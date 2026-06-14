import { DatabaseSync } from "node:sqlite";

/**
 * Default Transport: a local SQLite store + interval poll. The simplest proven
 * mechanism (the cleaned agent-mesh approach). Single-machine; swap this whole
 * module for a cloud-store or push transport later without touching the core.
 *
 * Honors the {@link import('../seams/transport.mjs').Transport} contract:
 *   - `send` resolves the recipient (by id, else most-recently-active by name),
 *     rejecting an unknown recipient with an error SendResult.
 *   - `startReceiving` polls for undelivered messages addressed to this session,
 *     invokes `onMessage`, and marks a message delivered ONLY after the handler
 *     resolves. A rejected handler is retried up to `maxAttempts`, then
 *     dead-lettered (bounded redelivery — no poison loop).
 *   - `meta` is round-tripped untouched (opaque).
 *
 * Credentials are unused for local SQLite (no auth); a remote transport would
 * call `ctx.credentials.get()` here.
 *
 * @param {object} [opts]
 * @param {string} opts.dbPath              Path to the SQLite file.
 * @param {number} [opts.pollIntervalMs]    Poll cadence (default 2000).
 * @param {number} [opts.maxAttempts]       Redelivery cap before dead-letter (default 5).
 * @param {number} [opts.staleMs]           Heartbeat age past which a peer is hidden from listAgents (default 30000).
 * @param {number} [opts.maxPerPoll]        Max messages handled per poll cycle (default 10).
 * @returns {import('../seams/transport.mjs').Transport}
 */
export function createSqlitePollTransport({
  dbPath,
  pollIntervalMs = 2000,
  maxAttempts = 5,
  staleMs = 30000,
  maxPerPoll = 10,
} = {}) {
  if (!dbPath) throw new Error("sqlite-poll transport requires a dbPath");

  /** @type {DatabaseSync} */
  let db;
  let dbOpen = false;
  /** @type {import('../seams/identity.mjs').AgentIdentity} */
  let self;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let draining = false;
  let stopped = false;

  function nowIso() {
    return new Date().toISOString();
  }

  return {
    async init(ctx) {
      self = ctx.self;
      // Credentials intentionally unused for local SQLite (no auth needed); a
      // remote transport would: await ctx.credentials.get().
      db = new DatabaseSync(dbPath);
      dbOpen = true;
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          registered_at  TEXT NOT NULL,
          last_heartbeat TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id            TEXT PRIMARY KEY,
          from_name     TEXT NOT NULL,
          to_target     TEXT NOT NULL,
          recipient_id  TEXT NOT NULL,
          body          TEXT NOT NULL,
          ts            TEXT NOT NULL,
          in_reply_to   TEXT,
          meta          TEXT NOT NULL,
          delivered     INTEGER NOT NULL DEFAULT 0,
          attempts      INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_inbox ON messages(recipient_id, delivered)");
    },

    async register(identity) {
      self = identity;
      const ts = nowIso();
      // Collision avoidance: if the identity supplies ordered `candidates`,
      // register under the FIRST one not already held by another session, and
      // reflect the chosen name back on `identity.name` (the core reads it
      // live). Done inside a write transaction so the read-taken + insert is
      // atomic against concurrent registrations (magic's withLock equivalent).
      const candidates =
        Array.isArray(identity.candidates) && identity.candidates.length
          ? identity.candidates
          : null;
      db.exec("BEGIN IMMEDIATE");
      try {
        let name = identity.name;
        if (candidates) {
          const taken = new Set(
            db.prepare("SELECT name FROM agents WHERE id != ?").all(identity.id).map((r) => r.name),
          );
          name = candidates.find((c) => !taken.has(c)) ?? candidates[0];
          identity.name = name;
        }
        db.prepare(
          `INSERT INTO agents (id, name, registered_at, last_heartbeat)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_heartbeat = excluded.last_heartbeat`,
        ).run(identity.id, name, ts, ts);
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw err;
      }
    },

    async deregister(identity) {
      db.prepare("DELETE FROM agents WHERE id = ?").run(identity.id);
    },

    async listAgents() {
      const cutoff = new Date(Date.now() - staleMs).toISOString();
      const rows = db
        .prepare("SELECT id, name FROM agents WHERE last_heartbeat >= ? ORDER BY name")
        .all(cutoff);
      return rows.map((r) => ({ id: r.id, name: r.name }));
    },

    async send(message) {
      // Resolve recipient: exact id first, else most-recently-active by name.
      const byId = db.prepare("SELECT id FROM agents WHERE id = ?").get(message.to);
      const recipient =
        byId ||
        db
          .prepare("SELECT id FROM agents WHERE name = ? ORDER BY last_heartbeat DESC LIMIT 1")
          .get(message.to);
      if (!recipient) {
        return { accepted: false, error: `no such agent: ${message.to}` };
      }
      db.prepare(
        `INSERT INTO messages (id, from_name, to_target, recipient_id, body, ts, in_reply_to, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        message.id,
        message.from,
        message.to,
        recipient.id,
        message.body,
        message.ts,
        message.inReplyTo ?? null,
        JSON.stringify(message.meta ?? {}),
      );
      return { accepted: true, id: message.id };
    },

    startReceiving(onMessage) {
      const drain = async () => {
        if (draining || stopped) return; // no overlapping cycles; bail once stopped
        draining = true;
        try {
          if (stopped || !dbOpen) return;
          // Heartbeat so peers see us as active.
          db.prepare("UPDATE agents SET last_heartbeat = ? WHERE id = ?").run(nowIso(), self.id);

          const rows = db
            .prepare(
              `SELECT * FROM messages
               WHERE recipient_id = ? AND delivered = 0
               ORDER BY ts ASC LIMIT ?`,
            )
            .all(self.id, maxPerPoll);

          for (const row of rows) {
            if (stopped) break;

            /** @type {import('../core/message.mjs').Message} */
            const message = {
              id: row.id,
              from: row.from_name,
              to: row.to_target,
              body: row.body,
              ts: row.ts,
              meta: safeParse(row.meta),
            };
            if (row.in_reply_to) message.inReplyTo = row.in_reply_to;

            // Classify ONLY the handler outcome here (success vs wake failure).
            let handled = false;
            try {
              await onMessage(message);
              handled = true;
            } catch {
              handled = false; // wake failed → bounded retry below
            }

            if (stopped || !dbOpen) break; // never touch the DB after stop/close

            // Persist the outcome in its OWN guarded write, so a DB-write error
            // is never misread as a wake failure (no spurious re-wake).
            try {
              if (handled) {
                db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?").run(row.id);
              } else {
                const attempts = row.attempts + 1;
                if (attempts >= maxAttempts) {
                  db.prepare(
                    "UPDATE messages SET delivered = 1, attempts = ? WHERE id = ?",
                  ).run(attempts, row.id); // dead-letter
                } else {
                  db.prepare("UPDATE messages SET attempts = ? WHERE id = ?").run(attempts, row.id);
                }
              }
            } catch {
              // DB closing/locked — leave the row for a later cycle (at-least-once). Don't crash.
            }
          }
        } catch {
          // Heartbeat/select hit a closing or locked DB — swallow; the transport
          // is contractually responsible for surviving a cycle, not the caller.
        } finally {
          draining = false;
        }
      };

      timer = setInterval(drain, pollIntervalMs);
      if (typeof timer.unref === "function") timer.unref(); // don't keep the process alive
    },

    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Quiesce any in-flight drain before closing the DB (avoid use-after-close).
      while (draining) await new Promise((r) => setTimeout(r, 5));
      if (db && dbOpen) {
        dbOpen = false;
        try {
          db.close();
        } catch {
          /* already closed */
        }
      }
      db = null;
    },
  };
}

function safeParse(json) {
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return {};
  }
}

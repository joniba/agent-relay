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
          last_heartbeat TEXT NOT NULL,
          attributes     TEXT NOT NULL DEFAULT '{}'
        )
      `);
      // An install created before `attributes` existed keeps its own table, and the
      // installer deliberately preserves the runtime DB across upgrades — so
      // CREATE TABLE IF NOT EXISTS above is a no-op for it and would leave every
      // later query referencing a column that isn't there. Add it idempotently.
      addColumnIfMissing(db, "agents", "attributes", "TEXT NOT NULL DEFAULT '{}'");
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
      // register under the FIRST one not held by another ACTIVE session, and
      // reflect the chosen name back on `identity.name` (the core reads it
      // live). Done inside a write transaction so the read-taken + insert is
      // atomic against concurrent registrations. Only non-stale sessions reserve
      // a name (same staleness cutoff as listAgents), so a crashed session's
      // name frees up. If every candidate is taken (>= candidates.length active
      // peers — rare), fall back to the first preference; id-addressing still
      // disambiguates.
      const candidates =
        Array.isArray(identity.candidates) && identity.candidates.length
          ? identity.candidates
          : null;
      db.exec("BEGIN IMMEDIATE");
      try {
        let name = identity.name;
        if (candidates) {
          const cutoff = new Date(Date.now() - staleMs).toISOString();
          const taken = new Set(
            db
              .prepare("SELECT name FROM agents WHERE id != ? AND last_heartbeat >= ?")
              .all(identity.id, cutoff)
              .map((r) => r.name),
          );
          name = candidates.find((c) => !taken.has(c)) ?? candidates[0];
          identity.name = name;
        }
        db.prepare(
          `INSERT INTO agents (id, name, registered_at, last_heartbeat, attributes)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             last_heartbeat = excluded.last_heartbeat,
             attributes = json_patch(${VALID_ATTRIBUTES_OF("agents")}, excluded.attributes)`,
        ).run(identity.id, name, ts, ts, JSON.stringify(identity.attributes ?? {}));
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
        .prepare("SELECT id, name, attributes FROM agents WHERE last_heartbeat >= ? ORDER BY name")
        .all(cutoff);
      return rows.map((r) => {
        const attributes = safeParse(r.attributes);
        // Omit the bag entirely when empty, so a session that publishes nothing looks
        // exactly as it did before attributes existed.
        return Object.keys(attributes).length ? { id: r.id, name: r.name, attributes } : { id: r.id, name: r.name };
      });
    },

    /**
     * PATCH the attributes of one agent. Keys present are set; keys ABSENT are left
     * alone; a key whose value is NULL is removed.
     *
     * The merge happens **in the database** (`json_patch`, RFC 7396) rather than as a
     * read-modify-write here. That matters: two sessions patching *different* keys on
     * the same entry concurrently would otherwise clobber each other, since each would
     * read the whole bag, edit its copy and write it back — defeating the point of
     * keeping one key per fact.
     */
    async setAttributes({ id, attributes, force = false } = {}) {
      const target = id ?? self.id;
      if (attributes == null || typeof attributes !== "object" || Array.isArray(attributes)) {
        return { ok: false, error: "'attributes' must be an object" };
      }
      // Writing another session's entry changes the state of something that is running
      // and will not be told. It stays possible — this is a trusted mesh — but it has
      // to be asked for explicitly rather than happening by default.
      if (target !== self.id && !force) {
        return {
          ok: false,
          error: `refusing to write attributes on another session (${target}) without force`,
        };
      }
      // A single statement, so the returned bag is guaranteed to be the state this
      // patch produced — and so a target that deregisters between the write and the
      // read cannot turn a contractual { ok, error } into a TypeError. `deregister`
      // hard-deletes, and force-writing a peer is exactly what `force` is for, so
      // "patch a peer while it exits" is the intended call racing the intended
      // teardown rather than a hypothetical.
      const row = db
        .prepare(
          `UPDATE agents SET attributes = json_patch(${VALID_ATTRIBUTES_OF()}, ?)
           WHERE id = ? RETURNING attributes`,
        )
        .get(JSON.stringify(attributes), target);
      if (!row) return { ok: false, error: `no such agent: ${target}` };
      return { ok: true, attributes: safeParse(row.attributes) };
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

/**
 * The attributes column as a *patchable* expression.
 *
 * The read path already tolerates a bad column value (`safeParse`); the write path
 * must too, or the two disagree about whether one is survivable. `json_patch` raises
 * on malformed JSON, and that throw happens inside `register` — so a single bad row
 * would not cost a session its attributes, it would cost it the relay entirely, on
 * every start, with no way back short of `--purge`. This also subsumes the NULL case.
 *
 * @param {string} [table]  Qualify the column when the statement needs it (upserts).
 */
const VALID_ATTRIBUTES_OF = (table) => {
  const col = table ? `${table}.attributes` : "attributes";
  return `CASE WHEN json_valid(${col}) THEN ${col} ELSE '{}' END`;
};

function safeParse(json) {
  try {
    return JSON.parse(json) ?? {};
  } catch {
    return {};
  }
}

/**
 * Add a column only if the table doesn't already have it — the idempotent stand-in
 * for a migration framework this transport doesn't have. SQLite's
 * `ALTER TABLE … ADD COLUMN` throws when the column exists, and there is no
 * `IF NOT EXISTS` form for it.
 */
function addColumnIfMissing(db, table, column, declaration) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

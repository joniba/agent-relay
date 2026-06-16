// `pg` is loaded LAZILY inside init() (see below), NOT at module top — so the
// extension's default single-machine path (built-in node:sqlite) needs ZERO
// external packages installed. The `pg` dependency matters only when a session
// actually opts into the cross-machine Postgres transport. Mirrors how the Azure
// credential lazily imports @azure/identity.

/**
 * Cross-machine Transport: a shared PostgreSQL store + interval poll. The
 * cross-machine analogue of `sqlite-poll.mjs` — same two-table model (an `agents`
 * registry + a `messages` inbox), same contract, so the core is unchanged. Only
 * the substrate moved across the machine boundary; the wake stays in-process.
 *
 * VENDOR-NEUTRAL: this module depends only on `pg` and the Credentials seam. It
 * works against ANY PostgreSQL (local Docker, Azure, RDS, self-hosted). The
 * Azure-specific credential is supplied via `ctx.credentials` (see the `azure/`
 * lib); nothing Azure appears here.
 *
 * Honors {@link import('../seams/transport.mjs').Transport}:
 *   - `register` resolves alias collisions **atomically across machines** under a
 *     Postgres advisory lock (the cross-machine analogue of SQLite's
 *     `BEGIN IMMEDIATE`), and marks the row `online`.
 *   - `deregister` marks the row offline (does NOT delete) so an exact-id send to
 *     a momentarily-away session is still durable.
 *   - `startReceiving` claims pending rows with `FOR UPDATE SKIP LOCKED` + a
 *     short lease (no overlapping/duplicate wake), wakes via `onMessage`, and
 *     DELETEs on success / dead-letters after `maxAttempts`. The heartbeat is
 *     non-resurrecting: a session that went stale re-registers before going live.
 *   - `meta` is round-tripped as `jsonb` (opaque).
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {string} opts.user
 * @param {string} opts.database
 * @param {number} [opts.port]                 Default 5432.
 * @param {boolean|object} [opts.ssl]          `pg` ssl option. Default
 *   `{ rejectUnauthorized: true }`; pass `false` for a local Docker server.
 * @param {number} [opts.pollIntervalMs]       Poll cadence (default 3000).
 * @param {number} [opts.heartbeatIntervalMs]  Heartbeat cadence (default 9000;
 *   decoupled from poll to cut write amplification).
 * @param {number} [opts.staleMs]              Liveness window (default 45000).
 * @param {number} [opts.leaseMs]              In-flight claim lease (default 30000).
 * @param {number} [opts.maxAttempts]          Redelivery cap before dead-letter (default 5).
 * @param {number} [opts.maxPerPoll]           Messages handled per cycle (default 10).
 * @param {number} [opts.sweepIntervalMs]      Base cleanup cadence (default 1_200_000 =
 *   20 min; each run is jittered to ~15–30 min so concurrent sessions rarely contend).
 * @param {number} [opts.messageTtlMs]         Delete messages older than this, any status
 *   (default 86_400_000 = 24 h).
 * @param {number} [opts.agentRetentionMs]     Drop agent rows not heartbeating within this
 *   window (default 604_800_000 = 7 d; LONGER than the message TTL so durable exact-id
 *   delivery to an away machine isn't cut short).
 * @param {(msg: string) => void} [opts.log]   Optional diagnostic sink.
 * @returns {import('../seams/transport.mjs').Transport}
 */
export function createPostgresTransport({
  host,
  user,
  database,
  port = 5432,
  ssl = { rejectUnauthorized: true },
  pollIntervalMs = 3000,
  heartbeatIntervalMs = 9000,
  staleMs = 45000,
  leaseMs = 30000,
  maxAttempts = 5,
  maxPerPoll = 10,
  sweepIntervalMs = 1_200_000,
  messageTtlMs = 86_400_000,
  agentRetentionMs = 604_800_000,
  pushEnabled = true,
  listenBackoffMinMs = 1000,
  listenBackoffMaxMs = 30000,
  listenRecycleMs = 2_400_000,
  log = () => {},
  debug = false,
  _pg = null,
} = {}) {
  if (!host) throw new Error("postgres transport requires a host");
  if (!user) throw new Error("postgres transport requires a user");
  if (!database) throw new Error("postgres transport requires a database");

  const staleSecs = staleMs / 1000;
  const leaseSecs = leaseMs / 1000;
  const messageTtlSecs = messageTtlMs / 1000;
  const agentRetentionSecs = agentRetentionMs / 1000;

  /** @type {import('pg').Pool} */
  let pool;
  /** Lazily-imported `pg` module namespace (loaded once in init). */
  let pg;
  /** @type {import('../seams/identity.mjs').AgentIdentity} */
  let self;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let sweepTimer = null;
  let draining = false;
  let stopped = false;
  let deregistered = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let heartbeatTimer = null;
  // ── push (LISTEN/NOTIFY) state — see startListener/dropListener below ──
  /** Set when a NOTIFY lands mid-drain; triggers one more bounded drain pass. */
  let rescan = false;
  /** Credentials seam captured in init(), reused for the dedicated listen client. */
  let credentials;
  /** @type {import('pg').Client | null} Dedicated long-lived LISTEN connection. */
  let listenClient = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let listenReconnectTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let listenRecycleTimer = null;
  /** Bumped on every (re)connect so a stale client's callbacks no-op (single-flight). */
  let listenGen = 0;
  let listenBackoffMs = listenBackoffMinMs;

  /**
   * Connection options for the dedicated LISTEN client (mirrors the pool's auth).
   * `keepAlive` helps surface a silently dropped listen socket; the password
   * callback mints a fresh credential per new connection (Azure token / env).
   */
  function connectionOptions() {
    return {
      host,
      user,
      database,
      port,
      ssl,
      password: async () => (await credentials.get()) ?? undefined,
      keepAlive: true,
      // Own connect timeout: the listen client is OUTSIDE the pool, so it does NOT
      // inherit the pool's connectionTimeoutMillis. Bound a hung connect so the
      // reconnect/backoff path can take over.
      connectionTimeoutMillis: 30000,
    };
  }

  // ── alias collision resolution (advisory-locked, cross-machine atomic) ──────
  async function register(identity) {
    self = identity;
    deregistered = false; // coming online (clears a prior intentional offline)
    const candidates =
      Array.isArray(identity.candidates) && identity.candidates.length ? identity.candidates : null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize alias acquisition across ALL machines (released at COMMIT).
      await client.query("SELECT pg_advisory_xact_lock($1)", [ALIAS_LOCK_KEY]);
      let name = identity.name;
      if (candidates) {
        const taken = new Set(
          (
            await client.query(
              `SELECT name FROM agents
               WHERE id <> $1 AND online AND last_heartbeat >= now() - make_interval(secs => $2)`,
              [identity.id, staleSecs],
            )
          ).rows.map((r) => r.name),
        );
        name = candidates.find((c) => !taken.has(c)) ?? candidates[0];
        identity.name = name; // core reads the chosen name live
      }
      await client.query(
        `INSERT INTO agents (id, name, device_name, online, registered_at, last_heartbeat)
         VALUES ($1, $2, $3, true, now(), now())
         ON CONFLICT (id) DO UPDATE
           SET name = excluded.name, device_name = excluded.device_name,
               online = true, last_heartbeat = now()`,
        [identity.id, name, identity.deviceName ?? null],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  function toMessage(row) {
    /** @type {import('../core/message.mjs').Message} */
    const message = {
      id: row.id,
      from: row.from_name,
      to: row.to_target,
      body: row.body,
      ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
      meta: row.meta ?? {},
    };
    if (row.in_reply_to) message.inReplyTo = row.in_reply_to;
    return message;
  }

  // ── session-owned cleanup (jittered; only ONE session sweeps per window) ─────
  // Every live session schedules a sweep, but `pg_try_advisory_xact_lock` makes
  // all-but-one a cheap no-op per window. No always-on infra (RD-CM: cleanup
  // waits for the next live session if none is up — acceptable at single-user
  // scale). Exposed on the transport so the integration suite can drive it.
  async function sweep() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Try-lock (non-blocking): if another session already holds it this window,
      // we no-op. Released automatically at COMMIT/ROLLBACK (xact-scoped).
      const got = (
        await client.query("SELECT pg_try_advisory_xact_lock($1) AS ok", [SWEEP_LOCK_KEY])
      ).rows[0].ok;
      if (!got) {
        await client.query("ROLLBACK");
        return { swept: false, skipped: true };
      }
      // Messages older than the TTL go (any status — pending/dead alike). `ts` is
      // the sender's timestamp; at a 24 h window cross-machine skew is immaterial.
      const msgs = await client.query(
        "DELETE FROM messages WHERE ts < now() - make_interval(secs => $1)",
        [messageTtlSecs],
      );
      // Known recipients are retained LONGER than messages so durable exact-id
      // delivery to an away machine isn't cut short; drop only long-stale rows.
      const agents = await client.query(
        "DELETE FROM agents WHERE last_heartbeat < now() - make_interval(secs => $1)",
        [agentRetentionSecs],
      );
      await client.query("COMMIT");
      // Routine cleanup is background noise in the session timeline, so it's
      // silent by default. Enable `debug` (AGENT_RELAY_DEBUG) to trace EVERY
      // sweep — including no-ops — when diagnosing whether cleanup is running.
      // Sweep ERRORS (below) are NOT gated: a failing sweep is a real fault.
      if (debug) {
        log(`postgres sweep: removed ${msgs.rowCount} message(s), ${agents.rowCount} stale agent(s)`);
      }
      return { swept: true, messages: msgs.rowCount, agents: agents.rowCount };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      log(`postgres sweep error: ${err.message}`);
      return { swept: false, error: err.message };
    } finally {
      client.release();
    }
  }

  function scheduleSweep() {
    if (stopped) return;
    // Long, randomized interval (~15–30 min for the 20 min base) so concurrent
    // sessions rarely contend; the try-lock makes the loser a cheap no-op.
    const delay = sweepIntervalMs * (0.75 + Math.random() * 0.75);
    sweepTimer = setTimeout(async () => {
      if (stopped) return;
      try {
        await sweep();
      } catch {
        // sweep() logs its own errors; cleanup must never crash the loop.
      }
      scheduleSweep();
    }, delay);
    if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  }

  return {
    async init(ctx) {
      self = ctx.self;
      credentials = ctx.credentials; // captured for the dedicated LISTEN client (push)
      // Load `pg` on demand. If it isn't installed, this is the cross-machine
      // opt-in path without its dependency — surface a clear, actionable error
      // (the entry then falls back to the local SQLite transport).
      if (!pg) {
        try {
          pg = _pg ?? (await import("pg")).default;
        } catch (err) {
          throw new Error(
            "the 'postgres' transport requires the 'pg' package — run `npm install` " +
              `in the agent-relay folder (original: ${err.message})`,
          );
        }
      }
      pool = new pg.Pool({
        host,
        user,
        database,
        port,
        ssl,
        // Async password from the Credentials seam → minted per NEW connection.
        // For Azure this is a fresh Entra token; for local/dev a static env value.
        password: async () => (await ctx.credentials.get()) ?? undefined,
        max: 4,
        maxLifetimeSeconds: 2700, // recycle connections before a token would expire
        idleTimeoutMillis: 30000,
      });
      // An idle-client error must never crash the host process.
      pool.on("error", (err) => log(`pg pool error: ${err.message}`));
      try {
        await migrate(pool, log);
      } catch (err) {
        // init failed (unreachable host, bad creds, refuse-newer schema, …) —
        // release the pool so a leaked idle client can't keep the process alive,
        // then rethrow so the entry can fall back.
        try {
          await pool.end();
        } catch {
          /* already ended */
        }
        pool = null;
        throw err;
      }
    },

    register,

    async deregister(identity) {
      // Mark offline, do NOT delete: the row stays a known recipient so an
      // exact-id send to an away session is still durable. `deregistered` stops
      // the heartbeat from re-registering (resurrecting) the ended session.
      deregistered = true;
      await pool.query("UPDATE agents SET online = false WHERE id = $1", [identity.id]);
    },

    async listAgents() {
      const rows = (
        await pool.query(
          `SELECT id, name, device_name FROM agents
           WHERE online AND last_heartbeat >= now() - make_interval(secs => $1)
           ORDER BY name`,
          [staleSecs],
        )
      ).rows;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        ...(r.device_name ? { deviceName: r.device_name } : {}),
      }));
    },

    async send(message) {
      // Exact id resolves a KNOWN agent even if offline/stale (durable delivery
      // to an away machine); a NAME resolves only a LIVE agent (never a freed
      // alias), most-recently-heartbeating wins.
      let recipient = (await pool.query("SELECT id FROM agents WHERE id = $1", [message.to])).rows[0];
      if (!recipient) {
        recipient = (
          await pool.query(
            `SELECT id FROM agents
             WHERE name = $1 AND online AND last_heartbeat >= now() - make_interval(secs => $2)
             ORDER BY last_heartbeat DESC LIMIT 1`,
            [message.to, staleSecs],
          )
        ).rows[0];
      }
      if (!recipient) {
        log(`postgres: send rejected — no live recipient for "${message.to}"`);
        return { accepted: false, error: `no such agent: ${message.to}` };
      }

      await pool.query(
        `INSERT INTO messages (id, from_name, to_target, recipient_id, body, ts, in_reply_to, meta, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        [
          message.id,
          message.from,
          message.to,
          recipient.id,
          message.body,
          message.ts, // preserve the sender's creation timestamp (parity with SQLite)
          message.inReplyTo ?? null,
          JSON.stringify(message.meta ?? {}),
        ],
      );
      // Best-effort INSTANT wake: fire-and-forget so it can never delay or fail an
      // already-durable send (an awaited notify could block on pool-checkout/network
      // after the row is committed). If this NOTIFY is lost, the receiver's poll is
      // the durable safety-net. The INSERT autocommits BEFORE this runs, so any
      // listener woken by the NOTIFY is guaranteed to see the row.
      if (pushEnabled) {
        // Fire-and-forget: the message is already durable, so a notify failure never
        // loses it (the poll delivers it). Swallow to avoid an unhandled rejection.
        void pool.query("SELECT pg_notify($1, $2)", [PUSH_CHANNEL, recipient.id]).catch(() => {});
      }
      return { accepted: true, id: message.id };
    },

    startReceiving(onMessage) {
      // One claim/wake pass: claim up to maxPerPoll pending rows for this session
      // (atomic, leased — no cross-machine double wake), wake each outside the
      // claiming statement, then DELETE on success / retry → dead-letter on failure.
      // Returns how many rows were claimed.
      const drainPass = async () => {
        const claimed = (
          await pool.query(
            `UPDATE messages SET lease_until = now() + make_interval(secs => $3)
             WHERE id IN (
               SELECT id FROM messages
               WHERE recipient_id = $1 AND status = 'pending'
                 AND (lease_until IS NULL OR lease_until < now())
               ORDER BY seq LIMIT $2
               FOR UPDATE SKIP LOCKED
             )
             RETURNING *`,
            [self.id, maxPerPoll, leaseSecs],
          )
        ).rows;

        for (const row of claimed) {
          if (stopped) break;
          let handled = false;
          try {
            await onMessage(toMessage(row));
            handled = true;
          } catch {
            handled = false; // wake failed → bounded retry below
          }
          if (stopped) break;
          try {
            if (handled) {
              await pool.query("DELETE FROM messages WHERE id = $1", [row.id]);
            } else {
              const attempts = row.attempts + 1;
              if (attempts >= maxAttempts) {
                await pool.query(
                  "UPDATE messages SET status = 'dead', attempts = $1, lease_until = NULL WHERE id = $2",
                  [attempts, row.id],
                );
                log(`postgres: message ${row.id} dead-lettered after ${attempts} attempt(s)`);
              } else {
                await pool.query(
                  "UPDATE messages SET attempts = $1, lease_until = NULL WHERE id = $2",
                  [attempts, row.id],
                );
              }
            }
          } catch {
            // DB hiccup — leave the row (lease expires → retried). At-least-once.
          }
        }
        return claimed.length;
      };

      // The SINGLE claim-and-wake routine, shared by BOTH the poll timer and the
      // push listener. `draining` serializes the two paths in-process (they never
      // overlap); a NOTIFY that lands mid-drain sets `rescan`, so we do one more
      // bounded pass rather than wait for the next (relaxed) poll. Each PASS claims
      // <= maxPerPoll; the loop runs at most MAX_DRAIN_PASSES passes (only while
      // NOTIFYs keep arriving mid-drain), so one drain delivers at most
      // MAX_DRAIN_PASSES*maxPerPoll rows before yielding — we never loop on a full
      // batch (no unbounded backlog drain).
      const drain = async () => {
        if (draining || stopped) return;
        draining = true;
        try {
          let passes = 0;
          do {
            rescan = false;
            if (stopped) break;
            await drainPass();
          } while (rescan && !stopped && ++passes < MAX_DRAIN_PASSES);
        } catch {
          // A cycle hit a transient error — swallow; the transport must survive a
          // cycle (poll/notify naturally retry).
        } finally {
          draining = false;
        }
      };

      // Presence heartbeat on its OWN timer, decoupled from poll so relaxing the poll
      // cadence never degrades liveness. NON-RESURRECTING: the UPDATE only matches a
      // still-online, non-stale row; if we already aged out (machine slept, alias maybe
      // reassigned) it matches 0 rows and we re-register instead of being silently
      // resurrected. Guards on `stopped` so no beat escapes after stop() (ghost session).
      const heartbeat = async () => {
        if (stopped) return;
        try {
          const hb = await pool.query(
            `UPDATE agents SET last_heartbeat = now()
             WHERE id = $1 AND online AND last_heartbeat >= now() - make_interval(secs => $2)`,
            [self.id, staleSecs],
          );
          if (hb.rowCount === 0 && !stopped && !deregistered) await register(self);
        } catch {
          // transient — the next heartbeat tick retries.
        }
      };

      // ── push: dedicated LISTEN client with single-flight reconnect + recycle ────
      // Only the addressed session reacts; a NOTIFY mid-drain folds into the in-flight
      // drain via `rescan` instead of overlapping.
      const onNotification = (gen, msg) => {
        if (stopped || gen !== listenGen) return; // stale client
        if (msg.payload !== self.id) return; // not addressed to us
        if (draining) rescan = true;
        else void drain();
      };

      // Tear down the current listen client and schedule a reconnect. Bumps listenGen
      // so any FURTHER event from the dead client (pg can fire BOTH `error` and `end`)
      // no-ops — single-flight.
      const dropListener = (gen) => {
        if (stopped || gen !== listenGen) return;
        listenGen++; // invalidate this client's remaining callbacks
        const client = listenClient;
        listenClient = null;
        if (listenRecycleTimer) {
          clearTimeout(listenRecycleTimer);
          listenRecycleTimer = null;
        }
        if (client) {
          try {
            client.removeAllListeners();
          } catch {
            /* ignore */
          }
          client.end().catch(() => {});
        }
        scheduleReconnect();
      };

      const scheduleReconnect = () => {
        if (stopped || listenReconnectTimer) return; // single-flight
        const delay = listenBackoffMs;
        listenBackoffMs = Math.min(listenBackoffMs * 2, listenBackoffMaxMs);
        listenReconnectTimer = setTimeout(() => {
          listenReconnectTimer = null;
          if (!stopped) startListener();
        }, delay);
        if (typeof listenReconnectTimer.unref === "function") listenReconnectTimer.unref();
      };

      const startListener = () => {
        if (!pushEnabled || stopped) return;
        const gen = ++listenGen;
        const client = new pg.Client(connectionOptions());
        listenClient = client;
        client.on("error", () => dropListener(gen));
        client.on("end", () => dropListener(gen));
        client.on("notification", (msg) => onNotification(gen, msg));
        client
          .connect()
          .then(() => client.query(LISTEN_SQL))
          .then(() => {
            if (stopped || gen !== listenGen) {
              client.end().catch(() => {});
              return;
            }
            listenBackoffMs = listenBackoffMinMs; // reset backoff on a clean connect
            // Proactive recycle before the credential/token lifetime, so a silent
            // half-drop is refreshed rather than only discovered on next use.
            listenRecycleTimer = setTimeout(() => dropListener(gen), listenRecycleMs);
            if (typeof listenRecycleTimer.unref === "function") listenRecycleTimer.unref();
            void drain(); // gap-heal: catch anything sent while we had no listener
          })
          .catch(() => dropListener(gen));
      };

      timer = setInterval(() => void drain(), pollIntervalMs);
      if (typeof timer.unref === "function") timer.unref();
      heartbeatTimer = setInterval(() => void heartbeat(), heartbeatIntervalMs);
      if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
      scheduleSweep();
      startListener();
    },

    sweep,

    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (sweepTimer) {
        clearTimeout(sweepTimer);
        sweepTimer = null;
      }
      if (listenReconnectTimer) {
        clearTimeout(listenReconnectTimer);
        listenReconnectTimer = null;
      }
      if (listenRecycleTimer) {
        clearTimeout(listenRecycleTimer);
        listenRecycleTimer = null;
      }
      if (listenClient) {
        const client = listenClient;
        listenClient = null;
        try {
          client.removeAllListeners();
        } catch {
          /* ignore */
        }
        try {
          await client.end();
        } catch {
          /* already ended */
        }
      }
      while (draining) await new Promise((r) => setTimeout(r, 5));
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* already ended */
        }
        pool = null;
      }
    },
  };
}

// Advisory-lock keys (arbitrary, stable constants; distinct per concern).
const MIGRATE_LOCK_KEY = 498061001;
const ALIAS_LOCK_KEY = 498061002;
const SWEEP_LOCK_KEY = 498061003;

// Push (LISTEN/NOTIFY): one shared channel; each listener filters by payload === self.id.
const PUSH_CHANNEL = "agent_relay_msg";
const LISTEN_SQL = `LISTEN "${PUSH_CHANNEL}"`;
// Max claim/wake passes per drain() — one normal pass plus up to ~2 rescan re-arms
// when NOTIFYs land mid-drain. Bounds the loop; any remainder rides poll/next-NOTIFY.
// We do NOT bulk-drain a backlog (per-drain cap = maxPerPoll, by design).
const MAX_DRAIN_PASSES = 3;

/** The schema version this transport build expects. */
export const TARGET_SCHEMA = 1;

/**
 * Idempotent schema migration, serialized across machines with an advisory lock.
 * Creates the schema on a fresh DB, upgrades an older one, and REFUSES to operate
 * on a newer schema than this build supports (the entry then falls back).
 *
 * @param {import('pg').Pool} pool
 * @param {(msg: string) => void} log
 */
export async function migrate(pool, log = () => {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATE_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS agent_relay_meta (key text PRIMARY KEY, value text NOT NULL)`,
    );
    const res = await client.query(
      "SELECT value FROM agent_relay_meta WHERE key = 'schema_version'",
    );
    const current = res.rows.length ? parseInt(res.rows[0].value, 10) : 0;

    if (current > TARGET_SCHEMA) {
      throw new Error(
        `agent-relay: database schema_version ${current} is newer than this build supports ` +
          `(${TARGET_SCHEMA}). Upgrade the extension; refusing to run on an unknown schema.`,
      );
    }

    if (current < 1) {
      log("postgres: applying schema migration 1 (initial)");
      await client.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id             text PRIMARY KEY,
          name           text NOT NULL,
          device_name    text,
          online         boolean NOT NULL DEFAULT true,
          registered_at  timestamptz NOT NULL DEFAULT now(),
          last_heartbeat timestamptz NOT NULL DEFAULT now()
        )`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_agents_live ON agents (last_heartbeat)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id            text PRIMARY KEY,
          from_name     text NOT NULL,
          to_target     text NOT NULL,
          recipient_id  text NOT NULL,
          body          text NOT NULL,
          ts            timestamptz NOT NULL DEFAULT now(),
          seq           bigserial,
          in_reply_to   text,
          meta          jsonb NOT NULL DEFAULT '{}',
          status        text NOT NULL DEFAULT 'pending',
          attempts      int  NOT NULL DEFAULT 0,
          lease_until   timestamptz
        )`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_inbox ON messages (recipient_id, status, seq)`,
      );
    }

    // Future migrations: if (current < 2) { … }

    await client.query(
      `INSERT INTO agent_relay_meta (key, value) VALUES ('schema_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [String(TARGET_SCHEMA)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

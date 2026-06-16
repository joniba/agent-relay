import { test } from "node:test";
import assert from "node:assert/strict";

import { createPostgresTransport } from "../extension/transports/postgres.mjs";

// ── Fake `pg` (no real database) ─────────────────────────────────────────────
// Injected via the transport's `_pg` test seam. Records pool queries and exposes
// the dedicated LISTEN client(s) so we can drive notifications / drops directly.
function makeFakePg() {
  const clients = [];
  const pools = [];

  class FakeClient {
    constructor(opts) {
      this.opts = opts;
      this.listeners = {};
      this.ended = false;
      clients.push(this);
    }
    on(ev, cb) {
      (this.listeners[ev] ||= []).push(cb);
      return this;
    }
    removeAllListeners() {
      this.listeners = {};
    }
    async connect() {
      this.connected = true;
    }
    async query(sql) {
      this.lastQuery = String(sql);
      return { rows: [], rowCount: 0 };
    }
    async end() {
      this.ended = true;
    }
    emit(ev, arg) {
      for (const cb of [...(this.listeners[ev] || [])]) cb(arg);
    }
  }

  class FakePool {
    constructor() {
      this.calls = [];
      this.ended = false;
      pools.push(this);
    }
    on() {}
    async connect() {
      return { query: (sql, params) => this.query(sql, params), release: () => {} };
    }
    async query(sql, params) {
      const s = String(sql);
      this.calls.push({ sql: s, params });
      // A send() resolves its recipient by exact id first — hand one back so the
      // INSERT + notify proceed. Match regardless of the selected column list
      // (the transport may select id alone or id + device_name).
      if (/FROM agents WHERE id = \$1/.test(s)) {
        return { rows: [{ id: params[0], device_name: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    async end() {
      this.ended = true;
    }
  }

  return { pg: { Pool: FakePool, Client: FakeClient }, clients, pools };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const baseOpts = (pg, extra = {}) => ({
  host: "h",
  user: "u",
  database: "d",
  _pg: pg,
  listenBackoffMinMs: 5,
  listenBackoffMaxMs: 5,
  ...extra,
});

const ctx = { self: { id: "self-A", name: "alpha" }, credentials: { get: async () => "pw" } };

const claimCount = (pool) =>
  pool.calls.filter((c) => /UPDATE messages SET lease_until/.test(c.sql)).length;

const msg = (over = {}) => ({
  id: "m1",
  from: "b",
  to: "self-A",
  body: "x",
  ts: new Date().toISOString(),
  meta: {},
  ...over,
});

test("send() emits pg_notify(channel, recipientId) AFTER the durable INSERT", async () => {
  const { pg, pools } = makeFakePg();
  const t = createPostgresTransport(baseOpts(pg));
  await t.init(ctx);

  const res = await t.send(msg());
  assert.equal(res.accepted, true);
  await tick(); // let the fire-and-forget notify run

  const pool = pools[0];
  const insertIdx = pool.calls.findIndex((c) => /INSERT INTO messages/.test(c.sql));
  const notifyIdx = pool.calls.findIndex((c) => /pg_notify/.test(c.sql));
  assert.ok(insertIdx >= 0, "INSERT happened");
  assert.ok(notifyIdx >= 0, "pg_notify happened");
  assert.ok(notifyIdx > insertIdx, "notify is emitted AFTER the insert");
  assert.deepEqual(pool.calls[notifyIdx].params, ["agent_relay_msg", "self-A"]);

  await t.stop();
});

test("pushEnabled=false → no listener and no pg_notify (pure poll)", async () => {
  const { pg, clients, pools } = makeFakePg();
  const t = createPostgresTransport(baseOpts(pg, { pushEnabled: false }));
  await t.init(ctx);
  t.startReceiving(async () => {});
  await tick();

  assert.equal(clients.length, 0, "no LISTEN client created when push is off");
  await t.send(msg({ id: "m2" }));
  await tick();
  assert.ok(!pools[0].calls.some((c) => /pg_notify/.test(c.sql)), "no notify when push off");

  await t.stop();
});

test("a matching NOTIFY triggers a drain; a non-matching one does not", async () => {
  const { pg, clients, pools } = makeFakePg();
  const t = createPostgresTransport(baseOpts(pg));
  await t.init(ctx);
  t.startReceiving(async () => {});
  await tick(20); // connect → LISTEN → gap-heal drain settle

  assert.equal(clients.length, 1, "exactly one LISTEN client");
  const pool = pools[0];

  const before = claimCount(pool);
  clients[0].emit("notification", { payload: "someone-else" });
  await tick();
  assert.equal(claimCount(pool), before, "non-matching payload does NOT drain");

  clients[0].emit("notification", { payload: "self-A" });
  await tick();
  assert.ok(claimCount(pool) > before, "matching payload triggers a drain");

  await t.stop();
});

test("a lost LISTEN connection schedules a single-flight reconnect", async () => {
  const { pg, clients } = makeFakePg();
  const t = createPostgresTransport(baseOpts(pg));
  await t.init(ctx);
  t.startReceiving(async () => {});
  await tick(20);
  assert.equal(clients.length, 1);

  // pg can fire BOTH error and end for one drop — must still reconnect exactly once.
  clients[0].emit("error", new Error("boom"));
  clients[0].emit("end");
  await tick(40); // backoff 5ms → reconnect

  assert.equal(clients.length, 2, "exactly one reconnect despite error+end");
  await t.stop();
});

test("stop() ends the listen client + pool and silences further notifications", async () => {
  const { pg, clients, pools } = makeFakePg();
  const t = createPostgresTransport(baseOpts(pg));
  await t.init(ctx);
  let woke = 0;
  t.startReceiving(async () => {
    woke += 1;
  });
  await tick(20);

  await t.stop();
  assert.equal(clients[0].ended, true, "listen client ended");
  assert.equal(pools[0].ended, true, "pool ended");

  const claimsAtStop = claimCount(pools[0]);
  clients[0].emit("notification", { payload: "self-A" });
  await tick();
  assert.equal(claimCount(pools[0]), claimsAtStop, "no drain after stop()");
});

test("heartbeat runs on its OWN timer, decoupled from the poll", async () => {
  const { pg, pools } = makeFakePg();
  const t = createPostgresTransport(
    baseOpts(pg, { heartbeatIntervalMs: 10, pollIntervalMs: 100000 }),
  );
  await t.init(ctx);
  t.startReceiving(async () => {});
  await tick(45); // several heartbeat ticks, well before any poll

  const beats = pools[0].calls.filter((c) =>
    /UPDATE agents SET last_heartbeat/.test(c.sql),
  ).length;
  assert.ok(beats >= 1, "heartbeat fired on its own timer without waiting for a poll");

  await t.stop();
});

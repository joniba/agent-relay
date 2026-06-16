import { test } from "node:test";
import assert from "node:assert/strict";

import { startRelaySession } from "../extension/bootstrap.mjs";
import { createConfig } from "../extension/config.mjs";

// ── fakes (no SDK, no DB) ────────────────────────────────────────────────────

/**
 * A fake Transport that records lifecycle calls and FAITHFULLY models the seam's
 * init-once / stop-terminal contract: once stop() is called, startReceiving() is
 * inert and deliver() drops — exactly like the real Postgres transport's `stopped`
 * guard. (A retried transport that was reused after stop() would therefore show
 * started=false, which is the bug this models.)
 */
function fakeTransport({ failInit = false, failRegister = false, hangInit = false, label = "t" } = {}) {
  let onMsg = null;
  let stopped = false;
  const calls = { init: 0, register: 0, started: false, stopped: 0, registeredSelf: null, ctx: null };
  return {
    calls,
    get stopped() {
      return stopped;
    },
    deliver(message) {
      return !stopped && onMsg ? onMsg(message) : undefined;
    },
    async init(ctx) {
      calls.init += 1;
      calls.ctx = ctx;
      if (hangInit) return new Promise(() => {}); // never settles
      if (failInit) throw new Error(`${label} init boom`);
    },
    async register(self) {
      calls.register += 1;
      calls.registeredSelf = self;
      if (failRegister) throw new Error(`${label} register boom`);
    },
    async deregister() {},
    async listAgents() {
      return [];
    },
    async send(message) {
      return { accepted: true, id: message.id };
    },
    startReceiving(fn) {
      if (stopped) return; // terminal: a stopped transport never receives
      onMsg = fn;
      calls.started = true;
    },
    async stop() {
      stopped = true;
      calls.stopped += 1;
    },
  };
}

function fakeSession({ sessionId = "sess-1" } = {}) {
  const wakes = [];
  const logs = [];
  return {
    sessionId,
    wakes,
    logs,
    async send(arg) {
      wakes.push(arg);
      return "ok";
    },
    async log(msg, opts) {
      logs.push({ msg, opts });
    },
  };
}

const fakeIdentity = (name) => ({
  async resolve(session) {
    return { id: session.sessionId, name };
  },
});

const noCreds = { async get() { return null; } };

/**
 * A createConfig FACTORY that hands out the given transports in order — like the
 * real createConfig, which builds a FRESH transport per call. Extra calls reuse the
 * last one.
 */
function configForTransports(...transports) {
  let i = 0;
  return () => ({
    identity: fakeIdentity("gull"),
    credentials: noCreds,
    transport: transports[Math.min(i++, transports.length - 1)],
    interceptors: [],
  });
}

// A backoff sleep that records its durations and never actually waits.
function fakeSleep() {
  const calls = [];
  const fn = async (ms) => {
    calls.push(ms);
  };
  fn.calls = calls;
  return fn;
}

async function withEnv(vars, fn) {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── happy path + identity ────────────────────────────────────────────────────

test("starts on the transport when it comes up", async () => {
  const t = fakeTransport();
  const logs = [];
  const res = await startRelaySession({
    session: fakeSession(),
    createConfig: configForTransports(t),
    log: (m) => logs.push(m),
  });
  assert.equal(t.calls.init, 1);
  assert.equal(t.calls.register, 1);
  assert.equal(t.calls.started, true);
  assert.equal(res.transport, t);
  assert.equal(res.self.name, "gull");
  assert.ok(logs.some((l) => /transport ready/.test(l)), "logs that the transport came up");
});

test("stamps the display-only device name from AGENT_RELAY_HOST onto the identity", async () => {
  await withEnv({ AGENT_RELAY_HOST: "test-box" }, async () => {
    const t = fakeTransport();
    const res = await startRelaySession({
      session: fakeSession(),
      createConfig: configForTransports(t),
      log() {},
    });
    assert.equal(res.self.deviceName, "test-box");
    assert.equal(t.calls.registeredSelf.deviceName, "test-box");
  });
});

test("passes the resolved credentials into the transport's init ctx", async () => {
  const creds = { async get() { return "tok"; } };
  const t = fakeTransport();
  await startRelaySession({
    session: fakeSession(),
    createConfig: () => ({ identity: fakeIdentity("gull"), credentials: creds, transport: t, interceptors: [] }),
    log() {},
  });
  assert.equal(t.calls.ctx.credentials, creds);
  assert.equal(t.calls.ctx.self.name, "gull");
});

// ── retry / no-fallback ──────────────────────────────────────────────────────

test("retries on a FRESH transport each time, then succeeds (the live one is not a reused/stopped instance)", async () => {
  const t0 = fakeTransport({ failInit: true, label: "a" });
  const t1 = fakeTransport({ failInit: true, label: "b" });
  const t2 = fakeTransport({ label: "c" });
  const sleep = fakeSleep();
  const logs = [];
  const res = await startRelaySession({
    session: fakeSession(),
    createConfig: configForTransports(t0, t1, t2),
    retry: { attempts: 3, backoffsMs: [2000, 4000] },
    sleep,
    log: (m, o) => logs.push({ m, o }),
  });

  assert.equal(res.transport, t2, "the live transport is the fresh one that succeeded");
  assert.equal(t2.calls.started, true, "the successful transport is actually receiving (not inert)");
  assert.equal(t2.stopped, false);
  assert.equal(t0.calls.init, 1);
  assert.equal(t1.calls.init, 1);
  assert.equal(t2.calls.init, 1);
  assert.equal(t0.calls.stopped, 1, "each failed instance is released");
  assert.equal(t1.calls.stopped, 1);
  assert.deepEqual(sleep.calls, [2000, 4000], "backoff after attempts 1 and 2");
  assert.equal(logs.filter((l) => l.o && l.o.level === "warning").length, 2);
  assert.equal(logs.filter((l) => l.o && l.o.level === "error").length, 0);
});

test("gives up after `attempts` failures and throws — never falls back to another mesh", async () => {
  const ts = [
    fakeTransport({ failInit: true, label: "a" }),
    fakeTransport({ failInit: true, label: "b" }),
    fakeTransport({ failInit: true, label: "c" }),
  ];
  const sleep = fakeSleep();
  const logs = [];
  await assert.rejects(
    () =>
      startRelaySession({
        session: fakeSession(),
        createConfig: configForTransports(...ts),
        retry: { attempts: 3, backoffsMs: [2000, 4000] },
        sleep,
        log: (m, o) => logs.push({ m, o }),
      }),
    /init boom/,
  );
  for (const t of ts) {
    assert.equal(t.calls.init, 1, "each fresh transport tried exactly once");
    assert.equal(t.calls.stopped, 1, "each failed transport released");
  }
  assert.deepEqual(sleep.calls, [2000, 4000]);
  assert.equal(logs.filter((l) => l.o && l.o.level === "warning").length, 2, "warn on the first two");
  assert.equal(logs.filter((l) => l.o && l.o.level === "error").length, 1, "error on the third (giving up)");
});

test("with no retry config, a connect failure throws immediately (single attempt, no backoff)", async () => {
  const t = fakeTransport({ failInit: true, label: "solo" });
  const sleep = fakeSleep();
  await assert.rejects(
    () =>
      startRelaySession({
        session: fakeSession(),
        createConfig: configForTransports(t),
        sleep,
        log() {},
      }),
    /solo init boom/,
  );
  assert.equal(t.calls.init, 1, "a single attempt");
  assert.deepEqual(sleep.calls, [], "no backoff without a retry policy");
});

test("times out a hanging connect attempt", async () => {
  const t = fakeTransport({ hangInit: true, label: "hang" });
  await assert.rejects(
    () =>
      startRelaySession({
        session: fakeSession(),
        createConfig: configForTransports(t),
        retry: { attempts: 1, attemptTimeoutMs: 20 },
        log() {},
      }),
    /timed out/,
  );
  assert.equal(t.calls.init, 1);
});

test("the relay is fully live on the fresh transport after a retried connect", async () => {
  const t0 = fakeTransport({ failInit: true, label: "a" });
  const t1 = fakeTransport({ label: "b" });
  const session = fakeSession();
  await startRelaySession({
    session,
    createConfig: configForTransports(t0, t1),
    retry: { attempts: 2, backoffsMs: [1] },
    sleep: fakeSleep(),
    log() {},
  });
  // The fresh, successful transport receives — a reused/stopped one would not.
  await t1.deliver({
    id: "m1",
    from: "pebble",
    to: "gull",
    body: "ping after retry",
    ts: new Date().toISOString(),
    meta: {},
  });
  assert.equal(session.wakes.length, 1);
  assert.match(session.wakes[0].prompt, /pebble/);
  assert.match(session.wakes[0].prompt, /ping after retry/);
});

// ── createConfig credential selection ────────────────────────────────────────

test("postgres branch uses env-password credentials when AGENT_RELAY_PG_PASSWORD is set", async () => {
  await withEnv(
    {
      AGENT_RELAY_TRANSPORT: "postgres",
      AGENT_RELAY_PG_HOST: "db.example",
      AGENT_RELAY_PG_USER: "relay",
      AGENT_RELAY_PG_DB: "relaydb",
      AGENT_RELAY_PG_PASSWORD: "s3cret",
    },
    async () => {
      const config = createConfig();
      assert.equal(await config.credentials.get(), "s3cret");
      assert.equal(typeof config.transport.send, "function");
    },
  );
});

test("postgres branch selects the Azure credential when no password is set", async () => {
  await withEnv(
    {
      AGENT_RELAY_TRANSPORT: "postgres",
      AGENT_RELAY_PG_HOST: "db.example",
      AGENT_RELAY_PG_USER: "relay",
      AGENT_RELAY_PG_DB: "relaydb",
      AGENT_RELAY_PG_PASSWORD: undefined,
    },
    async () => {
      const config = createConfig();
      assert.equal(typeof config.credentials.get, "function");
      assert.equal(typeof config.transport.send, "function");
      assert.equal(typeof config.transport.startReceiving, "function");
    },
  );
});

test("default (no AGENT_RELAY_TRANSPORT) stays the local SQLite slice with no credentials", async () => {
  await withEnv({ AGENT_RELAY_TRANSPORT: undefined, AGENT_RELAY_DB: "agent-relay-unit-test.db" }, async () => {
    const config = createConfig();
    assert.equal(await config.credentials.get(), null);
    assert.equal(typeof config.transport.send, "function");
    assert.deepEqual(config.interceptors, []);
  });
});

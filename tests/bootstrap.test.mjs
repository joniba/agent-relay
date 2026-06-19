import { test } from "node:test";
import assert from "node:assert/strict";

import { startRelaySession } from "../extension/bootstrap.mjs";

// -- fakes (no SDK, no DB) ----------------------------------------------------

/**
 * A fake Transport that records lifecycle calls and FAITHFULLY models the seam's
 * init-once / stop-terminal contract: once stop() is called, startReceiving() is
 * inert and deliver() drops - exactly like the real Postgres transport's `stopped`
 * guard.
 */
function fakeTransport({ failInit = false, failRegister = false, label = "t" } = {}) {
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

// A plain composed config (NOT a factory) - mirrors what createConfig now returns.
function configFor(transport, { credentials = noCreds, interceptors = [] } = {}) {
  return { identity: fakeIdentity("gull"), credentials, transport, interceptors };
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

// -- happy path + identity ----------------------------------------------------

test("brings the transport online linearly: init -> register -> startReceiving", async () => {
  const t = fakeTransport();
  const res = await startRelaySession({ session: fakeSession(), config: configFor(t), log() {} });
  assert.equal(t.calls.init, 1);
  assert.equal(t.calls.register, 1);
  assert.equal(t.calls.started, true);
  assert.equal(res.transport, t);
  assert.equal(res.self.name, "gull");
  assert.equal(t.stopped, false);
});

test("stamps the display-only device name from AGENT_RELAY_HOST onto the identity", async () => {
  await withEnv({ AGENT_RELAY_HOST: "test-box" }, async () => {
    const t = fakeTransport();
    const res = await startRelaySession({ session: fakeSession(), config: configFor(t), log() {} });
    assert.equal(res.self.deviceName, "test-box");
    assert.equal(t.calls.registeredSelf.deviceName, "test-box");
  });
});

test("passes the resolved credentials into the transport's init ctx", async () => {
  const creds = { async get() { return "tok"; } };
  const t = fakeTransport();
  await startRelaySession({ session: fakeSession(), config: configFor(t, { credentials: creds }), log() {} });
  assert.equal(t.calls.ctx.credentials, creds);
  assert.equal(t.calls.ctx.self.name, "gull");
});

test("the started relay is live and delivers a message to the session", async () => {
  const t = fakeTransport();
  const session = fakeSession();
  await startRelaySession({ session, config: configFor(t), log() {} });
  await t.deliver({
    id: "m1",
    from: "pebble",
    to: "gull",
    body: "ping",
    ts: new Date().toISOString(),
    meta: {},
  });
  assert.equal(session.wakes.length, 1);
  assert.match(session.wakes[0].prompt, /pebble/);
  assert.match(session.wakes[0].prompt, /ping/);
});

// -- partial-boot cleanup / no retry ------------------------------------------

test("init failure stops the transport and propagates (no retry, single attempt)", async () => {
  const t = fakeTransport({ failInit: true, label: "solo" });
  await assert.rejects(
    () => startRelaySession({ session: fakeSession(), config: configFor(t), log() {} }),
    /solo init boom/,
  );
  assert.equal(t.calls.init, 1, "a single attempt - no retry loop");
  assert.equal(t.calls.register, 0, "register is not reached when init throws");
  assert.equal(t.calls.stopped, 1, "the transport is stopped on partial-boot failure");
  assert.equal(t.calls.started, false, "the relay never starts receiving");
});

test("register failure (after a successful init) stops the transport and propagates", async () => {
  const t = fakeTransport({ failRegister: true, label: "reg" });
  await assert.rejects(
    () => startRelaySession({ session: fakeSession(), config: configFor(t), log() {} }),
    /reg register boom/,
  );
  assert.equal(t.calls.init, 1);
  assert.equal(t.calls.register, 1);
  assert.equal(t.calls.stopped, 1, "a half-opened transport is released");
  assert.equal(t.calls.started, false);
});
import { test } from "node:test";
import assert from "node:assert/strict";

import { startRelaySession } from "../extension/bootstrap.mjs";
import { createConfig } from "../extension/config.mjs";

// ── fakes (no SDK, no DB) ────────────────────────────────────────────────────

/**
 * A fake Transport that records lifecycle calls and lets a test drive an
 * inbound delivery through whatever handler the relay registers. Can be told to
 * fail at `init` or `register` to exercise the boot-time fallback.
 */
function fakeTransport({ failInit = false, failRegister = false, label = "t" } = {}) {
  let onMsg = null;
  const calls = {
    init: 0,
    register: 0,
    started: false,
    stopped: false,
    registeredSelf: null,
    ctx: null,
  };
  return {
    calls,
    /** Drive one inbound message through the relay's registered handler. */
    deliver(message) {
      return onMsg ? onMsg(message) : undefined;
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
      onMsg = fn;
      calls.started = true;
    },
    async stop() {
      calls.stopped = true;
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

const primaryConfig = (transport, { interceptors = [] } = {}) => () => ({
  identity: fakeIdentity("gull"),
  credentials: noCreds,
  transport,
  interceptors,
});

/** Run `fn` with env vars set, restoring prior values afterward. */
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

// ── startRelaySession ────────────────────────────────────────────────────────

test("starts on the primary transport when it comes up (no fallback)", async () => {
  const primary = fakeTransport({ label: "primary" });
  let fallbackCalled = false;
  const logs = [];
  const res = await startRelaySession({
    session: fakeSession(),
    createConfig: primaryConfig(primary),
    fallbackFactory: () => {
      fallbackCalled = true;
      return { transport: fakeTransport(), credentials: noCreds };
    },
    log: (m) => logs.push(m),
  });

  assert.equal(primary.calls.init, 1);
  assert.equal(primary.calls.register, 1);
  assert.equal(primary.calls.started, true);
  assert.equal(res.transport, primary);
  assert.equal(res.usedFallback, false);
  assert.equal(res.self.name, "gull");
  assert.equal(fallbackCalled, false, "fallback must not run when the primary is healthy");
  assert.ok(logs.some((l) => /ready \(primary\)/.test(l)), "should log the primary came up");
});

test("stamps the display-only device name from AGENT_RELAY_HOST onto the identity", async () => {
  await withEnv({ AGENT_RELAY_HOST: "test-box" }, async () => {
    const primary = fakeTransport();
    const res = await startRelaySession({
      session: fakeSession(),
      createConfig: primaryConfig(primary),
      log() {},
    });
    assert.equal(res.self.deviceName, "test-box");
    assert.equal(primary.calls.registeredSelf.deviceName, "test-box");
  });
});

test("falls back to the local transport when the primary fails to init", async () => {
  const primary = fakeTransport({ failInit: true, label: "primary" });
  const fallback = fakeTransport({ label: "fallback" });
  const session = fakeSession();
  const logs = [];

  const res = await startRelaySession({
    session,
    createConfig: primaryConfig(primary),
    fallbackFactory: () => ({ transport: fallback, credentials: noCreds }),
    log: (m) => logs.push(m),
  });

  assert.equal(primary.calls.init, 1);
  assert.equal(primary.calls.register, 0, "register is never reached when init throws");
  assert.equal(fallback.calls.init, 1);
  assert.equal(fallback.calls.register, 1);
  assert.equal(fallback.calls.started, true);
  assert.equal(res.transport, fallback);
  assert.equal(res.usedFallback, true);
  assert.equal(primary.calls.stopped, true, "the failed primary is released before falling back");
  assert.ok(
    logs.some((l) => /unavailable|falling back/i.test(l)),
    "should log the fallback reason",
  );

  // The relay is fully live on the fallback: an inbound message wakes the session.
  await fallback.deliver({
    id: "m1",
    from: "pebble",
    to: "gull",
    body: "ping over the fallback",
    ts: new Date().toISOString(),
    meta: {},
  });
  assert.equal(session.wakes.length, 1);
  assert.match(session.wakes[0].prompt, /pebble/);
  assert.match(session.wakes[0].prompt, /ping over the fallback/);
});

test("falls back when the primary connects but fails to register", async () => {
  const primary = fakeTransport({ failRegister: true, label: "primary" });
  const fallback = fakeTransport({ label: "fallback" });
  const res = await startRelaySession({
    session: fakeSession(),
    createConfig: primaryConfig(primary),
    fallbackFactory: () => ({ transport: fallback, credentials: noCreds }),
    log() {},
  });
  assert.equal(primary.calls.init, 1);
  assert.equal(primary.calls.register, 1);
  assert.equal(primary.calls.stopped, true, "the primary is released after a failed register");
  assert.equal(res.transport, fallback);
  assert.equal(res.usedFallback, true);
});

test("surfaces the error when the fallback ALSO fails (boot stays visible)", async () => {
  const primary = fakeTransport({ failInit: true, label: "primary" });
  const fallback = fakeTransport({ failInit: true, label: "fallback" });
  await assert.rejects(
    () =>
      startRelaySession({
        session: fakeSession(),
        createConfig: primaryConfig(primary),
        fallbackFactory: () => ({ transport: fallback, credentials: noCreds }),
        log() {},
      }),
    /fallback init boom/,
    "the fallback failure must propagate, not be swallowed",
  );
});

test("with no fallbackFactory, a primary failure propagates", async () => {
  const primary = fakeTransport({ failInit: true, label: "primary" });
  await assert.rejects(
    () =>
      startRelaySession({
        session: fakeSession(),
        createConfig: primaryConfig(primary),
        log() {},
      }),
    /primary init boom/,
  );
});

test("passes the resolved credentials into the chosen transport's init ctx", async () => {
  const creds = { async get() { return "tok"; } };
  const primary = fakeTransport();
  await startRelaySession({
    session: fakeSession(),
    createConfig: () => ({
      identity: fakeIdentity("gull"),
      credentials: creds,
      transport: primary,
      interceptors: [],
    }),
    log() {},
  });
  assert.equal(primary.calls.ctx.credentials, creds);
  assert.equal(primary.calls.ctx.self.name, "gull");
});

// ── createConfig credential selection (postgres branch) ──────────────────────

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
      // The env-password provider returns the plain password — proves the
      // Docker/CI/test path is selected (and never loads the Azure SDK).
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
      // A CredentialProvider is wired and the transport is the postgres one. We
      // do NOT call get() here: the Azure provider would load @azure/identity and
      // attempt real token acquisition — that path is exercised live in Phase E.
      assert.equal(typeof config.credentials.get, "function");
      assert.equal(typeof config.transport.send, "function");
      assert.equal(typeof config.transport.startReceiving, "function");
    },
  );
});

test("default (no AGENT_RELAY_TRANSPORT) stays the local SQLite slice with no credentials", async () => {
  await withEnv({ AGENT_RELAY_TRANSPORT: undefined }, async () => {
    const config = createConfig();
    assert.equal(await config.credentials.get(), null);
    assert.equal(typeof config.transport.send, "function");
    assert.deepEqual(config.interceptors, []);
  });
});

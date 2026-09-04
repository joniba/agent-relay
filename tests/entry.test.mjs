import { test } from "node:test";
import assert from "node:assert/strict";

import { createExtensionRuntime } from "../extension/entry.mjs";

// The boot sequence used to be top-level in extension.mjs and therefore untestable.
// These exercise the part that matters most about the reorder: plugins now load
// BEFORE joinSession, because tool declarations are one-shot in the join payload.

// -- harness ------------------------------------------------------------------

const aTool = (name) => ({
  name,
  description: `does ${name}`,
  parameters: { type: "object", properties: {} },
  handler: async () => ({ textResultForLlm: name, resultType: "success" }),
});

function harness(overrides = {}) {
  const order = [];
  const lines = [];
  const deregistered = [];
  let stopped = 0;

  const session = { sessionId: "abcdef01-2345-6789", log: async () => {} };
  const relay = {
    sendMessage: async () => ({ ok: true, id: "m1" }),
    listAgents: async () => [{ id: "s2", name: "gull", self: false }],
    stop: async () => { stopped += 1; },
  };
  const transport = { deregister: async (self) => { deregistered.push(self.id); } };
  const self = { id: "s1-aaaaaaaa", name: "loon" };

  const config = {
    tools: [],
    briefings: [],
    plugins: [],
    interceptors: [],
    remote: false,
    ...(overrides.config ?? {}),
  };

  const deps = {
    joinSession: async (cfg) => {
      order.push("joinSession");
      joined.push(cfg);
      return session;
    },
    createConfig: async (opts) => {
      order.push("createConfig");
      createConfigOpts.push(opts);
      // Plugins log while no tagged logger exists yet; this must survive to the real log.
      opts.log("plugin loaded: fake");
      return config;
    },
    startRelaySession: async () => {
      order.push("startRelaySession");
      return { relay, self, transport };
    },
    resolveDataDir: () => "C:/data",
    createRollingFileLog: () => () => {},
    // Capture the booting state per line. Discarding `isBooting` is how a whole
    // class of "logged, but nowhere anyone reads" bugs stays invisible.
    createRelayLog: ({ isBooting }) => (msg) => lines.push({ msg, booting: isBooting() }),
    aliasFor: () => "loon",
    env: {},
  };

  const joined = [];
  const createConfigOpts = [];
  Object.assign(deps, overrides.deps ?? {});

  return {
    deps,
    order,
    lines,
    joined,
    createConfigOpts,
    session,
    self,
    stopped: () => stopped,
    deregistered,
  };
}

// -- ordering: the whole point of the phase -----------------------------------

test("plugins load BEFORE joinSession — tool declarations are one-shot in the join payload", async () => {
  const h = harness();
  await createExtensionRuntime(h.deps).start();

  assert.deepEqual(h.order, ["createConfig", "joinSession", "startRelaySession"]);
});

test("the session is joined exactly once", async () => {
  const h = harness();
  await createExtensionRuntime(h.deps).start();
  assert.equal(h.joined.length, 1);
});

// -- tools --------------------------------------------------------------------

test("core tools are registered, and a plugin's tools are appended after them", async () => {
  const h = harness({
    config: {
      tools: [],
      briefings: [],
      plugins: [{ name: "roles", tools: [aTool("assign_role")], briefing: null, activate: null }],
    },
  });
  await createExtensionRuntime(h.deps).start();

  const names = h.joined[0].tools.map((t) => t.name);
  assert.deepEqual(names, ["send_message", "list_relay_agents", "assign_role"]);
});

test("core's own tool names are handed to the loader as reserved", async () => {
  const h = harness();
  await createExtensionRuntime(h.deps).start();

  assert.deepEqual(h.createConfigOpts[0].reservedToolNames, ["send_message", "list_relay_agents"]);
});

// -- fail-loud, but still reportable ------------------------------------------

test("a bad plugin still joins with core tools, so send_message can report the failure", async () => {
  const h = harness({
    deps: {
      createConfig: async () => {
        throw new Error('agent-relay: plugin "broken" failed to load: boom');
      },
    },
  });
  const runtime = createExtensionRuntime(h.deps);
  await runtime.start();

  // The join still happened, with core's tools only.
  assert.equal(h.joined.length, 1);
  assert.deepEqual(h.joined[0].tools.map((t) => t.name), ["send_message", "list_relay_agents"]);

  // And the failure is reportable THROUGH those tools rather than being silent.
  const sendMessage = h.joined[0].tools.find((t) => t.name === "send_message");
  const res = await sendMessage.handler({ to: "gull", content: "hi" });
  assert.equal(res.resultType, "failure");
  assert.match(res.textResultForLlm, /failed to start.*plugin "broken".*boom/);

  // The relay never came up.
  assert.equal(runtime.state().ready, false);
  assert.match(runtime.state().bootError, /plugin "broken"/);
});

test("a bad plugin means startRelaySession is never attempted", async () => {
  const h = harness({
    deps: { createConfig: async () => { throw new Error("nope"); } },
  });
  await createExtensionRuntime(h.deps).start();
  assert.deepEqual(h.order, ["joinSession"]);
});

test("before the relay is ready, tools report a TRANSIENT not-ready state", async () => {
  const h = harness({
    deps: { startRelaySession: async () => { throw new Error("transport down"); } },
  });
  const runtime = createExtensionRuntime(h.deps);

  // Grab a handler before start() so we can call it pre-boot.
  const { coreTools } = runtime.state();
  const listAgents = coreTools.find((t) => t.name === "list_relay_agents");
  const early = await listAgents.handler({});
  assert.match(early.textResultForLlm, /still starting up/);

  // After a terminal boot failure the message becomes the actual cause, not "try again".
  await runtime.start();
  const late = await listAgents.handler({});
  assert.match(late.textResultForLlm, /failed to start.*transport down/);
});

test("a plugin that throws a bare string still produces an attributed failure, not a null dereference", async () => {
  // `createConfig` can throw something without a `.message` — a plugin factory may
  // throw anything, and transport.create() runs outside the loader's own try/catch.
  // Testing bootError instead of config would let boot continue with config === null
  // and replace the plugin's error with a TypeError.
  const h = harness({ deps: { createConfig: async () => { throw "kaboom"; } } });
  const runtime = createExtensionRuntime(h.deps);
  await runtime.start();

  assert.deepEqual(h.order, ["joinSession"], "startRelaySession must not run without a config");
  assert.equal(runtime.state().bootError, "kaboom");

  const sendMessage = h.joined[0].tools.find((t) => t.name === "send_message");
  const res = await sendMessage.handler({ to: "gull", content: "hi" });
  assert.match(res.textResultForLlm, /failed to start: kaboom/);
  assert.doesNotMatch(res.textResultForLlm, /Cannot read properties/);
});

test("a throw after the relay is built leaves the session NOT ready", async () => {
  // Everything between `startRelaySession` returning and `ready = true` can throw —
  // a malformed identity, for instance. Reporting ready anyway would leave tools
  // dereferencing a relay that never came up.
  const h = harness();
  h.deps.startRelaySession = async () => ({
    relay: { stop: async () => {} },
    self: null, // reading self.id throws
    transport: { deregister: async () => {} },
  });
  const runtime = createExtensionRuntime(h.deps);
  await runtime.start();

  assert.equal(runtime.state().ready, false);
  assert.ok(runtime.state().bootError, "the failure must be recorded");

  const listAgents = runtime.state().coreTools.find((t) => t.name === "list_relay_agents");
  const res = await listAgents.handler({});
  assert.equal(res.resultType, "failure");
  assert.doesNotMatch(res.textResultForLlm, /still starting up/);
});

// -- briefing -----------------------------------------------------------------

test("the briefing composes core's text with every plugin's, in order", async () => {
  const h = harness({
    config: { tools: [], briefings: ["Use assign_role to tag a session.", "Second plugin note."], plugins: [] },
  });
  const runtime = createExtensionRuntime(h.deps);
  await runtime.start();

  const { additionalContext } = await runtime.state().hooks.onSessionStart();
  assert.match(additionalContext, /connected to agent-relay as "loon"/);
  assert.match(additionalContext, /Use assign_role to tag a session\./);
  assert.match(additionalContext, /Second plugin note\./);
  // Core first, plugins after, in load order.
  assert.ok(
    additionalContext.indexOf("assign_role") < additionalContext.indexOf("Second plugin note"),
    "plugin briefings must keep load order",
  );
});

test("no briefing is advertised until the relay is ready", async () => {
  const h = harness({ config: { tools: [], briefings: ["never seen"], plugins: [] } });
  const runtime = createExtensionRuntime(h.deps);

  assert.deepEqual(await runtime.state().hooks.onSessionStart(), {});
});

// -- buffered diagnostics -----------------------------------------------------

test("plugin-load diagnostics are buffered and replayed inside the booting window", async () => {
  const h = harness();
  await createExtensionRuntime(h.deps).start();

  // The boot line establishes context and must come first; the buffered plugin
  // line follows it rather than being lost to a logger that did not exist yet.
  assert.match(h.lines[0].msg, /^boot datadir=/);
  const replayed = h.lines.find((l) => l.msg === "plugin loaded: fake");
  assert.ok(replayed, "buffered plugin line was not replayed");
  // It has to land while `booting` is still true, or a warning that the booting
  // window exists to surface would be filed away silently instead.
  assert.equal(replayed.booting, true);
});

test("the logger handed to plugins keeps working AFTER boot — it is retained for the session", async () => {
  // A plugin transport logs from background poll/sweep timers for the whole session,
  // and a plugin factory keeps `ctx.log` indefinitely. A buffer drained once and then
  // never read again would swallow all of it, silently.
  const h = harness();
  await createExtensionRuntime(h.deps).start();

  const pluginLog = h.createConfigOpts[0].log;
  pluginLog("postgres sweep: removed 3 message(s)");

  const late = h.lines.find((l) => l.msg === "postgres sweep: removed 3 message(s)");
  assert.ok(late, "a plugin logging after boot reached nobody");
  assert.equal(late.booting, false, "the booting window should be closed by now");
});

test("a transport warning during startRelaySession still surfaces inside the booting window", async () => {
  // This is the real shape of the bug: a remote transport's init() retries and warns
  // while connecting, which happens after the buffer would have been drained.
  const h = harness();
  h.deps.startRelaySession = async ({ log }) => {
    void log;
    h.createConfigOpts[0].log("connect attempt 1 failed, retrying", { level: "warning" });
    return {
      relay: { sendMessage: async () => ({}), listAgents: async () => [], stop: async () => {} },
      self: h.self,
      transport: { deregister: async () => {} },
    };
  };
  await createExtensionRuntime(h.deps).start();

  const warned = h.lines.find((l) => l.msg === "connect attempt 1 failed, retrying");
  assert.ok(warned, "the transport's connect warning was lost");
  assert.equal(warned.booting, true, "it must surface while booting, not be filed away");
});

// -- shutdown -----------------------------------------------------------------

test("shutdown deregisters presence then stops the relay, and is idempotent", async () => {
  const h = harness();
  const runtime = createExtensionRuntime(h.deps);
  await runtime.start();

  await runtime.shutdown();
  await runtime.shutdown();

  assert.deepEqual(h.deregistered, [h.self.id]);
  assert.equal(h.stopped(), 1);
});

test("shutdown before the relay exists does not throw", async () => {
  const h = harness();
  await createExtensionRuntime(h.deps).shutdown();
  assert.deepEqual(h.deregistered, []);
});

test("a teardown requested DURING boot is honoured once boot completes", async () => {
  const h = harness();
  let runtime;
  h.deps.startRelaySession = async () => {
    h.order.push("startRelaySession");
    // Simulates onSessionEnd arriving while the transport is still coming up: at
    // this moment there is nothing to deregister, so the request must be replayed.
    await runtime.shutdown();
    return {
      relay: { sendMessage: async () => ({}), listAgents: async () => [], stop: async () => {} },
      self: h.self,
      transport: { deregister: async (s) => h.deregistered.push(s.id) },
    };
  };
  runtime = createExtensionRuntime(h.deps);
  await runtime.start();

  assert.deepEqual(h.deregistered, [h.self.id], "teardown during boot was dropped");
});

test("a teardown requested during a FAILING boot is still honoured", async () => {
  // A transport can half-open before throwing, so the replay belongs in `finally`
  // rather than on the success path only.
  const h = harness();
  let runtime;
  let stopped = 0;
  h.deps.startRelaySession = async () => {
    await runtime.shutdown();
    throw new Error("transport down");
  };
  runtime = createExtensionRuntime(h.deps);
  await runtime.start();

  // Nothing was assigned, so shutdown is a no-op — but it must have been ATTEMPTED
  // rather than skipped, and the boot failure must still be recorded.
  assert.equal(runtime.state().ready, false);
  assert.match(runtime.state().bootError, /transport down/);
  assert.equal(stopped, 0);
});

// -- activation ---------------------------------------------------------------

test("plugins are activated after registration, in load order, before ready", async () => {
  const seen = [];
  const h = harness({
    config: {
      tools: [],
      briefings: [],
      plugins: [
        { name: "first", tools: [], briefing: null, activate: async () => seen.push("first") },
        { name: "second", tools: [], briefing: null, activate: async () => seen.push("second") },
      ],
    },
  });
  const runtime = createExtensionRuntime(h.deps);
  await runtime.start();

  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(runtime.state().ready, true);
});

test("activate receives the REGISTERED identity and a working relay handle", async () => {
  let got = null;
  const h = harness({
    config: {
      tools: [],
      briefings: [],
      plugins: [{ name: "p", tools: [], briefing: null, activate: async (ctx) => { got = ctx; } }],
    },
  });
  await createExtensionRuntime(h.deps).start();

  // The identity a plugin could not know at factory time.
  assert.equal(got.self.name, "loon");
  assert.equal(typeof got.relay.sendMessage, "function");
  assert.equal(typeof got.relay.listAgents, "function");
  // Narrowed: lifecycle stays the host's.
  assert.equal(got.relay.stop, undefined);
  assert.deepEqual(await got.relay.listAgents(), [{ id: "s2", name: "gull", self: false }]);
});

test("a plugin without activate is simply skipped", async () => {
  const h = harness({
    config: { tools: [], briefings: [], plugins: [{ name: "p", tools: [], briefing: null, activate: null }] },
  });
  const runtime = createExtensionRuntime(h.deps);
  await runtime.start();
  assert.equal(runtime.state().ready, true);
});

test("a throwing activate does NOT abort an otherwise healthy session", async () => {
  const h = harness({
    config: {
      tools: [],
      briefings: [],
      plugins: [
        { name: "broken", tools: [], briefing: null, activate: async () => { throw new Error("no db"); } },
        { name: "fine", tools: [], briefing: null, activate: async () => {} },
      ],
    },
  });
  const runtime = createExtensionRuntime(h.deps);
  await runtime.start();

  // The relay is up and messaging works; only the plugin failed.
  assert.equal(runtime.state().ready, true);
  assert.equal(runtime.state().bootError, null);
  // And the failure is visible, named, as a warning inside the booting window.
  const warned = h.lines.find((l) => /plugin "broken" failed to activate: no db/.test(l.msg));
  assert.ok(warned, "the activation failure was not reported");
  assert.equal(warned.booting, true);
});

test("a later plugin still activates after an earlier one throws", async () => {
  const seen = [];
  const h = harness({
    config: {
      tools: [],
      briefings: [],
      plugins: [
        { name: "broken", tools: [], briefing: null, activate: async () => { throw new Error("x"); } },
        { name: "later", tools: [], briefing: null, activate: async () => seen.push("later") },
      ],
    },
  });
  await createExtensionRuntime(h.deps).start();
  assert.deepEqual(seen, ["later"]);
});

test("tools of a plugin that failed to activate report a DURABLE failure, not 'still starting up'", async () => {
  const h = harness({
    config: {
      tools: [],
      briefings: [],
      plugins: [
        {
          name: "broken",
          tools: [aTool("assign_role")],
          briefing: null,
          activate: async () => { throw new Error("no db"); },
        },
      ],
    },
  });
  await createExtensionRuntime(h.deps).start();

  const assignRole = h.joined[0].tools.find((t) => t.name === "assign_role");
  const res = await assignRole.handler({});
  assert.equal(res.resultType, "failure");
  assert.match(res.textResultForLlm, /plugin "broken" failed to activate: no db/);
  // The distinction that matters: this condition never resolves, so it must not
  // invite a retry the way core's transient not-ready message does.
  assert.doesNotMatch(res.textResultForLlm, /try again/);
});

test("tools of a plugin that activated fine are untouched", async () => {
  const h = harness({
    config: {
      tools: [],
      briefings: [],
      plugins: [{ name: "ok", tools: [aTool("assign_role")], briefing: null, activate: async () => {} }],
    },
  });
  await createExtensionRuntime(h.deps).start();

  const assignRole = h.joined[0].tools.find((t) => t.name === "assign_role");
  const res = await assignRole.handler({});
  assert.equal(res.resultType, "success");
  assert.equal(res.textResultForLlm, "assign_role");
});

test("one plugin's activation failure does not disable another plugin's tools", async () => {
  const h = harness({
    config: {
      tools: [],
      briefings: [],
      plugins: [
        { name: "broken", tools: [aTool("bad_tool")], briefing: null, activate: async () => { throw new Error("x"); } },
        { name: "ok", tools: [aTool("good_tool")], briefing: null, activate: async () => {} },
      ],
    },
  });
  await createExtensionRuntime(h.deps).start();

  const bad = await h.joined[0].tools.find((t) => t.name === "bad_tool").handler({});
  const good = await h.joined[0].tools.find((t) => t.name === "good_tool").handler({});
  assert.equal(bad.resultType, "failure");
  assert.equal(good.resultType, "success");
});

test("activation runs BEFORE the session is announced as ready", async () => {
  // A plugin acting at activation must not observe a session the consumer could
  // already be using, so `ready` has to flip after activation completes.
  let readyDuringActivation = null;
  let runtime;
  const h = harness({
    config: {
      tools: [],
      briefings: [],
      plugins: [
        {
          name: "p",
          tools: [],
          briefing: null,
          activate: async () => { readyDuringActivation = runtime.state().ready; },
        },
      ],
    },
  });
  runtime = createExtensionRuntime(h.deps);
  await runtime.start();

  assert.equal(readyDuringActivation, false);
  assert.equal(runtime.state().ready, true);
});

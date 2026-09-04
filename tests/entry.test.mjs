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
    createRelayLog: () => (msg, opts) => lines.push(msg),
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
  const h = harness({ config: { tools: [aTool("assign_role")], briefings: [], plugins: [] } });
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

test("plugin-load diagnostics are buffered and replayed once a tagged logger exists", async () => {
  const h = harness();
  await createExtensionRuntime(h.deps).start();

  // The boot line establishes context and must come first; the buffered plugin
  // line follows it rather than being lost to a logger that did not exist yet.
  assert.match(h.lines[0], /^boot datadir=/);
  assert.ok(h.lines.includes("plugin loaded: fake"), "buffered plugin line was not replayed");
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

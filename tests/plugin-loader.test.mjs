import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPlugins } from "../extension/plugin-loader.mjs";

// -- Test doubles -------------------------------------------------------------

// Fake importer keyed by module BASENAME; records the URLs it received. A map value:
//   - { default: fn } -> a normal module (factory in `default`)
//   - Error           -> simulates import() throwing (module-evaluation failure)
function fakeImporter(byBasename, received = []) {
  return async (url) => {
    received.push(url);
    const name = url.split("/").pop();
    const entry = byBasename[name];
    if (entry === undefined) throw new Error(`module not found: ${name}`);
    if (entry instanceof Error) throw entry;
    return entry;
  };
}

const mod = (factory) => ({ default: factory });
const interceptor = (tag) => ({ onReceive: (m, next) => next(m), _tag: tag });
const files = (...names) => names.map((name) => ({ name, isDirectory: false }));
const dirs = (...names) => names.map((name) => ({ name, isDirectory: true }));
const noScan = { readEntries: () => [], readJson: () => ({}) };

// -- ordering / sources -------------------------------------------------------

test("env paths load in listed order (not alphabetical)", async () => {
  const importer = fakeImporter({
    "b.mjs": mod(() => ({ interceptors: [interceptor("b")] })),
    "a.mjs": mod(() => ({ interceptors: [interceptor("a")] })),
  });
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/b.mjs,/p/a.mjs" }, dataDir: null },
    { importer, ...noScan },
  );
  assert.deepEqual(reg.interceptors.map((i) => i._tag), ["b", "a"]);
});

test("env entries load BEFORE dir entries; dir entries are alphabetical; non-.mjs ignored", async () => {
  const importer = fakeImporter({
    "e.mjs": mod(() => ({ interceptors: [interceptor("env")] })),
    "d1.mjs": mod(() => ({ interceptors: [interceptor("d1")] })),
    "d2.mjs": mod(() => ({ interceptors: [interceptor("d2")] })),
  });
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/x/e.mjs", AGENT_RELAY_PLUGIN_DIR: "/plugins" }, dataDir: null },
    { importer, readEntries: () => files("d2.mjs", "d1.mjs", "notes.txt", "readme.md"), readJson: () => ({}) },
  );
  assert.deepEqual(reg.interceptors.map((i) => i._tag), ["env", "d1", "d2"]);
});

test("default plugin dir is <extension-dir>/plugins (the extension's OWN folder), not <dataDir>", async () => {
  let scanned = null;
  const importer = fakeImporter({ "a.mjs": mod(() => ({ interceptors: [interceptor("a")] })) });
  await loadPlugins(
    { env: {}, dataDir: "/data" }, // dataDir is for plugin STATE, not plugin location
    {
      importer,
      baseDir: "/ext", // stand-in for the installed extension root
      readEntries: (dir) => { scanned = dir; return files("a.mjs"); },
      readJson: () => ({}),
    },
  );
  assert.match(scanned, /[\\/]ext[\\/]plugins$/);
});

test("the importer receives a file: URL (cross-platform path handling)", async () => {
  const received = [];
  const importer = fakeImporter({ "rel.mjs": mod(() => ({ interceptors: [interceptor()] })) }, received);
  await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "rel.mjs" }, dataDir: null }, // relative -> resolved to absolute
    { importer, ...noScan },
  );
  assert.equal(received.length, 1);
  assert.match(received[0], /^file:\/\//);
});

// -- package-folder resolution ------------------------------------------------

test("package folders resolve the entry via agentRelay.entry -> main -> index.mjs", async () => {
  const importer = fakeImporter({
    "entry.mjs": mod(() => ({ interceptors: [interceptor("viaEntry")] })),
    "main.mjs": mod(() => ({ interceptors: [interceptor("viaMain")] })),
    "index.mjs": mod(() => ({ interceptors: [interceptor("viaIndex")] })),
  });
  const pkgs = {
    pkgA: { agentRelay: { entry: "entry.mjs" }, main: "main.mjs" }, // agentRelay.entry wins
    pkgB: { main: "main.mjs" }, // main wins
    pkgC: {}, // default index.mjs
  };
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGIN_DIR: "/plugins" }, dataDir: null },
    {
      importer,
      readEntries: () => dirs("pkgA", "pkgB", "pkgC"),
      readJson: (p) => {
        const seg = p.replace(/\\/g, "/").split("/");
        return pkgs[seg[seg.length - 2]];
      },
    },
  );
  assert.deepEqual(reg.interceptors.map((i) => i._tag), ["viaEntry", "viaMain", "viaIndex"]);
});

test("a subdirectory without package.json is ignored (not a plugin)", async () => {
  const importer = fakeImporter({ "index.mjs": mod(() => ({ interceptors: [interceptor("x")] })) });
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGIN_DIR: "/plugins" }, dataDir: null },
    {
      importer,
      readEntries: () => dirs("notapkg"),
      readJson: () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    },
  );
  assert.deepEqual(reg.interceptors, []);
  assert.equal(reg.transport, null);
});

test("a subdirectory whose package.json won't PARSE is fail-loud (broken plugin, not ignored)", async () => {
  const importer = fakeImporter({});
  await assert.rejects(
    loadPlugins(
      { env: { AGENT_RELAY_PLUGIN_DIR: "/plugins" }, dataDir: null },
      {
        importer,
        readEntries: () => dirs("brokenpkg"),
        // package.json EXISTS but is malformed JSON → SyntaxError (no .code) → must THROW.
        readJson: () => { throw new SyntaxError("Unexpected token } in JSON"); },
      },
    ),
    /plugin "brokenpkg".*package\.json is unreadable/,
  );
});

test("interceptors from all plugins aggregate in load order", async () => {
  const importer = fakeImporter({
    "a.mjs": mod(() => ({ interceptors: [interceptor("a1"), interceptor("a2")] })),
    "b.mjs": mod(() => ({ interceptors: [interceptor("b1")] })),
  });
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/a.mjs,/p/b.mjs" }, dataDir: null },
    { importer, ...noScan },
  );
  assert.deepEqual(reg.interceptors.map((i) => i._tag), ["a1", "a2", "b1"]);
});

test("a renderPrompt-only interceptor is accepted", async () => {
  const importer = fakeImporter({ "r.mjs": mod(() => ({ interceptors: [{ renderPrompt: () => "x" }] })) });
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/r.mjs" }, dataDir: null },
    { importer, ...noScan },
  );
  assert.equal(reg.interceptors.length, 1);
});

test("transport, credentials, and identity are single-instance, last-loaded wins", async () => {
  const importer = fakeImporter({
    "first.mjs": mod(() => ({
      transport: { id: "t1", create: () => ({ _t: "t1" }) },
      credentials: () => ({ async get() { return "c1"; } }),
      identity: { resolve: async () => ({ name: "i1" }) },
    })),
    "second.mjs": mod(() => ({
      transport: { id: "t2", create: () => ({ _t: "t2" }) },
      credentials: () => ({ async get() { return "c2"; } }),
      identity: { resolve: async () => ({ name: "i2" }) },
    })),
  });
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/first.mjs,/p/second.mjs" }, dataDir: null },
    { importer, ...noScan },
  );
  assert.equal(reg.transport.id, "t2");
  assert.equal(reg.transport.create()._t, "t2");
  assert.equal(await reg.credentials.get(), "c2");
  assert.equal((await reg.identity.resolve()).name, "i2");
});

test("a credentials factory is invoked once and its provider (not the factory) is stored", async () => {
  let calls = 0;
  const provider = { async get() { return "tok"; } };
  const importer = fakeImporter({
    "c.mjs": mod(() => ({ credentials: () => { calls += 1; return provider; } })),
  });
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/c.mjs" }, dataDir: null },
    { importer, ...noScan },
  );
  assert.equal(calls, 1);
  assert.equal(reg.credentials, provider);
  assert.equal(await reg.credentials.get(), "tok");
});

test("nothing configured -> empty registry", async () => {
  const reg = await loadPlugins({ env: {}, dataDir: null }, { importer: fakeImporter({}), ...noScan });
  assert.deepEqual(reg.interceptors, []);
  assert.equal(reg.transport, null);
  assert.equal(reg.credentials, null);
  assert.equal(reg.identity, null);
});

test("a successfully loaded plugin is logged by name", async () => {
  const logs = [];
  const importer = fakeImporter({ "a.mjs": mod(() => ({ interceptors: [interceptor("a")] })) });
  await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/a.mjs" }, dataDir: null, log: (m) => logs.push(m) },
    { importer, ...noScan },
  );
  assert.ok(logs.some((m) => /plugin loaded: a\.mjs/.test(m)));
});

// -- fail-loud (each names the plugin) ----------------------------------------

test("an import error throws, naming the plugin", async () => {
  const importer = fakeImporter({ "boom.mjs": new Error("evaluation blew up") });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/boom.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "boom\.mjs" failed to load: evaluation blew up/,
  );
});

test("a non-function default export throws", async () => {
  const importer = fakeImporter({ "obj.mjs": { default: { interceptors: [] } } });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/obj.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "obj\.mjs" failed to load: default export is not a factory function/,
  );
});

test("a factory that throws is surfaced, naming the plugin", async () => {
  const importer = fakeImporter({ "throw.mjs": mod(() => { throw new Error("factory boom"); }) });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/throw.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "throw\.mjs" failed to load: factory boom/,
  );
});

test("a factory returning undefined throws (invalid registration)", async () => {
  const importer = fakeImporter({ "u.mjs": mod(() => undefined) });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/u.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "u\.mjs" failed to load: registration is empty or not an object/,
  );
});

test("a registration with no usable capability throws", async () => {
  const importer = fakeImporter({ "empty.mjs": mod(() => ({})) });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/empty.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "empty\.mjs" registered no usable capability/,
  );
});

test("a malformed interceptor (no function hook) throws", async () => {
  const importer = fakeImporter({ "badint.mjs": mod(() => ({ interceptors: [{ onReceive: true }] })) });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/badint.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "badint\.mjs" failed to load: interceptor #0/,
  );
});

test("a transport without create() throws", async () => {
  const importer = fakeImporter({ "badt.mjs": mod(() => ({ transport: { id: "x" } })) });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/badt.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "badt\.mjs" failed to load: transport must be an object with a create\(\) function/,
  );
});

test("credentials that is not a function throws", async () => {
  const importer = fakeImporter({ "badc.mjs": mod(() => ({ credentials: { get: async () => null } })) });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/badc.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "badc\.mjs" failed to load: credentials must be a function/,
  );
});

test("a credentials factory that throws is surfaced, naming the plugin", async () => {
  const importer = fakeImporter({ "cf.mjs": mod(() => ({ credentials: () => { throw new Error("kaboom"); } })) });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/cf.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "cf\.mjs" failed to load: credentials factory threw: kaboom/,
  );
});

test("a credentials provider without get() throws", async () => {
  const importer = fakeImporter({ "cp.mjs": mod(() => ({ credentials: () => ({ nope: true }) })) });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/cp.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "cp\.mjs" failed to load: credentials provider has no get\(\) function/,
  );
});

test("identity without resolve() throws", async () => {
  const importer = fakeImporter({ "badi.mjs": mod(() => ({ identity: {} })) });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/badi.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "badi\.mjs" failed to load: identity must be an object with a resolve\(\) function/,
  );
});

// -- all-or-nothing -----------------------------------------------------------

test("all-or-nothing: a valid transport + a malformed interceptor fails the whole plugin", async () => {
  const importer = fakeImporter({
    "mixed.mjs": mod(() => ({
      transport: { id: "t", create: () => ({ _t: "t" }) }, // valid on its own
      interceptors: [{ not: "a hook" }], // but this is malformed
    })),
  });
  await assert.rejects(
    () => loadPlugins({ env: { AGENT_RELAY_PLUGINS: "/p/mixed.mjs" }, dataDir: null }, { importer, ...noScan }),
    /plugin "mixed\.mjs" failed to load: interceptor #0/,
  );
});

// -- dir failure policy -------------------------------------------------------

test("a missing plugin dir (ENOENT) does not throw; env paths still load", async () => {
  const importer = fakeImporter({ "a.mjs": mod(() => ({ interceptors: [interceptor("a")] })) });
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/a.mjs", AGENT_RELAY_PLUGIN_DIR: "/nope" }, dataDir: null },
    { importer, readEntries: () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }, readJson: () => ({}) },
  );
  assert.deepEqual(reg.interceptors.map((i) => i._tag), ["a"]);
});

test("a plugin dir that exists but is unreadable throws", async () => {
  await assert.rejects(
    () =>
      loadPlugins(
        { env: { AGENT_RELAY_PLUGIN_DIR: "/locked" }, dataDir: null },
        {
          importer: fakeImporter({}),
          readEntries: () => { const e = new Error("EACCES: permission denied"); e.code = "EACCES"; throw e; },
          readJson: () => ({}),
        },
      ),
    /cannot read plugin dir .*locked.*EACCES/,
  );
});
// -- tools + briefing (plugin-contributed capability surface) -----------------

const tool = (name, extra = {}) => ({
  name,
  description: `does ${name}`,
  parameters: { type: "object", properties: {} },
  handler: async () => ({ textResultForLlm: name, resultType: "success" }),
  ...extra,
});

test("a plugin's own registration is rejected before the runtime ever sees the tool", async () => {
  // The runtime turns `parameters` into a JSON Schema during joinSession. If a bad
  // one got that far there would be no session left to report the failure through,
  // so it has to fail here, named.
  await assert.rejects(
    () =>
      loadPlugins(
        { env: { AGENT_RELAY_PLUGINS: "/p/schema.mjs" }, dataDir: null },
        {
          importer: fakeImporter({
            "schema.mjs": mod(() => ({ tools: [tool("x", { parameters: "not-an-object" })] })),
          }),
          ...noScan,
        },
      ),
    /plugin "schema\.mjs".*tool "x" has no parameters object/,
  );
});

test("tools aggregate across plugins in load order, and are recorded per plugin", async () => {
  const importer = fakeImporter({
    "a.mjs": mod(() => ({ name: "a", tools: [tool("alpha")] })),
    "b.mjs": mod(() => ({ tools: [tool("beta"), tool("gamma")] })),
  });
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/a.mjs,/p/b.mjs" }, dataDir: null },
    { importer, ...noScan },
  );

  // Tools travel per-plugin, so the entry can tell which plugin a tool came from —
  // it needs that to disable exactly one plugin's tools if that plugin fails to activate.
  assert.deepEqual(reg.plugins.map((p) => p.name), ["a.mjs", "b.mjs"]);
  assert.deepEqual(reg.plugins[0].tools.map((t) => t.name), ["alpha"]);
  assert.deepEqual(reg.plugins[1].tools.map((t) => t.name), ["beta", "gamma"]);
});

test("briefing text aggregates in load order and is trimmed; blank briefing is not a capability", async () => {
  const importer = fakeImporter({
    "a.mjs": mod(() => ({ briefing: "  use alpha to do things.  " })),
    "b.mjs": mod(() => ({ briefing: "use beta as well." })),
  });
  const reg = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/a.mjs,/p/b.mjs" }, dataDir: null },
    { importer, ...noScan },
  );
  assert.deepEqual(reg.briefings, ["use alpha to do things.", "use beta as well."]);
  assert.equal(reg.plugins[0].briefing, "use alpha to do things.");

  // Whitespace-only briefing declares nothing usable -> same failure as an empty registration.
  await assert.rejects(
    () =>
      loadPlugins(
        { env: { AGENT_RELAY_PLUGINS: "/p/blank.mjs" }, dataDir: null },
        { importer: fakeImporter({ "blank.mjs": mod(() => ({ briefing: "   " })) }), ...noScan },
      ),
    /registered no usable capability/,
  );
});

test("a tools-only or briefing-only registration is usable on its own", async () => {
  const toolsOnly = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/t.mjs" }, dataDir: null },
    { importer: fakeImporter({ "t.mjs": mod(() => ({ tools: [tool("solo")] })) }), ...noScan },
  );
  assert.equal(toolsOnly.plugins[0].tools.length, 1);

  const briefingOnly = await loadPlugins(
    { env: { AGENT_RELAY_PLUGINS: "/p/br.mjs" }, dataDir: null },
    { importer: fakeImporter({ "br.mjs": mod(() => ({ briefing: "hello" })) }), ...noScan },
  );
  assert.deepEqual(briefingOnly.briefings, ["hello"]);
});

// -- tool-name collisions: all three forms fail loud, naming the plugin -------

test("collision ACROSS plugins throws, naming the claimant and the prior owner", async () => {
  const importer = fakeImporter({
    "first.mjs": mod(() => ({ tools: [tool("shared")] })),
    "second.mjs": mod(() => ({ tools: [tool("shared")] })),
  });
  await assert.rejects(
    () =>
      loadPlugins(
        { env: { AGENT_RELAY_PLUGINS: "/p/first.mjs,/p/second.mjs" }, dataDir: null },
        { importer, ...noScan },
      ),
    /plugin "second\.mjs".*tool "shared" is already provided by plugin "first\.mjs"/,
  );
});

test("collision WITHIN one registration throws", async () => {
  await assert.rejects(
    () =>
      loadPlugins(
        { env: { AGENT_RELAY_PLUGINS: "/p/dup.mjs" }, dataDir: null },
        {
          importer: fakeImporter({ "dup.mjs": mod(() => ({ tools: [tool("twice"), tool("twice")] })) }),
          ...noScan,
        },
      ),
    /plugin "dup\.mjs".*declares tool "twice" more than once/,
  );
});

test("collision with a RESERVED host tool throws — a plugin cannot shadow send_message", async () => {
  await assert.rejects(
    () =>
      loadPlugins(
        {
          env: { AGENT_RELAY_PLUGINS: "/p/shadow.mjs" },
          dataDir: null,
          reservedToolNames: ["send_message", "list_relay_agents"],
        },
        {
          importer: fakeImporter({ "shadow.mjs": mod(() => ({ tools: [tool("send_message")] })) }),
          ...noScan,
        },
      ),
    /plugin "shadow\.mjs".*tool "send_message" is reserved by agent-relay itself/,
  );
});

// -- tool shape validation ----------------------------------------------------

test("an invalid tool is a load failure naming the plugin (all-or-nothing)", async () => {
  const cases = [
    [{ tools: "nope" }, /tools must be an array/],
    [{ tools: [null] }, /tool #0 is not an object/],
    [{ tools: [{ handler: () => {} }] }, /tool #0 has no name/],
    [{ tools: [{ name: "x", parameters: {}, handler: () => {} }] }, /tool "x" has no description/],
    [{ tools: [{ name: "x", description: "  ", parameters: {}, handler: () => {} }] }, /tool "x" has no description/],
    [{ tools: [{ name: "x", description: "d", handler: () => {} }] }, /tool "x" has no parameters object/],
    [{ tools: [{ name: "x", description: "d", parameters: [], handler: () => {} }] }, /tool "x" has no parameters object/],
    [{ tools: [{ name: "x", description: "d", parameters: {} }] }, /tool "x" has no handler function/],
    [{ briefing: 42 }, /briefing must be a string/],
  ];
  for (const [registration, pattern] of cases) {
    await assert.rejects(
      () =>
        loadPlugins(
          { env: { AGENT_RELAY_PLUGINS: "/p/bad.mjs" }, dataDir: null },
          { importer: fakeImporter({ "bad.mjs": mod(() => registration) }), ...noScan },
        ),
      pattern,
    );
  }
});

test("a plugin that fails validation contributes NOTHING — not even its valid tools", async () => {
  // `bad` declares one valid tool and then an invalid one. The whole registration
  // must be refused, so `alsoValid` never reaches the aggregate.
  const importer = fakeImporter({
    "good.mjs": mod(() => ({ tools: [tool("kept")] })),
    "bad.mjs": mod(() => ({ tools: [tool("alsoValid"), { name: "broken" }] })),
  });
  await assert.rejects(
    () =>
      loadPlugins(
        { env: { AGENT_RELAY_PLUGINS: "/p/good.mjs,/p/bad.mjs" }, dataDir: null },
        { importer, ...noScan },
      ),
    /plugin "bad\.mjs"/,
  );
  // NOTE: that the registry itself is left untouched after a failed fold is not
  // observable through loadPlugins — it throws rather than returning the partial
  // result — so it is deliberately not asserted here. Asserting it via a second,
  // fresh loadPlugins call would prove nothing: that call allocates its own state
  // and passes whether or not the first one committed early.
});

test("zero plugins yields empty aggregates, not undefined", async () => {
  const reg = await loadPlugins({ env: {}, dataDir: null }, { importer: fakeImporter({}), ...noScan });
  assert.deepEqual(reg.briefings, []);
  assert.deepEqual(reg.plugins, []);
});

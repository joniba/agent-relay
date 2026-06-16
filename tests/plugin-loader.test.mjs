import { test } from "node:test";
import assert from "node:assert/strict";

import { loadExternalInterceptors } from "../extension/plugins/loader.mjs";

// ── Test doubles ─────────────────────────────────────────────────────────────

// Fake importer keyed by module BASENAME; records the URLs it received. A map value:
//   - { default: fn } → a normal module
//   - Error           → simulates import() throwing (module-evaluation failure)
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
const passthrough = (tag) => () => ({ onReceive: (m, next) => next(m), _tag: tag });

function recordingLog() {
  const logs = [];
  return { log: (msg, opts) => logs.push({ msg, opts }), logs };
}

// ── env-var pointer source ────────────────────────────────────────────────────

test("env pointer loads listed modules in listed order (not alphabetical)", async () => {
  const importer = fakeImporter({ "a.mjs": mod(passthrough("a")), "b.mjs": mod(passthrough("b")) });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/p/b.mjs,/p/a.mjs" }, dataDir: null },
    { importer, readdir: () => [] },
  );
  assert.deepEqual(out.map((i) => i._tag), ["b", "a"]);
});

test("the importer receives a file: URL (cross-platform path handling)", async () => {
  const received = [];
  const importer = fakeImporter({ "rel.mjs": mod(passthrough()) }, received);
  await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "rel.mjs" }, dataDir: null }, // relative → resolved to absolute
    { importer, readdir: () => [] },
  );
  assert.equal(received.length, 1);
  assert.match(received[0], /^file:\/\//);
});

// ── plugin-dir source ──────────────────────────────────────────────────────────

test("plugin dir scans *.mjs alphabetically and ignores non-.mjs", async () => {
  const importer = fakeImporter({ "a.mjs": mod(passthrough("a")), "b.mjs": mod(passthrough("b")) });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_PLUGIN_DIR: "/plugins" }, dataDir: null },
    { importer, readdir: () => ["b.mjs", "a.mjs", "notes.txt", "readme.md"] },
  );
  assert.deepEqual(out.map((i) => i._tag), ["a", "b"]);
});

test("env entries load BEFORE plugin-dir entries", async () => {
  const importer = fakeImporter({ "e.mjs": mod(passthrough("env")), "d.mjs": mod(passthrough("dir")) });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/x/e.mjs", AGENT_RELAY_PLUGIN_DIR: "/plugins" }, dataDir: null },
    { importer, readdir: () => ["d.mjs"] },
  );
  assert.deepEqual(out.map((i) => i._tag), ["env", "dir"]);
});

test("default plugin dir is <dataDir>/plugins when no override", async () => {
  let scanned = null;
  const importer = fakeImporter({ "a.mjs": mod(passthrough("a")) });
  await loadExternalInterceptors(
    { env: {}, dataDir: "/data" },
    { importer, readdir: (dir) => { scanned = dir; return ["a.mjs"]; } },
  );
  assert.match(scanned, /[\\/]data[\\/]plugins$/);
});

// ── contract validation ────────────────────────────────────────────────────────

test("a non-function default export is skipped", async () => {
  const { log, logs } = recordingLog();
  const importer = fakeImporter({ "obj.mjs": { default: { onReceive() {} } } }); // object default ≠ factory
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/p/obj.mjs" }, dataDir: null, log },
    { importer, readdir: () => [] },
  );
  assert.equal(out.length, 0);
  assert.ok(logs.some((l) => /skipped: obj\.mjs/.test(l.msg) && l.opts?.level === "warning"));
});

test("a result with a present-but-non-function hook is skipped", async () => {
  const importer = fakeImporter({ "bad.mjs": mod(() => ({ onReceive: true })) });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/p/bad.mjs" }, dataDir: null },
    { importer, readdir: () => [] },
  );
  assert.equal(out.length, 0);
});

test("a renderPrompt-only interceptor is accepted", async () => {
  const importer = fakeImporter({ "r.mjs": mod(() => ({ renderPrompt: () => "x" })) });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/p/r.mjs" }, dataDir: null },
    { importer, readdir: () => [] },
  );
  assert.equal(out.length, 1);
});

// ── safe-degrade (load-time) ────────────────────────────────────────────────────

test("a module that throws on import is skipped; later modules still load", async () => {
  const importer = fakeImporter({ "boom.mjs": new Error("evaluation blew up"), "ok.mjs": mod(passthrough("ok")) });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/p/boom.mjs,/p/ok.mjs" }, dataDir: null },
    { importer, readdir: () => [] },
  );
  assert.deepEqual(out.map((i) => i._tag), ["ok"]);
});

test("a factory that throws (sync) is skipped; later modules still load", async () => {
  const importer = fakeImporter({
    "throw.mjs": mod(() => { throw new Error("factory boom"); }),
    "ok.mjs": mod(passthrough("ok")),
  });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/p/throw.mjs,/p/ok.mjs" }, dataDir: null },
    { importer, readdir: () => [] },
  );
  assert.deepEqual(out.map((i) => i._tag), ["ok"]);
});

test("an async factory that rejects is skipped; later modules still load", async () => {
  const importer = fakeImporter({
    "reject.mjs": mod(async () => { throw new Error("async boom"); }),
    "ok.mjs": mod(passthrough("ok")),
  });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/p/reject.mjs,/p/ok.mjs" }, dataDir: null },
    { importer, readdir: () => [] },
  );
  assert.deepEqual(out.map((i) => i._tag), ["ok"]);
});

test("loadExternalInterceptors NEVER throws, even when every module fails", async () => {
  const importer = fakeImporter({}); // every import → not found → throws
  await assert.doesNotReject(() =>
    loadExternalInterceptors(
      { env: { AGENT_RELAY_INTERCEPTORS: "/p/x.mjs,/p/y.mjs" }, dataDir: null },
      { importer, readdir: () => [] },
    ),
  );
});

// ── zero-config / dataDir / scan errors ──────────────────────────────────────────

test("nothing configured → returns [] (zero-impact, today's behavior)", async () => {
  const out = await loadExternalInterceptors(
    { env: {}, dataDir: null },
    { importer: fakeImporter({}), readdir: () => [] },
  );
  assert.deepEqual(out, []);
});

test("dataDir null → env paths still load, default plugin dir is skipped", async () => {
  let readdirCalled = false;
  const importer = fakeImporter({ "a.mjs": mod(passthrough("a")) });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/p/a.mjs" }, dataDir: null },
    { importer, readdir: () => { readdirCalled = true; return []; } },
  );
  assert.equal(out.length, 1);
  assert.equal(readdirCalled, false);
});

test("dataDir null + AGENT_RELAY_PLUGIN_DIR set → the override dir is still scanned", async () => {
  let scanned = null;
  const importer = fakeImporter({ "a.mjs": mod(passthrough("a")) });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_PLUGIN_DIR: "/override" }, dataDir: null },
    { importer, readdir: (dir) => { scanned = dir; return ["a.mjs"]; } },
  );
  assert.match(scanned, /override/);
  assert.equal(out.length, 1);
});

test("a missing plugin dir (ENOENT) → [] with no error", async () => {
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_PLUGIN_DIR: "/nope" }, dataDir: null },
    {
      importer: fakeImporter({}),
      readdir: () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    },
  );
  assert.deepEqual(out, []);
});

test("a non-ENOENT scan error is logged + skipped; env plugins still load; never throws", async () => {
  const { log, logs } = recordingLog();
  const importer = fakeImporter({ "a.mjs": mod(passthrough("a")) });
  const out = await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/p/a.mjs", AGENT_RELAY_PLUGIN_DIR: "/locked" }, dataDir: null, log },
    {
      importer,
      readdir: () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e; },
    },
  );
  assert.deepEqual(out.map((i) => i._tag), ["a"]);
  assert.ok(logs.some((l) => /scan failed/.test(l.msg) && l.opts?.level === "warning"));
});

test("loaded/skipped activity is logged as metadata (ids/names only)", async () => {
  const { log, logs } = recordingLog();
  const importer = fakeImporter({ "a.mjs": mod(passthrough("a")), "bad.mjs": new Error("nope") });
  await loadExternalInterceptors(
    { env: { AGENT_RELAY_INTERCEPTORS: "/p/a.mjs,/p/bad.mjs" }, dataDir: null, log },
    { importer, readdir: () => [] },
  );
  assert.ok(logs.some((l) => /plugin loaded: a\.mjs/.test(l.msg)));
  assert.ok(logs.some((l) => /plugin skipped: bad\.mjs/.test(l.msg) && l.opts?.level === "warning"));
});

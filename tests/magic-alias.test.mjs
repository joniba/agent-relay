import { test } from "node:test";
import assert from "node:assert/strict";

import { createMagicAliasIdentity } from "../extension/identity/magic-alias.mjs";

// ─── helpers ─────────────────────────────────────────────────────────────────

const fakeFallback = { async resolve(s) { return { id: s.sessionId, name: "folderleaf" }; } };

function makeState(pairs) {
  // pairs: [{ alias, agent_task_id }, ...] → { entries: { tN: {...} } }
  const entries = {};
  pairs.forEach((p, i) => {
    entries[`t${i}`] = p;
  });
  return { schemaVersion: 1, entries };
}

function makeSession(sessionId = "sid") {
  const logs = [];
  return {
    session: { sessionId, log: (m, o) => logs.push({ m, o }) },
    logs,
  };
}

async function waitFor(predicate, { timeoutMs = 1000, stepMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

const tick = () => new Promise((r) => setTimeout(r, 40));

// ─── B2 (synchronous read) ──────────────────────────────────────────────────

test("B2 hit: resolve returns the matching alias, id unchanged", async () => {
  const { session } = makeSession("sid");
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: { env: {}, readAliases: () => makeState([{ alias: "stone", agent_task_id: "sid" }]) },
  });
  const self = await identity.resolve(session);
  assert.equal(self.name, "stone");
  assert.equal(self.id, "sid");
});

test("B2 miss: resolve falls back to the fallback name", async () => {
  const { session } = makeSession("sid");
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: { env: {}, readAliases: () => makeState([]), isMagicPresent: () => false },
  });
  const self = await identity.resolve(session);
  assert.equal(self.name, "folderleaf");
});

test("explicit AGENT_RELAY_NAME hard-short-circuits: no alias read at all", async () => {
  const { session } = makeSession("sid");
  let read = 0;
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: { env: { AGENT_RELAY_NAME: "frontend" }, readAliases: () => { read += 1; return makeState([{ alias: "stone", agent_task_id: "sid" }]); } },
  });
  const self = await identity.resolve(session);
  assert.equal(self.name, "folderleaf"); // fallback used
  assert.equal(read, 0, "readAliases must NOT be called when AGENT_RELAY_NAME is set");
});

test("fail-closed: unreadable map (null) → fallback", async () => {
  const { session } = makeSession("sid");
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: { env: {}, readAliases: () => null, isMagicPresent: () => false },
  });
  assert.equal((await identity.resolve(session)).name, "folderleaf");
});

test("fail-closed: multiple entries match the same session id → fallback", async () => {
  const { session } = makeSession("sid");
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: {
      env: {},
      readAliases: () => makeState([
        { alias: "a", agent_task_id: "sid" },
        { alias: "b", agent_task_id: "sid" },
      ]),
      isMagicPresent: () => false,
    },
  });
  assert.equal((await identity.resolve(session)).name, "folderleaf");
});

test("exactly-one match among several entries wins", async () => {
  const { session } = makeSession("sid");
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: {
      env: {},
      readAliases: () => makeState([
        { alias: "other", agent_task_id: "nope" },
        { alias: "stone", agent_task_id: "sid" },
        { alias: "noid" }, // missing agent_task_id — ignored
      ]),
    },
  });
  assert.equal((await identity.resolve(session)).name, "stone");
});

// ─── bridge key ──────────────────────────────────────────────────────────────

test("bridge key uses COPILOT_AGENT_SESSION_ID over session.sessionId, logs mismatch", async () => {
  const { session, logs } = makeSession("sdkid");
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: {
      env: { COPILOT_AGENT_SESSION_ID: "envid" },
      readAliases: () => makeState([{ alias: "stone", agent_task_id: "envid" }]),
    },
  });
  const self = await identity.resolve(session);
  assert.equal(self.name, "stone"); // matched on env id, not sdk id
  assert.ok(logs.some((l) => /mismatch/i.test(l.m)), "expected a mismatch diagnostic");
});

// ─── B3 (async promotion) ────────────────────────────────────────────────────

test("onChange returns a dispose function", async () => {
  const { session } = makeSession("sid");
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: { env: {}, readAliases: () => makeState([{ alias: "stone", agent_task_id: "sid" }]) },
  });
  await identity.resolve(session);
  const dispose = identity.onChange(() => {});
  assert.equal(typeof dispose, "function");
});

test("B3 promotion: cold B2 miss → warm + re-read → onChange fires with the alias", async () => {
  const { session } = makeSession("sid");
  let reads = 0;
  let warmed = false;
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: {
      env: {},
      // First read (during resolve) misses; subsequent reads (after warm) hit.
      readAliases: () => {
        reads += 1;
        return reads === 1 ? makeState([]) : makeState([{ alias: "stone", agent_task_id: "sid" }]);
      },
      isMagicPresent: () => true,
      warmCache: async () => { warmed = true; },
      retryDelayMs: 0,
    },
  });
  const self = await identity.resolve(session);
  assert.equal(self.name, "folderleaf"); // boot stays on fallback

  let received = null;
  identity.onChange((next) => { received = next; });
  assert.ok(await waitFor(() => received !== null), "onChange never fired");
  assert.equal(received.name, "stone");
  assert.equal(received.id, "sid");
  assert.equal(warmed, true);
});

test("dispose() aborts an in-flight promotion: onChange never fires", async () => {
  const { session } = makeSession("sid");
  let reads = 0;
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: {
      env: {},
      // miss at boot (arms B3); would hit after warm if it continued.
      readAliases: () => {
        reads += 1;
        return reads === 1 ? makeState([]) : makeState([{ alias: "stone", agent_task_id: "sid" }]);
      },
      isMagicPresent: () => true,
      // Warm resolves ONLY when aborted — lets us dispose mid-flight.
      warmCache: ({ signal }) => new Promise((res) => signal.addEventListener("abort", () => res(), { once: true })),
      retryDelayMs: 0,
    },
  });
  await identity.resolve(session); // B2 miss → promotion armed

  let received = null;
  const dispose = identity.onChange((next) => { received = next; });
  dispose(); // abort before warm completes
  await tick();
  assert.equal(received, null, "promotion fired despite dispose");
});

test("magic absent: B3 never arms — warm not spawned, onChange never fires", async () => {
  const { session } = makeSession("sid");
  let warmCalls = 0;
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: {
      env: {},
      readAliases: () => makeState([]),
      isMagicPresent: () => false,
      warmCache: async () => { warmCalls += 1; },
      retryDelayMs: 0,
    },
  });
  await identity.resolve(session);
  let received = null;
  identity.onChange((next) => { received = next; });
  await tick();
  assert.equal(warmCalls, 0, "warmCache must not run when magic is absent");
  assert.equal(received, null);
});

test("warm B2 hit: already resolved → no promotion, no warm spawn", async () => {
  const { session } = makeSession("sid");
  let warmCalls = 0;
  const identity = createMagicAliasIdentity({
    fallback: fakeFallback,
    deps: {
      env: {},
      readAliases: () => makeState([{ alias: "stone", agent_task_id: "sid" }]),
      isMagicPresent: () => true,
      warmCache: async () => { warmCalls += 1; },
    },
  });
  assert.equal((await identity.resolve(session)).name, "stone");
  let received = null;
  identity.onChange((next) => { received = next; });
  await tick();
  assert.equal(warmCalls, 0, "no warm when the alias was already resolved at boot");
  assert.equal(received, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { createSqlitePollTransport } from "../extension/transports/sqlite-poll.mjs";
import { createFolderNameIdentity } from "../extension/identity/folder-name.mjs";
import { createNoneCredentials } from "../extension/credentials/none.mjs";
import { createMessage } from "../extension/core/message.mjs";

const credentials = createNoneCredentials();

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "agent-relay-test-"));
  return { dbPath: join(dir, "relay.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function waitFor(predicate, { timeoutMs = 1500, stepMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

// ─── identity / credentials adapters ─────────────────────────────

test("folder-name identity: override > env > cwd leaf; id = sessionId", async () => {
  const session = { sessionId: "sess-xyz" };
  const fromOverride = await createFolderNameIdentity({ nameOverride: "tia" }).resolve(session);
  assert.deepEqual(fromOverride, { id: "sess-xyz", name: "tia" });

  const fromCwd = await createFolderNameIdentity({ cwd: "C:/some/path/my-repo" }).resolve(session);
  assert.equal(fromCwd.name, "my-repo");
  assert.equal(fromCwd.id, "sess-xyz");
});

test("none credentials returns null", async () => {
  assert.equal(await createNoneCredentials().get(), null);
});

// ─── sqlite-poll transport ───────────────────────────────────────

test("two instances over one DB: A.send → B receives the same message", async () => {
  const { dbPath, cleanup } = tempDb();
  const alice = createSqlitePollTransport({ dbPath, pollIntervalMs: 15 });
  const bob = createSqlitePollTransport({ dbPath, pollIntervalMs: 15 });
  const aliceId = { id: "a-id", name: "alice" };
  const bobId = { id: "b-id", name: "bob" };

  try {
    await alice.init({ self: aliceId, credentials });
    await bob.init({ self: bobId, credentials });
    await alice.register(aliceId);
    await bob.register(bobId);

    const received = [];
    bob.startReceiving((m) => { received.push(m); });

    const msg = createMessage({ from: "alice", to: "bob", body: "ping", meta: { hop: 1 } });
    const res = await alice.send(msg);
    assert.equal(res.accepted, true);

    const got = await waitFor(() => received.length > 0);
    assert.ok(got, "bob did not receive the message in time");
    assert.equal(received[0].body, "ping");
    assert.equal(received[0].from, "alice");
    assert.deepEqual(received[0].meta, { hop: 1 }); // opaque meta round-trips
  } finally {
    await alice.stop();
    await bob.stop();
    cleanup();
  }
});

test("listAgents shows both registered peers; addressing by id works", async () => {
  const { dbPath, cleanup } = tempDb();
  const alice = createSqlitePollTransport({ dbPath, pollIntervalMs: 15 });
  const bob = createSqlitePollTransport({ dbPath, pollIntervalMs: 15 });
  const aliceId = { id: "a-id", name: "alice" };
  const bobId = { id: "b-id", name: "bob" };
  try {
    await alice.init({ self: aliceId, credentials });
    await bob.init({ self: bobId, credentials });
    await alice.register(aliceId);
    await bob.register(bobId);

    const names = (await alice.listAgents()).map((a) => a.name).sort();
    assert.deepEqual(names, ["alice", "bob"]);

    // address bob by exact id
    const received = [];
    bob.startReceiving((m) => { received.push(m); });
    await alice.send(createMessage({ from: "alice", to: "b-id", body: "by-id" }));
    assert.ok(await waitFor(() => received.length > 0));
    assert.equal(received[0].body, "by-id");
  } finally {
    await alice.stop();
    await bob.stop();
    cleanup();
  }
});

test("send to unknown recipient is rejected with an error", async () => {
  const { dbPath, cleanup } = tempDb();
  const alice = createSqlitePollTransport({ dbPath, pollIntervalMs: 15 });
  const aliceId = { id: "a-id", name: "alice" };
  try {
    await alice.init({ self: aliceId, credentials });
    await alice.register(aliceId);
    const res = await alice.send(createMessage({ from: "alice", to: "ghost", body: "x" }));
    assert.equal(res.accepted, false);
    assert.match(res.error, /no such agent: ghost/);
  } finally {
    await alice.stop();
    cleanup();
  }
});

test("a failing handler is retried then dead-lettered (bounded redelivery)", async () => {
  const { dbPath, cleanup } = tempDb();
  const alice = createSqlitePollTransport({ dbPath, pollIntervalMs: 10 });
  const bob = createSqlitePollTransport({ dbPath, pollIntervalMs: 10, maxAttempts: 3 });
  const aliceId = { id: "a-id", name: "alice" };
  const bobId = { id: "b-id", name: "bob" };
  try {
    await alice.init({ self: aliceId, credentials });
    await bob.init({ self: bobId, credentials });
    await alice.register(aliceId);
    await bob.register(bobId);

    let attempts = 0;
    bob.startReceiving(async () => { attempts += 1; throw new Error("always fails"); });

    await alice.send(createMessage({ from: "alice", to: "bob", body: "poison" }));

    // Retries should stop at maxAttempts (3), not loop forever.
    await waitFor(() => attempts >= 3, { timeoutMs: 1500 });
    const settled = attempts;
    await new Promise((r) => setTimeout(r, 120)); // let more polls fire
    assert.equal(attempts, settled, "redelivery was not bounded");
    assert.equal(attempts, 3);
  } finally {
    await alice.stop();
    await bob.stop();
    cleanup();
  }
});

test("a message is delivered exactly once on success (not re-woken)", async () => {
  const { dbPath, cleanup } = tempDb();
  const alice = createSqlitePollTransport({ dbPath, pollIntervalMs: 10 });
  const bob = createSqlitePollTransport({ dbPath, pollIntervalMs: 10 });
  const aliceId = { id: "a-id", name: "alice" };
  const bobId = { id: "b-id", name: "bob" };
  try {
    await alice.init({ self: aliceId, credentials });
    await bob.init({ self: bobId, credentials });
    await alice.register(aliceId);
    await bob.register(bobId);

    let count = 0;
    bob.startReceiving(() => { count += 1; });
    await alice.send(createMessage({ from: "alice", to: "bob", body: "once" }));
    await waitFor(() => count > 0);
    await new Promise((r) => setTimeout(r, 80)); // several more poll cycles
    assert.equal(count, 1);
  } finally {
    await alice.stop();
    await bob.stop();
    cleanup();
  }
});

test("stop() during an in-flight handler does not crash or use a closed DB", async () => {
  const { dbPath, cleanup } = tempDb();
  const alice = createSqlitePollTransport({ dbPath, pollIntervalMs: 10 });
  const bob = createSqlitePollTransport({ dbPath, pollIntervalMs: 10 });
  const aliceId = { id: "a-id", name: "alice" };
  const bobId = { id: "b-id", name: "bob" };
  try {
    await alice.init({ self: aliceId, credentials });
    await bob.init({ self: bobId, credentials });
    await alice.register(aliceId);
    await bob.register(bobId);

    let release;
    const handlerEntered = new Promise((resolve) => {
      bob.startReceiving(async () => {
        resolve();
        await new Promise((r) => { release = r; }); // park the handler open
      });
    });

    await alice.send(createMessage({ from: "alice", to: "bob", body: "x" }));
    await handlerEntered;            // bob is mid-handler
    const stopP = bob.stop();        // stop() must wait for the in-flight drain
    release();                       // let the handler resolve
    await stopP;                     // must resolve without throwing / unhandled rejection
    assert.ok(true);
  } finally {
    await alice.stop();
    cleanup();
  }
});

test("stop() is idempotent", async () => {
  const { dbPath, cleanup } = tempDb();
  const t = createSqlitePollTransport({ dbPath, pollIntervalMs: 10 });
  try {
    await t.init({ self: { id: "x", name: "x" }, credentials });
    await t.register({ id: "x", name: "x" });
    await t.stop();
    await t.stop(); // second call must be a no-op, not throw
    assert.ok(true);
  } finally {
    cleanup();
  }
});

test("deregister removes a peer from listAgents", async () => {
  const { dbPath, cleanup } = tempDb();
  const alice = createSqlitePollTransport({ dbPath, pollIntervalMs: 15 });
  const bob = createSqlitePollTransport({ dbPath, pollIntervalMs: 15 });
  const aliceId = { id: "a-id", name: "alice" };
  const bobId = { id: "b-id", name: "bob" };
  try {
    await alice.init({ self: aliceId, credentials });
    await bob.init({ self: bobId, credentials });
    await alice.register(aliceId);
    await bob.register(bobId);
    assert.equal((await alice.listAgents()).length, 2);

    await bob.deregister(bobId);
    const names = (await alice.listAgents()).map((a) => a.name);
    assert.deepEqual(names, ["alice"]);
  } finally {
    await alice.stop();
    await bob.stop();
    cleanup();
  }
});

test("listAgents hides a stale (non-heartbeating) peer", async () => {
  const { dbPath, cleanup } = tempDb();
  // alice keeps heartbeating (polling); bob registers but never polls.
  const alice = createSqlitePollTransport({ dbPath, pollIntervalMs: 10, staleMs: 40 });
  const bob = createSqlitePollTransport({ dbPath, pollIntervalMs: 10, staleMs: 40 });
  const aliceId = { id: "a-id", name: "alice" };
  const bobId = { id: "b-id", name: "bob" };
  try {
    await alice.init({ self: aliceId, credentials });
    await bob.init({ self: bobId, credentials });
    await alice.register(aliceId);
    await bob.register(bobId);
    alice.startReceiving(() => {}); // alice heartbeats; bob does not

    await new Promise((r) => setTimeout(r, 90)); // > staleMs
    const names = (await alice.listAgents()).map((a) => a.name);
    assert.deepEqual(names, ["alice"]); // bob aged out
  } finally {
    await alice.stop();
    await bob.stop();
    cleanup();
  }
});

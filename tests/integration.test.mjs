import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { createRelay } from "../extension/core/relay.mjs";
import { createSqlitePollTransport } from "../extension/transports/sqlite-poll.mjs";
import { createFolderNameIdentity } from "../extension/identity/folder-name.mjs";
import { createNoneCredentials } from "../extension/credentials/none.mjs";
import { createCopilotSink } from "../extension/sinks/copilot.mjs";

// Wire a participant exactly as extension.mjs does (sans the SDK): resolve
// identity → init+register transport → build the sink → createRelay → start.
// The fake Copilot session records the prompts it's woken with.
async function bootstrap({ dbPath, name, sessionId }) {
  const wakes = [];
  const session = {
    sessionId,
    async send(arg) { wakes.push(arg); return "ok"; },
    async log() {},
  };
  const identity = createFolderNameIdentity({ nameOverride: name });
  const credentials = createNoneCredentials();
  const transport = createSqlitePollTransport({ dbPath, pollIntervalMs: 15 });
  const self = await identity.resolve(session);
  await transport.init({ self, credentials });
  await transport.register(self);
  const sink = createCopilotSink(session);
  const relay = createRelay({ sink, self, transport, interceptors: [] });
  relay.start();
  return { session, wakes, relay, transport, self };
}

async function waitFor(predicate, { timeoutMs = 1500, stepMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

test("end-to-end: A messages B → B wakes; B replies → A wakes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-relay-e2e-"));
  const dbPath = join(dir, "relay.db");
  let alice, bob;
  try {
    alice = await bootstrap({ dbPath, name: "alice", sessionId: "alice-sess" });
    bob = await bootstrap({ dbPath, name: "bob", sessionId: "bob-sess" });

    // Both see each other.
    const names = (await alice.relay.listAgents()).map((a) => a.name).sort();
    assert.deepEqual(names, ["alice", "bob"]);

    // A sends to B via the SAME entry-point the tool uses.
    const sent = await alice.relay.sendMessage({ to: "bob", content: "what is the build status?" });
    assert.equal(sent.ok, true);

    // B wakes with the message (no human action).
    assert.ok(await waitFor(() => bob.wakes.length > 0), "bob did not wake");
    assert.match(bob.wakes[0].prompt, /alice/);
    assert.match(bob.wakes[0].prompt, /build status/);
    assert.equal(bob.wakes[0].mode, "immediate");

    // B replies → A wakes.
    const reply = await bob.relay.sendMessage({ to: "alice", content: "green", inReplyTo: sent.id });
    assert.equal(reply.ok, true);
    assert.ok(await waitFor(() => alice.wakes.length > 0), "alice did not wake on reply");
    assert.match(alice.wakes[0].prompt, /bob/);
    assert.match(alice.wakes[0].prompt, /green/);
  } finally {
    if (alice) { await alice.transport.deregister(alice.self); await alice.relay.stop(); }
    if (bob) { await bob.transport.deregister(bob.self); await bob.relay.stop(); }
    rmSync(dir, { recursive: true, force: true });
  }
});

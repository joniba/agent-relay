import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { createRelay } from "../extension/core/relay.mjs";
import { createSqlitePollTransport } from "../extension/transports/sqlite-poll.mjs";
import { createFolderNameIdentity } from "../extension/identity/folder-name.mjs";
import { createNoneCredentials } from "../extension/credentials/none.mjs";

// Wire a participant exactly as extension.mjs does (sans the SDK): resolve
// identity → init+register transport → createRelay → start. The "session" is a
// fake whose send() is the wake spy.
async function bootstrap({ dbPath, name, sessionId }) {
  const session = {
    sessionId,
    wakes: [],
    async send(arg) { this.wakes.push(arg); return "ok"; },
    async log() {},
  };
  const identity = createFolderNameIdentity({ nameOverride: name });
  const credentials = createNoneCredentials();
  const transport = createSqlitePollTransport({ dbPath, pollIntervalMs: 15 });
  const self = await identity.resolve(session);
  await transport.init({ self, credentials });
  await transport.register(self);
  const relay = createRelay({ session, self, transport, interceptors: [] });
  relay.start();
  return { session, relay, transport, self };
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
    assert.ok(await waitFor(() => bob.session.wakes.length > 0), "bob did not wake");
    assert.match(bob.session.wakes[0].prompt, /alice/);
    assert.match(bob.session.wakes[0].prompt, /build status/);
    assert.equal(bob.session.wakes[0].mode, "immediate");

    // B replies → A wakes.
    const reply = await bob.relay.sendMessage({ to: "alice", content: "green", inReplyTo: sent.id });
    assert.equal(reply.ok, true);
    assert.ok(await waitFor(() => alice.session.wakes.length > 0), "alice did not wake on reply");
    assert.match(alice.session.wakes[0].prompt, /bob/);
    assert.match(alice.session.wakes[0].prompt, /green/);
  } finally {
    if (alice) { await alice.transport.deregister(alice.self); await alice.relay.stop(); }
    if (bob) { await bob.transport.deregister(bob.self); await bob.relay.stop(); }
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRelayLog } from "../extension/logging/relay-log.mjs";

function harness({ booting = false } = {}) {
  const file = [];
  const term = [];
  const relayLog = createRelayLog({
    sessionLog: (m, o) => term.push({ m, o }),
    fileLog: (m, o) => file.push({ m, o }),
    isBooting: () => booting,
  });
  return { relayLog, file, term };
}

test("every line is written to the file log", () => {
  const { relayLog, file } = harness();
  relayLog("boot transport=local");
  relayLog("sent msg=1 to=bob (3ms)");
  relayLog("oops", { level: "error" });
  assert.equal(file.length, 3);
});

test("routine info lines do NOT reach the terminal (file-only)", () => {
  const { relayLog, term } = harness();
  relayLog("boot transport=postgres host=h datadir=d");
  relayLog("sent msg=1 to=bob (3ms)");
  relayLog("list 4 agent(s) (12ms)");
  assert.equal(term.length, 0);
});

test("terminal:true lines reach the terminal", () => {
  const { relayLog, term } = harness();
  relayLog("🌐 agent-relay: connected to remote transport as [ruby]", { terminal: true });
  assert.deepEqual(term.map((t) => t.m), ["🌐 agent-relay: connected to remote transport as [ruby]"]);
});

test("errors always reach the terminal (booting or not)", () => {
  const booting = harness({ booting: true });
  booting.relayLog("failed to start", { level: "error" });
  const running = harness({ booting: false });
  running.relayLog("failed mid-run", { level: "error" });
  assert.equal(booting.term.length, 1);
  assert.equal(running.term.length, 1);
});

test("warnings reach the terminal ONLY while booting", () => {
  const booting = harness({ booting: true });
  booting.relayLog("transport connect failed (attempt 1/3)", { level: "warning" });
  assert.equal(booting.term.length, 1, "a startup connect-retry warning surfaces inline");

  const running = harness({ booting: false });
  running.relayLog("postgres sweep was slow", { level: "warning" });
  assert.equal(running.term.length, 0, "a runtime warning stays file-only");
});

test("a throwing sessionLog never escapes (logging can't disrupt the relay)", () => {
  const file = [];
  const relayLog = createRelayLog({
    sessionLog: () => {
      throw new Error("sync boom");
    },
    fileLog: (m) => file.push(m),
  });
  assert.doesNotThrow(() => relayLog("x", { level: "error" }));
  assert.equal(file.length, 1, "the file write still happened");
});

test("a rejecting sessionLog never escapes as an unhandled rejection", async () => {
  const relayLog = createRelayLog({
    sessionLog: () => Promise.reject(new Error("async boom")),
    fileLog: () => {},
  });
  assert.doesNotThrow(() => relayLog("x", { level: "error" }));
  await Promise.resolve(); // give the swallowed rejection a tick to settle
});

test("a missing sessionLog is fine (file-only sink)", () => {
  const file = [];
  const relayLog = createRelayLog({ fileLog: (m) => file.push(m) });
  assert.doesNotThrow(() => relayLog("connected", { terminal: true }));
  assert.equal(file.length, 1);
});

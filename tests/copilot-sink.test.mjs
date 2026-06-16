import { test } from "node:test";
import assert from "node:assert/strict";

import { createCopilotSink } from "../extension/sinks/copilot.mjs";

test("copilot sink wakes via session.send with immediate mode", async () => {
  const sends = [];
  const session = { sessionId: "s1", async send(arg) { sends.push(arg); return "id"; } };
  const sink = createCopilotSink(session);
  await sink.wake("hello");
  assert.deepEqual(sends, [{ prompt: "hello", mode: "immediate" }]);
});

test("copilot sink delegates log when present, omits it when absent", async () => {
  const logs = [];
  const withLog = createCopilotSink({
    sessionId: "s",
    async send() {},
    async log(m, o) { logs.push({ m, o }); },
  });
  await withLog.log("hi", { level: "warning" });
  assert.deepEqual(logs, [{ m: "hi", o: { level: "warning" } }]);

  const noLog = createCopilotSink({ sessionId: "s", async send() {} });
  assert.equal(noLog.log, undefined); // optional — omitted when the runtime has none
});

test("an injected log overrides session.log (so the core's lines reach the file log)", async () => {
  const sessionLogs = [];
  const injected = [];
  const session = {
    sessionId: "s",
    async send() {},
    async log(m) { sessionLogs.push(m); },
  };
  const sink = createCopilotSink(session, (m, o) => injected.push({ m, o }));
  await sink.log("recv msg=1 from=bob", { level: undefined });
  assert.deepEqual(injected, [{ m: "recv msg=1 from=bob", o: { level: undefined } }]);
  assert.equal(sessionLogs.length, 0, "session.log is NOT used when a log is injected");
});

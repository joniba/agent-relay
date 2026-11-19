import assert from "node:assert/strict";
import test from "node:test";
import { joinSession } from "../extension/sdk-compat.mjs";

const missing = (name) => Object.assign(new Error(`Cannot find package '${name}' imported from the adapter`), {
  code: "ERR_MODULE_NOT_FOUND",
});

test("adapts tool definitions and hooks for the current SDK", async () => {
  const tools = [{ name: "test_tool", handler: () => "ok" }];
  const hooks = { onSessionEnd() {} };
  await joinSession({ tools, hooks }, async (name) => {
    assert.equal(name, "@microsoft/copilot-sdk/extension");
    return { joinSession(options) {
      assert.equal(options.tools.definitions, tools);
      assert.equal(options.hooks.handlers, hooks);
    } };
  });
});

test("passes the original options to the legacy SDK when the current package is missing", async () => {
  const options = { tools: [], hooks: { onSessionStart() {} } };
  const calls = [];
  await joinSession(options, async (name) => {
    calls.push(name);
    if (calls.length === 1) throw missing("@microsoft/copilot-sdk");
    return { joinSession: (received) => assert.equal(received, options) };
  });
  assert.deepEqual(calls, ["@microsoft/copilot-sdk/extension", "@github/copilot-sdk/extension"]);
});

test("does not fall back on a missing dependency or a failed join", async () => {
  const dependency = missing("sdk-dependency");
  const failedJoin = missing("@microsoft/copilot-sdk");
  for (const [failure, whenJoining] of [[dependency, false], [failedJoin, true]]) {
    let imports = 0;
    await assert.rejects(joinSession({}, async () => {
      imports += 1;
      if (!whenJoining) throw failure;
      return { joinSession: async () => { throw failure; } };
    }), error => error === failure);
    assert.equal(imports, 1);
  }
});

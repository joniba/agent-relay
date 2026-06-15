import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stripControlChars,
  compose,
  resolveName,
} from "../extension/bin/agent-relay-statusline.mjs";
import { aliasFor } from "../extension/identity/local-alias.mjs";

test("stripControlChars removes C0 controls and DEL", () => {
  assert.equal(stripControlChars("ab\x00c\x1b[31m\x7f"), "abc[31m");
  assert.equal(stripControlChars(42), "");
});

test("compose wraps a name in brackets, empty otherwise", () => {
  assert.equal(compose("stone"), "[stone]");
  assert.equal(compose(""), "");
  assert.equal(compose(null), "");
});

test("resolveName: deterministic wordlist alias from the session id (matches identity)", () => {
  // Same derivation the identity provider uses → the statusline shows the same
  // alias the session registered under (no DB read, works for any transport).
  assert.equal(resolveName("sess-1", {}), aliasFor("sess-1"));
  assert.match(resolveName("sess-1", {}), /^[a-z]+$/);
});

test("resolveName: AGENT_RELAY_NAME override wins", () => {
  assert.equal(resolveName("sess-1", { AGENT_RELAY_NAME: "tia" }), "tia");
});

test("resolveName: no session id → null (statusline stays empty)", () => {
  assert.equal(resolveName("", {}), null);
  assert.equal(resolveName(null, {}), null);
  assert.equal(resolveName(undefined, {}), null);
});

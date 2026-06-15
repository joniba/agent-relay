import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRoster } from "../extension/roster.mjs";

test("formatRoster appends the device name when present", () => {
  const out = formatRoster([{ id: "s1", name: "gull", deviceName: "my-laptop" }]);
  assert.equal(out, "- gull (my-laptop)  [id: s1]");
});

test("formatRoster omits the device suffix when absent (SQLite back-compat)", () => {
  // The local SQLite transport doesn't store a device name → listAgents has none.
  const out = formatRoster([{ id: "s1", name: "gull" }]);
  assert.equal(out, "- gull  [id: s1]");
});

test("formatRoster marks self and combines with the device name", () => {
  const out = formatRoster([{ id: "s1", name: "gull", deviceName: "my-laptop", self: true }]);
  assert.equal(out, "- gull (my-laptop) (you)  [id: s1]");
});

test("formatRoster renders one line per agent, in order", () => {
  const out = formatRoster([
    { id: "s1", name: "gull", deviceName: "laptop", self: true },
    { id: "s2", name: "pebble", deviceName: "desktop" },
    { id: "s3", name: "clove" },
  ]);
  assert.equal(
    out,
    "- gull (laptop) (you)  [id: s1]\n" +
      "- pebble (desktop)  [id: s2]\n" +
      "- clove  [id: s3]",
  );
});

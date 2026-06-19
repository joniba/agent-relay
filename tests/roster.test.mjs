import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRoster } from "../extension/roster.mjs";

test("formatRoster renders an attributes bag as sorted k=v (e.g. machine)", () => {
  const out = formatRoster([{ id: "s1", name: "gull", attributes: { machine: "host-a" } }]);
  assert.equal(out, "- gull (machine=host-a)  [id: s1]");
});

test("formatRoster sorts attribute keys and omits empty/nullish values", () => {
  const out = formatRoster([
    { id: "s1", name: "gull", attributes: { repo: "agent-relay", machine: "host-a", role: "", note: null } },
  ]);
  // keys sorted (machine before repo); role="" and note=null dropped.
  assert.equal(out, "- gull (machine=host-a, repo=agent-relay)  [id: s1]");
});

test("formatRoster strips control characters from attribute values", () => {
  const out = formatRoster([{ id: "s1", name: "gull", attributes: { machine: "ho\r\nst\u2028A" } }]);
  assert.equal(out, "- gull (machine=hostA)  [id: s1]");
});

test("formatRoster omits the suffix when there are no usable attributes (bare name)", () => {
  // The local SQLite transport supplies no attributes → bare name.
  assert.equal(formatRoster([{ id: "s1", name: "gull" }]), "- gull  [id: s1]");
  assert.equal(formatRoster([{ id: "s1", name: "gull", attributes: {} }]), "- gull  [id: s1]");
});

test("formatRoster marks self and combines with attributes", () => {
  const out = formatRoster([{ id: "s1", name: "gull", attributes: { machine: "host-a" }, self: true }]);
  assert.equal(out, "- gull (machine=host-a) (you)  [id: s1]");
});

test("formatRoster strips control characters from attribute KEYS too (forgery-safe)", () => {
  const out = formatRoster([{ id: "s1", name: "gull", attributes: { "ma\nchine": "host-a" } }]);
  assert.equal(out, "- gull (machine=host-a)  [id: s1]");
});

test("formatRoster renders one line per agent, in order", () => {
  const out = formatRoster([
    { id: "s1", name: "gull", attributes: { machine: "laptop" }, self: true },
    { id: "s2", name: "pebble", attributes: { machine: "desktop" } },
    { id: "s3", name: "clove" },
  ]);
  assert.equal(
    out,
    "- gull (machine=laptop) (you)  [id: s1]\n" +
      "- pebble (machine=desktop)  [id: s2]\n" +
      "- clove  [id: s3]",
  );
});

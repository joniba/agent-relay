import { test } from "node:test";
import assert from "node:assert/strict";

import { createLocalAliasIdentity, aliasFor } from "../extension/identity/local-alias.mjs";
import { WORDS } from "../extension/identity/wordlist.mjs";

// ─── wordlist sanity ─────────────────────────────────────────────────────────

test("wordlist is ~200 unique, lowercase, non-empty words", () => {
  assert.ok(WORDS.length >= 180 && WORDS.length <= 220, `expected ~200 words, got ${WORDS.length}`);
  assert.equal(new Set(WORDS).size, WORDS.length, "wordlist has duplicates");
  for (const w of WORDS) {
    assert.match(w, /^[a-z]+$/, `word not lowercase-alpha: ${w}`);
  }
});

// ─── aliasFor: deterministic, in-list, recomputable ──────────────────────────

test("aliasFor is deterministic for the same id", () => {
  const a = aliasFor("session-abc");
  const b = aliasFor("session-abc");
  assert.equal(a, b);
  assert.ok(WORDS.includes(a), `alias "${a}" not in wordlist`);
});

test("aliasFor spreads across different ids (not all the same word)", () => {
  const names = new Set();
  for (let i = 0; i < 50; i++) names.add(aliasFor(`sess-${i}`));
  // With 200 words and 50 ids, expect many distinct words (not a constant).
  assert.ok(names.size > 25, `expected good spread, got ${names.size} distinct`);
});

test("aliasFor matches the first-sorted candidate (recomputable by any consumer)", async () => {
  // Independent reference impl: sort all words by their hash and take the first.
  const { createHash } = await import("node:crypto");
  const h = (id, w) => {
    const d = createHash("sha256").update(id).update("|").update(w).digest();
    return ((d[0] << 24) >>> 0) | (d[1] << 16) | (d[2] << 8) | d[3];
  };
  const id = "recompute-me";
  const expected = [...WORDS].sort((a, b) => h(id, a) - h(id, b) || (a < b ? -1 : 1))[0];
  assert.equal(aliasFor(id), expected);
});

test("aliasFor honors a custom wordlist", () => {
  const words = ["only"];
  assert.equal(aliasFor("anything", words), "only");
});

// ─── orderedCandidates: permutation, deterministic, head = aliasFor ───────────

test("orderedCandidates is a deterministic permutation of the wordlist", async () => {
  const { orderedCandidates } = await import("../extension/identity/local-alias.mjs");
  const c1 = orderedCandidates("perm-id");
  const c2 = orderedCandidates("perm-id");
  assert.deepEqual(c1, c2, "deterministic");
  assert.equal(c1.length, WORDS.length, "same length as wordlist");
  assert.deepEqual([...c1].sort(), [...WORDS].sort(), "same set as wordlist");
  assert.equal(c1[0], aliasFor("perm-id"), "head is the first-choice alias");
});

// ─── candidates carried for collision avoidance ──────────────────────────────

test("resolve (generated) carries ordered candidates for collision avoidance", async () => {
  const { orderedCandidates } = await import("../extension/identity/local-alias.mjs");
  const identity = createLocalAliasIdentity({ deps: { env: {} } });
  const self = await identity.resolve({ sessionId: "cand-id" });
  assert.ok(Array.isArray(self.candidates), "candidates present");
  assert.equal(self.candidates[0], self.name, "name is the first candidate");
  assert.deepEqual(self.candidates, orderedCandidates("cand-id"));
});

test("resolve (AGENT_RELAY_NAME) carries NO candidates (explicit name, no walking)", async () => {
  const identity = createLocalAliasIdentity({ deps: { env: { AGENT_RELAY_NAME: "frontend" } } });
  const self = await identity.resolve({ sessionId: "x" });
  assert.equal(self.name, "frontend");
  assert.equal(self.candidates, undefined);
});

// ─── resolve: identity shape + precedence ────────────────────────────────────

test("resolve returns { id: sessionId, name: <alias> }", async () => {
  const identity = createLocalAliasIdentity({ deps: { env: {} } });
  const self = await identity.resolve({ sessionId: "sid-123" });
  assert.equal(self.id, "sid-123");
  assert.equal(self.name, aliasFor("sid-123"));
  assert.ok(WORDS.includes(self.name));
});

test("explicit AGENT_RELAY_NAME overrides the generated alias", async () => {
  const identity = createLocalAliasIdentity({ deps: { env: { AGENT_RELAY_NAME: "frontend" } } });
  const self = await identity.resolve({ sessionId: "sid-123" });
  assert.equal(self.name, "frontend");
  assert.equal(self.id, "sid-123"); // id is still the stable session id
});

test("the alias is stable across repeated resolves of the same session", async () => {
  const identity = createLocalAliasIdentity({ deps: { env: {} } });
  const a = await identity.resolve({ sessionId: "stable" });
  const b = await identity.resolve({ sessionId: "stable" });
  assert.equal(a.name, b.name);
});

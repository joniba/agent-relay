import { createHash } from "node:crypto";
import { WORDS } from "./wordlist.mjs";

/**
 * Local wordlist IdentityProvider — generates a short, friendly, STABLE alias
 * (stone/kara-style) for this session purely from its LOCAL session id. No
 * cloud, no network, no dependency on magic: the alias is a deterministic
 * function of the session id, so it resolves **synchronously at boot** with no
 * lag. This is agent-relay owning its own identity (it does not read magic's
 * cloud-derived aliases).
 *
 * Precedence: explicit `AGENT_RELAY_NAME` → generated wordlist alias.
 *
 * Name COLLISIONS between sessions are resolved by the registry: `resolve` hands
 * back the full ordered preference list (`candidates`), and the transport's
 * `register` picks the first candidate not already taken by another session,
 * atomically (mirroring magic's locked first-free selection). So distinct
 * sessions always get distinct names; the authoritative name is the registered
 * one (read it back from the registry rather than recomputing).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.words]  Override the wordlist (default: bundled WORDS).
 * @param {object} [opts.deps]     Test seam: { env }.
 * @returns {import('../seams/identity.mjs').IdentityProvider}
 */
export function createLocalAliasIdentity({ words = WORDS, deps = {} } = {}) {
  const env = deps.env ?? process.env;
  return {
    async resolve(session) {
      const id = session && session.sessionId;
      // Explicit override wins and disables alias generation entirely (an
      // explicit name is intentional — no candidates, no collision walking).
      if (env.AGENT_RELAY_NAME) return { id, name: env.AGENT_RELAY_NAME };
      const candidates = orderedCandidates(id, words);
      return { id, name: candidates[0], candidates };
    },
  };
}

/**
 * The full wordlist ordered by `sha256(id|word)` (ties broken lexicographically)
 * — this session's name preferences, most-preferred first. A pure permutation of
 * `words`. The registry uses this to pick the first un-taken name (collision
 * avoidance), mirroring magic's `orderedCandidates` + first-free selection.
 *
 * @param {string} id
 * @param {string[]} [words]
 * @returns {string[]}
 */
export function orderedCandidates(id, words = WORDS) {
  const key = String(id ?? "");
  return [...words]
    .map((w) => ({ w, h: hashU32(key, w) }))
    .sort((a, b) => a.h - b.h || (a.w < b.w ? -1 : 1))
    .map((x) => x.w);
}

/**
 * Deterministic FIRST-choice alias for an id (= `orderedCandidates(id)[0]`).
 * Pure function — useful where collision avoidance isn't needed (e.g. a quick
 * preview). The actually-registered name may differ if the first choice was
 * taken; read the registry for the authoritative name.
 *
 * @param {string} id
 * @param {string[]} [words]
 * @returns {string}
 */
export function aliasFor(id, words = WORDS) {
  return orderedCandidates(id, words)[0];
}

function hashU32(id, word) {
  const d = createHash("sha256").update(id).update("|").update(word).digest();
  return ((d[0] << 24) >>> 0) | (d[1] << 16) | (d[2] << 8) | d[3];
}

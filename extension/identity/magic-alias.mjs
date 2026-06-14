import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Magic-alias IdentityProvider — DECORATES a fallback IdentityProvider so a
 * session's relay NAME equals its magic-remote alias when one is available (F4),
 * while the relay core stays entirely magic-independent (C9: only this adapter
 * ever touches magic's data).
 *
 * Two tiers (see design.md "Magic-alias identity"):
 *   - B2 (sync, boot path): read magic's alias map and return the alias whose
 *     `agent_task_id` is THIS session's local id. Fail-closed — any error or
 *     non-unique match yields the fallback name. Never blocks/spawns/networks.
 *   - B3 (async, off the boot path, best-effort, one-shot): TRIGGERED by
 *     `onChange()`. Magic warms its OWN alias cache at sessionStart (its
 *     `backfillAliases` hook), so we simply POLL `aliases.json` for a bounded
 *     window; once this session's unique alias appears we fire the callback so
 *     the entry re-registers under it. No subprocess, no knowledge of magic's
 *     install location — purely a local-file read.
 *
 * Explicit `AGENT_RELAY_NAME` hard-short-circuits ALL magic work.
 *
 * Every filesystem touchpoint is injectable (`deps`) for headless tests.
 *
 * @param {object} opts
 * @param {import('../seams/identity.mjs').IdentityProvider} opts.fallback
 *   Resolved when no alias is available (e.g. `identity/folder-name.mjs`).
 * @param {object} [opts.deps]  Test seams: env, stateRoot, readAliases,
 *   isMagicPresent, pollWindowMs, pollIntervalMs.
 * @returns {import('../seams/identity.mjs').IdentityProvider}
 */
export function createMagicAliasIdentity({ fallback, deps = {} } = {}) {
  if (!fallback || typeof fallback.resolve !== "function") {
    throw new Error("createMagicAliasIdentity requires a fallback IdentityProvider");
  }

  const env = deps.env ?? process.env;
  const stateRoot =
    deps.stateRoot ?? env.MAGIC_STATE_ROOT ?? join(homedir(), ".copilot", "m-state");
  const readAliases = deps.readAliases ?? defaultReadAliases;
  const isMagicPresent = deps.isMagicPresent ?? (() => magicPlausiblyPresent(stateRoot));
  // Poll long enough to cover magic's sessionStart backfill (≤3s listSessions
  // timeout + overhead) without lingering — best-effort, one-shot.
  const pollWindowMs = deps.pollWindowMs ?? 12000;
  const pollIntervalMs = deps.pollIntervalMs ?? 500;

  let localSessionId = null; // the key we match against magic's agent_task_id
  let resolvedId = null; // the (stable) identity id, for the onChange payload
  let fallbackName = null;
  let armed = false; // B2 missed AND magic plausibly present → eligible for B3
  let cb = null;
  let controller = null;
  let promoted = false; // one-shot guard
  let disposed = false;

  async function resolve(session) {
    // Explicit override wins and disables ALL magic work (no read, no promotion).
    if (env.AGENT_RELAY_NAME) {
      return fallback.resolve(session);
    }

    const sdkId = session && session.sessionId;
    localSessionId = env.COPILOT_AGENT_SESSION_ID || sdkId || null;
    if (
      env.COPILOT_AGENT_SESSION_ID &&
      sdkId &&
      env.COPILOT_AGENT_SESSION_ID !== sdkId &&
      session &&
      typeof session.log === "function"
    ) {
      // Diagnostics only — we trust COPILOT_AGENT_SESSION_ID (what magic stores).
      session.log(
        `agent-relay: session id mismatch (env=${short(env.COPILOT_AGENT_SESSION_ID)} ` +
          `sdk=${short(sdkId)}); using env for alias lookup`,
        { level: "warning" },
      );
    }

    const fb = await fallback.resolve(session);
    resolvedId = fb.id;
    fallbackName = fb.name;

    const alias = lookupAlias(readAliases(stateRoot), localSessionId);
    if (alias) {
      return { id: fb.id, name: alias };
    }

    // Cold miss: arm B3 only if magic looks present (else never poll).
    armed = !!isMagicPresent();
    return fb;
  }

  /**
   * Subscribe to a late-resolved alias. Subscribing TRIGGERS the B3 promotion
   * (so it never runs without a listener). Returns a `dispose()` that aborts any
   * in-flight promotion and drops the callback.
   */
  function onChange(callback) {
    cb = typeof callback === "function" ? callback : null;
    if (cb && armed && !promoted && !disposed) {
      void promote();
    }
    return function dispose() {
      disposed = true;
      cb = null;
      if (controller) {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }
    };
  }

  /**
   * Best-effort, one-shot promotion: magic warms its own alias cache at
   * sessionStart, so we POLL `aliases.json` for a bounded window until this
   * session's unique alias appears, then fire the callback. No subprocess.
   */
  async function promote() {
    promoted = true;
    controller = new AbortController();
    const deadline = Date.now() + pollWindowMs;
    while (!disposed) {
      const alias = lookupAlias(readAliases(stateRoot), localSessionId);
      if (alias) {
        // Found our entry — promote only if it differs from the name in use.
        if (!disposed && cb && alias !== fallbackName) {
          cb({ id: resolvedId, name: alias });
        }
        return; // resolved (whether or not it differed) — stop polling
      }
      if (Date.now() >= deadline) return; // window elapsed — stay on fallback
      await delay(pollIntervalMs, controller.signal);
    }
  }

  return { resolve, onChange };
}

// ─── pure helpers (fail-closed, never throw) ─────────────────────────────────

function short(s) {
  return typeof s === "string" ? s.slice(0, 8) : String(s);
}

/** Read magic's alias map (`m-state/remote/aliases.json`). Any problem → null. */
function defaultReadAliases(stateRoot) {
  try {
    const raw = readFileSync(join(stateRoot, "remote", "aliases.json"), "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Return the alias for `sessionId` IFF exactly one entry matches; otherwise null
 * (zero or multiple matches fail closed). Tolerant of any shape; never throws.
 *
 * @param {*} state  parsed aliases.json (`{ entries: { [taskId]: {alias, agent_task_id} } }`)
 * @param {string|null} sessionId
 */
function lookupAlias(state, sessionId) {
  if (!state || typeof state !== "object" || !sessionId) return null;
  const entries =
    state.entries && typeof state.entries === "object" ? state.entries : null;
  if (!entries) return null;

  let found = null;
  let count = 0;
  for (const key of Object.keys(entries)) {
    const e = entries[key];
    if (
      e &&
      typeof e === "object" &&
      e.agent_task_id === sessionId &&
      typeof e.alias === "string" &&
      e.alias
    ) {
      found = e.alias;
      count += 1;
      if (count > 1) return null; // non-unique → fail closed
    }
  }
  return count === 1 ? found : null;
}

/**
 * True if magic looks present enough to be worth polling for an alias — i.e. the
 * user has used magic-remote before, so `m-state/remote/` exists and magic's
 * sessionStart backfill will populate this session's entry. If absent, never poll.
 */
function magicPlausiblyPresent(stateRoot) {
  try {
    return existsSync(join(stateRoot, "remote"));
  } catch {
    return false;
  }
}

/** Abortable delay; resolves (never rejects) on timeout OR abort. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    }
  });
}

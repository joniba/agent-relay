#!/usr/bin/env node
/**
 * agent-relay-statusline — Copilot CLI status-line script.
 *
 * Wired via `~/.copilot/settings.json`:
 *   { "statusLine": { "type": "command",
 *       "command": "node C:/…/extensions/agent-relay/bin/agent-relay-statusline.mjs" } }
 *
 * Shows THIS session's agent-relay alias as `[<name>]` below the prompt.
 *
 * The alias is a DETERMINISTIC function of the local session id — the same
 * derivation the identity provider uses — so we compute it directly here. That
 * means NO database read and NO network, and it is transport-agnostic: it works
 * whether the session joined the local SQLite mesh or the cross-machine Postgres
 * mesh. Precedence mirrors the identity provider: an explicit AGENT_RELAY_NAME
 * wins, else the wordlist alias. (A registry collision could in theory bump the
 * registered name off this first choice; that rare case isn't reflected here.)
 *
 * Contract (mirrors the Copilot CLI statusline protocol):
 *   - The CLI invokes us on each statusline refresh, piping a JSON document on
 *     stdin that includes `session_id` (the local Copilot session id).
 *   - Unknown session / any error → emit NOTHING (Copilot's own statusline
 *     shows). Never throw. Failure isolation: ANY error → empty line, exit 0.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { aliasFor } from "../identity/local-alias.mjs";

/** Strip C0 control chars + DEL so the rendered statusline can't be injected. */
export function stripControlChars(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Resolve THIS session's alias from its session id — explicit AGENT_RELAY_NAME
 * override wins, else the deterministic wordlist alias (same as the identity
 * provider). Pure; no DB, no network. Returns null when there's no session id.
 *
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function resolveName(sessionId, env = process.env) {
  if (!sessionId) return null;
  if (env.AGENT_RELAY_NAME) return env.AGENT_RELAY_NAME;
  return aliasFor(sessionId);
}

/** Pure: name → statusline text (may be empty). */
export function compose(name) {
  const n = stripControlChars(name);
  return n ? `[${n}]` : "";
}

/** Read all of stdin, parse JSON; null on empty/error/timeout. */
async function readStdinJson() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    let timer;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer); // don't let the rescue timer keep the process alive
      resolve(v);
    };
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        finish(text ? JSON.parse(text) : null);
      } catch {
        finish(null);
      }
    });
    process.stdin.on("error", () => finish(null));
    timer = setTimeout(() => finish(null), 500);
  });
}

async function main() {
  let input = null;
  try {
    input = await readStdinJson();
  } catch {
    /* never throw out */
  }
  let name = null;
  try {
    if (input && typeof input.session_id === "string") name = resolveName(input.session_id);
  } catch {
    /* fall through to silent */
  }
  process.stdout.write(compose(name));
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMainModule) main();

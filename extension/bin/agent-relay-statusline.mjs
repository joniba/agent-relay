#!/usr/bin/env node
/**
 * agent-relay-statusline — Copilot CLI status-line script.
 *
 * Wired via `~/.copilot/settings.json`:
 *   { "statusLine": { "type": "command",
 *       "command": "node C:/…/extensions/agent-relay/bin/agent-relay-statusline.mjs" } }
 *
 * Contract (mirrors the Copilot CLI statusline protocol):
 *   - The CLI invokes us on each statusline refresh, piping a JSON document on
 *     stdin that includes `session_id` (the local Copilot session id).
 *   - We look up THIS session's registered agent-relay name in the local
 *     registry (the same sqlite store the extension registers into) and emit a
 *     single visible line `[<name>]`.
 *   - Unknown session (agent-relay not running / not registered yet) or any
 *     error → emit NOTHING (Copilot's own statusline shows). Never throw.
 *
 * The name is generated locally and is available the instant the session
 * registers (read here from agent-relay's own registry), with no external
 * service.
 *
 * Performance: a single indexed lookup on a tiny table; must stay well under
 * 100ms. Failure isolation: ANY error → empty line, exit 0.
 */

import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Strip C0 control chars + DEL so the rendered statusline can't be injected. */
export function stripControlChars(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

/** Where the default sqlite-poll transport keeps its store (see config.mjs). */
export function resolveDbPath() {
  return process.env.AGENT_RELAY_DB || join(__dirname, "..", "agent-relay.db");
}

/**
 * Look up the registered name for a session id in the agent-relay registry.
 * Returns the name, or null when unknown / unavailable. Never throws. Opens
 * read-write (so a WAL store is handled), but only ever SELECTs; guarded by an
 * existence check so it never CREATES the store. `node:sqlite` is imported
 * dynamically so a runtime without it degrades to null rather than throwing at
 * module load (this script runs under whatever `node` is on PATH).
 */
export async function lookupName(sessionId, dbPath = resolveDbPath()) {
  if (!sessionId || !existsSync(dbPath)) return null;
  let db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT name FROM agents WHERE id = ?").get(sessionId);
    return row && typeof row.name === "string" ? row.name : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
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
    if (input && typeof input.session_id === "string") name = await lookupName(input.session_id);
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

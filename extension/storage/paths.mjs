import os from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const APP_DIR = "agent-relay";

/**
 * Resolve the canonical per-user data directory for agent-relay — where the local
 * SQLite store and the rolling logs live — so runtime state lives OUTSIDE the
 * install directory. Pure: pass env/platform/homedir to test without touching the
 * real machine.
 *
 * Precedence:
 *   1. AGENT_RELAY_DATA_DIR  — explicit override, used verbatim.
 *   2. per-platform OS convention:
 *      - win32:  %LOCALAPPDATA%\agent-relay   (fallback ~\AppData\Local\agent-relay)
 *      - darwin: ~/Library/Application Support/agent-relay
 *      - other:  $XDG_DATA_HOME/agent-relay   (fallback ~/.local/share/agent-relay)
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {NodeJS.Platform} [opts.platform]
 * @param {string} [opts.homedir]
 * @returns {string} absolute data-dir path
 */
export function resolveDataDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.AGENT_RELAY_DATA_DIR) return env.AGENT_RELAY_DATA_DIR;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || join(homedir, "AppData", "Local");
    return join(base, APP_DIR);
  }
  if (platform === "darwin") {
    return join(homedir, "Library", "Application Support", APP_DIR);
  }
  const base = env.XDG_DATA_HOME || join(homedir, ".local", "share");
  return join(base, APP_DIR);
}

/**
 * Absolute path to a named file inside the data dir.
 *
 * @param {string} name
 * @param {Parameters<typeof resolveDataDir>[0]} [opts]
 * @returns {string}
 */
export function dataFile(name, opts) {
  return join(resolveDataDir(opts), name);
}

/**
 * Ensure the data dir exists (mkdir -p) and return it. Side-effecting; `fs` is
 * injectable for tests.
 *
 * @param {(Parameters<typeof resolveDataDir>[0] & { fs?: { mkdirSync: Function } })} [opts]
 * @returns {string} the data-dir path
 */
export function ensureDataDir(opts = {}) {
  const dir = resolveDataDir(opts);
  const fs = opts.fs ?? { mkdirSync };
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

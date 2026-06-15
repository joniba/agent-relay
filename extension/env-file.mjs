import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load configuration from a gitignored `.env` file into `process.env`, so the
 * cross-machine settings (`AGENT_RELAY_*`, and optionally `AZURE_CONFIG_DIR`)
 * live WITH the project instead of being re-exported into every shell.
 *
 * Dependency-free — uses Node's built-in `util.parseEnv` (Node >= 20.12; the
 * extension already requires 22). Composition/entry concern: it only fills
 * `process.env` before `config.mjs` reads it; no other module knows about it.
 *
 * **Precedence:** a variable ALREADY set in the real environment WINS — the file
 * only fills gaps — so any value can still be overridden ad-hoc from the shell.
 *
 * **Search order** (the FIRST existing file is loaded; the rest are ignored):
 *   1. `$AGENT_RELAY_ENV_FILE`  — explicit path (for non-standard install layouts)
 *   2. `<extension-dir>/.env`   — next to `extension.mjs` (the recommended spot)
 *   3. `<extension-dir>/../.env` — repo root, for a cloned-layout install
 *
 * **Gotcha:** a value containing `#` (e.g. an Entra guest UPN `user#EXT#@tenant`)
 * MUST be double-quoted in the file, or `parseEnv` treats `#` as a comment.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]  Target environment. Defaults to `process.env`.
 * @param {string} [opts.baseDir]  Directory to resolve the relative candidates
 *   from. Defaults to this module's directory (the extension dir).
 * @returns {{ path: string, applied: string[] } | null}  The file that was loaded
 *   and the keys it actually set (gaps it filled), or `null` if no file was found.
 */
export function loadEnvFile({ env = process.env, baseDir } = {}) {
  const here = baseDir ?? dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.AGENT_RELAY_ENV_FILE,
    join(here, ".env"),
    resolve(here, "..", ".env"),
  ].filter(Boolean);

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let parsed;
    try {
      parsed = parseEnv(readFileSync(path, "utf8"));
    } catch {
      continue; // unparsable file — skip rather than crash the entry
    }
    const applied = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) {
        env[key] = value;
        applied.push(key);
      }
    }
    return { path, applied };
  }
  return null;
}

import { readdirSync } from "node:fs";
import { isAbsolute, resolve, join, basename } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Load EXTERNAL interceptor modules at startup and return them as an `Interceptor[]`
 * to compose into the relay's interceptor chain. This is the public extension point:
 * guardrails (or any middleware) live in user-controlled modules — a separate repo, a
 * plugin folder — instead of being baked into this repo.
 *
 * Two sources, loaded **in order**:
 *   1. `env.AGENT_RELAY_INTERCEPTORS` — a **comma-separated** list of module paths
 *      (absolute, or relative to `process.cwd()`), loaded in listed order.
 *   2. The **plugin directory** — `env.AGENT_RELAY_PLUGIN_DIR`, else (only when a
 *      `dataDir` is available) `<dataDir>/plugins` — scanned for top-level `*.mjs`
 *      files, **alphabetically**.
 *
 * **Contract:** each module DEFAULT-exports a factory `(ctx) => Interceptor` (it may be
 * async). `ctx = { env, dataDir, log }` (no `self` — identity isn't resolved yet). The
 * result must be an object with at least one **function-valued** hook
 * (`onSend`/`onReceive`/`renderPrompt`); otherwise it is skipped.
 *
 * **Safe-degrade (load-time).** Every module is isolated: any import / factory /
 * validation failure is skipped + logged (metadata) and loading continues. This function
 * NEVER throws, so a broken plugin can't crash or block startup. Plugins are TRUSTED user
 * code — a plugin that *hangs* or CPU-loops is out of scope (no timeout/isolation).
 *
 * @param {{ env?: NodeJS.ProcessEnv, dataDir?: string|null, log?: import('../seams/log.mjs').Logger }} [ctx]
 * @param {{ importer?: (url: string) => Promise<any>, readdir?: (dir: string) => string[] }} [deps]
 *   DI seams for tests (default: real dynamic `import()` + `fs.readdirSync`).
 * @returns {Promise<import('../seams/interceptor.mjs').Interceptor[]>}
 */
export async function loadExternalInterceptors(ctx = {}, deps = {}) {
  const env = ctx.env ?? process.env;
  const dataDir = ctx.dataDir ?? null;
  const log = typeof ctx.log === "function" ? ctx.log : () => {};
  const importer = deps.importer ?? ((url) => import(url));
  const readdir = deps.readdir ?? readdirSync;

  const pluginCtx = { env, dataDir, log };
  const interceptors = [];
  for (const absPath of resolveSpecs(env, dataDir, log, readdir)) {
    const loaded = await loadOne(absPath, pluginCtx, importer, log);
    if (loaded) interceptors.push(loaded);
  }
  if (interceptors.length) log(`external interceptors active: ${interceptors.length}`);
  return interceptors;
}

/** Ordered list of ABSOLUTE module paths to load: env-var entries first, then dir entries. */
function resolveSpecs(env, dataDir, log, readdir) {
  const specs = [];

  // 1) Explicit env-var paths (comma-separated), in listed order.
  for (const p of (env.AGENT_RELAY_INTERCEPTORS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    specs.push(isAbsolute(p) ? p : resolve(process.cwd(), p));
  }

  // 2) Plugin directory: explicit override, else <dataDir>/plugins (only when available).
  const dir = env.AGENT_RELAY_PLUGIN_DIR
    ? resolve(process.cwd(), env.AGENT_RELAY_PLUGIN_DIR)
    : dataDir
      ? join(dataDir, "plugins")
      : null;
  if (dir) {
    let names = [];
    try {
      names = readdir(dir);
    } catch (err) {
      // A MISSING dir is the zero-config norm → silent empty. Any OTHER scan error is
      // logged + skipped. Either way, never throw.
      if (!isMissingDir(err)) {
        log(`plugin dir scan failed: ${dir} (${err && err.message})`, { level: "warning" });
      }
      names = [];
    }
    for (const name of names.filter((n) => n.endsWith(".mjs")).sort()) {
      specs.push(join(dir, name));
    }
  }

  return specs;
}

function isMissingDir(err) {
  return !!err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/** Load + validate ONE module; return the Interceptor or null (skipped). Never throws. */
async function loadOne(absPath, pluginCtx, importer, log) {
  const name = basename(absPath);
  try {
    const mod = await importer(pathToFileURL(absPath).href);
    const factory = mod && mod.default;
    if (typeof factory !== "function") {
      log(`plugin skipped: ${name} (no default-export factory)`, { level: "warning" });
      return null;
    }
    const result = await factory(pluginCtx);
    if (!isInterceptor(result)) {
      log(`plugin skipped: ${name} (no onSend/onReceive/renderPrompt function)`, { level: "warning" });
      return null;
    }
    log(`plugin loaded: ${name}`);
    return result;
  } catch (err) {
    log(`plugin skipped: ${name} (${(err && err.message) || err})`, { level: "warning" });
    return null;
  }
}

/** A valid interceptor is an object with at least one FUNCTION-valued lifecycle hook. */
function isInterceptor(x) {
  return (
    x != null &&
    typeof x === "object" &&
    (typeof x.onSend === "function" ||
      typeof x.onReceive === "function" ||
      typeof x.renderPrompt === "function")
  );
}

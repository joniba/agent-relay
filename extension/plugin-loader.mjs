import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, join, basename, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// This module sits at the extension ROOT (next to extension.mjs), so its own
// directory IS the installed extension dir. The default drop-in plugin folder is
// `<that dir>/plugins` — i.e. the extension's OWN `plugins/` subfolder, NOT the
// per-user data dir. Code travels with the extension; only state lives in dataDir.
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Load plugins at startup and fold them into a single aggregated **registry** —
 * the one path by which any core seam (transport / credentials / identity /
 * interceptors) can come from outside this repo.
 *
 * A plugin DEFAULT-exports a factory `(ctx) => Registration`, where
 * `ctx = { env, dataDir, log }`. The returned **Registration** may declare any
 * subset of four capabilities, each an implementation of an existing core seam:
 *
 * ```js
 * {
 *   interceptors: [ { onSend?, onReceive?, renderPrompt? } ],  // aggregate — ALL plugins chained, in load order
 *   transport:    { id?, create: (ctx) => Transport },         // single-instance, LAST-loaded wins
 *   credentials:  () => CredentialProvider,                    // single-instance, LAST-loaded wins
 *   identity:     { resolve(session) },                        // single-instance, LAST-loaded wins
 * }
 * ```
 *
 * **Sources, loaded in order:**
 *   1. `env.AGENT_RELAY_PLUGINS` — a comma-separated list of module paths
 *      (absolute, or resolved against `process.cwd()`). A SECONDARY dev
 *      convenience for pointing at an un-copied repo.
 *   2. The plugin DIRECTORY (primary): `env.AGENT_RELAY_PLUGIN_DIR`, else the
 *      extension's OWN `plugins/` subfolder (`<extension-dir>/plugins`, resolved
 *      relative to this module's install location — NOT the data dir). Entries are
 *      taken in alphabetical order: a top-level `*.mjs` file is imported directly; a
 *      subdirectory with a `package.json` resolves its entry as
 *      `agentRelay.entry` -> `main` -> `index.mjs` and is imported by absolute
 *      `file:` URL (so a deps-carrying plugin resolves against its own
 *      `node_modules`). A subdirectory without `package.json`, or any non-`.mjs`
 *      file, is ignored.
 *
 * **Fail-loud + all-or-nothing.** The opposite of a best-effort loader: ANY
 * problem with ANY plugin - import error, missing/invalid factory, an empty or
 * malformed registration, any invalid capability within it - makes this function
 * **throw immediately, naming the plugin**. There is no skipping and no
 * best-effort tier. A plugin is folded into the registry only after its WHOLE
 * registration validates (so a plugin can never load "half" of itself). A
 * MISSING plugin dir is the normal zero-plugin case (returns the empty registry);
 * a dir that exists but is UNREADABLE is a failure and throws.
 *
 * @param {{ env?: NodeJS.ProcessEnv, dataDir?: string|null, log?: import('./seams/log.mjs').Logger }} [ctx]
 *   `dataDir` is the per-user STATE dir handed to plugins (for their own DB/files);
 *   it no longer locates the plugin folder (that is the extension's own `plugins/`).
 * @param {{
 *   importer?: (url: string) => Promise<any>,
 *   readEntries?: (dir: string) => Array<{ name: string, isDirectory: boolean }>,
 *   readJson?: (path: string) => any,
 *   baseDir?: string,
 * }} [deps]  DI seams for tests (default: real dynamic `import()` + `fs`; `baseDir`
 *   defaults to this module's own dir — the installed extension root).
 * @returns {Promise<{
 *   interceptors: import('./seams/interceptor.mjs').Interceptor[],
 *   transport: { id?: string, create: (ctx: any) => import('./seams/transport.mjs').Transport } | null,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider | null,
 *   identity: import('./seams/identity.mjs').IdentityProvider | null,
 * }>}
 */
export async function loadPlugins(ctx = {}, deps = {}) {
  const env = ctx.env ?? process.env;
  const dataDir = ctx.dataDir ?? null;
  const log = typeof ctx.log === "function" ? ctx.log : () => {};
  const importer = deps.importer ?? ((url) => import(url));
  const readEntries = deps.readEntries ?? defaultReadEntries;
  const readJson = deps.readJson ?? defaultReadJson;
  const baseDir = deps.baseDir ?? SELF_DIR;

  const pluginCtx = { env, dataDir, log };
  const registry = { interceptors: [], transport: null, credentials: null, identity: null };

  for (const { name, entryPath } of resolveSources(env, baseDir, readEntries, readJson)) {
    await loadOne({ name, entryPath, pluginCtx, importer, log, registry });
  }
  return registry;
}

/**
 * Ordered list of plugins to load: env-var entries first (in listed order), then
 * plugin-dir entries (alphabetical). Each is `{ name, entryPath }` where `name`
 * labels the plugin in logs/errors and `entryPath` is its absolute module path.
 *
 * Dir-failure policy: a MISSING dir contributes nothing (zero-plugin norm); a dir
 * that exists but is unreadable THROWS (fail loud).
 */
function resolveSources(env, baseDir, readEntries, readJson) {
  const sources = [];

  // 1) Explicit env-var paths (comma-separated), in listed order - dev convenience.
  for (const p of (env.AGENT_RELAY_PLUGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const entryPath = isAbsolute(p) ? p : resolve(process.cwd(), p);
    sources.push({ name: basename(entryPath), entryPath });
  }

  // 2) Plugin directory (primary): explicit override, else the extension's OWN
  //    `plugins/` subfolder (`<baseDir>/plugins`). Always resolves to a path; if it
  //    doesn't exist on disk that's the normal zero-plugin case (handled below).
  const dir = env.AGENT_RELAY_PLUGIN_DIR
    ? resolve(process.cwd(), env.AGENT_RELAY_PLUGIN_DIR)
    : join(baseDir, "plugins");
  {
    let entries;
    try {
      entries = readEntries(dir);
    } catch (err) {
      if (isMissingDir(err)) return sources; // missing dir -> contributes nothing
      throw new Error(`agent-relay: cannot read plugin dir ${dir}: ${(err && err.message) || err}`);
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const resolved = resolveDirEntry(dir, entry, readJson);
      if (resolved) sources.push(resolved);
    }
  }

  return sources;
}

/**
 * Resolve a single plugin-dir entry to `{ name, entryPath }`, or null if the
 * entry is not a plugin. A subdirectory is a packaged plugin only if it has a
 * readable `package.json`; a top-level file is a plugin only if it ends in `.mjs`.
 */
function resolveDirEntry(dir, entry, readJson) {
  if (entry.isDirectory) {
    let pkg;
    try {
      pkg = readJson(join(dir, entry.name, "package.json"));
    } catch (err) {
      // No package.json at all -> this subdir simply isn't a plugin (ignore it).
      if (isMissingDir(err)) return null;
      // A package.json that EXISTS but won't read/parse is a BROKEN plugin install
      // -> fail loud (not silently ignored), consistent with the loader's contract.
      throw fail(entry.name, `package.json is unreadable: ${(err && err.message) || err}`);
    }
    const entryFile = (pkg && pkg.agentRelay && pkg.agentRelay.entry) || (pkg && pkg.main) || "index.mjs";
    return { name: entry.name, entryPath: join(dir, entry.name, entryFile) };
  }
  if (entry.name.endsWith(".mjs")) {
    return { name: entry.name, entryPath: join(dir, entry.name) };
  }
  return null; // a non-.mjs top-level file -> not a plugin
}

function isMissingDir(err) {
  return !!err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/**
 * Import + validate ONE plugin and fold it into the registry. THROWS (naming the
 * plugin) on any failure - there is no skip path.
 */
async function loadOne({ name, entryPath, pluginCtx, importer, log, registry }) {
  let registration;
  try {
    const mod = await importer(pathToFileURL(entryPath).href);
    const factory = mod && mod.default;
    if (typeof factory !== "function") throw new Error("default export is not a factory function");
    registration = await factory(pluginCtx);
  } catch (err) {
    throw fail(name, (err && err.message) || String(err));
  }
  foldRegistration({ name, registration, registry });
  log(`plugin loaded: ${name}`);
}

/**
 * Validate a plugin's Registration in FULL, then commit it to the registry
 * (interceptors aggregate; transport/credentials/identity are last-wins). Any bad
 * field throws before ANY mutation, so a plugin is all-or-nothing.
 */
function foldRegistration({ name, registration, registry }) {
  if (registration == null || typeof registration !== "object" || Array.isArray(registration)) {
    throw fail(name, "registration is empty or not an object");
  }

  const staged = { interceptors: [], transport: undefined, credentials: undefined, identity: undefined };
  let usable = false;

  if (registration.interceptors !== undefined) {
    if (!Array.isArray(registration.interceptors)) throw fail(name, "interceptors must be an array");
    registration.interceptors.forEach((it, i) => {
      if (!isInterceptor(it)) {
        throw fail(name, `interceptor #${i} has no onSend/onReceive/renderPrompt function`);
      }
      staged.interceptors.push(it);
    });
    if (staged.interceptors.length) usable = true;
  }

  if (registration.transport !== undefined) {
    const t = registration.transport;
    if (t == null || typeof t !== "object" || Array.isArray(t) || typeof t.create !== "function") {
      throw fail(name, "transport must be an object with a create() function");
    }
    if (t.id !== undefined && typeof t.id !== "string") throw fail(name, "transport.id must be a string");
    staged.transport = t;
    usable = true;
  }

  if (registration.credentials !== undefined) {
    if (typeof registration.credentials !== "function") {
      throw fail(name, "credentials must be a function returning a CredentialProvider");
    }
    let provider;
    try {
      provider = registration.credentials();
    } catch (err) {
      throw fail(name, `credentials factory threw: ${(err && err.message) || err}`);
    }
    if (provider == null || typeof provider !== "object" || typeof provider.get !== "function") {
      throw fail(name, "credentials provider has no get() function");
    }
    staged.credentials = provider;
    usable = true;
  }

  if (registration.identity !== undefined) {
    const id = registration.identity;
    if (id == null || typeof id !== "object" || typeof id.resolve !== "function") {
      throw fail(name, "identity must be an object with a resolve() function");
    }
    staged.identity = id;
    usable = true;
  }

  if (!usable) throw fail(name, null); // declared no usable capability

  // All validated - commit. (Done last so a later throw leaves the registry untouched.)
  for (const it of staged.interceptors) registry.interceptors.push(it);
  if (staged.transport !== undefined) registry.transport = staged.transport;
  if (staged.credentials !== undefined) registry.credentials = staged.credentials;
  if (staged.identity !== undefined) registry.identity = staged.identity;
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

/** Build a fail-loud Error that names the plugin. `reason == null` -> no-capability. */
function fail(name, reason) {
  return new Error(
    reason == null
      ? `agent-relay: plugin "${name}" registered no usable capability`
      : `agent-relay: plugin "${name}" failed to load: ${reason}`,
  );
}

function defaultReadEntries(dir) {
  return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
}

function defaultReadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
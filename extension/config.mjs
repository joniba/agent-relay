import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalAliasIdentity } from "./identity/local-alias.mjs";
import { createNoneCredentials } from "./credentials/none.mjs";
import { createSqlitePollTransport } from "./transports/sqlite-poll.mjs";
import { dataFile, ensureDataDir } from "./storage/paths.mjs";
import { migrateLocalDbOnce } from "./storage/local-db.mjs";
import { loadPlugins } from "./plugin-loader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Composition root - the SINGLE place the seam bundle is assembled (OCP). It is
 * `async` and does the wiring itself: load plugins into a registry, then fold the
 * registry over the zero-infra local default.
 *
 * Every seam - transport, credentials, identity, and the interceptor chain - may
 * now come from a plugin (see `plugin-loader.mjs`). With NO plugins this returns
 * the dependency-free local default: SQLite-poll transport (DB in the canonical
 * per-user data dir; override with AGENT_RELAY_DB or AGENT_RELAY_DATA_DIR), no
 * credentials, the local wordlist-alias identity, and an empty interceptor chain.
 *
 * Folding rules (from the registry):
 *   - `interceptors` aggregate (every plugin's, in load order).
 *   - `transport` is single-instance, last-loaded wins; when a plugin supplies one
 *     we use it and pair it with `registry.credentials ?? none`. When none does, we
 *     fall back to the local SQLite slice.
 *   - `identity` is single-instance, last-loaded wins; defaults to the local alias.
 *
 * Loading is FAIL-LOUD: a bad/invalid plugin makes `loadPlugins` throw, which
 * propagates here so the entry marks the relay inactive (no silent fallback).
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]   Environment to read plugin config from. Defaults to `process.env`.
 * @param {string|null} [opts.dataDir]     Canonical per-user STATE dir (DB/logs), handed to plugins for their own state. Plugins are NOT located here — they live in the extension's own `plugins/` folder. May be null.
 * @param {import('./seams/log.mjs').Logger} [opts.log]   Diagnostic logger handed to plugins/transports. No-op by default.
 * @returns {Promise<{
 *   identity: import('./seams/identity.mjs').IdentityProvider,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 *   transport: import('./seams/transport.mjs').Transport,
 *   interceptors: import('./seams/interceptor.mjs').Interceptor[],
 *   remote: boolean,
 * }>}
 */
export async function createConfig({ env = process.env, dataDir, log = () => {} } = {}) {
  const registry = await loadPlugins({ env, dataDir, log });
  return {
    identity: registry.identity ?? createLocalAliasIdentity(),
    interceptors: registry.interceptors,
    // `remote` is a non-seam hint for the entry's boot/connected log lines: true when
    // a plugin supplied the transport, false on the local default. NOT used for wiring.
    remote: !!registry.transport,
    ...(registry.transport
      ? { transport: registry.transport.create({ log }), credentials: registry.credentials ?? createNoneCredentials() }
      : localSlice(env)),
  };
}

/**
 * The local SQLite slice (transport + its no-op credentials) - the zero-infra
 * default. Kept here so all composition lives at the root; createConfig calls it.
 *
 * @returns {{
 *   transport: import('./seams/transport.mjs').Transport,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 * }}
 */
function localSlice(env = process.env) {
  const explicitDb = env.AGENT_RELAY_DB;
  if (explicitDb) {
    return {
      credentials: createNoneCredentials(),
      transport: createSqlitePollTransport({ dbPath: explicitDb }),
    };
  }
  // Default the local store to the canonical per-user data dir (out of the install
  // dir). Provisioning + the one-time relocation of a legacy in-install DB are
  // BEST-EFFORT: a filesystem failure here must never harden the zero-infra local
  // default into a boot failure (the DB is otherwise opened lazily inside the
  // transport, within the boot try/catch), so on ANY error we degrade to the legacy
  // co-located path. The relocation itself is crash-safe (see storage/local-db.mjs).
  const legacyPath = join(__dirname, "agent-relay.db");
  let dbPath = legacyPath;
  try {
    ensureDataDir();
    const canonical = dataFile("agent-relay.db");
    migrateLocalDbOnce({ from: legacyPath, to: canonical });
    dbPath = canonical;
  } catch {
    dbPath = legacyPath;
  }
  return {
    credentials: createNoneCredentials(),
    transport: createSqlitePollTransport({ dbPath }),
  };
}
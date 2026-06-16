import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalAliasIdentity } from "./identity/local-alias.mjs";
import { createNoneCredentials } from "./credentials/none.mjs";
import { createEnvPasswordCredentials } from "./credentials/env-password.mjs";
import { createAzureEntraCredentials } from "./azure/index.mjs";
import { createSqlitePollTransport } from "./transports/sqlite-poll.mjs";
import { createPostgresTransport } from "./transports/postgres.mjs";
import { dataFile, ensureDataDir } from "./storage/paths.mjs";
import { migrateLocalDbOnce } from "./storage/local-db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Composition root — the SINGLE place adapters are chosen (OCP). To use a
 * different transport, identity scheme, credential source, or to add
 * interceptors (guardrails), edit ONLY this function.
 *
 * Substrate selection:
 *   - `AGENT_RELAY_TRANSPORT=postgres` → the cross-machine Postgres transport
 *     (shared DB; settings from AGENT_RELAY_PG_*). Credentials:
 *       · if `AGENT_RELAY_PG_PASSWORD` is set → the vendor-neutral env-password
 *         provider (a plain password server — local Docker / CI / tests), or
 *       · otherwise → the Azure Entra token provider (the real cross-machine
 *         path; the Azure SDK is imported lazily inside that provider, so it is
 *         loaded ONLY here and never on the local default).
 *     This is the single cross-machine mesh.
 *   - otherwise →  the zero-infra local default: SQLite-poll (DB in the canonical
  *     per-user data dir; override with AGENT_RELAY_DB or AGENT_RELAY_DATA_DIR), no
  *     credentials.
 *
 * Identity is always the local wordlist alias (override the name with
 * AGENT_RELAY_NAME). No interceptors by default.
 *
 * @param {object} [opts]
 * @param {import('./seams/log.mjs').Logger} [opts.log]
 *   Diagnostic logger handed to transports that emit observability events
 *   (pool errors, dead-letter, sweep). Defaults to a no-op.
 * @returns {{
 *   identity: import('./seams/identity.mjs').IdentityProvider,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 *   transport: import('./seams/transport.mjs').Transport,
 *   interceptors: import('./seams/interceptor.mjs').Interceptor[],
 * }}
 */
export function createConfig({ log = () => {} } = {}) {
  if (process.env.AGENT_RELAY_TRANSPORT === "postgres") {
    const credentials = process.env.AGENT_RELAY_PG_PASSWORD
      ? createEnvPasswordCredentials()
      : createAzureEntraCredentials({ tenantId: process.env.AGENT_RELAY_AZURE_TENANT });
    // Push (LISTEN/NOTIFY) is on unless explicitly disabled. With push carrying
    // delivery latency, the poll becomes a rare-case backstop, so relax it ~10× to
    // cut idle DB chatter; with push OFF, keep the tight 3s poll so latency is
    // unchanged. Override either with AGENT_RELAY_PUSH / AGENT_RELAY_POLL_MS.
    const pushEnabled = !/^(0|false|off|no)$/i.test(process.env.AGENT_RELAY_PUSH ?? "");
    const pollIntervalMs = process.env.AGENT_RELAY_POLL_MS
      ? Number(process.env.AGENT_RELAY_POLL_MS)
      : pushEnabled
        ? 30000
        : 3000;
    return {
      identity: createLocalAliasIdentity(),
      credentials,
      transport: createPostgresTransport({
        host: process.env.AGENT_RELAY_PG_HOST,
        user: process.env.AGENT_RELAY_PG_USER,
        database: process.env.AGENT_RELAY_PG_DB,
        port: process.env.AGENT_RELAY_PG_PORT ? Number(process.env.AGENT_RELAY_PG_PORT) : 5432,
        // TLS on by default (Azure); a local Docker server sets AGENT_RELAY_PG_SSL=false.
        ssl: process.env.AGENT_RELAY_PG_SSL === "false" ? false : { rejectUnauthorized: true },
        pushEnabled,
        pollIntervalMs,
        // Opt-in verbose sweep tracing (AGENT_RELAY_DEBUG=1|true|yes|on); silent otherwise.
        debug: /^(1|true|yes|on)$/i.test(process.env.AGENT_RELAY_DEBUG ?? ""),
        log,
      }),
      interceptors: [],
    };
  }

  return {
    identity: createLocalAliasIdentity(),
    interceptors: [],
    ...localSlice(),
  };
}

/**
 * The local SQLite slice (transport + its no-op credentials) — the zero-infra
 * default. Kept here so all composition lives at the root; createConfig calls it.
 *
 * @returns {{
 *   transport: import('./seams/transport.mjs').Transport,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 * }}
 */
function localSlice() {
  const explicitDb = process.env.AGENT_RELAY_DB;
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

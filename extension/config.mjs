import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalAliasIdentity } from "./identity/local-alias.mjs";
import { createNoneCredentials } from "./credentials/none.mjs";
import { createEnvPasswordCredentials } from "./credentials/env-password.mjs";
import { createAzureEntraCredentials } from "./azure/index.mjs";
import { createSqlitePollTransport } from "./transports/sqlite-poll.mjs";
import { createPostgresTransport } from "./transports/postgres.mjs";

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
 *   - otherwise → the zero-infra local default: SQLite-poll (DB co-located with
 *     the extension; override with AGENT_RELAY_DB), no credentials.
 *
 * Identity is always the local wordlist alias (override the name with
 * AGENT_RELAY_NAME). No interceptors by default.
 *
 * @param {object} [opts]
 * @param {(msg: string, opts?: object) => void} [opts.log]
 *   Diagnostic sink handed to transports that emit observability events
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
 * default, and the boot-time FALLBACK target when the cross-machine transport
 * can't come up (see bootstrap.mjs). Kept here so all composition lives at the
 * root; the entry just calls it.
 *
 * @returns {{
 *   transport: import('./seams/transport.mjs').Transport,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 * }}
 */
export function createFallbackConfig() {
  return localSlice();
}

function localSlice() {
  const dbPath = process.env.AGENT_RELAY_DB || join(__dirname, "agent-relay.db");
  return {
    credentials: createNoneCredentials(),
    transport: createSqlitePollTransport({ dbPath }),
  };
}

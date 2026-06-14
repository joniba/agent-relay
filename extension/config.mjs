import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalAliasIdentity } from "./identity/local-alias.mjs";
import { createNoneCredentials } from "./credentials/none.mjs";
import { createEnvPasswordCredentials } from "./credentials/env-password.mjs";
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
 *     (shared DB; settings from AGENT_RELAY_PG_*). Paired here with the
 *     vendor-neutral env-password credential; the Azure Entra credential is
 *     wired in a later phase. This is the single cross-machine mesh.
 *   - otherwise → the zero-infra local default: SQLite-poll (DB co-located with
 *     the extension; override with AGENT_RELAY_DB), no credentials.
 *
 * Identity is always the local wordlist alias (override the name with
 * AGENT_RELAY_NAME). No interceptors by default.
 *
 * @returns {{
 *   identity: import('./seams/identity.mjs').IdentityProvider,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 *   transport: import('./seams/transport.mjs').Transport,
 *   interceptors: import('./seams/interceptor.mjs').Interceptor[],
 * }}
 */
export function createConfig() {
  if (process.env.AGENT_RELAY_TRANSPORT === "postgres") {
    return {
      identity: createLocalAliasIdentity(),
      credentials: createEnvPasswordCredentials(),
      transport: createPostgresTransport({
        host: process.env.AGENT_RELAY_PG_HOST,
        user: process.env.AGENT_RELAY_PG_USER,
        database: process.env.AGENT_RELAY_PG_DB,
        port: process.env.AGENT_RELAY_PG_PORT ? Number(process.env.AGENT_RELAY_PG_PORT) : 5432,
        // TLS on by default (Azure); a local Docker server sets AGENT_RELAY_PG_SSL=false.
        ssl: process.env.AGENT_RELAY_PG_SSL === "false" ? false : { rejectUnauthorized: true },
      }),
      interceptors: [],
    };
  }

  const dbPath = process.env.AGENT_RELAY_DB || join(__dirname, "agent-relay.db");
  return {
    identity: createLocalAliasIdentity(),
    credentials: createNoneCredentials(),
    transport: createSqlitePollTransport({ dbPath }),
    interceptors: [],
  };
}

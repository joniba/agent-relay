import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createMagicAliasIdentity } from "./identity/magic-alias.mjs";
import { createFolderNameIdentity } from "./identity/folder-name.mjs";
import { createNoneCredentials } from "./credentials/none.mjs";
import { createSqlitePollTransport } from "./transports/sqlite-poll.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Composition root — the SINGLE place adapters are chosen (OCP). To use a
 * different transport, identity scheme, credential source, or to add
 * interceptors (guardrails), edit ONLY this function.
 *
 * Defaults: SQLite-poll transport (DB co-located with the extension; override
 * with AGENT_RELAY_DB); identity = magic-alias (relay name = magic-remote alias
 * when available) decorating folder-name (override the name with
 * AGENT_RELAY_NAME, which also disables alias resolution); no credentials, no
 * interceptors. Swap the identity to bare `createFolderNameIdentity()` to opt
 * out of magic entirely.
 *
 * @returns {{
 *   identity: import('./seams/identity.mjs').IdentityProvider,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 *   transport: import('./seams/transport.mjs').Transport,
 *   interceptors: import('./seams/interceptor.mjs').Interceptor[],
 * }}
 */
export function createConfig() {
  const dbPath = process.env.AGENT_RELAY_DB || join(__dirname, "agent-relay.db");
  return {
    identity: createMagicAliasIdentity({ fallback: createFolderNameIdentity() }),
    credentials: createNoneCredentials(),
    transport: createSqlitePollTransport({ dbPath }),
    interceptors: [],
  };
}

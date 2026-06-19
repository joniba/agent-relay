import { createPostgresTransport } from "./transport/postgres.mjs";
import { createEnvPasswordCredentials } from "./credentials/env-password.mjs";
import { createAzureEntraCredentials } from "./credentials/azure/index.mjs";

/**
 * agent-relay-pg — the cross-machine Postgres plugin, packaged exactly like an
 * external drop-in plugin (its own package.json + node_modules).
 *
 * Default-exports the plugin factory `(ctx) => Registration`. The factory only
 * CONSTRUCTS (no I/O): it reads connection settings from `ctx.env` and returns a
 * Registration declaring two seams:
 *   - `transport`: the vendor-neutral Postgres transport (its `init()` owns the
 *     connect-retry; `create()` just constructs).
 *   - `credentials`: the env-password provider when `AGENT_RELAY_PG_PASSWORD` is
 *     set (local Docker / CI), else the Azure Entra token provider (the real
 *     cross-machine path; @azure/identity is imported lazily inside it).
 *
 * Machine/device display is intentionally NOT handled here in this phase — core
 * still stamps it. (A machine interceptor arrives in a later phase.)
 *
 * @param {{ env?: NodeJS.ProcessEnv, dataDir?: string|null, log?: (msg: string, opts?: object) => void }} ctx
 * @returns {{
 *   name: string,
 *   transport: { id: string, create: (ctx: { log?: Function }) => any },
 *   credentials: () => { get: () => Promise<string|null> },
 * }}
 */
export default function createPgPlugin(ctx) {
  const { env = process.env } = ctx ?? {};
  return {
    name: "agent-relay-pg",
    transport: {
      id: "postgres",
      create: ({ log } = {}) =>
        createPostgresTransport({
          host: env.AGENT_RELAY_PG_HOST,
          user: env.AGENT_RELAY_PG_USER,
          database: env.AGENT_RELAY_PG_DB,
          port: env.AGENT_RELAY_PG_PORT ? Number(env.AGENT_RELAY_PG_PORT) : 5432,
          // TLS on by default (Azure); a local Docker server sets AGENT_RELAY_PG_SSL=false.
          ssl: env.AGENT_RELAY_PG_SSL === "false" ? false : { rejectUnauthorized: true },
          log,
        }),
    },
    credentials: () =>
      env.AGENT_RELAY_PG_PASSWORD
        ? createEnvPasswordCredentials({ env })
        : createAzureEntraCredentials({ tenantId: env.AGENT_RELAY_AZURE_TENANT }),
  };
}

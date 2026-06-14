/**
 * Azure Entra CredentialProvider — mints a PostgreSQL-scoped Microsoft Entra
 * access token for the Postgres transport to use as its connection password.
 *
 * This is the ONLY module that knows about Azure. It lives in the self-contained
 * `azure/` lib so it can be lifted out into a separate repo / npm package later
 * with no change to the rest of the extension (the transport depends on the
 * Credentials *seam*, never on this module directly).
 *
 * Honors the {@link import('../seams/credentials.mjs').CredentialProvider} shape:
 * `get()` resolves to the raw token string (the transport passes it as the `pg`
 * connection password). Returns a fresh token each call, so a caller that invokes
 * `get()` per new connection always authenticates with a current token.
 *
 * @param {object} [opts]
 * @param {{ getToken: (scope: string|string[]) => Promise<{ token: string } | null> }} [opts.credential]
 *   The underlying Azure token source. Defaults to `DefaultAzureCredential`
 *   (honors `az login`, env vars, managed identity, …). Inject a fake in tests.
 * @param {string} [opts.scope]  OAuth scope for the token. Defaults to the
 *   Azure Database for PostgreSQL AAD scope.
 * @returns {import('../seams/credentials.mjs').CredentialProvider}
 */
export function createAzureEntraCredentials({ credential, scope = PG_AAD_SCOPE } = {}) {
  // Construct the default credential lazily only when none is injected, so the
  // module stays unit-testable with a fake WITHOUT @azure/identity being
  // resolvable, and so the heavy SDK loads only on the real cross-machine path —
  // never on the local default.
  let source = credential ?? null;

  return {
    async get() {
      if (!source) source = await defaultCredential();
      const result = await source.getToken(scope);
      const token = result && result.token;
      if (!token) {
        throw new Error("azure-entra credentials: token acquisition returned no token");
      }
      return token;
    },
  };
}

/** The Azure Database for PostgreSQL Microsoft Entra (AAD) OAuth scope. */
export const PG_AAD_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

async function defaultCredential() {
  const { DefaultAzureCredential } = await import("@azure/identity");
  return new DefaultAzureCredential();
}

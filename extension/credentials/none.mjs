/**
 * Default CredentialProvider: no credentials (local/dev needs none).
 *
 * A transport that requires auth (a cross-machine one) would be paired with a
 * real provider — env / Azure Key Vault / OS keystore — without any core change.
 *
 * @returns {import('../seams/credentials.mjs').CredentialProvider}
 */
export function createNoneCredentials() {
  return {
    async get() {
      return null;
    },
  };
}

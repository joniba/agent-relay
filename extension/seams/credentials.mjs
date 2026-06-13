/**
 * Credentials seam — owns auth material a transport needs.
 *
 * Consumed by a {@link Transport} (never by the core directly), so all
 * provider-specific code (env, Azure Key Vault, OS keystore, …) stays out of the
 * core — the no-vendor-lock-in constraint. The local default needs none.
 *
 * Default: `credentials/none.mjs` (returns null).
 *
 * @typedef {object} CredentialProvider
 * @property {() => Promise<Credentials|null>} get
 *   Return credentials for the transport, or null when none are needed.
 */

/**
 * Opaque credential material. Shape is transport-defined (token, cert paths,
 * connection string, …) — the core treats it as a black box.
 * @typedef {unknown} Credentials
 */

export {}; // contract-only module (types via JSDoc)

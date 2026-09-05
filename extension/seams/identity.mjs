/**
 * Identity seam — owns "who am I" for this session.
 *
 * The core asks the provider once at startup. `resolve` is async so an adapter
 * may do I/O; the default (`identity/local-alias.mjs`) is pure + synchronous.
 *
 * Default: `identity/local-alias.mjs` (a stone-style alias generated locally
 * from the session id; collisions resolved by the registry — see `candidates`).
 *
 * @typedef {object} IdentityProvider
 * @property {(context: *) => Promise<AgentIdentity>} resolve
 *   Resolve this session's identity from a runtime-supplied context. The context
 *   is **opaque to the core** — the entry passes whatever its runtime provides
 *   (the Copilot entry passes a `SessionLike`; an ACP entry would pass its own
 *   context to an ACP identity adapter). `id` MUST be stable for the session's
 *   lifetime; `name` is the human-friendly address.
 */

/**
 * A session's identity.
 * @typedef {object} AgentIdentity
 * @property {string} id     Stable unique id (default: the Copilot sessionId).
 * @property {string} name   Human-friendly, addressable name.
 * @property {string[]} [candidates]
 *   OPTIONAL ordered name preferences (most-preferred first; `name` === the
 *   first). When present, a registry MAY register this session under the first
 *   candidate not already taken by another session (collision avoidance) and
 *   reflect the chosen name back on `name`. When absent, `name` is used as-is.
 * @property {Record<string, string>} [attributes]
 *   OPTIONAL facts this session publishes about ITSELF onto its registry entry —
 *   returned to peers by {@link Transport.listAgents} and rendered generically in
 *   the roster. The core interprets no key.
 *
 *   Supplying these at `register` is how a session states them initially; a
 *   transport MUST **merge** rather than replace, leaving keys it was not given
 *   intact. That matters because a resuming session supplies none of them — they
 *   live in the store, not in its configuration — so replacing would silently
 *   erase everything it had published.
 */

/**
 * The minimal slice of a Copilot session the Copilot-runtime adapters rely on
 * (the `folder-name` identity and the `copilot` sink). Kept tiny so the core (and
 * tests) can substitute a fake. Other runtimes (e.g. ACP) provide their own
 * context shape to their own identity/sink adapters — the core never sees it.
 * @typedef {object} SessionLike
 * @property {string} sessionId
 * @property {(arg: string | { prompt: string, mode?: string }) => Promise<string>} send
 * @property {(message: string, options?: object) => Promise<void>} [log]
 */

export {}; // contract-only module (types via JSDoc)

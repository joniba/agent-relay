/**
 * Identity seam — owns "who am I" for this session.
 *
 * The core asks the provider once at startup (and the shape is async so a future
 * adapter can resolve a late-arriving name, e.g. an external alias — that
 * behavior is parked, but the seam allows it without a core change).
 *
 * Default: `identity/folder-name.mjs` (name = launch-folder leaf, id = sessionId).
 *
 * @typedef {object} IdentityProvider
 * @property {(context: *) => Promise<AgentIdentity>} resolve
 *   Resolve this session's identity from a runtime-supplied context. The context
 *   is **opaque to the core** — the entry passes whatever its runtime provides
 *   (the Copilot entry passes a `SessionLike`; an ACP entry would pass its own
 *   context to an ACP identity adapter). `id` MUST be stable for the session's
 *   lifetime; `name` is the human-friendly address.
 *
 * Future (parked): an optional `onChange(cb)` could let a provider refresh a
 * late-arriving/changed name at runtime (e.g. an external alias) and trigger a
 * re-register. The seam is async to leave room for this without a core change.
 */

/**
 * A session's identity.
 * @typedef {object} AgentIdentity
 * @property {string} id     Stable unique id (default: the Copilot sessionId).
 * @property {string} name   Human-friendly, addressable name (default: cwd leaf).
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

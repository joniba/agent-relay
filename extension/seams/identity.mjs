/**
 * Identity seam — owns "who am I" for this session.
 *
 * The entry asks the provider once at startup; the shape is async so an adapter
 * can resolve a late-arriving name (e.g. an external alias) via the optional
 * `onChange` seam below, without any core change.
 *
 * Default: an alias adapter decorating `identity/folder-name.mjs` (wired in `config.mjs`).
 *
 * @typedef {object} IdentityProvider
 * @property {(context: *) => Promise<AgentIdentity>} resolve
 *   Resolve this session's identity from a runtime-supplied context. The context
 *   is **opaque to the core** — the entry passes whatever its runtime provides
 *   (the Copilot entry passes a `SessionLike`; an ACP entry would pass its own
 *   context to an ACP identity adapter). `id` MUST be stable for the session's
 *   lifetime; `name` is the human-friendly address.
 * @property {(cb: (next: AgentIdentity) => void) => (() => void)} [onChange]
 *   OPTIONAL. Subscribe to a late-resolved identity NAME (the `id` never
 *   changes). Subscribing MAY itself trigger the late lookup, so the entry
 *   should call it exactly once, AFTER the initial register. At most one
 *   subscriber. Returns a `dispose()` that cancels any in-flight late resolution
 *   and drops the callback (the entry calls it at shutdown). On fire, the entry
 *   re-registers the same-`id` session under `next.name` — which relies on
 *   {@link import('./transport.mjs')} `register` being an idempotent upsert by id.
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

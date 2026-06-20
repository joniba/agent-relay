/**
 * Transport seam — owns message STORAGE + DELIVERY (both directions).
 *
 * This is the largest seam. The core never knows whether delivery is poll or
 * push, local or cross-machine, durable or best-effort — a Transport decides
 * all of that. The default is `transports/sqlite-poll.mjs`.
 *
 * A Transport MAY consume a {@link CredentialProvider} for any auth it needs
 * (none for the local SQLite default).
 *
 * Implementations MUST honor this shape; the core depends only on it (OCP).
 *
 * @typedef {object} Transport
 *
 * @property {(ctx: TransportContext) => Promise<void>} init
 *   One-time setup (open store, connect, etc.). Called once before any other method.
 *
 * @property {(self: AgentIdentity) => Promise<void>} register
 *   Make this session discoverable to peers under its identity. If
 *   `self.candidates` is a non-empty array, the registry MAY register under the
 *   first candidate not already held by another id (atomic collision avoidance)
 *   and reflect the chosen name back on `self.name`; otherwise it uses
 *   `self.name` as-is. Re-registering the same `id` updates its row in place.
 *
 * @property {(self: AgentIdentity) => Promise<void>} deregister
 *   Remove this session from discovery (called on session end).
 *
 * @property {() => Promise<AgentIdentity[]>} listAgents
 *   Return the currently-addressable peers (realizes F3 discovery). An entry MAY
 *   carry an opaque `attributes: Record<string,string>` bag the core renders in the
 *   roster but does NOT interpret (e.g. a cross-machine transport's `machine`/host).
 *
 * @property {(message: Message) => Promise<SendResult>} send
 *   Outbound: record/transmit a message toward its recipient. `message.to`
 *   addresses the recipient by its {@link AgentIdentity} — resolving to an exact
 *   `id` if one matches, else to the most-recently-active session with that
 *   `name` (names may collide; ids are unique). Resolves once the transport
 *   considers the message accepted; returns `{accepted:false, error}` for an
 *   unknown recipient. The opaque `message.meta` MUST be carried through untouched.
 *
 * @property {(onMessage: (message: Message) => (void | Promise<void>)) => void} startReceiving
 *   Inbound: begin delivering messages addressed to this session by invoking
 *   `onMessage` for each (via poll or push). Non-blocking. `onMessage` MAY return
 *   a Promise; the transport SHOULD treat a message as consumed only after that
 *   promise RESOLVES, and MAY redeliver it on a later cycle if it REJECTS (this
 *   is how a failed wake is retried). The transport is responsible for surviving
 *   a rejected handler (catch + continue), not the caller. To avoid a
 *   poison-message loop, a transport SHOULD bound redelivery attempts (e.g.
 *   dead-letter or cap retries) — the core already consumes interceptor-level
 *   poison, so a rejected handler here means a genuine transient wake failure.
 *
 * @property {() => Promise<void>} stop
 *   Terminal: stop receiving and release resources (timers, connections, DB
 *   handles). MUST be idempotent and MUST quiesce any in-flight delivery before
 *   releasing resources. This is distinct from {@link Transport.deregister}:
 *   callers SHOULD `deregister` (to promptly remove presence) and THEN `stop`;
 *   a transport MAY also let presence lapse via staleness if only `stop` is called.
 */

/**
 * Context handed to {@link Transport.init}.
 * @typedef {object} TransportContext
 * @property {AgentIdentity} self                The resolved identity of this session.
 * @property {CredentialProvider} credentials    For transports that need auth.
 */

/**
 * Result of {@link Transport.send}.
 * @typedef {object} SendResult
 * @property {boolean} accepted        True if the transport accepted the message.
 * @property {string} [id]             The message id, when accepted.
 * @property {string} [error]          Human-readable reason when not accepted.
 */

/**
 * @typedef {import('./identity.mjs').AgentIdentity} AgentIdentity
 * @typedef {import('./credentials.mjs').CredentialProvider} CredentialProvider
 * @typedef {import('../core/message.mjs').Message} Message
 */

export {}; // contract-only module (types via JSDoc)

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
 *   Make this session discoverable to peers under its identity.
 *
 * @property {(self: AgentIdentity) => Promise<void>} deregister
 *   Remove this session from discovery (called on session end).
 *
 * @property {() => Promise<AgentIdentity[]>} listAgents
 *   Return the currently-addressable peers (realizes F3 discovery).
 *
 * @property {(message: Message) => Promise<SendResult>} send
 *   Outbound: record/transmit a message toward its recipient. Resolves once the
 *   transport considers the message accepted; returns an error SendResult for an
 *   unknown recipient.
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
 *   Stop receiving and release resources.
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

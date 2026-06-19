/**
 * Interceptor seam — middleware on the message lifecycle.
 *
 * Interceptors are the ONLY place behavior is layered onto the bare core. ALL
 * guardrails (authority/trust, rate limiting, content filtering, loop/hop
 * guards) are interceptors — the POC ships NONE (default `[]`).
 *
 * Each hook is optional. `onSend`/`onReceive` follow the standard middleware
 * shape: call `next(message)` to continue (optionally with a transformed
 * message), or return without calling `next` to drop the message. Hooks SHOULD
 * `return`/`await next(...)` so transforms and downstream errors propagate
 * naturally; the chain runner is also robust to fire-and-forget `next()`.
 *
 * **onReceive errors are POISON, not retries:** if an `onReceive` hook throws,
 * the core logs and CONSUMES the message (no redelivery) to avoid an infinite
 * poison loop. Only a `session.send` wake failure is retried by the transport.
 * A guardrail that wants to *reject* a message should drop it (return without
 * `next`), not throw.
 *
 * `renderPrompt` lets an interceptor override how a received message becomes the
 * wake prompt. If no interceptor provides one, the core's neutral default
 * renderer is used (sender alias + id, recipient alias, body).
 *
 * @typedef {object} Interceptor
 * @property {(message: Message, next: NextFn) => (void | Promise<void>)} [onSend]
 *   Outbound hook, before the transport sends.
 * @property {(message: Message, next: NextFn) => (void | Promise<void>)} [onReceive]
 *   Inbound hook, before the session is woken.
 * @property {(message: Message, self: AgentIdentity) => (string | null)} [renderPrompt]
 *   Optional override of the wake-prompt text. Receives the recipient identity
 *   (`self`) for the `<to-alias>`. Return null to defer to the next interceptor /
 *   the core default.
 */

/**
 * Continuation passed to onSend/onReceive. Call with the (possibly transformed)
 * message to proceed; don't call it to drop the message.
 * @callback NextFn
 * @param {Message} message
 * @returns {void | Promise<void>}
 */

/**
 * @typedef {import('../core/message.mjs').Message} Message
 */

export {}; // contract-only module (types via JSDoc)

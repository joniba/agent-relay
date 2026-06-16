/**
 * Sink seam — the local agent runtime a delivered message is woken into.
 *
 * This is what keeps the core runtime-agnostic: it does NOT assume the recipient
 * is an interactive Copilot CLI user-session. The default sink wakes a Copilot
 * session via the SDK's `session.send()`; an **ACP-managed session** (or any
 * other agent runtime) is a drop-in alternative implementing the same shape. The
 * core depends ONLY on this contract for delivery — never on a concrete session.
 *
 * Unlike Transport/Identity/Credentials/Interceptor (chosen in `config.mjs`), the
 * Sink is constructed by the **entry/runtime adapter** (e.g. the Copilot
 * `extension.mjs`, or a future ACP entry) because it is bound to that runtime's
 * live session handle.
 *
 * @typedef {object} Sink
 * @property {(prompt: string) => Promise<void>} wake
 *   Inject a prompt as a NEW turn into the local agent. How (and whether it
 *   interrupts an in-flight turn) is the sink's concern, not the core's.
 * @property {(message: string, options?: import('./log.mjs').LogOptions) => (void | Promise<void>)} [log]
 *   Optional: surface a diagnostic in the runtime's timeline/log. In the default
 *   composition the entry injects its {@link import('./log.mjs').Logger} here (which
 *   returns `void`), so the core's diagnostics also reach the rolling file; a runtime
 *   whose own logger is async may instead return a `Promise` (see `logging/relay-log.mjs`).
 */

export {}; // contract-only module (types via JSDoc)

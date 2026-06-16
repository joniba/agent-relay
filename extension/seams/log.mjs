/**
 * Logger seam — the relay's diagnostic sink: a single function that records one line
 * of diagnostics. It decouples the transport, the core (via the {@link Sink}'s `log`),
 * and the sink from HOW/WHERE diagnostics are stored or surfaced: they depend ONLY on
 * this `Logger` shape, never on a concrete logger. The entry/composition root is the
 * one place that constructs concrete loggers and passes the resulting `Logger` down.
 *
 * Like the {@link Sink} — and unlike Transport/Identity/Credentials/Interceptor, which
 * are chosen in `config.mjs` — the Logger is constructed by the **entry/composition
 * root** (`extension.mjs`), because the destination (rolling file) and the
 * terminal-vs-file routing policy are runtime/entry concerns. It is then injected DOWN
 * into transports that accept diagnostic logging (through `config.mjs`'s
 * `createConfig({ log })`; the local SQLite transport ignores it) and into the core
 * (through the Sink's `log`). To replace the ENTIRE logging stack — destination,
 * format, and routing — swap what the entry builds and passes as the `Logger`; no
 * transport, core, or sink change is needed.
 *
 * The default composition is `logging/relay-log.mjs` (the terminal-vs-file routing
 * policy) teeing to `logging/rolling-file-log.mjs` (the durable rolling-file sink).
 *
 * CONTRACT — a Logger is fire-and-forget and MUST be failure-isolated: it MUST NOT
 * throw, and MUST NOT reject in a way that escapes (it is invoked from background
 * poll/sweep timers, outside any caller try/catch). A logging fault can therefore
 * never disrupt message delivery.
 *
 * @typedef {(message: string, options?: LogOptions) => void} Logger
 *
 * @typedef {object} LogOptions
 * @property {"info"|"warning"|"error"|"debug"} [level]
 *   Severity (default `"info"`). Sets the file log's level label and, together with the
 *   routing policy, influences whether the line also surfaces in the live terminal
 *   (errors always do; warnings do only during startup).
 * @property {boolean} [terminal]
 *   Force this line into the live session timeline regardless of level — reserved for
 *   the few human-facing lines (e.g. the "connected" confirmation). Most diagnostics
 *   omit it and are file-only.
 */

export {}; // contract-only module (types via JSDoc)

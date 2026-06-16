/**
 * Tee + terminal-routing policy for the relay's diagnostics.
 *
 * Diagnostics ALWAYS go to the durable rolling file (`fileLog`). They ADDITIONALLY
 * surface in the live Copilot session timeline (`sessionLog`) only for the few lines a
 * human should see inline — so the terminal stays clean and the file holds the full
 * technical detail. A line reaches the terminal when ANY of:
 *   - `opts.terminal === true`   — an explicitly user-facing line (e.g. "connected as …")
 *   - `opts.level === "error"`   — errors always surface
 *   - `isBooting() && opts.level === "warning"` — startup connect-retry warnings only;
 *                                  runtime warnings (sweeps, dead-letters) stay file-only
 *
 * Fire-and-forget + failure-isolated: a throwing/rejecting `sessionLog` (or `fileLog`)
 * can NEVER disrupt the relay — these also fire from background poll/sweep timers,
 * outside any try/catch.
 *
 * This is the ONE place the "what the user sees in the terminal vs. only in the file"
 * decision lives, so it stays small, explicit, and unit-testable.
 *
 * @param {object} deps
 * @param {(msg: string, opts?: object) => unknown} [deps.sessionLog]  Live-timeline sink.
 * @param {(msg: string, opts?: object) => void} deps.fileLog          Durable rolling-file sink.
 * @param {() => boolean} [deps.isBooting]  True while the session is still booting, so
 *   startup warnings surface; defaults to always-false (runtime).
 * @returns {(msg: string, opts?: { level?: string, terminal?: boolean }) => void}
 */
export function createRelayLog({ sessionLog, fileLog, isBooting = () => false }) {
  return function relayLog(msg, opts) {
    // The file is the source of truth and must capture EVERYTHING — write it first.
    try {
      fileLog(msg, opts);
    } catch {
      /* the rolling file log is already failure-isolated; guard anyway */
    }

    const level = opts && opts.level;
    const toTerminal =
      (opts && opts.terminal === true) ||
      level === "error" ||
      (level === "warning" && isBooting());

    if (toTerminal && typeof sessionLog === "function") {
      try {
        Promise.resolve(sessionLog(msg, opts)).catch(() => {});
      } catch {
        /* a logging failure must never disrupt the relay */
      }
    }
  };
}

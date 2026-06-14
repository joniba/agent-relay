/**
 * Default Sink: wakes a **Copilot CLI session** via the SDK's `session.send()`.
 *
 * This is the Copilot runtime adapter for the {@link import('../seams/sink.mjs').Sink}
 * seam. An ACP-managed session would have its own sink (e.g. `sinks/acp.mjs`)
 * that injects a turn via the ACP client — with no change to the core.
 *
 * Delivery mode is `immediate` (the proven wake mode); that choice lives HERE,
 * not in the core.
 *
 * @param {import('../seams/identity.mjs').SessionLike} session
 * @returns {import('../seams/sink.mjs').Sink}
 */
export function createCopilotSink(session) {
  return {
    wake: (prompt) => session.send({ prompt, mode: "immediate" }),
    log: typeof session.log === "function" ? (m, o) => session.log(m, o) : undefined,
  };
}

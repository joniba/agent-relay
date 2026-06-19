// agent-relay - session bootstrap (composition/entry layer, NOT core).
//
// Extracted from extension.mjs so the boot sequence is unit-testable with
// injected fakes (no SDK, no DB): a fake transport whose init()/register() throws
// exercises the partial-boot cleanup path deterministically.
//
// Responsibilities (all entry-level wiring, no policy of its own):
//   - resolve identity,
//   - bring the transport online: init() then register(); if either throws, stop()
//     the (possibly half-opened) transport before propagating, so a partly-inited
//     transport never leaks,
//   - build the runtime sink, construct the core relay, start receiving.
//
// This layer holds NO retry/backoff/timeout policy: connect resilience is the
// Transport's own concern (its init() owns any retry). There is deliberately no
// fallback to a different substrate - a connect failure propagates so the entry
// marks the relay inactive rather than silently partitioning the mesh.

import { createRelay } from "./core/relay.mjs";
import { createCopilotSink } from "./sinks/copilot.mjs";

/**
 * Bring a fully-composed config online and start the relay.
 *
 * Takes a PLAIN composed config (from `createConfig`), not a factory: identity is
 * resolved, then the transport is brought up linearly (init -> register). On any
 * failure during bring-up the transport is `stop()`ed (best-effort) and the error
 * propagates - the caller surfaces it / goes inactive.
 *
 * @param {object} deps
 * @param {import('./seams/identity.mjs').SessionLike} deps.session
 * @param {{
 *   identity: import('./seams/identity.mjs').IdentityProvider,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 *   transport: import('./seams/transport.mjs').Transport,
 *   interceptors?: import('./seams/interceptor.mjs').Interceptor[],
 * }} deps.config  The composed seam bundle.
 * @param {import('./seams/log.mjs').Logger} [deps.log]  Diagnostic logger (tee'd to the sink).
 * @returns {Promise<{
 *   relay: ReturnType<typeof createRelay>,
 *   self: import('./seams/identity.mjs').AgentIdentity,
 *   transport: import('./seams/transport.mjs').Transport,
 * }>}
 */
export async function startRelaySession({ session, config, log }) {
  const self = await config.identity.resolve(session);

  try {
    await config.transport.init({ self, credentials: config.credentials });
    await config.transport.register(self);
  } catch (err) {
    // init() succeeded but register() failed (or init() itself failed) - release
    // the (possibly half-opened) transport so it can't leak, then propagate.
    await config.transport.stop().catch(() => {});
    throw err;
  }

  // The Sink is the runtime-specific seam: this Copilot entry wakes via
  // session.send(); an ACP entry would build an ACP sink here instead. The tee'd
  // `log` is injected so the core's send/recv/poison lines reach the rolling file;
  // when omitted, the sink falls back to `session.log`.
  const sink = createCopilotSink(session, log);
  const relay = createRelay({
    sink,
    self,
    transport: config.transport,
    interceptors: config.interceptors ?? [],
  });
  relay.start();
  return { relay, self, transport: config.transport };
}
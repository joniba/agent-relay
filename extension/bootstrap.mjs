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

/**
 * Invoke every plugin's optional `activate` once, in load order, after this session
 * has registered and the relay exists.
 *
 * This is the ONLY moment a plugin can act on the mesh it just joined. Its factory
 * ran inside `createConfig` — before identity was resolved and before `register` —
 * so at that point it could read its configuration but could not know who it turned
 * out to be, nor see any peer. Declared tools only run when a consumer calls them.
 *
 * **Failure is contained, not fatal.** A plugin whose `activate` throws is an
 * additive capability that did not come up; the session's messaging is unaffected and
 * must keep working. So the error is logged naming the plugin and returned to the
 * caller, which marks that plugin's own tools as failed — rather than aborting a
 * session that is otherwise healthy. This is deliberately unlike plugin *loading*,
 * which is fail-loud: a bad registration means the seam graph itself is unknown, so
 * there is nothing safe to run.
 *
 * @param {object} deps
 * @param {Array<{ name: string, activate: Function|null }>} deps.plugins  In load order.
 * @param {object} deps.relay  The handle handed to plugins (a narrowed relay facade).
 * @param {import('./seams/identity.mjs').AgentIdentity} deps.self
 * @param {import('./seams/log.mjs').Logger} [deps.log]
 * @returns {Promise<Map<string, string>>}  plugin name -> failure message, for those that threw.
 */
export async function activatePlugins({ plugins = [], relay, self, log = () => {} }) {
  const failures = new Map();
  for (const plugin of plugins) {
    if (typeof plugin.activate !== "function") continue;
    try {
      await plugin.activate({ relay, self });
      log(`plugin activated: ${plugin.name}`);
    } catch (err) {
      const message = (err && err.message) || String(err);
      failures.set(plugin.name, message);
      log(`agent-relay: plugin "${plugin.name}" failed to activate: ${message}`, {
        level: "warning",
      });
    }
  }
  return failures;
}
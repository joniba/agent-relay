// agent-relay — session bootstrap (composition/entry layer, NOT core).
//
// Extracted from extension.mjs so the boot sequence is unit-testable with
// injected fakes (no SDK, no DB): a fake transport whose init()/register()
// throws exercises the boot-time fallback deterministically.
//
// Responsibilities (all entry-level wiring, no policy):
//   - resolve identity and stamp the display-only device name,
//   - bring up the PRIMARY transport (e.g. cross-machine Postgres),
//   - on a boot-time failure, fall back to a local transport so the session
//     stays useful (C-CM9) — a composition choice, not a core change,
//   - build the runtime sink, construct the core relay, start receiving.

import { hostname } from "node:os";

import { createRelay } from "./core/relay.mjs";
import { createCopilotSink } from "./sinks/copilot.mjs";

/**
 * Start a relay session, with a boot-time fallback to a local transport.
 *
 * The PRIMARY transport and the FALLBACK are both supplied by the caller
 * (composition root), so this function makes no substrate decision of its own
 * and is fully testable with fakes.
 *
 * Fallback semantics (C-CM9): if the primary transport fails `init`/`register`
 * at startup — unreachable host, bad credentials, unsupported (newer) schema —
 * the fallback transport is brought up instead and the relay runs there. There
 * is NO nested fallback: if the fallback ALSO fails to come up, that error
 * propagates so the boot failure stays visible (the entry surfaces it). A purely
 * transient mid-session outage is a different concern — the poll loop already
 * retries on its next tick and does not fall back.
 *
 * @param {object} deps
 * @param {import('./seams/identity.mjs').SessionLike} deps.session
 *   The runtime session (Copilot SDK session, or a fake with `send`/`log`).
 * @param {() => {
 *   identity: import('./seams/identity.mjs').IdentityProvider,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 *   transport: import('./seams/transport.mjs').Transport,
 *   interceptors?: import('./seams/interceptor.mjs').Interceptor[],
 * }} deps.createConfig
 *   Resolves the PRIMARY config (identity + credentials + transport + interceptors).
 * @param {() => {
 *   transport: import('./seams/transport.mjs').Transport,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 * }} [deps.fallbackFactory]
 *   Constructs the local fallback transport + its credentials. Omit to disable
 *   fallback (a primary failure then propagates).
 * @param {(msg: string, opts?: object) => void} [deps.log]  Diagnostic sink.
 * @returns {Promise<{
 *   relay: ReturnType<typeof createRelay>,
 *   self: import('./seams/identity.mjs').AgentIdentity,
 *   transport: import('./seams/transport.mjs').Transport,
 *   usedFallback: boolean,
 * }>}
 */
export async function startRelaySession({ session, createConfig, fallbackFactory, log = () => {} }) {
  const config = createConfig();
  const self = await config.identity.resolve(session);
  // Display-only device name (the machine this session runs on). Surfaced in the
  // cross-machine roster (e.g. "gull (my-laptop)") so a human can tell machines
  // apart; NEVER used for addressing or collision. A transport that doesn't store
  // it (the local SQLite default) simply ignores it.
  self.deviceName = process.env.AGENT_RELAY_HOST || hostname();

  let transport;
  let usedFallback = false;
  try {
    transport = await bringUp(config.transport, { self, credentials: config.credentials }, log, "primary");
  } catch (err) {
    // Best-effort release the primary before we either fall back or rethrow: a
    // transport that failed `register` AFTER a successful `init` still holds an
    // open pool (its `init` self-cleans, but `register` does not). `stop()` is
    // idempotent and safe even when `init` only partially ran.
    await config.transport.stop().catch(() => {});
    if (!fallbackFactory) throw err;
    log(
      `agent-relay: cross-machine transport unavailable — falling back to the local ` +
        `transport for this session (${err.message})`,
      { level: "warning" },
    );
    const fb = fallbackFactory();
    // No nested fallback: a failure here propagates so the boot stays visible.
    transport = await bringUp(fb.transport, { self, credentials: fb.credentials }, log, "fallback");
    usedFallback = true;
  }

  // The Sink is the runtime-specific seam: this Copilot entry wakes via
  // session.send(); an ACP entry would build an ACP sink here instead.
  const sink = createCopilotSink(session);
  const relay = createRelay({ sink, self, transport, interceptors: config.interceptors ?? [] });
  relay.start();
  return { relay, self, transport, usedFallback };
}

/**
 * Bring one transport online: init → register → log which substrate won.
 * @param {import('./seams/transport.mjs').Transport} transport
 * @param {import('./seams/transport.mjs').TransportContext} ctx
 * @param {(msg: string, opts?: object) => void} log
 * @param {string} label  "primary" | "fallback" (for the observability log).
 */
async function bringUp(transport, ctx, log, label) {
  await transport.init(ctx);
  await transport.register(ctx.self);
  log(`agent-relay: transport ready (${label})`);
  return transport;
}

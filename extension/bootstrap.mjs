// agent-relay — session bootstrap (composition/entry layer, NOT core).
//
// Extracted from extension.mjs so the boot sequence is unit-testable with
// injected fakes (no SDK, no DB): a fake transport whose init()/register() throws
// (or hangs) exercises the retry/timeout path deterministically.
//
// Responsibilities (all entry-level wiring, no policy of its own):
//   - resolve identity and stamp the display-only device name,
//   - bring up the transport, retrying a transient/slow connect a few times (warn
//     per attempt, error when giving up) before surfacing the failure. Each retry
//     uses a FRESH transport: the Transport seam is init-once / stop-terminal, so a
//     transport stopped after a failed attempt must never be reused (reusing one
//     would "succeed" into an inert transport that never receives),
//   - build the runtime sink, construct the core relay, start receiving.
//
// There is deliberately NO fallback to a different substrate: when a connect
// ultimately fails the error propagates so the entry marks the relay inactive.
// Silently switching an explicit cross-machine session onto a single-machine local
// store partitions the mesh (machines stop seeing each other) without telling the
// user — so we surface the failure and let them choose to switch.

import { hostname } from "node:os";

import { createRelay } from "./core/relay.mjs";
import { createCopilotSink } from "./sinks/copilot.mjs";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a relay session, retrying a transient/slow transport connect.
 *
 * `createConfig` is a FACTORY: called once up front (to resolve identity and for
 * the first connect attempt) and again per retry, yielding a fresh transport each
 * time. This honors the init-once / stop-terminal Transport contract — a transport
 * stopped after a failed attempt is discarded, never reused.
 *
 * Retry semantics: with no `retry` it is a single attempt. With `retry`, the
 * connect (init -> register) is attempted up to `retry.attempts` times; each
 * attempt is bounded by `retry.attemptTimeoutMs`, non-final failures log a warning
 * and wait `retry.backoffsMs[i]` (via injected `sleep`), and the final failure logs
 * an error and PROPAGATES (no fallback — the entry surfaces it / goes inactive).
 *
 * @param {object} deps
 * @param {import('./seams/identity.mjs').SessionLike} deps.session
 * @param {() => {
 *   identity: import('./seams/identity.mjs').IdentityProvider,
 *   credentials: import('./seams/credentials.mjs').CredentialProvider,
 *   transport: import('./seams/transport.mjs').Transport,
 *   interceptors?: import('./seams/interceptor.mjs').Interceptor[],
 * }} deps.createConfig  Factory: a fresh config (incl. a fresh transport) per call.
 * @param {(msg: string, opts?: object) => void} [deps.log]  Diagnostic sink.
 * @param {{ attempts?: number, attemptTimeoutMs?: number, backoffsMs?: number[] }} [deps.retry]
 * @param {(ms: number) => Promise<void>} [deps.sleep]  Backoff sleep (injectable for tests).
 * @returns {Promise<{
 *   relay: ReturnType<typeof createRelay>,
 *   self: import('./seams/identity.mjs').AgentIdentity,
 *   transport: import('./seams/transport.mjs').Transport,
 * }>}
 */
export async function startRelaySession({ session, createConfig, log = () => {}, retry, sleep = defaultSleep }) {
  const initial = createConfig();
  const self = await initial.identity.resolve(session);
  // Display-only device name (the machine this session runs on). Surfaced in the
  // cross-machine roster (e.g. "gull (my-laptop)") so a human can tell machines
  // apart; NEVER used for addressing or collision. A transport that doesn't store
  // it (the local SQLite default) simply ignores it.
  self.deviceName = process.env.AGENT_RELAY_HOST || hostname();

  const { transport, interceptors } = await bringUpWithRetry(
    { initial, createConfig, self },
    { log, retry, sleep },
  );

  // The Sink is the runtime-specific seam: this Copilot entry wakes via
  // session.send(); an ACP entry would build an ACP sink here instead.
  const sink = createCopilotSink(session);
  const relay = createRelay({ sink, self, transport, interceptors: interceptors ?? [] });
  relay.start();
  return { relay, self, transport };
}

/**
 * Bring a transport online, retrying a transient/slow connect per the policy. The
 * initial config is used for the first attempt; each retry builds a FRESH transport
 * via `createConfig` (init-once / stop-terminal — a stopped transport isn't reused).
 * On the final failure the error propagates (the caller surfaces it).
 *
 * @returns {Promise<{ transport: import('./seams/transport.mjs').Transport, interceptors: any[] }>}
 */
async function bringUpWithRetry({ initial, createConfig, self }, { log, retry, sleep }) {
  const attempts = Math.max(1, retry?.attempts ?? 1);
  const timeoutMs = retry?.attemptTimeoutMs;
  const backoffsMs = retry?.backoffsMs ?? [];

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const config = attempt === 1 ? initial : createConfig(); // fresh transport per retry
    const transport = config.transport;
    try {
      await withTimeout(connect(transport, { self, credentials: config.credentials }), timeoutMs, "connect");
      log("agent-relay: transport ready");
      return { transport, interceptors: config.interceptors };
    } catch (err) {
      lastErr = err;
      // Terminal stop for THIS (discarded) transport instance; the next attempt
      // builds a fresh one. A timed-out connect keeps running in the background but
      // only touches this discarded instance, so it can't corrupt the next attempt.
      await transport.stop().catch(() => {});
      const isFinal = attempt === attempts;
      if (isFinal) {
        if (attempts > 1) {
          log(
            `agent-relay: transport connect failed after ${attempts} attempts — giving up (${err.message})`,
            { level: "error" },
          );
        }
        break;
      }
      log(
        `agent-relay: transport connect failed (attempt ${attempt}/${attempts}) — retrying (${err.message})`,
        { level: "warning" },
      );
      const backoff = backoffsMs[attempt - 1] ?? 0;
      if (backoff > 0) await sleep(backoff);
    }
  }
  throw lastErr;
}

async function connect(transport, ctx) {
  await transport.init(ctx);
  await transport.register(ctx.self);
}

/**
 * Reject if `promise` doesn't settle within `ms`. When `ms` is falsy, returns the
 * promise unchanged. The losing promise stays handled (no unhandled rejection); it
 * is NOT cancelled, but callers retry on a fresh transport, so a late-settling
 * connect only touches the already-discarded instance.
 */
function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

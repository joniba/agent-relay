import { createMessage } from "./message.mjs";
import { runChain, renderPrompt } from "./interceptors.mjs";

/**
 * The relay core — the unopinionated orchestration logic, deliberately
 * RUNTIME-AGNOSTIC so it is unit-testable without a live Copilot CLI and works
 * for any agent runtime (a Copilot user-session, an ACP-managed session, …).
 *
 * Given a {@link Sink} (how to wake the local agent) and the already-resolved
 * seams, it:
 *   - exposes the `send_message` / `list_relay_agents` tool handlers,
 *   - rejects self-send (the one micro-rule, OD1),
 *   - routes inbound messages through the interceptor chain, renders the wake
 *     prompt, and calls `sink.wake()` to wake the agent.
 *
 * It knows NOTHING about how identity/transport/credentials/sink are constructed
 * (that is the entry/bootstrap's job), how the transport stores/delivers, or what
 * KIND of session the sink wakes.
 *
 * @param {object} deps
 * @param {import('../seams/sink.mjs').Sink} deps.sink  How to wake the local agent.
 * @param {import('../seams/identity.mjs').AgentIdentity} deps.self  Already-resolved identity.
 * @param {import('../seams/transport.mjs').Transport} deps.transport
 * @param {import('../seams/interceptor.mjs').Interceptor[]} [deps.interceptors]
 * @returns {{ sendMessage: Function, listAgents: Function, start: Function, stop: Function }}
 */
export function createRelay({ sink, self, transport, interceptors = [] }) {
  // Fire-and-forget observability via the Sink's optional log seam. Never awaited
  // and never throws, so it can't slow or break delivery — distinct from the poison
  // path below, which logs a DROP decision. Lines are metadata only (ids, never bodies).
  function note(line) {
    if (typeof sink.log !== "function") return;
    try {
      Promise.resolve(sink.log(line)).catch(() => {});
    } catch {
      /* observability must never disrupt the relay */
    }
  }

  /**
   * `send_message` tool handler. Plain in/out shape; the SDK adapter (bootstrap)
   * maps tool-call args to this and formats the result.
   *
   * @param {{ to?: string, content?: string, inReplyTo?: string }} args
   * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
   */
  async function sendMessage({ to, content, inReplyTo } = {}) {
    if (!to) return { ok: false, error: "'to' is required" };
    if (!content) return { ok: false, error: "'content' is required" };
    if (to === self.name || to === self.id) {
      return { ok: false, error: "cannot send a message to yourself" };
    }

    const message = createMessage({
      from: self.name,
      to,
      body: content,
      inReplyTo,
      // Stamp our session id as machine-agnostic provenance in `meta.fromId`. It is
      // NOT rendered in the default wake header (the alias is the reply handle); it
      // stays in metadata for any plugin that wants it. Any machine/device provenance
      // is added by a transport's plugin interceptor, not core.
      meta: { fromId: self.id },
    });

    const gated = await runChain(interceptors, "onSend", message);
    if (!gated) return { ok: false, error: "message blocked by an interceptor" };

    const startedAt = performance.now();
    const result = await transport.send(gated);
    const ms = Math.round(performance.now() - startedAt);
    if (!result || !result.accepted) {
      return { ok: false, error: (result && result.error) || "transport rejected the message" };
    }
    const id = result.id ?? gated.id;
    note(`sent msg=${id} to=${to} (${ms}ms)`);
    return { ok: true, id };
  }

  /**
   * `list_relay_agents` tool handler — proxies the transport's registry and flags self.
   * @returns {Promise<Array<import('../seams/identity.mjs').AgentIdentity & { self: boolean }>>}
   */
  async function listAgents() {
    const startedAt = performance.now();
    const agents = await transport.listAgents();
    const ms = Math.round(performance.now() - startedAt);
    note(`list ${agents.length} agent(s) (${ms}ms)`);
    return agents.map((a) => ({ ...a, self: a.id === self.id }));
  }

  /**
   * Handle one inbound message: interceptors → render → wake.
   *
   * Distinguishes two failure modes (Issue 3): a POISON message — an
   * `onReceive` interceptor or the renderer THROWS — is logged and consumed (we
   * return normally so the transport does NOT redeliver, avoiding an infinite
   * poison loop). A transient WAKE failure — `sink.wake` rejects — is allowed to
   * propagate so the transport MAY redeliver per its contract.
   *
   * @param {import('./message.mjs').Message} message
   */
  async function onInbound(message) {
    let prompt;
    try {
      const gated = await runChain(interceptors, "onReceive", message);
      if (!gated) return; // dropped by an interceptor — consumed, no retry
      prompt = renderPrompt(interceptors, gated, self);
    } catch (err) {
      // Poison: interceptor/renderer threw. Consume (no retry) and log.
      if (typeof sink.log === "function") {
        try {
          await sink.log(
            `agent-relay: dropping message ${message.id} (onReceive error: ${err.message})`,
            { level: "warning" },
          );
        } catch {
          // A failing log must never turn a consumed poison message into a
          // wake-style failure that the transport would redeliver.
        }
      }
      return;
    }
    note(`recv msg=${message.id} from=${message.from}`);
    // Wake failures propagate → the transport may redeliver.
    await sink.wake(prompt);
  }

  /** Begin receiving inbound messages and waking the session. */
  function start() {
    transport.startReceiving((message) => onInbound(message));
  }

  /**
   * Publish facts about a session onto its registry entry. PATCH semantics: keys
   * present are set, keys absent are untouched, a `null` value removes the key.
   * Defaults to this session; writing another's requires `force`.
   *
   * Feature-detected, because attribute storage is an OPTIONAL transport capability —
   * a transport that predates it (or a third-party one) should produce a clear result
   * rather than a TypeError on an undefined method.
   *
   * **Everything that is not storage is decided HERE**, so that a transport's only job
   * is to merge a validated patch into its store. Left to the transports, each of these
   * was decided twice and independently — and `undefined` was decided *differently*, so
   * the same call deleted a key on one transport and silently no-opped with `ok: true`
   * on the other. A third transport could equally satisfy the documented signature while
   * quietly dropping `force`, and nothing would report that the guardrail was gone.
   *
   * Specifically:
   * - unknown option keys are REJECTED, not ignored. Every near-miss for `id`
   *   (`sessionId`, `to`, `target`) would otherwise be dropped by destructuring,
   *   silently redirecting the write to the caller's own entry and returning `ok: true`.
   * - `undefined` is normalised to `null` (a removal). It is a JavaScript artifact, not
   *   a storable value: `JSON.stringify` drops it, so it cannot survive to any store.
   * - non-string values are refused. Strings are the portable contract; a given
   *   transport may happen to round-trip richer JSON, and a plugin relying on that
   *   breaks the moment a different transport is installed.
   * - writing another session requires `force`, checked against the identity this relay
   *   registered with rather than anything the caller supplied.
   *
   * @param {{ id?: string, attributes: Record<string, string|null>, force?: boolean }} args
   */
  async function setAttributes(args = {}) {
    const unknown = Object.keys(args).filter((k) => !["id", "attributes", "force"].includes(k));
    if (unknown.length) {
      return {
        ok: false,
        error:
          `unknown setAttributes option(s): ${unknown.join(", ")}. ` +
          `The target session is named by 'id'; the call takes { id?, attributes, force? }`,
      };
    }
    const { id, attributes, force } = args;
    if (attributes == null || typeof attributes !== "object" || Array.isArray(attributes)) {
      return { ok: false, error: "'attributes' must be an object" };
    }

    const patch = {};
    for (const [key, raw] of Object.entries(attributes)) {
      if (raw === null || raw === undefined) {
        patch[key] = null;
        continue;
      }
      if (typeof raw !== "string") {
        return {
          ok: false,
          error:
            `attribute '${key}' must be a string or null (got ${typeof raw}). ` +
            `Strings are the portable contract across transports.`,
        };
      }
      patch[key] = raw;
    }

    const target = id ?? self.id;
    if (target !== self.id && !force) {
      return {
        ok: false,
        error: `refusing to write attributes on another session (${target}) without force`,
      };
    }
    if (typeof transport.setAttributes !== "function") {
      return { ok: false, error: "attributes aren't supported by the active transport" };
    }
    const result = await transport.setAttributes({ id: target, attributes: patch, force });
    if (result && result.ok) note(`attributes set on ${target.slice(0, 8)}`);
    return result;
  }

  /** Stop receiving and release transport resources. */
  async function stop() {
    await transport.stop();
  }

  return { sendMessage, listAgents, setAttributes, start, stop };
}

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

    const message = createMessage({ from: self.name, to, body: content, inReplyTo });

    const gated = await runChain(interceptors, "onSend", message);
    if (!gated) return { ok: false, error: "message blocked by an interceptor" };

    const result = await transport.send(gated);
    if (!result || !result.accepted) {
      return { ok: false, error: (result && result.error) || "transport rejected the message" };
    }
    const id = result.id ?? gated.id;
    note(`sent msg=${id} to=${to}`);
    return { ok: true, id };
  }

  /**
   * `list_relay_agents` tool handler — proxies the transport's registry and flags self.
   * @returns {Promise<Array<import('../seams/identity.mjs').AgentIdentity & { self: boolean }>>}
   */
  async function listAgents() {
    const agents = await transport.listAgents();
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
      prompt = renderPrompt(interceptors, gated);
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

  /** Stop receiving and release transport resources. */
  async function stop() {
    await transport.stop();
  }

  return { sendMessage, listAgents, start, stop };
}

import { createMessage } from "./message.mjs";
import { runChain, renderPrompt } from "./interceptors.mjs";

/**
 * The relay core — the unopinionated orchestration logic, deliberately
 * SESSION-AGNOSTIC so it is unit-testable without a live Copilot CLI.
 *
 * Given a session-like object and the already-resolved seams, it:
 *   - exposes the `send_message` / `list_relay_agents` tool handlers,
 *   - rejects self-send (the one micro-rule, OD1),
 *   - routes inbound messages through the interceptor chain, renders the wake
 *     prompt, and calls `session.send()` to wake the agent.
 *
 * It knows NOTHING about how identity/transport/credentials are constructed
 * (that is the bootstrap's job) or how the transport stores/delivers messages.
 *
 * @param {object} deps
 * @param {import('../seams/identity.mjs').SessionLike} deps.session
 * @param {import('../seams/identity.mjs').AgentIdentity} deps.self  Already-resolved identity.
 * @param {import('../seams/transport.mjs').Transport} deps.transport
 * @param {import('../seams/interceptor.mjs').Interceptor[]} [deps.interceptors]
 * @returns {{ sendMessage: Function, listAgents: Function, start: Function, stop: Function }}
 */
export function createRelay({ session, self, transport, interceptors = [] }) {
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
    return { ok: true, id: result.id ?? gated.id };
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
   * poison loop). A transient WAKE failure — `session.send` rejects — is allowed
   * to propagate so the transport MAY redeliver per its contract.
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
      if (typeof session.log === "function") {
        await session.log(
          `agent-relay: dropping message ${message.id} (onReceive error: ${err.message})`,
          { level: "warning" },
        );
      }
      return;
    }
    // Wake failures propagate → the transport may redeliver.
    await session.send({ prompt, mode: "immediate" });
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

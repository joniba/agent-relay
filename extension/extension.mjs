// agent-relay — Copilot CLI extension entry.
//
// Thin wiring layer ONLY: it joins the foreground session, resolves the seams
// from the composition root (config.mjs), constructs the core relay, and manages
// lifecycle. All behavior lives in core/ + the chosen adapters; this file makes
// no policy decisions of its own.
//
// Requires `copilot --experimental` (extensions are gated behind it) and Node 22+.

import { joinSession } from "@github/copilot-sdk/extension";
import { createConfig } from "./config.mjs";
import { createRelay } from "./core/relay.mjs";
import { createCopilotSink } from "./sinks/copilot.mjs";

// Assigned during bootstrap (after joinSession resolves). The tool/hook handlers
// below close over these and tolerate being called before bootstrap completes.
let relay = null;
let self = null;
let transport = null;
let ready = false; // true only after a fully successful bootstrap (relay started)
let bootError = null; // set if bootstrap failed (terminal, not transient)
let cleanedUp = false;

/** Result returned by tools before the relay is usable (booting OR boot-failed). */
function notReadyResult() {
  return bootError
    ? { textResultForLlm: `agent-relay failed to start: ${bootError}`, resultType: "failure" }
    : {
        textResultForLlm: "agent-relay is still starting up — try again in a moment.",
        resultType: "failure",
      };
}

const tools = [
  {
    name: "send_message",
    description:
      "Send a text message to another agent-relay session, waking it into a new turn. " +
      "Address the recipient by name (see list_relay_agents) or by its session id.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient name or session id" },
        content: { type: "string", description: "The message text to deliver" },
        in_reply_to: {
          type: "string",
          description: "Optional id of a message this is replying to",
        },
      },
      required: ["to", "content"],
    },
    handler: async (args) => {
      if (!ready) return notReadyResult();
      const res = await relay.sendMessage({
        to: args.to,
        content: args.content,
        inReplyTo: args.in_reply_to,
      });
      return res.ok
        ? {
            textResultForLlm:
              `Message sent to "${args.to}" (id: ${res.id}). ` +
              `Any reply will arrive automatically as a new turn — do not poll.`,
            resultType: "success",
          }
        : { textResultForLlm: `Could not send message: ${res.error}`, resultType: "failure" };
    },
  },
  {
    name: "list_relay_agents",
    description: "List the agent-relay sessions currently reachable for messaging.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!ready) return notReadyResult();
      const agents = await relay.listAgents();
      if (agents.length === 0) {
        return {
          textResultForLlm: "No agent-relay peers are currently registered.",
          resultType: "success",
        };
      }
      const lines = agents
        .map((a) => `- ${a.name}${a.self ? " (you)" : ""}  [id: ${a.id}]`)
        .join("\n");
      return {
        textResultForLlm: `Reachable agent-relay sessions:\n${lines}`,
        resultType: "success",
      };
    },
  },
];

const hooks = {
  onSessionStart: async () => {
    if (!ready) return {}; // don't advertise connectivity until fully registered
    return {
      additionalContext:
        `You are connected to agent-relay as "${self.name}". ` +
        `Use list_relay_agents to see reachable peers and send_message(to, content) to message ` +
        `another session — their replies arrive automatically as new turns (no polling).`,
    };
  },
  onSessionEnd: async () => {
    await shutdown();
  },
};

/** Deregister presence then stop the transport. Idempotent. */
async function shutdown() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    if (transport && self) await transport.deregister(self);
  } catch {
    /* best-effort */
  }
  try {
    if (relay) await relay.stop();
  } catch {
    /* best-effort */
  }
}

// ─── Join + bootstrap (runs at load — registers BEFORE the first user prompt) ──

const session = await joinSession({ tools, hooks });

try {
  const config = createConfig();
  transport = config.transport;
  self = await config.identity.resolve(session);
  await transport.init({ self, credentials: config.credentials });
  await transport.register(self);
  // The Sink is the runtime-specific seam: this Copilot entry wakes via
  // session.send(); an ACP entry would build an ACP sink here instead.
  const sink = createCopilotSink(session);
  relay = createRelay({ sink, self, transport, interceptors: config.interceptors });
  relay.start();
  ready = true;
  await session.log?.(`agent-relay: registered as "${self.name}" — ready`);
  // If a teardown was requested while we were booting, honor it now.
  if (cleanedUp) {
    cleanedUp = false;
    await shutdown();
  }
} catch (err) {
  bootError = err.message;
  await session.log?.(`agent-relay failed to start: ${err.message}`, { level: "error" });
}

// Best-effort cleanup if the host tears us down without onSessionEnd. Use `once`
// (no stacked handlers) and explicitly exit — a signal listener suppresses Node's
// default terminate, so we must drain + exit ourselves.
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });

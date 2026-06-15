// agent-relay — Copilot CLI extension entry.
//
// Composition root + lifecycle: it joins the foreground session, resolves the seams
// from config.mjs, chooses boot policy (connect-retry + inactive-on-failure for an
// explicit cross-machine transport), constructs the core relay, and manages
// lifecycle. All BEHAVIOR lives in core/ + the chosen adapters; the only decisions
// here are which adapters and which boot policy to wire — the composition root's job.
//
// Requires `copilot --experimental` (extensions are gated behind it) and Node 22+.

import { joinSession } from "@github/copilot-sdk/extension";
import { join } from "node:path";
import { loadEnvFile } from "./env-file.mjs";
import { createConfig } from "./config.mjs";
import { startRelaySession } from "./bootstrap.mjs";
import { formatRoster } from "./roster.mjs";
import { resolveDataDir } from "./storage/paths.mjs";
import { createRollingFileLog } from "./logging/rolling-file-log.mjs";

// Load project-local config from a gitignored `.env` (if present) BEFORE anything
// reads process.env — fills gaps only, so shell-exported vars still win. Lets the
// cross-machine settings live with the project instead of in every shell.
const loadedEnvFile = loadEnvFile();

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
      const lines = formatRoster(agents);
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

// A rolling on-disk log in the canonical data dir, so diagnostics survive after the
// live session timeline scrolls away — and exist even when no session is watching.
// Best-effort: created defensively, and the logger itself never throws.
let fileLog = () => {};
try {
  fileLog = createRollingFileLog({ dir: join(resolveDataDir(), "logs") });
} catch {
  /* data dir unresolvable → degrade to timeline-only logging */
}

// Route the transport's diagnostics through BOTH the session log (live timeline) and
// the rolling file log (durable). Fire-and-forget, but never let a logging failure
// escape as an unhandled rejection — these fire from background poll/sweep timers
// too, outside any try/catch.
const relayLog = (msg, opts) => {
  try {
    Promise.resolve(session.log?.(msg, opts)).catch(() => {});
  } catch {
    /* a logging failure must never disrupt the relay */
  }
  fileLog(msg);
};

// Surface which .env (if any) seeded the config — handy when diagnosing why a
// session did or didn't join the cross-machine mesh.
if (loadedEnvFile) {
  relayLog(
    `agent-relay: loaded config from ${loadedEnvFile.path}` +
      (loadedEnvFile.applied.length ? ` (set ${loadedEnvFile.applied.join(", ")})` : " (no new keys)"),
  );
}

// When the user EXPLICITLY selected the cross-machine (Postgres) transport, a boot
// failure must SURFACE — the relay goes inactive — rather than silently dropping to
// a different, single-machine local mesh (which caused confusing "why can't my
// machines see each other" situations). Retry transient/slow connects a few times
// first; the local default gets a single attempt, since a local store failure won't
// heal by retrying.
const isCrossMachine = process.env.AGENT_RELAY_TRANSPORT === "postgres";
const retry = isCrossMachine
  ? { attempts: 3, attemptTimeoutMs: 30_000, backoffsMs: [2_000, 4_000] }
  : undefined;

try {
  // All substrate composition lives in config.mjs; the entry only supplies the
  // session + log + retry policy and performs the boot via the testable bootstrap.
  const started = await startRelaySession({
    session,
    createConfig: () => createConfig({ log: relayLog }),
    retry,
    log: relayLog,
  });
  relay = started.relay;
  self = started.self;
  transport = started.transport;
  ready = true;
  relayLog(`agent-relay: registered as "${self.name}" — ready`);
  // If a teardown was requested while we were booting, honor it now.
  if (cleanedUp) {
    cleanedUp = false;
    await shutdown();
  }
} catch (err) {
  bootError = err.message;
  const suggestion = isCrossMachine
    ? " — agent-relay is INACTIVE this session (not on any mesh). Fix connectivity and restart, or unset AGENT_RELAY_TRANSPORT to use the local single-machine mesh."
    : "";
  relayLog(`agent-relay failed to start: ${err.message}${suggestion}`, { level: "error" });
}

// Best-effort cleanup if the host tears us down without onSessionEnd. Use `once`
// (no stacked handlers) and explicitly exit — a signal listener suppresses Node's
// default terminate, so we must drain + exit ourselves.
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });

// agent-relay — extension runtime (the testable half of the entry).
//
// `extension.mjs` is a shim that wires the real SDK/filesystem dependencies into
// this factory and starts it. Everything with behaviour lives here so the boot
// sequence can be exercised with fakes: the previous top-level `await
// joinSession(...)` could not be tested at all, which mattered once plugins began
// contributing tools and the load order had to change.
//
// Boot order (and why it is this order):
//   1. resolve the data dir            — no session needed
//   2. load plugins via createConfig   — MUST precede joinSession, because tool
//                                        declarations are one-shot in the join
//                                        payload and cannot be added afterwards
//   3. joinSession(core + plugin tools)
//   4. build the real logger           — its tag derives from session.sessionId,
//                                        which only exists now, so plugin-load
//                                        diagnostics are buffered until here
//   5. bring the relay online
//
// A plugin failure at step 2 is recorded and boot CONTINUES to step 3 with core's
// tools only, so `send_message` still exists to report what went wrong. That is
// the same fail-loud-but-visible contract the entry had before the reorder.

import { formatRoster } from "./roster.mjs";
import { activatePlugins } from "./bootstrap.mjs";
import { join } from "node:path";

/**
 * Narrow the relay to what a plugin legitimately needs. A plugin gets to send and to
 * see who is reachable; it does not get to stop the relay or reach the transport,
 * which are the host's lifecycle to own.
 */
function pluginRelayFacade(relay) {
  return {
    sendMessage: (args) => relay.sendMessage(args),
    listAgents: () => relay.listAgents(),
    setAttributes: (args) => relay.setAttributes(args),
  };
}

/**
 * Wrap each plugin tool so that, if its plugin failed to activate, calling it says so
 * instead of running against half-initialised state.
 *
 * Without this a failed activation is silent at the tool surface: the handler still
 * exists and still runs, and the plugin's own not-ready guard (if it has one) reports
 * a *transient* problem for a condition that will never resolve.
 *
 * @param {Array<{ name: string, tools: Array<object> }>} plugins
 * @param {Map<string, string>} failures  Filled in at activation; read at call time.
 */
function guardPluginTools(plugins, failures) {
  const guarded = [];
  for (const plugin of plugins) {
    for (const tool of plugin.tools) {
      guarded.push({
        ...tool,
        handler: async (args) => {
          const failure = failures.get(plugin.name);
          if (failure) {
            return {
              textResultForLlm:
                `agent-relay: plugin "${plugin.name}" failed to activate: ${failure}. ` +
                `Its tools are unavailable for the rest of this session.`,
              resultType: "failure",
            };
          }
          return tool.handler(args);
        },
      });
    }
  }
  return guarded;
}

/**
 * Build the extension runtime.
 *
 * @param {object} deps  All external collaborators, injectable for tests.
 * @param {(config: object) => Promise<any>} deps.joinSession
 * @param {(opts: object) => Promise<any>} deps.createConfig
 * @param {(opts: object) => Promise<any>} deps.startRelaySession
 * @param {() => string} deps.resolveDataDir
 * @param {(opts: object) => Function} deps.createRollingFileLog
 * @param {(opts: object) => Function} deps.createRelayLog
 * @param {(id: string) => string} deps.aliasFor
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @returns {{ start: () => Promise<void>, shutdown: () => Promise<void>, state: () => object }}
 */
export function createExtensionRuntime({
  joinSession,
  createConfig,
  startRelaySession,
  resolveDataDir,
  createRollingFileLog,
  createRelayLog,
  aliasFor,
  env = process.env,
}) {
  let relay = null;
  let self = null;
  let transport = null;
  let session = null;
  let ready = false; // true only after a fully successful bootstrap (relay started)
  let bootError = null; // set if plugin loading or bootstrap failed (terminal, not transient)
  let cleanedUp = false;
  let pluginBriefings = [];
  /** plugin name -> activation failure message. Read by guarded tool handlers. */
  const pluginFailures = new Map();

  /** Result returned by tools before the relay is usable (booting OR boot-failed). */
  function notReadyResult() {
    return bootError
      ? { textResultForLlm: `agent-relay failed to start: ${bootError}`, resultType: "failure" }
      : {
          textResultForLlm: "agent-relay is still starting up — try again in a moment.",
          resultType: "failure",
        };
  }

  const coreTools = [
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

  /** Names the entry owns. A plugin claiming one of these fails to load. */
  const coreToolNames = coreTools.map((t) => t.name);

  const hooks = {
    onSessionStart: async () => {
      if (!ready) return {}; // don't advertise connectivity until fully registered
      // Core describes its own tools; each plugin describes its own. Core does not
      // hold a hardcoded description of a tool surface it no longer solely owns —
      // otherwise the briefing goes stale the first time any plugin adds a tool,
      // and a plugin's tools stay undiscoverable to the consumer that matters.
      const core =
        `You are connected to agent-relay as "${self.name}". ` +
        `Use list_relay_agents to see reachable peers and send_message(to, content) to message ` +
        `another session — their replies arrive automatically as new turns (no polling).`;
      return { additionalContext: [core, ...pluginBriefings].join("\n\n") };
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

  async function start() {
    // Resolve the canonical data dir first (pure but can throw on an odd HOME).
    // Needed by plugins, and it does not depend on the session.
    let dataDir = null;
    try {
      dataDir = resolveDataDir();
    } catch {
      /* data dir unresolvable → degrade to timeline-only logging */
    }

    // Plugins load BEFORE the session exists, so there is no session id yet and
    // therefore no log tag. Buffer until the real logger is built — but this
    // function is RETAINED for the life of the session by every plugin factory and
    // by a plugin-supplied transport (whose connect retries and sweeps log from
    // background timers), so it must forward once a sink exists rather than going
    // write-only after a single drain.
    let logSink = null;
    const buffered = [];
    const pluginLog = (message, opts) => {
      if (logSink) logSink(message, opts);
      else buffered.push([message, opts]);
    };

    let config = null;
    try {
      config = await createConfig({
        env,
        dataDir,
        log: pluginLog,
        reservedToolNames: coreToolNames,
      });
    } catch (err) {
      // A bad plugin is terminal for the relay but NOT for the join: we still
      // register core's tools below so the failure is reportable through them.
      // `err` is not necessarily an Error — a plugin factory may throw anything.
      bootError = (err && err.message) || String(err);
    }

    pluginBriefings = config?.briefings ?? [];
    const tools = [...coreTools, ...guardPluginTools(config?.plugins ?? [], pluginFailures)];

    session = await joinSession({ tools, hooks });

    // Per-session tag for the rolling log, so lines from concurrent sessions sharing the
    // file are correlatable. Two parts: (1) the friendly alias — computed with the SAME
    // precedence as the statusline's resolveName (AGENT_RELAY_NAME override, else the
    // deterministic aliasFor(sessionId)), so a log line matches the [alias] under the
    // prompt; this is deliberately the statusline preview, NOT the post-registration name
    // (which the registry may bump on a local collision) — keeping log↔statusline parity.
    // (2) the first 8 chars of the session id — the AUTHORITATIVE key, since aliases can
    // collide; the id8 always disambiguates. e.g. "[loon 0c854195]".
    const sessionId = String(session.sessionId ?? "");
    const sessionTag = `${env.AGENT_RELAY_NAME || aliasFor(sessionId)} ${sessionId.slice(0, 8)}`.trim();

    // A rolling on-disk log in the canonical data dir, so diagnostics survive after the
    // live session timeline scrolls away — and exist even when no session is watching.
    // Best-effort: created defensively, and the logger itself never throws.
    let fileLog = () => {};
    if (dataDir) {
      try {
        fileLog = createRollingFileLog({ dir: join(dataDir, "logs"), tag: sessionTag });
      } catch {
        /* logger construction failed → degrade to timeline-only logging */
      }
    }

    // Diagnostics are durable in the rolling FILE log; only a curated few also surface in
    // the live terminal (the "connected" line, startup connect warnings, and errors) so
    // the session isn't cluttered with technical detail — see createRelayLog. `booting`
    // gates the startup-warning window: warnings surface while booting, file-only after.
    let booting = true;
    const relayLog = createRelayLog({
      sessionLog: (msg, opts) => session.log?.(msg, opts),
      fileLog,
      isBooting: () => booting,
    });

    try {
      // One boot line establishes the per-session context every later line is read against:
      // where this session's data + logs live. Without it, a shared log can't be correlated
      // to a session.
      relayLog(`boot datadir=${dataDir ?? "?"}`);
      // Replay everything the plugin loader said before a tagged logger existed, then
      // point the retained plugin logger at the real one. Drain first so replayed
      // lines keep their order ahead of anything logged from here on; both statements
      // are synchronous, so nothing can interleave between them.
      for (const [message, opts] of buffered.splice(0)) relayLog(message, opts);
      logSink = relayLog;

      // Guard on the actual invariant. `bootError` is a message, and a plugin can
      // throw something without one — testing it instead of `config` would let boot
      // continue and replace the plugin's error with a null dereference.
      if (!config) {
        relayLog(`agent-relay failed to start: ${bootError}`, { level: "error" });
        return;
      }

      const started = await startRelaySession({ session, config, log: relayLog });
      relay = started.relay;
      self = started.self;
      transport = started.transport;
      // File-only registration detail (id/name) for the log; the human-facing
      // confirmation is the single terminal line below.
      relayLog(`registered id=${String(self.id ?? "").slice(0, 8)} name=${self.name}`);
      // Plugins act on the mesh for the first time here — after registration, before
      // the session is announced as ready. A plugin that throws is contained: its own
      // tools report the failure, everything else carries on.
      for (const [name, message] of await activatePlugins({
        plugins: config.plugins ?? [],
        relay: pluginRelayFacade(relay),
        self,
        log: relayLog,
      })) {
        pluginFailures.set(name, message);
      }
      // The ONE line the user sees in the terminal on a successful join (🌐 = the
      // agent-mesh heritage icon). `config.remote` is true when a plugin supplied the
      // transport, false on the local default.
      relayLog(
        `🌐 agent-relay: connected to ${config.remote ? "remote" : "local"} transport as [${self.name}]`,
        { terminal: true },
      );
      // Set LAST: everything above can throw, and a half-started relay that reports
      // itself ready would have tools dereferencing a null relay.
      ready = true;
    } catch (err) {
      // Any boot failure (a transport that couldn't come up) marks the relay INACTIVE
      // for this session - no silent fallback to a different mesh.
      ready = false;
      bootError = (err && err.message) || String(err);
      relayLog(`agent-relay failed to start: ${bootError}`, { level: "error" });
    } finally {
      // If a teardown was requested while we were booting, honor it now — including
      // when boot failed, since a transport may have half-opened before throwing.
      if (cleanedUp) {
        cleanedUp = false;
        await shutdown();
      }
      // Startup window closed: from here on, only errors (not warnings) surface inline.
      booting = false;
    }
  }

  /** Inspection seam for tests. */
  function state() {
    return { session, relay, self, transport, ready, bootError, coreTools, hooks };
  }

  return { start, shutdown, state };
}

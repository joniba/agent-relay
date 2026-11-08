// agent-relay — Copilot CLI extension entry.
//
// Deliberately a shim. It wires the real SDK, filesystem and logging collaborators
// into `entry.mjs` and starts it; every decision with behaviour lives there, so the
// boot sequence can be tested with fakes. Before plugins could contribute tools the
// orchestration was small enough to sit at the top level here — it no longer is, and
// a top-level `await joinSession(...)` is not reachable from a test.
//
// Requires `copilot --experimental` (extensions are gated behind it) and Node 22+.

import { joinSession } from "@github/copilot-sdk/extension";
import { resolveDataDir } from "./storage/paths.mjs";
import { createExtensionRuntime } from "./entry.mjs";

const started = Date.now();
process.stderr.write("[agent-relay startup] loading tool configuration\n");
const runtime = createExtensionRuntime({
  joinSession: async (options) => {
    const session = await joinSession(options);
    process.stderr.write(`[agent-relay startup] tools registered elapsed_ms=${Date.now() - started}\n`);
    return session;
  },
  createConfig: async (options) => (await import("./config.mjs")).createConfig(options),
  startRelaySession: async (options) => (await import("./bootstrap.mjs")).startRelaySession(options),
  resolveDataDir,
  createRollingFileLog: async (options) =>
    (await import("./logging/rolling-file-log.mjs")).createRollingFileLog(options),
  createRelayLog: async (options) =>
    (await import("./logging/relay-log.mjs")).createRelayLog(options),
  aliasFor: async (id) => (await import("./identity/local-alias.mjs")).aliasFor(id),
  env: process.env,
});

// Runs at load — registers tools BEFORE the first user prompt.
const boot = runtime.start();

// Best-effort cleanup if the host tears us down without onSessionEnd. Use `once`
// (no stacked handlers) and explicitly exit — a signal listener suppresses Node's
// default terminate, so we must drain + exit ourselves.
process.once("SIGTERM", () => { void runtime.shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void runtime.shutdown().finally(() => process.exit(0)); });
await boot;

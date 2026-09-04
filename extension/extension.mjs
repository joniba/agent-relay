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
import { createConfig } from "./config.mjs";
import { startRelaySession } from "./bootstrap.mjs";
import { resolveDataDir } from "./storage/paths.mjs";
import { aliasFor } from "./identity/local-alias.mjs";
import { createRollingFileLog } from "./logging/rolling-file-log.mjs";
import { createRelayLog } from "./logging/relay-log.mjs";
import { createExtensionRuntime } from "./entry.mjs";

const runtime = createExtensionRuntime({
  joinSession,
  createConfig,
  startRelaySession,
  resolveDataDir,
  createRollingFileLog,
  createRelayLog,
  aliasFor,
  env: process.env,
});

// Runs at load — registers tools BEFORE the first user prompt.
await runtime.start();

// Best-effort cleanup if the host tears us down without onSessionEnd. Use `once`
// (no stacked handlers) and explicitly exit — a signal listener suppresses Node's
// default terminate, so we must drain + exit ourselves.
process.once("SIGTERM", () => { void runtime.shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void runtime.shutdown().finally(() => process.exit(0)); });

#!/usr/bin/env node
// Install agent-relay as a Copilot CLI extension — cross-platform, dependency-free.
//
// PRIMARY install path:   npx --yes github:joniba/agent-relay
// From a local clone:     node scripts/install.mjs
//
// It copies this package's `extension/` folder into the Copilot CLI extensions dir so
// the entry lives at `<COPILOT_HOME>/extensions/agent-relay/extension.mjs`, wires the
// statusline, and prints next steps. It does NOT launch Copilot.
//
// Core is LOCAL-ONLY and has zero runtime dependencies (built-in node:sqlite). Cross-
// machine messaging is a separate drop-in plugin (agent-relay-pg-plugin) installed into
// this extension's own `plugins/` folder — this installer never touches that folder.
//
// The copy is a NON-PURGING delta-copy: it overwrites the code in place but never
// deletes anything the source doesn't ship. That deliberately PRESERVES, across an
// upgrade: installed plugins (`plugins/<name>/`), the SQLite store + sidecars (`*.db*`),
// and any local config — so you can upgrade while sessions are open. Each file is
// written via a temp file + atomic rename, so a half-written file is never observed.

import { existsSync, readdirSync, copyFileSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const NO_STATUSLINE = argv.includes("--no-statusline");
// Suppress the trailing "Next steps" narrative — used when a WRAPPER installer (e.g. the
// agent-relay-pg-plugin installer) drives core, so the user sees one coherent set of next
// steps from the wrapper, not core's local-transport message contradicting it.
const QUIET = argv.includes("--quiet");

const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", CYAN = "\x1b[36m", DIM = "\x1b[90m", RESET = "\x1b[0m";
const ok = (m) => console.log(`${GREEN}${m}${RESET}`);
const warn = (m) => console.warn(`${YELLOW}${m}${RESET}`);
const info = (m) => console.log(`${CYAN}${m}${RESET}`);
const die = (m) => { console.error(`\n${m}`); process.exit(1); };

// --- Destination -------------------------------------------------------------
const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const dest = join(copilotHome, "extensions", "agent-relay");

// --- Uninstall mode (early exit; no source/build needed) ---------------------
const UNINSTALL = argv.includes("--uninstall");
const PURGE = argv.includes("--purge");
if (UNINSTALL) {
  if (existsSync(dest)) { rmSync(dest, { recursive: true, force: true }); ok(`\u2713 Removed ${dest}`); }
  else { info(`Nothing installed at ${dest}.`); }
  revertStatusline();
  if (PURGE) purgeState();
  else info(`Runtime state (DB + logs) kept at ${dataDir()} — re-run with --purge to remove it too.`);
  info(`\nagent-relay uninstalled. Reinstall: npx --yes github:joniba/agent-relay#feature/plugin-loader`);
  process.exit(0);
}

/** Reset Copilot's statusLine ONLY if it points at agent-relay's statusline script. */
function revertStatusline() {
  const settingsPath = join(copilotHome, "settings.json");
  if (!existsSync(settingsPath)) return;
  let settings;
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { return; }
  const cmd = settings && settings.statusLine && settings.statusLine.command;
  if (typeof cmd === "string" && /agent-relay-statusline\.mjs/.test(cmd)) {
    delete settings.statusLine;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    ok(`\u2713 Reverted Copilot statusline (${settingsPath})`);
  }
}

/** Per-user data dir (DB + logs) — mirrors extension/storage/paths.mjs resolveDataDir(). */
function dataDir() {
  if (process.env.AGENT_RELAY_DATA_DIR) return process.env.AGENT_RELAY_DATA_DIR;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "agent-relay");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "agent-relay");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "agent-relay");
}

/** With --purge: remove the data dir, but ONLY when it's a dedicated `agent-relay` dir (the
 *  default, or a custom AGENT_RELAY_DATA_DIR whose leaf is `agent-relay`). For any other custom
 *  dir we refuse — never risk wiping a shared directory the user pointed us at. */
function purgeState() {
  const dd = dataDir();
  if (!existsSync(dd)) { info(`No runtime state at ${dd}.`); return; }
  if (basename(dd) === "agent-relay") {
    rmSync(dd, { recursive: true, force: true });
    ok(`\u2713 Removed runtime state (DB + logs): ${dd}`);
  } else {
    warn(`--purge skipped: AGENT_RELAY_DATA_DIR=${dd} is not a dedicated 'agent-relay' directory; refusing to delete it wholesale. Remove ${join(dd, "agent-relay.db")} (+ -wal/-shm) and the agent-relay logs manually for a full reset.`);
  }
}

// --- Locate the source (this script lives in <repo>/scripts) -----------------
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const source = join(repoRoot, "extension");
const entry = join(source, "extension.mjs");
if (!existsSync(entry)) {
  die(`Cannot find the extension entry at '${entry}'. Run this from a clone of agent-relay (or via npx github:joniba/agent-relay).`);
}

// --- Node >= 22.5 (required at runtime for node:sqlite) ----------------------
{
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 5)) ok(`Node ${process.versions.node} (ok)`);
  else warn(`Node ${process.versions.node} found, but agent-relay needs >= 22.5.0 (node:sqlite). The extension will fail to load until you upgrade.`);
}

// --- Install: ensure the extensions dir exists -------------------------------
mkdirSync(dirname(dest), { recursive: true });

// --- Install: non-purging atomic delta-copy ----------------------------------
// Skip source artifacts that are state/config, never code: a stray dev SQLite store and
// the (now-inert) `.env` — core no longer loads a .env, it reads process.env directly.
const SKIP = (name) => name === ".env" || /\.db($|-)/.test(name);

function copyFileAtomic(src, dst) {
  const tmp = `${dst}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  copyFileSync(src, tmp);
  try {
    renameSync(tmp, dst); // atomic replace — a half-written file is never observed
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`could not write '${dst}': ${e.message}. If a running session holds it open, close it and re-run.`);
  }
}

function copyDir(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP(e.name)) continue;
    const s = join(srcDir, e.name);
    const d = join(dstDir, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) copyFileAtomic(s, d);
  }
}

copyDir(source, dest);

// --- Verify ------------------------------------------------------------------
if (!existsSync(join(dest, "extension.mjs"))) {
  die(`Install verification failed: '${join(dest, "extension.mjs")}' is missing.`);
}
ok(`\n\u2713 Installed agent-relay -> ${dest}`);

// --- Statusline: point Copilot's single statusLine slot at agent-relay --------
// Shows THIS session's locally-generated alias below the prompt. Replaces whatever
// statusLine command was previously configured. Opt out with --no-statusline.
if (!NO_STATUSLINE) {
  const statusScript = join(dest, "bin", "agent-relay-statusline.mjs");
  if (existsSync(statusScript)) {
    const settingsPath = join(copilotHome, "settings.json");
    let settings = {};
    let settingsParsedOk = true;
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) ?? {}; }
      catch { settingsParsedOk = false; }
    }
    if (!settingsParsedOk) {
      // Don't overwrite a file we couldn't parse — that would discard the user's other
      // settings. Skip the statusline wiring and tell them how to set it by hand.
      warn(`Could not parse ${settingsPath} as JSON — leaving it untouched and skipping statusline wiring. Fix the file (or set statusLine.command to: node "${statusScript}") and re-run.`);
    } else {
      const previous = settings?.statusLine?.command ?? null;
      const cmd = `node "${statusScript}"`;
      settings.statusLine = { type: "command", command: cmd };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
      ok(`\u2713 Statusline -> agent-relay (${settingsPath})`);
      if (previous && previous !== cmd) console.log(`${DIM}  (replaced: ${previous})${RESET}`);
    }
  } else {
    warn(`Statusline script not found at ${statusScript} — skipped.`);
  }
}

// --- Next steps --------------------------------------------------------------
if (!QUIET) {
  const nameHint = process.platform === "win32"
    ? `$env:AGENT_RELAY_NAME = "tia"   # PowerShell  (cmd.exe: set AGENT_RELAY_NAME=tia)`
    : `export AGENT_RELAY_NAME=tia`;
  info(`
Next steps (this script does NOT launch Copilot):
  1. (optional) name this session in the mesh:  ${nameHint}
  2. start with extensions enabled:             copilot --experimental

On load you'll see: \ud83c\udf10 agent-relay: connected to local transport as [<alias>]${
  NO_STATUSLINE ? "" : "\nThe same alias renders below the prompt as [<alias>] (statusline)."
}

Cross-machine messaging is a separate plugin: npx --yes github:joniba/agent-relay-pg-plugin`);
}

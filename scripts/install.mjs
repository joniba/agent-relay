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
// PLUGIN MANAGEMENT (core installs ANY plugin from GitHub — a plugin ships no installer):
//   npx --yes github:joniba/agent-relay --add-plugin <owner/repo> [--ref <branch|tag|sha>]
//   npx --yes github:joniba/agent-relay --remove-plugin <name>
// `--add-plugin` installs core ONLY if it's missing (it never re-installs/upgrades an
// already-installed core — run the bare installer to do that), then clones the plugin repo,
// `npm install --omit=dev`s its prod deps, and copies its package.json + `files` allowlist
// (+ node_modules) into this extension's own `plugins/<name>/` folder (the dir the loader
// scans). GitHub repos only — no npm-registry support. `--remove-plugin` deletes `plugins/<name>/`.
//
// Core is LOCAL-ONLY and has zero runtime dependencies (built-in node:sqlite). Cross-
// machine messaging is a separate drop-in plugin (agent-relay-pg-plugin) added via
// `--add-plugin github:joniba/agent-relay-pg-plugin`.
//
// The copy is a NON-PURGING delta-copy: it overwrites the code in place but never
// deletes anything the source doesn't ship. That deliberately PRESERVES, across an
// upgrade: installed plugins (`plugins/<name>/`), the SQLite store + sidecars (`*.db*`),
// and any local config — so you can upgrade while sessions are open. Each file is
// written via a temp file + atomic rename, so a half-written file is never observed.

import { existsSync, readdirSync, copyFileSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync, mkdtempSync, cpSync } from "node:fs";
import { join, dirname, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

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

/** Read the value following a `--flag` (e.g. `--add-plugin owner/repo`). Returns null if the
 *  flag is absent; dies if it's present without a following value. */
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("-")) die(`${name} requires a value (e.g. ${name} owner/repo).`);
  return v;
}
const ADD_PLUGIN = flagValue("--add-plugin");
const REMOVE_PLUGIN = flagValue("--remove-plugin");
const REF = flagValue("--ref");

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
  info(`\nagent-relay uninstalled. Reinstall: npx --yes github:joniba/agent-relay`);
  process.exit(0);
}

// --- Remove a plugin (early exit; no source/build needed) --------------------
if (REMOVE_PLUGIN) { removePlugin(REMOVE_PLUGIN); process.exit(0); }

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

/** Install (or refresh) core from this package's `extension/` into <dest>. Idempotent and
 *  non-purging: it overwrites code in place but PRESERVES installed plugins (`plugins/<name>/`),
 *  the SQLite store (`*.db*`), and local config — safe to re-run while sessions are open. */
function installCore() {
  const entry = join(source, "extension.mjs");
  if (!existsSync(entry)) {
    die(`Cannot find the extension entry at '${entry}'. Run this from a clone of agent-relay (or via npx github:joniba/agent-relay).`);
  }
  // Node >= 22.5 (required at runtime for node:sqlite).
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 5)) ok(`Node ${process.versions.node} (ok)`);
  else warn(`Node ${process.versions.node} found, but agent-relay needs >= 22.5.0 (node:sqlite). The extension will fail to load until you upgrade.`);

  mkdirSync(dirname(dest), { recursive: true });
  copyDir(source, dest);
  if (!existsSync(join(dest, "extension.mjs"))) {
    die(`Install verification failed: '${join(dest, "extension.mjs")}' is missing.`);
  }
  ok(`\n\u2713 Installed agent-relay -> ${dest}`);
  if (!NO_STATUSLINE) wireStatusline();
}

/** Point Copilot's single statusLine slot at agent-relay's statusline script. Shows THIS
 *  session's locally-generated alias below the prompt. Replaces whatever was configured. */
function wireStatusline() {
  const statusScript = join(dest, "bin", "agent-relay-statusline.mjs");
  if (!existsSync(statusScript)) { warn(`Statusline script not found at ${statusScript} — skipped.`); return; }
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
    return;
  }
  const previous = settings?.statusLine?.command ?? null;
  const cmd = `node "${statusScript}"`;
  settings.statusLine = { type: "command", command: cmd };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  ok(`\u2713 Statusline -> agent-relay (${settingsPath})`);
  if (previous && previous !== cmd) console.log(`${DIM}  (replaced: ${previous})${RESET}`);
}

// --- Plugin management -------------------------------------------------------
// The generic version of what a plugin's own installer used to do: clone the repo,
// `npm install --omit=dev` its prod deps, and copy its `files` allowlist (+ package.json
// + node_modules) into `plugins/<name>/`. A plugin carries NO install script — core
// installs ANY plugin by being pointed at its GitHub repo (no npm-registry support).

/** Spawn helper. On Windows `npm` is a `.cmd` shim Node can't run directly and that
 *  `shell:true` would leave unescaped (DEP0190) — route it through cmd.exe (a real .exe)
 *  with NO shell, so Node still escapes each arg. `git` is a real exe and runs directly. */
function winShim(cmd, args) {
  return process.platform === "win32" && cmd === "npm"
    ? ["cmd.exe", ["/d", "/s", "/c", cmd, ...args]]
    : [cmd, args];
}
function run(cmd, args, opts = {}) {
  const [c, a] = winShim(cmd, args);
  execFileSync(c, a, { stdio: "inherit", ...opts });
}
function tryRun(cmd, args, opts = {}) {
  const [c, a] = winShim(cmd, args);
  try { execFileSync(c, a, { stdio: "ignore", ...opts }); return true; }
  catch { return false; }
}

/** Normalize a plugin repo spec to a clone target. Accepts `owner/repo`, `github:owner/repo`,
 *  a full git URL (https / ssh), or an EXISTING local directory / `file:` URL (a dev affordance,
 *  mirroring core's AGENT_RELAY_CORE_REPO — `git clone` accepts a local path). */
function normalizeRepoUrl(spec) {
  if (/^https?:\/\//.test(spec) || /^git@/.test(spec) || /^ssh:\/\//.test(spec) || /^file:\/\//.test(spec)) return spec;
  if (existsSync(spec)) return spec; // a local clone source (dev / offline)
  const m = spec.replace(/^github:/, "").match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (m) return `https://github.com/${m[1]}/${m[2]}.git`;
  die(`--add-plugin: unrecognized repo '${spec}'. Use owner/repo, github:owner/repo, a full git URL, or a local path.`);
}

/** The on-disk folder for a plugin = its package.json `name`, scope stripped. Rejected unless
 *  it's a safe single path segment (defense against path traversal via a crafted name). */
function pluginFolder(name) {
  const folder = String(name).replace(/^@[^/]+\//, "");
  if (folder === "." || folder === ".." || !/^[a-zA-Z0-9._-]+$/.test(folder)) {
    die(`Plugin name '${name}' is not a safe folder name.`);
  }
  return folder;
}

/** Clone a plugin repo (optionally at a ref), install its prod deps, and copy its
 *  package.json + `files` allowlist (+ node_modules) into <dest>/plugins/<name>/. */
function addPlugin(spec, ref) {
  if (!existsSync(join(dest, "extension.mjs"))) {
    die(`agent-relay core isn't installed at ${dest}. Install it first: npx --yes github:joniba/agent-relay`);
  }
  if (!tryRun("git", ["--version"])) {
    die("git is required for --add-plugin (it clones the plugin repo) but was not found on PATH.");
  }
  const url = normalizeRepoUrl(spec);
  const tmp = mkdtempSync(join(tmpdir(), "agent-relay-plugin-"));
  try {
    info(`Cloning plugin ${url}${ref ? ` @ ${ref}` : ""}...`);
    // Full clone then checkout — works for a branch, tag, OR commit SHA (a SHA can't be a
    // `--branch` arg). Default branch when no ref is given.
    run("git", ["clone", "--quiet", url, tmp]);
    if (ref) run("git", ["-C", tmp, "checkout", "--quiet", ref]);

    const pkgPath = join(tmp, "package.json");
    if (!existsSync(pkgPath)) die("The plugin repo has no package.json — can't determine its name/files.");
    let pkg;
    try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); }
    catch (e) { die(`The plugin's package.json is not valid JSON: ${e.message}`); }
    if (!pkg.name || typeof pkg.name !== "string") die(`The plugin's package.json has no "name".`);
    const folder = pluginFolder(pkg.name);
    const fileList = Array.isArray(pkg.files) ? pkg.files : null;
    if (!fileList || fileList.length === 0) {
      die(`The plugin's package.json has no "files" array — core needs it to know which files to install.`);
    }

    // Install prod dependencies INTO the clone, so node_modules can be copied alongside.
    const hasDeps = pkg.dependencies && Object.keys(pkg.dependencies).length > 0;
    if (hasDeps) {
      if (!tryRun("npm", ["--version"])) {
        die("npm is required to install this plugin's dependencies but was not found on PATH.");
      }
      info("Installing plugin dependencies (npm install --omit=dev)...");
      run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: tmp });
    }

    // Re-copy into the plugin dir. On an UPGRADE (the dir already exists) clear the previously
    // installed code so a file removed in the new version doesn't linger — but PRESERVE the
    // user's local config: the plugin's gitignored `.env` / `.env.*` (never part of a `files`
    // allowlist, so the copy below won't recreate it). This keeps re-running --add-plugin to
    // upgrade from destroying connection settings, matching core's own non-purging "preserve
    // local config across upgrades" guarantee. (We preserve only `.env*` — not all dotfiles —
    // so a SHIPPED dotfile dropped between versions is still purged like any other stale file.)
    const isLocalConfig = (name) => name === ".env" || name.startsWith(".env.");
    const pluginDest = join(dest, "plugins", folder);
    if (existsSync(pluginDest)) {
      for (const e of readdirSync(pluginDest, { withFileTypes: true })) {
        if (isLocalConfig(e.name)) continue; // keep the user's .env / .env.* across upgrades
        rmSync(join(pluginDest, e.name), { recursive: true, force: true });
      }
    } else {
      mkdirSync(pluginDest, { recursive: true });
    }
    cpSync(pkgPath, join(pluginDest, "package.json")); // the loader reads this to resolve the entry
    for (const rel of fileList) {
      if (typeof rel !== "string" || rel.includes("..") || isAbsolute(rel)) {
        warn(`  (skip) unsafe "files" entry: ${rel}`);
        continue;
      }
      const src = join(tmp, rel);
      if (!existsSync(src)) { warn(`  (skip) "files" entry not found in the plugin: ${rel}`); continue; }
      cpSync(src, join(pluginDest, rel), { recursive: true });
    }
    if (hasDeps) {
      const nm = join(tmp, "node_modules");
      if (!existsSync(nm)) die("npm install did not produce node_modules.");
      cpSync(nm, join(pluginDest, "node_modules"), { recursive: true });
    }

    // Verify the loader's entry resolves.
    const entryFile = (pkg.agentRelay && pkg.agentRelay.entry) || pkg.main || "index.mjs";
    if (!existsSync(join(pluginDest, entryFile))) {
      die(`Plugin '${folder}' installed but its entry '${entryFile}' is missing under ${pluginDest}.`);
    }
    ok(`\u2713 Installed plugin '${folder}' -> ${pluginDest}`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir best-effort */ }
  }
}

/** Remove an installed plugin's `plugins/<name>/` folder. */
function removePlugin(name) {
  const folder = pluginFolder(name);
  const pluginDir = join(dest, "plugins", folder);
  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true });
    ok(`\u2713 Removed plugin '${folder}' (${pluginDir})`);
  } else {
    info(`No plugin '${folder}' installed at ${pluginDir}.`);
  }
}

// --- Run ---------------------------------------------------------------------
if (ADD_PLUGIN) {
  // Adding a plugin must NOT touch an already-installed core. Only install core when it's
  // MISSING (a convenience so the two-step flow works even if you skipped step 1). To
  // upgrade core itself, run the bare installer: `npx --yes github:joniba/agent-relay`.
  if (existsSync(join(dest, "extension.mjs"))) {
    info(`agent-relay core already installed at ${dest} — leaving it as-is (run the bare installer to upgrade core).`);
  } else {
    info(`agent-relay core isn't installed yet — installing it first...`);
    installCore();
  }
  addPlugin(ADD_PLUGIN, REF);
  if (!QUIET) {
    info(`
Next steps (this script does NOT launch Copilot):
  start Copilot with extensions enabled:  copilot --experimental

If the plugin needs configuration, see ITS README for what to set (e.g. a .env to create
under ${join(dest, "plugins")}).`);
  }
} else {
  // Default path: install (or refresh) core.
  installCore();
  if (!QUIET) {
    const nameHint = process.platform === "win32"
      ? `$env:AGENT_RELAY_NAME = "alice"   # PowerShell  (cmd.exe: set AGENT_RELAY_NAME=alice)`
      : `export AGENT_RELAY_NAME=alice`;
    info(`
Next steps (this script does NOT launch Copilot):
  1. (optional) name this session in the mesh:  ${nameHint}
  2. start with extensions enabled:             copilot --experimental

On load you'll see: \ud83c\udf10 agent-relay: connected to local transport as [<alias>]${
  NO_STATUSLINE ? "" : "\nThe same alias renders below the prompt as [<alias>] (statusline)."
}

Cross-machine messaging is a separate plugin. Add it with:
  npx --yes github:joniba/agent-relay --add-plugin github:joniba/agent-relay-pg-plugin`);
  }
}

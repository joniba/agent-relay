#!/usr/bin/env node
// A disposable agent-relay install you can point a real Copilot session at, so a
// feature can be exercised end to end without touching the extension your live
// sessions are running on.
//
//   node scripts/sandbox.mjs up            # build it (core + roles plugin)
//   node scripts/sandbox.mjs launch        # open a session on it
//   node scripts/sandbox.mjs status        # what's installed, who's live
//   node scripts/sandbox.mjs down          # delete it
//
// Two environment variables do the isolating, and BOTH are required — this script
// exists mostly so you cannot forget the second one:
//
//   COPILOT_HOME           which extension the CLI loads
//   AGENT_RELAY_DATA_DIR   which mesh it joins
//
// Set only the first and the sandbox session joins your LIVE local mesh, which looks
// like it works and is the one mistake worth engineering away.
//
// There is exactly one sandbox. `up` is idempotent — re-run it after changing code.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_REPO = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const COMMAND = argv.find((a) => !a.startsWith("-")) ?? "help";
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

const c = (code, s) => `\u001b[${code}m${s}\u001b[0m`;
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const green = (s) => c(32, s);
const yellow = (s) => c(33, s);
const red = (s) => c(31, s);
const info = (s) => console.log(s);
const die = (s) => {
  console.error(`\n${red("✗")} ${s}\n`);
  process.exit(1);
};

// One sandbox, in the OS data dir — deliberately NOT inside a repo, so it can never
// be committed and `down` can remove it without touching a working tree.
const SANDBOX =
  process.env.AGENT_RELAY_SANDBOX ||
  join(
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : join(homedir(), ".local", "share"),
    "agent-relay-sandbox",
  );
const HOME_DIR = join(SANDBOX, "home");
const DATA_DIR = join(SANDBOX, "data");
const EXT_DIR = join(HOME_DIR, "extensions", "agent-relay");
const PLUGINS_DIR = join(EXT_DIR, "plugins");

const sandboxEnv = () => ({
  ...process.env,
  COPILOT_HOME: HOME_DIR,
  AGENT_RELAY_DATA_DIR: DATA_DIR,
});

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (res.error) die(`${cmd} failed to start: ${res.error.message}`);
  return res.status === 0;
}

function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", shell: false, ...opts });
  return res.status === 0 ? (res.stdout || "").trim() : null;
}

/**
 * Directory that holds sibling repo checkouts.
 *
 * Resolved through git rather than by counting `..`, because this script usually runs
 * from a worktree (`<repo>/worktrees/<name>`), which is two levels deeper than a plain
 * checkout. `--git-common-dir` points at the MAIN clone's `.git` from either.
 */
function reposParent() {
  const common = capture("git", ["-C", CORE_REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const mainRepo = common ? dirname(common) : CORE_REPO;
  return resolve(mainRepo, "..");
}

/**
 * Find a checkout of a sibling plugin repo, preferring one whose branch is not the
 * default — that is almost always the feature you are trying to test.
 *
 * Looked up rather than asked for: `--add-plugin` accepts a local path (it clones it),
 * so a sibling worktree installs the branch you already have checked out, with no ref
 * to remember and no push required.
 */
function findLocalCheckout(repoName) {
  const root = join(reposParent(), repoName);
  const candidates = [root];
  const wt = join(root, "worktrees");
  if (existsSync(wt)) {
    for (const e of readdirSync(wt, { withFileTypes: true })) {
      if (e.isDirectory()) candidates.push(join(wt, e.name));
    }
  }
  const scored = [];
  for (const path of candidates) {
    if (!existsSync(join(path, ".git"))) continue;
    const branch = capture("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch) continue;
    const isDefault = branch === "main" || branch === "master";
    scored.push({ path, branch, rank: isDefault ? 1 : 0, mtime: statSync(path).mtimeMs });
  }
  scored.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime);
  return scored[0] ?? null;
}

/** Live sessions in the SANDBOX mesh — used to pick a free name, and by `status`. */
function sandboxAgents() {
  const db = join(DATA_DIR, "agent-relay.db");
  if (!existsSync(db)) return [];
  try {
    // Imported lazily: node:sqlite is only present on a new enough Node, and every
    // other command should still work without it.
    const { DatabaseSync } = require("node:sqlite");
    const handle = new DatabaseSync(db, { readOnly: true });
    const cutoff = new Date(Date.now() - 45_000).toISOString();
    const rows = handle
      .prepare("SELECT name FROM agents WHERE last_heartbeat >= ? ORDER BY name")
      .all(cutoff);
    handle.close();
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/** First unused `sbx-<letter>`, so two tabs never collide and both are obviously test sessions. */
function pickName() {
  const taken = new Set(sandboxAgents());
  for (const ch of "abcdefghijklmnopqrstuvwxyz") {
    if (!taken.has(`sbx-${ch}`)) return `sbx-${ch}`;
  }
  return `sbx-${Date.now().toString(36).slice(-4)}`;
}

/** The .env of an INSTALLED pg plugin, so credentials are pointed at, never copied. */
function findPgEnv() {
  const explicit = value("--pg-env");
  if (explicit) {
    if (!existsSync(explicit)) die(`--pg-env: no such file: ${explicit}`);
    return explicit;
  }
  const live = join(homedir(), ".copilot", "extensions", "agent-relay", "plugins", "agent-relay-pg", ".env");
  return existsSync(live) ? live : null;
}

function readPgHost(envPath) {
  if (!envPath) return null;
  try {
    const text = readFileSync(envPath, "utf8");
    const m = text.match(/^\s*AGENT_RELAY_PG_HOST\s*=\s*"?([^"\r\n#]+)"?/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// ── up ───────────────────────────────────────────────────────────────────────

function up() {
  if (has("--fresh") && existsSync(SANDBOX)) {
    info(dim(`Removing existing sandbox at ${SANDBOX}`));
    rmSync(SANDBOX, { recursive: true, force: true });
  }
  mkdirSync(DATA_DIR, { recursive: true });

  info(`\n${bold("Sandbox")}  ${SANDBOX}`);
  info(`${bold("Core")}     ${CORE_REPO}  ${dim(capture("git", ["-C", CORE_REPO, "rev-parse", "--abbrev-ref", "HEAD"]) ?? "")}\n`);

  info(dim("→ installing core"));
  if (!run(process.execPath, [join(CORE_REPO, "scripts", "install.mjs")], { env: sandboxEnv(), stdio: "pipe" })) {
    die("core install failed — re-run without `stdio: pipe` to see why, or run scripts/install.mjs directly.");
  }
  info(`${green("✓")} core installed from this checkout`);

  const roles = findLocalCheckout("agent-relay-experimental-plugin");
  const rolesSpec = roles ? roles.path : "joniba/agent-relay-experimental-plugin";
  const rolesRef = roles ? null : value("--roles-ref") ?? "feature/session-roles";
  info(dim(`→ installing roles plugin from ${roles ? `${roles.path} (${roles.branch})` : `GitHub @ ${rolesRef}`}`));
  const rolesArgs = [join(CORE_REPO, "scripts", "install.mjs"), "--add-plugin", rolesSpec];
  if (rolesRef) rolesArgs.push("--ref", rolesRef);
  if (!run(process.execPath, rolesArgs, { env: sandboxEnv(), stdio: "pipe" })) {
    die(`roles plugin install failed (source: ${rolesSpec}).`);
  }
  info(`${green("✓")} roles plugin installed`);

  if (has("--pg")) installPg();

  info(`\n${bold("Next:")}  node scripts/sandbox.mjs launch      ${dim("(repeat in another tab for a second session)")}\n`);
}

function installPg() {
  const envPath = findPgEnv();
  const host = readPgHost(envPath);
  const isLocal = host && /^(localhost|127\.0\.0\.1|::1)$/i.test(host);

  info("");
  if (!envPath) {
    info(yellow("! no pg .env found — install it, then create one (see the pg plugin README)"));
  } else if (!isLocal) {
    info(yellow(`! ${bold("This will run schema migration 2 against a SHARED database")} (${host || "unknown host"}).`));
    info(yellow("  Sessions already running elsewhere keep working, but any FRESH session on a"));
    info(yellow("  machine still using an older pg build will refuse to start until it is upgraded."));
    if (!has("--yes-migrate")) {
      die("Refusing by default. Re-run with --yes-migrate, or point at a throwaway database:\n" +
          "    node scripts/sandbox.mjs up --pg --pg-env <path-to-a-local-.env>\n" +
          "  A local server needs no Docker — see `sandbox.mjs help`.");
    }
  }

  const pg = findLocalCheckout("agent-relay-pg-plugin");
  const spec = pg ? pg.path : "joniba/agent-relay-pg-plugin";
  info(dim(`→ installing pg plugin from ${pg ? `${pg.path} (${pg.branch})` : "GitHub"}`));
  const args = [join(CORE_REPO, "scripts", "install.mjs"), "--add-plugin", spec];
  if (!pg) args.push("--ref", value("--pg-ref") ?? "feature/registry-attributes");
  if (!run(process.execPath, args, { env: sandboxEnv(), stdio: "pipe" })) die("pg plugin install failed.");
  info(`${green("✓")} pg plugin installed`);
  if (envPath) info(`${green("✓")} will read settings from ${envPath} ${dim("(pointed at, not copied)")}`);
}

// ── launch ───────────────────────────────────────────────────────────────────

function launch() {
  if (!existsSync(EXT_DIR)) die("No sandbox yet — run `node scripts/sandbox.mjs up` first.");

  const name = value("--name") ?? pickName();
  const env = sandboxEnv();
  env.AGENT_RELAY_NAME = name;
  const pgEnv = findPgEnv();
  if (pgEnv && existsSync(join(PLUGINS_DIR, "agent-relay-pg"))) env.AGENT_RELAY_ENV_FILE = pgEnv;

  // Everything after the command word goes to the CLI, minus the flags we consume.
  const rest = argv.slice(argv.indexOf(COMMAND) + 1);
  const passthrough = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--name") { i++; continue; }
    passthrough.push(rest[i]);
  }

  info(`\n${bold("Launching")} ${green(name)} ${dim(`on the sandbox mesh (${SANDBOX})`)}\n`);
  // shell:false — on Windows a shell re-parses the argv and destroys the quoting of
  // anything containing spaces, which is every -p prompt.
  const res = spawnSync(process.platform === "win32" ? "copilot.exe" : "copilot",
    ["--experimental", ...passthrough], { stdio: "inherit", env, shell: false });
  if (res.error) {
    die(`could not run the Copilot CLI (${res.error.message}). Is \`copilot\` on your PATH?`);
  }
  process.exit(res.status ?? 0);
}

// ── status / down / help ─────────────────────────────────────────────────────

function status() {
  info(`\n${bold("Sandbox")}  ${SANDBOX}`);
  if (!existsSync(EXT_DIR)) {
    info(`${dim("not built —")} node scripts/sandbox.mjs up\n`);
    return;
  }
  const plugins = existsSync(PLUGINS_DIR)
    ? readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  info(`${bold("Plugins")}  ${plugins.length ? plugins.join(", ") : dim("none")}`);
  const live = sandboxAgents();
  info(`${bold("Live")}     ${live.length ? live.join(", ") : dim("no sessions")}`);
  info(`${bold("Log")}      ${join(DATA_DIR, "logs", "agent-relay.log")}\n`);
}

function down() {
  if (!existsSync(SANDBOX)) return info(`\n${dim("Nothing to remove.")}\n`);
  const live = sandboxAgents();
  if (live.length && !has("--force")) {
    die(`${live.length} sandbox session(s) still live (${live.join(", ")}). Close them, or pass --force.`);
  }
  rmSync(SANDBOX, { recursive: true, force: true });
  info(`\n${green("✓")} removed ${SANDBOX}\n`);
}

function help() {
  info(`
${bold("agent-relay sandbox")} — a disposable install for testing a feature end to end.

  ${green("up")}        build it: core from this checkout, plus the roles plugin
              ${dim("--pg")}            also install the pg plugin (see the warning it prints)
              ${dim("--pg-env <path>")} settings file for it (default: your installed pg plugin's)
              ${dim("--fresh")}         delete and rebuild from scratch
  ${green("launch")}    open a Copilot session on it ${dim("(--name <alias>, else auto)")}
  ${green("status")}    what is installed, and who is live
  ${green("down")}      delete it ${dim("(--force if sessions are still up)")}

${bold("Why this exists.")} Two variables isolate a session, and setting only the first
silently joins your LIVE mesh instead:

  COPILOT_HOME=${dim("<sandbox>/home")}          which extension loads
  AGENT_RELAY_DATA_DIR=${dim("<sandbox>/data")}  which mesh it joins

${bold("Plugin sources are looked up, not asked for.")} A sibling checkout of a plugin repo
is installed directly — including a worktree on a feature branch, preferred over one on
main — because ${dim("--add-plugin")} accepts a local path. Nothing needs pushing first.
Committed state is what gets installed, so commit before re-running ${green("up")}.

${bold("A local Postgres, without Docker.")} The pg plugin's integration suite and this
sandbox both just need ${bold("a")} server. If Docker is unavailable:

  ${dim("npm i embedded-postgres")}   # ships a real PostgreSQL binary, no daemon
  ${dim("# then point --pg-env at a .env with AGENT_RELAY_PG_HOST=localhost")}

An in-process engine such as PGlite is NOT enough — it accepts a single connection,
while the transport pools several and the suite exercises advisory locks.
`);
}

switch (COMMAND) {
  case "up": up(); break;
  case "launch": case "run": launch(); break;
  case "status": status(); break;
  case "down": down(); break;
  default: help();
}

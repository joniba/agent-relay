# agent-relay

> Minimal, unopinionated cross-session messaging for the GitHub Copilot CLI. One
> running session can send a message to another and **wake it into a turn** — no
> human at the keyboard — using the first-party `session.send()` SDK primitive.

A tiny core plus five pluggable seams (**Transport**, **Identity**, **Credentials**,
**Interceptor**, **Sink**). It ships with single-machine defaults (local SQLite + polling) and
**no** built-in safety/guardrails — those are opt-in interceptors you add later.

## Requirements

- **GitHub Copilot CLI** started with `--experimental` (extensions are gated behind it).
- **Node.js 22.5+** (the default transport uses the built-in `node:sqlite`, unflagged since 22.5.0).

## Install

**Quickest — one command, no clone:**

```bash
npx --yes github:joniba/agent-relay
```

It copies the extension into `<COPILOT_HOME>/extensions/agent-relay/` (default `~/.copilot/`), points
Copilot's statusline at agent-relay (replacing any existing one, unless `--no-statusline` is passed), and
verifies the entry. It does **not** launch Copilot. Core is **local-only and
dependency-free** (built-in `node:sqlite`) — there is nothing to `npm install`.

**From a local clone** (contributors, or to install a checked-out version):

```bash
git clone https://github.com/joniba/agent-relay.git
cd agent-relay
node scripts/install.mjs            # same installer; pass --no-statusline to skip the statusline wiring
```

**Upgrading:** re-run the same command — with `npx` that fetches the current GitHub version; from a clone,
update or switch your checkout first, then re-run `node scripts/install.mjs`. The copy is a non-purging
delta-copy — it refreshes the code in place and **never deletes** your runtime DB (`*.db*`) or any installed
plugins (`plugins/<name>/`), so you can upgrade **while sessions are running**.

**Uninstalling** (no manual file deletion needed):

```bash
npx --yes github:joniba/agent-relay --uninstall            # remove the extension + agent-relay statusline wiring; KEEPS the runtime DB + logs
npx --yes github:joniba/agent-relay --uninstall --purge    # the above, and also delete the runtime DB + logs
```

**Cross-machine messaging** is a separate drop-in plugin; installing it brings core along:

```bash
npx --yes github:joniba/agent-relay-pg-plugin
```

<details>
<summary>Manual install (no script)</summary>

Copy the extension into `<COPILOT_HOME>/extensions/agent-relay/` (or `~/.copilot/extensions/agent-relay/`
if `COPILOT_HOME` is unset) so the entry lives at `…/agent-relay/extension.mjs`:

```powershell
$dest = "$env:USERPROFILE\.copilot\extensions\agent-relay"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse -Force .\extension\* $dest
```
</details>

Then start Copilot with extensions enabled:

```powershell
copilot --experimental
```

On load you'll see a terminal line like `🌐 agent-relay: connected to local transport as [<alias>]`,
and the `send_message` / `list_relay_agents` tools become available.

## Identity (who you are in the mesh)

Each session registers under a **name** (how peers address it) and a stable **id**
(its Copilot session id). By default the name is a short, friendly **alias**
(e.g. `stone`, `gull`) derived deterministically from the session id — instant,
offline, no network. If two live sessions would land on the same word, the registry
resolves the collision automatically (each session walks an ordered list of candidates
and takes the first one not held by another active session). Override it:

```powershell
$env:AGENT_RELAY_NAME = "tia"      # this session is addressable as "tia"
copilot --experimental
```

The alias also renders below your prompt as `[stone]` via the Copilot **statusline**
(wired up by the installer; pass `--no-statusline` to skip).

## Usage

From inside a session:

- **`list_relay_agents`** — see who's reachable.
- **`send_message(to, content)`** — message another session by name or id; it wakes and
  may reply with `send_message` back to you. Replies arrive automatically as new turns —
  no polling.

Example prompt: *"Use list_relay_agents, then send_message to bob asking for the build status."*

## Configuration

The single wiring file is `extension/config.mjs` (the composition root). Environment
overrides for the defaults:

| Variable | Effect | Default |
|---|---|---|
| `AGENT_RELAY_NAME` | This session's mesh name | wordlist alias from session id |
| `AGENT_RELAY_DB`   | Path to the local SQLite store | `agent-relay.db` in the data dir (below) |
| `AGENT_RELAY_DATA_DIR` | Directory for local state + rolling diagnostic logs | per-user OS data dir (e.g. `%LOCALAPPDATA%\agent-relay`) |
| `AGENT_RELAY_PLUGINS` | Comma-separated plugin module paths to load (a dev convenience) | — |
| `AGENT_RELAY_PLUGIN_DIR` | Folder scanned for drop-in plugins | the extension's own `plugins/` folder |

> All local-mode sessions that use the same SQLite store — the same default data dir, or the same
> explicit `AGENT_RELAY_DB` — form one mesh.

> **No `.env` file:** core reads these directly from the environment — it does **not** auto-load a
> `.env`. Export the ones you want before launching Copilot (see `.env.example` for the list). Cross-machine
> / Postgres settings live with the [agent-relay-pg-plugin](https://github.com/joniba/agent-relay-pg-plugin),
> not here.

> **Data & logs:** the local SQLite store and a **rolling diagnostic log** live in a per-user data
> directory — `%LOCALAPPDATA%\agent-relay\` (Windows), `~/Library/Application Support/agent-relay/`
> (macOS), or `$XDG_DATA_HOME/agent-relay` (Linux; `~/.local/share/agent-relay` when unset) —
> **outside** the install dir, so upgrades never
> touch your state. Override with `AGENT_RELAY_DATA_DIR`. The log is `logs/agent-relay.log`, rotated
> when it passes 24h old, keeping the current file plus 3 older ones. (An existing in-install
> `agent-relay.db` from an older version is migrated into the data dir automatically on first run.)

## Cross-machine messaging

The default mesh is **single-machine** (local SQLite). To wake sessions across **different machines**,
install the **[agent-relay-pg-plugin](https://github.com/joniba/agent-relay-pg-plugin)** — a drop-in
plugin that swaps the local SQLite transport for a shared **Postgres** mesh (each machine mints its own
short-lived Microsoft Entra token locally; tokens are never copied between machines) and adds machine
provenance to the wake prompt and the `list_relay_agents` roster. It installs core alongside it:

```bash
npx --yes github:joniba/agent-relay-pg-plugin
```

See that repo's README for provisioning, configuration, the security model, and teardown.

## Extending (the seams)

Swap any adapter by editing **only** `config.mjs` (or, for the Sink, the entry) — the core never
changes (OCP):

- **Transport** (`extension/seams/transport.mjs`) — storage + delivery. Default:
  `transports/sqlite-poll.mjs` (single-machine, local SQLite). A **cross-machine** transport (shared
  Postgres) is provided by the
  [agent-relay-pg-plugin](https://github.com/joniba/agent-relay-pg-plugin), not core.
- **Identity** (`seams/identity.mjs`) — how a session is named. Default: `identity/local-alias.mjs`.
- **Credentials** (`seams/credentials.mjs`) — auth material a transport needs. Default:
  `credentials/none.mjs` (the local default needs none). A real credential provider — e.g. the Azure
  Entra token provider for cross-machine Postgres — ships with the agent-relay-pg-plugin.
- **Interceptor** (`seams/interceptor.mjs`) — middleware on send/receive and the wake
  prompt. The core ships **none**; this is where guardrails (authority, rate-limit,
  loop/hop guards, content filters) go. You can add interceptors **without editing this
  repo** — drop in an external module via the plugin loader (see *External plugins*
  below).
- **Sink** (`seams/sink.mjs`) — *which agent runtime a delivered message wakes.* Default:
  `sinks/copilot.mjs` (wakes a Copilot CLI session via `session.send()`). The core is **not** locked
  to interactive Copilot user-sessions — an **ACP-managed session** (or any runtime) is a drop-in
  `sinks/<runtime>.mjs` paired with a matching entry, with no core change.

### External plugins

A plugin loads **your own modules** at startup and can supply any of four seams — interceptors (guardrails /
middleware), the transport, credentials, or identity (the Sink is wired in the entry, not via plugins) — so a capability can live in a separate,
even **private**, repo or a local folder, never in this one. Two sources, loaded in order (env entries
first, then the directory, alphabetically):

| Source | How |
|---|---|
| **Env-var pointer** | `AGENT_RELAY_PLUGINS` = a **comma-separated** list of module paths (**absolute recommended** — a session's cwd isn't obvious; relative is resolved against it), loaded in listed order. A secondary dev convenience. |
| **Plugin directory** | every top-level `*.mjs` **and** every package subfolder (`<name>/` with a `package.json`, which may carry its own `node_modules`) in `AGENT_RELAY_PLUGIN_DIR` — default the extension's **own** `plugins/` folder (next to `extension.mjs`), so an installed plugin survives core upgrades. |

**Contract** — a plugin module **default-exports a factory** (it may be `async`) that returns a
**Registration** declaring any subset of: `interceptors` (an array — every plugin's aggregate, in load
order), `transport`, `credentials`, `identity` (each single-instance, last-loaded wins). The common
case — one interceptor:

```js
// my-plugin.mjs
export default function createPlugin(ctx) {
  // ctx = { env, dataDir, log }   — no `self`; identity isn't resolved yet.
  //   env     — process.env (read your own config vars)
  //   dataDir — the per-user data dir (string, or null) for any plugin state
  //   log     — log(message[, { level: "warning" | "error" }]) → the diagnostic log
  return {
    interceptors: [{
      // Gate/transform inbound: call next(msg) to pass it on, or return WITHOUT
      // calling next to drop it. (To reject a message, DROP it — don't throw.)
      onReceive(message, next) { return next(message); },
      // Optional: shape the wake prompt; return null to defer to the default.
      renderPrompt(message) { return null; },
      // Optional: onSend(message, next)
    }],
    // transport:   { id, create(ctx) { /* ... */ } },  // optional — see agent-relay-pg-plugin
    // credentials: () => ({ get() { /* ... */ } }),     // optional
    // identity:    { resolve(session) { /* ... */ } },  // optional
  };
}
```

- **Trusted, not sandboxed.** Loaded modules are **your own code** — only ever the modules you point at
  via the env var / plugin dir. The loader fetches nothing and never loads anything derived from message
  content.
- **Fail-loud + all-or-nothing.** A plugin that fails to import, isn't a factory, returns an invalid
  registration, or declares any invalid capability makes startup **stop with a clear error naming the
  plugin** — the extension reports **inactive** (`send_message` / `list_relay_agents` say it didn't start)
  rather than silently running degraded. A plugin is folded in only after its WHOLE registration
  validates. (A plugin that *hangs* is out of scope — it's trusted code.)
- **Opt-in.** With no `AGENT_RELAY_PLUGINS` paths **and** no plugins in the directory, nothing loads —
  behaviour is exactly the dependency-free local default.

**Verify it loaded.** On startup each plugin logs `plugin loaded: <name>` to the rolling diagnostic log at
`<data-dir>/logs/agent-relay.log`; a failing one makes the extension fail to start with the error above
(naming the plugin). On Windows `<data-dir>` defaults to `%LOCALAPPDATA%\agent-relay` (see *Configuration*).

## License

MIT. The cross-session wake mechanism is inspired by
[htekdev/agent-mesh](https://github.com/htekdev/agent-mesh) (also MIT); agent-relay is an
independent reimplementation built around pluggable seams.

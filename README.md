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

Clone the repo and run the install script — it **copies** `extension/` (and its `node_modules`, if
present) into `~/.copilot/extensions/agent-relay/` and verifies the entry. It does **not** launch
Copilot.

> **Dependencies are opt-in.** The single-machine default uses Node's built-in SQLite and needs
> **no packages** — just clone and install. Only the **cross-machine** transport needs `pg` plus the
> Azure credential lib (`@azure/identity`), both loaded lazily. The PowerShell **cross-machine setup
> below runs `npm install` for you**; you only need to run it yourself for the bash installer or a
> manual install. (See *Cross-machine messaging* for the one-command setup.)

```powershell
# Windows / PowerShell
git clone https://github.com/joniba/agent-relay.git
cd agent-relay
# npm install        # ONLY for cross-machine (fetches pg + Azure cred deps) — skip for local-only
pwsh scripts/install.ps1                        # self-contained copy into ~/.copilot/extensions
#   ...-Link   dev junction to this clone instead (updates via `git pull`)
```

```bash
# macOS / Linux
git clone https://github.com/joniba/agent-relay.git
cd agent-relay
# npm install        # ONLY for cross-machine (fetches pg + Azure cred deps) — skip for local-only
scripts/install.sh                             # self-contained copy into ~/.copilot/extensions
#   --link   dev symlink to this clone instead (updates via `git pull`)
```

**Upgrading:** `git pull` then re-run the install script. The copy refreshes the code in place and
**preserves your runtime DB** (`*.db*` is never touched), so you can upgrade **while sessions are
running** — no need to close anything.

<details>
<summary>Manual install (no script)</summary>

Copy the extension so the entry lives at `~/.copilot/extensions/agent-relay/extension.mjs`:

```powershell
$dest = "$env:USERPROFILE\.copilot\extensions\agent-relay"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse -Force .\extension\* $dest
# Cross-machine only: also copy node_modules so `pg` resolves at the destination
# Copy-Item -Recurse -Force .\node_modules $dest\node_modules
```
</details>

Then start Copilot with extensions enabled:

```powershell
copilot --experimental
```

On load you'll see a timeline entry like `agent-relay: registered as "<name>" — ready`,
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
(wired up by `scripts/install.ps1` / `scripts/install.sh`; pass `-NoStatusline` /
`--no-statusline` to skip).

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
| `AGENT_RELAY_TRANSPORT` | `postgres` to join a cross-machine mesh (see below) | local SQLite |
| `AGENT_RELAY_PG_HOST` / `_USER` / `_DB` | Shared Postgres connection settings (non-secret) | — |
| `AGENT_RELAY_AZURE_TENANT` | Entra tenant id for the DB token (multi-tenant / MFA accounts) | `az` default context |
| `AGENT_RELAY_HOST` | Device name shown beside each peer in the roster | the machine's hostname |
| `AGENT_RELAY_DEBUG` | `1`/`true`/`yes`/`on` → log every periodic sweep (cross-machine); errors always shown | silent |
| `AGENT_RELAY_ENV_FILE` | Explicit path to a `.env` to load | `extension/.env`, then repo-root `.env` |

> All local-mode sessions that use the same SQLite store — the same default data dir, or the same
> explicit `AGENT_RELAY_DB` — form one mesh.

> **`.env` support:** any of these may be set in a gitignored `.env` (auto-loaded from
> `extension/.env`, the repo root, or `$AGENT_RELAY_ENV_FILE`) instead of being exported — handy for
> the cross-machine settings below. Shell-exported values take precedence. Copy `.env.example` to
> start.

> **Data & logs:** the local SQLite store and a **rolling diagnostic log** live in a per-user data
> directory — `%LOCALAPPDATA%\agent-relay\` (Windows), `~/Library/Application Support/agent-relay/`
> (macOS), or `$XDG_DATA_HOME/agent-relay` (Linux; `~/.local/share/agent-relay` when unset) —
> **outside** the install dir, so upgrades never
> touch your state. Override with `AGENT_RELAY_DATA_DIR`. The log is `logs/agent-relay.log`, rotated
> when it passes 24h old, keeping the current file plus 3 older ones. (An existing in-install
> `agent-relay.db` from an older version is migrated into the data dir automatically on first run.)

## Cross-machine messaging (Azure Postgres)

The default mesh is **single-machine** (local SQLite). To message and **wake sessions across
machines**, point them at a shared PostgreSQL database. agent-relay ships a vendor-neutral
Postgres transport plus an isolated Azure credential lib; on Azure the security boundary is a
**Microsoft Entra token + TLS** — there is no password, and no IP allowlist.

**Prerequisites:** the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) and
`pwsh`, an Azure subscription, and permission to create a resource group + a PostgreSQL Flexible
Server. If you have more than one subscription, select it first with
`az account set --subscription <id-or-name>`.

### 1. Provision once (per environment)

Creates an Azure Database for PostgreSQL Flexible Server with Entra-only auth and TLS enforced.
Idempotent — safe to re-run.

```powershell
az login                                       # an account with a subscription
pwsh scripts/provision-azure.ps1 -ServerName pg-agent-relay-<unique>
```

The `-ServerName` must be **globally unique and lowercase** (it becomes the public
`<name>.postgres.database.azure.com` DNS label).

It prints the **non-secret** settings to export (host / user / database). It never creates or
prints a password — there isn't one.

> **Cost:** a rough compute estimate for the default Burstable **B1ms** SKU is ~$12–15/month
> (excludes storage/backup and varies by region/currency — check the
> [Azure pricing](https://azure.microsoft.com/pricing/details/postgresql/flexible-server/) for
> exact figures). Tear it down when you're done (see below). **Region:** defaults to
> `israelcentral`; override with `-Location`.

### 2. Enable cross-machine on each machine

On every machine that should join the **same** mesh, do **one** thing — drop in a `.env`, then run
the installer. It detects cross-machine and does the rest.

**Create `extension/.env` in the clone** with the four (non-secret) values from step 1 — quote any
value containing `#` (start from `.env.example`):

```ini
# extension/.env  — copied into the install; the extension auto-loads it at startup
AGENT_RELAY_TRANSPORT=postgres
AGENT_RELAY_PG_HOST=pg-agent-relay-<unique>.postgres.database.azure.com
AGENT_RELAY_PG_USER="<your-entra-admin-upn>"
AGENT_RELAY_PG_DB=agentrelay
# AGENT_RELAY_AZURE_TENANT=<tenant-id>       # set if your account spans multiple tenants or the DB tenant needs MFA
# AZURE_CONFIG_DIR=C:\path\to\.azure-relay   # optional: isolate the az profile used for the token
```

**Then run the installer:**

```powershell
pwsh scripts/install.ps1        # auto-detects cross-machine from the .env
```

Because the `.env` selects Postgres, the installer runs a **setup preflight** and does everything
for you, stopping with a specific message if anything's wrong:

1. checks the **Azure CLI** is installed,
2. validates the `.env` has `AGENT_RELAY_PG_HOST` / `_USER` / `_DB`,
3. runs **`npm install`** (fetches `pg` + `@azure/identity`) and bundles them into the install,
4. **signs you in** — if you're not authenticated it launches **`az login`** (sign in as the DB
   admin, targeting `AGENT_RELAY_AZURE_TENANT` if set). If it fails on a headless machine, run it
   yourself with `--use-device-code` (and `--tenant <id>` if `AGENT_RELAY_AZURE_TENANT` is set), then
   re-run,
5. **verifies a real connection** to the shared database end-to-end.

If verification fails, the message tells you exactly what to fix — e.g. *wrong account/tenant* (“sign
in as the DB admin”), *unreachable host*, or *not signed in* — then re-run. Because you explicitly
selected the cross-machine transport, a session that still can't connect **does not silently fall back
to the local mesh** (that would split your machines onto separate, single-machine stores without
telling you): it retries the connect a few times and then runs **inactive** — `send_message` /
`list_relay_agents` report it's not started — until you fix connectivity **and restart**, or unset
`AGENT_RELAY_TRANSPORT` and restart to use the local mesh.

> **Multi-tenant / MFA:** if your `az` account belongs to more than one Entra tenant, or the
> database's tenant enforces MFA, a plain `az login` can fail enumerating tenants (`AADSTS50076`,
> “no subscriptions found”). Set **`AGENT_RELAY_AZURE_TENANT`** to the database's tenant id — the
> installer then signs in and acquires the token against that tenant directly. (Find the id with
> `az account show --query tenantId -o tsv` while signed into that tenant, or from the Azure portal.)

> Each machine mints its **own** short-lived Entra token locally via its own `az login` — **tokens
> are never copied between machines**. The four `.env` values are not secrets (a hostname, a
> username, a database name). With the default provisioning there's exactly one DB admin, so every
> machine must `az login` as **that same account** (`AGENT_RELAY_PG_USER`); a token for any other
> account authenticates to Azure but is rejected by the database.

<details><summary>Plain shell exports instead of a <code>.env</code></summary>

Export the four values in your shell (these **win** over a `.env` if both are set), then run the
installer — it still does the deps + `az login` + verification for you:

```powershell
$env:AGENT_RELAY_TRANSPORT = 'postgres'
$env:AGENT_RELAY_PG_HOST   = 'pg-agent-relay-<unique>.postgres.database.azure.com'
$env:AGENT_RELAY_PG_USER   = '<your-entra-admin-upn>'
$env:AGENT_RELAY_PG_DB     = 'agentrelay'
# $env:AZURE_CONFIG_DIR    = '<dir>'   # optional: isolate the az profile
pwsh scripts/install.ps1 -CrossMachine
```
</details>

### 3. Run

```powershell
copilot --experimental
```

Sessions on any machine with those settings (in `.env` or the environment) join one cross-machine
mesh. `list_relay_agents`
shows everyone, each tagged with its **device name** (the machine's hostname; override with
`AGENT_RELAY_HOST`) so you can tell hosts apart — it's display-only, never used for addressing.

### Resilience

If the database can't be reached **at startup** (offline, not yet `az login`'d, an unsupported
newer schema, …), the session **retries the connect a few times**; if it still can't connect it runs
**inactive** for that session and does **not** silently fall back to the local single-machine mesh
(that would split your machines onto separate stores without telling you). Fix connectivity and
**restart**, or unset `AGENT_RELAY_TRANSPORT` and restart to use the local mesh. A transient
mid-session blip is ridden out by the poll loop (the session stays up, no fallback). A session-owned,
advisory-lock-guarded sweep prunes old messages (> 24 h) and long-gone peers (> 7 d), so no always-on
cleanup job is required.

### Security model

- **Microsoft Entra token + TLS** is the entire boundary. Password auth is disabled on the server;
  only a valid token for a server admin can connect.
- **No IP allowlist** — home/office egress IPs rotate, so network location is not a control.
  Public network access stays on, gated by authentication.
- Tokens are minted locally per machine and **never stored or transferred**.

### Teardown

```powershell
az group delete --name rg-agent-relay --yes        # removes the server + database
```

(Replace `rg-agent-relay` if you provisioned with a custom `-ResourceGroup`.)

See [`extension/azure/README.md`](extension/azure/README.md) for the credential-lib internals and
how to lift the Azure code into its own package (the core and transport never change).

## Extending (the seams)

Swap any adapter by editing **only** `config.mjs` (or, for the Sink, the entry) — the core never
changes (OCP):

- **Transport** (`extension/seams/transport.mjs`) — storage + delivery. Default:
  `transports/sqlite-poll.mjs` (single-machine). For **cross-machine** messaging it ships
  `transports/postgres.mjs` (vendor-neutral `pg`; shared DB + poll), selected with
  `AGENT_RELAY_TRANSPORT=postgres` — see *Cross-machine messaging* above.
- **Identity** (`seams/identity.mjs`) — how a session is named. Default: `identity/local-alias.mjs`.
- **Credentials** (`seams/credentials.mjs`) — auth material a remote transport needs.
  Default: `credentials/none.mjs`. For Postgres: `credentials/env-password.mjs` (a plain
  password from the env, for local Docker / CI) or the Azure Entra token provider in
  `extension/azure/` (the cross-machine path; password auth disabled server-side).
- **Interceptor** (`seams/interceptor.mjs`) — middleware on send/receive and the wake
  prompt. The core ships **none**; this is where guardrails (authority, rate-limit,
  loop/hop guards, content filters) go. You can add interceptors **without editing this
  repo** — drop in an external module via the plugin loader (see *External interceptors*
  below).
- **Sink** (`seams/sink.mjs`) — *which agent runtime a delivered message wakes.* Default:
  `sinks/copilot.mjs` (wakes a Copilot CLI session via `session.send()`). The core is **not** locked
  to interactive Copilot user-sessions — an **ACP-managed session** (or any runtime) is a drop-in
  `sinks/<runtime>.mjs` paired with a matching entry, with no core change.

### External interceptors (plugins)

Interceptors can be loaded from **your own modules** at startup — so a guardrail (or any
middleware) lives in a separate, even **private**, repo or a local folder, never in this
one. Two sources, loaded in order (env entries first, then the directory, alphabetically):

| Source | How |
|---|---|
| **Env-var pointer** | `AGENT_RELAY_INTERCEPTORS` = a **comma-separated** list of module paths (**absolute recommended** — a session's cwd isn't obvious; relative is resolved against it), loaded in listed order. |
| **Plugin directory** | every top-level `*.mjs` in `AGENT_RELAY_PLUGIN_DIR` (default `<data-dir>/plugins`, alongside the DB + logs, so it survives reinstalls). |

**Contract** — a plugin module **default-exports a factory** (it may be `async`) that
returns an interceptor (any subset of the seam's `onSend` / `onReceive` / `renderPrompt`):

```js
// my-interceptor.mjs
export default function createInterceptor(ctx) {
  // ctx = { env, dataDir, log }   — no `self`; identity isn't resolved yet.
  //   env     — process.env (read your own config vars)
  //   dataDir — the per-user data dir (string, or null) for any plugin state
  //   log     — log(message[, { level: "warning" | "error" }]) → the diagnostic log
  // ctx.log("my-guardrail ready");   // optional: announce yourself
  return {
    // Gate/transform inbound: call next(msg) to pass it on, or return WITHOUT
    // calling next to drop it. (To reject a message, DROP it — don't throw.)
    onReceive(message, next) { return next(message); },
    // Optional: shape the wake prompt; return null to defer to the default.
    renderPrompt(message) { return null; },
    // Optional: onSend(message, next)
  };
}
```

- **Trusted, not sandboxed.** Loaded modules are **your own code** — only ever the modules
  you point at via the env var / plugin dir. The loader fetches nothing and never loads
  anything derived from message content.
- **Load-time safe-degrade.** A plugin that fails to import, isn't a factory, or returns no
  usable hook is **skipped and logged** — it never blocks startup. (A plugin that *hangs*
  is out of scope; it's trusted code. Once loaded, a plugin's *runtime* hook behaviour
  follows the Interceptor seam — to reject a message, **drop it, don't throw**.)
- **Opt-in.** With no `AGENT_RELAY_INTERCEPTORS` paths **and** no `*.mjs` in the plugin
  directory, nothing loads — behaviour is exactly as before.

**Verify it loaded.** On startup each plugin logs `plugin loaded: <name>` (plus an
`external interceptors active: <count>` summary) to the rolling diagnostic log at
`<data-dir>/logs/agent-relay.log`; a rejected one logs `plugin skipped: <name> (<reason>)`.
On Windows `<data-dir>` defaults to `%LOCALAPPDATA%\agent-relay` (see *Configuration*).

## License

MIT. The cross-session wake mechanism is inspired by
[htekdev/agent-mesh](https://github.com/htekdev/agent-mesh) (also MIT); agent-relay is an
independent reimplementation built around pluggable seams.

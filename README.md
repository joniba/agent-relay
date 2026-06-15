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

Clone the repo, **install its dependencies**, then run the install script — it links (or copies)
`extension/` into `~/.copilot/extensions/agent-relay/` and verifies the entry. It does **not**
launch Copilot.

> The entry imports `pg` (and lazily `@azure/identity` for the cross-machine path), so
> `npm install` is required even for the single-machine default. The **junction** install (below)
> resolves these from the clone's `node_modules`; with `-Copy`/`--copy` you must also make the
> dependencies resolvable at the destination (e.g. copy `node_modules` too, or prefer the junction).

```powershell
# Windows / PowerShell
git clone https://github.com/joniba/agent-relay.git
cd agent-relay; npm install                    # runtime deps: pg, @azure/identity
pwsh scripts/install.ps1                        # junction (a later `git pull` updates it live)
#   ...-Copy   to copy instead of link
#   ...-Force  to replace an existing install
```

```bash
# macOS / Linux
git clone https://github.com/joniba/agent-relay.git
cd agent-relay && npm install                  # runtime deps: pg, @azure/identity
scripts/install.sh                             # symlink (a later `git pull` updates it live)
#   --copy / --force  as above
```

<details>
<summary>Manual install (no script)</summary>

Copy the extension so the entry lives at `~/.copilot/extensions/agent-relay/extension.mjs`:

```powershell
$dest = "$env:USERPROFILE\.copilot\extensions\agent-relay"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse -Force .\extension\* $dest
```

Run `npm install` in the clone first, and note the same dependency caveat as `-Copy`: a plain copy
won't resolve `pg`/`@azure/identity` unless they're reachable from `$dest` — prefer linking the
extension from the clone (the install script's default junction/symlink) after `npm install`.
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
| `AGENT_RELAY_DB`   | Path to the shared SQLite store | `agent-relay.db` beside the extension |
| `AGENT_RELAY_TRANSPORT` | `postgres` to join a cross-machine mesh (see below) | local SQLite |
| `AGENT_RELAY_PG_HOST` / `_USER` / `_DB` | Shared Postgres connection settings (non-secret) | — |
| `AGENT_RELAY_HOST` | Device name shown beside each peer in the roster | the machine's hostname |
| `AGENT_RELAY_ENV_FILE` | Explicit path to a `.env` to load | `extension/.env`, then repo-root `.env` |

> All sessions that share an `AGENT_RELAY_DB` (or a single global install) form one mesh.

> **`.env` support:** any of these may be set in a gitignored `.env` (auto-loaded from
> `extension/.env`, the repo root, or `$AGENT_RELAY_ENV_FILE`) instead of being exported — handy for
> the cross-machine settings below. Shell-exported values take precedence. Copy `.env.example` to
> start.

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

### 2. Distribute the (non-secret) config to each machine

Every machine/session that should join the **same** mesh provides the **same** four values. The
tidiest way is a **gitignored `.env` file** in the project (so you don't re-export them in every
shell); copy the template and fill it in:

```powershell
cp .env.example extension/.env        # gitignored; auto-loaded at startup
```

```ini
# extension/.env  — quote any value containing '#' (e.g. the Entra guest UPN)
AGENT_RELAY_TRANSPORT=postgres
AGENT_RELAY_PG_HOST=pg-agent-relay-<unique>.postgres.database.azure.com
AGENT_RELAY_PG_USER="<your-entra-admin-upn>"
AGENT_RELAY_PG_DB=agentrelay
# AZURE_CONFIG_DIR=C:\path\to\.azure-relay   # mint the token as the DB admin
```

It's loaded automatically from `extension/.env` (or the repo root, or `$AGENT_RELAY_ENV_FILE`).
Anything you **also** export in the shell takes precedence, so you can still override ad-hoc.

<details><summary>Prefer plain shell exports instead?</summary>

```powershell
# PowerShell
$env:AGENT_RELAY_TRANSPORT = 'postgres'
$env:AGENT_RELAY_PG_HOST   = 'pg-agent-relay-<unique>.postgres.database.azure.com'
$env:AGENT_RELAY_PG_USER   = '<your-entra-admin-upn>'
$env:AGENT_RELAY_PG_DB     = 'agentrelay'
```

```bash
# bash / zsh
export AGENT_RELAY_TRANSPORT=postgres
export AGENT_RELAY_PG_HOST='pg-agent-relay-<unique>.postgres.database.azure.com'
export AGENT_RELAY_PG_USER='<your-entra-admin-upn>'
export AGENT_RELAY_PG_DB=agentrelay
```
</details>

These are **not secrets** — a hostname, a username, and a database name. The actual credential is
a short-lived Entra token each machine mints **locally** from its own `az login`; **tokens are
never copied between machines**. With the default provisioning script there is exactly one DB
admin, so **each machine must `az login` as the same Entra principal printed as
`AGENT_RELAY_PG_USER`** — a different account can still mint a token but will fail Postgres auth
(and the session then falls back to local SQLite for that run). Granting additional DB users is a
separate, manual step.

Sanity-check that a machine can **acquire a token** for the Postgres scope — **without printing the
token itself**. (This proves only token acquisition, not server reachability, the DB, TLS, or that
your identity matches `AGENT_RELAY_PG_USER` — a successful boot is the real end-to-end check.)

```powershell
az account get-access-token --scope https://ossrdbms-aad.database.windows.net/.default `
  --query "{token_ok: (accessToken != null), expires: expiresOn}" -o json
```

### 3. Run

```powershell
copilot --experimental
```

Sessions on any machine carrying those env vars join one cross-machine mesh. `list_relay_agents`
shows everyone, each tagged with its **device name** (the machine's hostname; override with
`AGENT_RELAY_HOST`) so you can tell hosts apart — it's display-only, never used for addressing.

### Resilience & fallback

If the database can't be reached **at startup** (offline, not yet `az login`'d, an unsupported
newer schema, …) the session **falls back to the local SQLite mesh** for that run and logs why —
it stays usable, just single-machine until the next start. A transient mid-session blip is ridden
out by the poll loop (no fallback). A session-owned, advisory-lock-guarded sweep prunes old
messages (> 24 h) and long-gone peers (> 7 d), so no always-on cleanup job is required.

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
  loop/hop guards, content filters) go.
- **Sink** (`seams/sink.mjs`) — *which agent runtime a delivered message wakes.* Default:
  `sinks/copilot.mjs` (wakes a Copilot CLI session via `session.send()`). The core is **not** locked
  to interactive Copilot user-sessions — an **ACP-managed session** (or any runtime) is a drop-in
  `sinks/<runtime>.mjs` paired with a matching entry, with no core change.

## License

MIT. The cross-session wake mechanism is inspired by
[htekdev/agent-mesh](https://github.com/htekdev/agent-mesh) (also MIT); agent-relay is an
independent reimplementation built around pluggable seams.

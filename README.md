# agent-relay

> Minimal, unopinionated cross-session messaging for the GitHub Copilot CLI. One
> running session can send a message to another and **wake it into a turn** — no
> human at the keyboard — using the first-party `session.send()` SDK primitive.

A tiny core plus four pluggable seams (**Transport**, **Identity**, **Credentials**,
**Interceptor**). It ships with single-machine defaults (local SQLite + polling) and
**no** built-in safety/guardrails — those are opt-in interceptors you add later.

## Requirements

- **GitHub Copilot CLI** started with `--experimental` (extensions are gated behind it).
- **Node.js 22.5+** (the default transport uses the built-in `node:sqlite`, unflagged since 22.5.0).

## Install

Copy the extension into your Copilot extensions directory so the entry lives at
`~/.copilot/extensions/agent-relay/extension.mjs`:

```powershell
$dest = "$env:USERPROFILE\.copilot\extensions\agent-relay"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Recurse -Force .\extension\* $dest
```

Then start Copilot with extensions enabled:

```powershell
copilot --experimental
```

On load you'll see a timeline entry like `agent-relay: registered as "<name>" — ready`,
and the `send_message` / `list_relay_agents` tools become available.

## Identity (who you are in the mesh)

Each session registers under a **name** (how peers address it) and a stable **id**
(its Copilot session id). By default the name is the **launch-folder leaf**. Override it:

```powershell
$env:AGENT_RELAY_NAME = "tia"      # this session is addressable as "tia"
copilot --experimental
```

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
| `AGENT_RELAY_NAME` | This session's mesh name | launch-folder leaf |
| `AGENT_RELAY_DB`   | Path to the shared SQLite store | `agent-relay.db` beside the extension |

> All sessions that share an `AGENT_RELAY_DB` (or a single global install) form one mesh.

## Extending (the seams)

Swap any adapter by editing **only** `config.mjs` — the core never changes (OCP):

- **Transport** (`extension/seams/transport.mjs`) — storage + delivery. Default:
  `transports/sqlite-poll.mjs`. A cloud-store or push transport is a drop-in replacement
  (this is the path to cross-machine messaging).
- **Identity** (`seams/identity.mjs`) — how a session is named. Default: `identity/folder-name.mjs`.
- **Credentials** (`seams/credentials.mjs`) — auth material a remote transport needs.
  Default: `credentials/none.mjs`.
- **Interceptor** (`seams/interceptor.mjs`) — middleware on send/receive and the wake
  prompt. The core ships **none**; this is where guardrails (authority, rate-limit,
  loop/hop guards, content filters) go.

## License

MIT. The cross-session wake mechanism is inspired by
[htekdev/agent-mesh](https://github.com/htekdev/agent-mesh) (also MIT); agent-relay is an
independent reimplementation built around pluggable seams.

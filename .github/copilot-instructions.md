# agent-relay — repository instructions

## Local-only core (cross-machine lives in the pg-plugin)

agent-relay **core** is local-only and **dependency-free** — it uses Node's built-in
`node:sqlite`, so sessions on one machine wake each other via a local SQLite mesh. Core
reads configuration from the **process environment**; it does **not** load a `.env` file.

**Cross-machine messaging is a separate plugin.** The Postgres transport, Azure/Entra
credentials, provisioning, and all cross-machine `.env` handling live in the
[agent-relay-pg-plugin](https://github.com/joniba/agent-relay-pg-plugin) repo and install as
a drop-in plugin (`npx --yes github:joniba/agent-relay-pg-plugin`) — **not here**. Do not
add `pg`/`@azure` code or dependencies to this repo; core stays dependency-free.

Plugins load from the extension's own `plugins/` folder (or `AGENT_RELAY_PLUGIN_DIR` /
`AGENT_RELAY_PLUGINS`) — see the README's *External plugins* section. By default they live under the
installed extension (not in this repo), so there is no core `.env` or plugin file to copy into new
worktrees; if you deliberately point `AGENT_RELAY_PLUGIN_DIR` / `AGENT_RELAY_PLUGINS` at a worktree-local
path, keep that path valid.

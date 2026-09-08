# agent-relay — repository instructions

agent-relay is a **GitHub Copilot CLI extension** for cross-session messaging: one running session
can **wake another into a turn** via the first-party `session.send()` primitive, surfaced as the
`send_message` / `list_relay_agents` tools. A tiny core plus **five pluggable seams** — Transport,
Identity, Credentials, Interceptor, Sink. ESM only (`"type": "module"`, `.mjs`), **Node >= 22.5.0**;
runs only under `copilot --experimental`.

## The hard invariant: core stays local-only & dependency-free

Core uses Node's built-in `node:sqlite` for a single-machine SQLite wake mesh and has **zero runtime
dependencies**. **Do not add `pg` / `@azure` — or any — code or dependency here.** Cross-machine
messaging (the Postgres transport, Azure/Entra credentials, provisioning, and all cross-machine
`.env` handling) lives in the separate drop-in
[agent-relay-pg-plugin](https://github.com/joniba/agent-relay-pg-plugin); install it with
`… --add-plugin github:joniba/agent-relay-pg-plugin` — never fold it in here.

Core reads configuration **only from `process.env`** — it **never auto-loads a `.env`** (the
gitignored `.env*` files present are dev conveniences that nothing in core reads).

## Architecture — where things live

- **Entry / lifecycle host:** `extension/extension.mjs` (thin). Joins the session, sets up logging,
  awaits the composition root, bootstraps, and owns tools/hooks/signals. Makes **no** wiring choices.
- **Composition root (OCP):** `extension/config.mjs` is the **single** place the four plugin-capable
  seams (transport / credentials / identity / interceptors) are assembled — swap an adapter **only
  here**. The runtime-specific **Sink** is wired separately in `extension/bootstrap.mjs` (which also
  constructs the relay and starts receiving). With no plugins, config returns the zero-infra local
  default: SQLite-poll transport + no credentials + wordlist-alias identity + empty interceptor chain.
- **Core orchestration:** `extension/core/relay.mjs` — runtime-agnostic, unit-testable without a live
  CLI. **Adapters:** `extension/transports/`, `identity/`, `credentials/`. **Seam contracts (JSDoc
  types):** `extension/seams/*.mjs`.

## Plugins — the one path for outside seams

A plugin default-exports a factory `(ctx = { env, dataDir, log }) => Registration` declaring any of
four capabilities: `interceptors[]` (**aggregate**, in load order) and `transport` / `credentials` /
`identity` (each **single-instance, last-loaded wins**). Loading is **fail-loud & all-or-nothing**:
any bad plugin (import / missing factory / invalid registration) **throws** (usually naming the
plugin) and marks the relay **inactive** (below). Load order: `AGENT_RELAY_PLUGINS` (comma-separated
module paths) first, then the plugin **directory** alphabetically — the extension's **own `plugins/`
folder** (or `AGENT_RELAY_PLUGIN_DIR`), **not** the per-user data dir. A subdir plugin needs a
`package.json` (entry resolved `agentRelay.entry` → `main` → `index.mjs`). See
`extension/plugin-loader.mjs`. Note: plugin `credentials` take effect **only when a plugin also
supplies the `transport`** — the local default always uses none, so a credentials-only plugin is
accepted but its provider is unused.

## Invariants an agent MUST NOT break

- **No fallback to a different substrate.** A boot / transport-`init` failure marks the relay
  **inactive** for the session; it never silently switches to a different transport/mesh
  (`extension/extension.mjs`, `extension/bootstrap.mjs`). *(Separately, the **local default's DB
  path** is best-effort: it prefers the per-user data dir but degrades to the legacy in-install
  `agent-relay.db` on a filesystem error — same SQLite transport, different file.)*
- **Poison vs wake-failure** (`core/relay.mjs`): an `onReceive` interceptor or the renderer that
  **throws** is *poison* → logged and **consumed, never redelivered** (avoids a poison loop). A
  `sink.wake()` rejection **propagates** so the transport may **retry** (bounded → dead-letter). A
  guardrail that wants to reject a message must **drop** it (return without calling `next`), not throw.
- **Sanitize structured fields, never the body.** `stripControl` (`core/sanitize.mjs`) guards the
  peer-controlled display fields: the default wake header strips the **sender + recipient aliases**
  (`core/interceptors.mjs` `defaultRenderPrompt`; no id is rendered), and the roster strips the opaque
  **`attributes` bag** (keys + values, e.g. `machine`) in `roster.mjs`. The message **body is never
  sanitized** — that's an opt-in guardrail interceptor's job.
- **Self-send is rejected** (by name or id) — `core/relay.mjs`.

## Build / test

- `npm test` → **`node --test`** (dependency-free). Run it after touching `core/`, `plugin-loader`,
  the transports, or `storage/`.
- Install / manage (all via `scripts/install.mjs`, also the `agent-relay` bin):
  `npx --yes github:joniba/agent-relay` · `--add-plugin <repo>` · `--remove-plugin <name>` ·
  `--uninstall [--purge]` · `--no-statusline`. The installer is a **non-purging delta-copy** — it
  never deletes the runtime DB (`*.db*`) or installed plugins, so upgrades are safe **while sessions
  run**. `--purge` additionally removes the **entire per-user data dir** (DB, logs, and any plugin
  state kept there) — but **only** when its leaf is `agent-relay`, refusing to wipe a custom shared
  `AGENT_RELAY_DATA_DIR`; a store pointed elsewhere via `AGENT_RELAY_DB` is left untouched.

## Config & state (environment only)

| Var | Effect |
|---|---|
| `AGENT_RELAY_NAME` | This session's mesh name for the **default** identity (a plugin `identity` may ignore it); default is a deterministic wordlist alias from the session id |
| `AGENT_RELAY_DB` | Local SQLite store path — when set, overrides the data-dir store location entirely |
| `AGENT_RELAY_DATA_DIR` | Per-user dir for the rolling logs and (when `AGENT_RELAY_DB` is unset) the store; default is the OS data dir, e.g. `%LOCALAPPDATA%\agent-relay` |
| `AGENT_RELAY_PLUGINS` / `AGENT_RELAY_PLUGIN_DIR` | Extra plugin module paths / override the plugin folder |

State (SQLite `*.db*` + `logs/`) normally lives in the per-user data dir, **outside** the install
dir, so upgrades never touch it; a legacy in-install `agent-relay.db` is migrated on first run
(crash-safe). The statusline `[alias]` and the diagnostic log tag derive from the same
**name-resolution precedence** (`AGENT_RELAY_NAME` → deterministic alias) — a **pre-registration
preview**, so the actually-**registered** name can differ (a local alias collision bumps it, or a
plugin identity resolves differently; the statusline also control-char-strips its copy).

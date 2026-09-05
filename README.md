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

**Cross-machine messaging** is a separate drop-in plugin — add it with core's plugin installer:

```bash
npx --yes github:joniba/agent-relay --add-plugin github:joniba/agent-relay-pg-plugin
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
$env:AGENT_RELAY_NAME = "alice"      # this session is addressable as "alice"
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
provenance to the wake prompt and the `list_relay_agents` roster. Add it with core's plugin installer:

```bash
npx --yes github:joniba/agent-relay --add-plugin github:joniba/agent-relay-pg-plugin
```

See that repo's README for provisioning, configuration, the security model, and teardown.

## Trying a change safely (the sandbox)

Testing a change means installing it, and installing it overwrites the extension your running
sessions depend on. `scripts/sandbox.mjs` builds a **disposable install** instead — a real Copilot
session, on this working tree's code, on its own mesh:

```bash
node scripts/sandbox.mjs up        # core from this checkout + the roles plugin
node scripts/sandbox.mjs launch    # open a session on it (again in a 2nd tab for a peer)
node scripts/sandbox.mjs status    # what's installed, who's live
node scripts/sandbox.mjs down      # delete it
```

Two variables do the isolating — `COPILOT_HOME` selects the extension, `AGENT_RELAY_DATA_DIR`
selects the mesh — and setting only the first silently joins your **live** mesh instead. Automating
that pair is most of why the script exists.

The rest is lookup rather than arguments: a **sibling checkout** of a plugin repo is installed
directly, preferring a worktree on a feature branch over one on `main`, because `--add-plugin`
accepts a local path. Nothing needs pushing first — but it clones, so **commit before re-running
`up`**. Session aliases are auto-assigned (`sbx-a`, `sbx-b`, …) from whoever is already live.

The pg plugin is opt-in (`--pg`) and refuses by default when it would migrate a **shared** database,
since that locks out fresh sessions on any machine still running an older build.

**Full guide — every flag, worked examples, and the local-Postgres options: [`docs/sandbox.md`](docs/sandbox.md).**
Nothing here uses Docker; the `up`/`down` naming is borrowed, not the machinery.

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

**Install a plugin from a GitHub repo** — core clones it, runs `npm install --omit=dev` for its prod
dependencies, and copies it into the extension's own `plugins/` folder (the same folder it scans at
startup):

```bash
npx --yes github:joniba/agent-relay --add-plugin <owner/repo> [--ref <branch|tag|sha>]
npx --yes github:joniba/agent-relay --remove-plugin <name>      # <name> = the plugin's package.json "name"
```

A plugin ships **no installer of its own** — it only needs a `package.json` declaring a `name`, a `files`
allowlist (what core copies — **literal file/dir paths, not npm globs**), an entry (`agentRelay.entry` →
`main` → `index.mjs`), and any runtime `dependencies`. GitHub repos only (no npm registry); a local path or
full git URL also works (dev/offline). `--add-plugin` installs core only if it's **missing** — it never
re-installs or upgrades an already-installed core (run the bare `npx --yes github:joniba/agent-relay` to do
that). Re-running `--add-plugin` **upgrades the plugin** in place and preserves the plugin's local config —
a gitignored `.env` / `.env.*` in the plugin folder survives the upgrade.

At startup, a plugin loads **your own modules** and can supply any of seven capabilities — interceptors
(guardrails / middleware), the transport, credentials, identity, **tools**, **briefing** text, and an
**`activate`** hook (the Sink is wired in the entry, not via plugins) — so a capability can live in a
separate, even **private**, repo or a local folder, never in this one. Two sources, loaded in order
(env entries first, then the directory, alphabetically):

| Source | How |
|---|---|
| **Env-var pointer** | `AGENT_RELAY_PLUGINS` = a **comma-separated** list of module paths (**absolute recommended** — a session's cwd isn't obvious; relative is resolved against it), loaded in listed order. A secondary dev convenience. |
| **Plugin directory** | every top-level `*.mjs` **and** every package subfolder (`<name>/` with a `package.json`, which may carry its own `node_modules`) in `AGENT_RELAY_PLUGIN_DIR` — default the extension's **own** `plugins/` folder (next to `extension.mjs`), so an installed plugin survives core upgrades. |

**Contract** — a plugin module **default-exports a factory** (it may be `async`) that returns a
**Registration**. It may declare `interceptors` and `tools` (arrays), one `briefing` (a string) and
one `activate` (a function) — the first three accumulate across plugins in load order — plus
`transport`, `credentials` and `identity`, each single-instance, last-loaded wins. The common case —
one interceptor:

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
    // tools:       [ { name, description, parameters, handler } ],  // optional — see below
    // briefing:    "Use my_tool to …",                  // optional — see below
    // activate:    ({ relay, self }) => {},             // optional — see below
  };
}
```

**Tools and briefing.** A plugin can add tools of its own, and text describing them to the session
briefing.

A tool is `{ name, description, parameters, handler }` — all four required. `name` must be unique
across core's tools and every loaded plugin's; `description` is model-facing guidance for a single
call; `parameters` is the JSON Schema for the handler's argument object; and `handler(args)` returns
a result like `{ textResultForLlm, resultType: "success" | "failure" }`.

```js
return {
  tools: [{
    name: "roles_whois",
    description: "Return the session currently holding a given role.",
    parameters: {
      type: "object",
      properties: { role: { type: "string", description: "The role to look up" } },
      required: ["role"],
    },
    handler: async ({ role }) => ({
      textResultForLlm: `${role} is held by gull.`,
      resultType: "success",
    }),
  }],
  briefing: "Sessions can hold named roles. Before messaging a peer by alias, check roles_whois — " +
            "aliases change between restarts, roles don't.",
};
```

- **Ship briefing text with your tools.** The declaration makes a tool callable and its `description`
  says what one call does; the briefing is context injected when a session starts, and it is where
  *when to reach for this at all* belongs. A model rarely infers that from a schema, so a tool with no
  briefing tends to sit unused even though it is right there in the list. Core briefs its own tools and
  each plugin briefs its own — which is also why core no longer hardcodes a description of the tool
  surface, since it stopped being the only thing on it.
- **Names must not collide.** The loader rejects a duplicate within one registration, a name an
  earlier-loaded plugin already claimed, and core's own `send_message` / `list_relay_agents`. A
  collision fails the load rather than picking a winner. Core's names are reserved because a failed
  boot reports through them. Prefixing your tools (`roles_`, `acme_`) is the easy way to stay clear of
  everyone else.
- **The host gates your handlers until the relay is ready and your plugin has activated.** Tool
  declarations are registered with the runtime early — before the transport connects — but a call
  arriving before then gets the host's own result (still starting up, or the boot failure), and one
  arriving after a failed activation gets that failure. Your handler body runs only once both are
  behind it, so it does not need its own readiness gate. It *does* need one for anything you started
  in `activate` and deliberately did not await.

**Activation — the one point you can act on the mesh.** Your factory runs *before* identity is
resolved and *before* this session registers, so it can read configuration but cannot know who the
session turned out to be or see a single peer. Declared tools only run when a consumer calls them. So
if a plugin needs to announce itself, reconcile state, or check an invariant at startup, there is
nowhere to do it — that is what `activate` is for:

```js
export default function createPlugin(ctx) {
  // Shared state lives in the factory closure. `activate` is called on the host's own
  // record of your plugin, and handlers are called on their individual tool objects,
  // so `this` is NOT a way to pass anything between them.
  let me = null;

  return {
    async activate({ relay, self }) {
      // `self` is the REGISTERED identity — the name peers will actually address.
      // `relay` is narrowed to { sendMessage, listAgents, setAttributes }; lifecycle
      // stays the host's.
      me = self;
    },
    tools: [/* … handlers close over `me` … */],
  };
}
```

It is called once, after registration and **before the session is announced as ready**, and plugins
are activated in load order.

- **It is not a barrier against traffic.** Registration and inbound delivery both start *before*
  activation, so by the time your `activate` runs the session is already discoverable and messages can
  already be arriving. Activation gates tools, briefing and the ready announcement — not the
  transport. An interceptor that depends on state set up in `activate` therefore has a real race; set
  such state in the factory instead.

- **A failure is contained, not fatal.** If `activate` throws, the error is logged naming your plugin
  and **your tools** report it — but the session keeps running and messaging is unaffected. An additive
  capability that didn't come up shouldn't take down a working relay.
- **That is deliberately unlike loading**, which is fail-loud: a bad *registration* means the seam
  graph itself is unknown, so there is nothing safe to run. A bad *activation* is one component
  failing inside a graph that is otherwise fine.
- **Your tools then fail durably, not transiently.** Calling a tool whose plugin failed to activate
  says so and does not invite a retry — the condition will not resolve on its own.
- **You have 15 seconds.** `activate` is where a plugin does network work, so it is bounded: an
  unresolved callback here would otherwise hold the boot sequence open forever, and every *core tool*
  would report "still starting up" for the life of the session. (Transport traffic is unaffected —
  see above.) Overrun is recorded exactly like a throw.
- **A timed-out `activate` is abandoned, not cancelled.** Nothing can stop a promise that is already
  running, so after the ceiling fires your plugin is marked failed and its tools say so — while your
  `activate` keeps going and its side effects still land. Write it so that finishing after it has
  been given up on is safe; if it must not half-apply, make it idempotent or do the write last.
- **Failure is per-plugin and non-transactional.** Only *your tools and briefing* are withdrawn.
  Anything else you registered — an interceptor, transport, credentials, identity — was composed at
  load time and stays live. Side effects your `activate` already completed are not rolled back, and
  later plugins activate normally. Registration is atomic; activation is not.

**Session attributes — publishing facts about yourself.** The relay handle also carries
`setAttributes`, which writes key/value facts onto a session's own registry entry. Peers see them on
`list_relay_agents`, and the roster renders them without core interpreting a single key:

```js
async activate({ relay, self }) {
  const res = await relay.setAttributes({
    attributes: { "role.code-owner": new Date().toISOString() },
  });
  // It REPORTS failure, it does not throw one — see below.
  if (!res.ok) throw new Error(`could not publish role: ${res.error}`);
}
```

- **It reports failure by returning, not by throwing.** Every call resolves to
  `{ ok: true, attributes }` or `{ ok: false, error }`. Nothing inspects that for you: a plugin whose
  publish silently failed is still logged as activated, with its tools enabled and its briefing
  present. If publishing is a precondition for your plugin being useful, check `ok` and throw — that
  is what turns it into a contained activation failure. If it's best-effort, log it and carry on. What
  you must not do is ignore it.
- **`relay.setAttributes` always exists; support does not.** It is an optional *transport* capability,
  so the function is always there and a transport that doesn't implement it returns a clear
  "not supported by the active transport" result. Feature-detecting on `typeof` tells you nothing.
- **`await` it.** `activate` is awaited and its failures are contained, so an awaited rejection is
  reported against your plugin. A floating promise escapes that containment entirely — Node
  terminates the process on an unhandled rejection by default.
- **The target session is named by `id`.** Omit it and you write your own entry. Unknown options are
  rejected rather than ignored, because every near-miss for that name (`sessionId`, `to`, `target`)
  would otherwise be dropped silently, redirect the write to *your* entry, and still return
  `ok: true` — and `force` gives no signal either, since it is accepted on a self-write.
- **PATCH, not replace.** Keys you send are set; keys you don't are left alone; a key whose value is
  `null` is **removed** and never stored. The merge happens in the store, not in JavaScript, so two
  sessions patching *different* keys at the same time don't clobber each other. Two patches of the
  *same* key are ordinary last-writer-wins.
- **Values are strings.** That is the portable contract every transport has to honour, with `null`
  reserved for deletion. A given transport may happen to round-trip richer JSON — the local one does —
  but a plugin that relies on it stops working the moment someone installs a different transport.
- **Writing another session's entry needs `force: true`.** That write changes the state of something
  that is running and will not be told, so it has to be asked for rather than happening by default.
  It's a convention, not a wall — the mesh is trusted and nothing stops you setting the flag. The
  point is that the dangerous call looks dangerous.
- **Dotted keys group in the roster.** `role.owner` and `role.reviewer` render as `role: owner,
  reviewer`, values omitted. Purely structural — core groups on the dot and still knows nothing about
  what a key means. Values stay available through the API. A key whose value is the empty string is
  omitted from the roster entirely, so don't use `""` as a presence marker; use any non-empty value.
- **Attributes live as long as the registry entry does**, which differs by transport. The local SQLite
  transport *deletes* a session's entry on a graceful exit, so its attributes go with it; the
  cross-machine Postgres transport marks the session offline and keeps the entry, so a resumed session
  still has them.

- **Trusted, not sandboxed.** Loaded modules are **your own code** — only ever the modules you point at
  via the env var / plugin dir. The loader fetches nothing and never loads anything derived from message
  content.
- **Fail-loud + all-or-nothing, over what it recognises.** Anything the loader catches while importing
  or validating a plugin — a failed import, a missing factory, an invalid registration, a malformed
  tool, a name collision — **stops plugin loading with an error naming the plugin**. The extension then
  joins with core's tools only, and those tools report the inactive state rather than the session
  silently running degraded. A registration that fails contributes nothing, not even the parts of it
  that were valid. Validation is structural and covers the *known* capability keys: an unrecognised key
  is ignored rather than rejected, so a misspelled `breifing` loads cleanly and simply does nothing,
  and a tool's `parameters` is checked to be an object rather than validated as JSON Schema. (A plugin
  that *hangs* during load is out of scope — it's trusted code. `activate` is separately bounded.)
- **Containment covers `activate`, not your handlers.** A tool handler is invoked directly; if it
  throws or rejects, that escapes to the tool call rather than being converted. Return the documented
  failure result for expected failures.
- **Opt-in.** With no `AGENT_RELAY_PLUGINS` paths **and** no plugins in the directory, nothing loads —
  behaviour is exactly the dependency-free local default.

**Verify it loaded.** On startup each plugin logs `plugin loaded: <name>` to the rolling diagnostic log at
`<data-dir>/logs/agent-relay.log`; a failing one makes the extension fail to start with the error above
(naming the plugin). On Windows `<data-dir>` defaults to `%LOCALAPPDATA%\agent-relay` (see *Configuration*).

That line means *this plugin registered*, not *this plugin is working*. It is written as each
registration is accepted, so a later plugin can still fail the whole load, and this one can still fail
activation and lose its tools and briefing. For plugins loaded via `AGENT_RELAY_PLUGINS` the name is
the entry filename, so several `index.mjs` paths produce indistinguishable lines — a directory-installed
plugin is named by its folder and does not have that problem. To confirm a plugin is actually usable,
look for `plugin activated: <name>` and the absence of a `failed to activate` warning.

## License

MIT. The cross-session wake mechanism is inspired by
[htekdev/agent-mesh](https://github.com/htekdev/agent-mesh) (also MIT); agent-relay is an
independent reimplementation built around pluggable seams.

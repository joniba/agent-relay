# The sandbox — testing a change end to end

`scripts/sandbox.mjs` builds a **disposable agent-relay install** and points a real Copilot session
at it, so a change can be exercised for real without touching the extension your live sessions are
running on.

It is a thin orchestrator: it sets two environment variables, shells out to `scripts/install.mjs`,
and launches `copilot`. No containers, no daemon, no services — see [What it is not](#what-it-is-not).

---

## The 30-second version

```bash
node scripts/sandbox.mjs up        # build it
node scripts/sandbox.mjs launch    # open a session on it
node scripts/sandbox.mjs down      # delete it
```

`up` is idempotent. Change code, re-run `up`, `launch` again.

---

## Why it exists

Testing a change means installing it, and installing it overwrites the extension your running
sessions depend on. So the honest end-to-end test is also the one that takes your mesh down, which
is why it tends to be deferred until last — or skipped.

There is a second, subtler reason. Two environment variables isolate a session:

| Variable | Selects |
|---|---|
| `COPILOT_HOME` | which **extension** the CLI loads |
| `AGENT_RELAY_DATA_DIR` | which **mesh** it joins |

Set only the first and your sandbox session loads the sandbox extension but **joins your live
mesh** — where it can see, and message, your real sessions. It looks like it worked. Automating that
pair so it cannot be half-done is most of the point of this script.

---

## Commands and arguments

### `up` — build or refresh the sandbox

Installs core from *this checkout*, then the roles plugin. Safe to re-run.

| Flag | Default | What it does |
|---|---|---|
| `--fresh` | off | Delete the sandbox first and rebuild from scratch. Use when an install looks stale or wedged. |
| `--pg` | off | Also install the Postgres plugin. Opt-in, and it asks before doing anything shared — see [The pg plugin](#the-pg-plugin). |
| `--pg-env <path>` | your installed pg plugin's `.env` | Which settings file the pg plugin reads. Pointed at, never copied — credentials stay where they are. |
| `--yes-migrate` | off | Proceed with `--pg` against a **non-local** database, accepting the schema migration. Not needed for a local host. |
| `--roles-ref <ref>` | *(a local checkout)* | Install the roles plugin from **GitHub** at this branch/tag/SHA instead of a sibling checkout. |
| `--pg-ref <ref>` | *(a local checkout)* | Same, for the pg plugin. |

### `launch` — open a Copilot session on the sandbox

| Flag | Default | What it does |
|---|---|---|
| `--name <alias>` | next free `sbx-a`, `sbx-b`, … | The session's mesh alias. |

**Every other argument is passed straight through to `copilot`**, so anything the CLI accepts works:
`-p "prompt"`, `--allow-all-tools`, `--resume=<id>`, `--model`, and so on. `--experimental` is always
added, since extensions do not load without it.

### `status` — what is installed, and who is live

Prints the sandbox path, installed plugins, live sessions, and the diagnostic log location. Reads the
sandbox registry directly, so it works whether or not any session is running.

### `down` — delete the sandbox

| Flag | Default | What it does |
|---|---|---|
| `--force` | off | Delete even while sandbox sessions are still live. Without it, `down` refuses and names them. |

Removes the whole directory. Nothing outside it was ever written, so this is a complete undo.

### Environment

| Variable | Default | What it does |
|---|---|---|
| `AGENT_RELAY_SANDBOX` | OS data dir + `/agent-relay-sandbox` | Where the sandbox lives. There is deliberately **one** sandbox; set this only if the default path is awkward. |

---

## Examples

**The normal loop — one session.**

```bash
node scripts/sandbox.mjs up
node scripts/sandbox.mjs launch
```

**Two sessions that can message each other.** Run `launch` in two terminals; the second is
auto-named `sbx-b`, and both are on the same sandbox mesh.

```bash
# terminal 1                        # terminal 2
node scripts/sandbox.mjs launch     node scripts/sandbox.mjs launch
```

**Ask a question without opening a session** — the passthrough makes non-interactive runs work, which
is what makes this scriptable:

```bash
node scripts/sandbox.mjs launch --allow-all-tools \
  -p "Assign yourself the role 'code-owner', then list the relay agents."
```

**Test whether a capability is discoverable** — the gate no unit test can stand in for. Say what you
want, never name a tool, and see whether the session finds it:

```bash
node scripts/sandbox.mjs launch --allow-all-tools \
  -p "Send a message to whoever is currently the code owner. Work out how yourself."
```

**Test a plugin branch you have not pushed.** Nothing to pass — check the branch out in a sibling
worktree and `up` finds it:

```bash
cd ../agent-relay-experimental-plugin
git worktree add worktrees/my-feature -b my-feature
cd ../agent-relay && node scripts/sandbox.mjs up
# → installing roles plugin from …/worktrees/my-feature (my-feature)
```

**Test a published ref instead**, ignoring any local checkout:

```bash
node scripts/sandbox.mjs up --roles-ref main
```

**Start over after something wedges:**

```bash
node scripts/sandbox.mjs down --force && node scripts/sandbox.mjs up
```

---

## What gets looked up rather than asked for

A testing tool nobody remembers how to run does not get run, so anything derivable is derived.

- **Core** comes from the checkout the script lives in — including a worktree.
- **Plugins** come from a sibling checkout of their repo, preferring a worktree on a feature branch
  over one on `main`, because `install.mjs --add-plugin` already accepts a local path. Sibling repos
  are located via `git rev-parse --git-common-dir`, not by counting `..`, since this usually runs
  from a worktree — two levels deeper than a plain checkout.
- **Session aliases** are the first unused `sbx-<letter>`, read from the sandbox's own registry.
- **pg settings** default to the `.env` of your installed pg plugin.

Passing `--roles-ref` or `--pg-ref` turns the lookup off for that plugin, since an explicit ref that
was silently ignored would be worse than either behaviour on its own.

> **It clones, so it installs *committed* state.** Uncommitted edits in a plugin worktree will not
> appear in the sandbox. Commit, then re-run `up`. (Core is copied rather than cloned, so core edits
> apply immediately.)

---

## The pg plugin

Everything above is local-only and risk-free. `--pg` is the one flag with an effect **outside** the
sandbox, because the Postgres transport runs its schema migration when it starts — against whatever
database its `.env` points at, which by default is your **shared** one.

So it refuses by default, naming the host it read:

```
! This will run schema migration 2 against a SHARED database (pg-….postgres.database.azure.com).
  Sessions already running elsewhere keep working, but any FRESH session on a
  machine still using an older pg build will refuse to start until it is upgraded.

✗ Refusing by default. Re-run with --yes-migrate, or point at a throwaway database
```

Three ways forward:

1. **Skip pg.** The local SQLite mesh exercises everything except cross-machine delivery.
2. **Point at a throwaway database** — `--pg-env <path>` with a `.env` naming a local host. A local
   host is detected and the prompt is skipped.
3. **Accept it** with `--yes-migrate`, having decided to upgrade your other machines.

### A local Postgres, without Docker

`embedded-postgres` ships a real PostgreSQL binary — no daemon, no container:

```bash
npm i embedded-postgres
```

Start it on a spare port, then point `--pg-env` at a `.env` containing
`AGENT_RELAY_PG_HOST=localhost`, the port, and matching credentials.

> **PGlite is not sufficient.** It runs in-process and accepts a **single** connection, while the
> transport pools several — you get `ECONNRESET`. The same applies to the pg plugin's own integration
> suite, which additionally exercises advisory locks and `SKIP LOCKED` across concurrent connections.

---

## What it is not

The `up` / `down` / `status` vocabulary is borrowed from container tooling because it is the clearest
naming for a disposable environment — but **nothing here uses Docker, `docker-compose`, containers,
VMs, or background services.** There is no daemon and nothing to leak: the sandbox is a directory,
and `down` deletes it.

Under the hood, in full:

1. `up` runs `node scripts/install.mjs` with `COPILOT_HOME` pointed at the sandbox — the same
   installer, the same code path, a different destination. Then again with `--add-plugin` per plugin.
2. `launch` runs `copilot --experimental` with `COPILOT_HOME`, `AGENT_RELAY_DATA_DIR` and
   `AGENT_RELAY_NAME` set, inheriting your terminal.
3. `status` opens the sandbox's SQLite registry read-only.
4. `down` removes the directory.

The only reason Postgres appears anywhere is that one *optional plugin* uses it as its transport. It
is not part of the sandbox's own machinery, and **the default sandbox has no database server at
all** — just the local SQLite file core always uses.

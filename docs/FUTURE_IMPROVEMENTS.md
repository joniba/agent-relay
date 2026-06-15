# Future improvements / deferred work

Parking lot for ideas that are out of scope for the current work but worth doing
later. Each entry: the problem, a sketch of the approach, where it plugs in, and
status. Not commitments — a backlog.

---

## Session supervisor — runtime-rebindable transport (substrate lifecycle)

**Status:** proposed · **Value:** high · **Effort:** medium

**Problem.** The substrate (local SQLite vs cross-machine Postgres) is chosen
**once at boot** in `config.mjs` and is fixed for the life of the process. This makes
three things awkward:
- **Mode switching** local↔remote requires restarting the session.
- **Started-during-outage**: a session that boots while Postgres is unreachable
  falls back to local for good — it never upgrades to remote when PG returns.
- **Code upgrade** "reload" has no in-process hook.

(A mid-session *transient* PG outage is already ridden out: the poll loop swallows
errors and retries, the async token re-mints per reconnection, and a lapsed
heartbeat re-registers. So short blips already self-heal **without** restarting.)

**Approach.** Promote the already-extracted `startRelaySession` (`extension/bootstrap.mjs`)
into a small **session supervisor** that owns the `(identity, transport)` binding:
- `start()` — today's boot.
- `switchTo(newConfig)` — quiesce the old transport (`stop()`), `init`+`register`
  the new one, resume `startReceiving` **keeping the same Sink**.
- `stop()`.

The **core relay never changes** (OCP holds); this lives entirely in the
entry/composition layer. Then: live mode switch = `supervisor.switchTo(...)`;
self-heal / started-during-outage = a health signal drives `switchTo`; a code-reload
hook can reuse the same mechanism.

**⚠️ Semantic caveat (must be designed deliberately).** Local and remote are
**different meshes**, not two backends for one mesh — local SQLite is single-machine
by definition. Auto-failing-over remote→local during an outage **partitions** the
mesh (machine A → local-A, machine B → local-B) and can **strand** messages sent to a
remote peer during the gap (split-brain). Lossless auto-failover would need
outbox-replay-on-reconnect reconciliation. Recommended tiering:
- **Tier 1 (do first):** explicit live switch — a `relay_mode(local|remote)` tool /
  signal. No restart. Also enables manual recovery from started-during-outage
  (re-bind to remote once PG is back) without restarting.
- **Tier 2 (opt-in, later):** automatic health-driven remote→local degradation +
  local→remote recovery, **clearly labeled** as single-machine + best-effort, with
  reconciliation if losslessness is required. Not the default.

**Plugs into:** `extension/bootstrap.mjs`, `extension/extension.mjs` (entry),
`extension/config.mjs` (already the composition root). Core/seams untouched.

**Related:** the install/upgrade work shares the same "rebind without clobbering
runtime state" root; a clean supervisor would also make an in-process code-reload
feasible.

---

## Manual transport-switch tool (`relay_mode local|remote`) + retry-exhaustion handoff

**Status:** proposed · **Value:** high · **Effort:** low-medium

**Problem.** When a session can't reach the remote mesh (e.g. flaky/blocked 5432),
the user has no in-session way to flip to local, or back to remote once the network
recovers — today it means restarting the session. Tied to the new boot-retry work:
when the 3 remote-connect attempts are exhausted, the error should **offer (or ask)**
the user to switch to the local mesh rather than dead-ending.

**Approach.** Surface the Session-supervisor **Tier 1** as an extension tool
`relay_mode(local|remote)` that calls `supervisor.switchTo(config)` (no restart). The
retry-exhaustion error message then points at it ("remote unavailable after 3 tries —
run `relay_mode local` to use the single-machine mesh"). Decide ask-vs-suggest:
suggest by default (non-blocking); an explicit confirm is friendlier but needs a
prompt surface.

**Plugs into:** the Session supervisor entry above (its Tier 1); the boot-retry
feature (current `feature/relay-resilience` work) provides the trigger point.

---

## Canonical per-user data directory (relocate DB + logs out of the install dir)

**Status:** proposed · **Value:** medium · **Effort:** medium

**Problem.** Runtime **state lives inside the install dir** today
(`~/.copilot/extensions/agent-relay/agent-relay.db`, or the clone for a `-Link`
install) — the long-standing "state vs code" wart. It complicates upgrades (lock-safe
overlay dance), pollutes the git clone for dev installs, and there is **no canonical
home** for other runtime artifacts (notably the rolling log).

**Approach.** Adopt a per-user data dir, overridable by env:
- Windows: `%LOCALAPPDATA%\agent-relay\` · macOS: `~/Library/Application Support/agent-relay/`
  · Linux: `$XDG_DATA_HOME/agent-relay` or `~/.local/share/agent-relay`.
- Layout: `<data>/agent-relay.db` (move the SQLite DB here; install no longer holds
  state → upgrades become a plain replace) and `<data>/logs/` (rolling log home).
- Honor an explicit override (`AGENT_RELAY_DATA_DIR`, plus the existing
  `AGENT_RELAY_DB`). Migrate an existing in-install DB on first run.

**Plugs into:** `config.mjs` (DB path resolution), the installer (no longer needs the
lock-safe `*.db*`-preserve logic once state is out), the rolling-log feature.

---

## Roster idle-age visibility + optional idle-deregister

**Status:** proposed · **Value:** low-medium · **Effort:** low

**Problem.** `list_relay_agents` shows live peers but not **how long they've been
idle**, so a long-forgotten-but-still-running session looks identical to an active one
(the "is this a ghost?" confusion). Reachable-while-idle is intended, but the roster
gives no signal.

**Approach.** Surface `last_heartbeat` age (e.g. "idle 3h") per peer in the roster.
Optionally, an opt-in idle-deregister (a session deregisters after N minutes idle) —
**tradeoff:** a deregistered session can't be woken until it's touched again, which
fights the wake-idle feature; must be opt-in, off by default.

**Plugs into:** `roster.mjs`, the transport `listAgents()` (already returns the row;
add the timestamp).

---

## Cross-machine over restrictive networks (corporate 5432 block)

**Status:** investigation · **Value:** medium · **Effort:** high

**Problem.** Raw outbound TCP 5432 is blocked outright on some networks (measured: a
corporate network fails 100%; a home transparent proxy tunnels it but slowly/flakily).
Boot-retry (current work) helps the flaky case but **cannot** punch a hard block — the
session just runs local-only there.

**Approach (options, none chosen).** (a) Tunnel the DB over 443 (e.g. a small relay
gateway exposing a WebSocket/HTTPS endpoint that brokers messages, replacing the direct
pg connection on locked-down networks); (b) a second Transport implementation over an
egress-friendly protocol (HTTPS long-poll / SignalR / a hosted queue); (c) document
VPN/hotspot as the operational workaround. Keep it behind the Transport seam so it's a
config-only swap.

**Plugs into:** a new Transport adapter + `config.mjs`; the Credentials seam is reusable.

---

## Automate the pre-push security gate in CI (GitHub-triggered)

**Status:** proposed · **Value:** high · **Effort:** medium

**Problem.** The mandatory pre-push security review (no secrets / no vulns to the
public repo) is run **manually** per push today — a human/agent bottleneck and not
enforceable for other contributors.

**Approach.** Move it into GitHub, layered:
1. **Native secret scanning + push protection** (free on public repos) — enable in repo
   settings; blocks secret pushes at the source. Directly covers the #1 leak check.
2. **CodeQL** (free for public repos) — SAST for injection/etc.
3. **LLM security job** — a GitHub Actions workflow on `pull_request` that runs an
   LLM review (e.g. `gh models`, or an Action calling an LLM API with a repo-secret
   key, or a Copilot/Claude action) and posts findings as a **required check**; gate
   merges via branch protection.

**Implication.** Shifts the model from "push direct to branch" to **PR + required
checks**, which makes the gate enforceable and removes the manual step. Spec as its own
task.

**Plugs into:** `.github/workflows/` (new); repo settings (secret scanning, branch
protection).

---

## Push-based delivery (PG LISTEN/NOTIFY) with poll as backup

**Status:** ASSIGNED to the `clove` session (handed off 2026-06-15) · sequence: merge
**LAST** (after `relay-resilience`) · **Value:** medium-high · **Effort:** medium

**Problem.** Message delivery **polls** — the Postgres transport drains its inbox on a
~3 s interval (`postgres.mjs` `startReceiving()`), so a delivered message can wait up to
one poll interval before it wakes the recipient.

**Approach.** Add Postgres **LISTEN/NOTIFY** for instant push delivery (NOTIFY on
insert in `send`; a dedicated LISTEN connection wakes `drain` in `startReceiving`), and
**keep the poll loop as a backup** safety-net (covers missed notifications, dropped
LISTEN connections, reconnects). Stays behind the Transport seam; **core/relay.mjs
untouched** (OCP).

**Coordination.** Both this and `relay-resilience` edit `postgres.mjs` (`init` /
`startReceiving`) — implement on **top of** the merged resilience work (rebase/branch
off updated `main`) to avoid conflicts. Per the shared-machine protocol: separate
worktree, announce installs/integration-tests/merges on the relay.

**Plugs into:** `extension/transports/postgres.mjs` only.

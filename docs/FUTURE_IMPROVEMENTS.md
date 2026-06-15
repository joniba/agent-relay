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

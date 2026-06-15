# relay-resilience — build plan

**Branch:** `feature/relay-resilience` (off `origin/main` @ 0b9a45d) · **Status:** approved 2026-06-15, building.

Three operator-driven features from cross-machine dogfooding: (1) no silent local
fallback when the user explicitly chose Postgres, (2) bounded boot-time connection
retry, (3) a rolling on-disk diagnostic log living in a real per-user data directory
(which the sqlite DB also moves into).

**Guiding constraint:** SIMPLICITY is the top target, as long as it stays SRP/OCP-clean.

## Locked requirements (2026-06-15)
- **No-fallback:** explicit `AGENT_RELAY_TRANSPORT=postgres` -> on connect failure after
  retries, **no mesh at all** (never silently local).
- **Retry:** up to **3 attempts**, **30s timeout per attempt**, backoff **2s** (after #1)
  then **4s** (after #2); **warn** on attempts 1 & 2, **error** on 3.
- **Retry-exhaustion message:** **suggest** switching to local (non-blocking), not an
  interactive prompt.
- **Log location:** a **canonical per-user data dir** (e.g. `%LOCALAPPDATA%\agent-relay\`);
  relocate the sqlite DB there too (must not affect pg; migrate an existing in-install
  DB on first run).
- **Log contents:** implementer discretion — built to debug issues fast and confidently.
- **Rotation:** simplest approach that works.

## Coordination with clove (push-delivery)
clove rebases onto this once it lands on main. My only shared touch-point is `init()`; I
do NOT restructure `startReceiving()`'s drain/poll, and the only `postgres.mjs` change is
adding `connectionTimeoutMillis`. I ping clove the moment relay-resilience merges.

## Gates (per code phase)
smoke (`node --test`) -> code-review agent -> general-purpose SOLID (SRP/OCP + seam
encapsulation). Rubber-duck is docs-only. A security-review must APPROVE before any push
to the public repo. Findings are inputs, not orders.

---

## Phase 1 — Canonical data dir + sqlite relocation

**Goal:** give runtime state a real home outside the install dir; unblock the log; move
sqlite without touching the pg path. Independently shippable.

- [ ] `extension/storage/paths.mjs`: pure `resolveDataDir(env, platform)` ->
      `%LOCALAPPDATA%\agent-relay` (Win) / `~/Library/Application Support/agent-relay`
      (mac) / `$XDG_DATA_HOME|~/.local/share/agent-relay` (Linux); honors
      `AGENT_RELAY_DATA_DIR` override. `dataFile(name)` helper.
- [ ] `config.mjs` `localSlice()`: default DB -> `<dataDir>/agent-relay.db`; one-time
      migration of an existing in-install `agent-relay.db` when the new path is absent;
      keep the `AGENT_RELAY_DB` override. pg branch untouched.
- [ ] Smoke: `node --test` — `resolveDataDir` per-platform + env override; DB-path
      resolution + one-time migration (fake fs); assert the pg branch is unaffected.
- [ ] Gate: code-review · SOLID
- [ ] Committed

## Phase 2 — Rolling file log

**Goal:** durable, self-rotating diagnostics for fast/confident debugging.

- [ ] `extension/logging/rolling-file-log.mjs`: append to `<dataDir>/logs/`; rotate when
      the current log is >=24h old; keep current + 3 rolled, delete the 4th on rollover;
      injectable clock + fs; never throws (failure-isolated).
- [ ] `extension.mjs`: tee `relayLog` -> session timeline AND rolling log. Capture:
      registration, transport mode + fallback decision, connect attempts/retries/outcome,
      sweeps (when debug), errors.
- [ ] Smoke: rotation (forged timestamps), retention (4th deleted), tee, failure
      isolation (a log-write error never disrupts the relay).
- [ ] Gate: code-review · SOLID
- [ ] Committed

## Phase 3 — Boot retry x3 + no-silent-fallback

**Goal:** explicit Postgres never silently degrades; slow/transient networks get
retried. The behavioral core.

- [ ] `bootstrap.mjs`: retry transport init up to 3x — 30s/attempt, backoff 2s->4s; warn
      on 1 & 2, error on 3 (to the tee'd log).
- [ ] No-fallback policy: the composition root supplies **no** fallback when
      `AGENT_RELAY_TRANSPORT=postgres`; on exhaustion the relay goes **INACTIVE** (no
      mesh) with a non-blocking suggestion to switch to local. Default-local path keeps
      its current behavior. Guard the startup banner + tool handlers
      (`send_message`/`list_relay_agents`) for the inactive state.
- [ ] `postgres.mjs`: add pool `connectionTimeoutMillis` (bounds each attempt) — the ONLY
      transport change (keeps clove's rebase mechanical).
- [ ] Smoke: fake transport failing N->OK (assert 3 attempts + backoff via fake timers +
      warn/warn/error); explicit-postgres exhaustion -> inactive (not local); default-local
      unaffected; tools error gracefully when inactive.
- [ ] Gate: code-review · SOLID
- [ ] Committed

## Phase 4 — Docs + installer

**Goal:** document the new behavior + the data dir; let the installer drop the
now-unneeded lock dance (back-compat aware).

- [ ] README + `.env.example`: `AGENT_RELAY_DATA_DIR`; no-silent-fallback + retry +
      inactive-state/how-to-switch; log location + retention.
- [ ] `install.ps1`: simplify the `*.db*`-preserve logic now that state lives in the data
      dir (keep a migration-safe path for existing installs).
- [ ] Gate: rubber-duck (docs) · human-reviewer (setup journey) · code-review (installer)
- [ ] Committed

---

## Then (separate, on explicit user OK)
Final security-review -> `--no-ff` merge `feature/relay-resilience` -> `main` -> push ->
**ping clove** to rebase push-delivery on top.

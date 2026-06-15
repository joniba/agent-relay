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

## Phase 1 — Canonical data dir + sqlite relocation  ✅ DONE

**Goal:** give runtime state a real home outside the install dir; unblock the log; move
sqlite without touching the pg path. Independently shippable.

- [x] `extension/storage/paths.mjs`: pure `resolveDataDir({env,platform,homedir})` ->
      `%LOCALAPPDATA%\agent-relay` (Win) / `~/Library/Application Support/agent-relay`
      (mac) / `$XDG_DATA_HOME|~/.local/share/agent-relay` (Linux); `AGENT_RELAY_DATA_DIR`
      override; `dataFile()` + `ensureDataDir()`.
- [x] `extension/storage/local-db.mjs`: `migrateLocalDbOnce()` — crash-safe one-time
      relocation via SQLite `VACUUM INTO` (consistent single-file snapshot, no WAL/SHM) +
      atomic create-if-absent `linkSync` commit. (Split out of paths.mjs per review: a
      naive live-WAL file-copy was unsafe; see Issues 1-2 below.)
- [x] `config.mjs` `localSlice()`: default DB -> `<dataDir>/agent-relay.db`; best-effort
      provisioning + migration wrapped in try/catch, degrades to the legacy path on any fs
      error (boot resilience). `AGENT_RELAY_DB` override returns early. pg branch untouched.
- [x] Smoke: `node --test` — 118 tests, 0 fail (8 paths + 5 local-db incl. a real-sqlite
      round-trip).
- [x] Gate: code-review (Issues 1-3 resolved; R1 temp-leak + R2 peer-race hardened via
      linkSync + try/finally) · SOLID (clean)
- [x] Committed

## Phase 2 — Rolling file log  ✅ DONE

**Goal:** durable, self-rotating diagnostics for fast/confident debugging.

- [x] `extension/logging/rolling-file-log.mjs`: append ISO-timestamped lines to
      `<dataDir>/logs/agent-relay.log`; rotate when the current log is >=24h old; keep
      current + 3 rolled, delete the 4th on rollover; injectable clock + fs; never throws.
      Period resumed across restarts from the log's own first-line timestamp (self-
      describing; no fragile filesystem birthtime dependency).
- [x] `extension.mjs`: tee `relayLog` -> session timeline AND rolling log; registration +
      boot-error logs rerouted through `relayLog`. Logger built from
      `join(resolveDataDir(), "logs")`, guarded so it can't break boot.
- [x] Smoke: 7 rolling-log tests + a real-path probe that wrote the actual log file.
      Suite: 125 tests, 0 fail.
- [x] Gate: code-review (ship-able; Medium birthtime-starvation item resolved via the
      first-line-timestamp approach) · SOLID (clean)
- [x] Committed

## Phase 3 — Boot retry x3 + no-silent-fallback  ✅ DONE

**Goal:** explicit Postgres never silently degrades; slow/transient networks get
retried. The behavioral core.

- [x] `bootstrap.mjs`: rewritten — `startRelaySession` treats `createConfig` as a FACTORY
      and retries the connect (init→register) up to 3x via `bringUpWithRetry`, each attempt
      bounded by a 30s `withTimeout`, backoff 2s→4s (injected `sleep`), warn on 1 & 2, error
      on 3, then the error PROPAGATES (no fallback). CRITICAL FIX (both gates): each attempt
      uses a FRESH transport — the seam is init-once/stop-terminal, so a stopped transport is
      never reused (reuse would "succeed" into an inert transport).
- [x] No-fallback policy: `extension.mjs` supplies the retry policy ONLY for explicit
      `AGENT_RELAY_TRANSPORT=postgres`; on exhaustion the relay goes INACTIVE (bootError →
      tools return notReadyResult) with a non-blocking "unset AGENT_RELAY_TRANSPORT to use
      local" suggestion. Default-local = single attempt, unchanged. `createFallbackConfig`
      removed.
- [x] `postgres.mjs`: added pool `connectionTimeoutMillis` (default 30000) — the ONLY
      functional transport change (+ 2 stale-comment fixes); keeps clove's rebase mechanical.
- [x] Smoke: 8 bootstrap tests incl. a FAITHFUL fake that models terminal-`stop` (so the
      seam bug is now caught), fresh-instance-per-retry, give-up, single-attempt, timeout,
      and a real message delivered through the post-retry transport. Suite: 126 tests, 0 fail.
- [x] Gate: code-review (Critical seam-reuse bug found + fixed → "ready to merge") · SOLID
      (clean; timeout-cancellation residual accepted via fresh-instance containment)
- [x] Committed

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

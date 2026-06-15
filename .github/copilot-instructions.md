# agent-relay — repository instructions

## Cross-machine config (`extension/.env`) and new worktrees

The cross-machine Postgres settings live in **`extension/.env`**, which is
**gitignored** — it's local-only and per-machine (it holds non-secret host / DB user /
DB name / tenant values; database auth uses short-lived Microsoft Entra tokens minted
locally via `az login`, never stored in the file). `extension/.env.example` documents
every key.

Because the file is gitignored, **`git worktree add` does NOT carry it into a new
worktree.** A session in a worktree without it silently runs in single-machine **LOCAL**
mode (it won't join the cross-machine mesh) — and no error is shown.

**So: whenever you create a new worktree, copy `extension/.env` from the main
worktree into it.** The main worktree holds the canonical copy.

```powershell
# Run from inside the freshly-added worktree. The main worktree is the first
# entry of `git worktree list`.
$main = ((git worktree list --porcelain) | Select-String '^worktree ' |
         Select-Object -First 1) -replace '^worktree ', ''
Copy-Item (Join-Path $main 'extension\.env') 'extension\.env'
```

If you don't intend the new worktree to do cross-machine work (e.g. it only runs the
local-default tests), you can skip the copy — it will just operate in LOCAL mode.

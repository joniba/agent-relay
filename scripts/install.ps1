#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Install agent-relay as a Copilot CLI extension (Windows / PowerShell).

.DESCRIPTION
  Copies this clone's `extension/` folder (plus its `node_modules`, if present)
  into the Copilot CLI extensions directory so the entry lives at
  `~/.copilot/extensions/agent-relay/extension.mjs`. Does NOT launch Copilot.

  The default is a self-contained COPY: the destination depends on nothing else,
  and re-running to upgrade is LOCK-SAFE — it refreshes the code in place and
  PRESERVES runtime state (`*.db*`), so you can upgrade while sessions are open.
  The single-machine default needs no packages (built-in node:sqlite); for
  cross-machine messaging run `npm install` first so `node_modules` (with `pg`)
  is bundled into the install.

  Use -Link to create a directory **junction** to this clone instead (for
  contributors: a later `git pull` updates the live extension with no re-copy).

.PARAMETER Link
  Create a junction to this clone instead of copying (dev convenience); updates
  then come from `git pull`. Requires the destination be removable — a copy whose
  SQLite DB is held open by a running session can't be replaced with a link.

.PARAMETER NoStatusline
  Skip pointing Copilot's statusline at agent-relay.

.EXAMPLE
  pwsh scripts/install.ps1            # self-contained copy (recommended)
  pwsh scripts/install.ps1 -Link     # dev junction to this clone
#>
[CmdletBinding()]
param(
    [switch]$Link,
    [switch]$NoStatusline
)

$ErrorActionPreference = 'Stop'

# --- Locate the source (this script lives in <repo>/scripts) ----------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$source    = Join-Path $repoRoot 'extension'
$entry     = Join-Path $source 'extension.mjs'
if (-not (Test-Path -LiteralPath $entry)) {
    throw "Cannot find the extension entry at '$entry'. Run this from a clone of agent-relay."
}

# --- Node >= 22.5 (required at runtime for node:sqlite) ---------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $nodeVer = (& node --version).TrimStart('v')
    $p = $nodeVer.Split('.')
    $nodeOk = ([int]$p[0] -gt 22) -or ([int]$p[0] -eq 22 -and [int]$p[1] -ge 5)
    if ($nodeOk) { Write-Host "Node $nodeVer (ok)" -ForegroundColor Green }
    else { Write-Warning "Node $nodeVer found, but agent-relay needs >= 22.5.0 (node:sqlite). The extension will fail to load until you upgrade." }
} else {
    Write-Warning "Node not found on PATH. agent-relay needs Node >= 22.5.0 at runtime."
}

# --- Resolve destination ----------------------------------------------------
$copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }
$extRoot     = Join-Path $copilotHome 'extensions'
$dest        = Join-Path $extRoot 'agent-relay'
New-Item -ItemType Directory -Force -Path $extRoot | Out-Null

# --- Install: self-contained COPY (default) or a dev JUNCTION (-Link) --------
# A copy bundles extension/ + node_modules so the destination is self-contained
# and never depends on this clone staying put. Re-running to upgrade refreshes
# the code in place and PRESERVES runtime state (*.db*) — which is never even
# opened — so an upgrade is safe while a session holds the SQLite DB open. -Link
# instead points the destination at this clone (contributors: `git pull` updates
# the live extension with no re-copy).

$dbGlob = '*.db*'   # agent-relay.db + its -wal/-shm sidecars: runtime state, keep

if ($Link) {
    # Dev junction. Needs a removable destination; a copy whose DB is held open by
    # a running session can't be removed — close those sessions, or use a copy.
    if (Test-Path -LiteralPath $dest) {
        $item = Get-Item -LiteralPath $dest -Force
        if ($item.LinkType) { $item.Delete() }
        else {
            try { Remove-Item -LiteralPath $dest -Recurse -Force }
            catch {
                throw "Can't replace '$dest' with a link: $($_.Exception.Message). " +
                      "If a running session holds agent-relay.db open, close it (or install without -Link)."
            }
        }
    }
    New-Item -ItemType Junction -Path $dest -Target $source | Out-Null
    $mode = 'junction'
}
else {
    # Self-contained copy, lock-safe. Refresh code in place: remove the existing
    # CODE (everything EXCEPT *.db*), then copy extension/ + node_modules. The
    # locked DB is excluded from the removal, so this works while a session runs.
    if (Test-Path -LiteralPath $dest) {
        $existing = Get-Item -LiteralPath $dest -Force
        if ($existing.LinkType) {
            $existing.Delete()
            New-Item -ItemType Directory -Force -Path $dest | Out-Null
        }
        else {
            Get-ChildItem -LiteralPath $dest -Force |
                Where-Object { $_.Name -notlike $dbGlob } |
                Remove-Item -Recurse -Force
        }
    }
    else {
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
    }
    Copy-Item -Recurse -Force (Join-Path $source '*') $dest
    # Bundle dependencies if present. Cross-machine users ran `npm install`; the
    # single-machine default needs none, so a missing node_modules is fine.
    $deps = Join-Path $repoRoot 'node_modules'
    if (Test-Path -LiteralPath $deps) {
        Copy-Item -Recurse -Force $deps (Join-Path $dest 'node_modules')
        $mode = 'copied (+ node_modules)'
    }
    else {
        $mode = 'copied (no node_modules — single-machine default only)'
    }
}

# --- Verify -----------------------------------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $dest 'extension.mjs'))) {
    throw "Install verification failed: '$dest\extension.mjs' is missing."
}

Write-Host "`n✓ Installed agent-relay -> $dest ($mode)" -ForegroundColor Green
if ($mode -eq 'junction') { Write-Host "  Source: $source  (a later ``git pull`` updates the live extension)" }

# --- Statusline: point Copilot's single statusLine slot at agent-relay --------
# agent-relay shows THIS session's locally-generated alias below the prompt.
# This replaces whatever statusLine command was previously configured.
if (-not $NoStatusline) {
    $statusScript = Join-Path $dest 'bin\agent-relay-statusline.mjs'
    if (Test-Path -LiteralPath $statusScript) {
        $settingsPath = if ($env:COPILOT_HOME) { Join-Path $env:COPILOT_HOME 'settings.json' } else { Join-Path $copilotHome 'settings.json' }
        $settings = @{}
        if (Test-Path -LiteralPath $settingsPath) {
            try { $settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json -AsHashtable } catch { $settings = @{} }
            if ($null -eq $settings) { $settings = @{} }
        }
        $previous = $null
        if ($settings.statusLine -and $settings.statusLine.command) { $previous = $settings.statusLine.command }
        $cmd = 'node "' + $statusScript + '"'
        $settings.statusLine = @{ type = 'command'; command = $cmd }
        $settings | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $settingsPath -Encoding utf8
        Write-Host "✓ Statusline -> agent-relay ($settingsPath)" -ForegroundColor Green
        if ($previous -and $previous -ne $cmd) { Write-Host "  (replaced: $previous)" -ForegroundColor DarkGray }
    } else {
        Write-Warning "Statusline script not found at $statusScript — skipped."
    }
}

Write-Host @"

Next steps (this script does NOT launch Copilot):
  1. (optional) name this session in the mesh:  `$env:AGENT_RELAY_NAME = "tia"
  2. start with extensions enabled:             copilot --experimental

On load you'll see: agent-relay: registered as "<alias>" - ready
The same alias renders below the prompt as [<alias>] (statusline).
"@ -ForegroundColor Cyan

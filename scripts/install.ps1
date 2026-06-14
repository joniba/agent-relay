#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Install agent-relay as a Copilot CLI extension (Windows / PowerShell).

.DESCRIPTION
  Links (or copies) this clone's `extension/` folder into the Copilot CLI
  extensions directory so the entry lives at
  `~/.copilot/extensions/agent-relay/extension.mjs`. Does NOT launch Copilot.

  By default a directory **junction** is created (no admin needed, and a later
  `git pull` updates the live extension with no re-copy). Use -Copy for a plain
  copy instead.

.PARAMETER Copy
  Copy the files instead of creating a junction (use when you can't/won't link).

.PARAMETER Force
  Replace an existing install at the destination. Without this, an existing
  destination that isn't already our link is left untouched and the script exits
  non-zero. NOTE: with -Copy this removes any DB/state in a previously-copied dir.

.EXAMPLE
  pwsh scripts/install.ps1
  pwsh scripts/install.ps1 -Copy
  pwsh scripts/install.ps1 -Force
#>
[CmdletBinding()]
param(
    [switch]$Copy,
    [switch]$Force
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

# --- Handle an existing destination (idempotent / safe) ---------------------
if (Test-Path -LiteralPath $dest) {
    $item     = Get-Item -LiteralPath $dest -Force
    $linkType = $item.LinkType
    $target   = if ($linkType) { @($item.Target)[0] } else { $null }
    $sameLink = $false
    if ($target) {
        try { $sameLink = (Resolve-Path -LiteralPath $target).Path -eq (Resolve-Path -LiteralPath $source).Path } catch {}
    }

    if (-not $Copy -and $sameLink) {
        Write-Host "Already installed: $dest -> $source ($linkType). Nothing to do." -ForegroundColor Green
        Write-Host "`nNext: run ``copilot --experimental`` in any folder." -ForegroundColor Cyan
        return
    }

    if (-not $Force) {
        $kind = if ($linkType) { "a $linkType to $target" } else { "a directory" }
        Write-Error "Destination '$dest' already exists ($kind). Re-run with -Force to replace it."
        exit 1
    }

    # -Force: remove the existing destination. A reparse point (junction/symlink)
    # is deleted as a link only (never recursing into its target); a real
    # directory is removed recursively.
    Write-Warning "Replacing existing '$dest' (-Force)."
    if ($linkType) { $item.Delete() }
    else { Remove-Item -LiteralPath $dest -Recurse -Force }
}

# --- Install: junction (default) or copy ------------------------------------
if ($Copy) {
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Recurse -Force (Join-Path $source '*') $dest
    $mode = 'copied'
} else {
    try {
        New-Item -ItemType Junction -Path $dest -Target $source | Out-Null
        $mode = 'junction'
    } catch {
        Write-Warning "Junction failed ($($_.Exception.Message)). Falling back to copy."
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item -Recurse -Force (Join-Path $source '*') $dest
        $mode = 'copied'
    }
}

# --- Verify -----------------------------------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $dest 'extension.mjs'))) {
    throw "Install verification failed: '$dest\extension.mjs' is missing."
}

Write-Host "`n✓ Installed agent-relay -> $dest ($mode)" -ForegroundColor Green
if ($mode -eq 'junction') { Write-Host "  Source: $source  (a later ``git pull`` updates the live extension)" }
Write-Host @"

Next steps (this script does NOT launch Copilot):
  1. (optional) name this session in the mesh:  `$env:AGENT_RELAY_NAME = "tia"
  2. start with extensions enabled:             copilot --experimental

On load you'll see: agent-relay: registered as "<name>" - ready
"@ -ForegroundColor Cyan

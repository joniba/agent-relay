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

  CROSS-MACHINE: if your `.env` selects the Postgres transport
  (`AGENT_RELAY_TRANSPORT=postgres`), or you pass -CrossMachine, the script first
  runs a setup preflight — checks the Azure CLI + your `.env`, runs `npm install`,
  signs you in to Azure (`az login`) if needed, and verifies a real connection to
  the shared database — failing with a specific message for whatever isn't set up.

.PARAMETER Link
  Create a junction to this clone instead of copying (dev convenience); updates
  then come from `git pull`. Requires the destination be removable — a copy whose
  SQLite DB is held open by a running session can't be replaced with a link.

.PARAMETER CrossMachine
  Force the cross-machine (Postgres) setup preflight even if it wasn't auto-detected
  from the `.env`. (Auto-detected when the `.env` sets AGENT_RELAY_TRANSPORT=postgres.)

.PARAMETER NoStatusline
  Skip pointing Copilot's statusline at agent-relay.

.EXAMPLE
  pwsh scripts/install.ps1            # self-contained copy (recommended)
  pwsh scripts/install.ps1 -Link     # dev junction to this clone
  pwsh scripts/install.ps1 -CrossMachine   # force the cross-machine setup preflight
#>
[CmdletBinding()]
param(
    [switch]$Link,
    [switch]$CrossMachine,
    [switch]$NoStatusline
)

$ErrorActionPreference = 'Stop'
# Handle `az`/`npm` non-zero exits ourselves via $LASTEXITCODE — don't let a user
# profile that sets this $true turn a native non-zero exit into a terminating throw.
$PSNativeCommandUseErrorActionPreference = $false

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

# --- Cross-machine (Postgres) setup preflight -------------------------------
# Auto-detected from the source .env (AGENT_RELAY_TRANSPORT=postgres) or forced
# with -CrossMachine. Validates everything a cross-machine session needs and signs
# you in to Azure, failing with a SPECIFIC message for each thing that's missing.
$PG_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default'
$envFile = Join-Path $source '.env'
$envMap = @{}
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -lt 1) { continue }
        $k = $t.Substring(0, $i).Trim()
        $v = $t.Substring($i + 1).Trim()
        if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }
        $envMap[$k] = $v
    }
}
# Overlay the process environment on top of the .env — a shell-exported value
# WINS over the file, matching the runtime (env-file.mjs fills gaps; exported
# vars win), so the preflight validates/connects against exactly what a session
# will use.
foreach ($k in @('AGENT_RELAY_TRANSPORT', 'AGENT_RELAY_PG_HOST', 'AGENT_RELAY_PG_USER', 'AGENT_RELAY_PG_DB', 'AZURE_CONFIG_DIR', 'AGENT_RELAY_AZURE_TENANT')) {
    $val = [Environment]::GetEnvironmentVariable($k)
    if ($val) { $envMap[$k] = $val }
}
$isCrossMachine = $CrossMachine -or ($envMap['AGENT_RELAY_TRANSPORT'] -eq 'postgres')

if ($isCrossMachine) {
    Write-Host "`nCross-machine (Postgres) mode — running setup preflight..." -ForegroundColor Cyan

    # 1. Azure CLI present.
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw "Cross-machine needs the Azure CLI. Install it (https://learn.microsoft.com/cli/azure/install-azure-cli), then re-run."
    }

    # 2. Completeness — the four connection values (from .env or the environment).
    $missing = @('AGENT_RELAY_PG_HOST', 'AGENT_RELAY_PG_USER', 'AGENT_RELAY_PG_DB') | Where-Object { -not $envMap[$_] }
    if ($missing) {
        throw "Cross-machine needs $($missing -join ', '). Set them in extension/.env (copy .env.example) or export them in your shell, then re-run."
    }

    # 3. Dependencies (pg, @azure/identity) — needed to connect + bundled into the install.
    Write-Host "Installing dependencies (npm install)..." -ForegroundColor Cyan
    Push-Location $repoRoot
    try { & npm install --no-audit --no-fund 2>&1 | Out-Host } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE). Fix the error above and re-run." }

    # 4. Azure sign-in. Honor the .env's AZURE_CONFIG_DIR so the token comes from
    #    the same profile a real session uses; auto-launch `az login` if needed.
    #    If AGENT_RELAY_AZURE_TENANT is set, target that tenant directly — required
    #    when the account spans multiple tenants or the DB tenant enforces MFA (a
    #    plain `az login` otherwise fails enumerating other tenants, e.g. AADSTS50076).
    if ($envMap['AZURE_CONFIG_DIR']) { $env:AZURE_CONFIG_DIR = $envMap['AZURE_CONFIG_DIR'] }
    $tenant = $envMap['AGENT_RELAY_AZURE_TENANT']
    $tenantArgs = if ($tenant) { @('--tenant', $tenant) } else { @() }
    & az account get-access-token @tenantArgs --scope $PG_SCOPE --output none 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Not signed in to Azure — launching 'az login' (sign in as the DB admin: $($envMap['AGENT_RELAY_PG_USER']))..." -ForegroundColor Yellow
        & az login @tenantArgs --output none
        if ($LASTEXITCODE -ne 0) {
            $hint = if ($tenant) { "" } else { " If your account spans multiple tenants or the database tenant requires MFA, set AGENT_RELAY_AZURE_TENANT=<tenant-id> in your .env (or run: az login --tenant <tenant-id>)." }
            throw "az login failed (sign in as $($envMap['AGENT_RELAY_PG_USER'])).$hint On a headless machine add --use-device-code."
        }
        & az account get-access-token @tenantArgs --scope $PG_SCOPE --output none 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Still can't mint a Postgres token after login. Check you signed in as the DB admin, the tenant (AGENT_RELAY_AZURE_TENANT), and (if set) AZURE_CONFIG_DIR."
        }
    }
    Write-Host "Azure sign-in OK." -ForegroundColor Green
}

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
    # CODE (everything EXCEPT *.db* and node_modules), then copy extension/ and
    # sync node_modules incrementally. Excluding *.db* keeps the locked runtime DB
    # (a session may hold it open); excluding node_modules lets the robocopy below
    # skip unchanged dependency files, so a re-install is near-instant.
    if (Test-Path -LiteralPath $dest) {
        $existing = Get-Item -LiteralPath $dest -Force
        if ($existing.LinkType) {
            $existing.Delete()
            New-Item -ItemType Directory -Force -Path $dest | Out-Null
        }
        else {
            Get-ChildItem -LiteralPath $dest -Force |
                Where-Object { $_.Name -notlike $dbGlob -and $_.Name -ne 'node_modules' } |
                Remove-Item -Recurse -Force
        }
    }
    else {
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
    }
    Copy-Item -Recurse -Force (Join-Path $source '*') $dest
    # Sync dependencies with robocopy: multithreaded and INCREMENTAL — it skips
    # files whose size+timestamp are unchanged, so re-installs where node_modules
    # didn't change finish in seconds instead of recopying tens of thousands of
    # tiny files. Scoped to node_modules only (the DB lives at the install root and
    # is never touched). robocopy exit codes 0-7 are success; 8+ is a real failure.
    # Cross-machine users ran `npm install`; the single-machine default needs none,
    # so a missing node_modules is fine.
    $deps = Join-Path $repoRoot 'node_modules'
    if (Test-Path -LiteralPath $deps) {
        $destDeps = Join-Path $dest 'node_modules'
        $rcOut = & robocopy $deps $destDeps /E /MT:16 /R:1 /W:1 /NFL /NDL /NJH /NJS /NP 2>&1
        $rc = $LASTEXITCODE
        if ($rc -ge 8) {
            Write-Host ($rcOut | Out-String)
            throw "robocopy failed syncing node_modules (exit $rc). Fix the error above and re-run."
        }
        $mode = 'copied (+ node_modules, incremental)'
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

# --- Cross-machine live verification (the real end-to-end connection) --------
# Exercises the installed extension's real Azure-credential + pg path against the
# shared database. Files are already installed (a failure still leaves a usable
# LOCAL-mode extension), but we fail loudly with the specific reason so the user
# can fix it and re-run.
if ($isCrossMachine) {
    Write-Host "`nVerifying the cross-machine connection..." -ForegroundColor Cyan
    $preflight = Join-Path $scriptDir 'preflight-cross-machine.mjs'
    & node $preflight $dest
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Error "Cross-machine verification FAILED (reason above). The extension is installed and will run in LOCAL mode until this is fixed — re-run this script after fixing it."
        exit 1
    }
    Write-Host "✓ Cross-machine verified — this machine can reach the shared mesh." -ForegroundColor Green
}

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

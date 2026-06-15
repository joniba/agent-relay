#!/usr/bin/env bash
# Install agent-relay as a Copilot CLI extension (macOS / Linux).
#
# Copies this clone's `extension/` folder (plus its `node_modules`, if present)
# into the Copilot CLI extensions directory so the entry lives at
# `~/.copilot/extensions/agent-relay/extension.mjs`. Does NOT launch Copilot.
#
# The default is a self-contained COPY (lock-safe upgrades — preserves *.db*).
# Use --link for a symlink to this clone (dev: `git pull` updates it live).
#
# Usage:
#   scripts/install.sh           # self-contained copy (recommended)
#   scripts/install.sh --link    # dev symlink to this clone
set -euo pipefail

LINK=0
NO_STATUSLINE=0
for arg in "$@"; do
  case "$arg" in
    --link)  LINK=1 ;;
    --no-statusline) NO_STATUSLINE=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' ; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- Locate the source (this script lives in <repo>/scripts) ----------------
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname "$script_dir")"
source_dir="$repo_root/extension"
entry="$source_dir/extension.mjs"
[ -f "$entry" ] || { echo "Cannot find the extension entry at '$entry'. Run this from a clone of agent-relay." >&2; exit 1; }

# --- Node >= 22.5 (required at runtime for node:sqlite) ---------------------
if command -v node >/dev/null 2>&1; then
  ver="$(node --version | sed 's/^v//')"
  maj="${ver%%.*}"; rest="${ver#*.}"; min="${rest%%.*}"
  if [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 5 ]; }; then
    echo "Node $ver (ok)"
  else
    echo "WARNING: Node $ver found, but agent-relay needs >= 22.5.0 (node:sqlite)." >&2
  fi
else
  echo "WARNING: node not found on PATH. agent-relay needs Node >= 22.5.0 at runtime." >&2
fi

# --- Resolve destination ----------------------------------------------------
copilot_home="${COPILOT_HOME:-$HOME/.copilot}"
ext_root="$copilot_home/extensions"
dest="$ext_root/agent-relay"
mkdir -p "$ext_root"

# --- Install: self-contained COPY (default) or a dev SYMLINK (--link) --------
# A copy bundles extension/ + node_modules so the destination is self-contained
# and never depends on this clone staying put. Re-running to upgrade refreshes
# the code in place and PRESERVES runtime state (*.db*) — never even opened — so
# it's safe while a session holds the SQLite DB open. --link instead points the
# destination at this clone (contributors: `git pull` updates it live).
deps_dir="$repo_root/node_modules"

if [ "$LINK" -eq 1 ]; then
  # Dev symlink. Needs a removable destination; a copy whose DB is held open by a
  # running session can't be removed — close those sessions, or use a copy.
  if [ -L "$dest" ]; then rm "$dest"; elif [ -e "$dest" ]; then rm -rf "$dest"; fi
  ln -s "$source_dir" "$dest"
  mode="symlink"
else
  # Self-contained copy, lock-safe: remove existing CODE (everything EXCEPT
  # *.db*), then copy extension/ + node_modules. The locked DB is left in place.
  if [ -L "$dest" ]; then
    rm "$dest"; mkdir -p "$dest"
  elif [ -d "$dest" ]; then
    find "$dest" -mindepth 1 -maxdepth 1 ! -name '*.db*' -exec rm -rf {} +
  else
    mkdir -p "$dest"
  fi
  cp -R "$source_dir"/. "$dest"/
  # Bundle dependencies if present. Cross-machine users ran `npm install`; the
  # single-machine default needs none, so a missing node_modules is fine.
  if [ -d "$deps_dir" ]; then
    cp -R "$deps_dir" "$dest/node_modules"
    mode="copied (+ node_modules)"
  else
    mode="copied (no node_modules — single-machine default only)"
  fi
fi

# --- Verify -----------------------------------------------------------------
[ -f "$dest/extension.mjs" ] || { echo "Install verification failed: '$dest/extension.mjs' is missing." >&2; exit 1; }

echo
echo "✓ Installed agent-relay -> $dest ($mode)"
[ "$mode" = "symlink" ] && echo "  Source: $source_dir  (a later \`git pull\` updates the live extension)"

# --- Statusline: point Copilot's single statusLine slot at agent-relay --------
# agent-relay shows THIS session's locally-generated alias below the prompt.
# This replaces whatever statusLine command was previously configured.
if [ "$NO_STATUSLINE" -eq 0 ]; then
  status_script="$dest/bin/agent-relay-statusline.mjs"
  if [ -f "$status_script" ]; then
    settings="${COPILOT_HOME:-$HOME/.copilot}/settings.json"
    node -e '
      const fs = require("fs"), path = require("path");
      const [p, cmd] = process.argv.slice(1);
      let s = {};
      try { s = JSON.parse(fs.readFileSync(p, "utf8")) || {}; } catch {}
      const prev = s.statusLine && s.statusLine.command ? s.statusLine.command : "(none)";
      s.statusLine = { type: "command", command: cmd };
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
      process.stderr.write("✓ Statusline -> agent-relay (" + p + ")\n");
      if (prev !== cmd) process.stderr.write("  (replaced: " + prev + ")\n");
    ' "$settings" "node \"$status_script\""
  else
    echo "WARNING: statusline script not found at $status_script — skipped." >&2
  fi
fi

cat <<EOF

Next steps (this script does NOT launch Copilot):
  1. (optional) name this session in the mesh:  export AGENT_RELAY_NAME="tia"
  2. start with extensions enabled:             copilot --experimental

On load you'll see: agent-relay: registered as "<alias>" - ready
The same alias renders below the prompt as [<alias>] (statusline).
EOF

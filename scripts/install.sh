#!/usr/bin/env bash
# Install agent-relay as a Copilot CLI extension (macOS / Linux).
#
# Symlinks (or copies) this clone's `extension/` folder into the Copilot CLI
# extensions directory so the entry lives at
# `~/.copilot/extensions/agent-relay/extension.mjs`. Does NOT launch Copilot.
#
# Usage:
#   scripts/install.sh           # symlink (a later `git pull` updates the live extension)
#   scripts/install.sh --copy    # copy the files instead of symlinking
#   scripts/install.sh --force    # replace an existing install at the destination
set -euo pipefail

COPY=0
FORCE=0
NO_STATUSLINE=0
for arg in "$@"; do
  case "$arg" in
    --copy)  COPY=1 ;;
    --force) FORCE=1 ;;
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

# --- Handle an existing destination (idempotent / safe) ---------------------
if [ -e "$dest" ] || [ -L "$dest" ]; then
  if [ "$COPY" -eq 0 ] && [ -L "$dest" ] && [ "$(readlink "$dest")" = "$source_dir" ]; then
    echo "Already installed: $dest -> $source_dir (symlink). Nothing to do."
    echo; echo "Next: run \`copilot --experimental\` in any folder."
    exit 0
  fi
  if [ "$FORCE" -eq 0 ]; then
    echo "Destination '$dest' already exists. Re-run with --force to replace it." >&2
    exit 1
  fi
  echo "WARNING: replacing existing '$dest' (--force)." >&2
  # A symlink is removed as a link only; a real directory is removed recursively.
  if [ -L "$dest" ]; then rm "$dest"; else rm -rf "$dest"; fi
fi

# --- Install: symlink (default) or copy -------------------------------------
if [ "$COPY" -eq 1 ]; then
  mkdir -p "$dest"
  cp -R "$source_dir"/. "$dest"/
  mode="copied"
else
  ln -s "$source_dir" "$dest"
  mode="symlink"
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

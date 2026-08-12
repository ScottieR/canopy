#!/usr/bin/env bash
# One-time setup for the local-sync launchd agent. Safe to re-run (idempotent).
#
# This does NOT run automatically as part of any other script -- you run it yourself,
# once, when you're ready to turn the background sync on.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/run.sh"
PLIST_TEMPLATE="$SCRIPT_DIR/com.canopy.local-sync-master.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.canopy.local-sync-master.plist"

chmod +x "$SCRIPT_DIR/run.sh" "$SCRIPT_DIR/sync-master.sh" "$SCRIPT_DIR/cleanup-merged-worktrees.sh" "$SCRIPT_DIR/../worktree/new-task.sh"
mkdir -p "$HOME/Library/LaunchAgents"

sed "s#__RUN_SCRIPT_PATH__#$RUN_SCRIPT#" "$PLIST_TEMPLATE" > "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

REPO_DIR="${CANOPY_LOCAL_SYNC_REPO:-$HOME/Developer/Agent Management/canopy}"
WORKTREE_ROOT="${CANOPY_WORKTREE_ROOT:-$HOME/Developer/Agent Management/canopy-worktrees}"
echo "Installed. Every 10 minutes this will, in $REPO_DIR:"
echo "  1. fast-forward-pull master -- only when that repo is already on master with a"
echo "     fully clean working tree"
echo "  2. remove any worktree under $WORKTREE_ROOT"
echo "     whose branch has been merged and deleted on origin"
echo
echo "New isolated task: scripts/worktree/new-task.sh <branch-name>"
echo "Logs:              ~/Library/Logs/canopy-local-sync.log"
echo "Uninstall:         launchctl unload $PLIST_DEST && rm $PLIST_DEST"

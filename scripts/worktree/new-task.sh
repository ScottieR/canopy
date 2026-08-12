#!/usr/bin/env bash
# Creates an isolated git worktree for a new Claude/Codex thread to work in, instead of
# sharing the main checkout -- which is what caused two concurrent sessions to see each
# other's in-flight edits to the same files in the same folder.
#
# Usage: scripts/worktree/new-task.sh <branch-name>
#
# Once you push <branch-name> and its PR merges, the local-sync launchd job (see
# scripts/local-sync/) automatically removes this worktree within ~10 minutes -- nothing
# to clean up by hand.
set -euo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <branch-name>" >&2
  exit 1
fi

BRANCH="$1"
REPO_DIR="${CANOPY_LOCAL_SYNC_REPO:-$HOME/Developer/Agent Management/canopy}"
WORKTREE_ROOT="${CANOPY_WORKTREE_ROOT:-$HOME/Developer/Agent Management/canopy-worktrees}"
WORKTREE_PATH="$WORKTREE_ROOT/$BRANCH"

if [ -e "$WORKTREE_PATH" ]; then
  echo "Already exists: $WORKTREE_PATH" >&2
  exit 1
fi

mkdir -p "$WORKTREE_ROOT"
cd "$REPO_DIR"
git fetch origin master --quiet

git worktree add -b "$BRANCH" "$WORKTREE_PATH" origin/master

echo "Worktree ready: $WORKTREE_PATH"
echo "cd \"$WORKTREE_PATH\" and start working. Push '$BRANCH' and open a PR when done --"
echo "it'll be auto-removed once that PR merges."

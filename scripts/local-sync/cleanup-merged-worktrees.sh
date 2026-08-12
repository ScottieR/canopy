#!/usr/bin/env bash
# Removes local git worktrees (created via scripts/worktree/new-task.sh) whose branch
# has already been merged and deleted on origin by the auto-merge pipeline. Companion to
# sync-master.sh -- same safety discipline: only ever acts on state it can prove is safe
# to remove, logs everything, never forces past a dirty tree, never touches anything
# outside the managed worktree directory.
set -euo pipefail

REPO_DIR="${CANOPY_LOCAL_SYNC_REPO:-$HOME/Developer/Agent Management/canopy}"
WORKTREE_ROOT="${CANOPY_WORKTREE_ROOT:-$HOME/Developer/Agent Management/canopy-worktrees}"
LOG_FILE="${CANOPY_LOCAL_SYNC_LOG:-$HOME/Library/Logs/canopy-local-sync.log}"

mkdir -p "$(dirname "$LOG_FILE")"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG_FILE"; }

if [ ! -d "$REPO_DIR/.git" ]; then
  log "SKIP cleanup: $REPO_DIR is not a git repo"
  exit 0
fi
if [ ! -d "$WORKTREE_ROOT" ]; then
  exit 0  # nothing to clean up, nothing to log
fi

cd "$REPO_DIR"
if ! git fetch origin --prune --quiet 2>>"$LOG_FILE"; then
  log "SKIP cleanup: git fetch failed (offline?)"
  exit 0
fi

git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print}' | while IFS= read -r WT; do
  # Only ever touch worktrees under our own managed directory -- never the main
  # checkout, never a worktree someone created by hand elsewhere.
  case "$WT" in
    "$WORKTREE_ROOT"/*) ;;
    *) continue ;;
  esac
  [ -d "$WT" ] || continue

  BRANCH="$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  [ -z "$BRANCH" ] && continue

  if [ -n "$(git -C "$WT" status --porcelain --ignore-submodules 2>/dev/null)" ]; then
    log "SKIP cleanup: $WT (branch '$BRANCH') has uncommitted changes"
    continue
  fi

  if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
    continue  # branch still exists remotely -- not merged/deleted yet, leave it
  fi

  # "No remote ref" is ambiguous by itself -- it also describes a branch that was
  # never pushed at all (still local WIP), which must never be auto-deleted. Checking
  # only branch.<name>.remote is NOT enough to rule that out: `worktree add -b <name>
  # origin/master` (what new-task.sh does) makes git auto-set branch.<name>.remote and
  # branch.<name>.merge to track *master*, from the moment the branch is created --
  # before it's ever been pushed anywhere. The only reliable proof of an actual
  # `push -u origin <name>` is branch.<name>.merge equalling refs/heads/<name> itself
  # (a same-name remote branch) -- that value only gets set by a real push, and (like
  # branch.<name>.remote) survives `fetch --prune` deleting the now-merged remote ref.
  REMOTE_NAME="$(git -C "$WT" config --get "branch.$BRANCH.remote" 2>/dev/null || true)"
  MERGE_REF="$(git -C "$WT" config --get "branch.$BRANCH.merge" 2>/dev/null || true)"
  if [ "$REMOTE_NAME" != "origin" ] || [ "$MERGE_REF" != "refs/heads/$BRANCH" ]; then
    log "SKIP cleanup: $WT (branch '$BRANCH') was never pushed under its own name -- leaving it alone"
    continue
  fi

  log "CLEANUP: removing worktree $WT (branch '$BRANCH' was pushed, no longer on origin -- merged)"
  if git worktree remove "$WT" 2>>"$LOG_FILE"; then
    git branch -D "$BRANCH" 2>>"$LOG_FILE" || true
  else
    log "ERROR: could not remove worktree $WT -- leaving it for manual cleanup"
  fi
done

git worktree prune

#!/usr/bin/env bash
# Safely fast-forward-pulls origin/master into a local Canopy checkout.
#
# Never touches anything if:
#   - the repo isn't currently on the `master` branch
#   - the working tree has any uncommitted changes (staged, unstaged, or untracked)
#   - local master has diverged from origin/master (i.e. isn't a pure fast-forward)
#
# Meant to run unattended on a timer (see com.canopy.local-sync-master.plist), so every
# skip case exits 0 and just logs why -- it must never be noisy about the common,
# expected case of "you're mid-feature on a different branch," and it must never
# force/rebase/reset anything.
set -euo pipefail

REPO_DIR="${CANOPY_LOCAL_SYNC_REPO:-$HOME/Developer/Agent Management/canopy}"
LOG_FILE="${CANOPY_LOCAL_SYNC_LOG:-$HOME/Library/Logs/canopy-local-sync.log}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG_FILE"
}

if [ ! -d "$REPO_DIR/.git" ]; then
  log "SKIP: $REPO_DIR is not a git repo"
  exit 0
fi

cd "$REPO_DIR"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [ "$CURRENT_BRANCH" != "master" ]; then
  log "SKIP: on branch '$CURRENT_BRANCH', not master"
  exit 0
fi

if [ -n "$(git status --porcelain --ignore-submodules 2>/dev/null)" ]; then
  log "SKIP: working tree is dirty"
  exit 0
fi

if ! git fetch origin master --quiet 2>>"$LOG_FILE"; then
  log "SKIP: git fetch failed (offline?)"
  exit 0
fi

LOCAL_SHA="$(git rev-parse master)"
REMOTE_SHA="$(git rev-parse origin/master)"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  log "OK: already up to date ($LOCAL_SHA)"
  exit 0
fi

MERGE_BASE="$(git merge-base master origin/master)"
if [ "$MERGE_BASE" != "$LOCAL_SHA" ]; then
  log "SKIP: local master has diverged from origin/master ($LOCAL_SHA vs $REMOTE_SHA) -- not a fast-forward, resolve by hand"
  exit 0
fi

if git merge --ff-only origin/master --quiet 2>>"$LOG_FILE"; then
  log "OK: fast-forwarded master $LOCAL_SHA -> $REMOTE_SHA"
else
  log "ERROR: fast-forward merge failed unexpectedly"
  exit 1
fi

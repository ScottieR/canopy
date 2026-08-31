#!/usr/bin/env bash
# Reports work that exists ONLY on this machine: uncommitted changes, commits that were
# never pushed, or branches with no upstream at all.
#
# Why this exists: cleanup-merged-worktrees.sh deliberately refuses to touch a worktree
# that is dirty or was never pushed under its own name. That refusal is correct -- it is
# the only thing standing between an abandoned experiment and permanent data loss -- but
# by itself it is silent. It writes one SKIP line into a log nobody opens, and the
# worktree then sits on disk looking exactly like the merged ones around it.
#
# That is how three separate piles of real work (a conductor/worker orchestration layer,
# a connect-widget server, an mDNS discovery module) sat unpushed for over a week in
# August 2026 while the merged worktrees they were hiding among were cleaned up around
# them. Nothing was broken. Nothing reported it either.
#
# So: cleanup-merged-worktrees.sh removes what is provably safe to remove, and this
# reports what is provably NOT safe to remove. Two halves of the same job.
#
# This script only ever READS git state. It never commits, pushes, or deletes.
set -uo pipefail

WORKSPACE_ROOT="${CANOPY_WORKSPACE_ROOT:-$HOME/Developer/Agent Management}"
WORKTREE_ROOT="${CANOPY_WORKTREE_ROOT:-$WORKSPACE_ROOT/canopy-worktrees}"
REPORT="${CANOPY_STRANDED_REPORT:-$HOME/Library/Logs/canopy-stranded-work.md}"
STATE="${CANOPY_STRANDED_STATE:-$HOME/Library/Logs/.canopy-stranded-state}"
LOG_FILE="${CANOPY_LOCAL_SYNC_LOG:-$HOME/Library/Logs/canopy-local-sync.log}"

# How long work may sit local-only before it is considered stranded rather than simply
# in-progress. Anything under this is normal mid-task state and is reported but not
# alerted on.
STRANDED_AFTER_DAYS="${CANOPY_STRANDED_AFTER_DAYS:-3}"

mkdir -p "$(dirname "$REPORT")"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG_FILE"; }

NOW=$(date +%s)
STRANDED_COUNT=0
SIGNATURE=""
BODY=""

# Newest mtime across modified + untracked files == when this work was last touched.
# Newest rather than oldest on purpose: the question is "has anyone come back to this",
# not "when did it start".
last_touched() {
  local d="$1" newest=0 f m
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$d/$f" ] || continue
    m=$(stat -f %m "$d/$f" 2>/dev/null) || continue
    [ "$m" -gt "$newest" ] && newest=$m
  done < <(git -C "$d" ls-files -m -o --exclude-standard 2>/dev/null | head -500)
  echo "$newest"
}

examine() {
  local d="$1" label="$2"
  git -C "$d" rev-parse --git-dir >/dev/null 2>&1 || return 0

  local branch dirty unpushed upstream age_days newest issues="" worst=0
  branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null) || return 0
  dirty=$(git -C "$d" status --porcelain --ignore-submodules 2>/dev/null | wc -l | tr -d ' ')
  upstream=$(git -C "$d" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "")

  if [ "$dirty" != "0" ]; then
    newest=$(last_touched "$d")
    if [ "$newest" -gt 0 ]; then
      age_days=$(( (NOW - newest) / 86400 ))
      [ "$age_days" -gt "$worst" ] && worst=$age_days
      issues="${issues}    - ${dirty} uncommitted file(s), last touched ${age_days}d ago\n"
    else
      issues="${issues}    - ${dirty} uncommitted file(s)\n"
    fi
  fi

  if [ -z "$upstream" ]; then
    # No upstream: nothing on this branch has ever left the machine. Age this by the
    # branch tip's commit date rather than treating it as instantly stranded -- the
    # fleet creates branches constantly, and one made five minutes ago is just work in
    # progress. It only matters once nobody has come back to it.
    local n has_remote tip_ts
    n=$(git -C "$d" rev-list --count HEAD 2>/dev/null || echo 0)
    has_remote=$(git -C "$d" remote 2>/dev/null | head -1)
    if [ "$n" != "0" ] && [ "$branch" != "HEAD" ]; then
      tip_ts=$(git -C "$d" log -1 --format=%ct HEAD 2>/dev/null)
      if [ -z "$has_remote" ]; then
        # No remote configured at all -- the whole repo is unbacked-up, not just a branch.
        issues="${issues}    - repo has NO git remote configured -- nothing here is backed up\n"
        worst=$(( STRANDED_AFTER_DAYS + 1 ))
      elif [ -n "$tip_ts" ]; then
        age_days=$(( (NOW - tip_ts) / 86400 ))
        [ "$age_days" -gt "$worst" ] && worst=$age_days
        issues="${issues}    - branch '${branch}' has NO upstream -- never pushed (tip ${age_days}d old)\n"
      else
        issues="${issues}    - branch '${branch}' has NO upstream -- never pushed\n"
      fi
    fi
  else
    unpushed=$(git -C "$d" rev-list --count "${upstream}..HEAD" 2>/dev/null || echo 0)
    if [ "$unpushed" != "0" ]; then
      local oldest_ts
      oldest_ts=$(git -C "$d" log --format=%ct "${upstream}..HEAD" 2>/dev/null | tail -1)
      if [ -n "$oldest_ts" ]; then
        age_days=$(( (NOW - oldest_ts) / 86400 ))
        [ "$age_days" -gt "$worst" ] && worst=$age_days
        issues="${issues}    - ${unpushed} commit(s) not pushed to ${upstream}, oldest ${age_days}d old\n"
      else
        issues="${issues}    - ${unpushed} commit(s) not pushed to ${upstream}\n"
      fi
    fi
  fi

  [ -z "$issues" ] && return 0

  local flag="" 
  if [ "$worst" -ge "$STRANDED_AFTER_DAYS" ]; then
    flag=" **[STRANDED]**"
    STRANDED_COUNT=$((STRANDED_COUNT + 1))
    SIGNATURE="${SIGNATURE}${d}:${worst};"
  fi
  BODY="${BODY}\n- \`${label}\` (${branch})${flag}\n${issues}"
}

# The canopy repo drives worktree discovery; sibling repos are scanned as plain repos.
CANOPY_DIR="$WORKSPACE_ROOT/canopy"
if git -C "$CANOPY_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  while IFS= read -r wt; do
    [ -d "$wt" ] || continue
    examine "$wt" "${wt#$WORKSPACE_ROOT/}"
  done < <(git -C "$CANOPY_DIR" worktree list --porcelain | awk '/^worktree /{sub(/^worktree /,""); print}')
fi

for d in "$WORKSPACE_ROOT"/*/ "$WORKSPACE_ROOT"/../*/; do
  d="${d%/}"
  [ -d "$d" ] || continue
  case "$d" in
    "$CANOPY_DIR"|"$WORKTREE_ROOT"*) continue ;;
  esac
  git -C "$d" rev-parse --git-dir >/dev/null 2>&1 || continue
  # Skip worktrees already covered above.
  [ -f "$d/.git" ] && grep -q "gitdir:.*canopy/.git" "$d/.git" 2>/dev/null && continue
  examine "$d" "$(basename "$d")"
done

{
  printf '# Local-only work\n\n'
  printf 'Generated %s\n\n' "$(date '+%Y-%m-%d %H:%M')"
  if [ -z "$BODY" ]; then
    printf 'Nothing local-only. Every branch is pushed and every tree is clean.\n'
  else
    printf 'Work below exists only on this machine. Anything marked **[STRANDED]** has\n'
    printf 'been sitting for %s+ days.\n' "$STRANDED_AFTER_DAYS"
    printf '%b\n' "$BODY"
  fi
} > "$REPORT"

if [ "$STRANDED_COUNT" -gt 0 ]; then
  # Notify at most once per 24h per unique stranded set, so a genuinely parked branch
  # does not nag every 10 minutes -- but a NEW one alerts immediately.
  SIG_HASH=$(printf '%s' "$SIGNATURE" | shasum | awk '{print $1}')
  PREV_HASH=""; PREV_TIME=0
  [ -f "$STATE" ] && { PREV_HASH=$(awk 'NR==1' "$STATE"); PREV_TIME=$(awk 'NR==2' "$STATE"); }
  PREV_TIME=${PREV_TIME:-0}
  if [ "$SIG_HASH" != "$PREV_HASH" ] || [ $((NOW - PREV_TIME)) -ge 86400 ]; then
    osascript -e "display notification \"${STRANDED_COUNT} place(s) have work that was never pushed. See canopy-stranded-work.md\" with title \"Canopy: local-only work\"" 2>/dev/null || true
    printf '%s\n%s\n' "$SIG_HASH" "$NOW" > "$STATE"
    log "STRANDED: $STRANDED_COUNT location(s) with local-only work -- notified"
  fi
else
  rm -f "$STATE"
fi

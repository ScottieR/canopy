#!/usr/bin/env bash
# Entry point the launchd agent actually calls. Runs the local-sync steps in order;
# each is independently safe to fail without affecting the others.
#
# The three steps are deliberately complementary:
#   sync-master              -- keeps local master current, so "nothing is merging"
#                               never becomes an illusion created by a stale checkout
#   cleanup-merged-worktrees -- removes what is provably safe to remove
#   report-stranded-work     -- surfaces what is provably NOT safe to remove, which
#                               cleanup silently skips by design
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$DIR/sync-master.sh"
bash "$DIR/cleanup-merged-worktrees.sh"
bash "$DIR/report-stranded-work.sh"

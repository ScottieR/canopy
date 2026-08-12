#!/usr/bin/env bash
# Entry point the launchd agent actually calls. Runs both local-sync steps in order;
# each is independently safe to fail without affecting the other.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$DIR/sync-master.sh"
bash "$DIR/cleanup-merged-worktrees.sh"

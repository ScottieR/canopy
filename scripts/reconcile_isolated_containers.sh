#!/usr/bin/env bash
#
# reconcile_isolated_containers.sh — find and remove zombie isolated agent containers.
#
# WHY THIS EXISTS
# ---------------
# `toggle_agent_isolation(false)` tears the isolated container down with
# `docker compose down` as a BEST-EFFORT call (`let _ = …` in openclaw.rs) — the exit
# status is never checked. The generated compose sets `restart: unless-stopped`
# (docker.rs::generate_isolated_compose). So if that teardown ever fails or is
# interrupted, the container:
#
#   * is never removed,
#   * comes back on every OrbStack/Docker daemon start, forever,
#   * keeps a STALE openclaw.json (old skills, old API keys, old channel config),
#   * holds its own Slack socket and can still act on that stale config,
#   * consumes up to its 2 GB memory cap in the OrbStack VM.
#
# All app→container routing goes through `get_agent_container_name`, which reads the
# DB, so a zombie receives no traffic from Canopy. It is invisible in the UI and
# unmanaged — which is exactly what makes it easy to miss.
#
# WHAT COUNTS AS A ZOMBIE
# -----------------------
# A container labelled `com.canopy.type=isolated` whose `com.canopy.agent-id` either
# (a) has `isolated = 0` in the agents table, or (b) no longer exists in the DB.
#
# USAGE
# -----
#   ./scripts/reconcile_isolated_containers.sh              # report only (default)
#   ./scripts/reconcile_isolated_containers.sh --apply      # actually remove zombies
#   ./scripts/reconcile_isolated_containers.sh --apply --yes # skip the confirmation
#
# Nothing is removed without --apply. Quit Canopy before running with --apply so the
# app can't recreate a container mid-run.

set -euo pipefail

APPLY=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

DB_PATH="${CANOPY_DB_PATH:-$HOME/Library/Application Support/Canopy/canopy.db}"
DATA_DIR="${CANOPY_DATA_DIR:-$HOME/Library/Application Support/Canopy}"

for tool in docker sqlite3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found on PATH" >&2; exit 1; }
done

if [[ ! -f "$DB_PATH" ]]; then
  echo "error: Canopy database not found at: $DB_PATH" >&2
  echo "       set CANOPY_DB_PATH if it lives elsewhere." >&2
  exit 1
fi

docker info >/dev/null 2>&1 || { echo "error: Docker/OrbStack is not responding." >&2; exit 1; }

# ── Gather state ─────────────────────────────────────────────────────────────
# Read the container inventory from labels rather than parsing names: the label is
# written by generate_isolated_compose and survives renames.
#
# NOTE: built with a while-read loop rather than `mapfile`, which is bash 4+ only —
# stock macOS still ships bash 3.2 at /bin/bash.
CONTAINER_ROWS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && CONTAINER_ROWS+=("$line")
done < <(
  docker ps -a \
    --filter 'label=com.canopy.type=isolated' \
    --format '{{.Label "com.canopy.agent-id"}}|{{.Names}}|{{.State}}' \
    | sed '/^|/d'
)

if [[ ${#CONTAINER_ROWS[@]} -eq 0 ]]; then
  echo "No isolated agent containers found. Nothing to reconcile."
  exit 0
fi

# `isolated` is stored as a SQLite boolean (0/1).
ISOLATED_IDS="$(sqlite3 "$DB_PATH" "SELECT id FROM agents WHERE isolated = 1;" || true)"
KNOWN_IDS="$(sqlite3 "$DB_PATH" "SELECT id FROM agents;" || true)"

in_list() {
  local needle="$1" list="$2" line
  while IFS= read -r line; do
    [[ "$line" == "$needle" ]] && return 0
  done <<< "$list"
  return 1
}

# ── Classify ─────────────────────────────────────────────────────────────────
ZOMBIES=()
printf '%-34s %-30s %-10s %s\n' "CONTAINER" "AGENT ID" "STATE" "VERDICT"
printf '%s\n' "------------------------------------------------------------------------------------------------"

for row in "${CONTAINER_ROWS[@]}"; do
  agent_id="${row%%|*}"
  rest="${row#*|}"
  name="${rest%%|*}"
  state="${rest#*|}"

  if in_list "$agent_id" "$ISOLATED_IDS"; then
    verdict="keep — agent is isolated in the DB"
  elif ! in_list "$agent_id" "$KNOWN_IDS"; then
    verdict="ZOMBIE — agent no longer exists in the DB"
    ZOMBIES+=("$name|$agent_id")
  else
    verdict="ZOMBIE — agent is shared-gateway in the DB"
    ZOMBIES+=("$name|$agent_id")
  fi

  printf '%-34s %-30s %-10s %s\n' "$name" "$agent_id" "$state" "$verdict"
done

echo
if [[ ${#ZOMBIES[@]} -eq 0 ]]; then
  echo "All isolated containers match the database. Nothing to do."
  exit 0
fi

echo "Found ${#ZOMBIES[@]} zombie container(s)."

if [[ $APPLY -eq 0 ]]; then
  cat <<EOF

Dry run — nothing was changed. Re-run with --apply to remove them:

    $0 --apply

For each zombie this will:
  1. docker rm -f <container>                     (stops and removes it)
  2. move its compose file aside                  (docker-compose-<id>.yml.orphaned)
  3. LEAVE its state/workspace directory in place (isolated/<id>/ — your data)

The agent's state directory is never touched, so re-isolating the agent later
restores it exactly as it was.
EOF
  exit 0
fi

# ── Apply ────────────────────────────────────────────────────────────────────
if pgrep -x "canopy" >/dev/null 2>&1; then
  echo "warning: Canopy appears to be running. It may recreate containers while this runs." >&2
  echo "         Quit Canopy first for a clean reconcile." >&2
  echo
fi

if [[ $ASSUME_YES -eq 0 ]]; then
  read -r -p "Remove ${#ZOMBIES[@]} container(s)? Their state directories are kept. [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

removed=0
for entry in "${ZOMBIES[@]}"; do
  name="${entry%%|*}"
  agent_id="${entry#*|}"

  echo "→ removing $name"
  if docker rm -f "$name" >/dev/null; then
    removed=$((removed + 1))
  else
    echo "  ! docker rm failed for $name — skipping the rest of its cleanup" >&2
    continue
  fi

  # Retire the compose file so no stray `compose up` resurrects it, and so the next
  # legitimate isolation writes a fresh one.
  compose_file="$DATA_DIR/docker-compose-$agent_id.yml"
  if [[ -f "$compose_file" ]]; then
    mv "$compose_file" "$compose_file.orphaned"
    echo "  · compose file moved to $(basename "$compose_file").orphaned"
  fi

  # The per-agent network is created by the compose project and left behind once the
  # container is gone. Harmless, but it clutters `docker network ls`.
  if docker network inspect "isolated-$agent_id" >/dev/null 2>&1; then
    docker network rm "isolated-$agent_id" >/dev/null 2>&1 \
      && echo "  · removed network isolated-$agent_id" \
      || echo "  · network isolated-$agent_id still in use, left in place"
  fi

  echo "  · state kept at $DATA_DIR/isolated/$agent_id"
done

echo
echo "Removed $removed of ${#ZOMBIES[@]} zombie container(s)."
echo "Verify with: docker ps -a --filter label=com.canopy.type=isolated"

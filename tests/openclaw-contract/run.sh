#!/usr/bin/env bash
# ─── OpenClaw Engine Contract Tests ──────────────────────────────────────────
#
# Detects behavioral changes in the OpenClaw engine BEFORE they break Canopy.
# Every test here encodes a contract Canopy depends on, and each one maps to a
# real breakage that shipped to users because nothing checked it:
#
#   T0  engine identity guard      → "the engine changed and nobody noticed"
#   T1  config schema acceptance   → gateway.token schema rejection crash-loop
#   T2  model format round-trip    → {"primary": ...} object vs bare string
#   T3  catalog/model acceptance   → claude-sonnet-5 falling through to the
#                                    openai-responses transport
#   T4  auth delivery contract     → July 2026: auth-profiles.json became
#                                    legacy; secrets moved to per-agent sqlite
#                                    (openclaw-agent.sqlite), imported only by
#                                    `doctor --fix` → "No API key found" fleet-wide
#   T5  fallbacks acceptance       → agents.defaults.model.fallbacks must keep
#                                    being read (our runtime failover depends on it)
#
# Usage:
#   ./run.sh                       # test the pinned image (from docker.rs)
#   IMAGE=ghcr.io/openclaw/openclaw:latest ./run.sh   # canary against upstream
#   UPDATE_EXPECTED=1 ./run.sh     # accept current engine identity as expected
#
# Run this: in CI on every PR that touches docker.rs/openclaw.rs, on a weekly
# schedule against :latest (early warning), and ALWAYS before bumping the
# pinned image tag.
#
# Requires: docker (OrbStack or Docker Desktop) on the host.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Keep in sync with src-tauri/src/docker.rs (grep 'ghcr.io/openclaw/openclaw').
PINNED_IMAGE="ghcr.io/openclaw/openclaw:2026.7.1"
IMAGE="${IMAGE:-$PINNED_IMAGE}"
EXPECTED_FILE="$SCRIPT_DIR/expected-engine.txt"

STATE_DIR="$(mktemp -d /tmp/openclaw-contract.XXXXXX)"
AGENT_ID="contract-test-agent"
DUMMY_GEMINI_KEY="AIzaContractTestDummyKey000000000000000"
PASS=0; FAIL=0; WARN=0

cleanup() { rm -rf "$STATE_DIR"; }
trap cleanup EXIT

# Run the openclaw CLI in a throwaway container against our scratch state dir.
# --entrypoint pins the binary so a changed image entrypoint can't silently
# turn these into gateway boots. Stdin closed: prompts get EOF, never hang.
oc() {
  timeout 90 docker run --rm \
    -v "$STATE_DIR:/home/node/.openclaw" \
    --entrypoint openclaw \
    "$IMAGE" "$@" 2>&1
}

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; [ -n "${2:-}" ] && echo "        └─ $2"; }
warn() { WARN=$((WARN+1)); echo "  WARN  $1"; [ -n "${2:-}" ] && echo "        └─ $2"; }

echo "OpenClaw contract tests — image: $IMAGE"
echo "State dir: $STATE_DIR"
echo

# ─── T0: Engine identity guard ───────────────────────────────────────────────
# Fails when the engine version or image digest changes without a conscious
# update to expected-engine.txt. This is the test that answers "did the engine
# change under us?" — a tag like :2026.7.1 can be re-pushed upstream, and a
# tag bump in docker.rs should never land without re-running this suite.
echo "T0: engine identity guard"
VERSION="$(oc --version | tail -1 | tr -d '\r')"
DIGEST="$(docker image inspect --format '{{ range .RepoDigests }}{{ . }}{{ end }}' "$IMAGE" 2>/dev/null | head -c 120)"
IDENTITY="version=$VERSION digest=$DIGEST"
if [ "${UPDATE_EXPECTED:-0}" = "1" ] || [ ! -f "$EXPECTED_FILE" ]; then
  echo "$IDENTITY" > "$EXPECTED_FILE"
  warn "expected engine identity (re)recorded" "$IDENTITY"
elif [ "$(cat "$EXPECTED_FILE")" = "$IDENTITY" ]; then
  ok "engine identity unchanged ($VERSION)"
else
  bad "ENGINE CHANGED: $IDENTITY" "expected: $(cat "$EXPECTED_FILE") — review release notes, re-run suite, then UPDATE_EXPECTED=1"
fi

# ─── T1: Config schema acceptance ────────────────────────────────────────────
# Canopy's canonical config keys must be accepted. A schema rejection here
# previously crash-looped the container (top-level gateway.token).
echo "T1: config schema acceptance"
mkdir -p "$STATE_DIR"
cat > "$STATE_DIR/openclaw.json" <<'EOF'
{
  "gateway": {
    "auth": { "mode": "token", "token": "contract_test_token_000000000000" },
    "mode": "local",
    "port": 18789
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-5",
        "fallbacks": ["anthropic/claude-haiku-4-5", "google/gemini-3.6-flash"]
      },
      "models": { "anthropic/claude-sonnet-5": {} },
      "skills": ["gog", "summarize"]
    }
  }
}
EOF
OUT="$(oc config get gateway.auth.mode)"
if echo "$OUT" | grep -q "token"; then
  ok "canonical config parses and gateway.auth.mode reads back"
else
  bad "config get failed on canonical Canopy config" "$OUT"
fi

# ─── T2: Model format round-trip ─────────────────────────────────────────────
# `config set agents.defaults.model.primary` must produce/accept the nested
# {"primary": ...} object. A bare-string regression silently mutes agents.
echo "T2: model format round-trip"
oc config set agents.defaults.model.primary "anthropic/claude-sonnet-5" >/dev/null
OUT="$(oc config get agents.defaults.model)"
if echo "$OUT" | grep -q "primary" && echo "$OUT" | grep -q "claude-sonnet-5"; then
  ok "model.primary round-trips in nested object format"
else
  bad "model.primary did not round-trip as {\"primary\": ...}" "$OUT"
fi

# ─── T3: Catalog / model acceptance ──────────────────────────────────────────
# Every model Canopy offers must be resolvable by the engine. When the bundled
# provider catalog lags (e.g. claude-sonnet-5 missing), OpenClaw's resolver
# used to fall through to the openai-responses transport and fail auth.
echo "T3: catalog acceptance for Canopy's model IDs"
MODELS_JSON="$SCRIPT_DIR/../../shared/models.json"
LIST_OUT="$(oc models list --all --plain || true)"
MISSING=""
if [ -f "$MODELS_JSON" ] && [ -n "$LIST_OUT" ]; then
  for id in $(python3 -c "import json;print(' '.join(m['id'] for m in json.load(open('$MODELS_JSON'))['models']))" 2>/dev/null); do
    echo "$LIST_OUT" | grep -q "$id" || MISSING="$MISSING $id"
  done
  if [ -z "$MISSING" ]; then
    ok "all $(python3 -c "import json;print(len(json.load(open('$MODELS_JSON'))['models']))") catalog models known to engine"
  else
    warn "models not in engine catalog (verify transport before default-ing):" "$MISSING"
  fi
else
  warn "could not run catalog check" "models list output empty or shared/models.json missing"
fi

# ─── T4: Auth delivery contract (THE July 2026 bug) ──────────────────────────
# Canopy delivers API keys by writing auth-profiles.json. The engine contract
# we rely on TODAY: after `doctor --fix`, that key is visible as effective
# auth. We also probe whether the legacy file is still read directly — when
# that flips (either direction), we want a signal, not a fleet outage.
echo "T4: auth delivery contract"
mkdir -p "$STATE_DIR/agents/$AGENT_ID/agent"
cat > "$STATE_DIR/agents/$AGENT_ID/agent/auth-profiles.json" <<EOF
{
  "version": 1,
  "profiles": {
    "google:default": { "type": "api_key", "provider": "google", "key": "$DUMMY_GEMINI_KEY" }
  }
}
EOF
cp "$STATE_DIR/agents/$AGENT_ID/agent/auth-profiles.json" "$STATE_DIR/agents/$AGENT_ID/auth-profiles.json"

# 4a — behavior probe: is the legacy JSON read directly (pre-2026.7 behavior)?
STATUS_BEFORE="$(oc models status --agent "$AGENT_ID" 2>/dev/null || oc models status)"
if echo "$STATUS_BEFORE" | grep -qi "google"; then
  warn "engine reads legacy auth-profiles.json DIRECTLY (pre-July-2026 behavior)" \
       "if this starts passing again, the engine reverted — keep import_auth_into_store anyway"
else
  ok "confirmed: legacy auth-profiles.json is NOT read directly (sqlite auth store era)"
fi

# 4b — the contract our fix depends on: doctor --fix imports legacy JSON.
DOCTOR_OUT="$(oc doctor --fix </dev/null || true)"
STATUS_AFTER="$(oc models status --agent "$AGENT_ID" 2>/dev/null || oc models status)"
if echo "$STATUS_AFTER" | grep -qi "google"; then
  ok "doctor --fix imports legacy auth-profiles.json into the auth store"
elif ls "$STATE_DIR/agents/$AGENT_ID/agent/"openclaw-agent.sqlite* >/dev/null 2>&1 && \
     command -v sqlite3 >/dev/null 2>&1 && \
     sqlite3 "$STATE_DIR/agents/$AGENT_ID/agent/openclaw-agent.sqlite" \
       "SELECT 1" >/dev/null 2>&1 && \
     grep -q "google" <(sqlite3 "$STATE_DIR/agents/$AGENT_ID/agent/openclaw-agent.sqlite" ".dump" 2>/dev/null); then
  ok "doctor --fix imported the key (verified in openclaw-agent.sqlite)"
else
  bad "AUTH DELIVERY BROKEN: key invisible even after doctor --fix" \
      "Canopy's import_auth_into_store path no longer works — agents will report 'No API key found'. doctor output: $(echo "$DOCTOR_OUT" | tail -3 | tr '\n' ' ')"
fi

# ─── T5: Fallbacks acceptance ────────────────────────────────────────────────
# Runtime failover depends on the engine honoring agents.defaults.model.fallbacks.
echo "T5: fallbacks acceptance"
OUT="$(oc config get agents.defaults.model.fallbacks)"
if echo "$OUT" | grep -q "claude-haiku-4-5"; then
  ok "model.fallbacks reads back from config"
else
  bad "model.fallbacks not readable — runtime failover chain may be ignored" "$OUT"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo
echo "Summary: $PASS passed, $FAIL failed, $WARN warnings"
if [ "$FAIL" -gt 0 ]; then
  echo "CONTRACT FAILURE — do not bump the pinned image / do not ship until resolved."
  exit 1
fi
exit 0

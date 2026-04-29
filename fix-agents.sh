#!/usr/bin/env bash
# fix-agents.sh — Force-register all Canopy agents and write auth-profiles.
# Run this from Terminal: bash fix-agents.sh
set -euo pipefail

DOCKER="${HOME}/.orbstack/bin/docker"
DB="${HOME}/Library/Application Support/Canopy/canopy.db"

echo "=== Canopy Agent Fix Script ==="
echo ""

# ── 1. Check container is running ──────────────────────────────────────────
echo "[1/6] Checking gateway container..."
STATUS=$("$DOCKER" inspect canopy-gateway --format='{{.State.Status}}' 2>&1 || echo "missing")
if [[ "$STATUS" != "running" ]]; then
  echo "  ✗ Container is '$STATUS', not running."
  echo "    Start the Canopy app and wait for the gateway to come up, then re-run this script."
  exit 1
fi
echo "  ✓ canopy-gateway is running"

# ── 2. Read API keys from Canopy keychain vault ────────────────────────────
echo ""
echo "[2/6] Reading API keys from Keychain..."
VAULT_JSON=$(security find-generic-password -s "com.canopy.app" -a "canopy_vault_v2" -w 2>/dev/null || echo "{}")

extract_key() {
  echo "$VAULT_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1',''))" 2>/dev/null || echo ""
}

GEMINI_KEY=$(extract_key "GEMINI_API_KEY")
ANTHROPIC_KEY=$(extract_key "ANTHROPIC_API_KEY")
OPENAI_KEY=$(extract_key "OPENAI_API_KEY")

if [[ -z "$GEMINI_KEY" && -z "$ANTHROPIC_KEY" && -z "$OPENAI_KEY" ]]; then
  echo "  ✗ No API keys found in Keychain. Add keys via Canopy → Integrations first."
  exit 1
fi
[[ -n "$GEMINI_KEY" ]]    && echo "  ✓ GEMINI_API_KEY found"
[[ -n "$ANTHROPIC_KEY" ]] && echo "  ✓ ANTHROPIC_API_KEY found"
[[ -n "$OPENAI_KEY" ]]    && echo "  ✓ OPENAI_API_KEY found"

# Build auth-profiles JSON for the available keys
build_auth_profiles() {
  python3 - "$1" "$2" "$3" <<'PYEOF'
import sys, json

gemini, anthropic, openai = sys.argv[1], sys.argv[2], sys.argv[3]
profiles = {}
if gemini:
    profiles["google:default"] = {"type": "api_key", "provider": "google", "key": gemini}
if anthropic:
    profiles["anthropic:default"] = {"type": "api_key", "provider": "anthropic", "key": anthropic}
if openai:
    profiles["openai:default"] = {"type": "api_key", "provider": "openai", "key": openai}
print(json.dumps({"version": 1, "profiles": profiles}, indent=2))
PYEOF
}

AUTH_JSON=$(build_auth_profiles "$GEMINI_KEY" "$ANTHROPIC_KEY" "$OPENAI_KEY")

# ── 3. Get list of active agents from SQLite ────────────────────────────────
echo ""
echo "[3/6] Reading agents from SQLite..."
if ! command -v sqlite3 &>/dev/null; then
  echo "  ✗ sqlite3 not found. Install Xcode CLI tools: xcode-select --install"
  exit 1
fi
AGENTS=$(sqlite3 "$DB" "SELECT id FROM agents WHERE paused = 0;" 2>/dev/null || echo "")
if [[ -z "$AGENTS" ]]; then
  echo "  ✗ No active agents in database. Create an agent in the Canopy app first."
  exit 1
fi
echo "  ✓ Active agents: $(echo "$AGENTS" | tr '\n' ' ')"

# ── 4. Wait for [gateway] ready ─────────────────────────────────────────────
echo ""
echo "[4/6] Waiting for OpenClaw gateway to be ready..."
for i in $(seq 1 30); do
  LOGS=$("$DOCKER" logs --tail=50 canopy-gateway 2>&1 || echo "")
  if echo "$LOGS" | grep -q "\[gateway\] ready"; then
    echo "  ✓ Gateway is ready"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "  ✗ Gateway did not become ready after 60s. Check OrbStack and try again."
    exit 1
  fi
  echo "  ... waiting (${i}/30)"
  sleep 2
done

# ── 5. Register each agent and write auth-profiles ──────────────────────────
echo ""
echo "[5/6] Registering agents..."
for AGENT_ID in $AGENTS; do
  echo ""
  echo "  → $AGENT_ID"

  # Get agent-specific key if set, fall back to global
  AGENT_GEMINI=$(extract_key "agent_${AGENT_ID}_gemini_key")
  AGENT_ANTHROPIC=$(extract_key "agent_${AGENT_ID}_anthropic_key")
  AGENT_OPENAI=$(extract_key "agent_${AGENT_ID}_openai_key")
  [[ -z "$AGENT_GEMINI" ]]    && AGENT_GEMINI="$GEMINI_KEY"
  [[ -z "$AGENT_ANTHROPIC" ]] && AGENT_ANTHROPIC="$ANTHROPIC_KEY"
  [[ -z "$AGENT_OPENAI" ]]    && AGENT_OPENAI="$OPENAI_KEY"

  AGENT_AUTH=$(build_auth_profiles "$AGENT_GEMINI" "$AGENT_ANTHROPIC" "$AGENT_OPENAI")

  # Create workspace dir
  "$DOCKER" exec -u node canopy-gateway mkdir -p "/home/node/.openclaw/workspace/${AGENT_ID}" 2>&1 || true

  # Register with openclaw
  ADD_OUT=$("$DOCKER" exec -u node \
    -e "NODE_OPTIONS=--v8-pool-size=1 --max-old-space-size=512" \
    canopy-gateway \
    openclaw agents add "$AGENT_ID" \
    --workspace "/home/node/.openclaw/workspace/${AGENT_ID}" 2>&1 || echo "exit $?")
  if echo "$ADD_OUT" | grep -qE "Agent dir:|already exists|already registered"; then
    echo "    ✓ registered"
  else
    echo "    ⚠ agents add output: $(echo "$ADD_OUT" | tail -3)"
  fi

  # Create agent dir and write auth-profiles
  "$DOCKER" exec -u node canopy-gateway \
    mkdir -p "/home/node/.openclaw/agents/${AGENT_ID}/agent" 2>&1 || true

  echo "$AGENT_AUTH" | "$DOCKER" exec -i -u node canopy-gateway \
    sh -c "cat > /home/node/.openclaw/agents/${AGENT_ID}/agent/auth-profiles.json && \
           chmod 600 /home/node/.openclaw/agents/${AGENT_ID}/agent/auth-profiles.json && \
           cp /home/node/.openclaw/agents/${AGENT_ID}/agent/auth-profiles.json \
              /home/node/.openclaw/agents/${AGENT_ID}/auth-profiles.json" 2>&1 || true
  echo "    ✓ auth-profiles written"

  # Brief pause between agents to avoid config mutation conflicts
  sleep 3
done

# ── 6. Smoke test ──────────────────────────────────────────────────────────
echo ""
echo "[6/6] Smoke testing first agent..."
FIRST_AGENT=$(echo "$AGENTS" | head -1)
echo "  Sending test message to $FIRST_AGENT..."
TEST_OUT=$("$DOCKER" exec -u node \
  -e "NODE_OPTIONS=--v8-pool-size=1" \
  canopy-gateway \
  openclaw agent --agent "$FIRST_AGENT" -m "Reply with just: OK" --json 2>&1)

if echo "$TEST_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['payloads'][0]['text'])" 2>/dev/null; then
  echo "  ✓ Agent is responding!"
else
  echo "  ⚠ Could not parse response (may still be initializing — try again in 30s):"
  echo "$TEST_OUT" | head -5
fi

echo ""
echo "=== Done. Agents are registered and auth-profiles are written. ==="
echo "    Go back to Canopy and send a message — it should work now."

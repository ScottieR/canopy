#!/bin/sh
# Syncs Antigravity/Claude logs to Patch so it stays apprised of external AI developer work.

LOG_FILE="$HOME/.gemini/antigravity/brain/3476001a-54b3-47cf-8aa4-1ad49e5329e0/.system_generated/logs/overview.txt"

if [ -f "$LOG_FILE" ]; then
  # Grab the last 50 lines to avoid overwhelming the context window
  RECENT_LOGS=$(tail -n 50 "$LOG_FILE" | jq -Rs .)
  
  curl -X POST http://127.0.0.1:1420/api/agents/patch/messages \
    -H "Content-Type: application/json" \
    -d "{
      \"text\": \"Hey Patch, here are the recent logs of what the external AI developer (Antigravity/Claude) has been doing on the local system:\\n\\n$RECENT_LOGS\\n\\nPlease review these and integrate this context into your mental model of the Canopy architecture.\"
    }" || true
else
  echo "Log file not found: $LOG_FILE"
fi

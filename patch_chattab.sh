#!/bin/bash
# Apply fixes to ChatTab.tsx

sed -i '' 's/useWorldStore.setState(state => ({/const currentState = useWorldStore.getState();\
    const currentAgent = currentState.agents.find(a => a.id === agent.id);\
    if (!currentAgent) return;\
    if (currentAgent.chatLog === chatLog) return;\
    \
    useWorldStore.setState(state => ({/g' src/pages/ArchitectView/ChatTab.tsx

# Also comment out the blocking Waking Up banner
sed -i '' '/{(!gatewayReady || agent.status === "deploying") && !agent.paused && (/,/<\/div>/!b; /<\/div>/!d; /<\/div>/s/.*//g' src/pages/ArchitectView/ChatTab.tsx


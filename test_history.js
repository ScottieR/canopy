const fs = require('fs');
const path = require('path');
const dirs = fs.readdirSync('/Users/scottieryan/Library/Application Support/Canopy/openclaw-state/agents');
const agentId = dirs[0];
const sessionsDir = path.join('/Users/scottieryan/Library/Application Support/Canopy/openclaw-state/agents', agentId, 'sessions');
if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir);
    if (files.length > 0) {
        const lines = fs.readFileSync(path.join(sessionsDir, files[0]), 'utf8').split('\n');
        for (let line of lines) {
            if (line.includes('THOUGHT_PROCESS') || line.includes('think') || line.includes('thinking')) {
                console.log(line);
            }
        }
    }
}

const Database = require('better-sqlite3');
const db = new Database('/Users/scottieryan/Library/Application Support/Canopy/canopy.db');

const rows = db.prepare(`
    SELECT id, timestamp, agent_id, action, bridge_type, detail, content_hash
    FROM (
        SELECT id, timestamp, agent_id, action, bridge_type, detail, content_hash
        FROM audit_log
        UNION ALL
        SELECT m.id, m.timestamp, c.agent_id, 'chatted' as action, 
               CASE WHEN m.role = 'user' THEN 'user' ELSE 'app' END as bridge_type, 
               substr(m.content, 1, 150) as detail, NULL as content_hash
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
    )
    ORDER BY timestamp DESC
    LIMIT 10
`).all();

console.log(rows);

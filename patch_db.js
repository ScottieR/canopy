const fs = require('fs');
const file = "/Users/scottieryan/Documents/Claude/Projects/Agent Management/canopy/src-tauri/src/db.rs";
let content = fs.readFileSync(file, "utf8");

const ensureConv = `
    pub fn ensure_conversation(&self, conv_id: &str, agent_id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        // Check if exists
        let mut stmt = conn.prepare("SELECT 1 FROM conversations WHERE id = ?1")?;
        if stmt.query_row(params![conv_id], |_| Ok(())).optional()?.is_some() {
            return Ok(());
        }

        // Create
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO conversations (id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                conv_id,
                agent_id,
                "New Conversation",
                now,
                now
            ],
        )?;

        Ok(())
    }
`;

if (!content.includes("pub fn ensure_conversation")) {
    content = content.replace(
        "pub fn get_or_create_conversation",
        ensureConv + "\n    pub fn get_or_create_conversation"
    );
    fs.writeFileSync(file, content);
    console.log("Patched db.rs");
} else {
    console.log("Already patched db.rs");
}

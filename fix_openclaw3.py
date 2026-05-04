import re

with open('src-tauri/src/openclaw.rs', 'r') as f:
    content = f.read()

new_fn = """#[tauri::command]
pub async fn get_openclaw_status_json() -> Result<String, String> {
    // Natively read agent directories to calculate fast status instead of blocking on Docker IPC.
    use std::time::SystemTime;
    
    let db_path = dirs::data_dir()
        .ok_or("No data dir")?
        .join("Canopy")
        .join("canopy.db");
        
    let conn = match rusqlite::Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => return Err(e.to_string()),
    };
    
    let mut stmt = match conn.prepare("SELECT id FROM agents") {
        Ok(s) => s,
        Err(e) => return Err(e.to_string()),
    };
    
    let agent_ids: Vec<String> = stmt.query_map([], |row| row.get(0))
        .unwrap_or_else(|_| serde_json::from_str("[]").unwrap()) // Fallback empty iter
        .filter_map(|r| r.ok())
        .collect();
        
    let workspace_base = dirs::data_dir()
        .unwrap()
        .join("Canopy")
        .join("openclaw-state")
        .join("workspace");
        
    let mut entries = vec![];
    let now = SystemTime::now();
    
    for id in agent_ids {
        let agent_dir = workspace_base.join(&id);
        
        let mut last_active_age_ms: Option<u128> = None;
        
        let files_to_check = [".terminal_history.json", ".chat_log.json"];
        for file in files_to_check {
            let file_path = agent_dir.join(file);
            if let Ok(metadata) = std::fs::metadata(&file_path) {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(duration) = now.duration_since(modified) {
                        let ms = duration.as_millis();
                        match last_active_age_ms {
                            Some(current_min) => if ms < current_min { last_active_age_ms = Some(ms); },
                            None => last_active_age_ms = Some(ms),
                        }
                    }
                }
            }
        }
        
        entries.push(serde_json::json!({
            "id": id,
            "name": id,
            "bootstrapPending": false,
            "lastActiveAgeMs": last_active_age_ms,
        }));
    }
    
    let output = serde_json::json!({
        "system": {},
        "agents": {
            "entries": entries
        }
    });
    
    Ok(serde_json::to_string(&output).unwrap())
}"""

old_fn = """#[tauri::command]
pub async fn get_openclaw_status_json() -> Result<String, String> {
    let output = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "openclaw", "status", "--json"])
        .output()
        .await
        .map_err(|e| format!("Failed to get openclaw status: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}"""

if old_fn in content:
    content = content.replace(old_fn, new_fn)
else:
    print("WARNING: Could not find old function to replace")

with open('src-tauri/src/openclaw.rs', 'w') as f:
    f.write(content)

print("openclaw.rs patched")

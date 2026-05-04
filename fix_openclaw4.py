import re

with open('src-tauri/src/openclaw.rs', 'r') as f:
    content = f.read()

old_code = """    let mut stmt = match conn.prepare("SELECT id FROM agents") {
        Ok(s) => s,
        Err(e) => return Err(e.to_string()),
    };
    
    let agent_ids: Vec<String> = stmt.query_map([], |row| row.get(0))
        .unwrap_or_else(|_| serde_json::from_str("[]").unwrap()) // Fallback empty iter
        .filter_map(|r| r.ok())
        .collect();"""

new_code = """    let mut stmt = match conn.prepare("SELECT id FROM agents") {
        Ok(s) => s,
        Err(e) => return Err(e.to_string()),
    };
    
    let agent_ids: Vec<String> = match stmt.query_map([], |row| row.get(0)) {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => vec![],
    };"""

if old_code in content:
    content = content.replace(old_code, new_code)
else:
    print("WARNING: Could not find old code")

with open('src-tauri/src/openclaw.rs', 'w') as f:
    f.write(content)

print("patched")

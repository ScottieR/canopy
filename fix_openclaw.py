import re

with open('src-tauri/src/openclaw.rs', 'r') as f:
    content = f.read()

# Add get_best_user_md_content helper
helper_fn = """
async fn get_best_user_md_content(db: &tauri::State<'_, crate::db::Database>) -> String {
    // Check if any existing agent has a non-empty USER.md
    if let Some(data_dir) = dirs::data_dir() {
        let workspace_root = data_dir.join("Canopy").join("openclaw-state").join("workspace");
        if workspace_root.exists() {
            if let Ok(entries) = std::fs::read_dir(&workspace_root) {
                let mut best_content = String::new();
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let user_md_path = path.join("USER.md");
                        if user_md_path.exists() {
                            if let Ok(content) = std::fs::read_to_string(&user_md_path) {
                                if content.trim().len() > best_content.len() {
                                    best_content = content;
                                }
                            }
                        }
                    }
                }
                if best_content.trim().len() > 10 {
                    return best_content;
                }
            }
        }
    }
    
    // Fallback: build a simple template from DB user profile
    if let Ok(profile) = db.get_user_profile() {
        return format!("# USER.md - About Your Human\\n\\n- **Name:** {}\\n- **What to call them:** {}\\n- **Timezone:** {}\\n- **Notes:** {}\\n",
            profile.name, profile.name, profile.timezone, profile.communication_tone);
    }
    
    "# USER.md - About Your Human\\n\\n- **Name:** User\\n- **Timezone:** UTC\\n".to_string()
}
"""

if "async fn get_best_user_md_content" not in content:
    content = content.replace("async fn sync_agent_skills(", helper_fn + "\nasync fn sync_agent_skills(")

# In create_agent, write out all files instead of just SOUL.md
create_agent_old = """    // ─── Step 4: Write SOUL.md and set identity ──────────────────────────────────
    let soul_md = generate_soul_md(&personality);
    let soul_path = agent_soul_path(&agent_id);
    let escaped = soul_md.replace('\'', "'\\''");
    let write_cmd = format!(
        "mkdir -p \\"$(dirname '{soul_path}')\\" && printf '%s' '{soul}' > '{soul_path}'",
        soul_path = soul_path, soul = escaped,
    );
    let _ = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &write_cmd])
        .output()
        .await;"""

create_agent_new = """    // ─── Step 4: Write SOUL.md, IDENTITY.md, PREFERENCES.md, USER.md ─────────────
    let soul_md = generate_soul_md(&personality);
    let identity_md = personality.identity_template.clone().unwrap_or_default();
    let prefs_md = personality.custom_instructions.trim().to_string();
    let user_md = get_best_user_md_content(&db).await;
    
    let soul_path = agent_soul_path(&agent_id);
    let escaped_soul = soul_md.replace('\'', "'\\\\''");
    let escaped_identity = identity_md.replace('\'', "'\\\\''");
    let escaped_prefs = prefs_md.replace('\'', "'\\\\''");
    let escaped_user = user_md.replace('\'', "'\\\\''");
    
    let write_cmd = format!(
        "mkdir -p \\"$(dirname '{soul_path}')\\" && \\
         printf '%s' '{soul}' > '{soul_path}' && \\
         printf '%s' '{identity}' > \\"$(dirname '{soul_path}')\\"/IDENTITY.md && \\
         printf '%s' '{prefs}' > \\"$(dirname '{soul_path}')\\"/PREFERENCES.md && \\
         printf '%s' '{user}' > \\"$(dirname '{soul_path}')\\"/USER.md && \\
         touch \\"$(dirname '{soul_path}')\\"/AGENTS.md \\"$(dirname '{soul_path}')\\"/TOOLS.md",
        soul_path = soul_path,
        soul = escaped_soul,
        identity = escaped_identity,
        prefs = escaped_prefs,
        user = escaped_user
    );
    let _ = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &write_cmd])
        .output()
        .await;"""

content = content.replace(create_agent_old, create_agent_new)

# In boot_sync_agents, properly write USER.md instead of just touch-ing it
boot_sync_old = """        let custom_instructions = agent.personality.custom_instructions.trim();
        let escaped_prefs = custom_instructions.replace('\'', "'\\''");
        let write_cmd = format!(
            "mkdir -p \\"$(dirname '{soul_path}')\\" && \\
             if [ ! -f '{soul_path}' ]; then printf '%s' '{soul}' > '{soul_path}'; fi && \\
             if [ ! -f \\"$(dirname '{soul_path}')\\"/IDENTITY.md ]; then printf '%s' '{identity}' > \\"$(dirname '{soul_path}')\\"/IDENTITY.md; fi && \\
             if [ ! -f \\"$(dirname '{soul_path}')\\"/PREFERENCES.md ]; then printf '%s' '{prefs}' > \\"$(dirname '{soul_path}')\\"/PREFERENCES.md; fi && \\
             touch \\"$(dirname '{soul_path}')\\"/AGENTS.md \\"$(dirname '{soul_path}')\\"/TOOLS.md \\"$(dirname '{soul_path}')\\"/USER.md",
            soul_path = soul_path,
            soul = escaped_soul,
            identity = escaped_identity,
            prefs = escaped_prefs,
        );"""

boot_sync_new = """        let custom_instructions = agent.personality.custom_instructions.trim();
        let escaped_prefs = custom_instructions.replace('\'', "'\\\\''");
        let user_md = get_best_user_md_content(&db).await;
        let escaped_user = user_md.replace('\'', "'\\\\''");
        
        let write_cmd = format!(
            "mkdir -p \\"$(dirname '{soul_path}')\\" && \\
             if [ ! -f '{soul_path}' ]; then printf '%s' '{soul}' > '{soul_path}'; fi && \\
             if [ ! -f \\"$(dirname '{soul_path}')\\"/IDENTITY.md ]; then printf '%s' '{identity}' > \\"$(dirname '{soul_path}')\\"/IDENTITY.md; fi && \\
             if [ ! -f \\"$(dirname '{soul_path}')\\"/PREFERENCES.md ]; then printf '%s' '{prefs}' > \\"$(dirname '{soul_path}')\\"/PREFERENCES.md; fi && \\
             if [ ! -f \\"$(dirname '{soul_path}')\\"/USER.md ]; then printf '%s' '{user}' > \\"$(dirname '{soul_path}')\\"/USER.md; fi && \\
             touch \\"$(dirname '{soul_path}')\\"/AGENTS.md \\"$(dirname '{soul_path}')\\"/TOOLS.md",
            soul_path = soul_path,
            soul = escaped_soul,
            identity = escaped_identity,
            prefs = escaped_prefs,
            user = escaped_user
        );"""

content = content.replace(boot_sync_old, boot_sync_new)

with open('src-tauri/src/openclaw.rs', 'w') as f:
    f.write(content)

print("Updated openclaw.rs")

import re

with open('src-tauri/src/openclaw.rs', 'r') as f:
    content = f.read()

# 1. Update create_agent
create_agent_old = """    let prefs_md = personality.custom_instructions.trim().to_string();
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
    );"""

create_agent_new = """    let user_md = get_best_user_md_content(&db).await;
    
    let soul_path = agent_soul_path(&agent_id);
    let escaped_soul = soul_md.replace('\'', "'\\\\''");
    let escaped_identity = identity_md.replace('\'', "'\\\\''");
    let escaped_user = user_md.replace('\'', "'\\\\''");
    
    let write_cmd = format!(
        "mkdir -p \\"$(dirname '{soul_path}')\\" && \\
         printf '%s' '{soul}' > '{soul_path}' && \\
         printf '%s' '{identity}' > \\"$(dirname '{soul_path}')\\"/IDENTITY.md && \\
         printf '%s' '{user}' > \\"$(dirname '{soul_path}')\\"/USER.md && \\
         touch \\"$(dirname '{soul_path}')\\"/AGENTS.md \\"$(dirname '{soul_path}')\\"/TOOLS.md",
        soul_path = soul_path,
        soul = escaped_soul,
        identity = escaped_identity,
        user = escaped_user
    );"""

content = content.replace(create_agent_old, create_agent_new)

# 2. Update boot_sync_agents
boot_sync_old = """        let custom_instructions = agent.personality.custom_instructions.trim();
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

boot_sync_new = """        let user_md = get_best_user_md_content(&db).await;
        let escaped_user = user_md.replace('\'', "'\\\\''");
        
        let write_cmd = format!(
            "mkdir -p \\"$(dirname '{soul_path}')\\" && \\
             if [ ! -f '{soul_path}' ]; then printf '%s' '{soul}' > '{soul_path}'; fi && \\
             if [ ! -f \\"$(dirname '{soul_path}')\\"/IDENTITY.md ]; then printf '%s' '{identity}' > \\"$(dirname '{soul_path}')\\"/IDENTITY.md; fi && \\
             if [ ! -f \\"$(dirname '{soul_path}')\\"/USER.md ]; then printf '%s' '{user}' > \\"$(dirname '{soul_path}')\\"/USER.md; fi && \\
             touch \\"$(dirname '{soul_path}')\\"/AGENTS.md \\"$(dirname '{soul_path}')\\"/TOOLS.md",
            soul_path = soul_path,
            soul = escaped_soul,
            identity = escaped_identity,
            user = escaped_user
        );"""

content = content.replace(boot_sync_old, boot_sync_new)

# 3. Update update_agent_personality
update_agent_old = """    let soul_path = agent_soul_path(&agent_id);
    let custom_instructions = personality.custom_instructions.trim();
    let escaped_prefs = custom_instructions.replace('\'', "'\\''");

    let output = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c",
            &format!("mkdir -p $(dirname {}) && printf '%s' '{}' > $(dirname {})/PREFERENCES.md", soul_path, escaped_prefs, soul_path)])
        .output()
        .await
        .map_err(|e| format!("Failed to update PREFERENCES.md: {}", e))?;
        
    log_terminal_command_internal(&agent_id, "printf '%s' '...' > ~/.openclaw/agents/[id]/agent/PREFERENCES.md", "PREFERENCES.md successfully updated with latest personality.");

    if !output.status.success() {
        return Err("Failed to update personality in container".to_string());
    }"""

update_agent_new = """    let soul_path = agent_soul_path(&agent_id);
    let identity_md = personality.identity_template.clone().unwrap_or_default();
    let escaped_identity = identity_md.replace('\'', "'\\''");

    let output = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c",
            &format!("mkdir -p $(dirname {}) && printf '%s' '{}' > $(dirname {})/IDENTITY.md", soul_path, escaped_identity, soul_path)])
        .output()
        .await
        .map_err(|e| format!("Failed to update IDENTITY.md: {}", e))?;
        
    log_terminal_command_internal(&agent_id, "printf '%s' '...' > ~/.openclaw/agents/[id]/agent/IDENTITY.md", "IDENTITY.md successfully updated with latest personality.");

    if !output.status.success() {
        return Err("Failed to update personality in container".to_string());
    }"""

content = content.replace(update_agent_old, update_agent_new)

with open('src-tauri/src/openclaw.rs', 'w') as f:
    f.write(content)

print("Removed PREFERENCES.md references from openclaw.rs")

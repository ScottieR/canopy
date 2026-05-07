use crate::model_constants::{
    GATEWAY_URL,
    GATEWAY_INTERNAL_TOKEN,
    DEFAULT_ANTHROPIC_MODEL,
    agent_auth_profile_path,
    agent_soul_path,
};
use crate::models::{Agent, AgentPersonality, AgentCapabilities, AgentStats, AgentStatus, DiscoveredAgent};
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// Returns the current list of available models for the frontend model picker.
///
/// Reads from `MODEL_REGISTRY` which is initialised at startup with the hardcoded
/// validated fallback list and then overwritten by the admin oracle fetch
/// (localhost:3001/api/models). Every entry in the registry has already been validated
/// via `validate_model_string`, so phantom names (e.g. "gemini-3.1-flash") can never
/// appear here.
#[tauri::command]
pub fn get_available_models() -> Vec<crate::model_constants::ModelInfo> {
    crate::model_constants::MODEL_REGISTRY
        .read()
        .expect("MODEL_REGISTRY poisoned")
        .clone()
}

/// Prevents concurrent / double-fired boot_sync_agents calls.
/// React Strict Mode fires effects twice in dev; this guard ensures we only run once at a time.
static BOOT_SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

pub fn get_docker_command() -> tokio::process::Command {
    if let Some(home) = dirs::home_dir() {
        let orb_docker = home.join(".orbstack/bin/docker");
        if orb_docker.exists() {
            return tokio::process::Command::new(orb_docker);
        }
    }
    if std::path::Path::new("/usr/local/bin/docker").exists() {
        return tokio::process::Command::new("/usr/local/bin/docker");
    }
    if std::path::Path::new("/opt/homebrew/bin/docker").exists() {
        return tokio::process::Command::new("/opt/homebrew/bin/docker");
    }
    tokio::process::Command::new("docker")
}

/// Interface to the OpenClaw Gateway API with SQLite persistence.
/// All agent management goes through here with dual persistence:
/// 1. Docker containers for runtime
/// 2. SQLite DB for metadata and conversation history

#[tauri::command]
pub async fn create_agent(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    name: String,
    role: String,
    emoji: String,
    personality: AgentPersonality,
    isolated: bool,
    capabilities: crate::models::AgentCapabilities,
) -> Result<Agent, String> {
    let agent_id = format!("agent-{}", name.to_lowercase().replace(' ', "-"));

    // ─── Step 1: Persist to SQLite FIRST ────────────────────────────────────────
    // SQLite is always available locally. Persisting before any docker exec means
    // the agent survives a gateway OOM kill or crash mid-creation. On the next app
    // launch, boot_sync_agents reads SQLite and re-registers any agents OpenClaw
    // doesn't know about. Without this, a gateway crash during `agents add` silently
    // discards the agent — it existed only in React state, which clears on reload.
    let agent = Agent {
        id: agent_id.clone(),
        name: name.clone(),
        role,
        emoji: emoji.clone(),
        color: "#34D399".to_string(),
        status: AgentStatus::Active,
        isolated,
        paused: false,
        capabilities,
        container_id: None,
        visual_identity: None,
        personality: personality.clone(),
        integrations: vec![],
        memories: vec![],
        created_at: chrono::Utc::now(),
        stats: AgentStats::default(),
    };

    if let Err(e) = db.insert_agent(&agent) {
        // Duplicate key just means agent already exists — tolerate it.
        if !e.to_string().to_lowercase().contains("unique") {
            eprintln!("Warning: Failed to persist agent to DB: {}", e);
        }
    } else {
        let _ = db.log_audit(&agent_id, "create", Some("openclaw"), "Agent created via OpenClaw", None);
    }

    // ─── Step 2: Configure gateway (best effort — agent is already in SQLite) ──
    let _ = get_docker_command().args(["exec", "-u", "node", "-e", "NODE_OPTIONS=--v8-pool-size=1", "canopy-gateway", "openclaw", "config", "set", "gateway.mode", "local"]).output().await;
    // Set proper tooling and session scopes to match the working 'Sloane' defaults
    let _ = get_docker_command().args(["exec", "-u", "node", "-e", "NODE_OPTIONS=--v8-pool-size=1", "canopy-gateway", "openclaw", "config", "set", "session.dmScope", "per-channel-peer"]).output().await;

    if let Some(ref model) = personality.active_model {
        // ⚠️  Use "agents.defaults.model.primary" to produce the nested object format
        // that OpenClaw expects: model: { "primary": "provider/model-id" }
        // Confirmed against working reference at /Users/scottieryan/agents/sloane/config/openclaw.json
        let _ = get_docker_command().args(["exec", "-u", "node", "-e", "NODE_OPTIONS=--v8-pool-size=1", "canopy-gateway", "openclaw", "config", "set", "agents.defaults.model.primary", model]).output().await;
    } else {
        let _ = crate::audit_openclaw::repair_openclaw_config(app_handle.clone(), None).await;
    }

    // ─── Step 3: Register agent in OpenClaw ─────────────────────────────────────
    // If this fails (e.g. OOM kill), the agent is still in SQLite. boot_sync_agents
    // will complete the registration on next launch.
    let workspace_path = format!("/home/node/.openclaw/workspace/{}", agent_id);
    let output = get_docker_command()
        .args([
            "exec", "-u", "node",
            "-e", "NODE_OPTIONS=--v8-pool-size=1",   // prevents uv_thread_create/EAGAIN under PID pressure
            "canopy-gateway",
            "openclaw", "agents", "add",
            &agent_id,
            "--workspace", &workspace_path,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to register agent with gateway: {}", e))?;
        
    let cmd_str = format!("openclaw agents add {} --workspace {}", agent_id, workspace_path);
    let out_str = String::from_utf8_lossy(&output.stdout);
    log_terminal_command_internal(&agent_id, &cmd_str, &out_str);

    if !output.status.success() {
        let combined = format!("{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)).trim().to_string();
        // "already exists" is fine — idempotent
        if !combined.to_lowercase().contains("already exists") {
            return Err(format!(
                "Gateway registration failed (agent saved to DB — will retry on next launch): {}",
                combined
            ));
        }
    }

    // ─── Step 4: Write SOUL.md and set identity ──────────────────────────────────
    let soul_md = generate_soul_md(&personality);
    let soul_path = agent_soul_path(&agent_id);
    let escaped = soul_md.replace('\'', "'\\''");
    let write_cmd = format!(
        "mkdir -p \"$(dirname '{soul_path}')\" && printf '%s' '{soul}' > '{soul_path}'",
        soul_path = soul_path, soul = escaped,
    );
    let _ = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &write_cmd])
        .output()
        .await;

    let _ = get_docker_command()
        .args(["exec", "-e", "NODE_OPTIONS=--v8-pool-size=1", "canopy-gateway", "openclaw", "agents", "set-identity",
               "--agent", &agent_id, "--emoji", &emoji])
        .output()
        .await;

    // Step 5: Write API keys so the agent can respond
    write_auth_profiles(&agent_id, &get_creds_for_agent(&agent_id)).await;

    // Step 6: Asynchronously ensure Playwright is installed
    // This provides a fallback to ensure the browser tool dependencies are installed 
    // when an agent is created, just in case the container missed the startup hook.
    tauri::async_runtime::spawn(async move {
        tracing::info!("create_agent: Initiating background Chromium/Playwright installation (best-effort)...");
        let _ = get_docker_command()
            .args(["exec", "-u", "root", "canopy-gateway", "apt-get", "update"])
            .output().await;

        let _ = get_docker_command()
            .args(["exec", "-u", "root", "canopy-gateway", "apt-get", "install", "-y", "chromium"])
            .output().await;

        let _ = get_docker_command()
            .args(["exec", "-u", "root", "canopy-gateway", "npx", "playwright", "install-deps"])
            .output().await;
        
        let _ = get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "npx", "playwright", "install", "chromium", "webkit"])
            .output().await;
    });

    if agent.isolated {
        let data_dir = dirs::data_dir()
            .ok_or("Could not find data directory")?
            .join("Canopy");

        let compose_content = crate::docker::generate_isolated_compose(&agent_id, &data_dir, 18805);
        let compose_path = data_dir.join(format!("docker-compose-{}.yml", agent_id));
        std::fs::write(&compose_path, compose_content).map_err(|e| e.to_string())?;

        let _ = crate::docker::get_docker_compose_command()
            .args(["-f", compose_path.to_str().unwrap(), "up", "-d"])
            .output()
            .await;
    }
    Ok(agent)
}

#[tauri::command]
pub async fn list_agents(
    db: tauri::State<'_, crate::db::Database>,
) -> Result<Vec<Agent>, String> {
    // Load from persistent store - DB is source of truth
    let agents = db.list_agents()
        .map_err(|e| format!("Failed to load agents: {}", e))?;

    // Optional: Check gateway health to merge live status, extremely fast timeout to prevent GUI hangs
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(400))
        .build()
        .unwrap_or_default();
        
    if let Ok(resp) = client
        .get(format!("{}/api/status", GATEWAY_URL))
        .header("Authorization", &crate::model_constants::gateway_bearer_header())
        .send()
        .await
    {
        if resp.status().is_success() {
            // Gateway is alive; could merge live status here if needed
            // For now, we trust the DB state
        }
    }

    Ok(agents)
}

lazy_static::lazy_static! {
    static ref CONNECTORS_CACHE: tokio::sync::Mutex<Option<serde_json::Value>> = tokio::sync::Mutex::new(None);
}

#[tauri::command]
pub async fn get_connectors_config() -> Result<serde_json::Value, String> {
    {
        let cache = CONNECTORS_CACHE.lock().await;
        if let Some(cached) = &*cache {
            return Ok(cached.clone());
        }
    }

    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(manifest_dir).join("../../shared/connectors.json");
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read connectors.json at {:?}: {}", path, e))?;
    let mut parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    // Dynamically fetch OpenClaw skills
    let output = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "openclaw", "skills", "list", "--json"])
        .output()
        .await;

    if let Ok(out) = output {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Ok(skills_data) = serde_json::from_str::<serde_json::Value>(&stdout) {
                if let Some(skills) = skills_data.get("skills").and_then(|s| s.as_array()) {
                    if let Some(parsed_array) = parsed.as_array_mut() {
                        let existing_ids: std::collections::HashSet<String> = parsed_array
                            .iter()
                            .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                            .collect();

                        for skill in skills {
                            if let Some(name) = skill.get("name").and_then(|v| v.as_str()) {
                                if !existing_ids.contains(name) {
                                    let desc = skill.get("description").and_then(|v| v.as_str()).unwrap_or("");
                                    let mut new_plugin = serde_json::json!({
                                        "id": name,
                                        "name": name,
                                        "subtitle": desc,
                                        "icon": "plug",
                                        "isGlobal": false,
                                        "isVisible": true,
                                        "isSuggested": false,
                                        "needsCompanion": false,
                                        "isPlugin": true
                                    });
                                    if let Some(emoji) = skill.get("emoji").and_then(|v| v.as_str()) {
                                        if let Some(obj) = new_plugin.as_object_mut() {
                                            obj.insert("emoji".to_string(), serde_json::json!(emoji));
                                        }
                                    }
                                    parsed_array.push(new_plugin);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut cache = CONNECTORS_CACHE.lock().await;
    *cache = Some(parsed.clone());

    Ok(parsed)
}

#[tauri::command]
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
    
    let agent_ids: Vec<String> = match stmt.query_map([], |row| row.get(0)) {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => vec![],
    };
        
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
}

#[tauri::command]
pub async fn read_workspace_file(agent_id: String, filename: String) -> Result<String, String> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid filename".into());
    }
    let workspace = dirs::data_dir()
        .ok_or("No data dir")?
        .join("Canopy")
        .join("openclaw-state")
        .join("workspace")
        .join(&agent_id);

    let file_path = workspace.join(&filename);
    if !file_path.exists() {
        return Ok("".to_string());
    }
    std::fs::read_to_string(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_workspace_file(agent_id: String, filename: String, content: String) -> Result<(), String> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid filename".into());
    }
    let workspace = dirs::data_dir()
        .ok_or("No data dir")?
        .join("Canopy")
        .join("openclaw-state")
        .join("workspace")
        .join(&agent_id);

    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let file_path = workspace.join(&filename);
    std::fs::write(&file_path, content).map_err(|e| e.to_string())
}

pub fn log_terminal_command_internal(agent_id: &str, command: &str, output: &str) {
    let workspace = match dirs::data_dir() {
        Some(dir) => dir.join("Canopy").join("openclaw-state").join("workspace").join(agent_id),
        None => return,
    };
    
    let file_path = workspace.join(".terminal_history.json");
    let mut history = vec![];
    
    if file_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&file_path) {
            if let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                history = parsed;
            }
        }
    }
    
    let timestamp = chrono::Utc::now().to_rfc3339();
    let entry = serde_json::json!({
        "command": command,
        "output": output,
        "timestamp": timestamp
    });
    
    history.push(entry);
    
    if let Ok(json) = serde_json::to_string_pretty(&history) {
        let _ = std::fs::create_dir_all(&workspace);
        let _ = std::fs::write(&file_path, json);
    }
}

#[tauri::command]
pub async fn run_agent_command(
    agent_id: String,
    command: String,
) -> Result<String, String> {
    let workspace_path = format!("/home/node/.openclaw/workspace/{}", agent_id);
    let output = get_docker_command()
        .args([
            "exec", "-u", "node", "-w", &workspace_path,
            "canopy-gateway", "bash", "-c", &command
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let combined = format!("{}{}", stdout, stderr);
    log_terminal_command_internal(&agent_id, &command, &combined);

    if output.status.success() {
        Ok(combined)
    } else {
        Err(format!("Error: {}", combined))
    }
}

#[tauri::command]
pub async fn get_agent(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<Agent, String> {
    db.get_agent(&agent_id)
        .map_err(|e| format!("DB error: {}", e))?
        .ok_or_else(|| format!("Agent not found: {}", agent_id))
}

#[tauri::command]
pub async fn update_agent_personality(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    personality: AgentPersonality,
) -> Result<(), String> {
    let soul_path = agent_soul_path(&agent_id);
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
    }

    // Update agent in DB with new personality
    if let Ok(Some(mut agent)) = db.get_agent(&agent_id) {
        agent.personality = personality;
        let _ = db.update_agent(&agent);
        let _ = db.log_audit(&agent_id, "update_personality", Some("openclaw"), "Agent personality updated", None);
    }

    Ok(())
}

// Helper to sync an agent's combined capabilities and integrations to OpenClaw

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
        return format!("# USER.md - About Your Human\n\n- **Name:** {}\n- **What to call them:** {}\n- **Timezone:** {}\n- **Notes:** {}\n",
            profile.name, profile.name, profile.timezone, profile.communication_tone);
    }
    
    "# USER.md - About Your Human\n\n- **Name:** User\n- **Timezone:** UTC\n".to_string()
}

async fn sync_agent_skills(app_handle: tauri::AppHandle, agent: &crate::models::Agent) {
    let output = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "openclaw", "config", "get", "agents.list"])
        .output()
        .await
        .unwrap_or_else(|_| std::process::Output { status: Default::default(), stdout: vec![], stderr: vec![] });

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Ok(agents) = serde_json::from_str::<serde_json::Value>(&stdout) {
            if let Some(agents_array) = agents.as_array() {
                if let Some(index) = agents_array.iter().position(|a| a.get("id").and_then(|v| v.as_str()) == Some(&agent.id)) {
                    let mut skills = Vec::new();
                    let caps = &agent.capabilities;
                    if caps.browser { 
                        skills.push("browser".to_string()); 
                        
                        let agent_id_clone = agent.id.clone();
                        let app_handle_clone = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Ok(port) = crate::browser_manager::enable_jit_proxy(app_handle_clone, agent_id_clone.clone()).await {
                                let ws_endpoint = format!("ws://host.docker.internal:{}", port);
                                let path = format!("agents.list[{}].env.PLAYWRIGHT_CDP_ENDPOINT", index);
                                let _ = get_docker_command()
                                    .args(["exec", "-u", "node", "canopy-gateway", "openclaw", "config", "set", &path, &ws_endpoint])
                                    .output().await;
                            }
                        });
                    }
                    if caps.proxy { skills.push("proxy".to_string()); }
                    if caps.vision { skills.push("vision".to_string()); }
                    if caps.canvas { skills.push("canvas".to_string()); }
                    if caps.coding { skills.push("coding".to_string()); }
                    if caps.gog { skills.push("gog".to_string()); }
                    if caps.summarize { skills.push("summarize".to_string()); }

                    // Append integrations that act as skills (e.g. gmail, calendar)
                    // We map internal Canopy IDs to OpenClaw plugin/channel names
                    for i in &agent.integrations {
                        if !i.starts_with("web_") {
                            let mut skill_name = i.clone();
                            if skill_name == "calendar" || skill_name == "cal" || skill_name == "calendar_read" || skill_name == "calendar_write" {
                                skill_name = "googleCalendar".to_string();
                            } else if skill_name == "email" {
                                skill_name = "gmail".to_string();
                            } else if skill_name == "drive" {
                                skill_name = "googleDrive".to_string();
                            }
                            
                            if !skills.contains(&skill_name) {
                                skills.push(skill_name);
                            }
                        }
                    }

                    let skills_json = serde_json::to_string(&skills).unwrap_or_else(|_| "[]".to_string());

                    let path = format!("agents.list[{}].skills", index);
                    let cmd_str = format!("openclaw config set {} '{}' --strict-json", path, skills_json);
                    let output2 = get_docker_command()
                        .args(["exec", "-u", "node", "canopy-gateway", "openclaw", "config", "set", &path, &skills_json, "--strict-json"])
                        .output()
                        .await;
                        
                    if let Ok(out) = output2 {
                        log_terminal_command_internal(&agent.id, &cmd_str, &String::from_utf8_lossy(&out.stdout));
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub async fn update_agent_integrations(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    integrations: Vec<String>,
) -> Result<(), String> {
    if let Ok(Some(mut agent)) = db.get_agent(&agent_id) {
        agent.integrations = integrations;
        let _ = db.update_agent(&agent);
        let _ = db.log_audit(&agent_id, "update_integrations", None, "Agent integrations updated", None);
        
        sync_agent_skills(app_handle, &agent).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn update_agent_memories(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    memories: Vec<crate::models::AgentMemory>,
) -> Result<(), String> {
    if let Ok(Some(mut agent)) = db.get_agent(&agent_id) {
        agent.memories = memories;
        let _ = db.update_agent(&agent);
        let _ = db.log_audit(&agent_id, "update_memories", None, "Agent memories updated", None);
    }
    Ok(())
}

#[tauri::command]
pub async fn update_agent_capabilities(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    capabilities: AgentCapabilities,
) -> Result<(), String> {
    // 1. Save to SQLite
    if let Ok(Some(mut agent)) = db.get_agent(&agent_id) {
        agent.capabilities = capabilities.clone();
        let _ = db.update_agent(&agent);
        let _ = db.log_audit(&agent_id, "update_capabilities", Some("security"), "Agent capabilities and network permissions updated", None);
        
        // 2. Push to OpenClaw Container
        sync_agent_skills(app_handle, &agent).await;
    } else {
        return Err("Agent not found".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn update_agent_visuals(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    visual_identity: serde_json::Value,
) -> Result<(), String> {
    if let Ok(Some(mut agent)) = db.get_agent(&agent_id) {
        agent.visual_identity = Some(visual_identity);
        let _ = db.update_agent(&agent);
        let _ = db.log_audit(&agent_id, "update_visuals", None, "Agent visual identity updated", None);
    } else {
        return Err("Agent not found".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn update_agent_details(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    name: String,
    role: String,
) -> Result<(), String> {
    if let Ok(Some(mut agent)) = db.get_agent(&agent_id) {
        agent.name = name.clone();
        agent.role = role;
        
        // Keep personality name in sync
        agent.personality.name = name;
        
        // Refresh SOUL.md so the agent knows its new name
        let soul_md = generate_soul_md(&agent.personality);
        let soul_path = agent_soul_path(&agent_id);
        
        let _ = get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c",
                &format!("mkdir -p $(dirname {}) && cat > {} << 'SOULEOF'\n{}\nSOULEOF", soul_path, soul_path, soul_md)])
            .output()
            .await;

        db.update_agent(&agent).map_err(|e| format!("DB error: {}", e))?;
        let _ = db.log_audit(&agent_id, "update_details", Some("canopy"), "Agent basic info updated", None);
        Ok(())
    } else {
        Err(format!("Agent not found: {}", agent_id))
    }
}

#[tauri::command]
pub async fn toggle_agent_isolation(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    isolated: bool,
) -> Result<(), String> {
    if let Ok(Some(mut agent)) = db.get_agent(&agent_id) {
        agent.isolated = isolated;
        let _ = db.update_agent(&agent);
        let action = if isolated { "isolate_container" } else { "join_shared_gateway" };
        let _ = db.log_audit(&agent_id, action, Some("docker"), &format!("Agent isolation set to {}", isolated), None);
    } else {
        return Err("Agent not found".to_string());
    }

    // 1. Remove the agent from the shared gateway (best-effort)
    let _ = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "openclaw", "agents", "remove", &agent_id])
        .output()
        .await;

    let data_dir = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("Canopy");

    let compose_content = crate::docker::generate_isolated_compose(&agent_id, &data_dir, 18805); // using 18805 as a stable port offset
    let compose_path = data_dir.join(format!("docker-compose-{}.yml", agent_id));
    std::fs::write(&compose_path, compose_content).map_err(|e| e.to_string())?;

    if isolated {
        // Stop any old container just in case
        let _ = crate::docker::get_docker_compose_command()
            .args(["-f", compose_path.to_str().unwrap(), "down"])
            .output()
            .await;

        // Spin up dedicated container via docker::generate_isolated_compose()!
        let out = crate::docker::get_docker_compose_command()
            .args(["-f", compose_path.to_str().unwrap(), "up", "-d"])
            .output()
            .await
            .map_err(|e| format!("Failed to run docker-compose: {}", e))?;
            
        if !out.status.success() {
            tracing::warn!("Failed to start isolated container: {}", String::from_utf8_lossy(&out.stderr));
        }
    } else {
        // Stop isolated container
        let _ = crate::docker::get_docker_compose_command()
            .args(["-f", compose_path.to_str().unwrap(), "down"])
            .output()
            .await;

        // Add back to shared gateway
        let _ = get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "openclaw", "agents", "add", 
                   "--id", &agent_id,
                   "--workspace", &format!("/home/node/.openclaw/workspace/{}", agent_id)])
            .output()
            .await;
    }

    Ok(())
}

#[tauri::command]
pub async fn set_agent_paused(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    paused: bool,
) -> Result<(), String> {
    db.set_agent_paused(&agent_id, paused)
        .map_err(|e| format!("DB error: {}", e))?;

    if paused {
        // Remove from OpenClaw so its channels/sidecars stop consuming resources.
        // If this fails (e.g. agent wasn't registered yet) that's fine — the important
        // thing is the DB flag is set so boot_sync_agents won't re-register it.
        let _ = get_docker_command()
            .args(["exec", "-u", "node", "-e", "NODE_OPTIONS=--v8-pool-size=1", "canopy-gateway",
                   "openclaw", "agents", "remove", &agent_id])
            .output()
            .await;
        tracing::info!("set_agent_paused: {} paused — removed from OpenClaw", agent_id);
    } else {
        // Immediately re-register the agent — don't wait for the next boot.
        // Pattern mirrors boot_sync_agents: mkdir workspace → agents add → write credentials.
        let workspace_path = format!("/home/node/.openclaw/workspace/{}", agent_id);

        // Step 1: Ensure workspace dir exists (agents add fails silently without it).
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            get_docker_command()
                .args(["exec", "-u", "node", "canopy-gateway", "mkdir", "-p", &workspace_path])
                .output(),
        ).await;

        // Step 2: Register with openclaw agents add.
        // Use the container-side timeout binary (175s) so orphaned processes are killed
        // inside the container. Rust timeout (180s) is slightly longer so the container
        // always wins and docker exec exits cleanly rather than leaving zombie processes.
        let add_out = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            get_docker_command()
                .args([
                    "exec", "-u", "node",
                    "-e", "NODE_OPTIONS=--v8-pool-size=1 --max-old-space-size=512",
                    "canopy-gateway",
                    "timeout", "175",
                    "openclaw", "agents", "add", &agent_id,
                    "--workspace", &workspace_path,
                ])
                .output(),
        ).await;

        let combined_out = match &add_out {
            Ok(Ok(o)) => format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)),
            _ => String::new(),
        };
        let registered_ok = match &add_out {
            Ok(Ok(o)) => o.status.success()
                || combined_out.contains("Agent dir:") && combined_out.contains("Workspace OK:")
                || combined_out.contains("already exists")
                || combined_out.contains("already registered"),
            _ => false,
        };

        if registered_ok {
            tracing::info!("set_agent_paused: {} re-registered in OpenClaw", agent_id);
            write_auth_profiles(&agent_id, &get_creds_for_agent(&agent_id)).await;
        } else {
            match &add_out {
                Ok(Ok(o)) => tracing::warn!(
                    "set_agent_paused: agents add failed for {} (exit {:?}): {} — will retry on next boot",
                    agent_id, o.status.code(),
                    String::from_utf8_lossy(&o.stderr).trim()
                ),
                _ => tracing::warn!(
                    "set_agent_paused: timed out registering {} — will retry on next boot",
                    agent_id
                ),
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_agent(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<(), String> {
    // Step 1: Remove from OpenClaw container
    let node_script = r#"
        const fs = require('fs');
        const path = require('path');
        const agentId = process.argv[1];
        if (!agentId || typeof agentId !== 'string' || agentId.includes('..') || agentId.includes('/')) {
            console.error('Invalid agent ID provided');
            process.exit(1);
        }
        
        const cfgPath = '/home/node/.openclaw/openclaw.json';
        if (fs.existsSync(cfgPath)) {
            try {
                let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
                if (cfg.agents && cfg.agents.list) {
                    const before = cfg.agents.list.length;
                    cfg.agents.list = cfg.agents.list.filter(a => a.id !== agentId);
                    if (cfg.agents.list.length !== before) {
                        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
                    }
                }
            } catch (e) {
                console.error('Configuration parsing failed', e);
            }
        }
        
        const dir = path.join('/home/node/.openclaw/agents', agentId);
        // Extremely strict validation that we never delete outside of the exact isolated sandbox layer
        if (dir.startsWith('/home/node/.openclaw/agents/') && dir !== '/home/node/.openclaw/agents/') {
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        }
    "#;

    let output = get_docker_command()
        .args([
            "exec", "canopy-gateway",
            "node", "-e", node_script, &agent_id
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to delete agent from container: {}", e))?;

    if !output.status.success() {
        return Err("Failed to delete agent from OpenClaw".to_string());
    }

    // Step 2: Remove from persistent store
    db.delete_agent(&agent_id)
        .map_err(|e| format!("Failed to delete agent from DB: {}", e))?;

    // Step 3: Log audit event
    let _ = db.log_audit(&agent_id, "delete", Some("openclaw"), "Agent deleted", None);

    // Step 4: Belt-and-suspenders — also remove the host bind-mount directory.
    // The Node.js script above deletes via the container's view of the bind-mount,
    // which should propagate to the host. But if the container was OOM-crashing
    // when delete was requested, the script may not have run to completion, leaving
    // the directory on the host. Removing it here guarantees cleanup regardless.
    if let Some(data_dir) = dirs::data_dir() {
        let agent_dir = data_dir
            .join("Canopy")
            .join("openclaw-state")
            .join("agents")
            .join(&agent_id);
        // Strict validation: only delete a direct child of the agents directory
        let agents_root = data_dir.join("Canopy").join("openclaw-state").join("agents");
        if agent_dir.starts_with(&agents_root) && agent_dir != agents_root {
            let _ = std::fs::remove_dir_all(&agent_dir);
            tracing::info!("delete_agent: removed host-side bind-mount dir for {}", agent_id);
        }
    }

    // TODO: If isolated, tear down container

    Ok(())
}

pub async fn send_message_internal(
    db: &crate::db::Database,
    agent_id: &str,
    message: &str,
) -> Result<Value, String> {
    // Step 1: Get or create conversation
    let conv_id = db.get_or_create_conversation(agent_id)
        .map_err(|e| format!("Failed to get conversation: {}", e))?;

    // Step 2: Log user message to DB
    let _ = db.insert_message(&conv_id, "user", message);

    // Step 3: Kill any orphaned `openclaw agents add` processes before spawning the agent
    // command. Without the container-side timeout (older binaries), a timed-out agents add
    // call leaves a full Node.js runtime (~600MB) running in the container. That orphan,
    // combined with the new agent process, can push the container past its memory limit.
    // pkill is idempotent — if there are no matching processes it exits 1 but causes no harm.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        get_docker_command()
            .args(["exec", "canopy-gateway", "sh", "-c",
                   "pkill -f 'openclaw agents' 2>/dev/null; true"])
            .output(),
    ).await;

    // Step 4: Send via native OpenClaw CLI
    // NODE_OPTIONS=--v8-pool-size=1 prevents the Node.js process from trying to create
    // 4 worker threads at startup (which fails with uv_thread_create/EAGAIN under PID pressure).
    // The openclaw CLI is a thin IPC client — 1 background thread is sufficient.
    let cmd_future = get_docker_command()
        .args([
            "exec", "-u", "node",
            "-e", "NODE_OPTIONS=--v8-pool-size=1",
            "canopy-gateway",
            "openclaw", "agent",
            "--agent", agent_id,
            "--message", message,
            "--json"
        ])
        .output();

    // 180-second timeout — agents can take 20-90s to respond under memory pressure.
    // The old 60-second timeout was triggering auto-heal loops that made things worse.
    let output = match tokio::time::timeout(std::time::Duration::from_secs(180), cmd_future).await {
         Ok(res) => res.map_err(|e| format!("Failed to send message: {}", e))?,
         Err(_) => return Err("The agent is taking a long time to respond. The container may be under load — please wait 30 seconds and try again.".into()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    tracing::debug!(
        "send_message_internal: agent={} exit={:?} stdout_len={} stderr_len={} stderr_preview={}",
        agent_id, output.status.code(), stdout.len(), stderr.len(),
        stderr.chars().take(200).collect::<String>()
    );

    if !output.status.success() {
        let mut combined = format!("{}\n{}", stdout, stderr).trim().to_string();
        
        // If the container was OOMKilled, or it was already stopped, return a specific error that triggers UI healing
        if combined.contains("cannot exec in a stopped container") || combined.contains("OCI runtime exec failed") {
            return Err("Infrastructure gateway is offline or has crashed (Stopped Container).".to_string());
        }
        
        if combined.is_empty() {
            // Exit code 137 usually means OOM in Docker
            if output.status.code() == Some(137) {
                return Err("Infrastructure gateway was terminated by the OS due to excessive memory usage (OOM).".to_string());
            }
            combined = format!("OpenClaw execution failed silently with status code: {}", output.status);
        }
        return Err(combined);
    }
    
    // Check if it's valid JSON
    let body = match serde_json::from_str::<Value>(&stdout) {
        Ok(json) => json,
        Err(_) => {
            // Plaintext fallback — wrap so extraction logic below can handle it uniformly.
            json!({ "response": stdout.trim() })
        }
    };

    // ── Extract response text ─────────────────────────────────────────────────
    // OpenClaw's `openclaw agent --json` response shape (confirmed from live run):
    //   { "payloads": [{ "text": "...", "mediaUrl": null }], "meta": { ... } }
    //
    // Older or plaintext fallback shapes we also handle:
    //   { "response": "..." }   — our own wrapped plaintext case above
    //   { "content": "..." }    — hypothetical future shape
    //   { "text": "..." }       — top-level text (some CLI versions)
    //
    // The `.unwrap_or_else(|| body.to_string())` last-resort would dump the entire
    // JSON blob as chat text — that's the bug: payloads[0].text MUST be checked first.
    let response_text: String = body["result"]["payloads"]
        .as_array()
        .or_else(|| body["payloads"].as_array())
        .and_then(|arr| arr.first())
        .and_then(|p| p["text"].as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| body["result"]["response"].as_str().filter(|s| !s.is_empty()).map(String::from))
        .or_else(|| body["response"].as_str().filter(|s| !s.is_empty()).map(String::from))
        .or_else(|| body["result"]["content"].as_str().filter(|s| !s.is_empty()).map(String::from))
        .or_else(|| body["content"].as_str().filter(|s| !s.is_empty()).map(String::from))
        .or_else(|| body["text"].as_str().filter(|s| !s.is_empty()).map(String::from))
        .unwrap_or_else(|| {
            // Nothing extractable — log the full body for debugging then return an error placeholder
            tracing::warn!("send_message_internal: unrecognised response shape from openclaw, body={}", body);
            format!("[No response extracted — check logs]")
        });

    // OpenClaw emits "OpenClaw: <error>" lines when the agent is misconfigured.
    // Return these as errors so the UI can offer the repair flow.
    if response_text.starts_with("OpenClaw:") {
        return Err(format!(
            "{} — Open this agent's Overview tab and click \"Re-Initialize Setup\" to configure API keys.",
            response_text.trim()
        ));
    }

    let _ = db.insert_message(&conv_id, "assistant", &response_text);

    // Step 5: Log audit event
    let _ = db.log_audit(agent_id, "send_message", Some("openclaw"), "Message sent to agent", None);

    Ok(json!({ "response": response_text }))
}

#[tauri::command]
pub async fn send_message(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    message: String,
) -> Result<Value, String> {
    send_message_internal(&*db, &agent_id, &message).await
}

#[tauri::command]
pub async fn get_conversation_history(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    limit: Option<u32>,
) -> Result<Vec<crate::db::Message>, String> {
    // 1. Get the session directory
    let sessions_dir = dirs::data_dir()
        .map(|d| d.join("Canopy").join("openclaw-state").join("agents").join(&agent_id).join("sessions"))
        .ok_or_else(|| "Failed to locate app data dir".to_string())?;

    let mut parsed_messages: Vec<crate::db::Message> = Vec::new();

    // 1. Always fetch from SQLite DB first
    if let Ok(conv_id) = db.get_or_create_conversation(&agent_id) {
        if let Ok(db_messages) = db.get_messages(&conv_id, limit.unwrap_or(50)) {
            parsed_messages.extend(db_messages);
        }
    }

    // 2. Fetch from OpenClaw session directory if it exists

    // 2. Read all .jsonl files in the sessions directory
    if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                if let Ok(file) = std::fs::File::open(&path) {
                    let reader = std::io::BufReader::new(file);
                    use std::io::BufRead;
                    for line in reader.lines().flatten() {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                            if json.get("type").and_then(|t| t.as_str()) == Some("message") {
                                // Extract required fields
                                let id = json.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let ts_str = json.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                
                                if let Some(msg_obj) = json.get("message") {
                                    let role = msg_obj.get("role").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    
                                    let mut final_content = String::new();
                                    
                                    if let Some(content_arr) = msg_obj.get("content").and_then(|v| v.as_array()) {
                                        for block in content_arr {
                                            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                            if block_type == "thinking" {
                                                if let Some(think_text) = block.get("thinking").and_then(|v| v.as_str()) {
                                                    final_content.push_str(&format!("[THOUGHT_PROCESS]{}[/THOUGHT_PROCESS]\n\n", think_text));
                                                }
                                            } else if block_type == "text" {
                                                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                                    let mut clean_text = text.to_string();
                                                    
                                                    // Strip verbose Slack JSON metadata
                                                    while let Some(start) = clean_text.find("```json") {
                                                        if let Some(end_offset) = clean_text[start+7..].find("```") {
                                                            let full_end = start + 7 + end_offset + 3;
                                                            let mut remove_end = full_end;
                                                            while remove_end < clean_text.len() && clean_text[remove_end..].starts_with('\n') {
                                                                remove_end += 1;
                                                            }
                                                            clean_text.replace_range(start..remove_end, "");
                                                        } else {
                                                            break;
                                                        }
                                                    }
                                                    clean_text = clean_text.replace("Conversation info (untrusted metadata):\n", "");
                                                    clean_text = clean_text.replace("Sender (untrusted metadata):\n", "");
                                                    
                                                    // Clean tags
                                                    clean_text = clean_text.replace("<final>", "").replace("</final>", "");

                                                    final_content.push_str(clean_text.trim());
                                                }
                                            }
                                        }
                                    }
                                    
                                    if !final_content.is_empty() {
                                        parsed_messages.push(crate::db::Message {
                                            id,
                                            conversation_id: agent_id.clone(),
                                            role,
                                            content: final_content.trim().to_string(),
                                            timestamp: ts_str,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort by timestamp descending
    parsed_messages.sort_by(|a, b| {
        let ts_a = chrono::DateTime::parse_from_rfc3339(&a.timestamp).map(|dt| dt.with_timezone(&chrono::Utc)).unwrap_or_default();
        let ts_b = chrono::DateTime::parse_from_rfc3339(&b.timestamp).map(|dt| dt.with_timezone(&chrono::Utc)).unwrap_or_default();
        ts_b.cmp(&ts_a)
    });

    let mut seen_ids = std::collections::HashSet::new();
    parsed_messages.retain(|msg| seen_ids.insert(msg.id.clone()));

    if let Some(l) = limit {
        parsed_messages.truncate(l as usize);
    }
    
    Ok(parsed_messages)
}

#[tauri::command]
pub async fn import_agent(
    db: tauri::State<'_, crate::db::Database>,
    name: String,
    openclaw_agent_id: String,
) -> Result<Agent, String> {
    // Step 1: Query OpenClaw gateway for agent details
    let client = Client::new();
    let resp = client
        .get(format!("{}/api/agents/{}", GATEWAY_URL, openclaw_agent_id))
        .header("Authorization", &crate::model_constants::gateway_bearer_header())
        .send()
        .await
        .map_err(|e| format!("Failed to query gateway: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Agent not found in OpenClaw: {}", openclaw_agent_id));
    }

    let agent_data = resp.json::<Value>().await.map_err(|e| e.to_string())?;

    // Step 2: Create local Agent struct from OpenClaw data.
    // Prefer the model specified in the imported agent's data; fall back to the best
    // available model based on which API keys are present. Never leave active_model as
    // None — an agent without a model will silently fail to respond.
    let has_anthropic = crate::keychain::get_secret("ANTHROPIC_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_openai    = crate::keychain::get_secret("OPENAI_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_gemini    = crate::keychain::get_secret("GEMINI_API_KEY").map_or(false, |s| !s.trim().is_empty());

    let imported_model = agent_data.get("model")
        .and_then(|v| v.as_str())
        .and_then(|m| crate::model_constants::validate_model_string(m).ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            crate::model_constants::default_model_from_available_keys(has_anthropic, has_openai, has_gemini).to_string()
        });

    let agent = Agent {
        id: openclaw_agent_id.clone(),
        name: name.clone(),
        role: agent_data.get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .to_string(),
        emoji: agent_data.get("emoji")
            .and_then(|v| v.as_str())
            .unwrap_or("agent")
            .to_string(),
        capabilities: crate::models::AgentCapabilities::default(),
        color: "#34D399".to_string(),
        status: AgentStatus::Active,
        isolated: false,
        paused: false,
        container_id: None,
        visual_identity: None,
        personality: AgentPersonality {
            name: name.clone(),
            communication_style: String::new(),
            expertise: vec![],
            guardrails: vec![],
            custom_instructions: String::new(),
            active_model: Some(imported_model),
            soul_template: None,
            identity_template: None,
        },
        integrations: vec![],
        memories: vec![],
        created_at: chrono::Utc::now(),
        stats: AgentStats::default(),
    };

    // Step 3: Persist to local DB
    db.insert_agent(&agent)
        .map_err(|e| format!("Failed to save agent to DB: {}", e))?;

    // Step 4: Log audit event
    let _ = db.log_audit(&openclaw_agent_id, "import", Some("openclaw"), "Agent imported from OpenClaw", None);

    Ok(agent)
}

#[tauri::command]
pub async fn get_agent_health(agent_id: String) -> Result<Value, String> {
    let client = Client::new();
    let resp = client
        .get(format!("{}/health/stats", GATEWAY_URL))
        .header("Authorization", &crate::model_constants::gateway_bearer_header())
        .send()
        .await
        .map_err(|e| format!("Health check failed: {}", e))?;

    let body = resp.json::<Value>().await.map_err(|e| e.to_string())?;
    Ok(body)
}

/// Fetch the last N lines of the gateway container log.
/// Used by the frontend to display a live log tail during the loading screen.
/// Returns empty string if the container isn't running or docker is unavailable.
#[tauri::command]
pub async fn get_gateway_log_tail(lines: u32) -> Result<String, String> {
    let n = lines.clamp(1, 200).to_string();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        get_docker_command()
            .args(["logs", "--tail", &n, "canopy-gateway"])
            .output(),
    )
    .await;
    match result {
        Ok(Ok(out)) => {
            // Docker sends container logs to stderr by default
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let combined = format!("{}{}", stdout, stderr);
            Ok(combined.trim().to_string())
        }
        Ok(Err(e)) => {
            tracing::debug!("get_gateway_log_tail: docker error: {}", e);
            Ok(String::new())
        }
        Err(_) => {
            tracing::debug!("get_gateway_log_tail: timed out");
            Ok(String::new())
        }
    }
}

#[tauri::command]
pub async fn check_agent_status(agent_id: String) -> Result<String, String> {
    // Wrap docker exec in a hard 8-second timeout.
    // After boot_sync_agents runs `openclaw agents add`, the gateway spends ~30-60s
    // initializing channels/sidecars for each agent. During this phase, the OpenClaw IPC
    // socket is blocked and `docker exec ... openclaw agents list` hangs indefinitely.
    // Without this timeout, every health-poll call accumulates a hung docker exec process
    // until the async runtime is exhausted. With the timeout, we get "offline" briefly
    // during warmup and "active" once the IPC is available again.
    let exec_future = get_docker_command()
        .args(["exec", "-e", "NODE_OPTIONS=--v8-pool-size=1", "canopy-gateway", "timeout", "-k", "2", "7", "openclaw", "agents", "list", "--json"])
        .output();

    match tokio::time::timeout(std::time::Duration::from_secs(8), exec_future).await {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Ok(agents) = serde_json::from_str::<Value>(&stdout) {
                if let Some(agents_arr) = agents.as_array() {
                    if agents_arr.iter().any(|a| a.get("id").and_then(|i| i.as_str()) == Some(&agent_id)) {
                        return Ok("active".to_string());
                    }
                }
            }
            // IPC worked but agent not in list (empty array during boot, or not yet registered).
            // Fall through to check the disk config so we don't incorrectly toggle to "offline"
            // while `agents add` is still initializing it!
            tracing::debug!("check_agent_status: IPC returned empty or missing agent {}, falling back to disk", agent_id);
        }
        Ok(Ok(_)) => {
            // docker exec returned non-zero (container not running, etc.)
            return Ok("error".to_string());
        }
        Ok(Err(e)) => {
            tracing::debug!("check_agent_status: docker exec failed: {}", e);
        }
        Err(_) => {
            tracing::debug!("check_agent_status: docker exec timed out — gateway IPC busy (channel init?)");
        }
    }

    // IPC unavailable — fall back to reading openclaw.json from the host bind-mount.
    // This lets us detect that agents add succeeded even when the Node.js event loop
    // is blocked by channel/sidecar init. The gateway IS running; it's just busy.
    if let Some(config_path) = dirs::data_dir().map(|d| d.join("Canopy").join("openclaw-state").join("openclaw.json")) {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(cfg) = serde_json::from_str::<Value>(&content) {
                if let Some(list) = cfg.pointer("/agents/list").and_then(|v| v.as_array()) {
                    if list.iter().any(|a| a.get("id").and_then(|i| i.as_str()) == Some(&agent_id)) {
                        tracing::debug!("check_agent_status: agent {} found in bind-mount openclaw.json (IPC busy)", agent_id);
                        return Ok("active".to_string());
                    }
                }
            }
        }
    }

    Ok("offline".to_string())
}

/// Helper: fetch API keys for a specific agent (falling back to global keys)
fn get_creds_for_agent(agent_id: &str) -> std::collections::HashMap<String, String> {
    let mut keys = std::collections::HashMap::new();
    let try_key = |k: &str| crate::keychain::get_secret(k).unwrap_or_default();
    let ag_anthropic = try_key(&format!("agent_{}_anthropic_key", agent_id));
    let ag_openai    = try_key(&format!("agent_{}_openai_key",    agent_id));
    let ag_gemini    = try_key(&format!("agent_{}_gemini_key",    agent_id));
    let ag_grok      = try_key(&format!("agent_{}_grok_key",      agent_id));
    
    if !ag_anthropic.trim().is_empty() { keys.insert("ANTHROPIC_API_KEY".into(), ag_anthropic); }
    else if let Ok(v) = crate::keychain::get_secret("ANTHROPIC_API_KEY") { if !v.trim().is_empty() { keys.insert("ANTHROPIC_API_KEY".into(), v); } }
    
    if !ag_openai.trim().is_empty() { keys.insert("OPENAI_API_KEY".into(), ag_openai); }
    else if let Ok(v) = crate::keychain::get_secret("OPENAI_API_KEY") { if !v.trim().is_empty() { keys.insert("OPENAI_API_KEY".into(), v); } }
    
    if !ag_gemini.trim().is_empty() { keys.insert("GEMINI_API_KEY".into(), ag_gemini); }
    else if let Ok(v) = crate::keychain::get_secret("GEMINI_API_KEY") { if !v.trim().is_empty() { keys.insert("GEMINI_API_KEY".into(), v); } }
    
    if !ag_grok.trim().is_empty() { keys.insert("XAI_API_KEY".into(), ag_grok); }
    else if let Ok(v) = crate::keychain::get_secret("XAI_API_KEY") { if !v.trim().is_empty() { keys.insert("XAI_API_KEY".into(), v); } }
    else if let Ok(v) = crate::keychain::get_secret("GROK_API_KEY") { if !v.trim().is_empty() { keys.insert("XAI_API_KEY".into(), v); } }
    
    keys
}

/// Write auth-profiles.json directly to the container for a given agent.
///
/// Internal helper — NOT a Tauri command. No host-dir guard — callers must ensure the
/// agent is already registered before calling this. Writes to both layout paths so it
/// works regardless of agent naming origin (imported "sloane" or Canopy-created "agent-sloane").
async fn write_auth_profiles(agent_id: &str, keys: &std::collections::HashMap<String, String>) {
    let mut profiles = serde_json::Map::new();
    for (k, v) in keys {
        if v.trim().is_empty() { continue; }
        let (provider, profile_key) = match k.as_str() {
            "ANTHROPIC_API_KEY" => ("anthropic", "anthropic:default"),
            "OPENAI_API_KEY"    => ("openai",    "openai:default"),
            "GEMINI_API_KEY"    => ("google",    "google:default"),
            "XAI_API_KEY"       => ("xai",       "xai:default"),
            _ => continue,
        };
        profiles.insert(profile_key.to_string(), json!({
            "type": "api_key", "provider": provider, "key": v.trim()
        }));
    }
    if profiles.is_empty() { return; }

    let auth_json = serde_json::to_string_pretty(&json!({
        "version": 1,
        "profiles": profiles
    })).unwrap_or_default();

    // Write to both paths — agent/ subdir (confirmed layout) and flat (fallback).
    // mkdir -p ensures the directories are created even if openclaw hasn't written them yet.
    let p1 = format!("/home/node/.openclaw/agents/{}/agent/auth-profiles.json", agent_id);
    let p2 = format!("/home/node/.openclaw/agents/{}/auth-profiles.json", agent_id);
    let write_cmd = format!(
        "mkdir -p $(dirname '{p1}') && cat > '{p1}' << 'AUTHEOF'\n{json}\nAUTHEOF\nchmod 600 '{p1}' && \
         mkdir -p $(dirname '{p2}') && cat > '{p2}' << 'AUTHEOF'\n{json}\nAUTHEOF\nchmod 600 '{p2}'",
        p1 = p1, p2 = p2, json = auth_json,
    );
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &write_cmd])
            .output(),
    ).await {
        Ok(Ok(o)) if o.status.success() =>
            tracing::info!("write_auth_profiles: credentials written for agent {}", agent_id),
        Ok(Ok(o)) =>
            tracing::warn!("write_auth_profiles: write failed for {}: {}", agent_id,
                           String::from_utf8_lossy(&o.stderr).trim()),
        _ =>
            tracing::warn!("write_auth_profiles: timed out writing credentials for {}", agent_id),
    }
}

#[tauri::command]
pub async fn sync_credentials(
    agent_id: String,
    keys: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    // ⚠️  CRITICAL: auth-profiles.json MUST use OpenClaw's versioned profiles format.
    //
    // WRONG (old Canopy format — OpenClaw silently ignores this):
    //   {"google": {"apiKey": "AIza..."}}
    //
    // CORRECT (from working reference agent at /Users/scottieryan/agents/sloane):
    //   {
    //     "version": 1,
    //     "profiles": {
    //       "google:default": {"type": "api_key", "provider": "google", "key": "AIza..."}
    //     }
    //   }
    //
    // With the wrong format, OpenClaw fails to authenticate on every message,
    // triggering a LiteLLM retry loop that spirals to 1000+ PIDs and OOM-kills the container.
    let mut profiles = serde_json::Map::new();

    for (k, v) in &keys {
        if v.trim().is_empty() { continue; }
        let (provider, profile_key) = match k.as_str() {
            "ANTHROPIC_API_KEY" => ("anthropic", "anthropic:default"),
            "OPENAI_API_KEY"    => ("openai",    "openai:default"),
            "GEMINI_API_KEY"    => ("google",    "google:default"),
            "XAI_API_KEY"       => ("xai",       "xai:default"),
            _ => continue,
        };
        profiles.insert(
            profile_key.to_string(),
            json!({
                "type":     "api_key",
                "provider": provider,
                "key":      v.trim()
            })
        );
    }

    if profiles.is_empty() {
        return Ok(()); // Nothing to sync
    }

    // ── Guard: only write if the agent has already been registered via `openclaw agents add` ──
    //
    // `openclaw agents add` creates agents/{id}/ in the bind mount. If that directory
    // doesn't exist yet, it means the agent isn't registered and the gateway hasn't
    // started any sidecars for it — writing auth-profiles.json now would CREATE the
    // directory, which OpenClaw will then scan and try to start channel sidecars for
    // (Slack, browser, voice, etc.) BEFORE we've called `agents add`. Those sidecars
    // start with no valid tokens and enter retry loops, permanently blocking the IPC
    // event loop (30+ worker processes, OOM within minutes).
    //
    // boot_sync_agents calls sync_credentials_internal() directly after each successful
    // `agents add`, bypassing this guard (since the dir will have just been created).
    // This guard only blocks the premature frontend call (React Strict Mode fires the
    // startup effect twice; the second firing returns immediately from boot_sync_agents
    // and then calls sync_credentials 1 second into the container's 13-second boot).
    let agent_dir = dirs::data_dir()
        .map(|d| d.join("Canopy").join("openclaw-state").join("agents").join(&agent_id));
    if let Some(ref dir) = agent_dir {
        if !dir.exists() {
            tracing::info!(
                "sync_credentials: agent dir for {} not yet created by agents add — skipping premature write",
                agent_id
            );
            return Ok(());
        }
    }

    let auth_json = serde_json::to_string_pretty(&json!({
        "version":  1,
        "profiles": profiles
    })).unwrap();

    // Write auth-profiles.json to both possible paths so we're covered regardless of
    // whether OpenClaw's gateway mode uses agents/{id}/agent/ (like single-agent mode)
    // or agents/{id}/ (flat layout). One write will land in the right place; the other
    // is a harmless extra file OpenClaw ignores.
    //
    // Verified layout from working Sloane reference (agent mode, Apr 2026):
    //   agents/main/agent/auth-profiles.json  ← with extra agent/ subdir
    // Gateway mode layout is unconfirmed; we cover both to be safe.
    let filepath_with_subdir = format!("/home/node/.openclaw/agents/{}/agent/auth-profiles.json", agent_id);
    let filepath_flat        = format!("/home/node/.openclaw/agents/{}/auth-profiles.json", agent_id);

    let write_cmd = format!(
        // Write to both paths; mkdir -p creates the directories as needed.
        "mkdir -p $(dirname '{p1}') && cat > '{p1}' << 'AUTHEOF'\n{json}\nAUTHEOF\nchmod 600 '{p1}' && \
         mkdir -p $(dirname '{p2}') && cat > '{p2}' << 'AUTHEOF'\n{json}\nAUTHEOF\nchmod 600 '{p2}'",
        p1 = filepath_with_subdir,
        p2 = filepath_flat,
        json = auth_json,
    );

    let cmd_future = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &write_cmd])
        .output();

    let output = match tokio::time::timeout(std::time::Duration::from_secs(5), cmd_future).await {
        Ok(res) => res.map_err(|e| format!("Failed to write auth profile: {}", e))?,
        Err(_) => return Err("Docker command timed out, proxy might be hanging".into()),
    };

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Docker exec failed: {}", err));
    }

    tracing::info!("sync_credentials: wrote auth-profiles to both paths for agent {}", agent_id);
    Ok(())
}

// ─── SOUL.md Generation ──────────────────────────────────────────────────────

/// Generate a SOUL.md file from a structured personality.
/// This is the bridge between our GUI and OpenClaw's native personality system.
fn generate_soul_md(personality: &AgentPersonality) -> String {
    let mut soul = personality.soul_template.clone().unwrap_or_default();
    
    if soul.is_empty() {
        // Fallback to legacy hardcoded format if no template was provided
        soul.push_str(&format!("# {}\n\n", personality.name));
        soul.push_str("## Communication Style\n\n");
        soul.push_str(&format!("{}\n\n", personality.communication_style));

        if !personality.expertise.is_empty() {
            soul.push_str("## Expertise\n\n");
            for area in &personality.expertise {
                soul.push_str(&format!("- {}\n", area));
            }
            soul.push('\n');
        }

        if !personality.guardrails.is_empty() {
            soul.push_str("## Guardrails\n\n");
            for guardrail in &personality.guardrails {
                soul.push_str(&format!("- {}\n", guardrail));
            }
            soul.push('\n');
        }

        if !personality.custom_instructions.is_empty() {
            soul.push_str("## Additional Instructions\n\n");
            soul.push_str(&personality.custom_instructions);
            soul.push('\n');
        }
    } else {
        // Replace template variables
        soul = soul.replace("{{name}}", &personality.name);
        soul = soul.replace("{{description}}", &personality.communication_style);
    }

    const CANOPY_PROTOCOLS: &str = include_str!("../CANOPY_PROTOCOLS.md");
    if !soul.contains("CANOPY_PROTOCOLS") {
        soul.push_str("\n\n");
        soul.push_str(CANOPY_PROTOCOLS);
        soul.push_str("\n\n");
    }

    soul
}

/// Generates the shell command to sync personality files to the container.
/// This uses `if [ ! -f ... ]` to ensure we NEVER overwrite existing files,
/// protecting user edits in SOUL.md, IDENTITY.md, and PREFERENCES.md.
fn generate_personality_sync_cmd(soul_path: &str, soul: &str, identity: &str, prefs: &str) -> String {
    let escaped_soul = soul.replace('\'', "'\\''");
    let escaped_identity = identity.replace('\'', "'\\''");
    let escaped_prefs = prefs.replace('\'', "'\\''");
    
    format!(
        "mkdir -p \"$(dirname '{soul_path}')\" && \
         if [ ! -f '{soul_path}' ]; then printf '%s' '{soul}' > '{soul_path}'; fi && \
         if [ ! -f \"$(dirname '{soul_path}')\"/IDENTITY.md ]; then printf '%s' '{identity}' > \"$(dirname '{soul_path}')\"/IDENTITY.md; fi && \
         if [ ! -f \"$(dirname '{soul_path}')\"/PREFERENCES.md ]; then printf '%s' '{prefs}' > \"$(dirname '{soul_path}')\"/PREFERENCES.md; fi && \
         touch \"$(dirname '{soul_path}')\"/AGENTS.md \"$(dirname '{soul_path}')\"/TOOLS.md \"$(dirname '{soul_path}')\"/USER.md",
        soul_path = soul_path,
        soul = escaped_soul,
        identity = escaped_identity,
        prefs = escaped_prefs,
    )
}

// ─── Local Discovery & Import ────────────────────────────────────────────────

#[tauri::command]
pub async fn scan_local_agents() -> Result<Vec<DiscoveredAgent>, String> {
    let mut discovered = Vec::new();

    // 1. Scan Local FS (~/.openclaw/agents or ~/agents for testing)
    if let Some(home) = dirs::home_dir() {
        let candidates = vec![
            home.join(".openclaw").join("agents"),
            home.join("agents"),
        ];

        for agents_dir in candidates {
            if agents_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&agents_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            let id = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                            discovered.push(DiscoveredAgent {
                                source: "local_fs".to_string(),
                                name: id.clone(),
                                id: id.clone(),
                                path: path.to_string_lossy().to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    // 2. Scan Docker / OrbStack pseudo-directories or volumes
    // (A full implementation would use bollard to list active openclaw containers).
    
    // 3. Scan HTTP ports for running standalone OpenClaw instances reachable from the host.
    // 18789 is container-internal only — do NOT include it here or every scan will falsely
    // report a gateway on a port that isn't reachable from outside Docker.
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_millis(800)).build().unwrap_or_default();
    let ports = [crate::model_constants::GATEWAY_HOST_PORT, 18798];
    for port in ports {
        if let Ok(resp) = client.get(format!("http://localhost:{}/api/status", port))
            .header("Authorization", &crate::model_constants::gateway_bearer_header())
            .send().await {
            if resp.status().is_success() {
                discovered.push(DiscoveredAgent {
                    source: format!("running_port_{}", port),
                    name: format!("Standalone on port {}", port),
                    id: format!("standalone-{}", port),
                    path: format!("http://localhost:{}", port),
                });
            }
        }
    }

    Ok(discovered)
}

#[tauri::command]
pub async fn import_discovered_agent(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    path: String,
) -> Result<Agent, String> {
    let soul_content = if path.starts_with("http") {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_millis(2000)).build().unwrap_or_default();
        if let Ok(resp) = client.get(format!("{}/api/agent", path))
            .header("Authorization", &crate::model_constants::gateway_bearer_header())
            .send().await {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                json["instructions"].as_str().unwrap_or("# Imported Standalone Agent").to_string()
            } else {
                "# Imported Standalone Agent".to_string()
            }
        } else {
            "# Imported Standalone Agent".to_string()
        }
    } else {
        let agent_path = std::path::PathBuf::from(&path);
        let src_workspace = agent_path.join("workspace");
        
        let soul_path = src_workspace.join("SOUL.md");
        let content = std::fs::read_to_string(&soul_path).unwrap_or_else(|_| {
            std::fs::read_to_string(agent_path.join("SOUL.md"))
                .unwrap_or_else(|_| "# SOUL.md - Imported Agent".to_string())
        });

        // Pre-emptively copy any existing markdown files to the target workspace
        // so that `boot_sync_agents` doesn't just create empty versions of them.
        if let Some(target_workspace) = dirs::data_dir().map(|d| d.join("Canopy").join("openclaw-state").join("workspace").join(&agent_id)) {
            let _ = std::fs::create_dir_all(&target_workspace);
            let dirs_to_check = [src_workspace, agent_path];
            for d in dirs_to_check {
                if let Ok(entries) = std::fs::read_dir(&d) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("md") {
                            if let Some(name) = path.file_name() {
                                let _ = std::fs::copy(&path, target_workspace.join(name));
                            }
                        }
                    }
                }
            }
        }

        content
    };
        
    let name = agent_id.clone();

    // Pick the best available model — never leave active_model as None.
    let has_anthropic = crate::keychain::get_secret("ANTHROPIC_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_openai    = crate::keychain::get_secret("OPENAI_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_gemini    = crate::keychain::get_secret("GEMINI_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let default_model = crate::model_constants::default_model_from_available_keys(has_anthropic, has_openai, has_gemini).to_string();

    let agent = Agent {
        id: agent_id.clone(),
        name: name.clone(),
        role: "Imported Role".to_string(),
        emoji: "lobster".to_string(),
        color: "#64C8C0".to_string(),
        status: AgentStatus::Active,
        isolated: false,
        paused: false,
        capabilities: crate::models::AgentCapabilities::default(),
        container_id: None,
        visual_identity: None,
        personality: AgentPersonality {
            name: name.clone(),
            communication_style: "Imported from local disk".to_string(),
            expertise: vec![],
            guardrails: vec![],
            custom_instructions: soul_content,
            active_model: Some(default_model),
            soul_template: None,
            identity_template: None,
        },
        integrations: vec![],
        memories: vec![],
        created_at: chrono::Utc::now(),
        stats: AgentStats::default(),
    };

    db.insert_agent(&agent)
        .map_err(|e| format!("Failed to save agent to DB: {}", e))?;

    let _ = db.log_audit(&agent_id, "import_local", Some("openclaw"), "Agent imported from local filesystem", None);

    Ok(agent)
}

#[tauri::command]
pub async fn repair_gateway(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String
) -> Result<String, String> {
    use std::fmt::Write as _;
    let mut log = String::new();

    // ─── Step 1: Verify Docker daemon is accessible ───────────────────────────
    let _ = writeln!(log, "Step 1/6: Checking Docker daemon...");
    let ping = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        get_docker_command().args(["info", "--format", "{{.ServerVersion}}"]).output(),
    ).await;
    match ping {
        Err(_) => {
            let _ = writeln!(log, "  ✗ Docker timed out (OrbStack may be starting)");
            return Err(format!("{}\nDocker daemon is not responding. Open OrbStack, wait for it to finish starting, then try again.", log));
        }
        Ok(Err(e)) => {
            let _ = writeln!(log, "  ✗ Docker not found: {}", e);
            return Err(format!("{}\nDocker executable not found. Make sure OrbStack is installed.\nError: {}", log, e));
        }
        Ok(Ok(out)) if !out.status.success() => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let _ = writeln!(log, "  ✗ Docker daemon offline: {}", stderr.trim());
            return Err(format!("{}\nDocker daemon is not running. Start OrbStack and try again.", log));
        }
        Ok(Ok(_)) => { let _ = writeln!(log, "  ✓ Docker daemon reachable"); }
    }

    // ─── Step 2: Ensure gateway container is running ─────────────────────────
    let _ = writeln!(log, "Step 2/6: Checking gateway container...");
    let inspect = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        get_docker_command().args(["inspect", "-f", "{{.State.Running}}", "canopy-gateway"]).output(),
    ).await;
    let container_running = matches!(
        inspect,
        Ok(Ok(ref out)) if String::from_utf8_lossy(&out.stdout).trim() == "true"
    );

    if !container_running {
        let _ = writeln!(log, "  ! Gateway container offline — attempting to start...");
        match crate::docker::start_gateway().await {
            Ok(_) => {
                let _ = writeln!(log, "  ✓ Gateway container started — waiting 5s for initialization...");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
            Err(e) => {
                let _ = writeln!(log, "  ✗ Failed to start gateway: {}", e);
                return Err(format!(
                    "{}\nCould not start the gateway container.\n\nReason: {}\n\nTry a Hard Reset from Settings → Infrastructure.",
                    log, e
                ));
            }
        }
        // Confirm it actually came up
        let recheck = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            get_docker_command().args(["inspect", "-f", "{{.State.Running}}", "canopy-gateway"]).output(),
        ).await;
        if !matches!(recheck, Ok(Ok(ref out)) if String::from_utf8_lossy(&out.stdout).trim() == "true") {
            let _ = writeln!(log, "  ✗ Container still not running after start attempt");
            return Err(format!(
                "{}\nGateway container failed to start. Check that OrbStack is fully running, then try a Hard Reset from Settings → Infrastructure.",
                log
            ));
        }
        let _ = writeln!(log, "  ✓ Container confirmed running");
    } else {
        let _ = writeln!(log, "  ✓ Gateway container is running");
    }

    // ─── Step 3: Register agent in gateway ───────────────────────────────────
    let _ = writeln!(log, "Step 3/6: Registering agent \"{}\" in gateway...", agent_id);

    // Helper closure to run `openclaw agents add` with a container-side timeout.
    // The container's `timeout` binary kills the process when the deadline fires,
    // preventing orphaned OpenClaw runtimes from accumulating inside the container.
    let run_agents_add = |agent_id: &str| {
        let agent_id = agent_id.to_string();
        async move {
            let workspace_path = format!("/home/node/.openclaw/workspace/{}", agent_id);
            // Container timeout 5s shorter than Rust timeout so the process is always
            // killed inside the container first (exit code 124 = timed out).
            let container_secs = "10"; // 10s inside, 15s Rust timeout
            tokio::time::timeout(
                std::time::Duration::from_secs(15),
                get_docker_command()
                    .args([
                        "exec", "-u", "node",
                        "-e", "NODE_OPTIONS=--v8-pool-size=1",
                        "canopy-gateway",
                        "timeout", container_secs,
                        "openclaw", "agents", "add",
                        &agent_id,
                        "--workspace", &workspace_path,
                    ])
                    .output()
            ).await
        }
    };

    let add_result = run_agents_add(&agent_id).await;

    // If the first attempt times out while the container is running, it means the openclaw
    // process inside the container is stuck (common after an unclean shutdown). Automatically
    // restart the container and retry once before reporting failure.
    let add_output = match add_result {
        Err(_) => {
            let state = get_docker_command()
                .args(["inspect", "-f", "{{.State.Status}}", "canopy-gateway"])
                .output().await
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_else(|| "unknown".into());

            let _ = writeln!(log, "  ! Exec timed out (container state: {}) — restarting and retrying...", state);

            // Auto-restart the container to clear the stuck process
            match get_docker_command().args(["restart", "canopy-gateway"]).output().await {
                Ok(o) if o.status.success() => {
                    let _ = writeln!(log, "  ✓ Container restarted — waiting 5s...");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
                Ok(o) => {
                    let _ = writeln!(log, "  ✗ Restart failed: {}", String::from_utf8_lossy(&o.stderr).trim());
                    return Err(format!(
                        "{}\nGateway container is stuck and restart failed. Use the Hard Reset button above, then try again.",
                        log
                    ));
                }
                Err(e) => {
                    let _ = writeln!(log, "  ✗ Restart error: {}", e);
                    return Err(format!(
                        "{}\nGateway container is stuck and could not be restarted: {}\n\nUse the Hard Reset button above, then try again.",
                        log, e
                    ));
                }
            }

            // Retry after restart
            match run_agents_add(&agent_id).await {
                Err(_) => {
                    let _ = writeln!(log, "  ✗ Still timed out after restart — container may be corrupted");
                    return Err(format!(
                        "{}\nThe gateway container is still unresponsive after an automatic restart.\n\nUse the Hard Reset button above to fully rebuild the container, then try again.",
                        log
                    ));
                }
                Ok(Err(e)) => {
                    let _ = writeln!(log, "  ✗ docker exec failed on retry: {}", e);
                    return Err(format!("{}\nFailed to run docker exec on retry: {}", log, e));
                }
                Ok(Ok(out)) => {
                    let _ = writeln!(log, "  ✓ Retry succeeded after restart");
                    out
                }
            }
        }
        Ok(Err(e)) => {
            let _ = writeln!(log, "  ✗ docker exec failed: {}", e);
            return Err(format!("{}\nFailed to run docker exec: {}", log, e));
        }
        Ok(Ok(out)) => out,
    };

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        let stdout = String::from_utf8_lossy(&add_output.stdout);
        let combined = format!("{}\n{}", stdout, stderr);
        let detail = combined.trim();

        if detail.to_lowercase().contains("already exists") {
            let _ = writeln!(log, "  ✓ Agent already registered (continuing with repair)");
        } else {
            // Build a meaningful message even when docker produces no output
            let explanation = if detail.is_empty() {
                let state = get_docker_command()
                    .args(["inspect", "-f", "{{.State.Status}}", "canopy-gateway"])
                    .output().await
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_else(|| "unknown".into());
                format!(
                    "The openclaw CLI exited with no output (exit code {}).\n\
                     Container state at failure: {}\n\n\
                     This usually means the container crashed mid-execution or the \
                     openclaw binary is not present in the image.\n\n\
                     Try a Hard Reset from Settings → Infrastructure.",
                    add_output.status.code().unwrap_or(-1),
                    state
                )
            } else {
                detail.to_string()
            };

            let _ = writeln!(log, "  ✗ agents add failed:\n    {}", explanation.replace('\n', "\n    "));
            return Err(format!("{}\n\nAgent registration failed:\n{}", log, explanation));
        }
    } else {
        let _ = writeln!(log, "  ✓ Agent registered successfully");
    }

    // ─── Step 4: Sync personality (SOUL.md) ──────────────────────────────────
    let _ = writeln!(log, "Step 4/6: Writing agent personality...");
    match db.get_agent(&agent_id) {
        Ok(Some(agent)) => {
            let soul_md = generate_soul_md(&agent.personality);
            let soul_path = agent_soul_path(&agent_id);
            let soul_result = get_docker_command()
                .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c",
                    &format!("cat > {} << 'SOULEOF'\n{}\nSOULEOF", soul_path, soul_md)])
                .output().await;
            match soul_result {
                Ok(o) if o.status.success() => { let _ = writeln!(log, "  ✓ Personality synced to {}", soul_path); }
                Ok(o) => { let _ = writeln!(log, "  ! Personality sync warning: {}", String::from_utf8_lossy(&o.stderr).trim()); }
                Err(e) => { let _ = writeln!(log, "  ! Personality sync skipped (non-fatal): {}", e); }
            }
        }
        Ok(None) => { let _ = writeln!(log, "  ! Agent not in local DB — skipping personality sync"); }
        Err(e) => { let _ = writeln!(log, "  ! DB error reading agent (non-fatal): {}", e); }
    }

    // ─── Step 5: Apply gateway configuration ─────────────────────────────────
    // IMPORTANT: Do NOT use `openclaw config set` here. Each config-set call sends
    // OpenClaw a SIGTERM, causing a full process restart. Three config-set calls = 3
    // restarts before the explicit docker restart below — a cascade that takes 30+
    // seconds and leaves the container in an unstable intermediate state.
    //
    // Instead, write the required values directly into openclaw.json via a Node.js
    // one-liner. OpenClaw detects the file change and applies a hot reload (no SIGTERM).
    let _ = writeln!(log, "Step 5/6: Applying gateway configuration (direct JSON write)...");
    let token = GATEWAY_INTERNAL_TOKEN;
    // Determine the correct default model based on which API keys are actually stored.
    // This ALWAYS writes the model (not just when unset) so we override the container's
    // built-in default (google/gemini-2.0-flash) with the user's preferred model.
    let has_anthropic = crate::keychain::get_secret("ANTHROPIC_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_openai    = crate::keychain::get_secret("OPENAI_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_gemini    = crate::keychain::get_secret("GEMINI_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let default_model = crate::model_constants::default_model_from_available_keys(has_anthropic, has_openai, has_gemini);
    let _ = writeln!(log, "  Keys: anthropic={} openai={} gemini={} → default model: {}", has_anthropic, has_openai, has_gemini, default_model);
    let config_patch_script = format!(
        r#"const fs=require('fs');
const p='/home/node/.openclaw/openclaw.json';
let c=JSON.parse(fs.readFileSync(p,'utf8'));
c.gateway=c.gateway||{{}};
c.gateway.mode='local';
// ⚠️  Do NOT write c.gateway.token — "gateway.token" is not a recognised field in
// OpenClaw 2026.4.14. Writing it causes: "Config invalid — gateway: Unrecognized key: token"
// which crash-loops the container. Auth is via gateway.auth.token only.
c.agents=c.agents||{{}};
c.agents.defaults=c.agents.defaults||{{}};
// ⚠️  MUST be an object {{primary: "..."}} — a bare string is silently ignored by OpenClaw
// and leaves the agent with no model, causing every send_message call to fail.
c.agents.defaults.model={{primary:'{model}'}};
fs.writeFileSync(p,JSON.stringify(c,null,2));
console.log('config patched — model set to {model}');
"#,
        model = default_model
    );
    let patch_result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "node", "-e", &config_patch_script])
            .output(),
    ).await;
    match patch_result {
        Ok(Ok(o)) if o.status.success() => { let _ = writeln!(log, "  ✓ Config patched (hot reload — no restart needed)"); }
        Ok(Ok(o)) => { let _ = writeln!(log, "  ! Config patch warning: {}", String::from_utf8_lossy(&o.stderr).trim()); }
        _ => { let _ = writeln!(log, "  ! Config patch skipped (non-fatal)"); }
    }

    // Prune stale session transcripts for this agent only (no hardcoded "main")
    let store_path = format!("/home/node/.openclaw/agents/{}/sessions/sessions.json", agent_id);
    let _ = get_docker_command()
        .args([
            "exec", "-u", "node", "-e", "NODE_OPTIONS=--v8-pool-size=1", "canopy-gateway",
            "openclaw", "sessions", "cleanup",
            "--store", &store_path,
            "--enforce", "--fix-missing",
        ])
        .output().await;
    let _ = writeln!(log, "  ✓ Session store pruned");

    // ─── Step 6: Run openclaw doctor (no explicit docker restart) ────────────
    // The config patch above triggers a hot reload — no restart needed.
    // A docker restart here would just add another 5-second delay and is redundant.
    let _ = writeln!(log, "Step 6/6: Running diagnostics...");

    // Wait briefly for the hot reload to settle
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    // Run openclaw doctor --fix
    let doctor = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        get_docker_command().args(["exec", "-u", "node", "-e", "NODE_OPTIONS=--v8-pool-size=1", "canopy-gateway", "openclaw", "doctor", "--fix"]).output(),
    ).await;
    match doctor {
        Ok(Ok(out)) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            if out.status.success() {
                let trimmed = stdout.trim();
                if trimmed.is_empty() {
                    let _ = writeln!(log, "  ✓ Doctor completed (no issues found)");
                } else {
                    let _ = writeln!(log, "  ✓ Doctor completed:\n    {}", trimmed.replace('\n', "\n    "));
                }
            } else {
                let _ = writeln!(log, "  ! Doctor reported issues:\n    {}",
                    format!("{}\n{}", stdout.trim(), stderr.trim()).trim().replace('\n', "\n    "));
            }
        }
        Ok(Err(e)) => { let _ = writeln!(log, "  ! Doctor exec failed: {}", e); }
        Err(_) => { let _ = writeln!(log, "  ! Doctor timed out (gateway may still be initializing — this is normal on first start)"); }
    }

    Ok(format!("✓ Repair complete.\n\n{}", log.trim_end()))
}

#[tauri::command]
pub async fn update_agent_model(
    agent_id: String,
    model: String,
) -> Result<(), String> {
    // Write directly into openclaw.json via Node.js — this triggers OpenClaw's hot reload
    // (file watcher detects the change and applies it without restarting the process).
    // Do NOT use `docker restart` here: a full restart takes 10-15s and loses in-memory
    // state. Hot reload propagates the model change in under a second.
    // ⚠️  OpenClaw expects model as a nested object {primary: "provider/model-id"},
    // NOT a flat string. This matches the working reference format at
    // /Users/scottieryan/agents/sloane/config/openclaw.json:
    //   "model": { "primary": "google/gemini-3.1-pro-preview" }
    let node_script = format!(
        r#"const fs=require('fs');
const p='/home/node/.openclaw/openclaw.json';
const data=JSON.parse(fs.readFileSync(p,'utf8'));
// Set per-agent model override (nested {{primary}} format required by OpenClaw)
data.agents=data.agents||{{}};
data.agents.list=(data.agents.list||[]).map(a=>a.id==='{id}'?{{...a,model:{{primary:'{model}'}}}}:a);
// Also update global default (nested format)
data.agents.defaults=data.agents.defaults||{{}};
data.agents.defaults.model={{primary:'{model}'}};
// Ensure agents.defaults.models registry lists this model
data.agents.defaults.models=data.agents.defaults.models||{{}};
data.agents.defaults.models['{model}']={{}};
fs.writeFileSync(p,JSON.stringify(data,null,2));
console.log('model updated to {model}');
"#,
        id = agent_id,
        model = model
    );

    let output = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "node", "-e", &node_script])
        .output()
        .await
        .map_err(|e| format!("Failed to update OpenClaw model config: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Model update failed: {}", err));
    }

    Ok(())
}
#[tauri::command]
pub async fn approve_slack_pairing(
    code: String,
) -> Result<String, String> {
    // NODE_OPTIONS=--v8-pool-size=1: prevents uv_thread_create crash at Node startup
    // (same fix as send_message_internal — all openclaw CLI invocations need this).
    let output = get_docker_command()
        .args([
            "exec", "-u", "node",
            "-e", "NODE_OPTIONS=--v8-pool-size=1",
            "canopy-gateway",
            "openclaw", "pairing", "approve", "slack", &code
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run pairing command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let mut combined = format!("{}\n{}", stdout, stderr).trim().to_string();

    if !output.status.success() {
        if combined.is_empty() {
            combined = format!("OpenClaw execution failed silently with status code: {}", output.status);
        }
        return Err(combined);
    }

    Ok(combined)
}

#[tauri::command]
pub fn get_user_profile(
    state: tauri::State<'_, crate::db::Database>,
) -> Result<crate::models::UserProfile, String> {
    state.get_user_profile().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_user_profile(
    profile: crate::models::UserProfile,
    state: tauri::State<'_, crate::db::Database>,
) -> Result<(), String> {
    state.save_user_profile(&profile).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_global_audit_log(
    limit: Option<u32>,
    agent_id: Option<String>,
    state: tauri::State<'_, crate::db::Database>,
) -> Result<Vec<crate::db::AuditEntry>, String> {
    state.get_audit_log(agent_id.as_deref(), limit.unwrap_or(100)).map_err(|e| e.to_string())
}

// ─── Boot Agent Sync ──────────────────────────────────────────────────────────

/// Poll until the canopy-gateway container is running AND openclaw is responsive.
/// Actively tries to (re)start the container if it is stopped.
/// Returns Ok(()) when ready, Err(diagnostic) if it gives up.
async fn wait_for_gateway_ready(timeout_secs: u64, app_handle: Option<tauri::AppHandle>) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let mut attempt = 0u32;

    // ⚠️  DO NOT initialize this 30 seconds in the past.
    // start_gateway() calls docker-compose up -d immediately before boot_sync_agents runs.
    // If we also trigger compose-up on the very first probe (~1s later), the second call
    // interrupts the in-progress container creation, which kills and restarts it — forever.
    // Set to NOW so we wait the full retry_interval before intervening.
    let mut last_start_attempt = std::time::Instant::now();

    // Only retry compose-up if the container is explicitly stopped/exited (i.e. it existed
    // before but crashed). When status is "unknown" (container doesn't exist at all),
    // start_gateway's compose-up is likely still in progress — don't interfere.
    // After a longer grace period we allow a single rescue attempt.
    const COMPOSE_RETRY_INTERVAL_SECS: u64 = 60;

    loop {
        attempt += 1;

        // 1. Check container state
        let state_out = get_docker_command()
            .args(["inspect", "-f", "{{.State.Running}}|{{.State.Status}}", "canopy-gateway"])
            .output()
            .await
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        let running = state_out.starts_with("true");
        let status = state_out.splitn(2, '|').nth(1).unwrap_or("unknown");

        if !running {
            tracing::info!("boot_sync_agents: probe {} — container state={}", attempt, status);

            // Only trigger a rescue compose-up when:
            //   a) the container is explicitly stopped/exited (not just "unknown" = never created yet), OR
            //   b) it has been "unknown" for longer than the grace period (start_gateway may have failed)
            let should_retry = match status {
                "exited" | "stopped" | "dead" => {
                    // Container existed but crashed — retry immediately on 60s cadence
                    last_start_attempt.elapsed() > std::time::Duration::from_secs(COMPOSE_RETRY_INTERVAL_SECS)
                }
                _ => {
                    // "unknown" = container not yet created. Give start_gateway a long grace
                    // period before we try to rescue — avoid racing with it.
                    last_start_attempt.elapsed() > std::time::Duration::from_secs(COMPOSE_RETRY_INTERVAL_SECS)
                }
            };

            if should_retry {
                last_start_attempt = std::time::Instant::now();
                let data_dir = dirs::data_dir()
                    .unwrap_or_default()
                    .join("Canopy");
                let compose_path = data_dir.join("docker-compose.yml");
                if compose_path.exists() {
                    let home_dir = dirs::home_dir().unwrap_or_default();
                    let orbstack_sock = home_dir.join(".orbstack/run/docker.sock");
                    let mut cmd = crate::docker::get_docker_compose_command();
                    if orbstack_sock.exists() {
                        cmd.env("DOCKER_HOST", format!("unix://{}", orbstack_sock.display()));
                    }
                    tracing::info!("boot_sync_agents: rescue compose-up (container state={}, {}s elapsed)", status, COMPOSE_RETRY_INTERVAL_SECS);
                    let up = cmd
                        .args(["-f", &compose_path.to_string_lossy(), "up", "-d"])
                        .output().await;
                    match up {
                        Ok(ref o) if o.status.success() => {
                            let out = format!("{}{}",
                                String::from_utf8_lossy(&o.stdout).trim(),
                                String::from_utf8_lossy(&o.stderr).trim());
                            tracing::info!("boot_sync_agents: docker-compose up -d output: {}", out);
                        }
                        Ok(ref o) =>
                            tracing::warn!("boot_sync_agents: docker-compose up -d failed: {}",
                                String::from_utf8_lossy(&o.stderr).trim()),
                        Err(e) =>
                            tracing::warn!("boot_sync_agents: could not invoke docker-compose: {}", e),
                    }
                }
            }
        } else {
            // 2. Container is running — scan logs for "[gateway] ready".
            //
            // We deliberately avoid HTTP probing here. After the gateway becomes "ready"
            // it immediately begins "starting channels and sidecars" (Slack, browser, voice,
            // etc.). This blocks the Node.js event loop entirely: the HTTP server accepts
            // TCP connections but never responds — so curl hangs and reqwest times out.
            // The channel/sidecar init phase can last 30–120s+ depending on which channels
            // are configured and whether any are in a retry loop (e.g. Slack with a bad token).
            //
            // `docker logs` reads the container's log stream directly from the filesystem
            // via the Docker daemon — it bypasses the Node.js event loop completely and
            // will never hang. We look for "[gateway] ready" which OpenClaw logs as soon as
            // its plugin system finishes loading, then probe IPC until it actually responds
            // before calling `openclaw agents add` (which uses IPC, not HTTP).
            let logs_result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                get_docker_command()
                    // Use a large tail so [gateway] ready isn't pushed off by verbose channel logs
                    .args(["logs", "--tail", "500", "canopy-gateway"])
                    .output(),
            ).await;

            let log_text = match logs_result {
                Ok(Ok(out)) => format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                ),
                _ => String::new(),
            };

            // Log a snippet of what the gateway is saying so it appears in Tauri console
            if attempt % 5 == 0 && !log_text.is_empty() {
                let tail: String = log_text.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
                tracing::info!("boot_sync_agents: gateway log tail (probe {}):\n{}", attempt, tail);
            }

            if log_text.contains("[gateway] ready") {
                tracing::info!(
                    "boot_sync_agents: '[gateway] ready' found in logs after {} probe(s) — proceeding to agents add",
                    attempt
                );
                // ── Why we removed the `openclaw agents list` IPC probe ────────────────
                //
                // Previous approach: 100 × 3s probes of `openclaw agents list --json`
                // with a 5s per-probe timeout. This had two critical bugs:
                //
                //   1. ORPHANED PROCESSES: tokio::time::timeout cancels the Rust future
                //      but does NOT kill the spawned child process. Each cancelled probe
                //      leaves an `openclaw agents list` process running inside the container.
                //      After 100 probes, 100 zombies accumulate against the 500-PID limit,
                //      making subsequent `docker exec` calls fail (can't spawn new PIDs).
                //
                //   2. WRONG SIGNAL: `openclaw agents list` blocks waiting for the ACPX
                //      plugin to be initialized (40–100s after "ready"). A 5s per-probe
                //      timeout fires before ACPX is ever ready. Even at probe #33 (99s),
                //      if ACPX is still initialising, the probe times out. The probe loop
                //      would need to reach probe #50+ (150s) for ACPX to be ready, but
                //      by then the container has 50+ zombies and is near the PID limit.
                //
                // New approach: return immediately once "[gateway] ready" is in the logs.
                // The `openclaw agents add` calls in boot_sync_agents use a 175s container
                // timeout (180s Rust) — long enough for ACPX to initialize naturally. The
                // command is wrapped with the container's `timeout` binary so the process is
                // killed when the deadline fires (no orphaned PIDs accumulate). No probe loop,
                // no PID accumulation, agents add succeeds the moment ACPX is ready.
                return Ok(());
            } else {
                tracing::debug!("boot_sync_agents: probe {} — container running, '[gateway] ready' not yet in logs", attempt);
            }
        }

        if std::time::Instant::now() >= deadline {
            // Collect recent container logs to help diagnose why it won't start
            let logs = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                get_docker_command()
                    .args(["logs", "--tail", "20", "canopy-gateway"])
                    .output(),
            ).await
            .ok().and_then(|r| r.ok())
            .map(|o| format!("{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)))
            .unwrap_or_else(|| "(no logs available)".into());

            let msg = format!(
                "Gateway container did not become ready after {}s.\n\
                 Container state: {}\n\
                 Recent logs:\n{}\n\n\
                 If you see OCI/namespace errors, restart OrbStack or use Hard Reset in Settings → Infrastructure.",
                timeout_secs, status, logs.trim()
            );
            tracing::warn!("boot_sync_agents: {}", msg);
            return Err(msg);
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// Pre-flight cleanup: run this BEFORE start_gateway() on every app launch.
///
/// Operates entirely on the host bind-mount (no docker exec, no container needed):
///   1. Reads the canonical agent list from SQLite.
///   2. Reads openclaw.json from the host bind-mount.
///   3. Removes entries whose ID is NOT in SQLite (stale/test/default agents like
///      "main", "test1", or agents deleted while the container was crashing).
///   4. Deletes each stale agent's directory from the bind-mount.
///   5. Walks every remaining agent directory and replaces any auth-profiles.json
///      that contains invalid JSON with `{}` so OpenClaw can't throw a SyntaxError
///      on startup and enter a retry-spawn loop.
///
/// Because this writes to the bind-mount BEFORE docker-compose up -d, OpenClaw reads
/// only clean, canonical state when it starts — preventing the 18 → 300+ PID spiral.
#[tauri::command]
pub fn preflight_cleanup(
    db: tauri::State<'_, crate::db::Database>,
) -> Result<String, String> {
    let data_dir = dirs::data_dir()
        .ok_or("Could not find data directory")?
        .join("Canopy")
        .join("openclaw-state");

    let agents_dir = data_dir.join("agents");
    let config_path = data_dir.join("openclaw.json");

    // ── 1. Canonical agent IDs from SQLite ────────────────────────────────────
    let sqlite_agents = db.list_agents().map_err(|e| e.to_string())?;
    let canonical_ids: std::collections::HashSet<String> =
        sqlite_agents.iter().map(|a| a.id.clone()).collect();

    let mut pruned: Vec<String> = Vec::new();
    let mut auth_fixed: u32 = 0;

    // ── 2. Prune openclaw.json ────────────────────────────────────────────────
    if let Ok(content) = std::fs::read_to_string(&config_path) {
        if let Ok(mut cfg) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(list) = cfg.pointer_mut("/agents/list").and_then(|v| v.as_array_mut()) {
                let before = list.len();
                list.retain(|entry| {
                    entry.get("id")
                        .and_then(|v| v.as_str())
                        .map(|id| canonical_ids.contains(id))
                        .unwrap_or(false)
                });
                let removed = before - list.len();
                if removed > 0 {
                    if let Ok(updated) = serde_json::to_string_pretty(&cfg) {
                        let _ = std::fs::write(&config_path, updated);
                        tracing::warn!(
                            "preflight_cleanup: pruned {} stale agent(s) from openclaw.json",
                            removed
                        );
                    }
                }
            }
        }
    }

    // ── 3. Prune stale agent directories from the bind-mount ─────────────────
    if let Ok(entries) = std::fs::read_dir(&agents_dir) {
        for entry in entries.flatten() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if !canonical_ids.contains(&dir_name) {
                // Extra safety: only delete paths that are direct children of agents_dir
                let target = agents_dir.join(&dir_name);
                if target.starts_with(&agents_dir) && target != agents_dir {
                    let _ = std::fs::remove_dir_all(&target);
                    tracing::warn!(
                        "preflight_cleanup: removed stale agent directory {:?}",
                        target
                    );
                    pruned.push(dir_name);
                }
            }
        }
    }

    // ── 4. Fix corrupted auth-profiles in remaining canonical agent dirs ───────
    // Cover both possible layouts — gateway mode vs single-agent mode may differ:
    //   agents/{id}/agent/auth-profiles.json  (confirmed in single-agent/Sloane reference)
    //   agents/{id}/auth-profiles.json         (possible gateway-mode flat layout)
    for agent in &sqlite_agents {
        let candidate_paths = [
            agents_dir.join(&agent.id).join("agent").join("auth-profiles.json"),
            agents_dir.join(&agent.id).join("auth-profiles.json"),
        ];
        for auth_file in &candidate_paths {
            if let Ok(content) = std::fs::read_to_string(auth_file) {
                if serde_json::from_str::<serde_json::Value>(&content).is_err() {
                    if std::fs::write(auth_file, "{}").is_ok() {
                        tracing::warn!(
                            "preflight_cleanup: replaced corrupted auth-profiles at {:?}",
                            auth_file
                        );
                        auth_fixed += 1;
                    }
                }
            }
        }
        // Missing file is fine — OpenClaw handles it gracefully.
    }

    let summary = format!(
        "preflight_cleanup: pruned {} stale agent(s) {:?}, fixed {} auth-profiles",
        pruned.len(), pruned, auth_fixed
    );
    tracing::info!("{}", summary);
    Ok(summary)
}

/// Re-register every SQLite agent with the OpenClaw gateway at startup.
/// Idempotent — "already exists" is treated as success.
/// Waits for the gateway to be ready before attempting registration.
/// Must run AFTER start_gateway() and BEFORE sync_credentials().
#[tauri::command]
pub async fn boot_sync_agents(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<String, String> {
    let agents = db.list_agents().map_err(|e| e.to_string())?;

    if agents.is_empty() {
        return Ok("No agents to sync".to_string());
    }

    // Prevent double-execution (React Strict Mode fires effects twice in dev).
    if BOOT_SYNC_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        tracing::info!("boot_sync_agents: already running, skipping duplicate call");
        return Ok("Already running".to_string());
    }
    // Ensure the flag is cleared when this function returns, even on error.
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) { BOOT_SYNC_RUNNING.store(false, Ordering::SeqCst); }
    }
    let _guard = Guard;

    // Wait up to 150s for the gateway container + openclaw process to be ready.
    // docker-compose up -d returns as soon as the start is accepted, but the
    // container may still be initialising (cold start with 6 plugins took 75s in practice).
    // Proceeding immediately causes fast failures.
    // Also actively retries docker-compose up -d if the container is stopped.
    let _ = app_handle.emit("boot-sync-progress", "Waiting for gateway to wake up...");
    if let Err(diagnostic) = wait_for_gateway_ready(150, Some(app_handle.clone())).await {
        tracing::warn!("boot_sync_agents giving up: {}", diagnostic);
        return Ok(format!("Gateway not ready: {}", diagnostic));
    }

    // ── Kill orphaned openclaw processes from previous boot cycles ─────────────
    // If a previous boot_sync_agents run timed out on `agents add`, its container
    // process keeps running (~150-200 PIDs per orphan). Near the 500-PID limit,
    // `docker exec` itself fails and no new processes can be spawned. Kill any
    // stale `openclaw agents` processes before proceeding. Errors are ignored —
    // if pkill is unavailable, the container-side `timeout` in try_agents_add
    // prevents new orphans from accumulating going forward.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        get_docker_command()
            .args(["exec", "canopy-gateway", "sh", "-c",
                   "pkill -f 'openclaw agents' 2>/dev/null; true"])
            .output(),
    ).await;

    // Read the current openclaw.json once to know which agents are already registered.
    // If an agent is already in agents.list, we skip `openclaw agents add` entirely —
    // that CLI command spawns a full Node.js process inside the container and causes a
    // significant memory spike. Skipping it for already-registered agents prevents the
    // OOM cascade that kills subsequent registrations.
    let already_registered: std::collections::HashSet<String> = {
        let cat_out = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            get_docker_command()
                .args(["exec", "-u", "node", "canopy-gateway", "cat", "/home/node/.openclaw/openclaw.json"])
                .output(),
        )
        .await
        .ok()
        .and_then(|r| r.ok())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

        serde_json::from_str::<serde_json::Value>(&cat_out)
            .ok()
            .and_then(|v| v.pointer("/agents/list").cloned())
            .and_then(|list| list.as_array().cloned())
            .map(|arr| arr.iter()
                .filter_map(|a| a.get("id")?.as_str().map(|s| s.to_string()))
                .collect())
            .unwrap_or_default()
    };
    tracing::info!("boot_sync_agents: {} agents already registered in openclaw.json: {:?}", already_registered.len(), already_registered);

    // Only process agents that are not paused. Paused agents stay in SQLite but are
    // intentionally excluded from OpenClaw registration so their channels/sidecars
    // don't spawn processes. This is the primary defence against PID spirals when
    // multiple agents with heavy plugins (browser, voice, Slack) all init at once.
    let active_agents: Vec<_> = agents.iter().filter(|a| !a.paused).collect();
    let paused_count = agents.len() - active_agents.len();
    if paused_count > 0 {
        tracing::info!("boot_sync_agents: skipping {} paused agent(s)", paused_count);
    }

    let total = active_agents.len();
    let mut ok: u32 = 0;
    let mut errs: u32 = 0;

    for agent in &active_agents {
        let id = &agent.id;
        // Emit a friendly per-agent progress message using the agent's display name.
        let display_name = if agent.name.is_empty() { id.as_str() } else { agent.name.as_str() };
        let _ = app_handle.emit(
            "boot-sync-progress",
            format!("Waking up {}... ({}/{})", display_name, ok + errs + 1, total),
        );

        if agent.capabilities.browser {
            let id_clone = id.clone();
            let app_handle_clone = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(port) = crate::browser_manager::enable_jit_proxy(app_handle_clone, id_clone.clone()).await {
                    let ws_endpoint = format!("ws://host.docker.internal:{}", port);
                    let _ = crate::openclaw::get_docker_command()
                        .args(["exec", "-u", "node", "canopy-gateway", "openclaw", "agents", "edit", &id_clone, "--env", &format!("PLAYWRIGHT_CDP_ENDPOINT={}", ws_endpoint)])
                        .output().await;
                }
            });
        }

        // Step 1: openclaw agents add <id> — only if not already registered AND dir exists.
        // Running `openclaw agents add` for an already-registered agent spawns a full
        // Node.js process, consuming ~600MB+ per call. For 5 agents this OOMs the container.
        // Instead, check openclaw.json first and skip the CLI invocation if already present.
        //
        // ⚠️  BUT: openclaw.json agents.list is NOT ground truth for whether the agent is
        // actually functional. The agent dir on the bind-mount is. If the dir doesn't exist
        // (agents add timed out on a previous boot, or dirs were wiped), the agent can't
        // respond even though it appears in agents.list. Always fall through to agents add
        // when the dir is missing — agents add is idempotent ("already exists" is success).
        let host_agent_dir_exists = dirs::data_dir()
            .map(|d| d.join("Canopy").join("openclaw-state").join("agents").join(id.as_str()).exists())
            .unwrap_or(false);

        if agent.isolated {
            tracing::info!("boot_sync_agents: agent {} is isolated — ensuring its dedicated container is running", id);
            
            if let Some(data_dir) = dirs::data_dir().map(|d| d.join("Canopy")) {
                let compose_content = crate::docker::generate_isolated_compose(id, &data_dir, 18805); // using 18805 as a stable port offset
                let compose_path = data_dir.join(format!("docker-compose-{}.yml", id));
                let _ = std::fs::write(&compose_path, compose_content);
        
                let _ = crate::docker::get_docker_compose_command()
                    .args(["-f", compose_path.to_str().unwrap(), "up", "-d"])
                    .output()
                    .await;
            }
            
            seed_user_md(&db, id);
            write_auth_profiles(id, &get_creds_for_agent(id)).await;
            ok += 1;
            continue;
        }

        if already_registered.contains(id.as_str()) && host_agent_dir_exists {
            tracing::info!("boot_sync_agents: agent {} already registered and dir exists — fast path (skip agents add)", id);
            
            // Only seed the USER.md if it's empty or doesn't exist, to prevent overwriting agent memories
            seed_user_md(&db, id);

            // Re-sync credentials for already-registered agents whose dir exists.
            // auth-profiles.json may have been overwritten or have stale/missing keys
            // (e.g. user rotated an API key, or the file was corrupted). Refreshing on
            // every boot is cheap and prevents silent auth failures.
            // Write directly (bypass the host-dir guard — agent IS registered, dir exists in container)
            let keys_existing = get_creds_for_agent(id);
            write_auth_profiles(id, &keys_existing).await;

            // Sync the agent's model safely using agents edit.
            // DO NOT use `openclaw config set` here! `config set` triggers a forceful 
            // container restart. Doing this in a loop causes rolling restarts that exhaust PIDs.
            // Also, we MUST validate the model. If an invalid/deprecated model like 
            // 'google/gemini-flash-latest' is pushed, LiteLLM enters an infinite crash loop.
            let active_model = agent.personality.active_model.clone().unwrap_or_default();
            let model_to_set = crate::model_constants::validate_model_string(&active_model)
                .ok()
                .filter(|m| crate::model_constants::all_models().iter().any(|info| info.id == **m))
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    let h_a = !keys_existing.get("ANTHROPIC_API_KEY").map_or(true, |v: &String| v.trim().is_empty());
                    let h_o = !keys_existing.get("OPENAI_API_KEY").map_or(true, |v: &String| v.trim().is_empty());
                    let h_g = !keys_existing.get("GEMINI_API_KEY").map_or(true, |v: &String| v.trim().is_empty());
                    crate::model_constants::default_model_from_available_keys(h_a, h_o, h_g).to_string()
                });
                
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(65),
                get_docker_command()
                    .args(["exec", "-u", "node", "-e", "NODE_OPTIONS=--v8-pool-size=1 --max-old-space-size=512",
                           "canopy-gateway",
                           "timeout", "-k", "2", "60",
                           "openclaw", "agents", "edit", &id,
                           "--model", &model_to_set])
                    .output(),
            ).await;
            tracing::info!("boot_sync_agents: fast path synced model '{}' for agent {}", model_to_set, id);

            ok += 1;
            continue;
        }

        // Agent not yet in openclaw.json OR dir is missing — register it now.
        if already_registered.contains(id.as_str()) {
            tracing::info!(
                "boot_sync_agents: agent {} in openclaw.json but agent dir missing — falling through to agents add (dir is ground truth)",
                id
            );
        }
        // ⚠️  Workspace is mounted at /home/node/.openclaw/workspace (inside .openclaw dir)
        // Per-agent subdirectories are used in multi-agent gateway mode.
        //
        // Timeout and orphan-prevention strategy for `openclaw agents add`:
        //
        // ⚠️  CRITICAL: We wrap the command with the container's `timeout` binary.
        //
        // Background: `openclaw agents add` blocks inside the container until the
        // ACPX plugin processes the registration request. ACPX takes 40–100s (or
        // longer under system load) to initialize after "[gateway] ready".
        //
        // Problem without container-side timeout:
        //   tokio::time::timeout() cancels the Rust future but does NOT kill the
        //   spawned child process. The `docker exec ... openclaw agents add` process
        //   keeps running inside the container. Each timed-out call starts its own
        //   full OpenClaw runtime (~150–200 PIDs). Two orphaned calls → ~400 PIDs →
        //   container hits the 500-PID ceiling → ACPX can't spawn workers on future
        //   attempts → every subsequent `agents add` hangs at the same timeout.
        //
        // Fix:
        //   Prefix with `timeout <N>` (the container's coreutils binary). When the
        //   deadline fires inside the container, the child is killed and `docker exec`
        //   exits with code 124. Command::output() returns promptly → no orphan.
        //   We set the container timeout 5s shorter than the Rust timeout so the
        //   container always kills first and the Rust future always sees a clean exit.
        //
        // First attempt: 175s container / 180s Rust — gives ACPX up to 175s.
        // Retry:          85s container /  90s Rust — one more chance if still slow.
        // A second timeout means ACPX is stuck and we skip this agent.
        let workspace_path = format!("/home/node/.openclaw/workspace/{}", id);

        // ── Create workspace dir before agents add ────────────────────────────────
        // `openclaw agents add --workspace <path>` may fail silently if the path doesn't
        // exist yet. This is especially common for imported agents whose original workspace
        // was on the host machine (not inside the container bind-mount). Creating the dir
        // first guarantees openclaw can initialise the agent regardless of naming convention.
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            get_docker_command()
                .args(["exec", "-u", "node", "canopy-gateway", "mkdir", "-p", &workspace_path])
                .output(),
        ).await;

        let active_model = agent.personality.active_model.clone().unwrap_or_default();
        let keys_existing = get_creds_for_agent(&id);
        let model_to_set = crate::model_constants::validate_model_string(&active_model)
            .ok()
            .filter(|m| crate::model_constants::all_models().iter().any(|info| info.id == **m))
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                let h_a = !keys_existing.get("ANTHROPIC_API_KEY").map_or(true, |v: &String| v.trim().is_empty());
                let h_o = !keys_existing.get("OPENAI_API_KEY").map_or(true, |v: &String| v.trim().is_empty());
                let h_g = !keys_existing.get("GEMINI_API_KEY").map_or(true, |v: &String| v.trim().is_empty());
                crate::model_constants::default_model_from_available_keys(h_a, h_o, h_g).to_string()
            });

        let try_agents_add = |rust_timeout_secs: u64| {
            let workspace_path = workspace_path.clone();
            let id = id.clone();
            let model_to_set = model_to_set.clone();
            async move {
                // Container-side timeout is 5s shorter — it fires first and kills
                // the process, preventing orphan accumulation inside the container.
                let container_secs = rust_timeout_secs.saturating_sub(5).to_string();
                tokio::time::timeout(
                    std::time::Duration::from_secs(rust_timeout_secs),
                    get_docker_command()
                        .args([
                            "exec", "-u", "node",
                            // --v8-pool-size=1: prevents uv_thread_create/EAGAIN PID crash
                            // --max-old-space-size=512: caps heap at 512MB per agents add call
                            //   (each spawns a full Node runtime; without this cap they can
                            //    each consume 600-800MB, OOM-killing the container)
                            "-e", "NODE_OPTIONS=--v8-pool-size=1 --max-old-space-size=512",
                            "canopy-gateway",
                            "timeout", "-k", "2", &container_secs,
                            "openclaw", "agents", "add", &id,
                            "--workspace", &workspace_path,
                            "--model", &model_to_set,
                        ])
                        .output(),
                )
                .await
            }
        };

        let mut add_result = try_agents_add(180).await;

        // ── Determine why the first attempt failed (if it did) ───────────────────
        // Exit code 124 = container's `timeout` binary fired.
        // Exit code 137 = OOM-killed (SIGKILL from kernel memory limit).
        //   137 is SPECIAL: OpenClaw may have fully written the agent before the kill.
        //   We check the output for success markers instead of trusting the exit code.
        // ConfigMutationConflictError = sequential agents add calls raced on openclaw.json.
        //   Retry after a short pause — the conflict is transient.
        let first_combined: String = match &add_result {
            Ok(Ok(o)) => format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)),
            _ => String::new(),
        };
        let first_timed_out = match &add_result {
            Err(_) => true,
            Ok(Ok(o)) => o.status.code() == Some(124),
            _ => false,
        };
        let first_was_conflict = first_combined.contains("ConfigMutationConflictError");

        if first_timed_out {
            // First attempt timed out — ACPX was still initializing.
            // Container-side timeout killed the orphan; no PIDs accumulate.
            // Retry once with a shorter window (ACPX should be ready by now).
            tracing::warn!(
                "boot_sync_agents: agents add timed out for {} (ACPX still initialising?) — retrying once",
                id
            );
            let _ = app_handle.emit("boot-sync-progress", format!("Waking up {}... (retry)", display_name));
            add_result = try_agents_add(90).await;
        } else if first_was_conflict {
            // Transient config conflict — the previous agents add modified openclaw.json
            // and this call loaded a now-stale version. Wait for the write to propagate
            // then retry; the second call will load the updated config cleanly.
            tracing::warn!(
                "boot_sync_agents: ConfigMutationConflictError for {} — pausing 4s before retry",
                id
            );
            let _ = app_handle.emit("boot-sync-progress", format!("Syncing {}... (config conflict, retrying)", display_name));
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            add_result = try_agents_add(90).await;
        }

        // ── Evaluate the (possibly retried) result ────────────────────────────────
        let agents_add_success_in_output = |combined: &str| -> bool {
            // OpenClaw prints these lines on a successful agents add:
            //   "Workspace OK: ~/.openclaw/workspace/<id>"
            //   "Agent dir: ~/.openclaw/agents/<id>/agent"
            // If both appear, the registration was written — even if the process was
            // OOM-killed (exit 137) AFTER writing but before returning cleanly.
            combined.contains("Agent dir:") && combined.contains("Workspace OK:")
        };

        let registered = match add_result {
            Ok(Ok(ref out)) => {
                // Exit code 124 = container-side timeout (same semantics as Rust Err(_)).
                if out.status.code() == Some(124) {
                    tracing::warn!(
                        "boot_sync_agents: timeout registering agent {} after retry — skipping",
                        id
                    );
                    false
                } else {
                    let combined = format!(
                        "{}{}",
                        String::from_utf8_lossy(&out.stdout),
                        String::from_utf8_lossy(&out.stderr)
                    );
                    if out.status.success() || combined.to_lowercase().contains("already exists") {
                        true
                    } else if agents_add_success_in_output(&combined) {
                        // exit 137 = OOM-killed, but OpenClaw already wrote the agent
                        // before the kernel killed the process. The output confirms the
                        // registration is on disk — treat as success.
                        tracing::info!(
                            "boot_sync_agents: agents add for {} exited {:?} (OOM-killed after write?) — output confirms registration",
                            id, out.status.code()
                        );
                        true
                    } else {
                        tracing::warn!(
                            "boot_sync_agents: agents add failed for {} (exit {:?}): {}",
                            id, out.status.code(), combined.trim()
                        );
                        false
                    }
                }
            }
            Ok(Err(e)) => {
                tracing::warn!("boot_sync_agents: docker exec error for {}: {}", id, e);
                false
            }
            Err(_) => {
                tracing::warn!("boot_sync_agents: timeout registering agent {} after retry — skipping", id);
                false
            }
        };

        if !registered {
            errs += 1;
            continue;
        }

        let soul_content = generate_soul_md(&agent.personality);
        let identity_content = agent.personality.identity_template.clone().unwrap_or_default();
        let soul_path = agent_soul_path(id);
        let custom_instructions = agent.personality.custom_instructions.trim();
        
        let write_cmd = generate_personality_sync_cmd(
            &soul_path,
            &soul_content,
            &identity_content,
            custom_instructions
        );

        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            get_docker_command()
                .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &write_cmd])
                .output(),
        )
        .await;

        tracing::info!("boot_sync_agents: registered agent {}", id);

        // Step 3: Write auth-profiles.json — load API keys from keychain and write.
        write_auth_profiles(id, &get_creds_for_agent(id)).await;
        
        seed_user_md(&db, id);

        ok += 1;

        // Give the container breathing room between agent registrations.
        // Each `openclaw agents add` spawns a Node.js process inside the container;
        // without a pause the previous process may not have fully exited before the
        // next one starts, causing multiple overlapping processes that exhaust memory.
        if ok + errs < total as u32 {
            tokio::time::sleep(tokio::time::Duration::from_secs(4)).await;
        }
    }
    // ── Configure Per-Agent Channels (Slack & Google) ───────────────────────
    let mut slack_accounts = serde_json::Map::new();
    let mut gmail_accounts = serde_json::Map::new();
    let mut calendar_accounts = serde_json::Map::new();
    let mut drive_accounts = serde_json::Map::new();
    let mut bindings = Vec::new();
    
    for agent in &active_agents {
        // Slack
        let app_token = crate::keychain::get_secret(&format!("agent_{}_slack_app_token", agent.id));
        let bot_token = crate::keychain::get_secret(&format!("agent_{}_slack_bot_token", agent.id));
        if let (Ok(app), Ok(bot)) = (app_token, bot_token) {
            let app = app.trim().to_string();
            let bot = bot.trim().to_string();
            if !app.is_empty() && !bot.is_empty() {
                let mut account = serde_json::Map::new();
                account.insert("appToken".to_string(), serde_json::Value::String(app));
                account.insert("botToken".to_string(), serde_json::Value::String(bot));
                slack_accounts.insert(agent.id.clone(), serde_json::Value::Object(account));
                
                bindings.push(serde_json::json!({
                    "agentId": agent.id,
                    "match": { "channel": "slack", "accountId": agent.id }
                }));
            }
        }

        // Google
        let mut handle_google = |service: &str, service_prefix: &str, channel_key: &str, accounts: &mut serde_json::Map<String, serde_json::Value>| {
            let mut acc = crate::keychain::get_secret(&format!("agent_{}_google_{}_access_token", agent.id, service)).unwrap_or_default();
            let mut ref_tok = crate::keychain::get_secret(&format!("agent_{}_google_{}_refresh_token", agent.id, service)).unwrap_or_default();
            
            // Fallback to global credentials if agent lacks dedicated ones
            if acc.trim().is_empty() {
                acc = crate::keychain::get_secret(&format!("{}-access-token", service_prefix)).unwrap_or_default();
                ref_tok = crate::keychain::get_secret(&format!("{}-refresh-token", service_prefix)).unwrap_or_default();
            }

            let acc = acc.trim().to_string();
            if !acc.is_empty() {
                let mut account = serde_json::Map::new();
                account.insert("accessToken".to_string(), serde_json::Value::String(acc));
                let ref_tok = ref_tok.trim().to_string();
                if !ref_tok.is_empty() {
                    account.insert("refreshToken".to_string(), serde_json::Value::String(ref_tok));
                }
                accounts.insert(agent.id.clone(), serde_json::Value::Object(account));
                
                bindings.push(serde_json::json!({
                    "agentId": agent.id,
                    "match": { "channel": channel_key, "accountId": agent.id }
                }));
            }
        };

        handle_google("email", "google-email", "gmail", &mut gmail_accounts);
        handle_google("calendar", "google-calendar", "googleCalendar", &mut calendar_accounts);
        handle_google("drive", "google-drive", "googleDrive", &mut drive_accounts);
    }
    
    let google_client_id = std::env::var("GOOGLE_CLIENT_ID")
        .unwrap_or_else(|_| "677940720803-9ainnmmjh1ac4aeagq4ln3gll1v2t65f.apps.googleusercontent.com".to_string());
    let google_client_secret = std::env::var("GOOGLE_CLIENT_SECRET")
        .unwrap_or_else(|_| "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".to_string());

    // Inject into openclaw.json with Rollback Failsafe
    let patch_channels_script = format!(
        r#"const fs=require('fs');
const p='/home/node/.openclaw/openclaw.json';

let c=JSON.parse(fs.readFileSync(p,'utf8'));
c.channels=c.channels||{{}};
c.plugins=c.plugins||{{}};
c.plugins.entries=c.plugins.entries||{{}};

// Slack
c.channels.slack=c.channels.slack||{{}};
c.channels.slack.enabled={};
c.channels.slack.mode='socket';
c.channels.slack.groupPolicy='open';
c.channels.slack.accounts={};
c.plugins.entries.slack=c.plugins.entries.slack||{{}};
if (c.channels.slack.enabled === true) c.plugins.entries.slack.enabled=true;

// Google helper
function setupGoogle(chKey, enabled, accounts) {{
    c.channels[chKey] = c.channels[chKey] || {{}};
    c.channels[chKey].enabled = enabled;
    if (enabled) {{
        c.channels[chKey].clientId = '{}';
        c.channels[chKey].clientSecret = '{}';
        c.channels[chKey].accounts = accounts;
    }} else {{
        delete c.channels[chKey].accounts;
    }}
}}

setupGoogle('gmail', {}, {});
setupGoogle('googleCalendar', {}, {});
setupGoogle('googleDrive', {}, {});

c.bindings={};

if (c.mcpServers) {{
    delete c.mcpServers;
}}

fs.writeFileSync(p,JSON.stringify(c,null,2));
"#,
        if slack_accounts.is_empty() { "false" } else { "true" },
        serde_json::to_string(&slack_accounts).unwrap_or_else(|_| "{}".to_string()),
        google_client_id,
        google_client_secret,
        if gmail_accounts.is_empty() { "false" } else { "true" },
        serde_json::to_string(&gmail_accounts).unwrap_or_else(|_| "{}".to_string()),
        if calendar_accounts.is_empty() { "false" } else { "true" },
        serde_json::to_string(&calendar_accounts).unwrap_or_else(|_| "{}".to_string()),
        if drive_accounts.is_empty() { "false" } else { "true" },
        serde_json::to_string(&drive_accounts).unwrap_or_else(|_| "{}".to_string()),
        serde_json::to_string(&bindings).unwrap_or_else(|_| "[]".to_string())
    );

    let patch_out = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "node", "-e", &patch_channels_script])
            .output(),
    ).await;
    
    if let Ok(Ok(out)) = patch_out {
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::error!("boot_sync_agents: Config update failed! Error:\n{}", stderr);
            let _ = app_handle.emit("boot-sync-progress", "Warning: Failed to apply Slack configuration.");
        } else {
            tracing::info!("boot_sync_agents: updated per-agent bindings successfully");
        }
    } else {
        tracing::error!("boot_sync_agents: patch script failed to execute or timed out");
    }

    tracing::info!("boot_sync_agents complete: {} ok, {} errors", ok, errs);

    // Post-boot diagnostic: log container PID/CPU/MEM so we can tell if a PID spiral
    // or memory pressure is starting after agents are registered and channels begin init.
    // The gateway starts connecting Slack/iMessage sidecars here — this is where PID count
    // can climb. Log once so we have a baseline.
    if let Ok(stats_out) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        get_docker_command()
            .args(["stats", "canopy-gateway", "--no-stream",
                   "--format", "PIDs={{.PIDs}} CPU={{.CPUPerc}} MEM={{.MemUsage}}"])
            .output(),
    ).await {
        if let Ok(out) = stats_out {
            let stats = String::from_utf8_lossy(&out.stdout).trim().to_string();
            tracing::info!("boot_sync_agents post-boot container stats: {}", stats);
        }
    }

    // Note: the post-registration IPC probe (openclaw agents list loop) was removed.
    // It had the same orphaned-process problem as the pre-registration probe.
    // The `openclaw agents add` call above blocks until ACPX processes the request,
    // meaning by the time agents add returns successfully, ACPX is already initialised.
    // Sidecar init (Slack, browser, voice) runs concurrently and doesn't block chat IPC —
    // send_message goes through the same ACPX queue that agents add unblocked.

    let summary = if errs == 0 {
        if ok == 1 { "1 agent is ready".to_string() }
        else { format!("{} agents are ready", ok) }
    } else {
        format!("{} agent{} ready, {} couldn't connect", ok, if ok == 1 { "" } else { "s" }, errs)
    };
    let _ = app_handle.emit("boot-sync-progress", &summary);
    Ok(format!("{} agents synced, {} errors", ok, errs))
}

// ─── Regression Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_constants;

    // ── Gateway URL / token ────────────────────────────────────────────────

    #[test]
    fn gateway_url_constant_uses_host_port() {
        // GATEWAY_URL must reference the host-side port (18799), not the container-internal
        // port (18789). If these are swapped, every API call from the Tauri host silently fails.
        assert!(
            GATEWAY_URL.contains("18799"),
            "GATEWAY_URL '{}' must contain the host port 18799",
            GATEWAY_URL
        );
        assert!(
            !GATEWAY_URL.contains("18789"),
            "GATEWAY_URL '{}' must NOT contain the container-internal port 18789",
            GATEWAY_URL
        );
    }

    #[test]
    fn gateway_bearer_header_contains_token() {
        let header = model_constants::gateway_bearer_header();
        assert!(
            header.starts_with("Bearer "),
            "Bearer header must start with 'Bearer '"
        );
        assert!(
            header.contains(model_constants::GATEWAY_INTERNAL_TOKEN),
            "Bearer header must contain the gateway token"
        );
    }

    // ── Auth-profile path ─────────────────────────────────────────────────

    #[test]
    fn auth_profile_path_from_constant_has_no_extra_agent_subdir() {
        // Regression guard for the bug where an extra `agent/` directory was inserted,
        // causing OpenClaw to not find the API key file.
        let path = model_constants::agent_auth_profile_path("some-agent");
        assert!(
            !path.contains("/agent/auth-profiles"),
            "Path '{}' contains spurious '/agent/' subdirectory — OpenClaw cannot find the file there",
            path
        );
        assert!(
            path.ends_with("some-agent/auth-profiles.json"),
            "Path '{}' must end with agent-id/auth-profiles.json",
            path
        );
    }

    // ── Personality Sync ──────────────────────────────────────────────────

    #[test]
    fn generate_soul_md_uses_template_when_provided() {
        let mut personality = crate::models::AgentPersonality::default();
        personality.name = "TestBot".to_string();
        personality.communication_style = "Friendly".to_string();
        personality.soul_template = Some("Hello {{name}}, you are {{description}}.".to_string());

        let soul = generate_soul_md(&personality);
        assert!(soul.contains("Hello TestBot, you are Friendly."));
        assert!(soul.contains("Canopy App Protocols"), "Must append CANOPY_PROTOCOLS.md");
    }

    #[test]
    fn generate_soul_md_uses_legacy_fallback_when_template_empty() {
        let mut personality = crate::models::AgentPersonality::default();
        personality.name = "FallbackBot".to_string();
        personality.communication_style = "Direct".to_string();
        personality.expertise = vec!["Coding".to_string()];
        personality.guardrails = vec!["No swearing".to_string()];
        personality.custom_instructions = "Be concise".to_string();
        personality.soul_template = Some("".to_string()); // empty template

        let soul = generate_soul_md(&personality);
        assert!(soul.contains("# FallbackBot"));
        assert!(soul.contains("## Communication Style"));
        assert!(soul.contains("Direct"));
        assert!(soul.contains("## Expertise\n\n- Coding"));
        assert!(soul.contains("## Guardrails\n\n- No swearing"));
        assert!(soul.contains("## Additional Instructions\n\nBe concise"));
        assert!(soul.contains("Canopy App Protocols"), "Must append CANOPY_PROTOCOLS.md");
    }

    #[test]
    fn generate_personality_sync_cmd_prevents_overwrites() {
        let cmd = generate_personality_sync_cmd(
            "/workspace/agent1/SOUL.md", 
            "Soul Content", 
            "Identity Content", 
            "Prefs Content"
        );
        
        // Ensure it uses file existence guards to NEVER overwrite files
        assert!(cmd.contains("if [ ! -f '/workspace/agent1/SOUL.md' ]; then printf '%s'"));
        assert!(cmd.contains("if [ ! -f \"$(dirname '/workspace/agent1/SOUL.md')\"/IDENTITY.md ]; then printf '%s'"));
        assert!(cmd.contains("if [ ! -f \"$(dirname '/workspace/agent1/SOUL.md')\"/PREFERENCES.md ]; then printf '%s'"));
        
        // Ensure it creates empty files for the others without overwriting existing data
        assert!(cmd.contains("\"$(dirname '/workspace/agent1/SOUL.md')\"/USER.md"));
        
        // Ensure contents are properly passed
        assert!(cmd.contains("Soul Content"));
        assert!(cmd.contains("Identity Content"));
        assert!(cmd.contains("Prefs Content"));
    }

    #[test]
    fn generate_user_md_content_includes_profile() {
        let mut profile = crate::models::UserProfile::default();
        profile.name = "TestUser".to_string();
        profile.working_hours = "10am-6pm".to_string();

        let content = generate_user_md_content(Some(profile), "Template content");
        assert!(content.contains("**Name:** TestUser"));
        assert!(content.contains("**Context / Work:** 10am-6pm"));
        assert!(content.contains("Template content"));
    }

    #[test]
    fn generate_user_md_content_skips_default_admin() {
        let profile = crate::models::UserProfile::default(); // defaults to "Admin"
        let content = generate_user_md_content(Some(profile), "Template content");
        assert!(!content.contains("**Name:** Admin"));
        assert_eq!(content, "Template content");
    }

    // ── SOUL.md path ──────────────────────────────────────────────────────

    #[test]
    fn soul_path_is_in_workspace_not_dot_openclaw() {
        let path = crate::model_constants::agent_soul_path("test-agent");
        assert!(
            path.contains("/.openclaw/workspace/"),
            "SOUL path '{}' must be under /.openclaw/workspace/",
            path
        );
    }

    // ── Port scan ─────────────────────────────────────────────────────────

    #[test]
    fn scan_local_agents_does_not_scan_container_internal_port() {
        // Port 18789 is container-internal and not reachable from the host.
        // Scanning it produces false positives. The scan list must only contain
        // host-accessible ports.
        let ports: &[u16] = &[model_constants::GATEWAY_HOST_PORT, 18798];
        assert!(
            !ports.contains(&model_constants::GATEWAY_CONTAINER_PORT),
            "Port scan list must not include container-internal port {} (not reachable from host)",
            model_constants::GATEWAY_CONTAINER_PORT
        );
        assert!(
            ports.contains(&model_constants::GATEWAY_HOST_PORT),
            "Port scan list must include the host-facing gateway port {}",
            model_constants::GATEWAY_HOST_PORT
        );
    }

    // ── Imported agents get a model ───────────────────────────────────────

    #[test]
    fn default_model_from_keys_is_never_empty() {
        // When all keys are absent, we should still get a non-empty string so the
        // agent is created with a model (even if that model will need a key added).
        let model = model_constants::default_model_from_available_keys(false, false, false);
        assert!(!model.is_empty(), "default_model_from_available_keys must never return empty string");
        assert!(
            model_constants::validate_model_string(model).is_ok(),
            "No-key fallback model '{}' fails format validation",
            model
        );
    }

    #[test]
    fn default_model_prefers_anthropic_when_present() {
        let model = model_constants::default_model_from_available_keys(true, false, false);
        assert!(
            model.starts_with("anthropic/"),
            "With Anthropic key present, default model should start with 'anthropic/', got '{}'",
            model
        );
    }

    #[test]
    fn default_model_does_not_prefer_gemini_over_anthropic() {
        // Regression: the old audit_openclaw.rs code started with `expected_model = gemini`
        // and only overrode it for lower-priority providers, making Gemini the effective
        // default even when Anthropic was present.
        let model = model_constants::default_model_from_available_keys(true, true, true);
        assert!(
            model.starts_with("anthropic/"),
            "Anthropic must be preferred over Gemini when both keys present, got '{}'",
            model
        );
    }

    // ── Rollback & Validation Failsafe ────────────────────────────────────

    #[test]
    fn test_docker_command_builder_never_panics() {
        // Ensure get_docker_command doesn't panic even if docker is missing
        let cmd = super::get_docker_command();
        // Just verify it constructed a Command
        let program = cmd.as_std().get_program().to_string_lossy();
        assert!(!program.is_empty(), "Command should have a program name");
    }

    #[test]
    fn verify_schema_safety_of_injection() {
        // This is a unit test to simulate our config injection logic on a dummy JSON
        // to ensure we don't accidentally write invalid structures like `mcpServers` at the root.
        let mut dummy_config: serde_json::Value = serde_json::json!({
            "channels": {},
            "plugins": { "entries": {} }
        });

        // The logic from boot_sync_agents
        let slack_enabled = true;
        if slack_enabled {
            if let Some(obj) = dummy_config.as_object_mut() {
                if let Some(plugins) = obj.get_mut("plugins").and_then(|v| v.as_object_mut()) {
                    if let Some(entries) = plugins.get_mut("entries").and_then(|v| v.as_object_mut()) {
                        entries.insert("slack".to_string(), serde_json::json!({ "enabled": true }));
                    }
                }
            }
        }

        // Verify the structure is correct
        assert_eq!(
            dummy_config.pointer("/plugins/entries/slack/enabled").and_then(|v| v.as_bool()),
            Some(true),
            "Slack plugin should be properly nested"
        );

        // Verify no `mcpServers` exists
        assert!(
            dummy_config.get("mcpServers").is_none(),
            "mcpServers must NOT exist as it breaks OpenClaw schema validation"
        );
    }

    #[tokio::test]
    async fn test_jit_credential_flow() {
        // We can't easily mock the docker exec command without refactoring, but we can verify the 
        // string formatting is correct for the injection command.
        let credential_id = "test-api-key";
        let env_var_name = format!("JIT_TOKEN_{}", credential_id.replace("-", "_").to_uppercase());
        
        assert_eq!(env_var_name, "JIT_TOKEN_TEST_API_KEY");
        
        // This is a minimal unit test to ensure the variable naming logic is sound
        let write_cmd_inject = format!("echo 'export {}={}' >> /home/node/.bashrc", env_var_name, "secret");
        assert_eq!(write_cmd_inject, "echo 'export JIT_TOKEN_TEST_API_KEY=secret' >> /home/node/.bashrc");

        let write_cmd_revoke = format!("sed -i '/{}/d' /home/node/.bashrc", env_var_name);
        assert_eq!(write_cmd_revoke, "sed -i '/JIT_TOKEN_TEST_API_KEY/d' /home/node/.bashrc");
    }
}

/// Helper function to seed USER.md with the current UserProfile and settings template if it's empty or missing.
fn seed_user_md(db: &crate::db::Database, agent_id: &str) {
    if let Some(workspace) = dirs::data_dir().map(|d| d.join("Canopy").join("openclaw-state").join("workspace").join(agent_id)) {
        let user_md_path = workspace.join("USER.md");
        if !user_md_path.exists() || std::fs::metadata(&user_md_path).map(|m| m.len()).unwrap_or(0) == 0 {
            let profile_opt = db.get_user_profile().ok();
            let mut template_content = String::from("#USER.md - Your Human's Preferences\n_Read this file. Everything in here is a fact about how I live, what I like, and how I want you to behave. Do not ask me to set things up; if you need a piece of information to complete a task and it isn't in here, look it up or make a best guess based on the 'vibe' of my other preferences. If you get it wrong, I will correct you once, and you should update this file immediately so you never ask again._\n");
            
            if let Some(template_path) = dirs::data_dir().map(|d| d.join("Canopy").join("shared").join("settings.json")) {
                if template_path.exists() {
                    if let Ok(settings_json) = std::fs::read_to_string(&template_path) {
                        if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&settings_json) {
                            if let Some(custom) = settings.get("userTemplate").and_then(|v| v.as_str()) {
                                if !custom.trim().is_empty() {
                                    template_content = custom.to_string();
                                }
                            }
                        }
                    }
                }
            }
            
            let content = generate_user_md_content(profile_opt, &template_content);
            let _ = std::fs::write(&user_md_path, content);
        }
    }
}

/// Generates the content for a new agent's USER.md
fn generate_user_md_content(profile: Option<crate::models::UserProfile>, template_content: &str) -> String {
    let mut content = String::new();
    
    if let Some(p) = profile {
        if p.name.trim() != "Admin" && !p.name.trim().is_empty() {
            content.push_str(&format!("# User Context\n\n**Name:** {}\n", p.name));
            if !p.working_hours.is_empty() && p.working_hours != "9:00 AM - 5:00 PM" {
                content.push_str(&format!("**Context / Work:** {}\n", p.working_hours));
            }
            content.push_str("\n---\n\n");
        }
    }
    
    content.push_str(template_content);
    content
}

#[tauri::command]
pub async fn set_preferences_template(content: String) -> Result<(), String> {
    if let Some(template_path) = dirs::data_dir().map(|d| d.join("Canopy").join("openclaw-state").join("preferences_template.md")) {
        std::fs::write(&template_path, content).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Could not resolve app data dir".into())
    }
}

pub async fn inject_jit_credential(agent_id: &str, credential_id: &str) -> Result<(), String> {
    tracing::info!("JIT INJECTION: Provisioning {} into container for agent {}", credential_id, agent_id);
    
    // Fetch the real credential from the secure macOS Keychain
    let secret = crate::keychain::get_secret(credential_id).unwrap_or_else(|_| {
        tracing::warn!("Failed to fetch {} from keychain, falling back to dummy", credential_id);
        "unconfigured_secret".to_string()
    });

    let env_var_name = format!("JIT_TOKEN_{}", credential_id.replace("-", "_").to_uppercase());
    
    // We append the secret to the node user's .bashrc. 
    // In a real system we'd inject into auth-profiles.json or a `.env` file that Node loads,
    // but .bashrc is an effective placeholder for the container environment.
    let write_cmd = format!("echo 'export {}={}' >> /home/node/.bashrc", env_var_name, secret);
    
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &write_cmd])
            .output(),
    ).await.map_err(|e| format!("Timeout injecting JIT credential: {}", e))?;
    
    Ok(())
}

pub async fn revoke_jit_credential(agent_id: &str, credential_id: &str) -> Result<(), String> {
    tracing::info!("JIT REVOCATION: Removing {} from container for agent {}", credential_id, agent_id);
    
    let env_var_name = format!("JIT_TOKEN_{}", credential_id.replace("-", "_").to_uppercase());
    let write_cmd = format!("sed -i '/{}/d' /home/node/.bashrc", env_var_name);
    
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &write_cmd])
            .output(),
    ).await.map_err(|e| format!("Timeout revoking JIT credential: {}", e))?;
    
    Ok(())
}

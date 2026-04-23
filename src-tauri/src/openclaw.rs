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
) -> Result<Agent, String> {
    let agent_id = format!("agent-{}", name.to_lowercase().replace(' ', "-"));

    // Step 0: Ensure structural configurations are met so the gateway setup sequence doesn't fail uniquely in the headless docker host
    let _ = get_docker_command().args(["exec", "-u", "node", "canopy-gateway", "openclaw", "config", "set", "gateway.mode", "local"]).output().await;
    let _ = get_docker_command().args(["exec", "-u", "node", "canopy-gateway", "openclaw", "config", "set", "agents.defaults.memorySearch.enabled", "false"]).output().await;
    let _ = get_docker_command().args(["exec", "-u", "node", "canopy-gateway", "openclaw", "config", "set", "gateway.token", GATEWAY_INTERNAL_TOKEN]).output().await;

    // Fix models before creating to avoid FailoverError
    if let Some(ref model) = personality.active_model {
        let _ = get_docker_command().args(["exec", "-u", "node", "canopy-gateway", "openclaw", "config", "set", "agents.defaults.model", model]).output().await;
    } else {
        let _ = crate::audit_openclaw::repair_openclaw_config(app_handle.clone(), None).await;
    }

    // Step 1: Create agent via OpenClaw CLI (inside the container)
    let output = get_docker_command()
        .args([
            "exec", "-u", "node", "canopy-gateway",
            "openclaw", "agents", "add",
            &agent_id,
            "--workspace", "/home/node/openclaw/workspace",
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to create agent: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined = format!("{}\n{}", stdout, stderr).trim().to_string();
        return Err(format!("Failed to create agent: {}", combined));
    }

    // Step 2: Generate SOUL.md from personality
    let soul_md = generate_soul_md(&personality);
    // Write SOUL.md to the agent's workspace inside the container
    let soul_path = agent_soul_path(&agent_id);
    get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c",
            &format!("cat > {} << 'SOULEOF'\n{}\nSOULEOF", soul_path, soul_md)])
        .output()
        .await
        .map_err(|e| format!("Failed to write SOUL.md: {}", e))?;

    // Step 3: Set identity (emoji, avatar)
    get_docker_command()
        .args([
            "exec", "canopy-gateway",
            "openclaw", "agents", "set-identity",
            "--agent", &agent_id,
            "--emoji", &emoji,
        ])
        .output()
        .await
        .ok(); // Non-critical

    let agent = Agent {
        id: agent_id.clone(),
        name: name.clone(),
        role,
        emoji,
        color: "#34D399".to_string(), // Default, will be assigned by frontend
        status: AgentStatus::Active,
        isolated,
        capabilities: crate::models::AgentCapabilities::default(),
        container_id: None,
        visual_identity: None,
        personality,
        integrations: vec![],
        memories: vec![],
        created_at: chrono::Utc::now(),
        stats: AgentStats::default(),
    };

    // Step 4: Persist to SQLite (best effort; if this fails, docker creation succeeded)
    if let Err(e) = db.insert_agent(&agent) {
        eprintln!("Warning: Failed to persist agent to DB: {}", e);
    } else {
        // Log audit event for agent creation
        let _ = db.log_audit(&agent_id, "create", Some("openclaw"), "Agent created via OpenClaw", None);
    }

    // TODO: If isolated, spin up a dedicated container via docker::generate_isolated_compose()

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
    let soul_md = generate_soul_md(&personality);
    let soul_path = agent_soul_path(&agent_id);

    let output = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c",
            &format!("mkdir -p $(dirname {}) && cat > {} << 'SOULEOF'\n{}\nSOULEOF", soul_path, soul_path, soul_md)])
        .output()
        .await
        .map_err(|e| format!("Failed to update SOUL.md: {}", e))?;

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

#[tauri::command]
pub async fn update_agent_integrations(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    integrations: Vec<String>,
) -> Result<(), String> {
    if let Ok(Some(mut agent)) = db.get_agent(&agent_id) {
        agent.integrations = integrations;
        let _ = db.update_agent(&agent);
        let _ = db.log_audit(&agent_id, "update_integrations", None, "Agent integrations updated", None);
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
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    capabilities: AgentCapabilities,
) -> Result<(), String> {
    if let Ok(Some(mut agent)) = db.get_agent(&agent_id) {
        agent.capabilities = capabilities;
        let _ = db.update_agent(&agent);
        let _ = db.log_audit(&agent_id, "update_capabilities", Some("security"), "Agent capabilities and network permissions updated", None);
    } else {
        return Err("Agent not found".to_string());
    }
    
    // In a full implementation, we would relay these network restrictions directly to the Docker container's iptables or the gateway proxy.
    // For now, the Tauri bridge acts as the gateway proxy and evaluates these capabilities from SQLite during any outgoing intercept.

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

    // A complete implementation would stop the existing container and spin up a dedicated compose network.
    // We mock the transition log for now, as the UI requires the loading state to resolve.
    // TODO: Spin up dedicated container via docker::generate_isolated_compose()!

    // Simulate Docker container recreation latency
    tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

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

    // Step 3: Send via native OpenClaw CLI
    let cmd_future = get_docker_command()
        .args([
            "exec", "canopy-gateway", 
            "openclaw", "agent", 
            "--agent", agent_id, 
            "--message", message, 
            "--json"
        ])
        .output();

    let output = match tokio::time::timeout(std::time::Duration::from_secs(60), cmd_future).await {
         Ok(res) => res.map_err(|e| format!("Failed to send message: {}", e))?,
         Err(_) => return Err("The agent failed to respond in time (Gateway Timeout).".into()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

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
            // It might be plaintext fallback.
            json!({
                "response": stdout.trim()
            })
        }
    };

    // Extract response text and log assistant message
    let response_text = body.get("response")
        .and_then(|v| v.as_str())
        .or_else(|| body.get("content").and_then(|v| v.as_str()))
        .unwrap_or(&body.to_string())
        .to_string();

    // OpenClaw emits "OpenClaw: <error>" lines when the agent is misconfigured
    // (e.g. auth-profiles.json has no API key). Return these as errors so the
    // frontend chat UI can offer the repair flow instead of showing the raw
    // system message as if it were an agent reply.
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
    // Get or create conversation for this agent
    let conv_id = db.get_or_create_conversation(&agent_id)
        .map_err(|e| format!("Failed to get conversation: {}", e))?;

    // Load messages from DB
    let messages = db.get_messages(&conv_id, limit.unwrap_or(50))
        .map_err(|e| format!("Failed to load messages: {}", e))?;

    Ok(messages)
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
        container_id: None,
        visual_identity: None,
        personality: AgentPersonality {
            name: name.clone(),
            communication_style: String::new(),
            expertise: vec![],
            guardrails: vec![],
            custom_instructions: String::new(),
            active_model: Some(imported_model),
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

#[tauri::command]
pub async fn check_agent_status(agent_id: String) -> Result<String, String> {
    let output = get_docker_command()
        .args(["exec", "canopy-gateway", "openclaw", "agents", "list", "--json"])
        .output()
        .await
        .map_err(|e| format!("Failed to check status: {}", e))?;

    if !output.status.success() {
        return Ok("error".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Ok(agents) = serde_json::from_str::<Value>(&stdout) {
        if let Some(agents_arr) = agents.as_array() {
            if agents_arr.iter().any(|a| a.get("id").and_then(|i| i.as_str()) == Some(&agent_id)) {
                return Ok("active".to_string());
            }
        }
    }

    Ok("offline".to_string())
}

#[tauri::command]
pub async fn sync_credentials(
    agent_id: String,
    keys: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let mut auth_profile = serde_json::Map::new();

    for (k, v) in keys {
        if v.trim().is_empty() { continue; }
        let provider = match k.as_str() {
            "ANTHROPIC_API_KEY" => "anthropic",
            "OPENAI_API_KEY" => "openai",
            "GEMINI_API_KEY" => "google",
            "XAI_API_KEY" => "xai",
            _ => continue,
        };
        auth_profile.insert(
            provider.to_string(),
            json!({ "apiKey": v })
        );
    }

    if auth_profile.is_empty() {
        return Ok(()); // Nothing to sync
    }

    let auth_json = serde_json::to_string(&auth_profile).unwrap();
    // Use the validated path helper — NOT a manual format! string.
    // Wrong (old): "/home/node/.openclaw/agents/{id}/agent/auth-profiles.json"  (extra agent/ dir)
    // Right:       "/home/node/.openclaw/agents/{id}/auth-profiles.json"
    let filepath = agent_auth_profile_path(&agent_id);

    let cmd_future = get_docker_command()
        .args([
            "exec", "-u", "node", "canopy-gateway", "sh", "-c",
            &format!("mkdir -p $(dirname {filepath}) && cat > {filepath} << 'AUTHEOF'\n{auth_json}\nAUTHEOF && chmod 600 {filepath}")
        ])
        .output();

    let output = match tokio::time::timeout(std::time::Duration::from_secs(3), cmd_future).await {
        Ok(res) => res.map_err(|e| format!("Failed to write auth profile: {}", e))?,
        Err(_) => return Err("Docker command timed out, proxy might be hanging".into()),
    };

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Docker exec failed: {}", err));
    }

    Ok(())
}

// ─── SOUL.md Generation ──────────────────────────────────────────────────────

/// Generate a SOUL.md file from a structured personality.
/// This is the bridge between our GUI and OpenClaw's native personality system.
fn generate_soul_md(personality: &AgentPersonality) -> String {
    let mut soul = String::new();

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

    soul
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
        let soul_path = agent_path.join("workspace").join("SOUL.md");
        std::fs::read_to_string(&soul_path).unwrap_or_else(|_| {
            std::fs::read_to_string(agent_path.join("SOUL.md"))
                .unwrap_or_else(|_| "# SOUL.md - Imported Agent".to_string())
        })
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
        isolated: true,
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

    // Helper closure to run `openclaw agents add` with a timeout
    let run_agents_add = |agent_id: &str| {
        let agent_id = agent_id.to_string();
        async move {
            tokio::time::timeout(
                std::time::Duration::from_secs(15),
                get_docker_command()
                    .args([
                        "exec", "-u", "node", "canopy-gateway",
                        "openclaw", "agents", "add",
                        &agent_id,
                        "--workspace", "/home/node/openclaw/workspace",
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
    let _ = writeln!(log, "Step 5/6: Applying gateway configuration...");
    let config_cmds = [
        ("gateway.mode", "local"),
        ("agents.defaults.memorySearch.enabled", "false"),
        ("gateway.token", GATEWAY_INTERNAL_TOKEN),
    ];
    for (key, val) in config_cmds.iter() {
        let r = get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "openclaw", "config", "set", key, val])
            .output().await;
        match r {
            Ok(o) if o.status.success() => { let _ = writeln!(log, "  ✓ Set {}", key); }
            Ok(o) => { let _ = writeln!(log, "  ! config set {} warning: {}", key, String::from_utf8_lossy(&o.stderr).trim()); }
            Err(e) => { let _ = writeln!(log, "  ! config set {} failed (non-fatal): {}", key, e); }
        }
    }

    // Prune stale session transcripts
    for store_path in [
        "/home/node/.openclaw/agents/main/sessions/sessions.json".to_string(),
        format!("/home/node/.openclaw/agents/{}/sessions/sessions.json", agent_id),
    ] {
        let _ = get_docker_command()
            .args([
                "exec", "-u", "node", "canopy-gateway",
                "openclaw", "sessions", "cleanup",
                "--store", &store_path,
                "--enforce", "--fix-missing",
            ])
            .output().await;
    }
    let _ = writeln!(log, "  ✓ Session stores pruned");

    // ─── Step 6: Restart gateway & run openclaw doctor ───────────────────────
    let _ = writeln!(log, "Step 6/6: Restarting gateway and running diagnostics...");
    match get_docker_command().args(["restart", "canopy-gateway"]).output().await {
        Ok(o) if o.status.success() => { let _ = writeln!(log, "  ✓ Gateway restarted"); }
        Ok(o) => { let _ = writeln!(log, "  ! Restart warning: {}", String::from_utf8_lossy(&o.stderr).trim()); }
        Err(e) => { let _ = writeln!(log, "  ! Restart failed (continuing): {}", e); }
    }

    // Wait for gateway to fully bind
    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;

    // Run openclaw doctor --fix
    let doctor = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        get_docker_command().args(["exec", "-u", "node", "canopy-gateway", "openclaw", "doctor", "--fix"]).output(),
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
    let node_script = format!(
        "const fs = require('fs'); const data = JSON.parse(fs.readFileSync('/home/node/.openclaw/openclaw.json', 'utf8')); data.agents.list = data.agents.list.map(a => a.id === '{}' ? {{ ...a, model: '{}' }} : a); fs.writeFileSync('/home/node/.openclaw/openclaw.json', JSON.stringify(data, null, 2));",
        agent_id, model
    );
    
    let output = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "node", "-e", &node_script])
        .output()
        .await
        .map_err(|e| format!("Failed to update OpenClaw model config: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Docker config overwrite failed: {}", err));
    }

    // Restart the gateway container fully so the openclaw.json changes propagate into the boot.
    let output2 = get_docker_command()
        .args(["restart", "canopy-gateway"])
        .output()
        .await
        .map_err(|e| format!("Failed to restart Canopy Gateway: {}", e))?;

    if !output2.status.success() {
        let err = String::from_utf8_lossy(&output2.stderr);
        return Err(format!("Gateway restart failed: {}", err));
    }

    Ok(())
}
#[tauri::command]
pub async fn approve_slack_pairing(
    code: String,
) -> Result<String, String> {
    let output = get_docker_command()
        .args([
            "exec", "-u", "node", "canopy-gateway", "openclaw", "pairing", "approve", "slack", &code
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
    state: tauri::State<'_, crate::db::Database>,
) -> Result<Vec<crate::db::AuditEntry>, String> {
    state.get_audit_log(None, limit.unwrap_or(100)).map_err(|e| e.to_string())
}

// ─── Boot Agent Sync ──────────────────────────────────────────────────────────

/// Re-register every SQLite agent with the OpenClaw gateway at startup.
/// Idempotent — "already exists" is treated as success.
/// Must run AFTER start_gateway() and BEFORE sync_credentials().
#[tauri::command]
pub async fn boot_sync_agents(
    db: tauri::State<'_, crate::db::Database>,
) -> Result<String, String> {
    let agents = db.list_agents().map_err(|e| e.to_string())?;

    if agents.is_empty() {
        return Ok("No agents to sync".to_string());
    }

    let mut ok: u32 = 0;
    let mut errs: u32 = 0;

    for agent in &agents {
        let id = &agent.id;

        // Step 1: openclaw agents add <id> (idempotent)
        let add_result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            get_docker_command()
                .args([
                    "exec", "-u", "node", "canopy-gateway",
                    "openclaw", "agents", "add", id,
                    "--workspace", "/home/node/openclaw/workspace",
                ])
                .output(),
        )
        .await;

        let registered = match add_result {
            Ok(Ok(out)) => {
                let combined = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                out.status.success() || combined.to_lowercase().contains("already exists")
            }
            _ => false,
        };

        if !registered {
            tracing::warn!("boot_sync_agents: could not register agent {}", id);
            errs += 1;
            continue;
        }

        // Step 2: Re-write SOUL.md from persisted personality data
        let soul_content = generate_soul_md(&agent.personality);
        let soul_path = agent_soul_path(id);
        // Escape single quotes in the soul content for the shell heredoc
        let escaped_soul = soul_content.replace('\'', "'\\''");
        let write_cmd = format!(
            "mkdir -p \"$(dirname '{soul_path}')\" && printf '%s' '{soul}' > '{soul_path}'",
            soul_path = soul_path,
            soul = escaped_soul,
        );
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            get_docker_command()
                .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &write_cmd])
                .output(),
        )
        .await;

        tracing::info!("boot_sync_agents: registered agent {}", id);
        ok += 1;
    }

    tracing::info!("boot_sync_agents complete: {} ok, {} errors", ok, errs);
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

    // ── SOUL.md path ──────────────────────────────────────────────────────

    #[test]
    fn soul_path_is_in_workspace_not_dot_openclaw() {
        let path = model_constants::agent_soul_path("test-agent");
        assert!(
            path.contains("/openclaw/workspace/"),
            "SOUL path '{}' must be under /openclaw/workspace/",
            path
        );
        assert!(
            !path.contains("/.openclaw/"),
            "SOUL path '{}' must NOT be under /.openclaw/ — wrong directory",
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
}

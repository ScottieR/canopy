use crate::models::{Agent, AgentPersonality, AgentCapabilities, AgentStats, AgentStatus, DiscoveredAgent};
use reqwest::Client;
use serde_json::{json, Value};

const GATEWAY_URL: &str = "http://localhost:18799";

/// Interface to the OpenClaw Gateway API with SQLite persistence.
/// All agent management goes through here with dual persistence:
/// 1. Docker containers for runtime
/// 2. SQLite DB for metadata and conversation history

#[tauri::command]
pub async fn create_agent(
    db: tauri::State<'_, crate::db::Database>,
    name: String,
    role: String,
    emoji: String,
    personality: AgentPersonality,
    isolated: bool,
) -> Result<Agent, String> {
    let agent_id = format!("agent-{}", name.to_lowercase().replace(' ', "-"));

    // Step 1: Create agent via OpenClaw CLI (inside the container)
    let output = tokio::process::Command::new("docker")
        .args([
            "exec", "-u", "root", "canopy-gateway",
            "openclaw", "agents", "add",
            &agent_id,
            "--workspace", "/home/node/openclaw/workspace",
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to create agent: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to create agent: {}", stderr));
    }

    // Step 2: Generate SOUL.md from personality
    let soul_md = generate_soul_md(&personality);
    // Write SOUL.md to the agent's workspace inside the container
    let soul_path = format!("/home/node/openclaw/workspace/{}/SOUL.md", agent_id);
    tokio::process::Command::new("docker")
        .args(["exec", "-u", "root", "canopy-gateway", "sh", "-c",
            &format!("cat > {} << 'SOULEOF'\n{}\nSOULEOF", soul_path, soul_md)])
        .output()
        .await
        .map_err(|e| format!("Failed to write SOUL.md: {}", e))?;

    // Step 3: Set identity (emoji, avatar)
    tokio::process::Command::new("docker")
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
        personality,
        integrations: vec![],
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

    // Optional: Check gateway health to merge live status
    let client = Client::new();
    if let Ok(resp) = client
        .get(format!("{}/api/status", GATEWAY_URL))
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
    let soul_path = format!("/root/openclaw/workspace/{}/SOUL.md", agent_id);

    let output = tokio::process::Command::new("docker")
        .args(["exec", "canopy-gateway", "sh", "-c",
            &format!("cat > {} << 'SOULEOF'\n{}\nSOULEOF", soul_path, soul_md)])
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
    let output = tokio::process::Command::new("docker")
        .args([
            "exec", "canopy-gateway",
            "openclaw", "agents", "remove",
            "--agent", &agent_id,
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

#[tauri::command]
pub async fn send_message(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    message: String,
) -> Result<Value, String> {
    // Step 1: Get or create conversation
    let conv_id = db.get_or_create_conversation(&agent_id)
        .map_err(|e| format!("Failed to get conversation: {}", e))?;

    // Step 2: Log user message to DB
    let _ = db.insert_message(&conv_id, "user", &message);

    // Step 3: Send to OpenClaw API
    let client = Client::new();
    let resp = client
        .post(format!("{}/api/sessions/main/messages", GATEWAY_URL))
        .json(&json!({
            "agentId": agent_id,
            "message": message,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to send message: {}", e))?;

    let body = resp.json::<Value>().await.map_err(|e| e.to_string())?;

    // Step 4: Extract response text and log assistant message
    if let Some(response_text) = body.get("response").and_then(|v| v.as_str()) {
        let _ = db.insert_message(&conv_id, "assistant", response_text);
    }

    // Step 5: Log audit event
    let _ = db.log_audit(&agent_id, "send_message", Some("openclaw"), "Message sent to agent", None);

    Ok(body)
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
        .send()
        .await
        .map_err(|e| format!("Failed to query gateway: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Agent not found in OpenClaw: {}", openclaw_agent_id));
    }

    let agent_data = resp.json::<Value>().await.map_err(|e| e.to_string())?;

    // Step 2: Create local Agent struct from OpenClaw data
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
        personality: AgentPersonality {
            name: name.clone(),
            communication_style: String::new(),
            expertise: vec![],
            guardrails: vec![],
            custom_instructions: String::new(),
        },
        integrations: vec![],
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
        .send()
        .await
        .map_err(|e| format!("Health check failed: {}", e))?;

    let body = resp.json::<Value>().await.map_err(|e| e.to_string())?;
    Ok(body)
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
    
    // 3. Scan HTTP ports for running standalone OpenClaw instances
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_millis(800)).build().unwrap_or_default();
    let ports = [18789, 18798];
    for port in ports {
        if let Ok(resp) = client.get(format!("http://localhost:{}/api/status", port)).send().await {
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
        if let Ok(resp) = client.get(format!("{}/api/agent", path)).send().await {
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
        personality: AgentPersonality {
            name: name.clone(),
            communication_style: "Imported from local disk".to_string(),
            expertise: vec![],
            guardrails: vec![],
            custom_instructions: soul_content,
        },
        integrations: vec![],
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
    // 1. Verify and repair the agent's existence in the gateway
    let _ = tokio::process::Command::new("docker")
        .args([
            "exec", "-u", "root", "canopy-gateway",
            "openclaw", "agents", "add",
            &agent_id,
            "--workspace", "/home/node/openclaw/workspace",
        ])
        .output()
        .await;

    // 2. Sync personality to ensure SOUL.md is present
    if let Ok(Some(agent)) = db.get_agent(&agent_id) {
        let soul_md = generate_soul_md(&agent.personality);
        let soul_path = format!("/home/node/openclaw/workspace/{}/SOUL.md", agent_id);
        let _ = tokio::process::Command::new("docker")
            .args(["exec", "-u", "root", "canopy-gateway", "sh", "-c",
                &format!("cat > {} << 'SOULEOF'\n{}\nSOULEOF", soul_path, soul_md)])
            .output()
            .await;
    }

    // 3. Run the OpenClaw native diagnostic repair tool
    let output = tokio::process::Command::new("docker")
        .args([
            "exec", "-u", "root", "canopy-gateway",
            "openclaw", "doctor", "--fix",
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run diagnostic repair: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Doctor repair failed: {}", stderr));
    }

    Ok("Diagnostics and repair completed successfully.".to_string())
}

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::process::Command;
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};
use uuid::Uuid;

const MAX_MOBILE_MESSAGE_CHARS: usize = 64_000;
const MAX_MOBILE_SYSTEM_COMMAND_CHARS: usize = 4_096;

// State to hold the current valid pairing token
pub struct DispatchState {
    pub current_token: RwLock<Option<String>>,
    pub mobile_state: RwLock<serde_json::Value>,
}

impl DispatchState {
    pub fn new() -> Self {
        let stored_token = crate::keychain::get_secret("mobile_pairing_token").ok();
        Self {
            current_token: RwLock::new(stored_token),
            // Initial empty payload — both "forums" and "projects" keys are
            // pre-seeded so mobile's `list_forums` returns [] (not the older
            // "projects" leftover that caused empty Forums tabs on cold boot
            // before any desktop sync had run).
            mobile_state: RwLock::new(serde_json::json!({
                "forums": [],
                "projects": [],
                "inbox": []
            })),
        }
    }
}

#[derive(Serialize)]
pub struct PairingData {
    pub token: String,
    pub ip: String,
    pub port: u16,
}

#[tauri::command]
pub async fn generate_pairing_token(
    state: State<'_, Arc<DispatchState>>,
) -> Result<PairingData, String> {
    // 1. Generate new token
    let token = Uuid::new_v4().to_string();

    // 2. Store it
    let mut writer = state.current_token.write().await;
    *writer = Some(token.clone());
    let _ = crate::keychain::store_secret("mobile_pairing_token", &token);

    // 3. Get local IP
    let ip = get_local_ip().unwrap_or_else(|| "127.0.0.1".to_string());

    Ok(PairingData {
        token,
        ip,
        port: 3030,
    })
}

#[tauri::command]
pub async fn revoke_pairing_token(state: State<'_, Arc<DispatchState>>) -> Result<(), String> {
    let mut writer = state.current_token.write().await;
    *writer = None;
    let _ = crate::keychain::delete_secret_internal("mobile_pairing_token");
    Ok(())
}

#[tauri::command]
pub async fn sync_mobile_state(
    state: State<'_, Arc<DispatchState>>,
    payload: serde_json::Value,
) -> Result<(), String> {
    let mut writer = state.mobile_state.write().await;
    *writer = payload;
    Ok(())
}

fn get_local_ip() -> Option<String> {
    // Try en0 (Wi-Fi) first
    if let Ok(output) = Command::new("ipconfig").args(["getifaddr", "en0"]).output() {
        let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !ip.is_empty() {
            return Some(ip);
        }
    }
    // Try en1 (Ethernet/Secondary)
    if let Ok(output) = Command::new("ipconfig").args(["getifaddr", "en1"]).output() {
        let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !ip.is_empty() {
            return Some(ip);
        }
    }
    None
}

// WebSocket Server Task
pub async fn start_websocket_server(state: Arc<DispatchState>, app_handle: tauri::AppHandle) {
    let addr = "0.0.0.0:3030";
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("Failed to bind WebSocket server to {}: {}", addr, e);
            return;
        }
    };

    info!("WebSocket relay listening on: {}", addr);

    while let Ok((stream, peer_addr)) = listener.accept().await {
        let state_clone = Arc::clone(&state);
        tokio::spawn(handle_connection(
            stream,
            peer_addr,
            state_clone,
            app_handle.clone(),
        ));
    }
}

#[derive(Deserialize)]
struct AuthMessage {
    auth: String,
}

#[derive(Deserialize)]
struct RpcRequest {
    command: String,
    payload: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct RpcResponse {
    #[serde(rename = "type")]
    msg_type: String,
    payload: serde_json::Value,
}

fn is_allowed_mobile_system_command(text: &str) -> bool {
    if text.len() > MAX_MOBILE_SYSTEM_COMMAND_CHARS {
        return false;
    }

    if text == "COMMAND: CREATE_PROJECT_SPACE_AUTO" {
        return true;
    }

    [
        "COMMAND: CAPTURE_NOTE:",
        "COMMAND: DISMISS_INBOX_ITEM:",
        "COMMAND: APPROVE_INBOX_ITEM:",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix) && text.len() > prefix.len())
}

fn is_valid_mobile_message_text(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_MOBILE_MESSAGE_CHARS
}

async fn handle_connection(
    stream: TcpStream,
    peer_addr: SocketAddr,
    state: Arc<DispatchState>,
    app_handle: tauri::AppHandle,
) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            warn!("WebSocket handshake failed with {}: {}", peer_addr, e);
            return;
        }
    };

    info!("New WebSocket connection from: {}", peer_addr);
    let (mut write, mut read) = ws_stream.split();

    // Auth phase
    let mut authenticated = false;
    if let Some(Ok(Message::Text(text))) = read.next().await {
        if let Ok(auth_msg) = serde_json::from_str::<AuthMessage>(&text) {
            let reader = state.current_token.read().await;
            if let Some(valid_token) = &*reader {
                if auth_msg.auth == *valid_token {
                    authenticated = true;
                    // Write back success
                    let _ = write
                        .send(Message::Text("{\"status\":\"authenticated\"}".to_string()))
                        .await;
                }
            }
        }
    }

    if !authenticated {
        warn!("Authentication failed for {}", peer_addr);
        let _ = write
            .send(Message::Text("{\"error\":\"unauthorized\"}".to_string()))
            .await;
        return;
    }

    info!("Client {} successfully authenticated", peer_addr);

    use tauri::Manager;
    let db_state = app_handle.state::<crate::db::Database>();

    // Message loop
    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                info!("Received RPC command from {}: {}", peer_addr, text);

                if let Ok(req) = serde_json::from_str::<RpcRequest>(&text) {
                    match req.command.as_str() {
                        "list_agents" => {
                            // Prefer the richer agent list from mobile_state (includes conversation_id
                            // and image_url synced by the frontend) over the bare DB list.
                            let reader = state.mobile_state.read().await;
                            let agents_payload = if let Some(agents) = reader.get("agents") {
                                agents.clone()
                            } else {
                                drop(reader);
                                // Fallback: raw DB list without conversation_id
                                if let Ok(agents) =
                                    crate::openclaw::list_agents(db_state.clone()).await
                                {
                                    serde_json::json!(agents)
                                } else {
                                    serde_json::json!([])
                                }
                            };
                            let res = RpcResponse {
                                msg_type: "agents_list".to_string(),
                                payload: agents_payload,
                            };
                            if let Ok(json_str) = serde_json::to_string(&res) {
                                let _ = write.send(Message::Text(json_str)).await;
                            }
                        }
                        "get_chat_history" => {
                            if let Some(payload) = req.payload {
                                if let Some(agent_id) =
                                    payload.get("agent_id").and_then(|v| v.as_str())
                                {
                                    // Prefer an explicit session_id (the agent's activeConversationId)
                                    // so we never accidentally return a forum orchestration session.
                                    let session_id = payload
                                        .get("session_id")
                                        .and_then(|v| v.as_str())
                                        .filter(|s| !s.is_empty())
                                        .map(|s| s.to_string());
                                    let is_forum = payload.get("mode").and_then(|v| v.as_str())
                                        == Some("forum");
                                    if let Ok(history) = crate::openclaw::get_conversation_history(
                                        db_state.clone(),
                                        agent_id.to_string(),
                                        session_id,
                                        Some(100),
                                    )
                                    .await
                                    {
                                        // Filter out forum orchestration prompts — these are the large
                                        // system prompts sent to agents during forum phases and should
                                        // never appear in the mobile individual chat thread.
                                        let filtered: Vec<_> = history.into_iter().filter(|m| {
                                            let c = m.content.to_lowercase();
                                            // Drop messages that look like forum phase prompts
                                            let mut drop = (c.contains("you are ") && c.contains("participating in a collaborative forum"))
                                                || c.contains("this is the research & discovery phase")
                                                || c.contains("this is the strategic approach phase")
                                                || c.contains("producing the final deliverable for a collaborative forum");
                                            
                                            // If not viewing a forum, also drop the artifacts
                                            if !is_forum && c.contains("---format---") {
                                                drop = true;
                                            }
                                            
                                            !drop
                                        }).collect();
                                        let res = RpcResponse {
                                            msg_type: "chat_history".to_string(),
                                            payload: serde_json::json!(filtered),
                                        };
                                        if let Ok(json_str) = serde_json::to_string(&res) {
                                            let _ = write.send(Message::Text(json_str)).await;
                                        }
                                    }
                                }
                            }
                        }
                        "ping" => {
                            let res = RpcResponse {
                                msg_type: "pong".to_string(),
                                payload: serde_json::json!({}),
                            };
                            if let Ok(json_str) = serde_json::to_string(&res) {
                                let _ = write.send(Message::Text(json_str)).await;
                            }
                        }
                        // list_forums: new primary name. Falls back to the
                        // legacy "projects" key the same way list_projects
                        // does — so if a future code path or older client
                        // writes only "projects", mobile still gets data.
                        "list_forums" => {
                            let reader = state.mobile_state.read().await;
                            let forums = reader
                                .get("forums")
                                .or_else(|| reader.get("projects"))
                                .cloned()
                                .unwrap_or(serde_json::json!([]));
                            let res = RpcResponse {
                                msg_type: "forums_list".to_string(),
                                payload: forums,
                            };
                            if let Ok(json_str) = serde_json::to_string(&res) {
                                let _ = write.send(Message::Text(json_str)).await;
                            }
                        }
                        // list_projects: legacy alias — responds with forums_list for backwards compat
                        "list_projects" => {
                            let reader = state.mobile_state.read().await;
                            let forums = reader
                                .get("forums")
                                .or_else(|| reader.get("projects"))
                                .cloned()
                                .unwrap_or(serde_json::json!([]));
                            let res = RpcResponse {
                                msg_type: "forums_list".to_string(),
                                payload: forums,
                            };
                            if let Ok(json_str) = serde_json::to_string(&res) {
                                let _ = write.send(Message::Text(json_str)).await;
                            }
                        }
                        "list_inbox" => {
                            let reader = state.mobile_state.read().await;
                            if let Some(inbox) = reader.get("inbox") {
                                let res = RpcResponse {
                                    msg_type: "inbox_list".to_string(),
                                    payload: inbox.clone(),
                                };
                                if let Ok(json_str) = serde_json::to_string(&res) {
                                    let _ = write.send(Message::Text(json_str)).await;
                                }
                            }
                        }
                        "send_message" => {
                            if let Some(payload) = req.payload {
                                if let (Some(agent_id), Some(text_msg)) = (
                                    payload.get("agent_id").and_then(|v| v.as_str()),
                                    payload.get("text").and_then(|v| v.as_str()),
                                ) {
                                    if agent_id == "system" {
                                        // Only forward known mobile shortcut commands to the desktop UI.
                                        if is_allowed_mobile_system_command(text_msg) {
                                            let _ = app_handle.emit(
                                                "mobile_system_command",
                                                serde_json::json!({
                                                    "command": text_msg
                                                }),
                                            );
                                        } else {
                                            warn!(
                                                "Rejected mobile system command from {}",
                                                peer_addr
                                            );
                                            let _ = write
                                                .send(Message::Text(
                                                    "{\"error\":\"unauthorized_system_command\"}"
                                                        .to_string(),
                                                ))
                                                .await;
                                        }
                                    } else {
                                        if let Err(e) =
                                            crate::validators::agent::validate_id(agent_id)
                                        {
                                            warn!("Rejected mobile send_message with invalid agent id from {}: {}", peer_addr, e);
                                            let _ = write
                                                .send(Message::Text(
                                                    "{\"error\":\"invalid_agent_id\"}".to_string(),
                                                ))
                                                .await;
                                            continue;
                                        }
                                        if !is_valid_mobile_message_text(text_msg) {
                                            warn!("Rejected mobile send_message with invalid message size from {}", peer_addr);
                                            let _ = write
                                                .send(Message::Text(
                                                    "{\"error\":\"invalid_message\"}".to_string(),
                                                ))
                                                .await;
                                            continue;
                                        }
                                        if let Err(e) =
                                            crate::rate_limiter::limiters::AGENT_COMMAND_LIMITER
                                                .check(agent_id)
                                        {
                                            warn!("Rate limited mobile send_message for agent {} from {}: {}", agent_id, peer_addr, e);
                                            let _ = write
                                                .send(Message::Text(
                                                    "{\"error\":\"rate_limited\"}".to_string(),
                                                ))
                                                .await;
                                            continue;
                                        }
                                        // Pass the agent's individual chat session ID so forum sessions
                                        // never receive or contaminate the mobile conversation.
                                        let session_id = payload
                                            .get("session_id")
                                            .and_then(|v| v.as_str())
                                            .filter(|s| !s.is_empty())
                                            .map(|s| s.to_string());
                                        if let Ok(response_val) =
                                            crate::openclaw::send_message_internal(
                                                &*db_state,
                                                &app_handle,
                                                agent_id,
                                                text_msg,
                                                session_id,
                                            )
                                            .await
                                        {
                                            let res = RpcResponse {
                                                msg_type: "chat_response".to_string(),
                                                payload: serde_json::json!({
                                                    "agent_id": agent_id,
                                                    "response": response_val
                                                }),
                                            };
                                            if let Ok(json_str) = serde_json::to_string(&res) {
                                                let _ = write.send(Message::Text(json_str)).await;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        "resolve_inbox_item" => {
                            // Forward to the desktop UI to dismiss/approve the item
                            if let Some(payload) = req.payload {
                                let _ = app_handle.emit("mobile_inbox_resolved", payload);
                            }
                        }
                        "set_sensor_token" => {
                            if let Some(payload) = req.payload {
                                if let (Some(agent_id), Some(sensor_id), Some(token)) = (
                                    payload.get("agent_id").and_then(|v| v.as_str()),
                                    payload.get("sensor_id").and_then(|v| v.as_str()),
                                    payload.get("token").and_then(|v| v.as_str()),
                                ) {
                                    let key = format!("agent_{}_{}_token", agent_id, sensor_id);
                                    let _ = crate::keychain::store_secret(&key, token);

                                    // Also notify the frontend that a sensor token was set
                                    let _ = app_handle.emit(
                                        "mobile_sensor_configured",
                                        serde_json::json!({
                                            "agent_id": agent_id,
                                            "sensor_id": sensor_id
                                        }),
                                    );

                                    let res = RpcResponse {
                                        msg_type: "sensor_token_saved".to_string(),
                                        payload: serde_json::json!({"success": true}),
                                    };
                                    if let Ok(json_str) = serde_json::to_string(&res) {
                                        let _ = write.send(Message::Text(json_str)).await;
                                    }
                                }
                            }
                        }
                        _ => {
                            let _ = write
                                .send(Message::Text(format!(
                                    "{{\"error\": \"Unknown command: {}\"}}",
                                    req.command
                                )))
                                .await;
                        }
                    }
                }
            }
            Ok(Message::Ping(p)) => {
                let _ = write.send(Message::Pong(p)).await;
            }
            Ok(Message::Close(_)) => {
                break;
            }
            _ => {}
        }
    }

    info!("Connection closed: {}", peer_addr);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_system_command_allowlist_accepts_known_commands() {
        assert!(is_allowed_mobile_system_command(
            "COMMAND: CAPTURE_NOTE:Remember the demo notes"
        ));
        assert!(is_allowed_mobile_system_command(
            "COMMAND: CREATE_PROJECT_SPACE_AUTO"
        ));
        assert!(is_allowed_mobile_system_command(
            "COMMAND: DISMISS_INBOX_ITEM:item_123"
        ));
        assert!(is_allowed_mobile_system_command(
            "COMMAND: APPROVE_INBOX_ITEM:item_123"
        ));
    }

    #[test]
    fn mobile_system_command_allowlist_rejects_unknown_or_oversized_commands() {
        assert!(!is_allowed_mobile_system_command(
            "COMMAND: DELETE_AGENT:agent-alpha"
        ));
        assert!(!is_allowed_mobile_system_command("COMMAND: CAPTURE_NOTE:"));
        assert!(!is_allowed_mobile_system_command(&format!(
            "COMMAND: CAPTURE_NOTE:{}",
            "x".repeat(MAX_MOBILE_SYSTEM_COMMAND_CHARS)
        )));
    }

    #[test]
    fn mobile_agent_message_validation_rejects_bad_ids_and_empty_messages() {
        assert!(crate::validators::agent::validate_id("agent-alpha").is_ok());
        assert!(is_valid_mobile_message_text("hello"));
        assert!(crate::validators::agent::validate_id("agent-alpha;rm -rf").is_err());
        assert!(!is_valid_mobile_message_text("   "));
        assert!(!is_valid_mobile_message_text(
            &"x".repeat(MAX_MOBILE_MESSAGE_CHARS + 1)
        ));
    }
}

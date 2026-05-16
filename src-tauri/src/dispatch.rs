use std::sync::Arc;
use tokio::sync::RwLock;
use std::net::SocketAddr;
use tokio::net::{TcpListener, TcpStream};
use tauri::State;
use serde::{Deserialize, Serialize};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use std::process::Command;
use uuid::Uuid;
use tracing::{info, warn, error};

// State to hold the current valid pairing token
pub struct DispatchState {
    pub current_token: RwLock<Option<String>>,
}

impl DispatchState {
    pub fn new() -> Self {
        Self {
            current_token: RwLock::new(None),
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
pub async fn generate_pairing_token(state: State<'_, Arc<DispatchState>>) -> Result<PairingData, String> {
    // 1. Generate new token
    let token = Uuid::new_v4().to_string();
    
    // 2. Store it
    let mut writer = state.current_token.write().await;
    *writer = Some(token.clone());
    
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
        tokio::spawn(handle_connection(stream, peer_addr, state_clone, app_handle.clone()));
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

async fn handle_connection(stream: TcpStream, peer_addr: SocketAddr, state: Arc<DispatchState>, app_handle: tauri::AppHandle) {
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
                    let _ = write.send(Message::Text("{\"status\":\"authenticated\"}".to_string())).await;
                }
            }
        }
    }
    
    if !authenticated {
        warn!("Authentication failed for {}", peer_addr);
        let _ = write.send(Message::Text("{\"error\":\"unauthorized\"}".to_string())).await;
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
                            if let Ok(agents) = crate::openclaw::list_agents(db_state.clone()).await {
                                let res = RpcResponse {
                                    msg_type: "agents_list".to_string(),
                                    payload: serde_json::json!(agents),
                                };
                                if let Ok(json_str) = serde_json::to_string(&res) {
                                    let _ = write.send(Message::Text(json_str)).await;
                                }
                            }
                        }
                        "get_chat_history" => {
                            if let Some(payload) = req.payload {
                                if let Some(agent_id) = payload.get("agent_id").and_then(|v| v.as_str()) {
                                    if let Ok(history) = crate::openclaw::get_conversation_history(db_state.clone(), agent_id.to_string(), None, Some(100)).await {
                                        let res = RpcResponse {
                                            msg_type: "chat_history".to_string(),
                                            payload: serde_json::json!(history),
                                        };
                                        if let Ok(json_str) = serde_json::to_string(&res) {
                                            let _ = write.send(Message::Text(json_str)).await;
                                        }
                                    }
                                }
                            }
                        }
                        "send_message" => {
                            if let Some(payload) = req.payload {
                                if let (Some(agent_id), Some(text_msg)) = (
                                    payload.get("agent_id").and_then(|v| v.as_str()),
                                    payload.get("text").and_then(|v| v.as_str())
                                ) {
                                    if let Ok(response_val) = crate::openclaw::send_message_internal(&*db_state, &app_handle, agent_id, text_msg, None).await {
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
                        _ => {
                            let _ = write.send(Message::Text(format!("{{\"error\": \"Unknown command: {}\"}}", req.command))).await;
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

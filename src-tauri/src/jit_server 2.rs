use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tracing::{error, info};

// Shared state for pending approval requests. Maps a request_id to a oneshot sender.
lazy_static::lazy_static! {
    pub static ref PENDING_REQUESTS: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>> = Arc::new(Mutex::new(HashMap::new()));
}

#[derive(Serialize, Deserialize, Debug)]
struct JitRequest {
    credential_id: String,
    justification: String,
    agent_id: String,
}

pub async fn start_jit_server(app_handle: tauri::AppHandle) {
    let listener = TcpListener::bind("0.0.0.0:18802").await.expect("Failed to bind JIT port");
    info!("JIT Provisioning server listening on 0.0.0.0:18802");

    loop {
        if let Ok((mut socket, _)) = listener.accept().await {
            let app = app_handle.clone();
            tokio::spawn(async move {
                let mut buf = [0; 8192];
                let mut req_data = Vec::new();
                let mut content_length = 0;
                let mut headers_parsed = false;
                let mut is_post = false;

                // Read until we get the full HTTP request
                loop {
                    match socket.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            req_data.extend_from_slice(&buf[..n]);

                            if !headers_parsed {
                                if let Some(pos) = req_data.windows(4).position(|w| w == b"\r\n\r\n") {
                                    headers_parsed = true;
                                    let header_str = String::from_utf8_lossy(&req_data[..pos]);
                                    
                                    if header_str.starts_with("POST ") {
                                        is_post = true;
                                    }

                                    for line in header_str.lines() {
                                        if line.to_lowercase().starts_with("content-length:") {
                                            if let Some(len_str) = line.split(':').nth(1) {
                                                content_length = len_str.trim().parse().unwrap_or(0);
                                            }
                                        }
                                    }
                                    let body_start = pos + 4;
                                    if req_data.len() - body_start >= content_length {
                                        break; // Received full body
                                    }
                                }
                            } else {
                                // Find end of headers again to calculate body length
                                if let Some(pos) = req_data.windows(4).position(|w| w == b"\r\n\r\n") {
                                    let body_start = pos + 4;
                                    if req_data.len() - body_start >= content_length {
                                        break;
                                    }
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }

                if let Some(pos) = req_data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let body = &req_data[pos + 4..];
                    
                    if is_post {
                        if let Ok(req) = serde_json::from_slice::<JitRequest>(body) {
                            let (response, status_code) = handle_jit_request(app, req).await;

                            let resp_str = serde_json::to_string(&response).unwrap_or_default();
                            let http_resp = format!(
                                "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                status_code,
                                resp_str.len(),
                                resp_str
                            );
                            let _ = socket.write_all(http_resp.as_bytes()).await;
                        } else {
                            // Bad Request
                            let resp_str = r#"{"error":"Invalid request body"}"#;
                            let http_resp = format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", resp_str.len(), resp_str);
                            let _ = socket.write_all(http_resp.as_bytes()).await;
                        }
                    } else {
                        // Return simple options OK for CORS
                        let http_resp = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        let _ = socket.write_all(http_resp.as_bytes()).await;
                    }
                }
            });
        }
    }
}

async fn handle_jit_request(app: tauri::AppHandle, req: JitRequest) -> (Value, u16) {
    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<bool>();

    {
        let mut pending = PENDING_REQUESTS.lock().await;
        pending.insert(req_id.clone(), tx);
    }

    use tauri::Emitter;
    let _ = app.emit(
        "jit_auth_requested",
        json!({
            "request_id": req_id,
            "credential_id": req.credential_id,
            "justification": req.justification,
            "agent_id": req.agent_id
        }),
    );

    // Pause and wait for approval
    let approved = rx.await.unwrap_or(false);

    if approved {
        return (
            json!({
                "status": "provisioned",
                "message": "The user has approved this request and the credential has been physically injected into your environment. You may proceed."
            }),
            200,
        );
    } else {
        return (
            json!({
                "status": "denied",
                "message": "The user denied this request. You do not have access."
            }),
            403, // Return 403 Forbidden
        );
    }
}

#[tauri::command]
pub async fn approve_jit_request(
    app_handle: tauri::AppHandle,
    request_id: String,
    approved: bool,
    agent_id: String,
    credential_id: String,
    duration: String,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<(), String> {
    if approved {
        if duration == "permanent" {
            let mut agent = db.get_agent(&agent_id)
                .map_err(|e| format!("DB error: {}", e))?
                .ok_or_else(|| "Agent not found".to_string())?;
                
            if !agent.integrations.contains(&credential_id) {
                agent.integrations.push(credential_id.clone());
                db.update_agent(&agent).map_err(|e| format!("Failed to update agent: {}", e))?;
                
                // Sync openclaw.json so it applies permanently
                let _ = crate::openclaw::boot_sync_agents(app_handle.clone(), db.clone()).await;
            }
        } else {
            // Session or One-Time
            // Inject dynamically into container without saving to the DB profile
            crate::openclaw::inject_jit_credential(&agent_id, &credential_id).await.map_err(|e| e.to_string())?;
            
            if duration == "one_time" {
                // Spawn task to automatically revoke after 5 minutes
                let agent_id_clone = agent_id.clone();
                let cred_id_clone = credential_id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    let _ = crate::openclaw::revoke_jit_credential(&agent_id_clone, &cred_id_clone).await;
                    tracing::info!("Auto-revoked one_time JIT credential {} for {}", cred_id_clone, agent_id_clone);
                });
            }
        }
    }

    let mut pending = PENDING_REQUESTS.lock().await;
    if let Some(tx) = pending.remove(&request_id) {
        let _ = tx.send(approved);
    }
    
    Ok(())
}

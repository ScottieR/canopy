use base64::Engine;
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

#[derive(Serialize, Deserialize, Debug)]
struct ExportRequest {
    agent_id: String,
    filename: String,
    content: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct AttentionRequest {
    agent_id: String,
    reason: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct PermissionRequest {
    agent_id: String,
    /// Logical permission identifier — matches a `Permission.id` in worldStore.ts
    /// (e.g. "browser", "vision", "file_write") OR an integration name (e.g. "gmail",
    /// "googleCalendar", "github") OR a domain (e.g. "domain:linkedin.com").
    permission_id: String,
    justification: String,
}

fn bearer_token(headers: &str) -> Option<String> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.eq_ignore_ascii_case("authorization") {
            return None;
        }
        value
            .trim()
            .strip_prefix("Bearer ")
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(str::to_string)
    })
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn presented_capability_matches(presented: Option<&str>, expected: &str) -> bool {
    presented
        .map(|value| constant_time_eq(value, expected))
        .unwrap_or(false)
}

pub(crate) fn agent_jit_token(agent_id: &str) -> Result<String, String> {
    crate::validators::agent::validate_id(agent_id).map_err(|e| e.to_string())?;
    crate::keychain::get_or_create_internal_secret(
        &format!("internal_jit_bridge_{}", agent_id),
        "canopy_jit_",
    )
    .map_err(|e| e.to_string())
}

fn request_agent_id(body: &[u8]) -> Result<String, (u16, String)> {
    let value: Value = serde_json::from_slice(body).map_err(|_| {
        (
            400,
            r#"{"error":"Invalid JSON request body"}"#.to_string(),
        )
    })?;
    let agent_id = value
        .get("agent_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                400,
                r#"{"error":"agent_id is required"}"#.to_string(),
            )
        })?;
    crate::validators::agent::validate_id(agent_id).map_err(|_| {
        (
            400,
            r#"{"error":"Invalid agent_id"}"#.to_string(),
        )
    })?;
    Ok(agent_id.to_string())
}

fn authenticate_agent_request(
    capability: Option<&str>,
    body: &[u8],
) -> Result<String, (u16, String)> {
    let agent_id = request_agent_id(body)?;
    let presented = capability.ok_or_else(|| {
        (
            401,
            r#"{"error":"Missing agent bridge capability"}"#.to_string(),
        )
    })?;
    let expected = agent_jit_token(&agent_id).map_err(|_| {
        (
            503,
            r#"{"error":"Agent bridge capability unavailable"}"#.to_string(),
        )
    })?;
    if !presented_capability_matches(Some(presented), &expected) {
        return Err((
            403,
            r#"{"error":"Invalid agent bridge capability"}"#.to_string(),
        ));
    }
    Ok(agent_id)
}

fn files_broker_response(result: Result<serde_json::Value, String>) -> (u16, String) {
    match result {
        Ok(value) => (
            200,
            serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string()),
        ),
        Err(error) => (
            403,
            serde_json::to_string(&json!({ "error": error }))
                .unwrap_or_else(|_| r#"{"error":"Files Bridge request denied"}"#.to_string()),
        ),
    }
}

pub async fn start_jit_server(app_handle: tauri::AppHandle) {
    let listener = TcpListener::bind("0.0.0.0:18802")
        .await
        .expect("Failed to bind JIT port");
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
                            if req_data.len() > 64 * 1024 {
                                let response = "HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                                let _ = socket.write_all(response.as_bytes()).await;
                                return;
                            }

                            if !headers_parsed {
                                if let Some(pos) =
                                    req_data.windows(4).position(|w| w == b"\r\n\r\n")
                                {
                                    headers_parsed = true;
                                    let header_str = String::from_utf8_lossy(&req_data[..pos]);

                                    let mut path = "/";
                                    if header_str.starts_with("POST ") {
                                        is_post = true;
                                        if let Some(p) = header_str.split_whitespace().nth(1) {
                                            path = p;
                                        }
                                    }

                                    for line in header_str.lines() {
                                        if line.to_lowercase().starts_with("content-length:") {
                                            if let Some(len_str) = line.split(':').nth(1) {
                                                content_length =
                                                    len_str.trim().parse().unwrap_or(0);
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
                                if let Some(pos) =
                                    req_data.windows(4).position(|w| w == b"\r\n\r\n")
                                {
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
                    let headers = String::from_utf8_lossy(&req_data[..pos]);
                    let capability = bearer_token(&headers);

                    if is_post {
                        let path = if let Some(p) =
                            String::from_utf8_lossy(&req_data).split_whitespace().nth(1)
                        {
                            p.to_string()
                        } else {
                            "/".to_string()
                        };

                        // Helper inline-format: produces an HTTP response string given status + body.
                        // Kept as a macro-like format so we don't have to plumb closures through async.
                        let auth_error = if path.starts_with("/files/") {
                            None
                        } else {
                            authenticate_agent_request(capability.as_deref(), body).err()
                        };

                        let route_to_response: (u16, String) = if let Some(error) = auth_error {
                            error
                        } else if path == "/export_file" {
                            match serde_json::from_slice::<ExportRequest>(body) {
                                Ok(req) => {
                                    let (response, status_code) =
                                        handle_export_request(app.clone(), req).await;
                                    (
                                        status_code,
                                        serde_json::to_string(&response).unwrap_or_default(),
                                    )
                                }
                                Err(_) => (
                                    400,
                                    r#"{"error":"Invalid export request body"}"#.to_string(),
                                ),
                            }
                        } else if path == "/request_attention" {
                            // Agent → user "please look at the browser" notification. Fire-and-forget:
                            // the agent doesn't block waiting for a click, just gets an ack. Used when
                            // the agent hits a step that needs visual confirmation (CAPTCHA, 2FA, etc.).
                            match serde_json::from_slice::<AttentionRequest>(body) {
                                Ok(req) => {
                                    handle_attention_request(app.clone(), req).await;
                                    (200, r#"{"status":"notified","message":"User has been notified."}"#.to_string())
                                }
                                Err(_) => (
                                    400,
                                    r#"{"error":"Invalid attention request body"}"#.to_string(),
                                ),
                            }
                        } else if path == "/spawn_genui" {
                            // Agent → user GenUI request. Spawns a native floating WebviewWindow
                            // to render a GenUI mini-app persistently on the desktop.
                            match serde_json::from_slice::<serde_json::Value>(body) {
                                Ok(req) => {
                                    use tauri::Emitter;
                                    let _ = app.emit("spawn_genui_window", req);
                                    (
                                        200,
                                        r#"{"status":"spawned","message":"GenUI window spawned."}"#
                                            .to_string(),
                                    )
                                }
                                Err(_) => {
                                    (400, r#"{"error":"Invalid GenUI request body"}"#.to_string())
                                }
                            }
                        } else if path == "/request_permission" {
                            // Agent → user permission elevation. Blocks waiting for a decision:
                            // once / session / forever / deny.
                            match serde_json::from_slice::<PermissionRequest>(body) {
                                Ok(req) => {
                                    let (response, status_code) =
                                        handle_permission_request(app.clone(), req).await;
                                    (
                                        status_code,
                                        serde_json::to_string(&response).unwrap_or_default(),
                                    )
                                }
                                Err(_) => (
                                    400,
                                    r#"{"error":"Invalid permission request body"}"#.to_string(),
                                ),
                            }
                        } else if path == "/files/list" {
                            match (
                                capability.as_deref(),
                                serde_json::from_slice::<crate::bridge::FilesListRequest>(body),
                            ) {
                                (Some(token), Ok(request)) => {
                                    use tauri::Manager;
                                    let db = app.state::<crate::db::Database>();
                                    files_broker_response(crate::bridge::broker_list(
                                        &db, token, request,
                                    ))
                                }
                                (None, _) => (
                                    401,
                                    r#"{"error":"Missing Files Bridge capability"}"#.to_string(),
                                ),
                                (_, Err(_)) => (
                                    400,
                                    r#"{"error":"Invalid Files Bridge list request"}"#.to_string(),
                                ),
                            }
                        } else if path == "/files/read" {
                            match (
                                capability.as_deref(),
                                serde_json::from_slice::<crate::bridge::FilesReadRequest>(body),
                            ) {
                                (Some(token), Ok(request)) => {
                                    use tauri::Manager;
                                    let db = app.state::<crate::db::Database>();
                                    files_broker_response(crate::bridge::broker_read(
                                        &db, token, request,
                                    ))
                                }
                                (None, _) => (
                                    401,
                                    r#"{"error":"Missing Files Bridge capability"}"#.to_string(),
                                ),
                                (_, Err(_)) => (
                                    400,
                                    r#"{"error":"Invalid Files Bridge read request"}"#.to_string(),
                                ),
                            }
                        } else if path == "/files/search" {
                            match (
                                capability.as_deref(),
                                serde_json::from_slice::<crate::bridge::FilesSearchRequest>(body),
                            ) {
                                (Some(token), Ok(request)) => {
                                    use tauri::Manager;
                                    let db = app.state::<crate::db::Database>();
                                    files_broker_response(crate::bridge::broker_search(
                                        &db, token, request,
                                    ))
                                }
                                (None, _) => (
                                    401,
                                    r#"{"error":"Missing Files Bridge capability"}"#.to_string(),
                                ),
                                (_, Err(_)) => (
                                    400,
                                    r#"{"error":"Invalid Files Bridge search request"}"#
                                        .to_string(),
                                ),
                            }
                        } else if path == "/" || path == "/request_credential" {
                            // Default = legacy JIT credential request (backwards-compat for agent
                            // code that POSTs to / without a specific path).
                            match serde_json::from_slice::<JitRequest>(body) {
                                Ok(req) => {
                                    let (response, status_code) =
                                        handle_jit_request(app.clone(), req).await;
                                    (
                                        status_code,
                                        serde_json::to_string(&response).unwrap_or_default(),
                                    )
                                }
                                Err(_) => (400, r#"{"error":"Invalid request body"}"#.to_string()),
                            }
                        } else {
                            (404, r#"{"error":"Unknown JIT bridge route"}"#.to_string())
                        };

                        let (status_code, resp_str) = route_to_response;
                        let http_resp = format!(
                            "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            status_code, resp_str.len(), resp_str
                        );
                        let _ = socket.write_all(http_resp.as_bytes()).await;
                    } else {
                        // This bridge is for container-to-host calls, never browser CORS.
                        let http_resp = "HTTP/1.1 405 Method Not Allowed\r\nAllow: POST\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        let _ = socket.write_all(http_resp.as_bytes()).await;
                    }
                }
            });
        }
    }
}

lazy_static::lazy_static! {
    pub static ref PENDING_EXPORTS: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>> = Arc::new(Mutex::new(HashMap::new()));
}

async fn handle_export_request(app: tauri::AppHandle, req: ExportRequest) -> (Value, u16) {
    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<bool>();

    {
        let mut pending = PENDING_EXPORTS.lock().await;
        pending.insert(req_id.clone(), tx);
    }

    // Decode content (assuming base64 if it's sent from the agent, otherwise raw string)
    // We'll try base64 first, fallback to raw bytes
    let content_bytes = match base64::engine::general_purpose::STANDARD.decode(&req.content) {
        Ok(b) => b,
        Err(_) => req.content.as_bytes().to_vec(),
    };

    let report = crate::security_scanner::analyze_file(&content_bytes, &req.filename).await;

    use tauri::Emitter;
    let _ = app.emit(
        "file_export_requested",
        json!({
            "request_id": req_id,
            "filename": req.filename,
            "agent_id": req.agent_id,
            "threat_report": report,
            "content": req.content, // Pass content so frontend can save it natively
        }),
    );

    let approved = rx.await.unwrap_or(false);

    if approved {
        (
            json!({"status": "saved", "message": "The user approved and saved the file."}),
            200,
        )
    } else {
        (
            json!({"status": "blocked", "message": "The user blocked the file export."}),
            403,
        )
    }
}

#[tauri::command]
pub async fn resolve_export_request(request_id: String, approved: bool) -> Result<(), String> {
    let mut pending = PENDING_EXPORTS.lock().await;
    if let Some(tx) = pending.remove(&request_id) {
        let _ = tx.send(approved);
    }
    Ok(())
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
            let mut agent = db
                .get_agent(&agent_id)
                .map_err(|e| format!("DB error: {}", e))?
                .ok_or_else(|| "Agent not found".to_string())?;

            if !agent.integrations.contains(&credential_id) {
                agent.integrations.push(credential_id.clone());
                db.update_agent(&agent)
                    .map_err(|e| format!("Failed to update agent: {}", e))?;

                // Sync openclaw.json so it applies permanently
                let _ = crate::openclaw::boot_sync_agents(app_handle.clone(), db.clone()).await;
            }
        } else {
            // Session or One-Time
            // Inject dynamically into container without saving to the DB profile
            crate::openclaw::inject_jit_credential(&db, &agent_id, &credential_id)
                .await
                .map_err(|e| e.to_string())?;

            if duration == "one_time" {
                // Spawn task to automatically revoke after 5 minutes
                let agent_id_clone = agent_id.clone();
                let cred_id_clone = credential_id.clone();
                let app_handle_clone = app_handle.clone();
                tokio::spawn(async move {
                    use tauri::Manager;
                    tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    let db_state = app_handle_clone.state::<crate::db::Database>();
                    let _ = crate::openclaw::revoke_jit_credential(
                        &*db_state,
                        &agent_id_clone,
                        &cred_id_clone,
                    )
                    .await;
                    tracing::info!(
                        "Auto-revoked one_time JIT credential {} for {}",
                        cred_id_clone,
                        agent_id_clone
                    );
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

// ─── Attention requests ───────────────────────────────────────────────────────
//
// Fire-and-forget notification from the agent to the user. The agent calls this when
// it needs the user to LOOK at its browser — to read a CAPTCHA, confirm a destructive
// action, observe a 2FA challenge, etc. The user gets a toast in the frontend and can
// click "Show browser" to bring that agent's Chrome on-screen and focus it.
//
// Unlike credential / permission requests this doesn't block — the agent gets an ack
// immediately and continues working (or polls the page state to see if the user has
// acted). Blocking would also block other agent activity and the user might take a
// while to respond.

async fn handle_attention_request(app: tauri::AppHandle, req: AttentionRequest) {
    use tauri::Emitter;
    let _ = app.emit(
        "agent_attention_requested",
        json!({
            "request_id":  uuid::Uuid::new_v4().to_string(),
            "agent_id":    req.agent_id,
            "reason":      req.reason,
            "requested_at": chrono::Utc::now().to_rfc3339(),
        }),
    );
}

// ─── Permission requests ──────────────────────────────────────────────────────
//
// Agent calls POST /request_permission with `permission_id` + `justification`. The host
// emits a Tauri event the frontend listens for; user picks one of:
//   - "once"    → grant for this specific request only; revoked after the agent's HTTP
//                 call returns (5-second window — enough to perform the next action).
//   - "session" → grant for the rest of the gateway session. Revoked at next gateway
//                 restart by `boot_sync_agents` re-reading SQLite as the source of truth.
//   - "forever" → persist to the agent's row in SQLite and propagate via boot_sync_agents.
//   - "deny"    → return 403 to the agent.
//
// Permission_id semantics:
//   - "browser", "vision", "canvas", "coding", ...   → `agent.capabilities.{id}`
//   - "gmail", "googleCalendar", "github", ...       → `agent.integrations` membership
//   - "domain:example.com"                           → add to per-agent allowlist
//
// The permanent path goes through the existing `update_agent_capabilities` /
// `update_agent_integrations` Tauri commands so all the standard sync_agent_skills +
// sync_credentials machinery runs.

lazy_static::lazy_static! {
    pub static ref PENDING_PERMISSION_REQUESTS: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>> =
        Arc::new(Mutex::new(HashMap::new()));
}

async fn handle_permission_request(app: tauri::AppHandle, req: PermissionRequest) -> (Value, u16) {
    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<String>();

    {
        let mut pending = PENDING_PERMISSION_REQUESTS.lock().await;
        pending.insert(req_id.clone(), tx);
    }

    use tauri::Emitter;
    let _ = app.emit(
        "agent_permission_requested",
        json!({
            "request_id":    req_id,
            "agent_id":      req.agent_id,
            "permission_id": req.permission_id,
            "justification": req.justification,
        }),
    );

    let decision = rx.await.unwrap_or_else(|_| "deny".to_string());

    match decision.as_str() {
        "deny" => (
            json!({
                "status":  "denied",
                "message": "The user denied this request. You do not have access."
            }),
            403,
        ),
        "once" | "session" | "forever" => (
            json!({
                "status":   "granted",
                "scope":    decision,
                "message":  format!(
                    "The user granted {} access ({}). You may proceed.",
                    req.permission_id, decision
                ),
            }),
            200,
        ),
        other => (
            json!({
                "status":  "error",
                "message": format!("Unknown decision scope: {}", other)
            }),
            500,
        ),
    }
}

/// Frontend resolves the agent's permission request with one of:
/// "once" | "session" | "forever" | "deny".
///
/// For "forever" the change is persisted via `update_agent_capabilities` /
/// `update_agent_integrations` so it survives a gateway restart. For "once" and
/// "session" the agent gets a one-shot grant message but no DB write happens — the
/// agent must use the granted permission immediately or re-request.
#[tauri::command]
pub async fn resolve_permission_request(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    request_id: String,
    decision: String,
    agent_id: String,
    permission_id: String,
) -> Result<(), String> {
    let scope = match decision.as_str() {
        "once" | "session" | "forever" | "deny" => decision.clone(),
        other => return Err(format!("Unknown decision: {}", other)),
    };

    if scope == "forever" {
        // Persist depending on permission shape:
        //  - "domain:foo.com"   → append to agent's allowlist
        //  - integration name   → append to agent.integrations + sync_agent_skills
        //  - capability name    → flip the matching field on agent.capabilities
        if let Some(domain) = permission_id.strip_prefix("domain:") {
            let mut current: Vec<String> =
                crate::browser_manager::get_agent_allowed_domains(agent_id.clone()).await?;
            let cleaned = domain.trim().to_lowercase();
            if !cleaned.is_empty() && !current.contains(&cleaned) {
                current.push(cleaned);
            }
            // Re-use the existing Tauri command. We need a tauri::State for it which we
            // get via app_handle.
            use tauri::Manager;
            let bm_state = app_handle.state::<crate::browser_manager::BrowserManager>();
            crate::browser_manager::update_agent_allowed_domains(
                app_handle.clone(),
                bm_state,
                agent_id.clone(),
                current,
            )
            .await?;
        } else if let Ok(Some(mut agent)) = db.get_agent(&agent_id) {
            let cap = permission_id.as_str();
            // Capability flips
            let mut handled = true;
            match cap {
                "browser" => agent.capabilities.browser = true,
                "proxy" => agent.capabilities.proxy = true,
                "vision" => agent.capabilities.vision = true,
                "canvas" => agent.capabilities.canvas = true,
                "coding" => agent.capabilities.coding = true,
                "gog" => agent.capabilities.gog = true,
                "summarize" => agent.capabilities.summarize = true,
                _ => {
                    handled = false;
                }
            }
            if !handled {
                // Treat as integration name.
                if !agent.integrations.contains(&permission_id) {
                    agent.integrations.push(permission_id.clone());
                }
            }
            db.update_agent(&agent)
                .map_err(|e| format!("DB error: {}", e))?;

            // Patch agents.list[i].skills via the existing helper so OpenClaw picks up
            // the new permission via hot-reload (no SIGTERM cascade).
            crate::openclaw::sync_agent_skills(app_handle.clone(), &agent).await;
        }
    }

    let mut pending = PENDING_PERMISSION_REQUESTS.lock().await;
    if let Some(tx) = pending.remove(&request_id) {
        let _ = tx.send(scope);
    }

    Ok(())
}

/// Pure ack route used by the frontend toast — no agent state to mutate, but we still
/// need a Tauri command surface so the frontend can call `request_user_attention`
/// programmatically (e.g. for testing the toast).
#[tauri::command]
pub async fn request_user_attention(
    app_handle: tauri::AppHandle,
    agent_id: String,
    reason: String,
) -> Result<(), String> {
    handle_attention_request(app_handle, AttentionRequest { agent_id, reason }).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_bridge_capability_is_read_from_authorization_header() {
        let headers = "POST /files/read HTTP/1.1\r\nAuthorization: Bearer agent-a:token\r\nContent-Type: application/json";
        assert_eq!(bearer_token(headers).as_deref(), Some("agent-a:token"));
    }

    #[test]
    fn unrelated_headers_do_not_authenticate_files_bridge() {
        let headers = "POST /files/read HTTP/1.1\r\nX-Agent-Id: agent-a";
        assert!(bearer_token(headers).is_none());
    }

    #[test]
    fn agent_bridge_requires_an_exact_capability() {
        assert!(presented_capability_matches(
            Some("canopy_jit_expected"),
            "canopy_jit_expected"
        ));
        assert!(!presented_capability_matches(
            Some("canopy_jit_wrong"),
            "canopy_jit_expected"
        ));
        assert!(!presented_capability_matches(
            None,
            "canopy_jit_expected"
        ));
    }

    #[test]
    fn agent_bridge_body_must_name_a_valid_agent() {
        assert_eq!(
            request_agent_id(br#"{"agent_id":"agent-alpha"}"#).as_deref(),
            Ok("agent-alpha")
        );
        assert!(request_agent_id(br#"{"agent_id":"../../other"}"#).is_err());
        assert!(request_agent_id(br#"{"reason":"missing"}"#).is_err());
        assert!(request_agent_id(b"not-json").is_err());
    }
}

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

/// Path-based export: `path` is relative to the agent's own workspace (or an absolute
/// container path inside it, e.g. `/home/node/.openclaw/workspace/<agent_id>/out.pdf`).
#[derive(Serialize, Deserialize, Debug)]
struct ExportWorkspaceFileRequest {
    agent_id: String,
    path: String,
    /// Optional suggested filename for the save dialog; defaults to the file's basename.
    #[serde(default)]
    filename: Option<String>,
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

#[derive(Serialize, Deserialize, Debug)]
struct WebSearchRequest {
    agent_id: String,
    query: String,
    #[serde(default)]
    num_results: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug)]
struct WebFetchRequest {
    agent_id: String,
    url: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct WebFetchAuthenticatedRequest {
    agent_id: String,
    url: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct WebResearchRequest {
    agent_id: String,
    topic: String,
    #[serde(default)]
    depth: Option<u8>,
}

#[derive(Serialize, Deserialize, Debug)]
struct WebConnectionTokenRequest {
    agent_id: String,
    provider_name: String,
    #[serde(default)]
    token_url: Option<String>,
    #[serde(default)]
    instructions: Option<String>,
    #[serde(default)]
    placeholder: Option<String>,
    #[serde(default)]
    secret_key: Option<String>,
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
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| (400, r#"{"error":"Invalid JSON request body"}"#.to_string()))?;
    let agent_id = value
        .get("agent_id")
        .and_then(Value::as_str)
        .ok_or_else(|| (400, r#"{"error":"agent_id is required"}"#.to_string()))?;
    crate::validators::agent::validate_id(agent_id)
        .map_err(|_| (400, r#"{"error":"Invalid agent_id"}"#.to_string()))?;
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

// ─── Request limits & timeouts ─────────────────────────────────────────────────

/// Max bytes of request line + headers.
const MAX_HEADER_BYTES: usize = 64 * 1024;
/// Default max body for every bridge route (JSON control messages).
const MAX_DEFAULT_BODY_BYTES: usize = 64 * 1024;
/// Largest file an agent may hand back to the user (either export route).
pub(crate) const MAX_EXPORT_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// `/export_file` carries the file base64-encoded inside JSON: 4/3 overhead plus
/// headroom for the JSON envelope / filename.
const MAX_EXPORT_BODY_BYTES: usize = (MAX_EXPORT_FILE_BYTES as usize).div_ceil(3) * 4 + 64 * 1024;
/// How many large-body uploads may be buffered at once (bounds host memory, since the
/// bridge listens before auth can be checked against the body).
const MAX_CONCURRENT_LARGE_BODIES: usize = 2;
/// A large upload must finish arriving within this window.
const BODY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// How long `/request_permission` waits for the user before answering "timed out".
pub(crate) const PERMISSION_REQUEST_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(5 * 60);
/// How long an export waits for the user to Save/Reject. Longer than permissions
/// because the user may be picking a destination in a native save dialog.
pub(crate) const EXPORT_REQUEST_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(10 * 60);
/// If the user's decision is already being applied when the timeout fires (e.g. a
/// "forever" grant running boot sync), wait this long for it rather than discarding it.
const DECISION_IN_FLIGHT_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

lazy_static::lazy_static! {
    static ref LARGE_BODY_SLOTS: Arc<tokio::sync::Semaphore> =
        Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_LARGE_BODIES));
}

fn max_body_bytes_for_path(path: &str) -> usize {
    match path {
        "/export_file" => MAX_EXPORT_BODY_BYTES,
        _ => MAX_DEFAULT_BODY_BYTES,
    }
}

fn json_http_response(status: u16, reason: &str, body: &Value) -> String {
    let body = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    )
}

fn payload_too_large_response(path: &str, limit: usize) -> String {
    json_http_response(
        413,
        "Payload Too Large",
        &json!({
            "error": format!("Request body exceeds the {} byte limit for {}", limit, path),
            "hint": "To hand a file to the user, write it to your workspace and POST \
                     {\"agent_id\":\"...\",\"path\":\"<workspace-relative path>\"} to \
                     /export_workspace_file — the host reads the file directly, so no \
                     file content goes in the request.",
        }),
    )
}

struct ParsedRequest {
    is_post: bool,
    path: String,
    headers: String,
    body: Vec<u8>,
    large_body_permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

enum ReadOutcome {
    Request(ParsedRequest),
    /// Reject before routing; the string is a complete HTTP response.
    Respond(String),
    Closed,
}

/// Read one HTTP/1.1 request, enforcing header and per-route body limits *before*
/// buffering the body (based on the declared Content-Length).
async fn read_http_request<S>(socket: &mut S) -> ReadOutcome
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; 64 * 1024];
    let mut data: Vec<u8> = Vec::new();

    let header_end = loop {
        match socket.read(&mut buf).await {
            Ok(0) | Err(_) => return ReadOutcome::Closed,
            Ok(n) => data.extend_from_slice(&buf[..n]),
        }
        if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if data.len() > MAX_HEADER_BYTES {
            return ReadOutcome::Respond(
                "HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string(),
            );
        }
    };

    let headers = String::from_utf8_lossy(&data[..header_end]).to_string();
    let mut request_line = headers.lines().next().unwrap_or("").split_whitespace();
    let method = request_line.next().unwrap_or("");
    let path = request_line.next().unwrap_or("/").to_string();
    let is_post = method == "POST";

    let mut content_length: usize = 0;
    let mut expects_continue = false;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            match value.parse::<usize>() {
                Ok(len) => content_length = len,
                Err(_) => {
                    return ReadOutcome::Respond(json_http_response(
                        400,
                        "Bad Request",
                        &json!({ "error": "Invalid Content-Length" }),
                    ))
                }
            }
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            && !value.eq_ignore_ascii_case("identity")
        {
            return ReadOutcome::Respond(json_http_response(
                411,
                "Length Required",
                &json!({ "error": "Chunked uploads are not supported; send a Content-Length" }),
            ));
        } else if name.eq_ignore_ascii_case("expect") && value.eq_ignore_ascii_case("100-continue")
        {
            expects_continue = true;
        }
    }

    if !is_post {
        return ReadOutcome::Request(ParsedRequest {
            is_post,
            path,
            headers,
            body: Vec::new(),
            large_body_permit: None,
        });
    }

    let limit = max_body_bytes_for_path(&path);
    if content_length > limit {
        return ReadOutcome::Respond(payload_too_large_response(&path, limit));
    }

    let large_body_permit = if content_length > MAX_DEFAULT_BODY_BYTES {
        match LARGE_BODY_SLOTS.clone().try_acquire_owned() {
            Ok(permit) => Some(permit),
            Err(_) => {
                return ReadOutcome::Respond(json_http_response(
                    503,
                    "Service Unavailable",
                    &json!({ "error": "Another large upload is in progress; retry shortly" }),
                ))
            }
        }
    } else {
        None
    };

    // curl sends `Expect: 100-continue` for larger bodies and otherwise stalls ~1s.
    if expects_continue {
        let _ = socket.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await;
    }

    let body_start = header_end + 4;
    let read_body = async {
        while data.len() - body_start < content_length {
            match socket.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => data.extend_from_slice(&buf[..n]),
            }
        }
    };
    if tokio::time::timeout(BODY_READ_TIMEOUT, read_body)
        .await
        .is_err()
    {
        return ReadOutcome::Respond(json_http_response(
            408,
            "Request Timeout",
            &json!({ "error": "Timed out waiting for the request body" }),
        ));
    }
    let body_end = (body_start + content_length).min(data.len());
    let body = data[body_start..body_end].to_vec();

    ReadOutcome::Request(ParsedRequest {
        is_post,
        path,
        headers,
        body,
        large_body_permit,
    })
}

/// Outcome of waiting for the user to answer a blocking bridge prompt.
#[derive(Debug, PartialEq, Eq)]
enum UserDecision<T> {
    Decided(T),
    /// The resolver dropped the sender without answering (treated as a denial).
    Dropped,
    /// Nobody answered within the timeout; the pending entry has been removed.
    TimedOut,
}

/// Wait up to `timeout` for the user's decision on `req_id`. On timeout the pending
/// entry is removed so a late UI click can't resolve a request the agent already gave
/// up on. If the resolver had already claimed the sender (decision in flight), wait a
/// short grace period for it instead of discarding a real answer.
async fn await_user_decision<T>(
    mut rx: oneshot::Receiver<T>,
    timeout: std::time::Duration,
    pending: &Mutex<HashMap<String, oneshot::Sender<T>>>,
    req_id: &str,
) -> UserDecision<T> {
    match tokio::time::timeout(timeout, &mut rx).await {
        Ok(Ok(value)) => return UserDecision::Decided(value),
        Ok(Err(_)) => return UserDecision::Dropped,
        Err(_) => {}
    }
    let still_pending = pending.lock().await.remove(req_id).is_some();
    if still_pending {
        return UserDecision::TimedOut;
    }
    match tokio::time::timeout(DECISION_IN_FLIGHT_GRACE, rx).await {
        Ok(Ok(value)) => UserDecision::Decided(value),
        Ok(Err(_)) => UserDecision::Dropped,
        Err(_) => UserDecision::TimedOut,
    }
}

pub async fn start_jit_server(app_handle: tauri::AppHandle) {
    let jit_addr = format!("0.0.0.0:{}", crate::flavor::flavor().jit_port);
    let listener = match TcpListener::bind(&jit_addr).await {
        Ok(listener) => listener,
        Err(e) => {
            // Don't abort the whole app if the port is already held (e.g. by
            // another running Canopy instance) — log and back off instead.
            // See GitHub issue #17.
            error!("Failed to bind JIT port {}: {}", jit_addr, e);
            crate::system_health::report_failed(
                "jit_server",
                format!("Agent authorization server couldn't start: {jit_addr} is unavailable ({e})"),
                "Is another copy of Canopy running? Quit it (or whatever holds that port) and relaunch.",
            );
            return;
        }
    };
    info!("JIT Provisioning server listening on {}", jit_addr);
    crate::system_health::report_ok("jit_server");

    loop {
        if let Ok((mut socket, _)) = listener.accept().await {
            let app = app_handle.clone();
            tokio::spawn(async move {
                let request = match read_http_request(&mut socket).await {
                    ReadOutcome::Request(request) => request,
                    ReadOutcome::Respond(response) => {
                        let _ = socket.write_all(response.as_bytes()).await;
                        return;
                    }
                    ReadOutcome::Closed => return,
                };
                // Held (when present) for the lifetime of a large-body request so a
                // handful of concurrent 50MB uploads can't exhaust host memory.
                let _large_body_permit = request.large_body_permit;
                {
                    let body = request.body.as_slice();
                    let headers = request.headers.as_str();
                    let capability = bearer_token(headers);

                    if request.is_post {
                        let path = request.path.clone();

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
                        } else if path == "/export_workspace_file" {
                            // Path-based export: the agent names a file in its own
                            // bind-mounted workspace and the host reads it directly — no
                            // file bytes cross the bridge, so size/argv limits don't apply.
                            match serde_json::from_slice::<ExportWorkspaceFileRequest>(body) {
                                Ok(req) => {
                                    let (response, status_code) =
                                        handle_export_workspace_file_request(app.clone(), req)
                                            .await;
                                    (
                                        status_code,
                                        serde_json::to_string(&response).unwrap_or_default(),
                                    )
                                }
                                Err(_) => (
                                    400,
                                    r#"{"error":"Invalid export request body — expected {\"agent_id\":\"...\",\"path\":\"<workspace-relative path>\"}"}"#
                                        .to_string(),
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
                        } else if path == "/web/search" {
                            match serde_json::from_slice::<WebSearchRequest>(body) {
                                Ok(req) => {
                                    let (response, status_code) =
                                        handle_web_search_request(app.clone(), req).await;
                                    (
                                        status_code,
                                        serde_json::to_string(&response).unwrap_or_default(),
                                    )
                                }
                                Err(_) => (
                                    400,
                                    r#"{"error":"Invalid web search request body"}"#.to_string(),
                                ),
                            }
                        } else if path == "/web/fetch" {
                            match serde_json::from_slice::<WebFetchRequest>(body) {
                                Ok(req) => {
                                    let (response, status_code) =
                                        handle_web_fetch_request(app.clone(), req).await;
                                    (
                                        status_code,
                                        serde_json::to_string(&response).unwrap_or_default(),
                                    )
                                }
                                Err(_) => (
                                    400,
                                    r#"{"error":"Invalid web fetch request body"}"#.to_string(),
                                ),
                            }
                        } else if path == "/web/fetch_authenticated" {
                            match serde_json::from_slice::<WebFetchAuthenticatedRequest>(body) {
                                Ok(req) => {
                                    let (response, status_code) =
                                        handle_web_fetch_authenticated_request(app.clone(), req)
                                            .await;
                                    (
                                        status_code,
                                        serde_json::to_string(&response).unwrap_or_default(),
                                    )
                                }
                                Err(_) => (
                                    400,
                                    r#"{"error":"Invalid authenticated web fetch request body"}"#
                                        .to_string(),
                                ),
                            }
                        } else if path == "/web/research" {
                            match serde_json::from_slice::<WebResearchRequest>(body) {
                                Ok(req) => {
                                    let (response, status_code) =
                                        handle_web_research_request(app.clone(), req).await;
                                    (
                                        status_code,
                                        serde_json::to_string(&response).unwrap_or_default(),
                                    )
                                }
                                Err(_) => (
                                    400,
                                    r#"{"error":"Invalid web research request body"}"#.to_string(),
                                ),
                            }
                        } else if path == "/generate_web_connection_token" {
                            // Agent -> user provider-key request, delivered as a web link instead
                            // of a canopy:// deep link — used when the agent knows it's replying
                            // over Slack, where the desktop app is often unreachable from mobile.
                            match serde_json::from_slice::<WebConnectionTokenRequest>(body) {
                                Ok(req) => {
                                    let (response, status_code) =
                                        handle_generate_web_connection_token_request(
                                            app.clone(),
                                            req,
                                        )
                                        .await;
                                    (
                                        status_code,
                                        serde_json::to_string(&response).unwrap_or_default(),
                                    )
                                }
                                Err(_) => (
                                    400,
                                    r#"{"error":"Invalid web connection token request body"}"#
                                        .to_string(),
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
    // Content is base64 when the agent followed the docs; fall back to raw text.
    let content_bytes = match base64::engine::general_purpose::STANDARD.decode(&req.content) {
        Ok(b) => b,
        Err(_) => req.content.into_bytes(),
    };
    if content_bytes.len() as u64 > MAX_EXPORT_FILE_BYTES {
        return (
            json!({ "error": format!("File exceeds the {} byte export limit", MAX_EXPORT_FILE_BYTES) }),
            413,
        );
    }
    let filename = sanitize_export_filename(&req.filename, "export");
    deliver_export_to_user(app, req.agent_id, filename, content_bytes).await
}

/// Agent-scoped, path-based export. Resolves `req.path` inside the agent's own
/// bind-mounted workspace on the host (rejecting traversal, absolute paths outside the
/// workspace, symlink escapes, hardlinks and the private `.canopy/` dir), then hands the
/// bytes to the same user-approval flow as `/export_file`.
async fn handle_export_workspace_file_request(
    app: tauri::AppHandle,
    req: ExportWorkspaceFileRequest,
) -> (Value, u16) {
    let (filename, bytes) = {
        use tauri::Manager;
        let db = app.state::<crate::db::Database>();
        match db.get_agent(&req.agent_id) {
            Ok(Some(_)) => {}
            Ok(None) => return (json!({ "error": "agent not found" }), 404),
            Err(e) => return (json!({ "error": format!("db error: {e}") }), 500),
        }
        let workspace = match crate::openclaw::get_agent_workspace_dir(&db, &req.agent_id) {
            Ok(path) => path,
            Err(e) => {
                return (
                    json!({ "error": format!("workspace unavailable: {e}") }),
                    500,
                )
            }
        };
        let (resolved, bytes) =
            match read_agent_workspace_file(&workspace, &req.agent_id, &req.path) {
                Ok(found) => found,
                Err((status, message)) => return (json!({ "error": message }), status),
            };
        let fallback = resolved
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "export".to_string());
        let filename =
            sanitize_export_filename(req.filename.as_deref().unwrap_or(&fallback), &fallback);
        let _ = db.log_audit(
            &req.agent_id,
            "file_export_requested",
            None,
            &format!(
                "Workspace file export requested: {} ({} bytes)",
                req.path,
                bytes.len()
            ),
            None,
        );
        (filename, bytes)
    };
    deliver_export_to_user(app, req.agent_id, filename, bytes).await
}

/// Keep only the final path component and drop control characters, so the save
/// dialog's suggested name can't point somewhere unexpected.
fn sanitize_export_filename(requested: &str, fallback: &str) -> String {
    let last = requested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    let trimmed = last.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Container-side mount point of the workspace volume (see docker.rs compose volumes).
const CONTAINER_WORKSPACE_ROOT: &str = "/home/node/.openclaw/workspace";

/// Map an agent-supplied path to a path relative to that agent's workspace. Relative
/// paths pass through; absolute paths are only accepted when they are inside this
/// agent's own container workspace.
fn workspace_relative_path(agent_id: &str, requested: &str) -> Result<String, String> {
    let requested = requested.trim();
    let requested = requested.strip_prefix("file://").unwrap_or(requested);
    if requested.is_empty() {
        return Err("A workspace-relative file path is required".to_string());
    }
    if requested.contains('\0') {
        return Err("Invalid path".to_string());
    }
    if !requested.starts_with('/') {
        return Ok(requested.to_string());
    }
    for root in [CONTAINER_WORKSPACE_ROOT, "/workspace"] {
        let prefix = format!("{}/{}/", root, agent_id);
        if let Some(rest) = requested.strip_prefix(&prefix) {
            return Ok(rest.to_string());
        }
    }
    Err(format!(
        "Absolute paths must be inside your own workspace ({}/{}/...). Pass a path relative to your workspace instead.",
        CONTAINER_WORKSPACE_ROOT, agent_id
    ))
}

fn is_private_workspace_component(component: std::path::Component<'_>) -> bool {
    matches!(component, std::path::Component::Normal(name) if name == ".canopy")
}

/// Resolve `requested` to an existing regular file strictly inside `workspace_root`.
pub(crate) fn resolve_agent_workspace_file(
    workspace_root: &std::path::Path,
    agent_id: &str,
    requested: &str,
) -> Result<std::path::PathBuf, (u16, String)> {
    use std::path::{Component, Path};
    let relative = workspace_relative_path(agent_id, requested).map_err(|e| (400, e))?;
    let relative_path = Path::new(&relative);
    if relative_path.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err((400, "Path cannot leave your workspace".to_string()));
    }
    if relative_path
        .components()
        .any(is_private_workspace_component)
    {
        return Err((403, "Files under .canopy/ cannot be exported".to_string()));
    }

    let canonical_root = std::fs::canonicalize(workspace_root).map_err(|_| {
        (
            500,
            "Agent workspace is unavailable on the host".to_string(),
        )
    })?;
    let candidate = std::fs::canonicalize(canonical_root.join(relative_path)).map_err(|_| {
        (
            404,
            format!(
                "No file at '{}' in your workspace. Paths are relative to your workspace root.",
                relative
            ),
        )
    })?;
    // canonicalize resolved every symlink, so this also rejects symlink escapes.
    let inside = candidate
        .strip_prefix(&canonical_root)
        .map_err(|_| (403, "Path resolves outside your workspace".to_string()))?;
    if inside.components().any(is_private_workspace_component) {
        return Err((403, "Files under .canopy/ cannot be exported".to_string()));
    }
    let metadata =
        std::fs::metadata(&candidate).map_err(|_| (404, "File is not readable".to_string()))?;
    if !metadata.is_file() {
        return Err((400, "Export target is not a regular file".to_string()));
    }
    Ok(candidate)
}

/// Resolve and read a workspace file, re-verifying after open that the handle is the
/// same inode that passed containment (guards against a path swap between the check
/// and the read) and that it isn't a hardlink to something outside the workspace.
fn read_agent_workspace_file(
    workspace_root: &std::path::Path,
    agent_id: &str,
    requested: &str,
) -> Result<(std::path::PathBuf, Vec<u8>), (u16, String)> {
    use std::io::Read;
    let resolved = resolve_agent_workspace_file(workspace_root, agent_id, requested)?;
    let checked = std::fs::symlink_metadata(&resolved)
        .map_err(|_| (404, "File is not readable".to_string()))?;
    let file =
        std::fs::File::open(&resolved).map_err(|_| (404, "File is not readable".to_string()))?;
    let opened = file
        .metadata()
        .map_err(|_| (404, "File is not readable".to_string()))?;
    if !opened.is_file() || checked.file_type().is_symlink() {
        return Err((400, "Export target is not a regular file".to_string()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != checked.dev() || opened.ino() != checked.ino() {
            return Err((
                409,
                "File changed while it was being exported; retry".to_string(),
            ));
        }
        if opened.nlink() > 1 {
            return Err((
                403,
                "Hard-linked files cannot be exported; copy the file to a new name first"
                    .to_string(),
            ));
        }
    }
    if opened.len() > MAX_EXPORT_FILE_BYTES {
        return Err((
            413,
            format!(
                "File exceeds the {} byte export limit",
                MAX_EXPORT_FILE_BYTES
            ),
        ));
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(MAX_EXPORT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| (500, "Failed to read file".to_string()))?;
    if bytes.len() as u64 > MAX_EXPORT_FILE_BYTES {
        return Err((
            413,
            format!(
                "File exceeds the {} byte export limit",
                MAX_EXPORT_FILE_BYTES
            ),
        ));
    }
    Ok((resolved, bytes))
}

/// Scan the bytes, show the user the export modal, and wait (bounded) for Save/Reject.
async fn deliver_export_to_user(
    app: tauri::AppHandle,
    agent_id: String,
    filename: String,
    content_bytes: Vec<u8>,
) -> (Value, u16) {
    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<bool>();

    {
        let mut pending = PENDING_EXPORTS.lock().await;
        pending.insert(req_id.clone(), tx);
    }

    let report = crate::security_scanner::analyze_file(&content_bytes, &filename).await;
    let size_bytes = content_bytes.len();
    let content = base64::engine::general_purpose::STANDARD.encode(&content_bytes);
    drop(content_bytes);

    use tauri::Emitter;
    let _ = app.emit(
        "file_export_requested",
        json!({
            "request_id": req_id,
            "filename": filename,
            "agent_id": agent_id,
            "threat_report": report,
            "size_bytes": size_bytes,
            "content": content, // base64; the frontend decodes and saves it natively
        }),
    );

    match await_user_decision(rx, EXPORT_REQUEST_TIMEOUT, &PENDING_EXPORTS, &req_id).await {
        UserDecision::Decided(true) => (
            json!({"status": "saved", "message": "The user approved and saved the file."}),
            200,
        ),
        UserDecision::Decided(false) | UserDecision::Dropped => (
            json!({"status": "blocked", "message": "The user blocked the file export."}),
            403,
        ),
        UserDecision::TimedOut => {
            let _ = app.emit(
                "file_export_request_expired",
                json!({ "request_id": req_id, "agent_id": agent_id }),
            );
            (
                json!({
                    "status": "timed_out",
                    "message": format!(
                        "The user did not respond to the export prompt within {} minutes, so the file was NOT saved. It is still in your workspace; tell the user its workspace path and offer to export it again.",
                        EXPORT_REQUEST_TIMEOUT.as_secs() / 60
                    ),
                }),
                408,
            )
        }
    }
}

/// UI-initiated export of a file an agent referenced in chat (e.g. an OpenClaw
/// `MEDIA:` line pointing at a container path). Maps the container path to the agent's
/// host workspace with the same containment checks as the bridge route, then shows the
/// standard export modal. Returns once the prompt is shown.
#[tauri::command]
pub async fn export_agent_workspace_file(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    path: String,
) -> Result<(), String> {
    crate::validators::agent::validate_id(&agent_id).map_err(|e| e.to_string())?;
    let workspace = crate::openclaw::get_agent_workspace_dir(&db, &agent_id)?;
    let (resolved, bytes) =
        read_agent_workspace_file(&workspace, &agent_id, &path).map_err(|(_, message)| message)?;
    let fallback = resolved
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "export".to_string());
    let filename = sanitize_export_filename(&fallback, "export");
    tokio::spawn(async move {
        let _ = deliver_export_to_user(app_handle, agent_id, filename, bytes).await;
    });
    Ok(())
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

    let decision = match await_user_decision(
        rx,
        PERMISSION_REQUEST_TIMEOUT,
        &PENDING_PERMISSION_REQUESTS,
        &req_id,
    )
    .await
    {
        UserDecision::Decided(decision) => decision,
        UserDecision::Dropped => "deny".to_string(),
        UserDecision::TimedOut => {
            let _ = app.emit(
                "agent_permission_request_expired",
                json!({ "request_id": req_id, "agent_id": req.agent_id }),
            );
            return permission_timed_out_response(&req.permission_id);
        }
    };

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

// ─── Web tools (search / fetch / research) ─────────────────────────────────────
//
// Agent-callable via curl + the JIT bridge token, same shape as request_permission /
// request_attention above. These are separate from OpenClaw's own built-in `browser`/
// `gog` skills — see web_tools.rs for why. Each route independently re-checks the
// agent's capability flags (never trust that PERMISSIONS.md alone kept the agent from
// asking anyway).

async fn handle_web_search_request(app: tauri::AppHandle, req: WebSearchRequest) -> (Value, u16) {
    use tauri::Manager;
    let db = app.state::<crate::db::Database>();
    let agent = match db.get_agent(&req.agent_id) {
        Ok(Some(a)) => a,
        Ok(None) => return (json!({ "error": "agent not found" }), 404),
        Err(e) => return (json!({ "error": format!("db error: {e}") }), 500),
    };
    if !agent.capabilities.web_search {
        return (
            json!({ "error": "web_search capability is not enabled for this agent" }),
            403,
        );
    }
    match crate::web_tools::web_search_impl(&req.query, req.num_results.unwrap_or(10)).await {
        Ok(results) => (json!({ "results": results }), 200),
        Err(e) => (json!({ "error": e }), 502),
    }
}

async fn handle_web_fetch_request(app: tauri::AppHandle, req: WebFetchRequest) -> (Value, u16) {
    use tauri::Manager;
    let db = app.state::<crate::db::Database>();
    let agent = match db.get_agent(&req.agent_id) {
        Ok(Some(a)) => a,
        Ok(None) => return (json!({ "error": "agent not found" }), 404),
        Err(e) => return (json!({ "error": format!("db error: {e}") }), 500),
    };
    if !agent.capabilities.web_browse {
        return (
            json!({ "error": "web_browse capability is not enabled for this agent" }),
            403,
        );
    }
    let browser_manager = app.state::<crate::browser_manager::BrowserManager>();
    match crate::web_tools::fetch_page_impl(&app, &browser_manager, &agent, true, &req.url).await {
        Ok(page) => (
            serde_json::to_value(page).unwrap_or_else(|_| json!({})),
            200,
        ),
        Err(e) => (json!({ "error": e }), 502),
    }
}

async fn handle_web_research_request(
    app: tauri::AppHandle,
    req: WebResearchRequest,
) -> (Value, u16) {
    use tauri::Manager;
    let db = app.state::<crate::db::Database>();
    let agent = match db.get_agent(&req.agent_id) {
        Ok(Some(a)) => a,
        Ok(None) => return (json!({ "error": "agent not found" }), 404),
        Err(e) => return (json!({ "error": format!("db error: {e}") }), 500),
    };
    if !agent.capabilities.web_search {
        return (
            json!({ "error": "web_search capability is not enabled for this agent" }),
            403,
        );
    }
    let browser_manager = app.state::<crate::browser_manager::BrowserManager>();
    let can_browse = agent.capabilities.web_browse;
    match crate::web_tools::research_impl(
        &app,
        &browser_manager,
        &agent,
        can_browse,
        &req.topic,
        req.depth.unwrap_or(1),
    )
    .await
    {
        Ok(packet) => (
            serde_json::to_value(packet).unwrap_or_else(|_| json!({})),
            200,
        ),
        Err(e) => (json!({ "error": e }), 502),
    }
}

async fn handle_web_fetch_authenticated_request(
    app: tauri::AppHandle,
    req: WebFetchAuthenticatedRequest,
) -> (Value, u16) {
    use tauri::Manager;
    let db = app.state::<crate::db::Database>();
    let agent = match db.get_agent(&req.agent_id) {
        Ok(Some(a)) => a,
        Ok(None) => return (json!({ "error": "agent not found" }), 404),
        Err(e) => return (json!({ "error": format!("db error: {e}") }), 500),
    };
    if !agent.capabilities.web_auth {
        return (
            json!({ "error": "web_auth capability is not enabled for this agent" }),
            403,
        );
    }
    match crate::web_tools::fetch_authenticated_page_impl(&req.url, &req.agent_id).await {
        Ok(page) => (
            serde_json::to_value(page).unwrap_or_else(|_| json!({})),
            200,
        ),
        Err(e) => (json!({ "error": e }), 502),
    }
}

async fn handle_generate_web_connection_token_request(
    app: tauri::AppHandle,
    req: WebConnectionTokenRequest,
) -> (Value, u16) {
    use tauri::Manager;
    let db = app.state::<crate::db::Database>();
    if !matches!(db.get_agent(&req.agent_id), Ok(Some(_))) {
        return (json!({ "error": "agent not found" }), 404);
    }
    match crate::web_connections::generate_web_connection_token_impl(
        &db,
        &req.agent_id,
        &req.provider_name,
        req.token_url,
        req.instructions,
        req.placeholder,
        req.secret_key,
    )
    .await
    {
        Ok(token) => (
            json!({ "url": token.url, "token": token.token, "expiresAt": token.expires_at }),
            200,
        ),
        Err(e) => (json!({ "error": e }), 502),
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

    // Claim the waiting agent request *before* applying any grant. If it already timed
    // out (the agent was told "not granted"), don't persist a grant it will never use.
    // Holding the sender also stops the timeout from racing us while "forever" persists.
    let tx = PENDING_PERMISSION_REQUESTS.lock().await.remove(&request_id);
    let Some(tx) = tx else {
        return Err(
            "This permission request expired before you answered, so nothing was granted. \
             The agent can ask again if it still needs access."
                .to_string(),
        );
    };

    // Tier 4 authenticated-fetch consent — handled for every scope (not just "forever"):
    // "once"/"session" grant a temporary, in-memory pass; "forever" additionally persists
    // to the agent's approved-domains file so it survives a restart. Unlike "domain:"
    // above (the browser CDP allowlist), no cookies are ever touched until this resolves.
    if scope != "deny" {
        if let Some(domain) = permission_id.strip_prefix("webauth:") {
            let cleaned = domain.trim().to_lowercase();
            if !cleaned.is_empty() {
                if scope == "forever" {
                    crate::web_tools::approve_web_auth_domain_forever(&agent_id, &cleaned)?;
                } else {
                    crate::web_tools::grant_temporary_web_auth(&agent_id, &cleaned);
                }
            }
        }
    }

    if scope == "forever" {
        // Persist depending on permission shape:
        //  - "domain:foo.com"   → append to agent's allowlist
        //  - "webauth:foo.com"  → handled above (every scope, not just forever)
        //  - integration name   → append to agent.integrations + sync_agent_skills
        //  - capability name    → flip the matching field on agent.capabilities
        if permission_id.starts_with("webauth:") {
            // Already persisted above — nothing further to do for this permission shape.
        } else if let Some(domain) = permission_id.strip_prefix("domain:") {
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
                "web_search" => agent.capabilities.web_search = true,
                "web_browse" => agent.capabilities.web_browse = true,
                "web_auth" => agent.capabilities.web_auth = true,
                "web_sandbox_browser" => agent.capabilities.web_sandbox_browser = true,
                "browser_control" => agent.capabilities.browser_control = true,
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

    let _ = tx.send(scope);

    Ok(())
}

fn permission_timed_out_response(permission_id: &str) -> (Value, u16) {
    (
        json!({
            "status":  "timed_out",
            "granted": false,
            "message": format!(
                "The user did not respond to your request for '{}' within {} minutes, so it was NOT granted (treat this as denied). Do not retry in a loop; continue without it or tell the user what you need and why.",
                permission_id,
                PERMISSION_REQUEST_TIMEOUT.as_secs() / 60
            ),
        }),
        408,
    )
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
        assert!(!presented_capability_matches(None, "canopy_jit_expected"));
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

    // ─── Body limits ────────────────────────────────────────────────────────────

    async fn send_raw(request: Vec<u8>) -> (ReadOutcome, Vec<u8>) {
        let (mut client, mut server) = tokio::io::duplex(256 * 1024);
        let writer = tokio::spawn(async move {
            let _ = client.write_all(&request).await;
            let _ = client.shutdown().await;
            let mut echoed = Vec::new();
            let _ = client.read_to_end(&mut echoed).await;
            echoed
        });
        let outcome = read_http_request(&mut server).await;
        drop(server);
        let echoed = writer.await.unwrap();
        (outcome, echoed)
    }

    fn post(path: &str, body: &[u8], extra_headers: &str) -> Vec<u8> {
        let mut request = format!(
            "POST {} HTTP/1.1\r\nHost: host.docker.internal\r\nContent-Length: {}\r\n{}\r\n",
            path,
            body.len(),
            extra_headers
        )
        .into_bytes();
        request.extend_from_slice(body);
        request
    }

    #[test]
    fn export_route_allows_document_sized_bodies_and_others_stay_small() {
        // A 50MB file base64-encoded inside JSON must fit.
        let encoded_50mb = (MAX_EXPORT_FILE_BYTES as usize).div_ceil(3) * 4;
        assert!(max_body_bytes_for_path("/export_file") >= encoded_50mb + 1024);
        assert_eq!(max_body_bytes_for_path("/request_permission"), 64 * 1024);
        assert_eq!(max_body_bytes_for_path("/export_workspace_file"), 64 * 1024);
        assert_eq!(max_body_bytes_for_path("/export_file/../x"), 64 * 1024);
    }

    #[tokio::test]
    async fn reads_a_body_larger_than_the_old_64kb_cap_on_export() {
        // ~266KB PDF base64'd — the size that 413'd in the 2026-08-26 CUJ.
        let body = vec![b'a'; 360 * 1024];
        let (outcome, _) = send_raw(post("/export_file", &body, "")).await;
        match outcome {
            ReadOutcome::Request(request) => {
                assert!(request.is_post);
                assert_eq!(request.path, "/export_file");
                assert_eq!(request.body.len(), body.len());
                assert!(request.large_body_permit.is_some());
            }
            _ => panic!("expected a parsed request"),
        }
    }

    #[tokio::test]
    async fn rejects_oversized_declared_length_before_reading_body() {
        // Declares a huge length but sends no body: must 413 immediately, not buffer.
        let request = format!(
            "POST /export_file HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_EXPORT_BODY_BYTES + 1
        );
        match send_raw(request.into_bytes()).await.0 {
            ReadOutcome::Respond(response) => {
                assert!(response.starts_with("HTTP/1.1 413"));
                assert!(response.contains("/export_workspace_file"));
            }
            _ => panic!("expected a 413"),
        }
        let body = vec![b'a'; 64 * 1024 + 1];
        match send_raw(post("/request_permission", &body, "")).await.0 {
            ReadOutcome::Respond(response) => assert!(response.starts_with("HTTP/1.1 413")),
            _ => panic!("expected a 413 for a non-export route"),
        }
    }

    #[tokio::test]
    async fn rejects_chunked_uploads_and_bad_lengths() {
        let chunked =
            b"POST /export_file HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".to_vec();
        match send_raw(chunked).await.0 {
            ReadOutcome::Respond(response) => assert!(response.starts_with("HTTP/1.1 411")),
            _ => panic!("expected 411"),
        }
        let bad = b"POST /export_file HTTP/1.1\r\nContent-Length: -5\r\n\r\n".to_vec();
        match send_raw(bad).await.0 {
            ReadOutcome::Respond(response) => assert!(response.starts_with("HTTP/1.1 400")),
            _ => panic!("expected 400"),
        }
    }

    #[tokio::test]
    async fn answers_expect_continue() {
        let body = br#"{"agent_id":"agent-a"}"#;
        let (outcome, echoed) =
            send_raw(post("/request_attention", body, "Expect: 100-continue\r\n")).await;
        assert!(matches!(outcome, ReadOutcome::Request(_)));
        assert!(String::from_utf8_lossy(&echoed).starts_with("HTTP/1.1 100 Continue"));
    }

    // ─── Timeouts ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn unanswered_decision_times_out_and_clears_pending_state() {
        let pending: Mutex<HashMap<String, oneshot::Sender<String>>> = Mutex::new(HashMap::new());
        let (tx, rx) = oneshot::channel::<String>();
        pending.lock().await.insert("req-1".to_string(), tx);
        let outcome =
            await_user_decision(rx, std::time::Duration::from_millis(20), &pending, "req-1").await;
        assert_eq!(outcome, UserDecision::TimedOut);
        assert!(
            pending.lock().await.is_empty(),
            "stale request must be removed"
        );
    }

    #[tokio::test]
    async fn answered_decision_is_returned() {
        let pending: Mutex<HashMap<String, oneshot::Sender<String>>> = Mutex::new(HashMap::new());
        let (tx, rx) = oneshot::channel::<String>();
        pending.lock().await.insert("req-2".to_string(), tx);
        let sender = pending.lock().await.remove("req-2").unwrap();
        sender.send("once".to_string()).unwrap();
        let outcome =
            await_user_decision(rx, std::time::Duration::from_secs(5), &pending, "req-2").await;
        assert_eq!(outcome, UserDecision::Decided("once".to_string()));
    }

    #[tokio::test]
    async fn decision_in_flight_at_timeout_is_not_discarded() {
        let pending: Mutex<HashMap<String, oneshot::Sender<String>>> = Mutex::new(HashMap::new());
        let (tx, rx) = oneshot::channel::<String>();
        // Resolver already claimed the sender (e.g. persisting a "forever" grant)...
        let claimed = tx;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = claimed.send("forever".to_string());
        });
        let outcome =
            await_user_decision(rx, std::time::Duration::from_millis(10), &pending, "req-3").await;
        assert_eq!(outcome, UserDecision::Decided("forever".to_string()));
    }

    #[test]
    fn timeout_response_is_agent_readable_and_not_a_grant() {
        let (body, status) = permission_timed_out_response("browser");
        assert_eq!(status, 408);
        assert_eq!(body["status"], "timed_out");
        assert_eq!(body["granted"], false);
        assert!(body["message"].as_str().unwrap().contains("NOT granted"));
        assert!(PERMISSION_REQUEST_TIMEOUT >= std::time::Duration::from_secs(60));
    }

    // ─── Workspace path containment ─────────────────────────────────────────────

    fn workspace_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace").join("agent-a");
        std::fs::create_dir_all(workspace.join("reports")).unwrap();
        std::fs::create_dir_all(workspace.join(".canopy")).unwrap();
        std::fs::write(workspace.join("reports/boots.pdf"), b"%PDF-1.7 test").unwrap();
        std::fs::write(workspace.join(".canopy/jit-bridge-token"), b"secret").unwrap();
        std::fs::write(tmp.path().join("outside.txt"), b"host secret").unwrap();
        let sibling = tmp.path().join("workspace").join("agent-b");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(sibling.join("theirs.txt"), b"other agent").unwrap();
        (tmp, workspace)
    }

    #[test]
    fn resolves_relative_and_container_absolute_paths() {
        let (_tmp, ws) = workspace_fixture();
        let expected = std::fs::canonicalize(ws.join("reports/boots.pdf")).unwrap();
        for path in [
            "reports/boots.pdf",
            "./reports/boots.pdf",
            "/home/node/.openclaw/workspace/agent-a/reports/boots.pdf",
            "file:///home/node/.openclaw/workspace/agent-a/reports/boots.pdf",
            "/workspace/agent-a/reports/boots.pdf",
        ] {
            assert_eq!(
                resolve_agent_workspace_file(&ws, "agent-a", path).unwrap(),
                expected,
                "{path}"
            );
        }
        let (resolved, bytes) =
            read_agent_workspace_file(&ws, "agent-a", "reports/boots.pdf").unwrap();
        assert_eq!(resolved, expected);
        assert_eq!(bytes, b"%PDF-1.7 test");
    }

    #[test]
    fn rejects_traversal_and_foreign_absolute_paths() {
        let (_tmp, ws) = workspace_fixture();
        for path in [
            "",
            "../outside.txt",
            "reports/../../outside.txt",
            "../agent-b/theirs.txt",
            "/etc/passwd",
            "/home/node/.openclaw/workspace/agent-b/theirs.txt",
            "/home/node/.openclaw/workspace/agent-a/../agent-b/theirs.txt",
            "/home/node/.openclaw/openclaw.json",
            "reports",
            "missing.pdf",
            "reports/boots.pdf\0",
        ] {
            assert!(
                resolve_agent_workspace_file(&ws, "agent-a", path).is_err(),
                "{path:?} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_private_canopy_dir() {
        let (_tmp, ws) = workspace_fixture();
        assert!(resolve_agent_workspace_file(&ws, "agent-a", ".canopy/jit-bridge-token").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(ws.join(".canopy/jit-bridge-token"), ws.join("token-link"))
                .unwrap();
            assert!(resolve_agent_workspace_file(&ws, "agent-a", "token-link").is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes_and_hardlinks() {
        let (tmp, ws) = workspace_fixture();
        std::os::unix::fs::symlink(tmp.path().join("outside.txt"), ws.join("escape.txt")).unwrap();
        std::os::unix::fs::symlink(tmp.path(), ws.join("escape-dir")).unwrap();
        assert!(resolve_agent_workspace_file(&ws, "agent-a", "escape.txt").is_err());
        assert!(resolve_agent_workspace_file(&ws, "agent-a", "escape-dir/outside.txt").is_err());

        std::fs::hard_link(tmp.path().join("outside.txt"), ws.join("hard.txt")).unwrap();
        assert_eq!(
            read_agent_workspace_file(&ws, "agent-a", "hard.txt")
                .unwrap_err()
                .0,
            403
        );

        // An in-workspace symlink to an in-workspace file is fine.
        std::os::unix::fs::symlink(ws.join("reports/boots.pdf"), ws.join("latest.pdf")).unwrap();
        assert!(read_agent_workspace_file(&ws, "agent-a", "latest.pdf").is_ok());
    }

    #[test]
    fn export_filename_is_reduced_to_a_basename() {
        assert_eq!(sanitize_export_filename("../../evil.pdf", "x"), "evil.pdf");
        assert_eq!(sanitize_export_filename("a\\b\\c.txt", "x"), "c.txt");
        assert_eq!(
            sanitize_export_filename("..", "fallback.pdf"),
            "fallback.pdf"
        );
        assert_eq!(
            sanitize_export_filename("  ", "fallback.pdf"),
            "fallback.pdf"
        );
        assert_eq!(sanitize_export_filename("re\nport.pdf", "x"), "report.pdf");
    }
}

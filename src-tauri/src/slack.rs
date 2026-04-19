use crate::db::Database;
use crate::keychain;
use crate::models::{Bridge, BridgeConfig, BridgePermissions, BridgeType};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tauri::State;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

const SLACK_API_BASE: &str = "https://slack.com/api";

// ============================================================================
// Data Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackChannel {
    pub id: String,
    pub name: String,
    pub is_private: bool,
    pub member_count: u32,
    pub topic: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackMessage {
    pub ts: String,
    pub channel_id: String,
    pub user: String,
    pub text: String,
    pub thread_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackConnectionStatus {
    pub connected: bool,
    pub workspace_name: Option<String>,
    pub bot_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OAuthTokenResponse {
    ok: bool,
    access_token: Option<String>,
    bot_user_id: Option<String>,
    app_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AuthTestResponse {
    ok: bool,
    url: Option<String>,
    team: Option<String>,
    user: Option<String>,
    team_id: Option<String>,
    user_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ConversationsListResponse {
    ok: bool,
    channels: Option<Vec<ConversationInfo>>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ConversationInfo {
    id: String,
    name: String,
    is_private: bool,
    num_members: u32,
    topic: Option<TopicInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TopicInfo {
    value: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ConversationsHistoryResponse {
    ok: bool,
    messages: Option<Vec<MessageInfo>>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct MessageInfo {
    ts: String,
    user: Option<String>,
    text: Option<String>,
    thread_ts: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PostMessageResponse {
    ok: bool,
    channel: Option<String>,
    ts: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ConnectionsOpenResponse {
    ok: bool,
    url: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SlackEnvelope {
    envelope_id: String,
    payload: Value,
    #[allow(dead_code)]
    accepts_response_payload: bool,
    #[allow(dead_code)]
    retry_num: Option<u32>,
    #[allow(dead_code)]
    retry_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SlackEventPayload {
    event: Option<SlackEvent>,
    #[serde(rename = "type")]
    payload_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SlackEvent {
    #[serde(rename = "type")]
    event_type: String,
    channel: Option<String>,
    user: Option<String>,
    text: Option<String>,
    ts: Option<String>,
    thread_ts: Option<String>,
}

// ============================================================================
// Global State
// ============================================================================

pub struct SlackListenerState {
    running: Arc<AtomicBool>,
}

impl SlackListenerState {
    fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn set_running(&self, running: bool) {
        self.running.store(running, Ordering::SeqCst);
    }
}

lazy_static::lazy_static! {
    static ref SLACK_LISTENER: Arc<RwLock<Option<SlackListenerState>>> = Arc::new(RwLock::new(None));
}

// ============================================================================
// OAuth2 Flow
// ============================================================================

/// Start Slack OAuth flow by opening browser and listening for redirect
#[tauri::command]
pub async fn start_slack_oauth(
    _app: tauri::AppHandle,
) -> Result<String, String> {
    let client_id = std::env::var("SLACK_CLIENT_ID")
        .map_err(|_| "SLACK_CLIENT_ID not set. Set it in your environment before connecting Slack.".to_string())?;
    let client_secret = std::env::var("SLACK_CLIENT_SECRET")
        .map_err(|_| "SLACK_CLIENT_SECRET not set".to_string())?;

    // Find available port for redirect listener
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind port: {}", e))?;
    let port = listener.local_addr()
        .map_err(|e| format!("Failed to get port: {}", e))?
        .port();

    debug!("OAuth redirect listener on port {}", port);

    let redirect_uri = format!("http://localhost:{}/slack-oauth", port);

    // Build OAuth URL
    let oauth_url = format!(
        "https://slack.com/oauth/v2/authorize?client_id={}&scope={}&redirect_uri={}&user_scope=",
        client_id,
        "channels:read,channels:history,chat:write,users:read",
        urlencoding::encode(&redirect_uri)
    );

    // Open browser
    if let Err(e) = open::that(&oauth_url) {
        error!("Failed to open browser: {}", e);
        return Err(format!("Failed to open browser: {}", e));
    }

    info!("Opened Slack OAuth URL in browser");

    // Wait for redirect with timeout
    let timeout = std::time::Duration::from_secs(300); // 5 minutes
    listener.set_nonblocking(false)
        .map_err(|e| format!("Failed to configure listener: {}", e))?;

    // Read the HTTP request (blocking, with timeout)
    let code = tokio::task::spawn_blocking(move || {
        let (stream, _) = listener.accept()
            .map_err(|e| format!("Failed to accept connection: {}", e))?;

        stream.set_read_timeout(Some(timeout))
            .map_err(|e| format!("Failed to set timeout: {}", e))?;

        let mut buffer = [0u8; 2048];
        let n = std::io::Read::read(&mut &stream, &mut buffer)
            .map_err(|e| format!("Failed to read: {}", e))?;

        let request = String::from_utf8_lossy(&buffer[..n]);

        // Parse code from query string
        let code = request
            .lines()
            .next()
            .and_then(|line| {
                line.split_whitespace().nth(1).and_then(|path| {
                    path.split("code=").nth(1).map(|c| c.split('&').next().unwrap_or(""))
                })
            })
            .ok_or_else(|| "No code in redirect".to_string())?
            .to_string();

        // Send a simple HTML response to the browser
        let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html><body><h1>Slack Connected!</h1><p>You can close this tab.</p></body></html>";
        let _ = std::io::Write::write_all(&mut &stream, response.as_bytes());

        Ok::<String, String>(code)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Exchange code for token
    let http_client = Client::new();
    let token_response: OAuthTokenResponse = http_client
        .post(&format!("{}/oauth.v2.access", SLACK_API_BASE))
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to exchange code: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    if !token_response.ok {
        let error = token_response.error.unwrap_or_else(|| "Unknown error".to_string());
        error!("OAuth error: {}", error);
        return Err(format!("OAuth failed: {}", error));
    }

    let token = token_response.access_token
        .ok_or_else(|| "No access token in response".to_string())?;

    // Store token in keychain
    keychain::store_secret("slack-bot-token", &token)
        .map_err(|e| format!("Failed to store token: {}", e))?;

    info!("Slack OAuth completed successfully");
    Ok("Slack connected successfully".to_string())
}

// ============================================================================
// Slack API Client
// ============================================================================

async fn get_bot_token() -> Result<String, String> {
    keychain::get_secret("slack-bot-token")
        .map_err(|e| format!("Failed to get bot token: {}", e))
}

async fn make_api_call(
    endpoint: &str,
    params: Option<&[(&str, &str)]>,
) -> Result<Value, String> {
    let token = get_bot_token().await?;
    let client = Client::new();
    let url = format!("{}/{}", SLACK_API_BASE, endpoint);

    let mut request = client.post(&url)
        .bearer_auth(&token);

    if let Some(p) = params {
        request = request.form(&p.to_vec());
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", e))?
        .json::<Value>()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let ok = response.get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !ok {
        let error = response.get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error");
        return Err(format!("Slack API error: {}", error));
    }

    Ok(response)
}

/// List all channels the bot has access to
#[tauri::command]
pub async fn list_slack_channels() -> Result<Vec<SlackChannel>, String> {
    let response: ConversationsListResponse = serde_json::from_value(
        make_api_call("conversations.list", Some(&[("types", "public_channel,private_channel")]))
            .await?
    ).map_err(|e| format!("Failed to parse channels: {}", e))?;

    if !response.ok {
        let error = response.error.unwrap_or_else(|| "Unknown error".to_string());
        return Err(format!("Failed to list channels: {}", error));
    }

    let channels: Vec<SlackChannel> = response.channels
        .unwrap_or_default()
        .into_iter()
        .map(|c| SlackChannel {
            id: c.id,
            name: c.name,
            is_private: c.is_private,
            member_count: c.num_members,
            topic: c.topic.map(|t| t.value).unwrap_or_default(),
        })
        .collect();

    debug!("Listed {} Slack channels", channels.len());
    Ok(channels)
}

/// Read messages from a specific channel
#[tauri::command]
pub async fn read_slack_messages(
    db: State<'_, Database>,
    agent_id: String,
    channel_id: String,
    limit: u32,
) -> Result<Vec<SlackMessage>, String> {
    // Check channel allowlist
    let allowed_channels = get_allowed_channels_internal(&db, &agent_id)?;
    if !allowed_channels.is_empty() && !allowed_channels.contains(&channel_id) {
        return Err(format!("Channel {} not in agent's allowlist", channel_id));
    }

    let limit = limit.max(1).min(100); // Clamp between 1 and 100

    let response: ConversationsHistoryResponse = serde_json::from_value(
        make_api_call(
            "conversations.history",
            Some(&[
                ("channel", &channel_id),
                ("limit", &limit.to_string()),
            ]),
        )
        .await?
    ).map_err(|e| format!("Failed to parse messages: {}", e))?;

    if !response.ok {
        let error = response.error.unwrap_or_else(|| "Unknown error".to_string());
        return Err(format!("Failed to read messages: {}", error));
    }

    let messages: Vec<SlackMessage> = response.messages
        .unwrap_or_default()
        .into_iter()
        .map(|m| SlackMessage {
            ts: m.ts,
            channel_id: channel_id.clone(),
            user: m.user.unwrap_or_default(),
            text: m.text.unwrap_or_default(),
            thread_ts: m.thread_ts,
        })
        .collect();

    debug!("Read {} messages from channel {}", messages.len(), channel_id);
    Ok(messages)
}

/// Send a message to a specific channel
#[tauri::command]
pub async fn send_slack_message(
    db: State<'_, Database>,
    agent_id: String,
    channel_id: String,
    text: String,
) -> Result<String, String> {
    // Check channel allowlist
    let allowed_channels = get_allowed_channels_internal(&db, &agent_id)?;
    if !allowed_channels.is_empty() && !allowed_channels.contains(&channel_id) {
        return Err(format!("Channel {} not in agent's allowlist", channel_id));
    }

    if text.is_empty() {
        return Err("Message text cannot be empty".to_string());
    }

    if text.len() > 40000 {
        return Err("Message exceeds 40000 character limit".to_string());
    }

    let response: PostMessageResponse = serde_json::from_value(
        make_api_call(
            "chat.postMessage",
            Some(&[
                ("channel", &channel_id),
                ("text", &text),
            ]),
        )
        .await?
    ).map_err(|e| format!("Failed to parse response: {}", e))?;

    if !response.ok {
        let error = response.error.unwrap_or_else(|| "Unknown error".to_string());
        return Err(format!("Failed to send message: {}", error));
    }

    let ts = response.ts.ok_or_else(|| "No timestamp in response".to_string())?;
    info!("Sent message to channel {} with ts {}", channel_id, ts);
    Ok(ts)
}

// ============================================================================
// Channel Allowlist Management
// ============================================================================

/// Internal: get allowed channels from the Slack bridge in our DB
fn get_allowed_channels_internal(
    db: &Database,
    agent_id: &str,
) -> Result<Vec<String>, String> {
    let bridge_id = format!("{}-slack", agent_id);

    match db.get_bridge(&bridge_id) {
        Ok(Some(bridge)) => {
            // Extract allowed channels from config.scope
            if let Some(allowed) = bridge.config.scope.get("allowed_channels") {
                if let Ok(channels) = serde_json::from_value::<Vec<String>>(allowed.clone()) {
                    return Ok(channels);
                }
            }
            // No allowlist set — empty means allow all
            Ok(vec![])
        }
        Ok(None) => Ok(vec![]),
        Err(e) => {
            error!("Database error retrieving Slack bridge: {}", e);
            Ok(vec![]) // Fail safe
        }
    }
}

/// Get the list of allowed Slack channels for an agent
#[tauri::command]
pub async fn get_allowed_slack_channels(
    db: State<'_, Database>,
    agent_id: String,
) -> Result<Vec<String>, String> {
    get_allowed_channels_internal(&db, &agent_id)
}

/// Update the list of allowed Slack channels for an agent
#[tauri::command]
pub async fn update_allowed_slack_channels(
    db: State<'_, Database>,
    agent_id: String,
    channel_ids: Vec<String>,
) -> Result<(), String> {
    let bridge_id = format!("{}-slack", agent_id);

    // Build scope with allowed channels
    let scope = json!({
        "allowed_channels": channel_ids
    });

    match db.get_bridge(&bridge_id) {
        Ok(Some(mut existing)) => {
            // Update existing bridge config
            existing.config.scope = scope;
            db.update_bridge(&existing)
                .map_err(|e| format!("Failed to update bridge: {}", e))?;
        }
        Ok(None) => {
            // Create new Slack bridge
            let bridge = Bridge {
                id: bridge_id,
                agent_id: agent_id.clone(),
                name: "Slack Bridge".to_string(),
                bridge_type: BridgeType::Slack,
                enabled: true,
                config: BridgeConfig {
                    scope,
                    expires_at: None,
                    push_enabled: true,
                },
                permissions: BridgePermissions {
                    read: true,
                    write: true, // Need write to send messages
                    delete: false,
                },
            };
            db.insert_bridge(&bridge)
                .map_err(|e| format!("Failed to create bridge: {}", e))?;
        }
        Err(e) => {
            return Err(format!("Database error: {}", e));
        }
    }

    info!("Updated allowed channels for agent {}: {:?}", agent_id, channel_ids);
    Ok(())
}

// ============================================================================
// Connection Status
// ============================================================================

/// Check if Slack is connected and get workspace/bot info
#[tauri::command]
pub async fn check_slack_connection() -> Result<SlackConnectionStatus, String> {
    let token_result = keychain::get_secret("slack-bot-token");

    if token_result.is_err() {
        return Ok(SlackConnectionStatus {
            connected: false,
            workspace_name: None,
            bot_name: None,
        });
    }

    // Test token with auth.test
    let response: AuthTestResponse = serde_json::from_value(
        make_api_call("auth.test", None)
            .await
            .unwrap_or_else(|_| json!({"ok": false}))
    ).unwrap_or(AuthTestResponse {
        ok: false,
        url: None,
        team: None,
        user: None,
        team_id: None,
        user_id: None,
        error: None,
    });

    if response.ok {
        Ok(SlackConnectionStatus {
            connected: true,
            workspace_name: response.team,
            bot_name: response.user,
        })
    } else {
        Ok(SlackConnectionStatus {
            connected: false,
            workspace_name: None,
            bot_name: None,
        })
    }
}

// ============================================================================
// Socket Mode (WebSocket) for Real-time Events
// ============================================================================

/// Start listening for Slack events via Socket Mode
#[tauri::command]
pub async fn start_slack_listener(
    app: tauri::AppHandle,
) -> Result<String, String> {
    let listener = SLACK_LISTENER.read().await;
    if listener.is_some() && listener.as_ref().unwrap().is_running() {
        return Err("Slack listener already running".to_string());
    }
    drop(listener);

    let state = SlackListenerState::new();
    state.set_running(true);

    let running_flag = state.running.clone();

    let mut listener = SLACK_LISTENER.write().await;
    *listener = Some(state);
    drop(listener);

    let app_clone = app.clone();

    tokio::spawn(async move {
        if let Err(e) = run_slack_listener(app_clone, running_flag).await {
            error!("Slack listener error: {}", e);
        }
    });

    info!("Slack listener started");
    Ok("Slack listener started".to_string())
}

async fn run_slack_listener(
    app: tauri::AppHandle,
    running: Arc<AtomicBool>,
) -> Result<(), String> {
    loop {
        if !running.load(Ordering::SeqCst) {
            info!("Slack listener stopped");
            break;
        }

        // Get app-level token for Socket Mode
        let app_token = keychain::get_secret("slack-app-token")
            .map_err(|e| format!("Failed to get app token: {}", e))?;

        // Get WSS URL
        let wss_url = get_wss_url(&app_token).await?;

        // Connect to WebSocket
        if let Err(e) = connect_socket_mode(&wss_url, &app, &running).await {
            warn!("WebSocket error: {}, reconnecting in 5s...", e);
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            continue;
        }
    }

    Ok(())
}

async fn get_wss_url(app_token: &str) -> Result<String, String> {
    let client = Client::new();
    let response: ConnectionsOpenResponse = client
        .post(&format!("{}/apps.connections.open", SLACK_API_BASE))
        .bearer_auth(app_token)
        .send()
        .await
        .map_err(|e| format!("Failed to get WSS URL: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse WSS response: {}", e))?;

    if !response.ok {
        let error = response.error.unwrap_or_else(|| "Unknown error".to_string());
        return Err(format!("Failed to open connection: {}", error));
    }

    response.url.ok_or_else(|| "No URL in response".to_string())
}

async fn connect_socket_mode(
    wss_url: &str,
    app: &tauri::AppHandle,
    running: &Arc<AtomicBool>,
) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message;

    let (ws_stream, _) = connect_async(wss_url)
        .await
        .map_err(|e| format!("WebSocket connection failed: {}", e))?;

    info!("Connected to Slack Socket Mode");

    let (mut write, mut read) = ws_stream.split();

    // Handle incoming messages
    while let Some(msg_result) = read.next().await {
        if !running.load(Ordering::SeqCst) {
            break;
        }

        match msg_result {
            Ok(msg) => {
                if let Ok(text) = msg.to_text() {
                    if let Ok(envelope) = serde_json::from_str::<SlackEnvelope>(text) {
                        // Acknowledge envelope
                        let ack = json!({
                            "envelope_id": envelope.envelope_id,
                        });

                        let _ = write.send(Message::Text(ack.to_string())).await;

                        // Process payload
                        if let Ok(payload) = serde_json::from_value::<SlackEventPayload>(
                            envelope.payload.clone(),
                        ) {
                            if payload.payload_type == Some("events_api".to_string()) {
                                if let Some(event) = payload.event {
                                    if event.event_type == "message" {
                                        if let (Some(channel), Some(user), Some(text), Some(ts)) =
                                            (event.channel, event.user, event.text, event.ts)
                                        {
                                            let message = SlackMessage {
                                                ts,
                                                channel_id: channel,
                                                user,
                                                text,
                                                thread_ts: event.thread_ts,
                                            };

                                            debug!("Slack message received: {:?}", message);
                                            let _ = app.emit(
                                                "slack://new-message",
                                                &message,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                error!("WebSocket error: {}", e);
                return Err(format!("WebSocket error: {}", e));
            }
        }
    }

    Ok(())
}

/// Stop listening for Slack events
#[tauri::command]
pub async fn stop_slack_listener() -> Result<(), String> {
    let mut listener = SLACK_LISTENER.write().await;
    if let Some(state) = listener.as_ref() {
        state.set_running(false);
        *listener = None;
        info!("Slack listener stopped");
        Ok(())
    } else {
        Err("Slack listener not running".to_string())
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slack_channel_serialization() {
        let channel = SlackChannel {
            id: "C123".to_string(),
            name: "general".to_string(),
            is_private: false,
            member_count: 42,
            topic: "Team updates".to_string(),
        };

        let json = serde_json::to_string(&channel).unwrap();
        let deserialized: SlackChannel = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.id, channel.id);
        assert_eq!(deserialized.name, channel.name);
    }

    #[test]
    fn test_slack_message_serialization() {
        let message = SlackMessage {
            ts: "1234567890.000001".to_string(),
            channel_id: "C123".to_string(),
            user: "U456".to_string(),
            text: "Hello, world!".to_string(),
            thread_ts: None,
        };

        let json = serde_json::to_string(&message).unwrap();
        let deserialized: SlackMessage = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.ts, message.ts);
        assert_eq!(deserialized.text, message.text);
    }
}

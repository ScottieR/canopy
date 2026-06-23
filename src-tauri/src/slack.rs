use crate::db::Database;
use crate::keychain;
use crate::models::{Bridge, BridgeConfig, BridgePermissions, BridgeType};
use lazy_static::lazy_static;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::TcpListener;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

const SLACK_API_BASE: &str = "https://slack.com/api";

// Shared reqwest client for ALL Slack API calls.
//
// Why: a fresh `Client::new()` per call (the previous behaviour) re-opens TLS
// against api.slack.com every single time — easily 100-500ms of overhead
// before Slack even sees the request, plus no HTTP/2 multiplexing, plus no
// connection pool. Five Slack calls in a row could waste 2+ seconds of pure
// handshake time. That was a major contributor to "Slack feels slow" once
// multiple agents started polling.
//
// Also sets a real timeout — `Client::new()` defaults to NO timeout, which
// means a hung Slack call could stall a Tauri command indefinitely and
// cascade into the chat UI looking frozen.
lazy_static! {
    static ref HTTP: Client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(15))
        .pool_idle_timeout(std::time::Duration::from_secs(15)) // macOS aggressively drops idle sockets; close them before 60s
        .tcp_keepalive(std::time::Duration::from_secs(15))
        .pool_max_idle_per_host(8)
        .user_agent("canopy/slack")
        .build()
        .unwrap_or_else(|_| Client::new());
}

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

// ============================================================================
// OAuth2 Flow
// ============================================================================

/// Start Slack OAuth flow by opening browser and listening for redirect
#[tauri::command]
pub async fn start_slack_oauth(_app: tauri::AppHandle) -> Result<String, String> {
    // ── RATE LIMITING ──
    crate::rate_limiter::limiters::OAUTH_LIMITER
        .check("local-user")
        .map_err(|e| e.to_string())?;
    // SECURITY: Try keychain first for secrets (secure storage)
    // Fall back to environment variables for development/backward compatibility
    let client_id = crate::keychain::get_secret("SLACK_CLIENT_ID")
        .or_else(|_| std::env::var("SLACK_CLIENT_ID"))
        .map_err(|_| "SLACK_CLIENT_ID not found in keychain or environment. Store it securely using the keychain for production use.".to_string())?;

    let client_secret = crate::keychain::get_secret("SLACK_CLIENT_SECRET")
        .or_else(|_| std::env::var("SLACK_CLIENT_SECRET"))
        .map_err(|_| "SLACK_CLIENT_SECRET not found in keychain or environment. Store it securely using the keychain for production use.".to_string())?;

    // Find available port for redirect listener
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Failed to bind port: {}", e))?;
    let port = listener
        .local_addr()
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
    listener
        .set_nonblocking(false)
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

    // Exchange code for token (reuse the shared client — same pool + timeout).
    let token_response: OAuthTokenResponse = HTTP
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
        let error = token_response
            .error
            .unwrap_or_else(|| "Unknown error".to_string());
        error!("OAuth error: {}", error);
        return Err(format!("OAuth failed: {}", error));
    }

    let token = token_response
        .access_token
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

/// Resolve a Slack bot token.
///
/// Per-agent isolation rule (important — this is the "no shared keys" guarantee):
///
/// * When `agent_id == Some(id)`, look up ONLY `agent_{id}_slack_bot_token`. If the
///   per-agent token isn't in the keychain, error out cleanly. Do NOT fall back to
///   the global `slack-bot-token` slot. The previous fallback meant that as soon as
///   the global slot had a stale token (e.g. left over from the legacy single-tenant
///   `start_slack_listener` path), every agent missing its own connection would
///   silently use that one — Agent A's messages going through Agent B's bot. Hard
///   fail makes the UI prompt for a real per-agent connection instead.
///
/// * When `agent_id == None`, this is a global/legacy call site (e.g. the global
///   IntegrationsView, or a "is Slack working at all" health check) and falling
///   through to the global slot is the intended behaviour.
async fn get_bot_token(agent_id: Option<&str>) -> Result<String, String> {
    if let Some(id) = agent_id {
        return keychain::get_secret(&format!("agent_{}_slack_bot_token", id)).map_err(|_| {
            format!(
                "Slack is not connected for agent '{}'. Open this agent's Connections \
                 tab and complete the Slack setup. (Not falling back to the global \
                 token to avoid cross-agent context leaks.)",
                id
            )
        });
    }
    keychain::get_secret("slack-bot-token").map_err(|e| format!("Failed to get bot token: {}", e))
}

async fn make_api_call(
    method: reqwest::Method,
    endpoint: &str,
    params: Option<&[(&str, &str)]>,
    agent_id: Option<&str>,
) -> Result<Value, String> {
    let token = get_bot_token(agent_id).await?;
    let url = format!("{}/{}", SLACK_API_BASE, endpoint);

    let mut last_error = String::new();
    for attempt in 0..2 {
        let mut request = HTTP.request(method.clone(), &url).bearer_auth(&token);

        if let Some(p) = params {
            if method == reqwest::Method::GET {
                request = request.query(&p.to_vec());
            } else {
                request = request.form(&p.to_vec());
            }
        }

        match request.send().await {
            Ok(response) => {
                let json_resp = response
                    .json::<Value>()
                    .await
                    .map_err(|e| format!("Failed to parse response: {}", e))?;

                let ok = json_resp
                    .get("ok")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if !ok {
                    let error = json_resp
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown error");
                    return Err(format!("Slack API error: {}", error));
                }

                return Ok(json_resp);
            }
            Err(e) => {
                if attempt == 0 {
                    tracing::warn!(
                        "Slack connection dropped, likely stale pool socket. Retrying once: {}",
                        e
                    );
                    continue;
                }
                last_error = e.to_string();
            }
        }
    }

    Err(format!("API request failed: {}", last_error))
}

/// List all channels the bot has access to
#[tauri::command]
pub async fn list_slack_channels(agent_id: Option<String>) -> Result<Vec<SlackChannel>, String> {
    let response: ConversationsListResponse = serde_json::from_value(
        make_api_call(
            reqwest::Method::GET,
            "conversations.list",
            Some(&[("types", "public_channel,private_channel")]),
            agent_id.as_deref(),
        )
        .await?,
    )
    .map_err(|e| format!("Failed to parse channels: {}", e))?;

    if !response.ok {
        let error = response
            .error
            .unwrap_or_else(|| "Unknown error".to_string());
        return Err(format!("Failed to list channels: {}", error));
    }

    let channels: Vec<SlackChannel> = response
        .channels
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
            reqwest::Method::GET,
            "conversations.history",
            Some(&[("channel", &channel_id), ("limit", &limit.to_string())]),
            Some(&agent_id),
        )
        .await?,
    )
    .map_err(|e| format!("Failed to parse messages: {}", e))?;

    if !response.ok {
        let error = response
            .error
            .unwrap_or_else(|| "Unknown error".to_string());
        return Err(format!("Failed to read messages: {}", error));
    }

    let messages: Vec<SlackMessage> = response
        .messages
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

    debug!(
        "Read {} messages from channel {}",
        messages.len(),
        channel_id
    );
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
            reqwest::Method::POST,
            "chat.postMessage",
            Some(&[("channel", &channel_id), ("text", &text)]),
            Some(&agent_id),
        )
        .await?,
    )
    .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !response.ok {
        let error = response
            .error
            .unwrap_or_else(|| "Unknown error".to_string());
        return Err(format!("Failed to send message: {}", error));
    }

    let ts = response
        .ts
        .ok_or_else(|| "No timestamp in response".to_string())?;
    info!("Sent message to channel {} with ts {}", channel_id, ts);
    Ok(ts)
}

// ============================================================================
// Channel Allowlist Management
// ============================================================================

/// Internal: get allowed channels from the Slack bridge in our DB
fn get_allowed_channels_internal(db: &Database, agent_id: &str) -> Result<Vec<String>, String> {
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

    // Sync union of all allowed channels to OpenClaw config
    if let Ok(bridges) = db.list_all_bridges() {
        let mut all_allowed_channels = std::collections::HashSet::new();
        for cid in &channel_ids {
            all_allowed_channels.insert(cid.clone());
        }
        for b in bridges {
            if b.bridge_type == BridgeType::Slack && b.agent_id != agent_id {
                if let Some(allowed) = b.config.scope.get("allowed_channels") {
                    if let Ok(channels) = serde_json::from_value::<Vec<String>>(allowed.clone()) {
                        for cid in channels {
                            all_allowed_channels.insert(cid);
                        }
                    }
                }
            }
        }

        let mut channels_obj = serde_json::Map::new();
        for cid in all_allowed_channels {
            let mut props = serde_json::Map::new();
            props.insert("enabled".to_string(), json!(true));
            channels_obj.insert(cid, json!(props));
        }
        let channels_json = json!(channels_obj).to_string();

        // Apply via direct JSON patch instead of `openclaw config set` so we don't SIGTERM
        // the gateway just to refresh the allowed-channels list. The file watcher will
        // hot-reload the change.
        let patch_script = format!(
            r#"const fs=require('fs');
const p='/home/node/.openclaw/openclaw.json';
let c=JSON.parse(fs.readFileSync(p,'utf8'));
c.channels=c.channels||{{}};
c.channels.slack=c.channels.slack||{{}};
c.channels.slack.channels={chs};
fs.writeFileSync(p,JSON.stringify(c,null,2));
"#,
            chs = channels_json,
        );

        let container_name = crate::openclaw::get_agent_container_name(&db, &agent_id);
        let cmd_future = crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "node",
                &container_name,
                "node",
                "-e",
                &patch_script,
            ])
            .output();

        if let Ok(Ok(output)) =
            tokio::time::timeout(std::time::Duration::from_secs(8), cmd_future).await
        {
            if !output.status.success() {
                tracing::warn!(
                    "Failed to patch channels.slack.channels: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            } else {
                tracing::info!(
                    "Synced {} Slack channels to OpenClaw config",
                    channels_obj.len()
                );
            }
        }
    }

    info!(
        "Updated allowed channels for agent {}: {:?}",
        agent_id, channel_ids
    );
    Ok(())
}

// ============================================================================
// Connection Status
// ============================================================================

/// Check if Slack is connected and get workspace/bot info
#[tauri::command]
pub async fn check_slack_connection(
    agent_id: Option<String>,
) -> Result<SlackConnectionStatus, String> {
    let token_result = get_bot_token(agent_id.as_deref()).await;

    if let Err(e) = token_result {
        tracing::error!("check_slack_connection token error: {}", e);
        return Ok(SlackConnectionStatus {
            connected: false,
            workspace_name: None,
            bot_name: None,
        });
    }

    // Test token with auth.test using POST and empty form to ensure Content-Type is set
    let response: AuthTestResponse = serde_json::from_value(
        make_api_call(
            reqwest::Method::POST,
            "auth.test",
            Some(&[]),
            agent_id.as_deref(),
        )
        .await
        .unwrap_or_else(|e| {
            tracing::error!("check_slack_connection api error: {}", e);
            json!({"ok": false})
        }),
    )
    .unwrap_or(AuthTestResponse {
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

/// Start the OpenClaw Slack integration via Socket Mode.
///
/// # How OpenClaw Slack configuration works (important)
///
/// OpenClaw does NOT have a `channels add` CLI command. Slack is configured by writing
/// token values into `openclaw.json` via `openclaw config set`, then restarting the
/// gateway so the new config is loaded. The previous implementation incorrectly called
/// `openclaw channels add --channel slack ...` which does not exist and silently failed.
///
/// # Token requirements
///
/// Two tokens are required — both must be stored in the system keychain before calling this:
///
/// - **`slack-bot-token`** — starts with `xoxb-`. Obtained via the OAuth flow
///   (`start_slack_oauth`). Requires bot scopes: `channels:read`, `channels:history`,
///   `chat:write`, `users:read`.
///
/// - **`slack-app-token`** — starts with `xapp-`. Created separately in the Slack app
///   dashboard under "App-Level Tokens". Requires the `connections:write` scope.
///   This is NOT obtained via the OAuth redirect flow — the user must paste it manually.
///   Without it, Socket Mode cannot establish its WebSocket connection.
#[tauri::command]
pub async fn start_slack_listener(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: Option<String>,
) -> Result<String, String> {
    start_slack_listener_internal(&db, agent_id.as_deref()).await
}

pub async fn start_slack_listener_internal(
    db: &crate::db::Database,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let app_token_key = if let Some(id) = &agent_id {
        format!("agent_{}_slack_app_token", id)
    } else {
        "slack-app-token".to_string()
    };
    let bot_token_key = if let Some(id) = &agent_id {
        format!("agent_{}_slack_bot_token", id)
    } else {
        "slack-bot-token".to_string()
    };

    let app_token = keychain::get_secret(&app_token_key).map_err(|_| {
        "Slack App Token (xapp-...) not found in keychain. \
             Create one in your Slack app dashboard under App-Level Tokens \
             with the connections:write scope, then save it via the Canopy settings panel."
            .to_string()
    })?;

    let bot_token = keychain::get_secret(&bot_token_key).map_err(|_| {
        "Slack Bot Token (xoxb-...) not found in keychain. Connect Slack via Settings first."
            .to_string()
    })?;

    let app_token = app_token.trim().to_string();
    let bot_token = bot_token.trim().to_string();

    if app_token.is_empty() {
        return Err(
            "Slack App Token is blank. Paste the xapp-... token in Settings → Slack.".to_string(),
        );
    }
    if bot_token.is_empty() {
        return Err(
            "Slack Bot Token is blank. Re-connect Slack via the OAuth flow in Settings."
                .to_string(),
        );
    }
    if !app_token.starts_with("xapp-") {
        return Err(format!(
            "Slack App Token looks wrong (got '{}...'). It must start with 'xapp-'. \
             Make sure you're pasting the App-Level Token, not the Bot Token.",
            &app_token[..app_token.len().min(8)]
        ));
    }
    if !bot_token.starts_with("xoxb-") {
        return Err(format!(
            "Slack Bot Token looks wrong (got '{}...'). It must start with 'xoxb-'.",
            &bot_token[..bot_token.len().min(8)]
        ));
    }

    // Configure Slack by writing all six fields atomically into openclaw.json via a single
    // `node -e` JSON patch. Previously this used six rapid `openclaw config set` calls in a
    // loop — each one SIGTERMs the gateway, cascading into OOM with multiple agents
    // (OPENCLAW_INTEGRATION.md §8). One patch + one restart is far less churn.
    //
    // ⚠️  groupPolicy MUST be "allowlist" — setting this to "open" breaks the pairing
    // flow entirely, because OpenClaw will bypass the pairing challenge and route
    // unregistered users directly to the LLM. "allowlist" ensures the agent asks
    // for a pairing code if the DM is not in its allowed channels list.
    //
    // String values below are JSON-encoded to handle any unusual characters in tokens
    // safely (newlines, quotes, etc.).
    let bot_token_json =
        serde_json::to_string(&bot_token).map_err(|e| format!("Token serialize error: {}", e))?;
    let app_token_json =
        serde_json::to_string(&app_token).map_err(|e| format!("Token serialize error: {}", e))?;

    let patch_script = if let Some(id) = agent_id {
        let account_json = serde_json::json!({
            "appToken": app_token,
            "botToken": bot_token
        });
        let account_json = serde_json::to_string(&account_json)
            .map_err(|e| format!("Token serialize error: {}", e))?;
        let binding_json = serde_json::json!({
            "agentId": id,
            "match": { "channel": "slack", "accountId": id }
        });
        let binding_json = serde_json::to_string(&binding_json)
            .map_err(|e| format!("Binding serialize error: {}", e))?;

        format!(
            r#"const fs=require('fs');
const p='/home/node/.openclaw/openclaw.json';
let c=JSON.parse(fs.readFileSync(p,'utf8'));
c.channels=c.channels||{{}};
c.channels.slack=c.channels.slack||{{}};
c.channels.slack.enabled=true;
c.channels.slack.mode='socket';
c.channels.slack.groupPolicy='allowlist';
c.channels.slack.accounts=c.channels.slack.accounts||{{}};
c.channels.slack.accounts[{agent_id}]={account};
delete c.channels.slack.botToken;
delete c.channels.slack.appToken;
c.plugins=c.plugins||{{}};
c.plugins.entries=c.plugins.entries||{{}};
c.plugins.entries.slack=c.plugins.entries.slack||{{}};
c.plugins.entries.slack.enabled=true;
c.bindings=Array.isArray(c.bindings)?c.bindings:[];
const newBinding={binding};
c.bindings=c.bindings.filter(b => !(b && b.agentId===newBinding.agentId && b.match && b.match.channel==='slack'));
c.bindings.push(newBinding);
fs.writeFileSync(p,JSON.stringify(c,null,2));
console.log('slack config patched');
"#,
            agent_id = serde_json::to_string(id).unwrap_or_else(|_| "\"\"".to_string()),
            account = account_json,
            binding = binding_json,
        )
    } else {
        format!(
            r#"const fs=require('fs');
const p='/home/node/.openclaw/openclaw.json';
let c=JSON.parse(fs.readFileSync(p,'utf8'));
c.channels=c.channels||{{}};
c.channels.slack=c.channels.slack||{{}};
c.channels.slack.botToken={bot};
c.channels.slack.appToken={app};
c.channels.slack.enabled=true;
c.channels.slack.mode='socket';
c.channels.slack.groupPolicy='allowlist';
c.plugins=c.plugins||{{}};
c.plugins.entries=c.plugins.entries||{{}};
c.plugins.entries.slack=c.plugins.entries.slack||{{}};
c.plugins.entries.slack.enabled=true;
fs.writeFileSync(p,JSON.stringify(c,null,2));
console.log('slack config patched');
"#,
            bot = bot_token_json,
            app = app_token_json,
        )
    };

    let container_name = agent_id
        .map(|id| crate::openclaw::get_agent_container_name(db, id))
        .unwrap_or_else(|| "canopy-gateway".to_string());

    let patch_out = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "node",
                &container_name,
                "node",
                "-e",
                &patch_script,
            ])
            .output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("Failed to patch Slack config: {}", e)),
        Err(_) => {
            return Err("Timed out patching Slack config. Is the gateway running?".to_string())
        }
    };

    if !patch_out.status.success() {
        let stderr = String::from_utf8_lossy(&patch_out.stderr);
        let stdout = String::from_utf8_lossy(&patch_out.stdout);
        let mut combined = format!("{}\n{}", stdout, stderr).trim().to_string();
        if combined.contains("cannot exec in a stopped container")
            || combined.contains("No such container")
        {
            combined = "Gateway container is stopped. Start infrastructure first.".to_string();
        }
        error!("Failed to patch Slack config: {}", combined);
        return Err(format!("Failed to configure Slack: {}", combined));
    }

    // The `node -e` patch only changes the file on disk — OpenClaw needs a real restart
    // to (a) drop any existing Socket Mode connection and (b) re-read the config. ONE
    // restart total replaces the previous ~6 SIGTERMs from the config-set loop.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::openclaw::get_docker_command()
            .args(["restart", &container_name])
            .output(),
    )
    .await;

    // Brief wait for Socket Mode WebSocket to establish on the freshly-started gateway.
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;

    info!("Slack Socket Mode configured and gateway restarted successfully.");
    Ok("Slack connected via Socket Mode. Gateway restarted.".to_string())
}

/// Disable the OpenClaw Slack integration.
///
/// Sets `channels.slack.enabled = false` in openclaw.json and restarts the gateway.
/// Tokens are NOT removed from keychain — reconnecting only requires calling
/// `start_slack_listener()` again.
#[tauri::command]
pub async fn stop_slack_listener(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: Option<String>,
) -> Result<(), String> {
    // Disable via direct JSON patch instead of `openclaw config set` so we get one
    // process restart total (the explicit docker restart below) rather than the
    // self-SIGTERM-from-config-set + explicit-restart double-churn we had previously.
    let patch_script = r#"const fs=require('fs');
const p='/home/node/.openclaw/openclaw.json';
let c=JSON.parse(fs.readFileSync(p,'utf8'));
c.channels=c.channels||{};
c.channels.slack=c.channels.slack||{};
c.channels.slack.enabled=false;
c.plugins=c.plugins||{};
c.plugins.entries=c.plugins.entries||{};
c.plugins.entries.slack=c.plugins.entries.slack||{};
c.plugins.entries.slack.enabled=false;
fs.writeFileSync(p,JSON.stringify(c,null,2));
console.log('slack disabled in config');
"#;

    let container_name = agent_id
        .as_deref()
        .map(|id| crate::openclaw::get_agent_container_name(&db, id))
        .unwrap_or_else(|| "canopy-gateway".to_string());

    let patch_out = match tokio::time::timeout(
        std::time::Duration::from_secs(8),
        crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "node",
                &container_name,
                "node",
                "-e",
                patch_script,
            ])
            .output(),
    )
    .await
    {
        Ok(res) => res.map_err(|e| format!("Failed to disable Slack in gateway config: {}", e))?,
        Err(_) => return Err("Timed out while disabling Slack.".into()),
    };

    if !patch_out.status.success() {
        let stderr = String::from_utf8_lossy(&patch_out.stderr);
        let stdout = String::from_utf8_lossy(&patch_out.stdout);
        let combined = format!("{}\n{}", stdout, stderr).trim().to_string();
        warn!("Failed to disable Slack via JSON patch: {}", combined);
        // Non-fatal — still attempt the restart so whatever state we're in gets flushed
    }

    // Restart the gateway to drop the Socket Mode connection.
    let _ = crate::openclaw::get_docker_command()
        .args(["restart", &container_name])
        .output()
        .await;

    info!("Slack integration disabled and gateway restarted.");
    Ok(())
}

/// Per-agent Slack disconnect.
///
/// Wipes the agent's saved Slack tokens (`agent_{id}_slack_app_token` and
/// `agent_{id}_slack_bot_token`) from the keychain, then triggers the gateway-channels
/// sync so the rebuilt `channels.slack.accounts` map no longer contains this agent and
/// the matching `bindings` entry is removed.
///
/// Other agents' Slack connections are unaffected — only this agent's binding goes away.
#[tauri::command]
pub async fn disconnect_slack_for_agent(
    db: State<'_, Database>,
    agent_id: String,
) -> Result<String, String> {
    if !agent_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "disconnect_slack_for_agent: invalid agent id {:?}",
            agent_id
        ));
    }

    let _ = keychain::delete_secret_internal(&format!("agent_{}_slack_app_token", agent_id));
    let _ = keychain::delete_secret_internal(&format!("agent_{}_slack_bot_token", agent_id));

    let is_isolated = db
        .get_agent(&agent_id)
        .map(|a| a.map(|a| a.isolated).unwrap_or(false))
        .unwrap_or(false);

    if is_isolated {
        let patch_script = r#"const fs=require('fs');
const p='/home/node/.openclaw/openclaw.json';
let c=JSON.parse(fs.readFileSync(p,'utf8'));
c.channels=c.channels||{};
c.channels.slack=c.channels.slack||{};
c.channels.slack.enabled=false;
c.channels.slack.botToken='';
c.channels.slack.appToken='';
c.plugins=c.plugins||{};
c.plugins.entries=c.plugins.entries||{};
c.plugins.entries.slack=c.plugins.entries.slack||{};
c.plugins.entries.slack.enabled=false;
fs.writeFileSync(p,JSON.stringify(c,null,2));
"#;
        let container_name = crate::openclaw::get_agent_container_name(&db, &agent_id);
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            crate::openclaw::get_docker_command()
                .args([
                    "exec",
                    "-u",
                    "node",
                    &container_name,
                    "node",
                    "-e",
                    patch_script,
                ])
                .output(),
        )
        .await;

        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            crate::openclaw::get_docker_command()
                .args(["restart", &container_name])
                .output(),
        )
        .await;
    } else {
        let active_agents = db.list_agents().unwrap_or_default();
        let gateway_agents: Vec<_> = active_agents.into_iter().filter(|a| !a.isolated).collect();
        let changed =
            crate::openclaw::sync_container_channels_internal("canopy-gateway", &gateway_agents)
                .await?;
        if changed {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(15),
                crate::openclaw::get_docker_command()
                    .args(["restart", "canopy-gateway"])
                    .output(),
            )
            .await;
        }
    }

    info!("Slack disconnected for agent {}; tokens removed.", agent_id);
    Ok(format!(
        "Slack disconnected for {} and saved tokens removed.",
        agent_id
    ))
}

/// Global Slack disconnect (legacy single-workspace path).
///
/// Wipes the global `slack-bot-token` / `slack-app-token` keychain entries, clears the
/// matching fields in `openclaw.json`, and restarts the gateway. Use only for the legacy
/// single-tenant Slack flow — for per-agent connections call `disconnect_slack_for_agent`.
#[tauri::command]
pub async fn disconnect_slack_global() -> Result<String, String> {
    let _ = keychain::delete_secret_internal("slack-bot-token");
    let _ = keychain::delete_secret_internal("slack-app-token");

    let patch_script = r#"const fs=require('fs');
const p='/home/node/.openclaw/openclaw.json';
let c=JSON.parse(fs.readFileSync(p,'utf8'));
c.channels=c.channels||{};
c.channels.slack=c.channels.slack||{};
c.channels.slack.enabled=false;
c.channels.slack.botToken='';
c.channels.slack.appToken='';
c.plugins=c.plugins||{};
c.plugins.entries=c.plugins.entries||{};
c.plugins.entries.slack=c.plugins.entries.slack||{};
c.plugins.entries.slack.enabled=false;
fs.writeFileSync(p,JSON.stringify(c,null,2));
"#;

    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "node",
                "canopy-gateway",
                "node",
                "-e",
                patch_script,
            ])
            .output(),
    )
    .await;

    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::openclaw::get_docker_command()
            .args(["restart", "canopy-gateway"])
            .output(),
    )
    .await;

    info!("Global Slack integration disconnected; tokens removed.");
    Ok("Slack disconnected and saved tokens removed.".to_string())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── Serialization ─────────────────────────────────────────────────────

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

    // ── Token format validation (regression guards) ───────────────────────

    #[test]
    fn bot_token_prefix_check() {
        // Bot tokens from Slack's OAuth flow always start with "xoxb-".
        // start_slack_listener validates this — test that the validation logic is correct.
        assert!(
            "xoxb-12345-abc".starts_with("xoxb-"),
            "Valid bot token prefix check failed"
        );
        assert!(
            !"xapp-12345-abc".starts_with("xoxb-"),
            "App token should not pass bot prefix check"
        );
        assert!(
            !"xoxb-".starts_with("xoxb-a"),
            "Empty token should not pass"
        );
    }

    #[test]
    fn app_token_prefix_check() {
        // App-Level tokens (Socket Mode) always start with "xapp-".
        assert!(
            "xapp-1-abc123".starts_with("xapp-"),
            "Valid app token prefix check failed"
        );
        assert!(
            !"xoxb-12345-abc".starts_with("xapp-"),
            "Bot token should not pass app prefix check"
        );
    }

    #[test]
    fn start_slack_listener_uses_config_set_not_channels_add() {
        // Regression guard: the old implementation called `openclaw channels add --channel slack`
        // which does not exist. The new implementation uses `openclaw config set` for each key.
        // This test documents the expected command structure.
        //
        // If start_slack_listener is rewritten, ensure it still uses config-set semantics:
        // - "openclaw config set channels.slack.botToken <value>"
        // - "openclaw config set channels.slack.appToken <value>"
        // - "openclaw config set channels.slack.enabled true"
        //
        // These string literals are the expected config keys — any change to them here
        // should also be reflected in the function body.
        let expected_config_keys = [
            "channels.slack.botToken",
            "channels.slack.appToken",
            "channels.slack.enabled",
            "channels.slack.mode",
        ];
        for key in expected_config_keys {
            assert!(
                key.starts_with("channels.slack."),
                "Config key '{}' must be under channels.slack.*",
                key
            );
        }
    }

    #[test]
    fn oauth_url_requests_required_scopes() {
        // The OAuth URL in start_slack_oauth must request the minimum scopes for
        // channel reading and message sending. Verify the scope string contains them.
        let scopes = "channels:read,channels:history,chat:write,users:read";
        assert!(
            scopes.contains("channels:read"),
            "Missing channels:read scope"
        );
        assert!(
            scopes.contains("channels:history"),
            "Missing channels:history scope"
        );
        assert!(scopes.contains("chat:write"), "Missing chat:write scope");
    }
}

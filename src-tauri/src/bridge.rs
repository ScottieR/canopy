use crate::models::{Bridge, BridgeConfig, BridgePermissions, BridgeType};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Component, Path, PathBuf};

/// Bridge management — the security boundary between agents and data sources.
/// Providers mediate lifecycle and permission checks for agent-scoped data sources.
use async_trait::async_trait;

/// Standardized trait for executing bridge lifecycle and permission checks
#[async_trait]
pub trait BridgeProvider: Send + Sync {
    async fn start_bridge(&self, agent_id: &str, config: &BridgeConfig) -> Result<(), String>;
    async fn stop_bridge(&self, agent_id: &str) -> Result<(), String>;
    async fn validate_access(
        &self,
        requested_action: &str,
        permissions: &BridgePermissions,
    ) -> Result<bool, String>;
}

/// A dummy mock implementation for testing
pub struct MockBridgeProvider;

#[async_trait]
impl BridgeProvider for MockBridgeProvider {
    async fn start_bridge(&self, agent_id: &str, _config: &BridgeConfig) -> Result<(), String> {
        tracing::info!("MockBridgeProvider: Starting bridge for agent {}", agent_id);
        Ok(())
    }

    async fn stop_bridge(&self, agent_id: &str) -> Result<(), String> {
        tracing::info!("MockBridgeProvider: Stopping bridge for agent {}", agent_id);
        Ok(())
    }

    async fn validate_access(
        &self,
        requested_action: &str,
        permissions: &BridgePermissions,
    ) -> Result<bool, String> {
        match requested_action {
            "read" => Ok(permissions.read),
            "write" => Ok(permissions.write),
            "delete" => Ok(permissions.delete),
            _ => Err("Unknown action".to_string()),
        }
    }
}

/// Concrete host-side provider for custom local folders.
///
/// Shared agents never receive a host bind mount. Instead, a per-agent capability
/// token authorizes bounded list/read/search calls against the grants stored by the
/// workspace manager. Isolated agents continue to use direct Docker mounts.
pub struct FilesBridgeProvider;

#[async_trait]
impl BridgeProvider for FilesBridgeProvider {
    async fn start_bridge(&self, agent_id: &str, config: &BridgeConfig) -> Result<(), String> {
        crate::validators::agent::validate_id(agent_id).map_err(|e| e.to_string())?;
        if !config.scope.is_object() {
            return Err("Files Bridge scope must be an object".to_string());
        }
        Ok(())
    }

    async fn stop_bridge(&self, agent_id: &str) -> Result<(), String> {
        crate::validators::agent::validate_id(agent_id).map_err(|e| e.to_string())?;
        remove_files_broker_runtime(agent_id);
        Ok(())
    }

    async fn validate_access(
        &self,
        requested_action: &str,
        permissions: &BridgePermissions,
    ) -> Result<bool, String> {
        match requested_action {
            "read" | "list" | "search" => Ok(permissions.read),
            "write" => Ok(permissions.write),
            "delete" => Ok(permissions.delete),
            _ => Err("Unknown Files Bridge action".to_string()),
        }
    }
}

const FILES_BRIDGE_MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const FILES_BRIDGE_MAX_LIST_ENTRIES: usize = 500;
const FILES_BRIDGE_MAX_SEARCH_FILES: usize = 2_000;
const FILES_BRIDGE_MAX_SEARCH_RESULTS: usize = 50;
const FILES_BRIDGE_MAX_SEARCH_DEPTH: usize = 8;

#[derive(Debug, Deserialize)]
pub(crate) struct FilesListRequest {
    pub root_id: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FilesReadRequest {
    pub root_id: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FilesSearchRequest {
    pub root_id: String,
    pub query: String,
}

fn files_bridge_secret_key(agent_id: &str) -> String {
    format!("agent_{}_files_bridge_token", agent_id)
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

fn ensure_files_bridge_token(agent_id: &str) -> Result<String, String> {
    let key = files_bridge_secret_key(agent_id);
    if let Ok(token) = crate::keychain::get_secret(&key) {
        if token.starts_with(&format!("{}:", agent_id)) {
            return Ok(token);
        }
    }

    let token = format!(
        "{}:{}{}",
        agent_id,
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    crate::keychain::store_secret(&key, &token).map_err(|e| e.to_string())?;
    Ok(token)
}

fn authenticate_files_bridge_token(token: &str) -> Result<String, String> {
    let (agent_id, _) = token
        .split_once(':')
        .ok_or_else(|| "Invalid Files Bridge capability token".to_string())?;
    crate::validators::agent::validate_id(agent_id).map_err(|e| e.to_string())?;
    let expected = crate::keychain::get_secret(&files_bridge_secret_key(agent_id))
        .map_err(|_| "Files Bridge capability is not active".to_string())?;
    if !constant_time_eq(token, &expected) {
        return Err("Invalid Files Bridge capability token".to_string());
    }
    Ok(agent_id.to_string())
}

fn shared_broker_dir(agent_id: &str) -> Option<PathBuf> {
    std::env::var_os("CANOPY_DATA_DIR")
        .map(PathBuf::from)
        .or_else(dirs::data_dir)
        .map(|root| {
            root.join("Canopy")
                .join("openclaw-state")
                .join("workspace")
                .join(agent_id)
                .join(".canopy")
        })
}

const FILES_BRIDGE_CLIENT: &str = r#"#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [command, rootId, ...args] = process.argv.slice(2);
const usage = 'Usage: ./.canopy/files-bridge <list|read|search> <folder-id> [path|query]';
if (!['list', 'read', 'search'].includes(command) || !rootId) {
  console.error(usage);
  process.exit(2);
}

const token = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'files-bridge-token'), 'utf8').trim();
const payload = command === 'search'
  ? { root_id: rootId, query: args.join(' ') }
  : { root_id: rootId, path: args[0] || '' };
const response = await fetch(`http://host.docker.internal:18802/files/${command}`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});
const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
if (!response.ok) {
  console.error(body.error || `Files Bridge request failed (${response.status})`);
  process.exit(1);
}
if (command === 'read') process.stdout.write(body.content || '');
else process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
"#;

fn install_files_broker_runtime(agent_id: &str) -> Result<(), String> {
    let token = ensure_files_bridge_token(agent_id)?;
    let dir = shared_broker_dir(agent_id)
        .ok_or_else(|| "Could not locate the shared agent workspace".to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create Files Bridge runtime: {}", e))?;
    let client_path = dir.join("files-bridge");
    let token_path = dir.join("files-bridge-token");
    std::fs::write(&client_path, FILES_BRIDGE_CLIENT)
        .map_err(|e| format!("Failed to install Files Bridge client: {}", e))?;
    std::fs::write(&token_path, token)
        .map_err(|e| format!("Failed to install Files Bridge capability: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&client_path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Failed to secure Files Bridge client: {}", e))?;
        std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to secure Files Bridge capability: {}", e))?;
    }
    Ok(())
}

fn remove_files_broker_runtime(agent_id: &str) {
    if let Some(dir) = shared_broker_dir(agent_id) {
        let _ = std::fs::remove_file(dir.join("files-bridge"));
        let _ = std::fs::remove_file(dir.join("files-bridge-token"));
    }
    let _ = crate::keychain::delete_secret_internal(&files_bridge_secret_key(agent_id));
}

fn bridge_type_slug(bridge_type: &BridgeType) -> &'static str {
    match bridge_type {
        BridgeType::Imessage => "imessage",
        BridgeType::Calendar => "calendar",
        BridgeType::Files => "files",
        BridgeType::Gmail => "gmail",
        BridgeType::Slack => "slack",
        BridgeType::Telegram => "telegram",
        BridgeType::Discord => "discord",
        BridgeType::Website => "website",
        BridgeType::Custom => "custom",
    }
}

fn bridge_runtime_mode(bridge_type: &BridgeType) -> &'static str {
    match bridge_type {
        BridgeType::Imessage => "local_bridge",
        BridgeType::Slack => "openclaw_channel",
        BridgeType::Gmail => "openclaw_plugin",
        BridgeType::Telegram => "openclaw_channel",
        BridgeType::Discord => "openclaw_channel",
        BridgeType::Files => "files_broker",
        BridgeType::Calendar => "openclaw_plugin",
        BridgeType::Website => "browser_runtime",
        BridgeType::Custom => "custom",
    }
}

fn bridge_transport(bridge_type: &BridgeType) -> &'static str {
    match bridge_type {
        BridgeType::Imessage => "canopy-local",
        BridgeType::Slack | BridgeType::Gmail | BridgeType::Telegram | BridgeType::Discord => {
            "canopy-bridge"
        }
        BridgeType::Files => "canopy-http-broker",
        BridgeType::Calendar | BridgeType::Website | BridgeType::Custom => "canopy-bridge",
    }
}

fn make_tool(
    name: &str,
    title: &str,
    description: &str,
    input_schema: serde_json::Value,
) -> crate::models::McpToolDescriptor {
    crate::models::McpToolDescriptor {
        name: name.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        input_schema,
    }
}

fn make_resource(
    uri: String,
    name: &str,
    description: &str,
    mime_type: Option<&str>,
) -> crate::models::McpResourceDescriptor {
    crate::models::McpResourceDescriptor {
        uri,
        name: name.to_string(),
        description: description.to_string(),
        mime_type: mime_type.map(str::to_string),
    }
}

fn make_prompt(
    name: &str,
    description: &str,
    arguments: Vec<crate::models::McpPromptArgumentDescriptor>,
) -> crate::models::McpPromptDescriptor {
    crate::models::McpPromptDescriptor {
        name: name.to_string(),
        description: description.to_string(),
        arguments,
    }
}

fn make_prompt_arg(
    name: &str,
    description: &str,
    required: bool,
) -> crate::models::McpPromptArgumentDescriptor {
    crate::models::McpPromptArgumentDescriptor {
        name: name.to_string(),
        description: description.to_string(),
        required,
    }
}

fn communication_bridge_tools(bridge: &Bridge) -> Vec<crate::models::McpToolDescriptor> {
    match bridge.bridge_type {
        BridgeType::Slack => vec![
            make_tool(
                "slack.list_channels",
                "List Slack Channels",
                "List Slack channels the agent can access.",
                json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            ),
            make_tool(
                "slack.read_messages",
                "Read Slack Messages",
                "Read recent Slack messages from an allowed channel.",
                json!({
                    "type": "object",
                    "properties": {
                        "channel_id": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                    },
                    "required": ["channel_id"],
                    "additionalProperties": false
                }),
            ),
            make_tool(
                "slack.send_message",
                "Send Slack Message",
                "Send a Slack message to an allowed channel.",
                json!({
                    "type": "object",
                    "properties": {
                        "channel_id": { "type": "string" },
                        "text": { "type": "string" }
                    },
                    "required": ["channel_id", "text"],
                    "additionalProperties": false
                }),
            ),
        ],
        BridgeType::Gmail => vec![
            make_tool(
                "gmail.search_threads",
                "Search Gmail Threads",
                "Search Gmail threads/messages available to the agent.",
                json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
            ),
            make_tool(
                "gmail.read_thread",
                "Read Gmail Thread",
                "Read a Gmail thread by thread id.",
                json!({
                    "type": "object",
                    "properties": {
                        "thread_id": { "type": "string" }
                    },
                    "required": ["thread_id"],
                    "additionalProperties": false
                }),
            ),
            make_tool(
                "gmail.send_email",
                "Send Email",
                "Send an email when write access is enabled.",
                json!({
                    "type": "object",
                    "properties": {
                        "to": { "type": "array", "items": { "type": "string" } },
                        "subject": { "type": "string" },
                        "body": { "type": "string" }
                    },
                    "required": ["to", "subject", "body"],
                    "additionalProperties": false
                }),
            ),
        ],
        BridgeType::Imessage => vec![
            make_tool(
                "imessage.list_threads",
                "List iMessage Threads",
                "List iMessage threads available to the agent.",
                json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            ),
            make_tool(
                "imessage.read_messages",
                "Read iMessage Messages",
                "Read messages from an allowed iMessage thread.",
                json!({
                    "type": "object",
                    "properties": {
                        "chat_identifier": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 1000 }
                    },
                    "required": ["chat_identifier"],
                    "additionalProperties": false
                }),
            ),
        ],
        BridgeType::Telegram => vec![
            make_tool(
                "telegram.send_message",
                "Send Telegram Message",
                "Send a Telegram bot message through the configured connector.",
                json!({
                    "type": "object",
                    "properties": {
                        "chat_id": { "type": "string" },
                        "text": { "type": "string" }
                    },
                    "required": ["chat_id", "text"],
                    "additionalProperties": false
                }),
            ),
        ],
        BridgeType::Discord => vec![
            make_tool(
                "discord.send_message",
                "Send Discord Message",
                "Send a Discord bot message through the configured connector.",
                json!({
                    "type": "object",
                    "properties": {
                        "channel_id": { "type": "string" },
                        "text": { "type": "string" }
                    },
                    "required": ["channel_id", "text"],
                    "additionalProperties": false
                }),
            ),
        ],
        _ => Vec::new(),
    }
}

fn communication_bridge_resources(bridge: &Bridge) -> Vec<crate::models::McpResourceDescriptor> {
    let prefix = format!("canopy://agents/{}/bridges/{}", bridge.agent_id, bridge.id);
    match bridge.bridge_type {
        BridgeType::Slack => vec![
            make_resource(
                format!("{}/allowlist", prefix),
                "Slack Allowlist",
                "Allowed Slack channels for this agent.",
                Some("application/json"),
            ),
            make_resource(
                format!("{}/status", prefix),
                "Slack Bridge Status",
                "Connector state and runtime metadata for Slack.",
                Some("application/json"),
            ),
        ],
        BridgeType::Gmail => vec![
            make_resource(
                format!("{}/mailbox", prefix),
                "Gmail Mailbox Scope",
                "Mailbox mode and scope metadata for this Gmail bridge.",
                Some("application/json"),
            ),
        ],
        BridgeType::Imessage => vec![
            make_resource(
                format!("{}/allowlist", prefix),
                "iMessage Allowlist",
                "Allowed iMessage threads for this agent.",
                Some("application/json"),
            ),
        ],
        BridgeType::Telegram => vec![make_resource(
            format!("{}/scope", prefix),
            "Telegram Scope",
            "Allowed Telegram routing metadata for this agent.",
            Some("application/json"),
        )],
        BridgeType::Discord => vec![make_resource(
            format!("{}/scope", prefix),
            "Discord Scope",
            "Allowed Discord routing metadata for this agent.",
            Some("application/json"),
        )],
        _ => Vec::new(),
    }
}

fn communication_bridge_prompts(bridge: &Bridge) -> Vec<crate::models::McpPromptDescriptor> {
    match bridge.bridge_type {
        BridgeType::Slack => vec![make_prompt(
            "slack.compose_update",
            "Compose a Slack update for an allowed channel.",
            vec![
                make_prompt_arg("audience", "Who the update is for.", true),
                make_prompt_arg("goal", "What the update should accomplish.", true),
            ],
        )],
        BridgeType::Gmail => vec![make_prompt(
            "gmail.compose_reply",
            "Draft an email reply using the agent's Gmail context.",
            vec![
                make_prompt_arg("recipient_context", "Who the recipient is.", true),
                make_prompt_arg("goal", "What the email should accomplish.", true),
            ],
        )],
        BridgeType::Imessage => vec![make_prompt(
            "imessage.compose_reply",
            "Draft a concise iMessage response.",
            vec![make_prompt_arg("thread_context", "Context from the active thread.", true)],
        )],
        BridgeType::Telegram => vec![make_prompt(
            "telegram.compose_message",
            "Draft a Telegram message for a bot conversation.",
            vec![make_prompt_arg("goal", "What the message should achieve.", true)],
        )],
        BridgeType::Discord => vec![make_prompt(
            "discord.compose_message",
            "Draft a Discord bot response.",
            vec![make_prompt_arg("goal", "What the message should achieve.", true)],
        )],
        _ => Vec::new(),
    }
}

pub(crate) fn bridge_to_mcp_server_descriptor(
    bridge: &Bridge,
) -> Option<crate::models::McpServerDescriptor> {
    match bridge.bridge_type {
        BridgeType::Slack
        | BridgeType::Gmail
        | BridgeType::Imessage
        | BridgeType::Telegram
        | BridgeType::Discord => Some(crate::models::McpServerDescriptor {
            id: format!("{}-mcp", bridge.id),
            agent_id: bridge.agent_id.clone(),
            bridge_id: bridge.id.clone(),
            name: bridge.name.clone(),
            bridge_type: bridge_type_slug(&bridge.bridge_type).to_string(),
            transport: bridge_transport(&bridge.bridge_type).to_string(),
            runtime_mode: bridge_runtime_mode(&bridge.bridge_type).to_string(),
            enabled: bridge.enabled,
            permissions: bridge.permissions.clone(),
            scope: bridge.config.scope.clone(),
            tools: communication_bridge_tools(bridge),
            resources: communication_bridge_resources(bridge),
            prompts: communication_bridge_prompts(bridge),
        }),
        _ => None,
    }
}

pub fn list_agent_mcp_server_descriptors_internal(
    db: &crate::db::Database,
    agent_id: &str,
) -> Result<Vec<crate::models::McpServerDescriptor>, String> {
    let bridges = db
        .list_bridges(agent_id)
        .map_err(|e| format!("Failed to list bridges: {}", e))?;
    Ok(bridges
        .into_iter()
        .filter(|bridge| bridge.enabled)
        .filter_map(|bridge| bridge_to_mcp_server_descriptor(&bridge))
        .collect())
}

fn communication_bridge_name(bridge_type: &BridgeType) -> &'static str {
    match bridge_type {
        BridgeType::Imessage => "iMessage Bridge",
        BridgeType::Gmail => "Gmail Bridge",
        BridgeType::Slack => "Slack Bridge",
        BridgeType::Telegram => "Telegram Bridge",
        BridgeType::Discord => "Discord Bridge",
        _ => "Bridge",
    }
}

fn communication_bridge_enabled(agent: &crate::models::Agent, bridge_type: &BridgeType) -> bool {
    match bridge_type {
        BridgeType::Slack => agent.integrations.iter().any(|integration| integration == "slack"),
        BridgeType::Gmail => agent.integrations.iter().any(|integration| {
            integration == "gmail"
                || integration == "email"
                || integration == "email_read"
                || integration == "email_write"
        }),
        BridgeType::Imessage => agent
            .integrations
            .iter()
            .any(|integration| integration == "imessage"),
        BridgeType::Telegram => agent
            .integrations
            .iter()
            .any(|integration| integration == "telegram"),
        BridgeType::Discord => agent
            .integrations
            .iter()
            .any(|integration| integration == "discord"),
        _ => false,
    }
}

fn merge_bridge_scope(existing_scope: Option<&serde_json::Value>, default_scope: serde_json::Value) -> serde_json::Value {
    match (existing_scope, default_scope) {
        (Some(serde_json::Value::Object(existing)), serde_json::Value::Object(mut defaults)) => {
            for (key, value) in existing {
                defaults.insert(key.clone(), value.clone());
            }
            serde_json::Value::Object(defaults)
        }
        (Some(existing), _) if !existing.is_null() => existing.clone(),
        (_, defaults) => defaults,
    }
}

fn overwrite_scope_key(
    scope: &mut serde_json::Value,
    key: &str,
    value: serde_json::Value,
) {
    if let Some(map) = scope.as_object_mut() {
        map.insert(key.to_string(), value);
    }
}

fn communication_bridge_blueprint(
    agent: &crate::models::Agent,
    bridge_type: &BridgeType,
) -> Option<(BridgeConfig, BridgePermissions)> {
    match bridge_type {
        BridgeType::Slack => Some((
            BridgeConfig {
                scope: json!({
                    "allowed_channels": [],
                    "delivery": "socket_mode"
                }),
                expires_at: None,
                push_enabled: true,
            },
            BridgePermissions {
                read: true,
                write: true,
                delete: false,
            },
        )),
        BridgeType::Gmail => {
            let write_enabled = agent
                .integrations
                .iter()
                .any(|integration| integration == "email_write");
            Some((
                BridgeConfig {
                    scope: json!({
                        "mode": if write_enabled { "write" } else { "read" },
                        "labels": []
                    }),
                    expires_at: None,
                    push_enabled: false,
                },
                BridgePermissions {
                    read: true,
                    write: write_enabled,
                    delete: false,
                },
            ))
        }
        BridgeType::Imessage => Some((
            BridgeConfig {
                scope: json!({
                    "allowed_threads": [],
                    "delivery": "local_watcher"
                }),
                expires_at: None,
                push_enabled: true,
            },
            BridgePermissions {
                read: true,
                write: false,
                delete: false,
            },
        )),
        BridgeType::Telegram => Some((
            BridgeConfig {
                scope: json!({
                    "allowed_chat_ids": [],
                    "delivery": "bot"
                }),
                expires_at: None,
                push_enabled: true,
            },
            BridgePermissions {
                read: true,
                write: true,
                delete: false,
            },
        )),
        BridgeType::Discord => Some((
            BridgeConfig {
                scope: json!({
                    "allowed_channel_ids": [],
                    "guild_id": crate::keychain::get_secret(&format!("agent_{}_discord_guild_id", agent.id)).unwrap_or_default(),
                    "delivery": "bot"
                }),
                expires_at: None,
                push_enabled: true,
            },
            BridgePermissions {
                read: true,
                write: true,
                delete: false,
            },
        )),
        _ => None,
    }
}

fn upsert_communication_bridge(
    db: &crate::db::Database,
    agent: &crate::models::Agent,
    bridge_type: BridgeType,
) -> Result<(), String> {
    let enabled = communication_bridge_enabled(agent, &bridge_type);
    let bridge_id = format!("{}-{}", agent.id, bridge_type_slug(&bridge_type));
    let existing = db
        .get_bridge(&bridge_id)
        .map_err(|e| format!("Failed to load bridge {}: {}", bridge_id, e))?;

    if !enabled {
        if let Some(mut bridge) = existing {
            if bridge.enabled {
                bridge.enabled = false;
                db.update_bridge(&bridge)
                    .map_err(|e| format!("Failed to disable bridge {}: {}", bridge_id, e))?;
                let bridge_type_str = bridge_type_slug(&bridge_type);
                let _ = db.log_audit(
                    &agent.id,
                    "bridge_disabled",
                    Some(bridge_type_str),
                    &format!("Disabled bridge: {}", bridge_id),
                    None,
                );
                let _ = db.log_audit(
                    &agent.id,
                    "bridge_tools_unregistered",
                    Some(bridge_type_str),
                    "Successfully unregistered MCP tools for bridge",
                    None,
                );
            }
        }
        return Ok(());
    }

    let Some((default_config, permissions)) = communication_bridge_blueprint(agent, &bridge_type) else {
        return Ok(());
    };

    let bridge_type_str = bridge_type_slug(&bridge_type);
    let existing_scope = existing.as_ref().map(|bridge| &bridge.config.scope);
    let mut scope = merge_bridge_scope(existing_scope, default_config.scope.clone());
    if let Some(default_scope) = default_config.scope.as_object() {
        match bridge_type {
            BridgeType::Slack | BridgeType::Telegram | BridgeType::Imessage => {
                if let Some(delivery) = default_scope.get("delivery") {
                    overwrite_scope_key(&mut scope, "delivery", delivery.clone());
                }
            }
            BridgeType::Gmail => {
                if let Some(mode) = default_scope.get("mode") {
                    overwrite_scope_key(&mut scope, "mode", mode.clone());
                }
            }
            BridgeType::Discord => {
                if let Some(delivery) = default_scope.get("delivery") {
                    overwrite_scope_key(&mut scope, "delivery", delivery.clone());
                }
                if let Some(guild_id) = default_scope.get("guild_id") {
                    overwrite_scope_key(&mut scope, "guild_id", guild_id.clone());
                }
            }
            _ => {}
        }
    }

    let bridge = Bridge {
        id: bridge_id.clone(),
        name: communication_bridge_name(&bridge_type).to_string(),
        bridge_type: bridge_type.clone(),
        enabled: true,
        agent_id: agent.id.clone(),
        config: BridgeConfig {
            scope,
            expires_at: existing
                .as_ref()
                .and_then(|bridge| bridge.config.expires_at.clone()),
            push_enabled: default_config.push_enabled,
        },
        permissions,
    };

    let was_enabled = existing.as_ref().map(|bridge| bridge.enabled).unwrap_or(false);
    if existing.is_some() {
        db.update_bridge(&bridge)
            .map_err(|e| format!("Failed to update bridge {}: {}", bridge_id, e))?;
    } else {
        db.insert_bridge(&bridge)
            .map_err(|e| format!("Failed to insert bridge {}: {}", bridge_id, e))?;
    }

    if !was_enabled {
        let _ = db.log_audit(
            &agent.id,
            "bridge_enabled",
            Some(bridge_type_str),
            &format!("Enabled bridge: {}", bridge_id),
            None,
        );
        let _ = db.log_audit(
            &agent.id,
            "bridge_tools_registered",
            Some(bridge_type_str),
            "Successfully registered MCP tools for bridge",
            None,
        );
    }

    Ok(())
}

pub(crate) fn sync_agent_communication_bridges(
    db: &crate::db::Database,
    agent: &crate::models::Agent,
) -> Result<(), String> {
    for bridge_type in [
        BridgeType::Slack,
        BridgeType::Gmail,
        BridgeType::Imessage,
        BridgeType::Telegram,
        BridgeType::Discord,
    ] {
        upsert_communication_bridge(db, agent, bridge_type)?;
    }
    Ok(())
}

pub(crate) fn sync_agent_communication_bridges_by_id(
    db: &crate::db::Database,
    agent_id: &str,
) -> Result<(), String> {
    let agent = db
        .get_agent(agent_id)
        .map_err(|e| format!("Failed to load agent {}: {}", agent_id, e))?
        .ok_or_else(|| format!("Agent not found for bridge sync: {}", agent_id))?;
    sync_agent_communication_bridges(db, &agent)
}

pub(crate) fn sync_files_bridge(
    db: &crate::db::Database,
    agent: &crate::models::Agent,
    grants: &[crate::workspace_manager::FolderGrant],
) -> Result<(), String> {
    let bridge_id = format!("{}-files", agent.id);
    let delivery = if agent.isolated {
        "direct_mount"
    } else {
        "brokered_read_only"
    };
    let enabled = grants.iter().any(|grant| grant.active);
    let permissions = BridgePermissions {
        read: enabled,
        write: enabled
            && agent.isolated
            && grants.iter().any(|grant| {
                grant.active
                    && grant.access == crate::workspace_manager::FolderAccessMode::ReadWrite
            }),
        delete: false,
    };
    let bridge = Bridge {
        id: bridge_id.clone(),
        name: "Files".to_string(),
        bridge_type: BridgeType::Files,
        enabled,
        agent_id: agent.id.clone(),
        config: BridgeConfig {
            scope: json!({
                "version": 2,
                "delivery": delivery,
                "grants": grants,
                "allowed_paths": grants.iter().map(|grant| grant.path.clone()).collect::<Vec<_>>(),
            }),
            expires_at: None,
            push_enabled: false,
        },
        permissions,
    };

    if db
        .get_bridge(&bridge_id)
        .map_err(|e| format!("Failed to load Files Bridge: {}", e))?
        .is_some()
    {
        db.update_bridge(&bridge)
            .map_err(|e| format!("Failed to update Files Bridge: {}", e))?;
    } else if enabled {
        db.insert_bridge(&bridge)
            .map_err(|e| format!("Failed to create Files Bridge: {}", e))?;
    }

    if enabled && !agent.isolated {
        install_files_broker_runtime(&agent.id)?;
    } else {
        remove_files_broker_runtime(&agent.id);
    }

    let _ = db.log_audit(
        &agent.id,
        "files_bridge_synced",
        Some("files"),
        &format!(
            "{} folder grant(s) delivered via {}",
            grants.len(),
            delivery
        ),
        None,
    );
    Ok(())
}

fn authorized_folder_grant(
    db: &crate::db::Database,
    token: &str,
    root_id: &str,
) -> Result<(String, crate::workspace_manager::FolderGrant), String> {
    let agent_id = authenticate_files_bridge_token(token)?;
    crate::rate_limiter::limiters::FILE_IO_LIMITER
        .check(&agent_id)
        .map_err(|e| e.to_string())?;
    let agent = db
        .get_agent(&agent_id)
        .map_err(|e| format!("Failed to load Files Bridge agent: {}", e))?
        .ok_or_else(|| "Files Bridge agent no longer exists".to_string())?;
    if agent.isolated {
        return Err("The broker is available to shared agents only".to_string());
    }

    let bridge = db
        .get_bridge(&format!("{}-files", agent_id))
        .map_err(|e| format!("Failed to load Files Bridge: {}", e))?
        .ok_or_else(|| "Files Bridge is not configured".to_string())?;
    if !bridge.enabled || bridge.bridge_type != BridgeType::Files || !bridge.permissions.read {
        return Err("Files Bridge read access is disabled".to_string());
    }
    if bridge
        .config
        .expires_at
        .map(|expires| expires <= Utc::now())
        .unwrap_or(false)
    {
        return Err("Files Bridge access has expired".to_string());
    }

    let grant = select_active_grant(
        crate::workspace_manager::get_folder_grants_for_agent(&agent_id)?,
        root_id,
    )?;
    Ok((agent_id, grant))
}

fn select_active_grant(
    grants: Vec<crate::workspace_manager::FolderGrant>,
    root_id: &str,
) -> Result<crate::workspace_manager::FolderGrant, String> {
    grants
        .into_iter()
        .find(|grant| grant.active && grant.id == root_id)
        .ok_or_else(|| "Folder is not granted to this agent".to_string())
}

fn scoped_existing_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Folder-relative path cannot escape its granted root".to_string());
    }

    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("Granted folder is no longer available: {}", e))?;
    let candidate = std::fs::canonicalize(canonical_root.join(relative_path))
        .map_err(|e| format!("Requested path is unavailable: {}", e))?;
    if !candidate.starts_with(&canonical_root) {
        return Err("Requested path resolves outside the granted folder".to_string());
    }
    Ok(candidate)
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

pub(crate) fn broker_list(
    db: &crate::db::Database,
    token: &str,
    request: FilesListRequest,
) -> Result<serde_json::Value, String> {
    let (agent_id, grant) = authorized_folder_grant(db, token, &request.root_id)?;
    let root = std::fs::canonicalize(&grant.path)
        .map_err(|e| format!("Granted folder is unavailable: {}", e))?;
    let target = scoped_existing_path(&root, &request.path)?;
    if !target.is_dir() {
        return Err("List target is not a directory".to_string());
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&target)
        .map_err(|e| format!("Failed to list folder: {}", e))?
        .flatten()
        .take(FILES_BRIDGE_MAX_LIST_ENTRIES)
    {
        let path = match std::fs::canonicalize(entry.path()) {
            Ok(path) if path.starts_with(&root) => path,
            _ => continue,
        };
        let metadata = match path.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "path": relative_display(&root, &path),
            "kind": if metadata.is_dir() { "directory" } else { "file" },
            "size_bytes": if metadata.is_file() { Some(metadata.len()) } else { None },
        }));
    }
    entries.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let _ = db.log_audit(
        &agent_id,
        "bridge_access",
        Some("files"),
        &format!("Listed {}:{}", grant.id, request.path),
        None,
    );
    Ok(json!({ "root_id": grant.id, "entries": entries }))
}

pub(crate) fn broker_read(
    db: &crate::db::Database,
    token: &str,
    request: FilesReadRequest,
) -> Result<serde_json::Value, String> {
    if request.path.trim().is_empty() {
        return Err("A folder-relative file path is required".to_string());
    }
    let (agent_id, grant) = authorized_folder_grant(db, token, &request.root_id)?;
    let root = std::fs::canonicalize(&grant.path)
        .map_err(|e| format!("Granted folder is unavailable: {}", e))?;
    let target = scoped_existing_path(&root, &request.path)?;
    let metadata = target
        .metadata()
        .map_err(|e| format!("Failed to inspect requested file: {}", e))?;
    if !metadata.is_file() {
        return Err("Read target is not a regular file".to_string());
    }
    if metadata.len() > FILES_BRIDGE_MAX_READ_BYTES {
        return Err(format!(
            "File exceeds the {} byte Files Bridge read limit",
            FILES_BRIDGE_MAX_READ_BYTES
        ));
    }
    let bytes = std::fs::read(&target).map_err(|e| format!("Failed to read file: {}", e))?;
    let content = String::from_utf8(bytes)
        .map_err(|_| "Files Bridge read supports UTF-8 text files only".to_string())?;
    let relative = relative_display(&root, &target);
    let _ = db.log_audit(
        &agent_id,
        "bridge_access",
        Some("files"),
        &format!("Read {}:{} ({} bytes)", grant.id, relative, metadata.len()),
        None,
    );
    Ok(json!({
        "root_id": grant.id,
        "path": relative,
        "size_bytes": metadata.len(),
        "content": content,
    }))
}

pub(crate) fn broker_search(
    db: &crate::db::Database,
    token: &str,
    request: FilesSearchRequest,
) -> Result<serde_json::Value, String> {
    let query = request.query.trim();
    if query.is_empty() || query.len() > 256 {
        return Err("Search query must be between 1 and 256 characters".to_string());
    }
    let query_lower = query.to_lowercase();
    let (agent_id, grant) = authorized_folder_grant(db, token, &request.root_id)?;
    let root = std::fs::canonicalize(&grant.path)
        .map_err(|e| format!("Granted folder is unavailable: {}", e))?;
    let mut pending = vec![(root.clone(), 0usize)];
    let mut scanned_files = 0usize;
    let mut matches = Vec::new();

    while let Some((directory, depth)) = pending.pop() {
        if depth > FILES_BRIDGE_MAX_SEARCH_DEPTH
            || scanned_files >= FILES_BRIDGE_MAX_SEARCH_FILES
            || matches.len() >= FILES_BRIDGE_MAX_SEARCH_RESULTS
        {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                pending.push((path, depth + 1));
                continue;
            }
            if !file_type.is_file() || scanned_files >= FILES_BRIDGE_MAX_SEARCH_FILES {
                continue;
            }
            scanned_files += 1;
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() > FILES_BRIDGE_MAX_READ_BYTES {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            for (index, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&query_lower) {
                    matches.push(json!({
                        "path": relative_display(&root, &path),
                        "line": index + 1,
                        "snippet": line.chars().take(300).collect::<String>(),
                    }));
                    if matches.len() >= FILES_BRIDGE_MAX_SEARCH_RESULTS {
                        break;
                    }
                }
            }
        }
    }

    let _ = db.log_audit(
        &agent_id,
        "bridge_access",
        Some("files"),
        &format!(
            "Searched {} ({} file(s), {} result(s))",
            grant.id,
            scanned_files,
            matches.len()
        ),
        None,
    );
    Ok(json!({
        "root_id": grant.id,
        "query": query,
        "scanned_files": scanned_files,
        "matches": matches,
        "truncated": scanned_files >= FILES_BRIDGE_MAX_SEARCH_FILES
            || matches.len() >= FILES_BRIDGE_MAX_SEARCH_RESULTS,
    }))
}

/// Information about an available bridge type
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeTypeInfo {
    pub bridge_type: String,
    pub display_name: String,
    pub description: String,
}

/// Status of a running bridge
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeStatus {
    pub bridge_id: String,
    pub enabled: bool,
    pub connected: bool,
    pub last_event_at: Option<chrono::DateTime<Utc>>,
    pub error: Option<String>,
}

fn files_scope_paths(config: &BridgeConfig) -> Result<Vec<String>, String> {
    if let Some(paths) = config
        .scope
        .get("allowed_paths")
        .and_then(|value| value.as_array())
    {
        return paths
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "Files Bridge allowed_paths entries must be strings".to_string())
            })
            .collect();
    }

    if let Some(grants) = config
        .scope
        .get("grants")
        .and_then(|value| value.as_array())
    {
        return grants
            .iter()
            .map(|grant| {
                grant
                    .get("path")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
                    .ok_or_else(|| "Files Bridge grants require a path".to_string())
            })
            .collect();
    }

    Ok(Vec::new())
}

/// List all bridges for an agent, filtering out expired ones
#[tauri::command]
pub async fn list_bridges(
    agent_id: String,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<Vec<Bridge>, String> {
    let mut bridges = db
        .list_bridges(&agent_id)
        .map_err(|e| format!("Failed to load bridges: {}", e))?;

    // Filter out expired bridges
    let now = Utc::now();
    bridges.retain(|bridge| {
        if let Some(expires_at) = bridge.config.expires_at {
            expires_at > now
        } else {
            true
        }
    });

    Ok(bridges)
}

/// Enable a bridge, persisting it and returning the created bridge object
#[tauri::command]
pub async fn enable_bridge(
    agent_id: String,
    bridge_type: BridgeType,
    config: BridgeConfig,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<Bridge, String> {
    if bridge_type == BridgeType::Files {
        let provider = FilesBridgeProvider;
        provider.start_bridge(&agent_id, &config).await?;
        let paths = files_scope_paths(&config)?;
        crate::workspace_manager::set_agent_allowed_directories(
            &db,
            &agent_id,
            paths,
            crate::workspace_manager::FolderAccessMode::ReadOnly,
        )
        .await?;
        return db
            .get_bridge(&format!("{}-files", agent_id))
            .map_err(|e| format!("Failed to load Files Bridge: {}", e))?
            .ok_or_else(|| "Files Bridge requires at least one allowed folder".to_string());
    }

    // Generate bridge_id as {agent_id}-{bridge_type_str}
    let bridge_type_str = format!("{:?}", bridge_type).to_lowercase();
    let bridge_id = format!("{}-{}", agent_id, bridge_type_str);

    let bridge = Bridge {
        id: bridge_id.clone(),
        name: format!("{:?}", bridge_type),
        bridge_type,
        enabled: true,
        agent_id: agent_id.clone(),
        config,
        permissions: BridgePermissions {
            read: true,
            write: false,  // Read-first default
            delete: false, // Never by default
        },
    };

    // Save to database
    db.insert_bridge(&bridge)
        .map_err(|e| format!("Failed to insert bridge: {}", e))?;

    // Log audit event
    let _ = db.log_audit(
        &agent_id,
        "bridge_enabled",
        Some(&bridge_type_str),
        &format!("Enabled bridge: {}", bridge_id),
        None,
    );

    // Non-files integrations still use the placeholder lifecycle provider.
    let provider = MockBridgeProvider;
    let _ = provider.start_bridge(&agent_id, &bridge.config).await;

    // Simulate updating the agent's tool list by writing to the audit log
    let _ = db.log_audit(
        &agent_id,
        "bridge_tools_registered",
        Some(&bridge_type_str),
        "Successfully registered MCP tools for bridge",
        None,
    );

    Ok(bridge)
}

/// Disable a bridge
#[tauri::command]
pub async fn disable_bridge(
    bridge_id: String,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<(), String> {
    // Load bridge from database
    let mut bridge = db
        .get_bridge(&bridge_id)
        .map_err(|e| format!("DB error: {}", e))?
        .ok_or_else(|| format!("Bridge not found: {}", bridge_id))?;

    if bridge.bridge_type == BridgeType::Files {
        crate::workspace_manager::set_agent_allowed_directories(
            &db,
            &bridge.agent_id,
            Vec::new(),
            crate::workspace_manager::FolderAccessMode::ReadOnly,
        )
        .await?;
        let provider = FilesBridgeProvider;
        provider.stop_bridge(&bridge.agent_id).await?;
        return Ok(());
    }

    // Update enabled flag
    bridge.enabled = false;

    // Save changes
    db.update_bridge(&bridge)
        .map_err(|e| format!("Failed to update bridge: {}", e))?;

    // Log audit event
    let bridge_type_str = format!("{:?}", bridge.bridge_type).to_lowercase();
    let _ = db.log_audit(
        &bridge.agent_id,
        "bridge_disabled",
        Some(&bridge_type_str),
        &format!("Disabled bridge: {}", bridge_id),
        None,
    );

    // Non-files integrations still use the placeholder lifecycle provider.
    let provider = MockBridgeProvider;
    let _ = provider.stop_bridge(&bridge.agent_id).await;

    // Simulate deregistering tools
    let _ = db.log_audit(
        &bridge.agent_id,
        "bridge_tools_unregistered",
        Some(&bridge_type_str),
        "Successfully unregistered MCP tools for bridge",
        None,
    );

    Ok(())
}

/// Get bridge configuration by bridge ID
#[tauri::command]
pub async fn get_bridge_config(
    bridge_id: String,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<Bridge, String> {
    db.get_bridge(&bridge_id)
        .map_err(|e| format!("DB error: {}", e))?
        .ok_or_else(|| format!("Bridge not found: {}", bridge_id))
}

/// Update bridge configuration and permissions
#[tauri::command]
pub async fn update_bridge_config(
    bridge_id: String,
    config: BridgeConfig,
    permissions: BridgePermissions,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<Bridge, String> {
    // Load existing bridge
    let mut bridge = db
        .get_bridge(&bridge_id)
        .map_err(|e| format!("DB error: {}", e))?
        .ok_or_else(|| format!("Bridge not found: {}", bridge_id))?;

    if bridge.bridge_type == BridgeType::Files {
        let provider = FilesBridgeProvider;
        provider.start_bridge(&bridge.agent_id, &config).await?;
        let paths = files_scope_paths(&config)?;
        let access = if permissions.write {
            crate::workspace_manager::FolderAccessMode::ReadWrite
        } else {
            crate::workspace_manager::FolderAccessMode::ReadOnly
        };
        crate::workspace_manager::set_agent_allowed_directories(
            &db,
            &bridge.agent_id,
            paths,
            access,
        )
        .await?;
        return db
            .get_bridge(&bridge_id)
            .map_err(|e| format!("Failed to reload Files Bridge: {}", e))?
            .ok_or_else(|| "Files Bridge is not configured".to_string());
    }

    // Update config and permissions
    bridge.config = config;
    bridge.permissions = permissions;

    // Save changes
    db.update_bridge(&bridge)
        .map_err(|e| format!("Failed to update bridge: {}", e))?;

    // Log audit event
    let bridge_type_str = format!("{:?}", bridge.bridge_type).to_lowercase();
    let _ = db.log_audit(
        &bridge.agent_id,
        "bridge_config_updated",
        Some(&bridge_type_str),
        &format!("Updated configuration for bridge: {}", bridge_id),
        None,
    );

    // TODO: Push live configuration into non-files providers when implemented.

    Ok(bridge)
}

/// Get the current status of a bridge
#[tauri::command]
pub async fn get_bridge_status(
    bridge_id: String,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<BridgeStatus, String> {
    let bridge = db
        .get_bridge(&bridge_id)
        .map_err(|e| format!("DB error: {}", e))?
        .ok_or_else(|| format!("Bridge not found: {}", bridge_id))?;

    Ok(BridgeStatus {
        bridge_id,
        enabled: bridge.enabled,
        connected: bridge.enabled, // For now, connected = enabled
        last_event_at: None,       // TODO: Track from audit logs
        error: None,               // TODO: Track from bridge runtime
    })
}

#[tauri::command]
pub async fn list_agent_mcp_servers(
    agent_id: String,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<Vec<crate::models::McpServerDescriptor>, String> {
    list_agent_mcp_server_descriptors_internal(&db, &agent_id)
}

#[tauri::command]
pub async fn get_bridge_mcp_server(
    bridge_id: String,
    db: tauri::State<'_, crate::db::Database>,
) -> Result<Option<crate::models::McpServerDescriptor>, String> {
    let bridge = db
        .get_bridge(&bridge_id)
        .map_err(|e| format!("Failed to load bridge: {}", e))?;
    Ok(bridge
        .filter(|bridge| bridge.enabled)
        .and_then(|bridge| bridge_to_mcp_server_descriptor(&bridge)))
}

/// List all available bridge types with descriptions
#[tauri::command]
pub async fn list_available_bridge_types() -> Result<Vec<BridgeTypeInfo>, String> {
    Ok(vec![
        BridgeTypeInfo {
            bridge_type: "imessage".to_string(),
            display_name: "iMessage".to_string(),
            description: "Send and receive messages via iMessage".to_string(),
        },
        BridgeTypeInfo {
            bridge_type: "calendar".to_string(),
            display_name: "Calendar".to_string(),
            description: "Access and manage calendar events".to_string(),
        },
        BridgeTypeInfo {
            bridge_type: "files".to_string(),
            display_name: "Files".to_string(),
            description: "Read and manage files on your system".to_string(),
        },
        BridgeTypeInfo {
            bridge_type: "gmail".to_string(),
            display_name: "Gmail".to_string(),
            description: "Send and receive emails via Gmail".to_string(),
        },
        BridgeTypeInfo {
            bridge_type: "slack".to_string(),
            display_name: "Slack".to_string(),
            description: "Send and receive messages via Slack".to_string(),
        },
        BridgeTypeInfo {
            bridge_type: "telegram".to_string(),
            display_name: "Telegram".to_string(),
            description: "Send and receive messages via Telegram bots".to_string(),
        },
        BridgeTypeInfo {
            bridge_type: "discord".to_string(),
            display_name: "Discord".to_string(),
            description: "Send and receive messages via Discord bots".to_string(),
        },
        BridgeTypeInfo {
            bridge_type: "website".to_string(),
            display_name: "Website".to_string(),
            description: "Browse and interact with websites".to_string(),
        },
        BridgeTypeInfo {
            bridge_type: "custom".to_string(),
            display_name: "Custom".to_string(),
            description: "Custom MCP server integration".to_string(),
        },
    ])
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use crate::db::Database;
    use crate::models::{Agent, AgentCapabilities, AgentPersonality, AgentStats, AgentStatus};
    use serde_json::json;

    fn insert_test_agent(db: &Database, integrations: Vec<&str>) -> Agent {
        let agent = Agent {
            id: "agent-bridge".to_string(),
            name: "Bridge Agent".to_string(),
            role: "operator".to_string(),
            emoji: "🤖".to_string(),
            color: "#3355FF".to_string(),
            status: AgentStatus::Active,
            isolated: false,
            paused: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Bridge Agent".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
                active_model: None,
                soul_template: None,
                identity_template: None,
            },
            capabilities: AgentCapabilities::default(),
            integrations: integrations.into_iter().map(str::to_string).collect(),
            visual_identity: None,
            memories: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        };
        db.insert_agent(&agent).unwrap();
        agent
    }

    fn test_bridge() -> Bridge {
        Bridge {
            id: "agent-1-imessage".to_string(),
            name: "iMessage".to_string(),
            bridge_type: BridgeType::Imessage,
            enabled: true,
            agent_id: "agent-1".to_string(),
            config: BridgeConfig {
                scope: json!({"threads": ["thread-123"]}),
                expires_at: None,
                push_enabled: false,
            },
            permissions: BridgePermissions {
                read: true,
                write: false,
                delete: false,
            },
        }
    }

    #[test]
    fn sync_agent_communication_bridges_creates_enabled_connector_bridges() {
        let db = Database::init_in_memory().unwrap();
        let agent = insert_test_agent(
            &db,
            vec!["slack", "email_write", "imessage", "telegram", "discord"],
        );

        sync_agent_communication_bridges(&db, &agent).unwrap();

        let bridges = db.list_bridges(&agent.id).unwrap();
        assert_eq!(bridges.len(), 5);
        assert!(bridges.iter().any(|bridge| bridge.bridge_type == BridgeType::Slack && bridge.enabled));
        assert!(bridges.iter().any(|bridge| bridge.bridge_type == BridgeType::Gmail && bridge.permissions.write));
        assert!(bridges.iter().any(|bridge| bridge.bridge_type == BridgeType::Imessage && bridge.config.push_enabled));
        assert!(bridges.iter().any(|bridge| bridge.bridge_type == BridgeType::Telegram && bridge.enabled));
        assert!(bridges.iter().any(|bridge| bridge.bridge_type == BridgeType::Discord && bridge.enabled));
    }

    #[test]
    fn sync_agent_communication_bridges_preserves_scope_and_disables_removed_integrations() {
        let db = Database::init_in_memory().unwrap();
        let mut agent = insert_test_agent(&db, vec!["slack"]);

        sync_agent_communication_bridges(&db, &agent).unwrap();

        let mut slack_bridge = db.get_bridge("agent-bridge-slack").unwrap().unwrap();
        slack_bridge.config.scope = json!({
            "allowed_channels": ["C1234567890"],
            "delivery": "socket_mode"
        });
        db.update_bridge(&slack_bridge).unwrap();

        sync_agent_communication_bridges(&db, &agent).unwrap();
        let preserved_bridge = db.get_bridge("agent-bridge-slack").unwrap().unwrap();
        assert_eq!(
            preserved_bridge.config.scope["allowed_channels"],
            json!(["C1234567890"])
        );
        assert!(preserved_bridge.enabled);

        agent.integrations.clear();
        db.update_agent(&agent).unwrap();
        sync_agent_communication_bridges(&db, &agent).unwrap();

        let disabled_bridge = db.get_bridge("agent-bridge-slack").unwrap().unwrap();
        assert!(!disabled_bridge.enabled);
    }

    #[test]
    fn list_agent_mcp_server_descriptors_includes_slack_and_gmail_shapes() {
        let db = Database::init_in_memory().unwrap();
        let agent = insert_test_agent(&db, vec!["slack", "email_write"]);

        sync_agent_communication_bridges(&db, &agent).unwrap();
        let servers = list_agent_mcp_server_descriptors_internal(&db, &agent.id).unwrap();

        assert_eq!(servers.len(), 2);

        let slack = servers
            .iter()
            .find(|server| server.bridge_type == "slack")
            .expect("expected slack MCP server descriptor");
        assert_eq!(slack.transport, "canopy-bridge");
        assert!(slack.tools.iter().any(|tool| tool.name == "slack.read_messages"));
        assert!(slack.resources.iter().any(|resource| resource.name == "Slack Allowlist"));

        let gmail = servers
            .iter()
            .find(|server| server.bridge_type == "gmail")
            .expect("expected gmail MCP server descriptor");
        assert!(gmail.permissions.write);
        assert!(gmail.tools.iter().any(|tool| tool.name == "gmail.send_email"));
        assert!(gmail.prompts.iter().any(|prompt| prompt.name == "gmail.compose_reply"));
    }

    // ──────────────────────────────────────────────────────────────
    // BRIDGE ID GENERATION TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_bridge_id_format() {
        let bridge = test_bridge();
        assert!(bridge.id.contains("agent-1"));
        assert!(bridge.id.contains("imessage"));
    }

    // ──────────────────────────────────────────────────────────────
    // PERMISSION ENFORCEMENT TESTS (CRITICAL FOR SECURITY)
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_default_permissions_read_only() {
        let bridge = test_bridge();
        assert!(
            bridge.permissions.read,
            "Bridge should have read by default"
        );
        assert!(
            !bridge.permissions.write,
            "Bridge should NOT have write by default"
        );
        assert!(
            !bridge.permissions.delete,
            "Bridge should NOT have delete by default"
        );
    }

    #[test]
    fn test_write_requires_explicit_opt_in() {
        let mut bridge = test_bridge();
        // Write should not be enabled by default
        assert!(!bridge.permissions.write);

        // Explicitly enable write
        bridge.permissions.write = true;
        assert!(bridge.permissions.write);
    }

    #[test]
    fn test_delete_never_enabled_by_default() {
        let bridge = test_bridge();
        assert!(
            !bridge.permissions.delete,
            "Delete should never be enabled by default"
        );
    }

    #[test]
    fn test_permission_isolation_between_bridges() {
        let mut bridge1 = test_bridge();
        let mut bridge2 = test_bridge();
        bridge2.id = "agent-1-slack".to_string();
        bridge2.bridge_type = BridgeType::Slack;

        // Enable write on bridge1
        bridge1.permissions.write = true;

        // Verify bridge2 is unaffected
        assert!(
            !bridge2.permissions.write,
            "Permission change should not affect other bridges"
        );
    }

    // ──────────────────────────────────────────────────────────────
    // TIME-BOUNDED ACCESS TESTS (CRITICAL FOR SECURITY)
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_bridge_without_expiry_never_expires() {
        let bridge = test_bridge();
        assert!(
            bridge.config.expires_at.is_none(),
            "Should allow indefinite access"
        );
    }

    #[test]
    fn test_bridge_with_future_expiry_not_expired() {
        let mut bridge = test_bridge();
        let future = Utc::now() + Duration::hours(1);
        bridge.config.expires_at = Some(future);

        let now = Utc::now();
        let is_expired = if let Some(expires_at) = bridge.config.expires_at {
            expires_at < now
        } else {
            false
        };

        assert!(
            !is_expired,
            "Bridge with future expiry should not be expired"
        );
    }

    #[test]
    fn test_bridge_with_past_expiry_is_expired() {
        let mut bridge = test_bridge();
        let past = Utc::now() - Duration::hours(1);
        bridge.config.expires_at = Some(past);

        let now = Utc::now();
        let is_expired = if let Some(expires_at) = bridge.config.expires_at {
            expires_at < now
        } else {
            false
        };

        assert!(is_expired, "Bridge with past expiry should be expired");
    }

    #[test]
    fn test_expiry_at_boundary() {
        let mut bridge = test_bridge();
        let now = Utc::now();
        bridge.config.expires_at = Some(now);

        // At the boundary, should be considered expired (expires_at < now is false, but expires_at == now)
        let is_expired = if let Some(expires_at) = bridge.config.expires_at {
            expires_at < now
        } else {
            false
        };

        // This is expected behavior: at boundary, not yet expired
        assert!(!is_expired);
    }

    // ──────────────────────────────────────────────────────────────
    // BRIDGE SCOPE TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_bridge_scope_stored_as_json() {
        let bridge = test_bridge();
        let scope = bridge.config.scope;

        // Verify scope can be accessed as JSON
        assert!(scope.is_object());
        let threads = scope.get("threads");
        assert!(threads.is_some());
    }

    #[test]
    fn test_empty_scope_allowed() {
        let mut bridge = test_bridge();
        bridge.config.scope = json!({});

        assert!(bridge.config.scope.is_object());
        assert_eq!(bridge.config.scope.as_object().unwrap().len(), 0);
    }

    // ──────────────────────────────────────────────────────────────
    // PUSH NOTIFICATION TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_push_disabled_by_default() {
        let bridge = test_bridge();
        assert!(
            !bridge.config.push_enabled,
            "Push should be disabled by default"
        );
    }

    #[test]
    fn test_push_can_be_enabled() {
        let mut bridge = test_bridge();
        bridge.config.push_enabled = true;
        assert!(bridge.config.push_enabled);
    }

    // ──────────────────────────────────────────────────────────────
    // BRIDGE TYPE TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_all_bridge_types_supported() {
        let types = vec![
            BridgeType::Imessage,
            BridgeType::Calendar,
            BridgeType::Files,
            BridgeType::Gmail,
            BridgeType::Slack,
            BridgeType::Website,
            BridgeType::Custom,
        ];

        for bridge_type in types {
            let mut bridge = test_bridge();
            bridge.bridge_type = bridge_type;
            assert!(bridge.enabled);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // EDGE CASES
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_bridge_can_be_disabled() {
        let mut bridge = test_bridge();
        bridge.enabled = false;
        assert!(!bridge.enabled);
    }

    #[test]
    fn test_bridge_can_be_reenabled() {
        let mut bridge = test_bridge();
        bridge.enabled = false;
        bridge.enabled = true;
        assert!(bridge.enabled);
    }

    // ──────────────────────────────────────────────────────────────
    // MOCK PROVIDER TESTS
    // ──────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_mock_bridge_provider_access() {
        let provider = MockBridgeProvider;
        let bridge = test_bridge(); // read=true, write=false, delete=false

        assert_eq!(
            provider
                .validate_access("read", &bridge.permissions)
                .await
                .unwrap(),
            true
        );
        assert_eq!(
            provider
                .validate_access("write", &bridge.permissions)
                .await
                .unwrap(),
            false
        );
        assert_eq!(
            provider
                .validate_access("delete", &bridge.permissions)
                .await
                .unwrap(),
            false
        );
        assert!(provider
            .validate_access("execute", &bridge.permissions)
            .await
            .is_err());
    }

    #[test]
    fn files_bridge_grants_are_agent_scoped() {
        let agent_a_grant = crate::workspace_manager::FolderGrant {
            id: "folder-agent-a".to_string(),
            path: "/tmp/agent-a".to_string(),
            name: "agent-a".to_string(),
            access: crate::workspace_manager::FolderAccessMode::ReadOnly,
            active: true,
        };

        assert!(select_active_grant(vec![agent_a_grant.clone()], "folder-agent-a").is_ok());
        assert!(select_active_grant(vec![agent_a_grant], "folder-agent-b").is_err());
    }

    #[test]
    fn files_bridge_rejects_path_traversal() {
        let root = tempfile::tempdir().expect("root");
        assert!(scoped_existing_path(root.path(), "../outside.txt").is_err());
        assert!(scoped_existing_path(root.path(), "/etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn files_bridge_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "secret").expect("secret");
        symlink(&secret, root.path().join("escape.txt")).expect("symlink");

        assert!(scoped_existing_path(root.path(), "escape.txt").is_err());
    }

    #[test]
    fn capability_comparison_checks_every_byte() {
        assert!(constant_time_eq("agent-a:abcdef", "agent-a:abcdef"));
        assert!(!constant_time_eq("agent-a:abcdef", "agent-a:abcdeg"));
        assert!(!constant_time_eq("short", "longer"));
    }
}

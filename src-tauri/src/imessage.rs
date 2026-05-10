use rusqlite::{params, Connection, Result as SqlResult};
use std::time::SystemTime;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tracing::{error, info, warn, debug};

use crate::db::Database;
use tauri::Emitter;

// ─── Apple Date Format Constants ─────────────────────────────────────────────

/// Apple uses nanoseconds since 2001-01-01 00:00:00 UTC
/// Unix epoch is 1970-01-01 00:00:00 UTC
/// The difference is 978,307,200 seconds
const APPLE_TO_UNIX_EPOCH_OFFSET: i64 = 978_307_200;

// ─── Data Types ─────────────────────────────────────────────────────────────

/// Represents a single message in iMessage
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMessage {
    pub id: i64,
    pub chat_identifier: String,
    pub sender: String,
    pub text: String,
    pub date: String, // RFC3339 timestamp
    pub is_from_me: bool,
    pub has_attachment: bool,
}

/// Represents an iMessage thread/conversation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMessageThread {
    pub chat_identifier: String,
    pub display_name: String,
    pub last_message_date: String, // RFC3339 timestamp
    pub message_count: i64,
}

// ─── iMessage Bridge State ──────────────────────────────────────────────────

/// Manages file watching and real-time updates (reserved for future use)
#[allow(dead_code)]
pub struct IMessageWatcher {
    running: std::sync::Mutex<bool>,
    last_poll: std::sync::Mutex<DateTime<Utc>>,
}

#[allow(dead_code)]
impl IMessageWatcher {
    pub fn new() -> Self {
        Self {
            running: std::sync::Mutex::new(false),
            last_poll: std::sync::Mutex::new(Utc::now()),
        }
    }
}

// ─── Helper Functions ───────────────────────────────────────────────────────

/// Convert Apple timestamp (nanoseconds since 2001-01-01) to RFC3339 string
fn apple_timestamp_to_rfc3339(apple_nanos: i64) -> String {
    // Convert nanoseconds to seconds
    let apple_seconds = apple_nanos / 1_000_000_000;
    // Convert Apple epoch to Unix epoch
    let unix_seconds = apple_seconds + APPLE_TO_UNIX_EPOCH_OFFSET;

    match DateTime::<Utc>::from_timestamp(unix_seconds, 0) {
        Some(dt) => dt.to_rfc3339(),
        None => {
            // Fallback for invalid timestamps
            warn!("Invalid Apple timestamp: {}, using current time", apple_nanos);
            Utc::now().to_rfc3339()
        }
    }
}

/// Parse RFC3339 timestamp string
fn parse_rfc3339(timestamp_str: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(timestamp_str)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Get the path to Apple's iMessage database
fn get_imessage_db_path() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        home.join("Library/Messages/chat.db")
    } else {
        PathBuf::from("~/Library/Messages/chat.db")
    }
}

/// Check if we have Full Disk Access permission
#[allow(dead_code)]
fn check_imessage_readable() -> bool {
    // Try to actually open the iMessage database
    open_imessage_db().is_ok()
}

/// Open Apple's iMessage database in read-only mode
fn open_imessage_db() -> Result<Connection, String> {
    let db_path = get_imessage_db_path();

    debug!("Opening iMessage database at: {:?}", db_path);

    if !db_path.exists() {
        return Err(format!(
            "iMessage database not found at {:?}. macOS may not have iMessage enabled.",
            db_path
        ));
    }

    // Open in read-only mode — never write to Apple's database
    Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
        .map_err(|e| {
            debug!("Failed to open iMessage database: {}", e);
            format!(
                "Cannot access iMessage database. Error: {}. Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access.",
                e
            )
        })
}

// ─── Core iMessage Operations ──────────────────────────────────────────────

/// Read all iMessage threads from the database
fn query_imessage_threads() -> Result<Vec<IMessageThread>, String> {
    let conn = open_imessage_db()?;

    let mut stmt = conn
        .prepare(
            "SELECT
                c.chat_identifier,
                c.display_name,
                MAX(m.date) as last_date,
                COUNT(m.ROWID) as message_count
             FROM chat c
             LEFT JOIN chat_message_join cmj ON c.ROWID = cmj.chat_id
             LEFT JOIN message m ON cmj.message_id = m.ROWID
             GROUP BY c.chat_identifier
             ORDER BY last_date DESC
             NULLS LAST",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let threads = stmt
        .query_map([], |row| {
            let chat_identifier: String = row.get(0)?;
            let display_name: String = row.get(1)?;
            let last_date_opt: Option<i64> = row.get(2)?;
            let message_count: i64 = row.get(3).unwrap_or(0);

            let last_message_date = if let Some(apple_nanos) = last_date_opt {
                apple_timestamp_to_rfc3339(apple_nanos)
            } else {
                Utc::now().to_rfc3339()
            };

            Ok(IMessageThread {
                chat_identifier,
                display_name,
                last_message_date,
                message_count,
            })
        })
        .map_err(|e| format!("Failed to execute query: {}", e))?
        .collect::<SqlResult<Vec<_>>>()
        .map_err(|e| format!("Failed to collect results: {}", e))?;

    info!("Found {} iMessage threads", threads.len());
    Ok(threads)
}

/// Read messages from a specific iMessage thread
fn query_imessage_messages(
    chat_identifier: &str,
    since_opt: Option<DateTime<Utc>>,
    limit: u32,
) -> Result<Vec<IMessage>, String> {
    let conn = open_imessage_db()?;

    let mut stmt = conn
        .prepare(
            "SELECT
                m.ROWID,
                c.chat_identifier,
                h.id as sender,
                m.text,
                m.date,
                m.is_from_me,
                (SELECT COUNT(*) FROM message_attachment_join maj
                 WHERE maj.message_id = m.ROWID) > 0 as has_attachment
             FROM message m
             JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
             JOIN chat c ON cmj.chat_id = c.ROWID
             LEFT JOIN handle h ON m.handle_id = h.ROWID
             WHERE c.chat_identifier = ?1
             ORDER BY m.date DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let mut messages: Vec<IMessage> = stmt
        .query_map(params![chat_identifier, limit as i32], |row| {
            let id: i64 = row.get(0)?;
            let chat_id: String = row.get(1)?;
            let sender: String = row.get::<_, Option<String>>(2)?.unwrap_or_else(|| "unknown".to_string());
            let text: String = row.get::<_, Option<String>>(3)?.unwrap_or_default();
            let apple_nanos: i64 = row.get(4)?;
            let is_from_me: bool = row.get(5)?;
            let has_attachment: bool = row.get(6)?;

            Ok(IMessage {
                id,
                chat_identifier: chat_id,
                sender,
                text,
                date: apple_timestamp_to_rfc3339(apple_nanos),
                is_from_me,
                has_attachment,
            })
        })
        .map_err(|e| format!("Failed to execute query: {}", e))?
        .collect::<SqlResult<Vec<_>>>()
        .map_err(|e| format!("Failed to collect results: {}", e))?;

    // Filter by since date if provided
    if let Some(since) = since_opt {
        messages.retain(|msg| {
            if let Some(msg_date) = parse_rfc3339(&msg.date) {
                msg_date >= since
            } else {
                true // Keep if we can't parse
            }
        });
    }

    // Reverse to get chronological order (oldest first)
    messages.reverse();

    debug!("Found {} messages for thread {}", messages.len(), chat_identifier);
    Ok(messages)
}

// ─── Allowlist Management ──────────────────────────────────────────────────

/// Get allowed iMessage threads for an agent
fn get_allowlist_from_db(
    db: &Database,
    agent_id: &str,
) -> Result<Vec<String>, String> {
    // Try to find the iMessage bridge for this agent
    // The bridge ID follows the pattern: "{agent_id}-imessage"
    let bridge_id = format!("{}-imessage", agent_id);

    match db.get_bridge(&bridge_id) {
        Ok(Some(bridge)) => {
            // Extract allowlist from config.scope
            if let Some(allowlist) = bridge.config.scope.get("allowed_threads") {
                if let Ok(identifiers) = serde_json::from_value::<Vec<String>>(allowlist.clone()) {
                    return Ok(identifiers);
                }
            }
            // If no allowlist is set, return empty (which means allow all threads)
            Ok(vec![])
        }
        Ok(None) => {
            // Bridge doesn't exist yet; no restrictions
            Ok(vec![])
        }
        Err(e) => {
            error!("Database error retrieving iMessage bridge: {}", e);
            // Fail safe: allow all on DB error
            Ok(vec![])
        }
    }
}

/// Store/update allowed iMessage threads for an agent in Canopy's database
fn save_allowlist_to_db(
    db: &Database,
    agent_id: &str,
    chat_identifiers: Vec<String>,
) -> Result<(), String> {
    use crate::models::{Bridge, BridgeType, BridgeConfig, BridgePermissions};

    let bridge_id = format!("{}-imessage", agent_id);

    // Try to fetch existing bridge
    let bridge = match db.get_bridge(&bridge_id) {
        Ok(Some(mut existing)) => {
            // Update existing bridge's config
            existing.config.scope["allowed_threads"] =
                serde_json::to_value(&chat_identifiers)
                    .map_err(|e| format!("JSON serialization error: {}", e))?;
            existing
        }
        Ok(None) => {
            // Create new bridge
            let mut config = BridgeConfig::default();
            config.scope["allowed_threads"] =
                serde_json::to_value(&chat_identifiers)
                    .map_err(|e| format!("JSON serialization error: {}", e))?;

            Bridge {
                id: bridge_id.clone(),
                agent_id: agent_id.to_string(),
                name: "iMessage Bridge".to_string(),
                bridge_type: BridgeType::Imessage,
                enabled: true,
                config,
                permissions: BridgePermissions {
                    read: true,
                    write: false, // Read-only by default
                    delete: false,
                },
            }
        }
        Err(e) => {
            return Err(format!("Database error: {}", e));
        }
    };

    // Save to database
    match db.get_bridge(&bridge_id) {
        Ok(Some(_)) => {
            // Update existing
            db.update_bridge(&bridge)
                .map_err(|e| format!("Failed to update bridge: {}", e))?;
            info!(
                "Updated iMessage allowlist for agent {}: {:?}",
                agent_id, chat_identifiers
            );
        }
        Ok(None) => {
            // Insert new
            db.insert_bridge(&bridge)
                .map_err(|e| format!("Failed to insert bridge: {}", e))?;
            info!(
                "Created iMessage bridge for agent {} with allowlist: {:?}",
                agent_id, chat_identifiers
            );
        }
        Err(e) => {
            return Err(format!("Database check error: {}", e));
        }
    }

    Ok(())
}

/// Check if an agent is allowed to access a specific iMessage thread
fn is_thread_allowed(
    allowlist: &[String],
    chat_identifier: &str,
) -> bool {
    // Empty allowlist means allow all (no restrictions set yet)
    if allowlist.is_empty() {
        return true;
    }

    // Check if chat_identifier is in the allowlist
    allowlist.contains(&chat_identifier.to_string())
}

// ─── Tauri Commands ────────────────────────────────────────────────────────

/// Check if Full Disk Access is granted
#[tauri::command]
pub async fn check_full_disk_access() -> Result<bool, String> {
    let db_path = get_imessage_db_path();

    if !db_path.exists() {
        return Err(
            "iMessage database not found. Ensure macOS has iMessage enabled.".to_string()
        );
    }

    match open_imessage_db() {
        Ok(_) => {
            info!("Full Disk Access is granted for iMessage database");
            Ok(true)
        }
        Err(e) => {
            debug!("Full Disk Access check failed: {}", e);
            Err(format!(
                "Full Disk Access required. Go to System Settings > Privacy & Security > Full Disk Access and add Claude. Error: {}",
                e
            ))
        }
    }
}

/// Open System Settings to the Full Disk Access page
#[tauri::command]
pub async fn open_full_disk_access_settings() -> Result<(), String> {
    // macOS 13+ (Ventura and later) uses the new System Settings deep link URL
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")
        .spawn()
        .map_err(|e| format!("Failed to open system settings: {}", e))?;
    Ok(())
}

/// List all available iMessage threads
#[tauri::command]
pub async fn list_imessage_threads() -> Result<Vec<IMessageThread>, String> {
    query_imessage_threads()
}

/// Read messages from a specific iMessage thread
/// Filters by agent allowlist if configured
#[tauri::command]
pub async fn read_imessage_messages(
    agent_id: String,
    chat_identifier: String,
    since: Option<String>,
    limit: u32,
    db: tauri::State<'_, Database>,
) -> Result<Vec<IMessage>, String> {
    // Validate limit
    let safe_limit = std::cmp::min(limit, 1000);

    // Check allowlist
    let allowlist = get_allowlist_from_db(&db, &agent_id)
        .unwrap_or_default();

    if !is_thread_allowed(&allowlist, &chat_identifier) {
        return Err(format!(
            "Agent {} is not allowed to access thread {}",
            agent_id, chat_identifier
        ));
    }

    // Parse since timestamp if provided
    let since_dt = if let Some(since_str) = since {
        match parse_rfc3339(&since_str) {
            Some(dt) => Some(dt),
            None => {
                return Err(format!("Invalid RFC3339 timestamp: {}", since_str));
            }
        }
    } else {
        None
    };

    let messages = query_imessage_messages(&chat_identifier, since_dt, safe_limit)?;

    info!(
        "Agent {} read {} messages from thread {}",
        agent_id,
        messages.len(),
        chat_identifier
    );

    Ok(messages)
}

/// Get the list of iMessage threads allowed for an agent
#[tauri::command]
pub async fn get_allowed_imessage_threads(
    agent_id: String,
    db: tauri::State<'_, Database>,
) -> Result<Vec<String>, String> {
    get_allowlist_from_db(&db, &agent_id)
}

/// Update the list of iMessage threads allowed for an agent
#[tauri::command]
pub async fn update_allowed_imessage_threads(
    agent_id: String,
    chat_identifiers: Vec<String>,
    db: tauri::State<'_, Database>,
) -> Result<(), String> {
    // Validate that all identifiers exist in iMessage
    let all_threads = query_imessage_threads()?;
    let valid_identifiers: Vec<String> = all_threads
        .iter()
        .map(|t| t.chat_identifier.clone())
        .collect();

    for identifier in &chat_identifiers {
        if !valid_identifiers.contains(identifier) {
            return Err(format!(
                "Invalid chat identifier: {}. Not found in iMessage.",
                identifier
            ));
        }
    }

    // Save to Canopy's database
    save_allowlist_to_db(&db, &agent_id, chat_identifiers)?;

    info!(
        "Updated allowed iMessage threads for agent {}",
        agent_id
    );

    Ok(())
}

// ─── File Watcher for Real-Time Updates ────────────────────────────────────

/// Start watching for iMessage database changes
/// Emits `imessage://new-messages` event on updates
#[tauri::command]
pub async fn start_imessage_watcher(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    info!("Starting iMessage watcher");

    // Spawn background task
    tokio::spawn(async move {
        let db_path = get_imessage_db_path();
        let mut last_poll = Utc::now();
        let mut last_check = SystemTime::now();

        loop {
            // Check every 2 seconds for changes
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            // Check if database file has been modified
            if let Ok(metadata) = std::fs::metadata(&db_path) {
                if let Ok(modified) = metadata.modified() {
                    // If modified after our last check, poll for new messages
                    if modified > last_check {
                        debug!("iMessage database modified, checking for new messages");
                        last_check = SystemTime::now();

                        // Query for new messages since last poll
                        match query_imessage_threads() {
                            Ok(threads) => {
                                // For each thread, get new messages
                                let mut new_messages = Vec::new();

                                for thread in threads {
                                    match parse_rfc3339(&thread.last_message_date) {
                                        Some(last_date) => {
                                            if last_date > last_poll {
                                                // This thread has new messages
                                                if let Ok(messages) = query_imessage_messages(
                                                    &thread.chat_identifier,
                                                    Some(last_poll),
                                                    100,
                                                ) {
                                                    new_messages.extend(messages);
                                                }
                                            }
                                        }
                                        None => continue,
                                    }
                                }

                                if !new_messages.is_empty() {
                                    info!("Found {} new iMessage messages", new_messages.len());

                                    // Emit event to frontend
                                    let _ = app_handle.emit(
                                        "imessage://new-messages",
                                        json!({
                                            "messages": new_messages,
                                            "timestamp": Utc::now().to_rfc3339()
                                        }),
                                    );

                                    last_poll = Utc::now();
                                }
                            }
                            Err(e) => {
                                error!("Error polling iMessage: {}", e);
                            }
                        }
                    }
                }
            } else {
                warn!("Cannot access iMessage database file for monitoring");
                // Wait longer before retrying
                tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
            }
        }
    });

    Ok(())
}

/// Stop the iMessage watcher
#[tauri::command]
pub async fn stop_imessage_watcher() -> Result<(), String> {
    info!("Stopping iMessage watcher");
    // Note: In a production implementation, we'd track the watcher task
    // with a JoinHandle and abort it here. For now, this is a placeholder.
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apple_timestamp_conversion() {
        // 2024-01-01 00:00:00 UTC in Apple format
        // Unix timestamp: 1704067200
        // Apple offset: 978307200
        // Apple seconds: 1704067200 - 978307200 = 725760000
        // Apple nanoseconds: 725760000 * 1_000_000_000
        let apple_nanos = 725_760_000_000_000_000i64;
        let result = apple_timestamp_to_rfc3339(apple_nanos);

        // Should be a valid RFC3339 string
        assert!(result.contains("2024-01-01"));
    }

    #[test]
    fn test_parse_rfc3339() {
        let timestamp = "2024-01-01T00:00:00+00:00";
        let result = parse_rfc3339(timestamp);
        assert!(result.is_some());
    }

    #[test]
    fn test_is_thread_allowed_empty_allowlist() {
        // Empty allowlist means allow all
        assert!(is_thread_allowed(&[], "test@example.com"));
    }

    #[test]
    fn test_is_thread_allowed_specific() {
        let allowlist = vec![
            "alice@example.com".to_string(),
            "bob@example.com".to_string(),
        ];

        assert!(is_thread_allowed(&allowlist, "alice@example.com"));
        assert!(!is_thread_allowed(&allowlist, "charlie@example.com"));
    }

    #[test]
    fn test_imessage_db_path() {
        let path = get_imessage_db_path();
        assert!(path.to_string_lossy().contains("Library/Messages/chat.db"));
    }
}

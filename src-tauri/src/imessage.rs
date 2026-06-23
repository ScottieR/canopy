use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::SystemTime;
use tracing::{debug, error, info, warn};

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
            warn!(
                "Invalid Apple timestamp: {}, using current time",
                apple_nanos
            );
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

fn open_system_settings_targets(targets: &[&str]) -> Result<(), String> {
    let mut last_error = None;

    for target in targets {
        match std::process::Command::new("open").arg(target).status() {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => {
                last_error = Some(format!(
                    "open {} exited with status {}",
                    target, status
                ));
            }
            Err(err) => {
                last_error = Some(format!("open {} failed: {}", target, err));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Failed to open system settings.".to_string()))
}

// ─── Contact Name Resolution ───────────────────────────────────────────────

/// Strip everything except digits from a phone string.
fn digits_only(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Normalise a phone string to a 10-digit US number (no country code).
/// Returns the raw digit string if normalisation doesn't apply.
fn normalize_phone(phone: &str) -> String {
    let digits = digits_only(phone);
    // "+1XXXXXXXXXX" or "1XXXXXXXXXX" → strip leading 1
    if digits.len() == 11 && digits.starts_with('1') {
        digits[1..].to_string()
    } else {
        digits
    }
}

/// Format a raw phone number/identifier into a more readable string.
/// Used as a fallback when we can't resolve a contact name.
fn format_identifier(id: &str) -> String {
    // Email addresses — leave as-is
    if id.contains('@') {
        return id.to_string();
    }
    // Group chat IDs — leave as-is
    if id.starts_with("chat") {
        return id.to_string();
    }
    // Strip non-digits, drop leading country code, format as (XXX) XXX-XXXX
    let digits = digits_only(id);
    let ten = if digits.len() == 11 && digits.starts_with('1') {
        digits[1..].to_string()
    } else {
        digits
    };
    if ten.len() == 10 {
        format!("({}) {}-{}", &ten[0..3], &ten[3..6], &ten[6..10])
    } else {
        id.to_string()
    }
}

/// Try to read the macOS Contacts database and return a map of
/// normalised phone/email → full contact name.
/// Returns an empty map on any failure (no permissions, missing DB, etc.).
fn try_resolve_contact_names() -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return map,
    };

    // macOS stores contacts in one or more source directories under here.
    let sources_dir = home.join("Library/Application Support/Contacts/Sources");
    let db_paths: Vec<PathBuf> = match std::fs::read_dir(&sources_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("AddressBook-v22.abcddb"))
            .filter(|p| p.exists())
            .collect(),
        Err(_) => return map,
    };

    for db_path in &db_paths {
        let conn = match Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // ── Phone numbers ──────────────────────────────────────────────────
        let phone_sql = "
            SELECT p.ZFULLNUMBER, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION
            FROM ZABCDPHONENUMBER p
            JOIN ZABCDRECORD r ON p.ZOWNER = r.Z_PK
            WHERE p.ZFULLNUMBER IS NOT NULL
        ";
        if let Ok(mut stmt) = conn.prepare(phone_sql) {
            let _ = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map(|rows| {
                    for row in rows.filter_map(|r| r.ok()) {
                        if let (Some(phone), first, last, org) = row {
                            let name = build_name(first, last, org);
                            if !name.is_empty() {
                                let norm = normalize_phone(&phone);
                                if !norm.is_empty() {
                                    map.insert(norm, name);
                                }
                            }
                        }
                    }
                });
        }

        // ── Email addresses ────────────────────────────────────────────────
        let email_sql = "
            SELECT e.ZADDRESS, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION
            FROM ZABCDEMAILADDRESS e
            JOIN ZABCDRECORD r ON e.ZOWNER = r.Z_PK
            WHERE e.ZADDRESS IS NOT NULL
        ";
        if let Ok(mut stmt) = conn.prepare(email_sql) {
            let _ = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map(|rows| {
                    for row in rows.filter_map(|r| r.ok()) {
                        if let (Some(email), first, last, org) = row {
                            let name = build_name(first, last, org);
                            if !name.is_empty() {
                                map.insert(email.to_lowercase(), name);
                            }
                        }
                    }
                });
        }; // semicolon forces the Statement temporary to drop before `conn` goes out of scope
    }

    debug!(
        "Resolved {} contacts from macOS Contacts database",
        map.len()
    );
    map
}

/// Combine first/last/org into a display name, preferring personal name over org.
fn build_name(first: Option<String>, last: Option<String>, org: Option<String>) -> String {
    let f = first.unwrap_or_default();
    let l = last.unwrap_or_default();
    let full = format!("{} {}", f, l).trim().to_string();
    if !full.is_empty() {
        return full;
    }
    org.unwrap_or_default().trim().to_string()
}

/// Resolve a chat_identifier to a human-readable display name.
/// Tries contacts lookup first, then formats the number/email, then returns as-is.
fn resolve_display_name(chat_identifier: &str, contacts: &HashMap<String, String>) -> String {
    // 1. Phone number lookup (normalised)
    if !chat_identifier.contains('@') && !chat_identifier.starts_with("chat") {
        let norm = normalize_phone(chat_identifier);
        if let Some(name) = contacts.get(&norm) {
            return name.clone();
        }
        // Also try with full original digits
        let full_digits = digits_only(chat_identifier);
        if let Some(name) = contacts.get(&full_digits) {
            return name.clone();
        }
        // Fallback: format the number nicely
        return format_identifier(chat_identifier);
    }

    // 2. Email lookup
    if chat_identifier.contains('@') {
        if let Some(name) = contacts.get(&chat_identifier.to_lowercase()) {
            return name.clone();
        }
        // Email is already readable — return as-is
        return chat_identifier.to_string();
    }

    // 3. Group chats or anything else — leave as-is
    chat_identifier.to_string()
}

fn normalize_lookup_query(value: &str) -> String {
    value.trim().to_lowercase()
}

fn thread_matches_query(thread: &IMessageThread, query: &str) -> bool {
    let normalized_query = normalize_lookup_query(query);
    if normalized_query.is_empty() {
        return false;
    }

    let identifier = normalize_lookup_query(&thread.chat_identifier);
    let display_name = normalize_lookup_query(&thread.display_name);

    if identifier == normalized_query || display_name == normalized_query {
        return true;
    }

    let query_digits = normalize_phone(query);
    let identifier_digits = normalize_phone(&thread.chat_identifier);
    if !query_digits.is_empty() && query_digits == identifier_digits {
        return true;
    }

    display_name.contains(&normalized_query)
        || identifier.contains(&normalized_query)
        || (!query_digits.is_empty() && identifier_digits.contains(&query_digits))
}

fn resolve_thread_identifier_from_threads(
    threads: &[IMessageThread],
    query: &str,
) -> Result<String, String> {
    let normalized_query = normalize_lookup_query(query);
    if normalized_query.is_empty() {
        return Err("Thread lookup cannot use an empty search query.".to_string());
    }

    if let Some(thread) = threads
        .iter()
        .find(|thread| normalize_lookup_query(&thread.chat_identifier) == normalized_query)
    {
        return Ok(thread.chat_identifier.clone());
    }

    let query_digits = normalize_phone(query);
    if !query_digits.is_empty() {
        if let Some(thread) = threads
            .iter()
            .find(|thread| normalize_phone(&thread.chat_identifier) == query_digits)
        {
            return Ok(thread.chat_identifier.clone());
        }
    }

    if let Some(thread) = threads
        .iter()
        .find(|thread| normalize_lookup_query(&thread.display_name) == normalized_query)
    {
        return Ok(thread.chat_identifier.clone());
    }

    let matches: Vec<&IMessageThread> = threads
        .iter()
        .filter(|thread| thread_matches_query(thread, query))
        .collect();

    match matches.as_slice() {
        [single] => Ok(single.chat_identifier.clone()),
        [] => Err(format!(
            "No iMessage thread matched '{}'. Search by a contact name, group name, email, or phone number from your existing threads.",
            query
        )),
        many => {
            let suggestions = many
                .iter()
                .take(5)
                .map(|thread| {
                    if thread.display_name == thread.chat_identifier {
                        thread.chat_identifier.clone()
                    } else {
                        format!("{} ({})", thread.display_name, thread.chat_identifier)
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            Err(format!(
                "Multiple iMessage threads matched '{}'. Please be more specific. Matches: {}",
                query, suggestions
            ))
        }
    }
}

fn resolve_thread_identifier(query: &str) -> Result<String, String> {
    let threads = query_imessage_threads()?;
    resolve_thread_identifier_from_threads(&threads, query)
}

// ─── Core iMessage Operations ──────────────────────────────────────────────

/// Read all iMessage threads from the database, with contact names resolved.
fn query_imessage_threads() -> Result<Vec<IMessageThread>, String> {
    let conn = open_imessage_db()?;

    // Load contact names once up-front; failures are silently ignored (empty map).
    let contacts = try_resolve_contact_names();

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

    let mut threads = stmt
        .query_map([], |row| {
            let chat_identifier: String = row.get(0)?;
            let display_name_raw: Option<String> = row.get(1)?;
            let last_date_opt: Option<i64> = row.get(2)?;
            let message_count: i64 = row.get(3).unwrap_or(0);

            let last_message_date = if let Some(apple_nanos) = last_date_opt {
                apple_timestamp_to_rfc3339(apple_nanos)
            } else {
                Utc::now().to_rfc3339()
            };

            Ok(IMessageThread {
                // display_name resolved below (after query_map, which can't capture contacts)
                display_name: display_name_raw
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| chat_identifier.clone()),
                chat_identifier,
                last_message_date,
                message_count,
            })
        })
        .map_err(|e| format!("Failed to execute query: {}", e))?
        .collect::<SqlResult<Vec<_>>>()
        .map_err(|e| format!("Failed to collect results: {}", e))?;

    // Resolve display names: use the chat table's display_name for group chats
    // (those have a non-empty name already). For 1:1 threads where display_name
    // == chat_identifier (unresolved), look up the contact name.
    for thread in &mut threads {
        if thread.display_name == thread.chat_identifier {
            thread.display_name = resolve_display_name(&thread.chat_identifier, &contacts);
        }
        // Group chats whose display_name was set by iMessage already look fine;
        // we leave those unchanged.
    }

    info!(
        "Found {} iMessage threads ({} contacts loaded)",
        threads.len(),
        contacts.len()
    );
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
            let sender: String = row
                .get::<_, Option<String>>(2)?
                .unwrap_or_else(|| "unknown".to_string());
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

    debug!(
        "Found {} messages for thread {}",
        messages.len(),
        chat_identifier
    );
    Ok(messages)
}

// ─── Allowlist Management ──────────────────────────────────────────────────

/// Get allowed iMessage threads for an agent
fn get_allowlist_from_db(db: &Database, agent_id: &str) -> Result<Vec<String>, String> {
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
    use crate::models::{Bridge, BridgeConfig, BridgePermissions, BridgeType};

    let bridge_id = format!("{}-imessage", agent_id);

    // Try to fetch existing bridge
    let bridge = match db.get_bridge(&bridge_id) {
        Ok(Some(mut existing)) => {
            // Update existing bridge's config
            existing.config.scope["allowed_threads"] = serde_json::to_value(&chat_identifiers)
                .map_err(|e| format!("JSON serialization error: {}", e))?;
            existing
        }
        Ok(None) => {
            // Create new bridge
            let mut config = BridgeConfig::default();
            config.scope["allowed_threads"] = serde_json::to_value(&chat_identifiers)
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
fn is_thread_allowed(allowlist: &[String], chat_identifier: &str) -> bool {
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
        return Err("iMessage database not found. Ensure macOS has iMessage enabled.".to_string());
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
    // The older `com.apple.preference.security?Privacy_AllFiles` deep link has
    // proven more reliable for landing on the actual Full Disk Access list. We
    // keep the newer Ventura+ URL as a fallback.
    open_system_settings_targets(&[
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
    ])
}

/// Open System Settings to the Photos privacy page.
/// Same pattern as open_full_disk_access_settings — the JS shell plugin
/// rejects x-apple.systempreferences: URLs, so this must go through Rust.
#[tauri::command]
pub async fn open_photos_privacy_settings() -> Result<(), String> {
    open_system_settings_targets(&[
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos",
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Photos",
    ])
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

    let resolved_chat_identifier = resolve_thread_identifier(&chat_identifier)?;

    // Check allowlist
    let allowlist = get_allowlist_from_db(&db, &agent_id).unwrap_or_default();

    if !is_thread_allowed(&allowlist, &resolved_chat_identifier) {
        return Err(format!(
            "Agent {} is not allowed to access thread {}",
            agent_id, resolved_chat_identifier
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

    let messages = query_imessage_messages(&resolved_chat_identifier, since_dt, safe_limit)?;

    info!(
        "Agent {} read {} messages from thread {}",
        agent_id,
        messages.len(),
        resolved_chat_identifier
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

    info!("Updated allowed iMessage threads for agent {}", agent_id);

    Ok(())
}

// ─── File Watcher for Real-Time Updates ────────────────────────────────────

/// Start watching for iMessage database changes
/// Emits `imessage://new-messages` event on updates
#[tauri::command]
pub async fn start_imessage_watcher(app_handle: tauri::AppHandle) -> Result<(), String> {
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

    #[test]
    fn test_resolve_thread_identifier_exact_display_name() {
        let threads = vec![
            IMessageThread {
                chat_identifier: "+15551234567".to_string(),
                display_name: "Mom".to_string(),
                last_message_date: Utc::now().to_rfc3339(),
                message_count: 12,
            },
            IMessageThread {
                chat_identifier: "chat123".to_string(),
                display_name: "Family Group".to_string(),
                last_message_date: Utc::now().to_rfc3339(),
                message_count: 44,
            },
        ];

        let resolved = resolve_thread_identifier_from_threads(&threads, "mom").unwrap();
        assert_eq!(resolved, "+15551234567");
    }

    #[test]
    fn test_resolve_thread_identifier_partial_group_name() {
        let threads = vec![IMessageThread {
            chat_identifier: "chat123".to_string(),
            display_name: "Weekend Planning".to_string(),
            last_message_date: Utc::now().to_rfc3339(),
            message_count: 9,
        }];

        let resolved = resolve_thread_identifier_from_threads(&threads, "planning").unwrap();
        assert_eq!(resolved, "chat123");
    }

    #[test]
    fn test_resolve_thread_identifier_matches_normalized_phone() {
        let threads = vec![IMessageThread {
            chat_identifier: "+1 (555) 123-4567".to_string(),
            display_name: "Alex".to_string(),
            last_message_date: Utc::now().to_rfc3339(),
            message_count: 3,
        }];

        let resolved = resolve_thread_identifier_from_threads(&threads, "5551234567").unwrap();
        assert_eq!(resolved, "+1 (555) 123-4567");
    }

    #[test]
    fn test_resolve_thread_identifier_rejects_ambiguous_name() {
        let threads = vec![
            IMessageThread {
                chat_identifier: "+15551234567".to_string(),
                display_name: "Alex Johnson".to_string(),
                last_message_date: Utc::now().to_rfc3339(),
                message_count: 3,
            },
            IMessageThread {
                chat_identifier: "+15557654321".to_string(),
                display_name: "Alex Chen".to_string(),
                last_message_date: Utc::now().to_rfc3339(),
                message_count: 8,
            },
        ];

        let err = resolve_thread_identifier_from_threads(&threads, "alex").unwrap_err();
        assert!(err.contains("Multiple iMessage threads matched"));
    }
}

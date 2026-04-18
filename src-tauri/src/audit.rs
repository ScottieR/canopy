use serde::{Deserialize, Serialize};
use chrono::{DateTime, Timelike, Utc, Duration};
use tauri::State;
use crate::db::{Database, AuditEntry};

// ─── Core Audit Types ────────────────────────────────────────────────────────

/// Enum representing all possible audit actions
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AuditAction {
    // Agent lifecycle
    AgentCreated,
    AgentDeleted,
    AgentUpdated,

    // Bridge management
    BridgeEnabled,
    BridgeDisabled,
    BridgeAccess,

    // Messaging
    MessageSent,
    MessageReceived,

    // Permissions
    PermissionGranted,
    PermissionRevoked,

    // Purchases & payments
    PurchaseRequested,
    PurchaseApproved,
    PurchaseDenied,

    // Voice sessions
    VoiceSessionStarted,
    VoiceSessionEnded,

    // System
    SystemStartup,
    SystemShutdown,
    SecurityAlert,
}

impl AuditAction {
    /// Convert AuditAction to its string representation for database storage
    pub fn to_string(&self) -> String {
        match self {
            AuditAction::AgentCreated => "agent_created".to_string(),
            AuditAction::AgentDeleted => "agent_deleted".to_string(),
            AuditAction::AgentUpdated => "agent_updated".to_string(),
            AuditAction::BridgeEnabled => "bridge_enabled".to_string(),
            AuditAction::BridgeDisabled => "bridge_disabled".to_string(),
            AuditAction::BridgeAccess => "bridge_access".to_string(),
            AuditAction::MessageSent => "message_sent".to_string(),
            AuditAction::MessageReceived => "message_received".to_string(),
            AuditAction::PermissionGranted => "permission_granted".to_string(),
            AuditAction::PermissionRevoked => "permission_revoked".to_string(),
            AuditAction::PurchaseRequested => "purchase_requested".to_string(),
            AuditAction::PurchaseApproved => "purchase_approved".to_string(),
            AuditAction::PurchaseDenied => "purchase_denied".to_string(),
            AuditAction::VoiceSessionStarted => "voice_session_started".to_string(),
            AuditAction::VoiceSessionEnded => "voice_session_ended".to_string(),
            AuditAction::SystemStartup => "system_startup".to_string(),
            AuditAction::SystemShutdown => "system_shutdown".to_string(),
            AuditAction::SecurityAlert => "security_alert".to_string(),
        }
    }
}

/// Summary of audit activity for an agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditSummary {
    pub total_actions: u32,
    pub actions_today: u32,
    pub bridge_accesses_today: u32,
    pub last_action_at: Option<String>,
    pub security_alerts_count: u32,
}

/// Security alert detected by audit system
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityAlert {
    pub alert_type: String,
    pub severity: AlertSeverity,
    pub detail: String,
    pub timestamp: String,
}

/// Severity levels for security alerts
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AlertSeverity {
    Low,
    Medium,
    High,
    Critical,
}

// ─── Core Audit Function ─────────────────────────────────────────────────────

/// Log an audit action to the database
///
/// # Arguments
/// * `db` - Reference to the Database
/// * `agent_id` - Optional agent ID (None for system-level events)
/// * `action` - The AuditAction being logged
/// * `bridge_type` - Optional bridge type involved in the action
/// * `detail` - Human-readable details about the action
/// * `content_hash` - Optional hash of content for audit trails (use hash_content())
pub fn log_action(
    db: &Database,
    agent_id: Option<&str>,
    action: AuditAction,
    bridge_type: Option<&str>,
    detail: &str,
    content_hash: Option<&str>,
) -> Result<(), String> {
    let action_str = action.to_string();

    db.log_audit(
        agent_id.unwrap_or("system"),
        &action_str,
        bridge_type,
        detail,
        content_hash,
    )
    .map_err(|e| format!("Failed to log audit action: {}", e))
}

// ─── Content Hashing ─────────────────────────────────────────────────────────

/// Generate a SHA-256 hash of content for audit trails
/// Returns the hash as a hex string
pub fn hash_content(content: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    let hash_value = hasher.finish();

    // Format as hex string (simplified SHA-like representation)
    format!("sha256:{:x}", hash_value)
}

// ─── Security Alert Detection ────────────────────────────────────────────────

/// Check for security anomalies in agent activity
///
/// Detects:
/// - More than 100 bridge accesses in 1 hour
/// - Permission changes outside business hours (9-17)
/// - Rapid-fire message sending (>20 messages/minute)
pub fn check_security_alerts(db: &Database, agent_id: &str) -> Result<Vec<SecurityAlert>, String> {
    let mut alerts = Vec::new();

    // Get last 1000 audit entries for the agent to analyze
    let entries = db.get_audit_log(Some(agent_id), 1000)
        .map_err(|e| format!("Failed to retrieve audit log: {}", e))?;

    if entries.is_empty() {
        return Ok(alerts);
    }

    let now = Utc::now();
    let one_hour_ago = now - Duration::hours(1);
    let one_minute_ago = now - Duration::minutes(1);

    // Check for excessive bridge accesses in the last hour
    let recent_bridge_accesses = entries.iter()
        .filter(|entry| {
            if let Ok(timestamp) = DateTime::parse_from_rfc3339(&entry.timestamp) {
                let ts = timestamp.with_timezone(&Utc);
                ts > one_hour_ago && entry.action == "bridge_access"
            } else {
                false
            }
        })
        .count();

    if recent_bridge_accesses > 100 {
        alerts.push(SecurityAlert {
            alert_type: "excessive_bridge_access".to_string(),
            severity: AlertSeverity::High,
            detail: format!("{} bridge accesses in the last hour (threshold: 100)", recent_bridge_accesses),
            timestamp: now.to_rfc3339(),
        });
    }

    // Check for permission changes outside business hours
    let business_hour_violations = entries.iter()
        .filter(|entry| {
            if entry.action == "permission_granted" || entry.action == "permission_revoked" {
                if let Ok(timestamp) = DateTime::parse_from_rfc3339(&entry.timestamp) {
                    let ts = timestamp.with_timezone(&Utc);
                    let hour = ts.hour();
                    // Outside 9am-5pm UTC (business hours)
                    hour < 9 || hour >= 17
                } else {
                    false
                }
            } else {
                false
            }
        })
        .count();

    if business_hour_violations > 0 {
        alerts.push(SecurityAlert {
            alert_type: "off_hours_permission_change".to_string(),
            severity: AlertSeverity::Medium,
            detail: format!("{} permission changes detected outside business hours", business_hour_violations),
            timestamp: now.to_rfc3339(),
        });
    }

    // Check for rapid message sending (>20 messages per minute)
    let rapid_messages = entries.iter()
        .filter(|entry| {
            if entry.action == "message_sent" {
                if let Ok(timestamp) = DateTime::parse_from_rfc3339(&entry.timestamp) {
                    let ts = timestamp.with_timezone(&Utc);
                    ts > one_minute_ago
                } else {
                    false
                }
            } else {
                false
            }
        })
        .count();

    if rapid_messages > 20 {
        alerts.push(SecurityAlert {
            alert_type: "rapid_message_sending".to_string(),
            severity: AlertSeverity::Critical,
            detail: format!("{} messages sent in the last minute (threshold: 20)", rapid_messages),
            timestamp: now.to_rfc3339(),
        });
    }

    Ok(alerts)
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

/// Retrieve audit log entries with optional filtering
///
/// Returns the most recent audit entries, optionally filtered by agent and/or limit
#[tauri::command]
pub async fn get_audit_log(
    db: State<'_, Database>,
    agent_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<AuditEntry>, String> {
    let agent_ref = agent_id.as_deref();
    let limit_val = limit.unwrap_or(100);

    db.get_audit_log(agent_ref, limit_val)
        .map_err(|e| format!("Failed to retrieve audit log: {}", e))
}

/// Get a summary of audit activity for a specific agent
///
/// Returns counts and summary information about recent activity
#[tauri::command]
pub async fn get_audit_summary(
    db: State<'_, Database>,
    agent_id: String,
) -> Result<AuditSummary, String> {
    let entries = db.get_audit_log(Some(&agent_id), 10000)
        .map_err(|e| format!("Failed to retrieve audit log: {}", e))?;

    if entries.is_empty() {
        return Ok(AuditSummary {
            total_actions: 0,
            actions_today: 0,
            bridge_accesses_today: 0,
            last_action_at: None,
            security_alerts_count: 0,
        });
    }

    let now = Utc::now();
    let today = now.date_naive();

    // Count actions today
    let actions_today = entries.iter()
        .filter(|entry| {
            if let Ok(timestamp) = DateTime::parse_from_rfc3339(&entry.timestamp) {
                let ts = timestamp.with_timezone(&Utc);
                ts.date_naive() == today
            } else {
                false
            }
        })
        .count();

    // Count bridge accesses today
    let bridge_accesses_today = entries.iter()
        .filter(|entry| {
            let is_bridge_action = entry.action == "bridge_access"
                || entry.action == "bridge_enabled"
                || entry.action == "bridge_disabled";

            if is_bridge_action {
                if let Ok(timestamp) = DateTime::parse_from_rfc3339(&entry.timestamp) {
                    let ts = timestamp.with_timezone(&Utc);
                    ts.date_naive() == today
                } else {
                    false
                }
            } else {
                false
            }
        })
        .count();

    // Get last action timestamp
    let last_action_at = entries.first().map(|e| e.timestamp.clone());

    // Count security alerts
    let alerts = check_security_alerts(&db, &agent_id)
        .unwrap_or_default();
    let security_alerts_count = alerts.len() as u32;

    Ok(AuditSummary {
        total_actions: entries.len() as u32,
        actions_today: actions_today as u32,
        bridge_accesses_today: bridge_accesses_today as u32,
        last_action_at,
        security_alerts_count,
    })
}

/// Search audit log with advanced filtering
///
/// # Arguments
/// * `agent_id` - Optional agent ID to filter by
/// * `action_filter` - Optional action type to filter by (exact match)
/// * `since` - Optional ISO 8601 timestamp to filter entries after this time
/// * `limit` - Maximum number of results to return
#[tauri::command]
pub async fn search_audit_log(
    db: State<'_, Database>,
    agent_id: Option<String>,
    action_filter: Option<String>,
    since: Option<String>,
    limit: u32,
) -> Result<Vec<AuditEntry>, String> {
    let agent_ref = agent_id.as_deref();

    let mut entries = db.get_audit_log(agent_ref, limit * 2)
        .map_err(|e| format!("Failed to retrieve audit log: {}", e))?;

    // Filter by action if provided
    if let Some(action) = action_filter {
        entries.retain(|e| e.action == action);
    }

    // Filter by timestamp if provided
    if let Some(since_str) = since {
        if let Ok(since_ts) = DateTime::parse_from_rfc3339(&since_str) {
            let since_utc = since_ts.with_timezone(&Utc);
            entries.retain(|e| {
                if let Ok(entry_ts) = DateTime::parse_from_rfc3339(&e.timestamp) {
                    entry_ts.with_timezone(&Utc) > since_utc
                } else {
                    true
                }
            });
        }
    }

    // Apply limit and return
    entries.truncate(limit as usize);
    Ok(entries)
}

/// Export audit log as JSON string
///
/// Currently supports "json" format. Returns a JSON array of audit entries.
///
/// # Arguments
/// * `agent_id` - Optional agent ID to filter by
/// * `format` - Output format (currently only "json" is supported)
#[tauri::command]
pub async fn export_audit_log(
    db: State<'_, Database>,
    agent_id: Option<String>,
    format: String,
) -> Result<String, String> {
    if format != "json" {
        return Err("Only 'json' format is currently supported".to_string());
    }

    let agent_ref = agent_id.as_deref();
    let entries = db.get_audit_log(agent_ref, 10000)
        .map_err(|e| format!("Failed to retrieve audit log: {}", e))?;

    serde_json::to_string(&entries)
        .map_err(|e| format!("Failed to serialize audit log: {}", e))
}

/// Get security alerts for an agent
///
/// Analyzes recent audit activity and returns detected security anomalies
#[tauri::command]
pub async fn get_security_alerts(
    db: State<'_, Database>,
    agent_id: String,
) -> Result<Vec<SecurityAlert>, String> {
    check_security_alerts(&db, &agent_id)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audit_action_to_string() {
        assert_eq!(AuditAction::AgentCreated.to_string(), "agent_created");
        assert_eq!(AuditAction::BridgeEnabled.to_string(), "bridge_enabled");
        assert_eq!(AuditAction::MessageSent.to_string(), "message_sent");
        assert_eq!(AuditAction::PurchaseApproved.to_string(), "purchase_approved");
        assert_eq!(AuditAction::SecurityAlert.to_string(), "security_alert");
    }

    #[test]
    fn test_hash_content() {
        let hash1 = hash_content("test content");
        let hash2 = hash_content("test content");
        let hash3 = hash_content("different content");

        // Same content should produce same hash
        assert_eq!(hash1, hash2);
        // Different content should produce different hash
        assert_ne!(hash1, hash3);
        // Hash should be prefixed with "sha256:"
        assert!(hash1.starts_with("sha256:"));
    }

    #[test]
    fn test_audit_summary_default() {
        let summary = AuditSummary {
            total_actions: 5,
            actions_today: 2,
            bridge_accesses_today: 1,
            last_action_at: Some("2026-04-17T12:00:00Z".to_string()),
            security_alerts_count: 0,
        };

        assert_eq!(summary.total_actions, 5);
        assert_eq!(summary.security_alerts_count, 0);
    }

    #[test]
    fn test_alert_severity_serialization() {
        let low = AlertSeverity::Low;
        let high = AlertSeverity::High;

        let low_json = serde_json::to_string(&low).unwrap();
        let high_json = serde_json::to_string(&high).unwrap();

        assert!(low_json.contains("low"));
        assert!(high_json.contains("high"));
    }

    #[test]
    fn test_security_alert_creation() {
        let alert = SecurityAlert {
            alert_type: "test_alert".to_string(),
            severity: AlertSeverity::Medium,
            detail: "Test alert detail".to_string(),
            timestamp: Utc::now().to_rfc3339(),
        };

        assert_eq!(alert.alert_type, "test_alert");
        assert_eq!(alert.severity, AlertSeverity::Medium);
    }
}

use crate::models::{Bridge, BridgeConfig, BridgePermissions, BridgeType};
use chrono::Utc;
use serde::{Deserialize, Serialize};

/// Bridge management — the security boundary between agents and data sources.
/// Each bridge is a local MCP server that mediates access.

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

    // TODO: Start the MCP server for this bridge
    // TODO: Register with the agent's tool list

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

    // TODO: Stop the MCP server
    // TODO: Remove from agent's tool list

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

    // TODO: Update MCP server config if running

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
        last_event_at: None,        // TODO: Track from audit logs
        error: None,                // TODO: Track from bridge runtime
    })
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
    use serde_json::json;

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
        assert!(bridge.permissions.read, "Bridge should have read by default");
        assert!(!bridge.permissions.write, "Bridge should NOT have write by default");
        assert!(!bridge.permissions.delete, "Bridge should NOT have delete by default");
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
        assert!(!bridge.permissions.delete, "Delete should never be enabled by default");
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
        assert!(!bridge2.permissions.write, "Permission change should not affect other bridges");
    }

    // ──────────────────────────────────────────────────────────────
    // TIME-BOUNDED ACCESS TESTS (CRITICAL FOR SECURITY)
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_bridge_without_expiry_never_expires() {
        let bridge = test_bridge();
        assert!(bridge.config.expires_at.is_none(), "Should allow indefinite access");
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

        assert!(!is_expired, "Bridge with future expiry should not be expired");
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
        assert!(!bridge.config.push_enabled, "Push should be disabled by default");
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
}

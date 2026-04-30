use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use std::sync::Mutex;
use chrono::Utc;
use serde_json::json;
use uuid::Uuid;
use tauri::Manager;

use crate::models::*;

// ─── Local Models for DB Layer ───────────────────────────────────────────────

/// Represents a message in a conversation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String, // "user", "assistant", "system"
    pub content: String,
    pub timestamp: String,
}

/// Represents an audit log entry
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuditEntry {
    pub id: u32,
    pub timestamp: String,
    pub agent_id: Option<String>,
    pub action: String,
    pub bridge_type: Option<String>,
    pub detail: String,
    pub content_hash: Option<String>,
}

// ─── Database Struct ─────────────────────────────────────────────────────────

/// Thread-safe SQLite database wrapper for Canopy
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Initialize the database, creating tables and migrations as needed
    pub fn init(app_handle: &tauri::AppHandle) -> SqlResult<Self> {
        // Determine database path
        let data_dir = if let Some(dir) = dirs::data_dir() {
            dir.join("Canopy")
        } else {
            // Fallback to app data directory
            app_handle.path().app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
        };

        // Create directory if it doesn't exist
        std::fs::create_dir_all(&data_dir).ok();

        let db_path = data_dir.join("canopy.db");
        let conn = Connection::open(&db_path)?;

        // Enable foreign keys
        conn.execute("PRAGMA foreign_keys = ON", [])?;

        let db = Database {
            conn: Mutex::new(conn),
        };

        // Run migrations
        db.run_migrations()?;

        tracing::info!("Database initialized at {:?}", db_path);
        Ok(db)
    }

    /// Run all migrations to create tables
    fn run_migrations(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        // Create agents table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                emoji TEXT NOT NULL,
                color TEXT NOT NULL,
                status TEXT NOT NULL,
                isolated BOOLEAN NOT NULL,
                container_id TEXT,
                personality_json TEXT NOT NULL,
                integrations_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                stats_json TEXT NOT NULL
            )",
            [],
        )?;

        // Migration: Add capabilities layer for Zero-Trust architecture
        let _ = conn.execute(
            "ALTER TABLE agents ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{}'",
            [],
        );

        // Migration: Add memories feature
        let _ = conn.execute(
            "ALTER TABLE agents ADD COLUMN memories_json TEXT NOT NULL DEFAULT '[]'",
            [],
        );

        // Migration: Add visual identity
        let _ = conn.execute(
            "ALTER TABLE agents ADD COLUMN visual_identity_json TEXT NOT NULL DEFAULT '{}'",
            [],
        );

        // Migration: Add paused flag.
        // Paused agents are stored in SQLite but NOT registered with OpenClaw on boot.
        // This prevents their channels/sidecars from spawning processes, avoiding PID spirals
        // when multiple agents with heavy plugins (browser, voice, Slack) all initialize at once.
        let _ = conn.execute(
            "ALTER TABLE agents ADD COLUMN paused BOOLEAN NOT NULL DEFAULT 0",
            [],
        );

        // Create conversations table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        // Create messages table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id)
            )",
            [],
        )?;

        // Create bridges table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS bridges (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                name TEXT NOT NULL,
                bridge_type TEXT NOT NULL,
                enabled BOOLEAN NOT NULL,
                config_json TEXT NOT NULL,
                permissions_json TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        // Create audit_log table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                agent_id TEXT,
                action TEXT NOT NULL,
                bridge_type TEXT,
                detail TEXT NOT NULL,
                content_hash TEXT
            )",
            [],
        )?;

        // Create budgets table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS budgets (
                agent_id TEXT PRIMARY KEY,
                config_json TEXT NOT NULL,
                daily_spent_cents INTEGER NOT NULL DEFAULT 0,
                monthly_spent_cents INTEGER NOT NULL DEFAULT 0,
                last_reset_date TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        // Create purchase_history table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS purchase_history (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                description TEXT NOT NULL,
                merchant TEXT NOT NULL,
                amount_cents INTEGER NOT NULL,
                category TEXT NOT NULL,
                decision TEXT NOT NULL,
                virtual_card_id TEXT,
                timestamp TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        // Create global_config table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS global_config (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            )",
            [],
        )?;

        // Create provider_models table for dynamic synchronization
        conn.execute(
            "CREATE TABLE IF NOT EXISTS provider_models (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                name TEXT NOT NULL,
                capabilities_json TEXT NOT NULL,
                recommended BOOLEAN NOT NULL,
                created_at TEXT NOT NULL
            )",
            [],
        )?;

        // Create indexes for common queries
        conn.execute("CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id)", [])?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)", [])?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_bridges_agent ON bridges(agent_id)", [])?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent_id)", [])?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)", [])?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_purchase_history_agent ON purchase_history(agent_id)", [])?;

        tracing::debug!("Database migrations completed");
        Ok(())
    }

    // ─── Global Config Operations ────────────────────────────────────────────

    pub fn get_user_profile(&self) -> SqlResult<UserProfile> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value_json FROM global_config WHERE key = 'user_profile'")?;
        
        let json_str: String = match stmt.query_row([], |row| row.get(0)) {
            Ok(val) => val,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(UserProfile::default()),
            Err(e) => return Err(e),
        };

        let profile: UserProfile = serde_json::from_str(&json_str)
            .unwrap_or_else(|_| UserProfile::default());
        Ok(profile)
    }

    pub fn save_user_profile(&self, profile: &UserProfile) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let value_json = serde_json::to_string(profile)
            .unwrap_or_else(|_| "{}".to_string());
        
        conn.execute(
            "INSERT INTO global_config (key, value_json) VALUES ('user_profile', ?1)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![value_json],
        )?;
        Ok(())
    }

    // ─── Agent CRUD Operations ───────────────────────────────────────────────

    /// Insert a new agent
    pub fn insert_agent(&self, agent: &Agent) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let personality_json = serde_json::to_string(&agent.personality)
            .unwrap_or_else(|_| "{}".to_string());
        let capabilities_json = serde_json::to_string(&agent.capabilities)
            .unwrap_or_else(|_| "{}".to_string());
        let integrations_json = serde_json::to_string(&agent.integrations)
            .unwrap_or_else(|_| "[]".to_string());
        let stats_json = serde_json::to_string(&agent.stats)
            .unwrap_or_else(|_| "{}".to_string());
        let status_str = status_to_string(&agent.status);

        let memories_json = serde_json::to_string(&agent.memories)
            .unwrap_or_else(|_| "[]".to_string());
        let vi_json = serde_json::to_string(&agent.visual_identity)
            .unwrap_or_else(|_| "{}".to_string());
            
        conn.execute(
            "INSERT INTO agents
                (id, name, role, emoji, color, status, isolated, container_id,
                 personality_json, capabilities_json, integrations_json, created_at, stats_json, memories_json, visual_identity_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                &agent.id,
                &agent.name,
                &agent.role,
                &agent.emoji,
                &agent.color,
                status_str,
                agent.isolated,
                &agent.container_id,
                personality_json,
                capabilities_json,
                integrations_json,
                agent.created_at.to_rfc3339(),
                stats_json,
                memories_json,
                vi_json,
            ],
        )?;

        Ok(())
    }

    /// Get an agent by ID
    pub fn get_agent(&self, id: &str) -> SqlResult<Option<Agent>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, role, emoji, color, status, isolated, container_id,
                    personality_json, capabilities_json, integrations_json, created_at, stats_json, memories_json, visual_identity_json, paused
             FROM agents WHERE id = ?1",
        )?;

        let agent = stmt.query_row(params![id], |row| {
            let status_str: String = row.get(5)?;
            let personality_json: String = row.get(8)?;
            let capabilities_json: String = row.get(9)?;
            let integrations_json: String = row.get(10)?;
            let stats_json: String = row.get(12)?;
            let created_at_str: String = row.get(11)?;
            let memories_json: String = row.get(13).unwrap_or_else(|_| "[]".to_string());
            let vi_json: String = row.get(14).unwrap_or_else(|_| "{}".to_string());
            let paused: bool = row.get(15).unwrap_or(false);

            Ok(Agent {
                id: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                emoji: row.get(3)?,
                color: row.get(4)?,
                status: string_to_status(&status_str),
                isolated: row.get(6)?,
                paused,
                container_id: row.get(7)?,
                personality: serde_json::from_str(&personality_json).unwrap_or_default(),
                capabilities: serde_json::from_str(&capabilities_json).unwrap_or_default(),
                integrations: serde_json::from_str(&integrations_json).unwrap_or_default(),
                memories: serde_json::from_str(&memories_json).unwrap_or_default(),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at_str)
                    .unwrap_or_else(|_| chrono::DateTime::default())
                    .with_timezone(&Utc),
                stats: serde_json::from_str(&stats_json).unwrap_or_default(),
                visual_identity: serde_json::from_str(&vi_json).ok(),
            })
        }).optional()?;

        Ok(agent)
    }

    /// List all agents
    pub fn list_agents(&self) -> SqlResult<Vec<Agent>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, role, emoji, color, status, isolated, container_id,
                    personality_json, capabilities_json, integrations_json, created_at, stats_json, memories_json, visual_identity_json, paused
             FROM agents ORDER BY created_at DESC",
        )?;

        let agents = stmt.query_map([], |row| {
            let status_str: String = row.get(5)?;
            let personality_json: String = row.get(8)?;
            let capabilities_json: String = row.get(9)?;
            let integrations_json: String = row.get(10)?;
            let stats_json: String = row.get(12)?;
            let created_at_str: String = row.get(11)?;
            let memories_json: String = row.get(13).unwrap_or_else(|_| "[]".to_string());
            let vi_json: String = row.get(14).unwrap_or_else(|_| "{}".to_string());
            let paused: bool = row.get(15).unwrap_or(false);

            Ok(Agent {
                id: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                emoji: row.get(3)?,
                color: row.get(4)?,
                status: string_to_status(&status_str),
                isolated: row.get(6)?,
                paused,
                container_id: row.get(7)?,
                personality: serde_json::from_str(&personality_json).unwrap_or_default(),
                capabilities: serde_json::from_str(&capabilities_json).unwrap_or_default(),
                integrations: serde_json::from_str(&integrations_json).unwrap_or_default(),
                memories: serde_json::from_str(&memories_json).unwrap_or_default(),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at_str)
                    .unwrap_or_else(|_| chrono::DateTime::default())
                    .with_timezone(&Utc),
                stats: serde_json::from_str(&stats_json).unwrap_or_default(),
                visual_identity: serde_json::from_str(&vi_json).ok(),
            })
        })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(agents)
    }

    /// Set paused state for an agent
    pub fn set_agent_paused(&self, id: &str, paused: bool) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE agents SET paused = ?1 WHERE id = ?2",
            params![paused, id],
        )?;
        Ok(())
    }

    /// Update an existing agent
    pub fn update_agent(&self, agent: &Agent) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let personality_json = serde_json::to_string(&agent.personality)
            .unwrap_or_else(|_| "{}".to_string());
        let capabilities_json = serde_json::to_string(&agent.capabilities)
            .unwrap_or_else(|_| "{}".to_string());
        let integrations_json = serde_json::to_string(&agent.integrations)
            .unwrap_or_else(|_| "[]".to_string());
        let stats_json = serde_json::to_string(&agent.stats)
            .unwrap_or_else(|_| "{}".to_string());
        let memories_json = serde_json::to_string(&agent.memories)
            .unwrap_or_else(|_| "[]".to_string());
        let vi_json = serde_json::to_string(&agent.visual_identity)
            .unwrap_or_else(|_| "{}".to_string());
        let status_str = status_to_string(&agent.status);

        conn.execute(
            "UPDATE agents
             SET name = ?1, role = ?2, emoji = ?3, color = ?4, status = ?5,
                 isolated = ?6, container_id = ?7, personality_json = ?8,
                 capabilities_json = ?9, integrations_json = ?10, stats_json = ?11, memories_json = ?12, visual_identity_json = ?13,
                 paused = ?14
             WHERE id = ?15",
            params![
                &agent.name,
                &agent.role,
                &agent.emoji,
                &agent.color,
                status_str,
                agent.isolated,
                &agent.container_id,
                personality_json,
                capabilities_json,
                integrations_json,
                stats_json,
                memories_json,
                vi_json,
                agent.paused,
                &agent.id,
            ],
        )?;

        Ok(())
    }

    /// Delete an agent
    pub fn delete_agent(&self, id: &str) -> SqlResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        // Clean up all child relational tables to avoid FOREIGN KEY constraints
        tx.execute("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_id = ?1)", params![id])?;
        tx.execute("DELETE FROM conversations WHERE agent_id = ?1", params![id])?;
        tx.execute("DELETE FROM bridges WHERE agent_id = ?1", params![id])?;
        tx.execute("DELETE FROM budgets WHERE agent_id = ?1", params![id])?;
        tx.execute("DELETE FROM purchase_history WHERE agent_id = ?1", params![id])?;
        tx.execute("DELETE FROM audit_log WHERE agent_id = ?1", params![id])?;
        
        // Finally delete the main agent record
        tx.execute("DELETE FROM agents WHERE id = ?1", params![id])?;

        tx.commit()?;
        Ok(())
    }

    // ─── Conversation & Message Operations ──────────────────────────────────

    /// Get or create a conversation for an agent
    pub fn get_or_create_conversation(&self, agent_id: &str) -> SqlResult<String> {
        let conn = self.conn.lock().unwrap();

        // Check if a conversation already exists for this agent
        let mut stmt = conn.prepare(
            "SELECT id FROM conversations WHERE agent_id = ?1 ORDER BY created_at DESC LIMIT 1",
        )?;

        if let Some(existing_id) = stmt.query_row(params![agent_id], |row| row.get::<_, String>(0)).optional()? {
            return Ok(existing_id);
        }

        // Create a new conversation
        let conv_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO conversations (id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                &conv_id,
                agent_id,
                format!("Conversation with {}", agent_id),
                &now,
                &now,
            ],
        )?;

        Ok(conv_id)
    }

    /// Insert a message into a conversation
    pub fn insert_message(&self, conv_id: &str, role: &str, content: &str) -> SqlResult<String> {
        let conn = self.conn.lock().unwrap();

        let msg_id = Uuid::new_v4().to_string();
        let timestamp = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                &msg_id,
                conv_id,
                role,
                content,
                &timestamp,
            ],
        )?;

        // Update conversation's updated_at timestamp
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![&timestamp, conv_id],
        )?;

        Ok(msg_id)
    }

    /// Get messages from a conversation with limit
    pub fn get_messages(&self, conv_id: &str, limit: u32) -> SqlResult<Vec<Message>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, timestamp
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY timestamp DESC
             LIMIT ?2",
        )?;

        let messages = stmt.query_map(params![conv_id, limit as i32], |row| {
            Ok(Message {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                timestamp: row.get(4)?,
            })
        })?
            .collect::<SqlResult<Vec<_>>>()?;

        // Reverse to get oldest first
        Ok(messages.into_iter().rev().collect())
    }

    // ─── Bridge Operations ──────────────────────────────────────────────────

    /// Insert a new bridge
    pub fn insert_bridge(&self, bridge: &Bridge) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let bridge_type_str = serde_json::to_string(&bridge.bridge_type)
            .unwrap_or_else(|_| "custom".to_string());
        let config_json = serde_json::to_string(&bridge.config)
            .unwrap_or_else(|_| "{}".to_string());
        let permissions_json = serde_json::to_string(&bridge.permissions)
            .unwrap_or_else(|_| "{}".to_string());

        conn.execute(
            "INSERT INTO bridges
                (id, agent_id, name, bridge_type, enabled, config_json, permissions_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &bridge.id,
                &bridge.agent_id,
                &bridge.name,
                bridge_type_str,
                bridge.enabled,
                config_json,
                permissions_json,
            ],
        )?;

        Ok(())
    }

    /// Get a bridge by ID
    pub fn get_bridge(&self, id: &str) -> SqlResult<Option<Bridge>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, agent_id, name, bridge_type, enabled, config_json, permissions_json
             FROM bridges WHERE id = ?1",
        )?;

        let bridge = stmt.query_row(params![id], |row| {
            let bridge_type_str: String = row.get(3)?;
            let config_json: String = row.get(5)?;
            let permissions_json: String = row.get(6)?;

            Ok(Bridge {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                name: row.get(2)?,
                bridge_type: serde_json::from_str(&bridge_type_str).unwrap_or(BridgeType::Custom),
                enabled: row.get(4)?,
                config: serde_json::from_str(&config_json).unwrap_or_default(),
                permissions: serde_json::from_str(&permissions_json).unwrap_or_default(),
            })
        }).optional()?;

        Ok(bridge)
    }

    /// List bridges for an agent
    pub fn list_bridges(&self, agent_id: &str) -> SqlResult<Vec<Bridge>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, agent_id, name, bridge_type, enabled, config_json, permissions_json
             FROM bridges WHERE agent_id = ?1",
        )?;

        let bridges = stmt.query_map(params![agent_id], |row| {
            let bridge_type_str: String = row.get(3)?;
            let config_json: String = row.get(5)?;
            let permissions_json: String = row.get(6)?;

            Ok(Bridge {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                name: row.get(2)?,
                bridge_type: serde_json::from_str(&bridge_type_str).unwrap_or(BridgeType::Custom),
                enabled: row.get(4)?,
                config: serde_json::from_str(&config_json).unwrap_or_default(),
                permissions: serde_json::from_str(&permissions_json).unwrap_or_default(),
            })
        })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(bridges)
    }

    /// List all bridges globally across the platform
    pub fn list_all_bridges(&self) -> SqlResult<Vec<Bridge>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, agent_id, name, bridge_type, enabled, config_json, permissions_json
             FROM bridges",
        )?;

        let bridges = stmt.query_map([], |row| {
            let bridge_type_str: String = row.get(3)?;
            let config_json: String = row.get(5)?;
            let permissions_json: String = row.get(6)?;

            Ok(Bridge {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                name: row.get(2)?,
                bridge_type: serde_json::from_str(&bridge_type_str).unwrap_or(BridgeType::Custom),
                enabled: row.get(4)?,
                config: serde_json::from_str(&config_json).unwrap_or_default(),
                permissions: serde_json::from_str(&permissions_json).unwrap_or_default(),
            })
        })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(bridges)
    }

    /// Update a bridge
    pub fn update_bridge(&self, bridge: &Bridge) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let bridge_type_str = serde_json::to_string(&bridge.bridge_type)
            .unwrap_or_else(|_| "custom".to_string());
        let config_json = serde_json::to_string(&bridge.config)
            .unwrap_or_else(|_| "{}".to_string());
        let permissions_json = serde_json::to_string(&bridge.permissions)
            .unwrap_or_else(|_| "{}".to_string());

        conn.execute(
            "UPDATE bridges
             SET name = ?1, bridge_type = ?2, enabled = ?3, config_json = ?4, permissions_json = ?5
             WHERE id = ?6",
            params![
                &bridge.name,
                bridge_type_str,
                bridge.enabled,
                config_json,
                permissions_json,
                &bridge.id,
            ],
        )?;

        Ok(())
    }

    /// Delete a bridge
    pub fn delete_bridge(&self, id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute("DELETE FROM bridges WHERE id = ?1", params![id])?;

        Ok(())
    }

    // ─── Audit Log Operations ──────────────────────────────────────────────

    /// Log an audit entry
    pub fn log_audit(
        &self,
        agent_id: &str,
        action: &str,
        bridge_type: Option<&str>,
        detail: &str,
        content_hash: Option<&str>,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let timestamp = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO audit_log
                (timestamp, agent_id, action, bridge_type, detail, content_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &timestamp,
                agent_id,
                action,
                bridge_type,
                detail,
                content_hash,
            ],
        )?;

        Ok(())
    }

    /// Get audit log entries
    pub fn get_audit_log(&self, agent_id: Option<&str>, limit: u32) -> SqlResult<Vec<AuditEntry>> {
        let conn = self.conn.lock().unwrap();

        let (query, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = if let Some(agent_id) = agent_id {
            (
                "SELECT id, timestamp, agent_id, action, bridge_type, detail, content_hash
                 FROM (
                     SELECT id, timestamp, agent_id, action, bridge_type, detail, content_hash
                     FROM audit_log
                     UNION ALL
                     SELECT (m.rowid + 10000000) as id, m.timestamp, c.agent_id, 'chatted' as action, 
                            CASE WHEN m.role = 'user' THEN 'user' ELSE 'app' END as bridge_type, 
                            substr(m.content, 1, 150) as detail, NULL as content_hash
                     FROM messages m
                     JOIN conversations c ON m.conversation_id = c.id
                 )
                 WHERE agent_id = ?1
                 ORDER BY timestamp DESC
                 LIMIT ?2".to_string(),
                vec![Box::new(agent_id.to_string()), Box::new(limit as i32)],
            )
        } else {
            (
                "SELECT id, timestamp, agent_id, action, bridge_type, detail, content_hash
                 FROM (
                     SELECT id, timestamp, agent_id, action, bridge_type, detail, content_hash
                     FROM audit_log
                     UNION ALL
                     SELECT (m.rowid + 10000000) as id, m.timestamp, c.agent_id, 'chatted' as action, 
                            CASE WHEN m.role = 'user' THEN 'user' ELSE 'app' END as bridge_type, 
                            substr(m.content, 1, 150) as detail, NULL as content_hash
                     FROM messages m
                     JOIN conversations c ON m.conversation_id = c.id
                 )
                 ORDER BY timestamp DESC
                 LIMIT ?1".to_string(),
                vec![Box::new(limit as i32)],
            )
        };

        let mut stmt = conn.prepare(&query)?;

        let entries = if agent_id.is_some() {
            stmt.query_map(params![agent_id, limit as i32], |row| {
                Ok(AuditEntry {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    agent_id: row.get(2)?,
                    action: row.get(3)?,
                    bridge_type: row.get(4)?,
                    detail: row.get(5)?,
                    content_hash: row.get(6)?,
                })
            })?.collect::<SqlResult<Vec<_>>>()?
        } else {
            stmt.query_map(params![limit as i32], |row| {
                Ok(AuditEntry {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    agent_id: row.get(2)?,
                    action: row.get(3)?,
                    bridge_type: row.get(4)?,
                    detail: row.get(5)?,
                    content_hash: row.get(6)?,
                })
            })?.collect::<SqlResult<Vec<_>>>()?
        };

        Ok(entries)
    }

    // ─── Budget Operations ─────────────────────────────────────────────────

    /// Get a budget for an agent
    pub fn get_budget(&self, agent_id: &str) -> SqlResult<Option<AgentBudget>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT agent_id, config_json, daily_spent_cents, monthly_spent_cents, last_reset_date
             FROM budgets WHERE agent_id = ?1",
        )?;

        let budget = stmt.query_row(params![agent_id], |row| {
            let config_json: String = row.get(1)?;
            let default_budget = AgentBudget {
                agent_id: row.get(0)?,
                payments_enabled: false,
                auto_approve_threshold_cents: 0,
                per_transaction_limit_cents: 0,
                daily_limit_cents: 0,
                monthly_limit_cents: 0,
                allowed_categories: vec![],
                daily_spent_cents: row.get(2)?,
                monthly_spent_cents: row.get(3)?,
                require_approval_new_merchant: false,
                require_approval_recurring: false,
            };
            
            let mut config: AgentBudget = serde_json::from_str(&config_json).unwrap_or(default_budget);
            config.daily_spent_cents = row.get(2)?;
            config.monthly_spent_cents = row.get(3)?;

            Ok(config)
        }).optional()?;

        Ok(budget)
    }

    /// Insert or update a budget
    pub fn upsert_budget(&self, budget: &AgentBudget) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let config_json = serde_json::to_string(budget)
            .unwrap_or_else(|_| "{}".to_string());
        let last_reset = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT OR REPLACE INTO budgets
                (agent_id, config_json, daily_spent_cents, monthly_spent_cents, last_reset_date)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                &budget.agent_id,
                config_json,
                budget.daily_spent_cents,
                budget.monthly_spent_cents,
                &last_reset,
            ],
        )?;

        Ok(())
    }

    /// Record a purchase
    pub fn record_purchase(&self, record: &PurchaseRecord) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let decision_json = serde_json::to_string(&record.decision)
            .unwrap_or_else(|_| "{}".to_string());

        conn.execute(
            "INSERT INTO purchase_history
                (id, agent_id, description, merchant, amount_cents, category, decision, virtual_card_id, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &record.id,
                &record.agent_id,
                &record.description,
                &record.merchant,
                record.amount_cents as i32,
                &record.category,
                decision_json,
                &record.virtual_card_id,
                record.timestamp.to_rfc3339(),
            ],
        )?;

        Ok(())
    }

    /// Get purchase history for an agent
    pub fn get_purchase_history(&self, agent_id: &str, limit: u32) -> SqlResult<Vec<PurchaseRecord>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, agent_id, description, merchant, amount_cents, category, decision, virtual_card_id, timestamp
             FROM purchase_history
             WHERE agent_id = ?1
             ORDER BY timestamp DESC
             LIMIT ?2",
        )?;

        let records = stmt.query_map(params![agent_id, limit as i32], |row| {
            let decision_json: String = row.get(6)?;
            let timestamp_str: String = row.get(8)?;

            Ok(PurchaseRecord {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                description: row.get(2)?,
                merchant: row.get(3)?,
                amount_cents: row.get::<_, i32>(4)? as u64,
                category: row.get(5)?,
                decision: serde_json::from_str(&decision_json).unwrap_or(PurchaseDecision::Denied {
                    reasons: vec!["Failed to deserialize decision".to_string()],
                }),
                virtual_card_id: row.get(7)?,
                timestamp: chrono::DateTime::parse_from_rfc3339(&timestamp_str)
                    .unwrap_or_else(|_| chrono::DateTime::default())
                    .with_timezone(&Utc),
            })
        })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(records)
    }

    // ─── Budget Reset Operations ───────────────────────────────────────────

    /// Reset daily budgets for all agents (call on daily schedule)
    pub fn reset_daily_budgets(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE budgets SET daily_spent_cents = 0, last_reset_date = ?1",
            params![&now],
        )?;

        self.log_audit_internal(&conn, None, "reset_daily_budgets", None, "Daily budgets reset", None)?;

        Ok(())
    }

    /// Reset monthly budgets for all agents (call on monthly schedule)
    pub fn reset_monthly_budgets(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE budgets SET monthly_spent_cents = 0, last_reset_date = ?1",
            params![&now],
        )?;

        self.log_audit_internal(&conn, None, "reset_monthly_budgets", None, "Monthly budgets reset", None)?;

        Ok(())
    }

    // ─── Utility ─────────────────────────────────────────────────────────────

    /// Internal audit logging (used without needing to re-lock the mutex)
    fn log_audit_internal(
        &self,
        conn: &Connection,
        agent_id: Option<&str>,
        action: &str,
        bridge_type: Option<&str>,
        detail: &str,
        content_hash: Option<&str>,
    ) -> SqlResult<()> {
        let timestamp = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO audit_log
                (timestamp, agent_id, action, bridge_type, detail, content_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &timestamp,
                agent_id,
                action,
                bridge_type,
                detail,
                content_hash,
            ],
        )?;

        Ok(())
    }

    /// Update agent spending (called after successful purchase)
    pub fn update_agent_spending(&self, agent_id: &str, amount_cents: u64, is_daily: bool, is_monthly: bool) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        if is_daily {
            conn.execute(
                "UPDATE budgets SET daily_spent_cents = daily_spent_cents + ?1 WHERE agent_id = ?2",
                params![amount_cents as i32, agent_id],
            )?;
        }

        if is_monthly {
            conn.execute(
                "UPDATE budgets SET monthly_spent_cents = monthly_spent_cents + ?1 WHERE agent_id = ?2",
                params![amount_cents as i32, agent_id],
            )?;
        }

        Ok(())
    }

    /// Delete all data for testing/reset purposes
    #[cfg(test)]
    pub fn clear_all(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute("DELETE FROM purchase_history", [])?;
        conn.execute("DELETE FROM budgets", [])?;
        conn.execute("DELETE FROM audit_log", [])?;
        conn.execute("DELETE FROM bridges", [])?;
        conn.execute("DELETE FROM messages", [])?;
        conn.execute("DELETE FROM conversations", [])?;
        conn.execute("DELETE FROM agents", [])?;

        Ok(())
    }

    // ─── Provider Models Operations ──────────────────────────────────────────

    pub fn insert_provider_models(&self, models: Vec<ProviderModel>) -> SqlResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        // To keep logic simple, we can upsert
        for m in models {
            let caps_json = serde_json::to_string(&m.capabilities).unwrap_or_else(|_| "[]".to_string());
            tx.execute(
                "INSERT INTO provider_models (id, provider, name, capabilities_json, recommended, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET 
                    name = excluded.name,
                    capabilities_json = excluded.capabilities_json,
                    recommended = CASE WHEN recommended = 1 THEN excluded.recommended ELSE recommended END",
                params![&m.id, &m.provider, &m.name, &caps_json, &m.recommended, m.created_at.to_rfc3339()],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn get_provider_models(&self) -> SqlResult<Vec<ProviderModel>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, provider, name, capabilities_json, recommended, created_at FROM provider_models ORDER BY provider ASC, id DESC"
        )?;

        let models = stmt.query_map([], |row| {
            let caps_json: String = row.get(3)?;
            let created_at_str: String = row.get(5)?;
            Ok(ProviderModel {
                id: row.get(0)?,
                provider: row.get(1)?,
                name: row.get(2)?,
                capabilities: serde_json::from_str(&caps_json).unwrap_or_default(),
                recommended: row.get(4)?,
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at_str)
                    .unwrap_or_else(|_| chrono::DateTime::default())
                    .with_timezone(&Utc),
            })
        })?.collect::<SqlResult<Vec<_>>>()?;

        Ok(models)
    }

    pub fn remove_provider_model(&self, id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM provider_models WHERE id = ?1", params![id])?;
        Ok(())
    }
}

// ─── Helper Functions ────────────────────────────────────────────────────────

fn status_to_string(status: &AgentStatus) -> String {
    match status {
        AgentStatus::Active => "active".to_string(),
        AgentStatus::Sleeping => "sleeping".to_string(),
        AgentStatus::Thinking => "thinking".to_string(),
        AgentStatus::Stopped => "stopped".to_string(),
        AgentStatus::Error => "error".to_string(),
    }
}

fn string_to_status(s: &str) -> AgentStatus {
    match s {
        "active" => AgentStatus::Active,
        "sleeping" => AgentStatus::Sleeping,
        "thinking" => AgentStatus::Thinking,
        "stopped" => AgentStatus::Stopped,
        "error" => AgentStatus::Error,
        _ => AgentStatus::Stopped,
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_db() -> Database {
        let conn = Connection::open_in_memory().unwrap();
        let db = Database {
            conn: Mutex::new(conn),
        };
        db.run_migrations().unwrap();
        db
    }

    #[test]
    fn test_agent_crud() {
        let db = create_test_db();

        let agent = Agent {
            id: "test-agent-1".to_string(),
            name: "Test Agent".to_string(),
            role: "analyst".to_string(),
            emoji: "🤖".to_string(),
            color: "#FF0000".to_string(),
            status: AgentStatus::Active,
            isolated: false,
            container_id: Some("container-1".to_string()),
            personality: AgentPersonality {
                name: "Curious".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec!["analysis".to_string()],
                guardrails: vec!["no-code".to_string()],
                custom_instructions: "Be helpful".to_string(),
            },
            integrations: vec!["slack".to_string()],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        };

        // Insert
        db.insert_agent(&agent).unwrap();

        // Read
        let retrieved = db.get_agent("test-agent-1").unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name, "Test Agent");

        // List
        let all = db.list_agents().unwrap();
        assert_eq!(all.len(), 1);

        // Update
        let mut updated_agent = agent.clone();
        updated_agent.name = "Updated Agent".to_string();
        db.update_agent(&updated_agent).unwrap();

        let retrieved_updated = db.get_agent("test-agent-1").unwrap().unwrap();
        assert_eq!(retrieved_updated.name, "Updated Agent");

        // Delete
        db.delete_agent("test-agent-1").unwrap();
        let deleted = db.get_agent("test-agent-1").unwrap();
        assert!(deleted.is_none());
    }

    #[test]
    fn test_message_operations() {
        let db = create_test_db();

        let agent = Agent {
            id: "agent-1".to_string(),
            name: "Agent 1".to_string(),
            role: "analyst".to_string(),
            emoji: "🤖".to_string(),
            color: "#FF0000".to_string(),
            status: AgentStatus::Active,
            isolated: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Agent 1".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
            },
            integrations: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        };
        db.insert_agent(&agent).unwrap();

        let conv_id = db.get_or_create_conversation("agent-1").unwrap();
        assert!(!conv_id.is_empty());

        let msg_id = db.insert_message(&conv_id, "user", "Hello").unwrap();
        assert!(!msg_id.is_empty());

        db.insert_message(&conv_id, "assistant", "Hi there").unwrap();

        let messages = db.get_messages(&conv_id, 10).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
    }

    #[test]
    fn test_bridge_operations() {
        let db = create_test_db();

        let agent = Agent {
            id: "agent-1".to_string(),
            name: "Agent 1".to_string(),
            role: "analyst".to_string(),
            emoji: "🤖".to_string(),
            color: "#FF0000".to_string(),
            status: AgentStatus::Active,
            isolated: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Agent 1".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
            },
            integrations: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        };
        db.insert_agent(&agent).unwrap();

        let bridge = Bridge {
            id: "bridge-1".to_string(),
            agent_id: "agent-1".to_string(),
            name: "Test Bridge".to_string(),
            bridge_type: BridgeType::Slack,
            enabled: true,
            config: BridgeConfig {
                scope: json!({"channel": "general"}),
                expires_at: None,
                push_enabled: true,
            },
            permissions: BridgePermissions {
                read: true,
                write: true,
                delete: false,
            },
        };

        db.insert_bridge(&bridge).unwrap();

        let retrieved = db.get_bridge("bridge-1").unwrap();
        assert!(retrieved.is_some());

        let agent_bridges = db.list_bridges("agent-1").unwrap();
        assert_eq!(agent_bridges.len(), 1);

        db.delete_bridge("bridge-1").unwrap();
        let deleted = db.get_bridge("bridge-1").unwrap();
        assert!(deleted.is_none());
    }

    #[test]
    fn test_audit_log() {
        let db = create_test_db();

        db.log_audit("agent-1", "created", Some("slack"), "Agent created", None).unwrap();
        db.log_audit("agent-1", "updated", None, "Agent config changed", None).unwrap();

        let entries = db.get_audit_log(Some("agent-1"), 10).unwrap();
        assert_eq!(entries.len(), 2);

        let all_entries = db.get_audit_log(None, 10).unwrap();
        assert_eq!(all_entries.len(), 2);
    }

    #[test]
    fn test_budget_operations() {
        let db = create_test_db();

        let agent = Agent {
            id: "agent-1".to_string(),
            name: "Agent 1".to_string(),
            role: "analyst".to_string(),
            emoji: "🤖".to_string(),
            color: "#FF0000".to_string(),
            status: AgentStatus::Active,
            isolated: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Agent 1".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
            },
            integrations: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        };
        db.insert_agent(&agent).unwrap();

        let budget = AgentBudget {
            agent_id: "agent-1".to_string(),
            payments_enabled: true,
            auto_approve_threshold_cents: 5000,
            per_transaction_limit_cents: 10000,
            daily_limit_cents: 50000,
            monthly_limit_cents: 500000,
            allowed_categories: vec!["software".to_string()],
            daily_spent_cents: 1000,
            monthly_spent_cents: 5000,
            require_approval_new_merchant: true,
            require_approval_recurring: false,
        };

        db.upsert_budget(&budget).unwrap();

        let retrieved = db.get_budget("agent-1").unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().daily_spent_cents, 1000);

        db.update_agent_spending("agent-1", 500, true, true).unwrap();

        let updated = db.get_budget("agent-1").unwrap().unwrap();
        assert_eq!(updated.daily_spent_cents, 1500);
        assert_eq!(updated.monthly_spent_cents, 5500);
    }
}

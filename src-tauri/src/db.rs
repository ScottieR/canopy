use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde_json::json;
use std::sync::Mutex;
use tauri::Manager;
use uuid::Uuid;

use crate::models::*;

// ─── Local Models for DB Layer ───────────────────────────────────────────────

/// Represents an item in the user's universal inbox
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InboxItem {
    pub id: String,
    pub item_type: String,
    pub status: String,
    pub payload_json: String,
    pub timestamp: String,
}

/// Represents a message in a conversation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String, // "user", "assistant", "system"
    pub content: String,
    pub timestamp: String,
}

/// Lightweight thread metadata for frontend hydration and recovery.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: u32,
    pub first_user_message: Option<String>,
    pub thread_status: String,
    pub background_allowed: bool,
    pub active_run_count: u32,
    pub last_run_id: Option<String>,
    pub last_run_status: Option<String>,
    pub checkpoint_count: u32,
    pub last_checkpoint_at: Option<String>,
}

/// A single execution attempt within a conversation thread.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ThreadRun {
    pub id: String,
    pub conversation_id: String,
    pub agent_id: String,
    pub status: String,
    pub trigger_type: String,
    pub started_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub checkpoint_payload_json: Option<String>,
    pub error_payload_json: Option<String>,
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

/// Represents an aggregated activity count per day for a heatmap
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ActivityHeatmapEntry {
    pub date: String,
    pub interactions: u32,
    pub tools: u32,
    pub system: u32,
    pub total: u32,
}

/// A person using one or more agents through the focused companion app.
/// Profiles are deliberately separate from the desktop owner's global profile.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionProfile {
    pub id: String,
    pub display_name: String,
    pub profile_type: String,
    pub context_json: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

/// A revocable, device-bound grant for a constrained subset of agents.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionDeviceGrant {
    pub device_id: String,
    pub profile_id: String,
    pub device_name: String,
    pub experience: String,
    pub allowed_agent_ids: Vec<String>,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub revoked: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionLearningEvent {
    pub id: String,
    pub profile_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub event_type: String,
    pub subject: Option<String>,
    pub skill: Option<String>,
    pub outcome: Option<String>,
    pub score: Option<f64>,
    pub confidence: Option<f64>,
    pub evidence: Option<String>,
    pub recommended_next: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionReport {
    pub id: String,
    pub profile_id: String,
    pub agent_id: String,
    pub period_start: String,
    pub period_end: String,
    pub report_json: serde_json::Value,
    pub created_at: String,
}

/// Versioned content published into a companion assignment. `mini_app` is the
/// first resource type; learning plans and other parent-managed material use
/// the same transport without coupling the grant layer to tutoring.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionResource {
    pub id: String,
    pub profile_id: String,
    pub agent_id: String,
    pub resource_type: String,
    pub title: String,
    pub version: i64,
    pub content_json: serde_json::Value,
    pub source: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionResourceEvent {
    pub id: String,
    pub resource_id: String,
    pub device_id: String,
    pub profile_id: String,
    pub agent_id: String,
    pub action: String,
    pub data_json: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BrowserHistoryEntry {
    pub timestamp: String,
    pub action: String,
    pub detail: String,
}

/// Represents a security alert generated by the network sniffer
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SecurityAlert {
    pub id: String,
    pub agent_id: String,
    pub timestamp: String,
    pub severity: String, // "Medium", "High", "Critical"
    pub description: String,
    pub resolved: bool,
}

/// A web-hosted connection-token capture request, awaiting the user to paste a
/// provider API key into the `/connect/{token}` page on canopy-admin. Mirrors
/// (but does not replace) the local companion-window flow — this exists so the
/// key can be captured from any browser, without the desktop app being reachable.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingConnectionRecord {
    pub token: String,
    pub agent_id: String,
    pub provider_name: String,
    /// Env-style Keychain key suffix, e.g. `SEATS_AERO_API_KEY`. The key is
    /// ultimately stored as `agent_<agent_id>_<secret_name>`.
    pub secret_name: String,
    pub token_url: Option<String>,
    pub instructions: Option<String>,
    pub placeholder: String,
    pub created_at: String,
    pub expires_at: String,
}

// ─── Database Struct ─────────────────────────────────────────────────────────

/// Thread-safe SQLite database wrapper for Canopy
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Initialize the database, creating tables and migrations as needed
    pub fn init<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> SqlResult<Self> {
        // Determine database path
        let data_dir = if let Some(dir) = crate::flavor::canopy_data_dir() {
            dir
        } else {
            // Fallback to app data directory
            app_handle
                .path()
                .app_data_dir()
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

    /// Initialize an in-memory database (primarily for testing)
    pub fn init_in_memory() -> SqlResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute("PRAGMA foreign_keys = ON", [])?;
        let db = Database {
            conn: Mutex::new(conn),
        };
        db.run_migrations()?;
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
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN thread_status TEXT NOT NULL DEFAULT 'idle'",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN background_allowed BOOLEAN NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN active_run_count INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute("ALTER TABLE conversations ADD COLUMN last_run_id TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN last_run_status TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN checkpoint_count INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE conversations ADD COLUMN last_checkpoint_at TEXT",
            [],
        );

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
        conn.execute(
            "CREATE TABLE IF NOT EXISTS thread_runs (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                status TEXT NOT NULL,
                trigger_type TEXT NOT NULL,
                started_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT,
                checkpoint_payload_json TEXT,
                error_payload_json TEXT,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id),
                FOREIGN KEY(agent_id) REFERENCES agents(id)
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

        conn.execute(
            "CREATE TABLE IF NOT EXISTS payment_approval_requests (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                purchase_record_id TEXT NOT NULL,
                request_json TEXT NOT NULL,
                reason TEXT NOT NULL,
                flags_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                resolved_at TEXT,
                expires_at TEXT,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS virtual_cards (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                purchase_record_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                provider_card_ref TEXT NOT NULL,
                last_four TEXT NOT NULL,
                amount_cents INTEGER NOT NULL,
                merchant TEXT NOT NULL,
                memo TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS payment_audit_log (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                detail_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS payment_transactions (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                purchase_record_id TEXT,
                virtual_card_id TEXT,
                provider TEXT NOT NULL,
                provider_transaction_ref TEXT NOT NULL,
                merchant TEXT NOT NULL,
                amount_cents INTEGER NOT NULL,
                status TEXT NOT NULL,
                source TEXT NOT NULL,
                decline_reason TEXT,
                created_at TEXT NOT NULL,
                settled_at TEXT,
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

        // Durable UI content. WebKit localStorage only keeps lightweight
        // catalogs; full forum bodies and mini-app source live in SQLite.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS forum_states (
                id TEXT PRIMARY KEY,
                summary_json TEXT NOT NULL,
                content_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS agent_mini_apps (
                agent_id TEXT PRIMARY KEY,
                content_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        // Create security_alerts table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS security_alerts (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                severity TEXT NOT NULL,
                description TEXT NOT NULL,
                resolved BOOLEAN NOT NULL DEFAULT 0,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
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

        // Create voice_configs table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS voice_configs (
                agent_id TEXT PRIMARY KEY,
                config_json TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        // Create agent_bug_reports table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS agent_bug_reports (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                service TEXT NOT NULL,
                error_message TEXT NOT NULL,
                resolved BOOLEAN NOT NULL DEFAULT 0,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS feedback_reports (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                agent_id TEXT,
                reporter_name TEXT NOT NULL,
                reporter_email TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                context_json TEXT NOT NULL,
                remote_status TEXT NOT NULL DEFAULT 'pending',
                remote_error TEXT,
                slack_notified INTEGER NOT NULL DEFAULT 0,
                dispatched_agent_id TEXT,
                dispatched_at TEXT,
                FOREIGN KEY(agent_id) REFERENCES agents(id),
                FOREIGN KEY(dispatched_agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        // Create inbox_items table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS inbox_items (
                id TEXT PRIMARY KEY,
                item_type TEXT NOT NULL,
                status TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )",
            [],
        )?;

        // Create indexes for common queries

        let _ = conn.execute(
            "ALTER TABLE token_usage_history ADD COLUMN conversation_id TEXT",
            [],
        );

        conn.execute(
            "CREATE TABLE IF NOT EXISTS token_usage_history (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                conversation_id TEXT,
                timestamp TEXT NOT NULL,
                model TEXT NOT NULL,
                provider TEXT NOT NULL,
                tokens_in INTEGER NOT NULL,
                tokens_out INTEGER NOT NULL,
                cost_usd REAL NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage_history(agent_id)",
            [],
        )?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage_history(timestamp)", [])?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS system_warnings (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                warning_type TEXT NOT NULL,
                message TEXT NOT NULL,
                resolved INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;

        // Managed companion/family foundation. The same grant model supports a
        // child with a Tutor, a teammate with a Developer, or a guest with any
        // other explicitly shared agent. Provider credentials remain agent-scoped.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS companion_profiles (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                profile_type TEXT NOT NULL,
                context_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS companion_device_grants (
                device_id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL,
                device_name TEXT NOT NULL,
                experience TEXT NOT NULL,
                allowed_agent_ids_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT,
                revoked INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(profile_id) REFERENCES companion_profiles(id)
            )",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS companion_learning_events (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                subject TEXT,
                skill TEXT,
                outcome TEXT,
                score REAL,
                confidence REAL,
                evidence TEXT,
                recommended_next TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(profile_id) REFERENCES companion_profiles(id),
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS companion_reports (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                period_start TEXT NOT NULL,
                period_end TEXT NOT NULL,
                report_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(profile_id) REFERENCES companion_profiles(id),
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS companion_resources (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                resource_type TEXT NOT NULL,
                title TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                content_json TEXT NOT NULL,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(profile_id) REFERENCES companion_profiles(id),
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS companion_resource_events (
                id TEXT PRIMARY KEY,
                resource_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                profile_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                action TEXT NOT NULL,
                data_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(resource_id) REFERENCES companion_resources(id),
                FOREIGN KEY(profile_id) REFERENCES companion_profiles(id),
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_companion_grants_profile ON companion_device_grants(profile_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_companion_events_profile_agent ON companion_learning_events(profile_id, agent_id, created_at)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_companion_reports_profile_agent ON companion_reports(profile_id, agent_id, created_at)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_companion_resources_profile_agent ON companion_resources(profile_id, agent_id, status, updated_at)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_companion_resource_events_resource ON companion_resource_events(resource_id, created_at)",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_thread_runs_conversation ON thread_runs(conversation_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_thread_runs_agent_status ON thread_runs(agent_id, status)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_bridges_agent ON bridges(agent_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_purchase_history_agent ON purchase_history(agent_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_payment_approval_requests_agent_status
             ON payment_approval_requests(agent_id, status)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_virtual_cards_agent_status
             ON virtual_cards(agent_id, status)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_payment_audit_log_agent_created
             ON payment_audit_log(agent_id, created_at DESC)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_payment_transactions_agent_created
             ON payment_transactions(agent_id, created_at DESC)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_payment_transactions_card
             ON payment_transactions(virtual_card_id, created_at DESC)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_feedback_reports_created_at ON feedback_reports(created_at DESC)",
            [],
        )?;

        // Web-hosted connection token capture (Slack-reachable, desktop-independent).
        // Rows are short-lived: created on request, deleted on pickup, and swept once
        // expired (see delete_expired_pending_connections, polled every 5s alongside
        // canopy-admin — see web_connections::start_web_connections_poll_daemon).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pending_connections (
                token TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                provider_name TEXT NOT NULL,
                secret_name TEXT NOT NULL,
                token_url TEXT,
                instructions TEXT,
                placeholder TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id)
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_pending_connections_agent ON pending_connections(agent_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_pending_connections_expires ON pending_connections(expires_at)",
            [],
        )?;

        // Migration: backfill capability blobs that predate the capabilities column.
        //
        // `ALTER TABLE agents ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{}'`
        // above gave every pre-existing row the literal string `{}`. Combined with the
        // (now fixed) field-level `#[serde(default)]` on AgentCapabilities, those agents
        // deserialized to all-false — no `browser`, no `gog` — and `sync_agent_skills`
        // then wrote `skills: []` into openclaw.json, so they had neither browser nor
        // web search no matter what the UI showed.
        //
        // The struct-level serde default fixes reads going forward; this makes the stored
        // row explicit so anything that parses the raw JSON without going through
        // AgentCapabilities (the frontend, jit_server's capability grants) agrees. Merge
        // semantics: keys already present win, missing keys are filled from Default. That
        // also gives capabilities added after an agent was created a sane starting value
        // instead of silently false.
        Self::backfill_agent_capabilities(&conn);

        tracing::debug!("Database migrations completed");
        Ok(())
    }

    /// Fill in missing keys in each agent's `capabilities_json` from
    /// `AgentCapabilities::default()`, leaving any explicitly stored value untouched.
    /// Only rows that actually change are written, so this is a no-op on later boots.
    fn backfill_agent_capabilities(conn: &rusqlite::Connection) {
        let defaults = match serde_json::to_value(crate::models::AgentCapabilities::default()) {
            Ok(serde_json::Value::Object(map)) => map,
            _ => return,
        };

        let rows: Vec<(String, String)> = {
            let mut stmt = match conn.prepare("SELECT id, capabilities_json FROM agents") {
                Ok(stmt) => stmt,
                Err(e) => {
                    tracing::warn!("capability backfill: could not read agents: {}", e);
                    return;
                }
            };
            let mapped = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            });
            match mapped {
                Ok(iter) => iter.filter_map(Result::ok).collect(),
                Err(e) => {
                    tracing::warn!("capability backfill: could not scan agents: {}", e);
                    return;
                }
            }
        };

        let mut patched = 0usize;
        for (id, raw) in rows {
            // A blob that isn't a JSON object at all (empty string, corrupt write) is
            // replaced wholesale rather than skipped — leaving it would keep the agent
            // in the all-false state this migration exists to undo.
            let mut stored = match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(serde_json::Value::Object(map)) => map,
                _ => serde_json::Map::new(),
            };

            let missing: Vec<&String> = defaults
                .keys()
                .filter(|key| !stored.contains_key(key.as_str()))
                .collect();
            if missing.is_empty() {
                continue;
            }
            let missing_names: Vec<String> = missing.iter().map(|k| (*k).clone()).collect();
            for key in missing_names.iter() {
                if let Some(value) = defaults.get(key) {
                    stored.insert(key.clone(), value.clone());
                }
            }

            let merged = serde_json::Value::Object(stored).to_string();
            match conn.execute(
                "UPDATE agents SET capabilities_json = ?1 WHERE id = ?2",
                rusqlite::params![merged, id],
            ) {
                Ok(_) => {
                    patched += 1;
                    tracing::info!(
                        "capability backfill: agent {} inherited defaults for [{}]",
                        id,
                        missing_names.join(", ")
                    );
                }
                Err(e) => tracing::warn!("capability backfill: agent {} update failed: {}", id, e),
            }
        }

        if patched > 0 {
            tracing::info!("capability backfill: patched {} agent row(s)", patched);
        }
    }

    // ─── Global Config Operations ────────────────────────────────────────────

    pub fn get_user_profile(&self) -> SqlResult<UserProfile> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT value_json FROM global_config WHERE key = 'user_profile'")?;

        let json_str: String = match stmt.query_row([], |row| row.get(0)) {
            Ok(val) => val,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(UserProfile::default()),
            Err(e) => return Err(e),
        };

        let profile: UserProfile =
            serde_json::from_str(&json_str).unwrap_or_else(|_| UserProfile::default());
        Ok(profile)
    }

    pub fn save_user_profile(&self, profile: &UserProfile) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let value_json = serde_json::to_string(profile).unwrap_or_else(|_| "{}".to_string());

        conn.execute(
            "INSERT INTO global_config (key, value_json) VALUES ('user_profile', ?1)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![value_json],
        )?;
        Ok(())
    }

    pub fn list_feedback_reports(&self) -> SqlResult<Vec<FeedbackReport>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, status, title, description, agent_id, reporter_name, reporter_email,
                    created_at, updated_at, context_json, remote_status, remote_error, slack_notified,
                    dispatched_agent_id, dispatched_at
             FROM feedback_reports
             ORDER BY created_at DESC",
        )?;

        let reports = stmt
            .query_map([], |row| {
                let context_json: String = row.get(10)?;
                Ok(FeedbackReport {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    status: row.get(2)?,
                    title: row.get(3)?,
                    description: row.get(4)?,
                    agent_id: row.get(5)?,
                    reporter_name: row.get(6)?,
                    reporter_email: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    context: serde_json::from_str(&context_json).unwrap_or_else(|_| json!({})),
                    remote_status: row.get(11)?,
                    remote_error: row.get(12)?,
                    slack_notified: row.get(13)?,
                    dispatched_agent_id: row.get(14)?,
                    dispatched_at: row.get(15)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(reports)
    }

    pub fn get_feedback_report(&self, report_id: &str) -> SqlResult<Option<FeedbackReport>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, status, title, description, agent_id, reporter_name, reporter_email,
                    created_at, updated_at, context_json, remote_status, remote_error, slack_notified,
                    dispatched_agent_id, dispatched_at
             FROM feedback_reports
             WHERE id = ?1",
        )?;

        stmt.query_row(params![report_id], |row| {
            let context_json: String = row.get(10)?;
            Ok(FeedbackReport {
                id: row.get(0)?,
                kind: row.get(1)?,
                status: row.get(2)?,
                title: row.get(3)?,
                description: row.get(4)?,
                agent_id: row.get(5)?,
                reporter_name: row.get(6)?,
                reporter_email: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                context: serde_json::from_str(&context_json).unwrap_or_else(|_| json!({})),
                remote_status: row.get(11)?,
                remote_error: row.get(12)?,
                slack_notified: row.get(13)?,
                dispatched_agent_id: row.get(14)?,
                dispatched_at: row.get(15)?,
            })
        })
        .optional()
    }

    pub fn insert_feedback_report(&self, report: &FeedbackReport) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO feedback_reports (
                id, kind, status, title, description, agent_id, reporter_name, reporter_email,
                created_at, updated_at, context_json, remote_status, remote_error, slack_notified,
                dispatched_agent_id, dispatched_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                &report.id,
                &report.kind,
                &report.status,
                &report.title,
                &report.description,
                &report.agent_id,
                &report.reporter_name,
                &report.reporter_email,
                &report.created_at,
                &report.updated_at,
                &serde_json::to_string(&report.context).unwrap_or_else(|_| "{}".to_string()),
                &report.remote_status,
                &report.remote_error,
                report.slack_notified,
                &report.dispatched_agent_id,
                &report.dispatched_at
            ],
        )?;
        Ok(())
    }

    pub fn update_feedback_report_delivery(
        &self,
        report_id: &str,
        remote_status: &str,
        remote_error: Option<&str>,
        slack_notified: bool,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE feedback_reports
             SET remote_status = ?1, remote_error = ?2, slack_notified = ?3, updated_at = ?4
             WHERE id = ?5",
            params![
                remote_status,
                remote_error,
                slack_notified,
                Utc::now().to_rfc3339(),
                report_id
            ],
        )?;
        Ok(())
    }

    pub fn mark_feedback_report_dispatched(
        &self,
        report_id: &str,
        dispatched_agent_id: &str,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE feedback_reports
             SET status = 'sent_to_engineer', dispatched_agent_id = ?1, dispatched_at = ?2, updated_at = ?2
             WHERE id = ?3",
            params![dispatched_agent_id, now, report_id],
        )?;
        Ok(())
    }

    // ─── Inbox Operations ────────────────────────────────────────────────────

    pub fn get_inbox_items(&self) -> SqlResult<Vec<InboxItem>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, item_type, status, payload_json, timestamp FROM inbox_items ORDER BY timestamp DESC"
        )?;

        let items = stmt
            .query_map([], |row| {
                Ok(InboxItem {
                    id: row.get(0)?,
                    item_type: row.get(1)?,
                    status: row.get(2)?,
                    payload_json: row.get(3)?,
                    timestamp: row.get(4)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(items)
    }

    pub fn add_inbox_item(&self, item: &InboxItem) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO inbox_items (id, item_type, status, payload_json, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                &item.id,
                &item.item_type,
                &item.status,
                &item.payload_json,
                &item.timestamp
            ],
        )?;
        Ok(())
    }

    pub fn update_inbox_item_status(&self, id: &str, status: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE inbox_items SET status = ?1 WHERE id = ?2",
            params![status, id],
        )?;
        Ok(())
    }

    pub fn delete_inbox_item(&self, id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM inbox_items WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ─── Agent CRUD Operations ───────────────────────────────────────────────

    /// Insert a new agent
    pub fn insert_agent(&self, agent: &Agent) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let personality_json =
            serde_json::to_string(&agent.personality).unwrap_or_else(|_| "{}".to_string());
        let capabilities_json =
            serde_json::to_string(&agent.capabilities).unwrap_or_else(|_| "{}".to_string());
        let integrations_json =
            serde_json::to_string(&agent.integrations).unwrap_or_else(|_| "[]".to_string());
        let stats_json = serde_json::to_string(&agent.stats).unwrap_or_else(|_| "{}".to_string());
        let status_str = status_to_string(&agent.status);

        let memories_json =
            serde_json::to_string(&agent.memories).unwrap_or_else(|_| "[]".to_string());
        let vi_json =
            serde_json::to_string(&agent.visual_identity).unwrap_or_else(|_| "{}".to_string());

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

        let agent = stmt
            .query_row(params![id], |row| {
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
            })
            .optional()?;

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

        let agents = stmt
            .query_map([], |row| {
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

        let personality_json =
            serde_json::to_string(&agent.personality).unwrap_or_else(|_| "{}".to_string());
        let capabilities_json =
            serde_json::to_string(&agent.capabilities).unwrap_or_else(|_| "{}".to_string());
        let integrations_json =
            serde_json::to_string(&agent.integrations).unwrap_or_else(|_| "[]".to_string());
        let stats_json = serde_json::to_string(&agent.stats).unwrap_or_else(|_| "{}".to_string());
        let memories_json =
            serde_json::to_string(&agent.memories).unwrap_or_else(|_| "[]".to_string());
        let vi_json =
            serde_json::to_string(&agent.visual_identity).unwrap_or_else(|_| "{}".to_string());
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
        tx.execute(
            "DELETE FROM purchase_history WHERE agent_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM audit_log WHERE agent_id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM security_alerts WHERE agent_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM voice_configs WHERE agent_id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM agent_bug_reports WHERE agent_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM agent_mini_apps WHERE agent_id = ?1",
            params![id],
        )?;

        // Finally delete the main agent record
        tx.execute("DELETE FROM agents WHERE id = ?1", params![id])?;

        tx.commit()?;
        Ok(())
    }

    // ─── Authorization & Permission Checks ──────────────────────────────────

    /// Check if a user owns an agent
    /// For now, returns true if agent exists (single-user mode)
    /// TODO: Implement multi-user support with user_id foreign key in agents table
    pub fn is_agent_owner(&self, agent_id: &str, _user_id: &str) -> SqlResult<bool> {
        let conn = self.conn.lock().unwrap();

        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM agents WHERE id = ?1 LIMIT 1",
                params![agent_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);

        Ok(exists)
    }

    /// Check if a user owns a budget
    /// For now, returns true if budget exists for the agent
    pub fn is_budget_owner(&self, agent_id: &str, _user_id: &str) -> SqlResult<bool> {
        let conn = self.conn.lock().unwrap();

        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM budgets WHERE agent_id = ?1 LIMIT 1",
                params![agent_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);

        Ok(exists)
    }

    /// Check if a user owns a conversation
    /// For now, returns true if conversation exists for the agent
    pub fn is_conversation_owner(&self, conversation_id: &str, _user_id: &str) -> SqlResult<bool> {
        let conn = self.conn.lock().unwrap();

        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM conversations WHERE id = ?1 LIMIT 1",
                params![conversation_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);

        Ok(exists)
    }

    /// Return the owning agent ID for a conversation, if it exists.
    pub fn get_conversation_agent_id(&self, conversation_id: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT agent_id FROM conversations WHERE id = ?1 LIMIT 1",
            params![conversation_id],
            |row| row.get(0),
        )
        .optional()
    }

    /// Check if a user has permission to modify an agent
    /// Combines existence check with future permission system
    pub fn can_modify_agent(&self, agent_id: &str, user_id: &str) -> SqlResult<bool> {
        self.is_agent_owner(agent_id, user_id)
    }

    /// Check if a user has permission to delete an agent
    pub fn can_delete_agent(&self, agent_id: &str, user_id: &str) -> SqlResult<bool> {
        self.is_agent_owner(agent_id, user_id)
    }

    // ─── Durable Webview Content ───────────────────────────────────────────

    /// Store a full forum body alongside a lightweight catalog entry.
    /// `if_absent` is used by the one-time localStorage migration so an older
    /// bounded cache can never overwrite a newer SQLite record.
    pub fn upsert_forum_state(
        &self,
        forum_id: &str,
        summary_json: &str,
        content_json: &str,
        if_absent: bool,
    ) -> SqlResult<bool> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        let changed = if if_absent {
            conn.execute(
                "INSERT OR IGNORE INTO forum_states (id, summary_json, content_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![forum_id, summary_json, content_json, &now],
            )?
        } else {
            conn.execute(
                "INSERT INTO forum_states (id, summary_json, content_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                    summary_json = excluded.summary_json,
                    content_json = excluded.content_json,
                    updated_at = excluded.updated_at",
                params![forum_id, summary_json, content_json, &now],
            )?
        };
        Ok(changed > 0)
    }

    pub fn get_forum_state_json(&self, forum_id: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT content_json FROM forum_states WHERE id = ?1",
            params![forum_id],
            |row| row.get(0),
        )
        .optional()
    }

    pub fn list_forum_summary_jsons(&self) -> SqlResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT summary_json FROM forum_states ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<SqlResult<Vec<_>>>()
    }

    pub fn delete_forum_state(&self, forum_id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM forum_states WHERE id = ?1", params![forum_id])?;
        Ok(())
    }

    pub fn upsert_agent_mini_apps(
        &self,
        agent_id: &str,
        content_json: &str,
        if_absent: bool,
    ) -> SqlResult<bool> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().to_rfc3339();
        let changed = if if_absent {
            conn.execute(
                "INSERT OR IGNORE INTO agent_mini_apps (agent_id, content_json, updated_at)
                 VALUES (?1, ?2, ?3)",
                params![agent_id, content_json, &now],
            )?
        } else {
            conn.execute(
                "INSERT INTO agent_mini_apps (agent_id, content_json, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(agent_id) DO UPDATE SET
                    content_json = excluded.content_json,
                    updated_at = excluded.updated_at",
                params![agent_id, content_json, &now],
            )?
        };
        Ok(changed > 0)
    }

    pub fn get_agent_mini_apps_json(&self, agent_id: &str) -> SqlResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT content_json FROM agent_mini_apps WHERE agent_id = ?1",
            params![agent_id],
            |row| row.get(0),
        )
        .optional()
    }

    pub fn delete_agent_mini_apps(&self, agent_id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM agent_mini_apps WHERE agent_id = ?1",
            params![agent_id],
        )?;
        Ok(())
    }

    // ─── Conversation & Message Operations ──────────────────────────────────

    /// Ensure a specific conversation ID exists for an agent
    pub fn ensure_conversation(&self, conv_id: &str, agent_id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        // Check if exists
        let mut stmt = conn.prepare("SELECT 1 FROM conversations WHERE id = ?1")?;
        if stmt
            .query_row(params![conv_id], |_| Ok(()))
            .optional()?
            .is_some()
        {
            return Ok(());
        }

        // Create
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO conversations (
                id, agent_id, title, created_at, updated_at, thread_status,
                background_allowed, active_run_count, checkpoint_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'idle', 0, 0, 0)",
            params![conv_id, agent_id, "New Conversation", &now, &now],
        )?;

        Ok(())
    }

    /// Get or create a conversation for an agent
    pub fn get_or_create_conversation(&self, agent_id: &str) -> SqlResult<String> {
        let conn = self.conn.lock().unwrap();

        // Check if a conversation already exists for this agent
        let mut stmt = conn.prepare(
            "SELECT id FROM conversations WHERE agent_id = ?1 ORDER BY created_at DESC LIMIT 1",
        )?;

        if let Some(existing_id) = stmt
            .query_row(params![agent_id], |row| row.get::<_, String>(0))
            .optional()?
        {
            return Ok(existing_id);
        }

        // Create a new conversation
        let conv_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO conversations (
                id, agent_id, title, created_at, updated_at, thread_status,
                background_allowed, active_run_count, checkpoint_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'idle', 0, 0, 0)",
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
            params![&msg_id, conv_id, role, content, &timestamp,],
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

        let messages = stmt
            .query_map(params![conv_id, limit as i32], |row| {
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

    /// Get the full message history for a conversation in chronological order.
    pub fn get_all_messages(&self, conv_id: &str) -> SqlResult<Vec<Message>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, timestamp
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY timestamp ASC",
        )?;

        let rows = stmt.query_map(params![conv_id], |row| {
            Ok(Message {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                timestamp: row.get(4)?,
            })
        })?;

        rows.collect::<SqlResult<Vec<_>>>()
    }

    /// Mark the start of a new thread run and push the parent conversation into
    /// the running state. This creates the durable execution primitive needed
    /// for true concurrent per-thread work.
    pub fn start_thread_run(
        &self,
        conversation_id: &str,
        agent_id: &str,
        trigger_type: &str,
    ) -> SqlResult<String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let run_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        tx.execute(
            "INSERT INTO thread_runs (
                id, conversation_id, agent_id, status, trigger_type, started_at, updated_at
             ) VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?5)",
            params![&run_id, conversation_id, agent_id, trigger_type, &now],
        )?;
        tx.execute(
            "UPDATE conversations
             SET thread_status = 'running',
                 active_run_count = active_run_count + 1,
                 last_run_id = ?1,
                 last_run_status = 'running',
                 updated_at = ?2
             WHERE id = ?3",
            params![&run_id, &now, conversation_id],
        )?;

        tx.commit()?;
        Ok(run_id)
    }

    /// Complete a thread run and reconcile the parent conversation state.
    pub fn finish_thread_run(
        &self,
        run_id: &str,
        final_status: &str,
        error_payload_json: Option<&str>,
    ) -> SqlResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let now = Utc::now().to_rfc3339();

        let conversation_id: String = tx.query_row(
            "SELECT conversation_id FROM thread_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )?;

        tx.execute(
            "UPDATE thread_runs
             SET status = ?1,
                 updated_at = ?2,
                 completed_at = ?2,
                 error_payload_json = COALESCE(?3, error_payload_json)
             WHERE id = ?4",
            params![final_status, &now, error_payload_json, run_id],
        )?;
        tx.execute(
            "UPDATE conversations
             SET active_run_count = CASE
                     WHEN active_run_count > 0 THEN active_run_count - 1
                     ELSE 0
                 END,
                 last_run_id = ?1,
                 last_run_status = ?2,
                 thread_status = CASE
                     WHEN active_run_count > 1 THEN 'running'
                     WHEN ?2 = 'completed' THEN 'idle'
                     ELSE ?2
                 END,
                 updated_at = ?3
             WHERE id = ?4",
            params![run_id, final_status, &now, &conversation_id],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// Persist a resumability checkpoint for a thread run and roll the
    /// aggregate checkpoint metadata up to the parent conversation.
    pub fn checkpoint_thread_run(
        &self,
        run_id: &str,
        checkpoint_payload_json: &str,
    ) -> SqlResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let now = Utc::now().to_rfc3339();

        let conversation_id: String = tx.query_row(
            "SELECT conversation_id FROM thread_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )?;

        tx.execute(
            "UPDATE thread_runs
             SET checkpoint_payload_json = ?1,
                 updated_at = ?2
             WHERE id = ?3",
            params![checkpoint_payload_json, &now, run_id],
        )?;
        tx.execute(
            "UPDATE conversations
             SET checkpoint_count = checkpoint_count + 1,
                 last_checkpoint_at = ?1,
                 updated_at = ?1
             WHERE id = ?2",
            params![&now, &conversation_id],
        )?;

        tx.commit()?;
        Ok(())
    }

    pub fn list_active_thread_run_ids(&self, conversation_id: &str) -> SqlResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id
             FROM thread_runs
             WHERE conversation_id = ?1 AND status = 'running'
             ORDER BY started_at DESC",
        )?;
        let rows = stmt.query_map(params![conversation_id], |row| row.get(0))?;
        rows.collect::<SqlResult<Vec<_>>>()
    }

    pub fn list_thread_runs(&self, conversation_id: &str, limit: u32) -> SqlResult<Vec<ThreadRun>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT
                id,
                conversation_id,
                agent_id,
                status,
                trigger_type,
                started_at,
                updated_at,
                completed_at,
                checkpoint_payload_json,
                error_payload_json
             FROM thread_runs
             WHERE conversation_id = ?1
             ORDER BY started_at DESC
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![conversation_id, limit as i32], |row| {
            Ok(ThreadRun {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                agent_id: row.get(2)?,
                status: row.get(3)?,
                trigger_type: row.get(4)?,
                started_at: row.get(5)?,
                updated_at: row.get(6)?,
                completed_at: row.get(7)?,
                checkpoint_payload_json: row.get(8)?,
                error_payload_json: row.get(9)?,
            })
        })?;

        rows.collect::<SqlResult<Vec<_>>>()
    }

    pub fn get_conversation_summary(
        &self,
        conversation_id: &str,
    ) -> SqlResult<Option<ConversationSummary>> {
        let conn = self.conn.lock().unwrap();

        conn.query_row(
            "SELECT
                c.id,
                c.agent_id,
                c.title,
                c.created_at,
                c.updated_at,
                COUNT(m.id) AS message_count,
                (
                    SELECT content
                    FROM messages fm
                    WHERE fm.conversation_id = c.id
                      AND fm.role = 'user'
                    ORDER BY fm.timestamp ASC
                    LIMIT 1
                ) AS first_user_message,
                c.thread_status,
                c.background_allowed,
                c.active_run_count,
                c.last_run_id,
                c.last_run_status,
                c.checkpoint_count,
                c.last_checkpoint_at
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE c.id = ?1
             GROUP BY
                c.id,
                c.agent_id,
                c.title,
                c.created_at,
                c.updated_at,
                c.thread_status,
                c.background_allowed,
                c.active_run_count,
                c.last_run_id,
                c.last_run_status,
                c.checkpoint_count,
                c.last_checkpoint_at",
            params![conversation_id],
            |row| {
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    message_count: row.get::<_, i64>(5)?.max(0) as u32,
                    first_user_message: row.get(6)?,
                    thread_status: row.get(7)?,
                    background_allowed: row.get::<_, bool>(8)?,
                    active_run_count: row.get::<_, i64>(9)?.max(0) as u32,
                    last_run_id: row.get(10)?,
                    last_run_status: row.get(11)?,
                    checkpoint_count: row.get::<_, i64>(12)?.max(0) as u32,
                    last_checkpoint_at: row.get(13)?,
                })
            },
        )
        .optional()
    }

    /// List durable conversation summaries for an agent, newest activity first.
    pub fn list_agent_conversation_summaries(
        &self,
        agent_id: &str,
        limit: u32,
    ) -> SqlResult<Vec<ConversationSummary>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT
                c.id,
                c.agent_id,
                c.title,
                c.created_at,
                c.updated_at,
                COUNT(m.id) AS message_count,
                (
                    SELECT content
                    FROM messages fm
                    WHERE fm.conversation_id = c.id
                      AND fm.role = 'user'
                    ORDER BY fm.timestamp ASC
                    LIMIT 1
                ) AS first_user_message,
                c.thread_status,
                c.background_allowed,
                c.active_run_count,
                c.last_run_id,
                c.last_run_status,
                c.checkpoint_count,
                c.last_checkpoint_at
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE c.agent_id = ?1
             GROUP BY
                c.id,
                c.agent_id,
                c.title,
                c.created_at,
                c.updated_at,
                c.thread_status,
                c.background_allowed,
                c.active_run_count,
                c.last_run_id,
                c.last_run_status,
                c.checkpoint_count,
                c.last_checkpoint_at
             ORDER BY c.updated_at DESC
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![agent_id, limit as i32], |row| {
            Ok(ConversationSummary {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                message_count: row.get::<_, i64>(5)?.max(0) as u32,
                first_user_message: row.get(6)?,
                thread_status: row.get(7)?,
                background_allowed: row.get::<_, bool>(8)?,
                active_run_count: row.get::<_, i64>(9)?.max(0) as u32,
                last_run_id: row.get(10)?,
                last_run_status: row.get(11)?,
                checkpoint_count: row.get::<_, i64>(12)?.max(0) as u32,
                last_checkpoint_at: row.get(13)?,
            })
        })?;

        rows.collect::<SqlResult<Vec<_>>>()
    }

    // ─── Bridge Operations ──────────────────────────────────────────────────

    /// Insert a new bridge
    pub fn insert_bridge(&self, bridge: &Bridge) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let bridge_type_str =
            serde_json::to_string(&bridge.bridge_type).unwrap_or_else(|_| "custom".to_string());
        let config_json =
            serde_json::to_string(&bridge.config).unwrap_or_else(|_| "{}".to_string());
        let permissions_json =
            serde_json::to_string(&bridge.permissions).unwrap_or_else(|_| "{}".to_string());

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

        let bridge = stmt
            .query_row(params![id], |row| {
                let bridge_type_str: String = row.get(3)?;
                let config_json: String = row.get(5)?;
                let permissions_json: String = row.get(6)?;

                Ok(Bridge {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    name: row.get(2)?,
                    bridge_type: serde_json::from_str(&bridge_type_str)
                        .unwrap_or(BridgeType::Custom),
                    enabled: row.get(4)?,
                    config: serde_json::from_str(&config_json).unwrap_or_default(),
                    permissions: serde_json::from_str(&permissions_json).unwrap_or_default(),
                })
            })
            .optional()?;

        Ok(bridge)
    }

    /// List bridges for an agent
    pub fn list_bridges(&self, agent_id: &str) -> SqlResult<Vec<Bridge>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, agent_id, name, bridge_type, enabled, config_json, permissions_json
             FROM bridges WHERE agent_id = ?1",
        )?;

        let bridges = stmt
            .query_map(params![agent_id], |row| {
                let bridge_type_str: String = row.get(3)?;
                let config_json: String = row.get(5)?;
                let permissions_json: String = row.get(6)?;

                Ok(Bridge {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    name: row.get(2)?,
                    bridge_type: serde_json::from_str(&bridge_type_str)
                        .unwrap_or(BridgeType::Custom),
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

        let bridges = stmt
            .query_map([], |row| {
                let bridge_type_str: String = row.get(3)?;
                let config_json: String = row.get(5)?;
                let permissions_json: String = row.get(6)?;

                Ok(Bridge {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    name: row.get(2)?,
                    bridge_type: serde_json::from_str(&bridge_type_str)
                        .unwrap_or(BridgeType::Custom),
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

        let bridge_type_str =
            serde_json::to_string(&bridge.bridge_type).unwrap_or_else(|_| "custom".to_string());
        let config_json =
            serde_json::to_string(&bridge.config).unwrap_or_else(|_| "{}".to_string());
        let permissions_json =
            serde_json::to_string(&bridge.permissions).unwrap_or_else(|_| "{}".to_string());

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

    // ─── Security Alerts Operations ──────────────────────────────────────────

    pub fn insert_security_alert(&self, alert: &SecurityAlert) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO security_alerts (id, agent_id, timestamp, severity, description, resolved)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &alert.id,
                &alert.agent_id,
                &alert.timestamp,
                &alert.severity,
                &alert.description,
                alert.resolved
            ],
        )?;
        Ok(())
    }

    pub fn get_active_security_alerts(&self) -> SqlResult<Vec<SecurityAlert>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, timestamp, severity, description, resolved 
             FROM security_alerts 
             WHERE resolved = 0 
             ORDER BY timestamp DESC",
        )?;

        let alerts = stmt
            .query_map([], |row| {
                Ok(SecurityAlert {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    timestamp: row.get(2)?,
                    severity: row.get(3)?,
                    description: row.get(4)?,
                    resolved: row.get(5)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(alerts)
    }

    pub fn resolve_security_alert(&self, alert_id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE security_alerts SET resolved = 1 WHERE id = ?1",
            params![alert_id],
        )?;
        Ok(())
    }

    // ─── Self-Healing Agent Operations ───────────────────────────────────────

    pub fn insert_agent_bug_report(&self, report: &AgentBugReport) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agent_bug_reports (id, agent_id, timestamp, service, error_message, resolved)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &report.id,
                &report.agent_id,
                &report.timestamp,
                &report.service,
                &report.error_message,
                report.resolved
            ],
        )?;
        Ok(())
    }

    pub fn get_unresolved_bug_reports(&self) -> SqlResult<Vec<AgentBugReport>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, timestamp, service, error_message, resolved
             FROM agent_bug_reports
             WHERE resolved = 0
             ORDER BY timestamp DESC",
        )?;

        let reports = stmt
            .query_map([], |row| {
                Ok(AgentBugReport {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    timestamp: row.get(2)?,
                    service: row.get(3)?,
                    error_message: row.get(4)?,
                    resolved: row.get(5)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(reports)
    }

    pub fn resolve_bug_report(&self, report_id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE agent_bug_reports SET resolved = 1 WHERE id = ?1",
            params![report_id],
        )?;
        Ok(())
    }

    /// Get audit log entries
    pub fn get_audit_log(&self, agent_id: Option<&str>, limit: u32) -> SqlResult<Vec<AuditEntry>> {
        let conn = self.conn.lock().unwrap();

        let (query, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = if let Some(agent_id) =
            agent_id
        {
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
            })?
            .collect::<SqlResult<Vec<_>>>()?
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
            })?
            .collect::<SqlResult<Vec<_>>>()?
        };

        Ok(entries)
    }

    pub fn get_agent_browser_history(
        &self,
        agent_id: &str,
        limit: u32,
    ) -> SqlResult<Vec<BrowserHistoryEntry>> {
        let conn = self.conn.lock().unwrap();

        let query = "
            SELECT timestamp, action, detail 
            FROM audit_log 
            WHERE agent_id = ?1 AND detail LIKE '%http%'
            ORDER BY timestamp DESC
            LIMIT ?2
        ";

        let mut stmt = conn.prepare(query)?;

        let entries = stmt
            .query_map(params![agent_id, limit], |row| {
                Ok(BrowserHistoryEntry {
                    timestamp: row.get(0)?,
                    action: row.get(1)?,
                    detail: row.get(2)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(entries)
    }

    /// Get aggregated daily activity counts for the last 90 days
    pub fn get_agent_activity_heatmap(
        &self,
        agent_id: &str,
    ) -> SqlResult<Vec<ActivityHeatmapEntry>> {
        let conn = self.conn.lock().unwrap();

        let query = "
            WITH RECURSIVE dates(date) AS (
                SELECT date('now', '-89 days')
                UNION ALL
                SELECT date(date, '+1 day')
                FROM dates
                WHERE date < date('now')
            ),
            combined_logs AS (
                SELECT date(timestamp) as log_date, action, bridge_type
                FROM audit_log
                WHERE agent_id = ?1 AND timestamp >= datetime('now', '-90 days')
                
                UNION ALL
                
                SELECT date(m.timestamp) as log_date, 'chatted' as action, 
                       CASE WHEN m.role = 'user' THEN 'user' ELSE 'app' END as bridge_type
                FROM messages m
                JOIN conversations c ON m.conversation_id = c.id
                WHERE c.agent_id = ?1 AND m.timestamp >= datetime('now', '-90 days')
            )
            SELECT 
                d.date,
                SUM(CASE WHEN c.action = 'chatted' THEN 1 ELSE 0 END) as interactions,
                SUM(CASE WHEN c.action = 'tool_call' OR (c.action != 'chatted' AND c.bridge_type IS NOT NULL) THEN 1 ELSE 0 END) as tools,
                SUM(CASE WHEN c.action != 'chatted' AND c.action != 'tool_call' AND c.bridge_type IS NULL THEN 1 ELSE 0 END) as system
            FROM dates d
            LEFT JOIN combined_logs c ON d.date = c.log_date
            GROUP BY d.date
            ORDER BY d.date ASC
        ";

        let mut stmt = conn.prepare(query)?;

        let heatmap = stmt
            .query_map(params![agent_id], |row| {
                let interactions: u32 = row.get(1).unwrap_or(0);
                let tools: u32 = row.get(2).unwrap_or(0);
                let system: u32 = row.get(3).unwrap_or(0);

                Ok(ActivityHeatmapEntry {
                    date: row.get(0)?,
                    interactions,
                    tools,
                    system,
                    total: interactions + tools + system,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(heatmap)
    }

    // ─── Budget Operations ─────────────────────────────────────────────────

    /// Get a budget for an agent
    pub fn get_budget(&self, agent_id: &str) -> SqlResult<Option<AgentBudget>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT agent_id, config_json, daily_spent_cents, monthly_spent_cents, last_reset_date
             FROM budgets WHERE agent_id = ?1",
        )?;

        let budget = stmt
            .query_row(params![agent_id], |row| {
                let config_json: String = row.get(1)?;
                let default_budget = AgentBudget {
                    agent_id: row.get(0)?,
                    payments_enabled: false,
                    auto_approve_threshold_cents: 0,
                    per_transaction_limit_cents: 0,
                    daily_limit_cents: 0,
                    monthly_limit_cents: 0,
                    hourly_velocity_limit: 5,
                    allowed_categories: vec![],
                    allowed_merchants: vec![],
                    blocked_merchants: vec![],
                    daily_spent_cents: row.get(2)?,
                    monthly_spent_cents: row.get(3)?,
                    require_approval_new_merchant: false,
                    require_approval_recurring: false,
                };

                let mut config: AgentBudget =
                    serde_json::from_str(&config_json).unwrap_or(default_budget);
                config.daily_spent_cents = row.get(2)?;
                config.monthly_spent_cents = row.get(3)?;

                Ok(config)
            })
            .optional()?;

        Ok(budget)
    }

    /// Insert or update a budget
    pub fn upsert_budget(&self, budget: &AgentBudget) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let config_json = serde_json::to_string(budget).unwrap_or_else(|_| "{}".to_string());
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

        let decision_json =
            serde_json::to_string(&record.decision).unwrap_or_else(|_| "{}".to_string());

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

    pub fn get_purchase_record(&self, id: &str) -> SqlResult<Option<PurchaseRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, description, merchant, amount_cents, category, decision, virtual_card_id, timestamp
             FROM purchase_history
             WHERE id = ?1
             LIMIT 1",
        )?;

        stmt.query_row(params![id], |row| {
            let decision_json: String = row.get(6)?;
            let timestamp_str: String = row.get(8)?;

            Ok(PurchaseRecord {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                description: row.get(2)?,
                merchant: row.get(3)?,
                amount_cents: row.get::<_, i64>(4)? as u64,
                category: row.get(5)?,
                decision: serde_json::from_str(&decision_json).unwrap_or(
                    PurchaseDecision::Denied {
                        reasons: vec!["Failed to deserialize decision".to_string()],
                        flags: vec!["deserialization_error".to_string()],
                    },
                ),
                virtual_card_id: row.get(7)?,
                timestamp: chrono::DateTime::parse_from_rfc3339(&timestamp_str)
                    .unwrap_or_else(|_| chrono::DateTime::default())
                    .with_timezone(&Utc),
            })
        })
        .optional()
    }

    pub fn update_purchase_record(&self, record: &PurchaseRecord) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let decision_json =
            serde_json::to_string(&record.decision).unwrap_or_else(|_| "{}".to_string());

        conn.execute(
            "UPDATE purchase_history
             SET description = ?2,
                 merchant = ?3,
                 amount_cents = ?4,
                 category = ?5,
                 decision = ?6,
                 virtual_card_id = ?7,
                 timestamp = ?8
             WHERE id = ?1",
            params![
                &record.id,
                &record.description,
                &record.merchant,
                record.amount_cents as i64,
                &record.category,
                decision_json,
                &record.virtual_card_id,
                record.timestamp.to_rfc3339(),
            ],
        )?;

        Ok(())
    }

    /// Get purchase history for an agent
    pub fn get_purchase_history(
        &self,
        agent_id: &str,
        limit: u32,
    ) -> SqlResult<Vec<PurchaseRecord>> {
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, agent_id, description, merchant, amount_cents, category, decision, virtual_card_id, timestamp
             FROM purchase_history
             WHERE agent_id = ?1
             ORDER BY timestamp DESC
             LIMIT ?2",
        )?;

        let records = stmt
            .query_map(params![agent_id, limit as i32], |row| {
                let decision_json: String = row.get(6)?;
                let timestamp_str: String = row.get(8)?;

                Ok(PurchaseRecord {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    description: row.get(2)?,
                    merchant: row.get(3)?,
                    amount_cents: row.get::<_, i32>(4)? as u64,
                    category: row.get(5)?,
                    decision: serde_json::from_str(&decision_json).unwrap_or(
                        PurchaseDecision::Denied {
                            reasons: vec!["Failed to deserialize decision".to_string()],
                            flags: vec!["deserialization_error".to_string()],
                        },
                    ),
                    virtual_card_id: row.get(7)?,
                    timestamp: chrono::DateTime::parse_from_rfc3339(&timestamp_str)
                        .unwrap_or_else(|_| chrono::DateTime::default())
                        .with_timezone(&Utc),
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(records)
    }

    pub fn create_payment_approval_request(
        &self,
        approval: &PurchaseApprovalRequest,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let request_json =
            serde_json::to_string(&approval.purchase_request).unwrap_or_else(|_| "{}".to_string());
        let flags_json =
            serde_json::to_string(&approval.flags).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO payment_approval_requests
             (id, agent_id, purchase_record_id, request_json, reason, flags_json, status, created_at, resolved_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                &approval.id,
                &approval.agent_id,
                &approval.purchase_record_id,
                request_json,
                &approval.reason,
                flags_json,
                serde_json::to_string(&approval.status).unwrap_or_else(|_| "\"pending\"".to_string()),
                approval.created_at.to_rfc3339(),
                approval.resolved_at.map(|value| value.to_rfc3339()),
                approval.expires_at.map(|value| value.to_rfc3339()),
            ],
        )?;
        Ok(())
    }

    pub fn get_payment_approval_request(
        &self,
        approval_id: &str,
    ) -> SqlResult<Option<PurchaseApprovalRequest>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, purchase_record_id, request_json, reason, flags_json, status, created_at, resolved_at, expires_at
             FROM payment_approval_requests
             WHERE id = ?1
             LIMIT 1",
        )?;

        stmt.query_row(params![approval_id], |row| {
            let request_json: String = row.get(3)?;
            let flags_json: String = row.get(5)?;
            let status_json: String = row.get(6)?;
            let created_at: String = row.get(7)?;
            let resolved_at: Option<String> = row.get(8)?;
            let expires_at: Option<String> = row.get(9)?;

            Ok(PurchaseApprovalRequest {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                purchase_record_id: row.get(2)?,
                purchase_request: serde_json::from_str(&request_json).unwrap_or(PurchaseRequest {
                    agent_id: row.get::<_, String>(1)?,
                    description: "Unknown purchase".to_string(),
                    merchant: "Unknown".to_string(),
                    amount_cents: 0,
                    category: "unknown".to_string(),
                    is_recurring: false,
                }),
                reason: row.get(4)?,
                flags: serde_json::from_str(&flags_json).unwrap_or_default(),
                status: serde_json::from_str(&status_json)
                    .unwrap_or(PurchaseApprovalStatus::Pending),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .unwrap_or_else(|_| chrono::DateTime::default())
                    .with_timezone(&Utc),
                resolved_at: resolved_at.and_then(|value| {
                    chrono::DateTime::parse_from_rfc3339(&value)
                        .ok()
                        .map(|parsed| parsed.with_timezone(&Utc))
                }),
                expires_at: expires_at.and_then(|value| {
                    chrono::DateTime::parse_from_rfc3339(&value)
                        .ok()
                        .map(|parsed| parsed.with_timezone(&Utc))
                }),
            })
        })
        .optional()
    }

    pub fn list_payment_approval_requests(
        &self,
        agent_id: Option<&str>,
        pending_only: bool,
    ) -> SqlResult<Vec<PurchaseApprovalRequest>> {
        let conn = self.conn.lock().unwrap();
        let query = match (agent_id, pending_only) {
            (Some(_), true) => {
                "SELECT id, agent_id, purchase_record_id, request_json, reason, flags_json, status, created_at, resolved_at, expires_at
                 FROM payment_approval_requests
                 WHERE agent_id = ?1 AND status = '\"pending\"'
                 ORDER BY created_at DESC"
            }
            (Some(_), false) => {
                "SELECT id, agent_id, purchase_record_id, request_json, reason, flags_json, status, created_at, resolved_at, expires_at
                 FROM payment_approval_requests
                 WHERE agent_id = ?1
                 ORDER BY created_at DESC"
            }
            (None, true) => {
                "SELECT id, agent_id, purchase_record_id, request_json, reason, flags_json, status, created_at, resolved_at, expires_at
                 FROM payment_approval_requests
                 WHERE status = '\"pending\"'
                 ORDER BY created_at DESC"
            }
            (None, false) => {
                "SELECT id, agent_id, purchase_record_id, request_json, reason, flags_json, status, created_at, resolved_at, expires_at
                 FROM payment_approval_requests
                 ORDER BY created_at DESC"
            }
        };

        let mut stmt = conn.prepare(query)?;
        let rows = if let Some(agent_id) = agent_id {
            stmt.query_map(params![agent_id], |row| {
                let request_json: String = row.get(3)?;
                let flags_json: String = row.get(5)?;
                let status_json: String = row.get(6)?;
                let created_at: String = row.get(7)?;
                let resolved_at: Option<String> = row.get(8)?;
                let expires_at: Option<String> = row.get(9)?;
                Ok(PurchaseApprovalRequest {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    purchase_record_id: row.get(2)?,
                    purchase_request: serde_json::from_str(&request_json).unwrap_or(
                        PurchaseRequest {
                            agent_id: row.get::<_, String>(1)?,
                            description: "Unknown purchase".to_string(),
                            merchant: "Unknown".to_string(),
                            amount_cents: 0,
                            category: "unknown".to_string(),
                            is_recurring: false,
                        },
                    ),
                    reason: row.get(4)?,
                    flags: serde_json::from_str(&flags_json).unwrap_or_default(),
                    status: serde_json::from_str(&status_json)
                        .unwrap_or(PurchaseApprovalStatus::Pending),
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                        .unwrap_or_else(|_| chrono::DateTime::default())
                        .with_timezone(&Utc),
                    resolved_at: resolved_at.and_then(|value| {
                        chrono::DateTime::parse_from_rfc3339(&value)
                            .ok()
                            .map(|parsed| parsed.with_timezone(&Utc))
                    }),
                    expires_at: expires_at.and_then(|value| {
                        chrono::DateTime::parse_from_rfc3339(&value)
                            .ok()
                            .map(|parsed| parsed.with_timezone(&Utc))
                    }),
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?
        } else {
            stmt.query_map([], |row| {
                let request_json: String = row.get(3)?;
                let flags_json: String = row.get(5)?;
                let status_json: String = row.get(6)?;
                let created_at: String = row.get(7)?;
                let resolved_at: Option<String> = row.get(8)?;
                let expires_at: Option<String> = row.get(9)?;
                Ok(PurchaseApprovalRequest {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    purchase_record_id: row.get(2)?,
                    purchase_request: serde_json::from_str(&request_json).unwrap_or(
                        PurchaseRequest {
                            agent_id: row.get::<_, String>(1)?,
                            description: "Unknown purchase".to_string(),
                            merchant: "Unknown".to_string(),
                            amount_cents: 0,
                            category: "unknown".to_string(),
                            is_recurring: false,
                        },
                    ),
                    reason: row.get(4)?,
                    flags: serde_json::from_str(&flags_json).unwrap_or_default(),
                    status: serde_json::from_str(&status_json)
                        .unwrap_or(PurchaseApprovalStatus::Pending),
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                        .unwrap_or_else(|_| chrono::DateTime::default())
                        .with_timezone(&Utc),
                    resolved_at: resolved_at.and_then(|value| {
                        chrono::DateTime::parse_from_rfc3339(&value)
                            .ok()
                            .map(|parsed| parsed.with_timezone(&Utc))
                    }),
                    expires_at: expires_at.and_then(|value| {
                        chrono::DateTime::parse_from_rfc3339(&value)
                            .ok()
                            .map(|parsed| parsed.with_timezone(&Utc))
                    }),
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?
        };

        Ok(rows)
    }

    pub fn update_payment_approval_request(
        &self,
        approval: &PurchaseApprovalRequest,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let request_json =
            serde_json::to_string(&approval.purchase_request).unwrap_or_else(|_| "{}".to_string());
        let flags_json =
            serde_json::to_string(&approval.flags).unwrap_or_else(|_| "[]".to_string());
        let status_json =
            serde_json::to_string(&approval.status).unwrap_or_else(|_| "\"pending\"".to_string());
        conn.execute(
            "UPDATE payment_approval_requests
             SET request_json = ?2,
                 reason = ?3,
                 flags_json = ?4,
                 status = ?5,
                 resolved_at = ?6,
                 expires_at = ?7
             WHERE id = ?1",
            params![
                &approval.id,
                request_json,
                &approval.reason,
                flags_json,
                status_json,
                approval.resolved_at.map(|value| value.to_rfc3339()),
                approval.expires_at.map(|value| value.to_rfc3339()),
            ],
        )?;
        Ok(())
    }

    pub fn record_virtual_card(&self, card: &VirtualCardRecord) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO virtual_cards
             (id, agent_id, purchase_record_id, provider, provider_card_ref, last_four, amount_cents, merchant, memo, status, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                &card.id,
                &card.agent_id,
                &card.purchase_record_id,
                serde_json::to_string(&card.provider).unwrap_or_else(|_| "\"mock\"".to_string()),
                &card.provider_card_ref,
                &card.last_four,
                card.amount_cents as i64,
                &card.merchant,
                &card.memo,
                serde_json::to_string(&card.status).unwrap_or_else(|_| "\"active\"".to_string()),
                card.created_at.to_rfc3339(),
                card.expires_at.map(|value| value.to_rfc3339()),
            ],
        )?;
        Ok(())
    }

    pub fn get_virtual_card(&self, card_id: &str) -> SqlResult<Option<VirtualCardRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, purchase_record_id, provider, provider_card_ref, last_four, amount_cents, merchant, memo, status, created_at, expires_at
             FROM virtual_cards
             WHERE id = ?1
             LIMIT 1",
        )?;

        stmt.query_row(params![card_id], |row| {
            let provider_json: String = row.get(3)?;
            let status_json: String = row.get(9)?;
            let created_at: String = row.get(10)?;
            let expires_at: Option<String> = row.get(11)?;
            Ok(VirtualCardRecord {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                purchase_record_id: row.get(2)?,
                provider: serde_json::from_str(&provider_json)
                    .unwrap_or(VirtualCardProviderKind::Mock),
                provider_card_ref: row.get(4)?,
                last_four: row.get(5)?,
                amount_cents: row.get::<_, i64>(6)? as u64,
                merchant: row.get(7)?,
                memo: row.get(8)?,
                status: serde_json::from_str(&status_json).unwrap_or(VirtualCardStatus::Active),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .unwrap_or_else(|_| chrono::DateTime::default())
                    .with_timezone(&Utc),
                expires_at: expires_at.and_then(|value| {
                    chrono::DateTime::parse_from_rfc3339(&value)
                        .ok()
                        .map(|parsed| parsed.with_timezone(&Utc))
                }),
            })
        })
        .optional()
    }

    pub fn get_virtual_card_by_provider_ref(
        &self,
        provider: &VirtualCardProviderKind,
        provider_card_ref: &str,
    ) -> SqlResult<Option<VirtualCardRecord>> {
        let conn = self.conn.lock().unwrap();
        let provider_json =
            serde_json::to_string(provider).unwrap_or_else(|_| "\"mock\"".to_string());
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, purchase_record_id, provider, provider_card_ref, last_four, amount_cents, merchant, memo, status, created_at, expires_at
             FROM virtual_cards
             WHERE provider = ?1 AND provider_card_ref = ?2
             LIMIT 1",
        )?;

        stmt.query_row(params![provider_json, provider_card_ref], |row| {
            let provider_json: String = row.get(3)?;
            let status_json: String = row.get(9)?;
            let created_at: String = row.get(10)?;
            let expires_at: Option<String> = row.get(11)?;
            Ok(VirtualCardRecord {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                purchase_record_id: row.get(2)?,
                provider: serde_json::from_str(&provider_json)
                    .unwrap_or(VirtualCardProviderKind::Mock),
                provider_card_ref: row.get(4)?,
                last_four: row.get(5)?,
                amount_cents: row.get::<_, i64>(6)? as u64,
                merchant: row.get(7)?,
                memo: row.get(8)?,
                status: serde_json::from_str(&status_json).unwrap_or(VirtualCardStatus::Active),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .unwrap_or_else(|_| chrono::DateTime::default())
                    .with_timezone(&Utc),
                expires_at: expires_at.and_then(|value| {
                    chrono::DateTime::parse_from_rfc3339(&value)
                        .ok()
                        .map(|parsed| parsed.with_timezone(&Utc))
                }),
            })
        })
        .optional()
    }

    pub fn list_virtual_cards(
        &self,
        agent_id: &str,
        active_only: bool,
    ) -> SqlResult<Vec<VirtualCardRecord>> {
        let conn = self.conn.lock().unwrap();
        let query = if active_only {
            "SELECT id, agent_id, purchase_record_id, provider, provider_card_ref, last_four, amount_cents, merchant, memo, status, created_at, expires_at
             FROM virtual_cards
             WHERE agent_id = ?1 AND status = '\"active\"'
             ORDER BY created_at DESC"
        } else {
            "SELECT id, agent_id, purchase_record_id, provider, provider_card_ref, last_four, amount_cents, merchant, memo, status, created_at, expires_at
             FROM virtual_cards
             WHERE agent_id = ?1
             ORDER BY created_at DESC"
        };

        let mut stmt = conn.prepare(query)?;
        let cards = stmt
            .query_map(params![agent_id], |row| {
                let provider_json: String = row.get(3)?;
                let status_json: String = row.get(9)?;
                let created_at: String = row.get(10)?;
                let expires_at: Option<String> = row.get(11)?;
                Ok(VirtualCardRecord {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    purchase_record_id: row.get(2)?,
                    provider: serde_json::from_str(&provider_json)
                        .unwrap_or(VirtualCardProviderKind::Mock),
                    provider_card_ref: row.get(4)?,
                    last_four: row.get(5)?,
                    amount_cents: row.get::<_, i64>(6)? as u64,
                    merchant: row.get(7)?,
                    memo: row.get(8)?,
                    status: serde_json::from_str(&status_json).unwrap_or(VirtualCardStatus::Active),
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                        .unwrap_or_else(|_| chrono::DateTime::default())
                        .with_timezone(&Utc),
                    expires_at: expires_at.and_then(|value| {
                        chrono::DateTime::parse_from_rfc3339(&value)
                            .ok()
                            .map(|parsed| parsed.with_timezone(&Utc))
                    }),
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(cards)
    }

    pub fn update_virtual_card(&self, card: &VirtualCardRecord) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE virtual_cards
             SET provider = ?2,
                 provider_card_ref = ?3,
                 last_four = ?4,
                 amount_cents = ?5,
                 merchant = ?6,
                 memo = ?7,
                 status = ?8,
                 expires_at = ?9
             WHERE id = ?1",
            params![
                &card.id,
                serde_json::to_string(&card.provider).unwrap_or_else(|_| "\"mock\"".to_string()),
                &card.provider_card_ref,
                &card.last_four,
                card.amount_cents as i64,
                &card.merchant,
                &card.memo,
                serde_json::to_string(&card.status).unwrap_or_else(|_| "\"active\"".to_string()),
                card.expires_at.map(|value| value.to_rfc3339()),
            ],
        )?;
        Ok(())
    }

    pub fn record_payment_audit_entry(&self, entry: &PaymentAuditEntry) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO payment_audit_log (id, agent_id, event_type, detail_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                &entry.id,
                &entry.agent_id,
                &entry.event_type,
                serde_json::to_string(&entry.detail_json).unwrap_or_else(|_| "{}".to_string()),
                entry.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn list_payment_audit_entries(
        &self,
        agent_id: &str,
        limit: u32,
    ) -> SqlResult<Vec<PaymentAuditEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, event_type, detail_json, created_at
             FROM payment_audit_log
             WHERE agent_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )?;

        let entries = stmt
            .query_map(params![agent_id, limit as i32], |row| {
                let detail_json: String = row.get(3)?;
                let created_at: String = row.get(4)?;
                Ok(PaymentAuditEntry {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    event_type: row.get(2)?,
                    detail_json: serde_json::from_str(&detail_json)
                        .unwrap_or_else(|_| serde_json::json!({})),
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                        .unwrap_or_else(|_| chrono::DateTime::default())
                        .with_timezone(&Utc),
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(entries)
    }

    pub fn record_payment_transaction(
        &self,
        transaction: &PaymentTransactionRecord,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO payment_transactions
             (id, agent_id, purchase_record_id, virtual_card_id, provider, provider_transaction_ref, merchant, amount_cents, status, source, decline_reason, created_at, settled_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                &transaction.id,
                &transaction.agent_id,
                &transaction.purchase_record_id,
                &transaction.virtual_card_id,
                serde_json::to_string(&transaction.provider).unwrap_or_else(|_| "\"mock\"".to_string()),
                &transaction.provider_transaction_ref,
                &transaction.merchant,
                transaction.amount_cents as i64,
                serde_json::to_string(&transaction.status).unwrap_or_else(|_| "\"captured\"".to_string()),
                &transaction.source,
                &transaction.decline_reason,
                transaction.created_at.to_rfc3339(),
                transaction.settled_at.map(|value| value.to_rfc3339()),
            ],
        )?;
        Ok(())
    }

    pub fn get_payment_transaction_by_provider_ref(
        &self,
        provider: &VirtualCardProviderKind,
        provider_transaction_ref: &str,
    ) -> SqlResult<Option<PaymentTransactionRecord>> {
        let conn = self.conn.lock().unwrap();
        let provider_json =
            serde_json::to_string(provider).unwrap_or_else(|_| "\"mock\"".to_string());
        conn.query_row(
            "SELECT id, agent_id, purchase_record_id, virtual_card_id, provider, provider_transaction_ref, merchant, amount_cents, status, source, decline_reason, created_at, settled_at
             FROM payment_transactions
             WHERE provider = ?1 AND provider_transaction_ref = ?2
             LIMIT 1",
            params![provider_json, provider_transaction_ref],
            |row| {
                let provider_json: String = row.get(4)?;
                let status_json: String = row.get(8)?;
                let created_at: String = row.get(11)?;
                let settled_at: Option<String> = row.get(12)?;
                Ok(PaymentTransactionRecord {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    purchase_record_id: row.get(2)?,
                    virtual_card_id: row.get(3)?,
                    provider: serde_json::from_str(&provider_json)
                        .unwrap_or(VirtualCardProviderKind::Mock),
                    provider_transaction_ref: row.get(5)?,
                    merchant: row.get(6)?,
                    amount_cents: row.get::<_, i64>(7)? as u64,
                    status: serde_json::from_str(&status_json)
                        .unwrap_or(PaymentTransactionStatus::Captured),
                    source: row.get(9)?,
                    decline_reason: row.get(10)?,
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                        .unwrap_or_else(|_| chrono::DateTime::default())
                        .with_timezone(&Utc),
                    settled_at: settled_at.and_then(|value| {
                        chrono::DateTime::parse_from_rfc3339(&value)
                            .ok()
                            .map(|parsed| parsed.with_timezone(&Utc))
                    }),
                })
            },
        )
        .optional()
    }

    pub fn list_payment_transactions(
        &self,
        agent_id: &str,
        limit: u32,
    ) -> SqlResult<Vec<PaymentTransactionRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, purchase_record_id, virtual_card_id, provider, provider_transaction_ref, merchant, amount_cents, status, source, decline_reason, created_at, settled_at
             FROM payment_transactions
             WHERE agent_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )?;

        let transactions = stmt
            .query_map(params![agent_id, limit as i32], |row| {
                let provider_json: String = row.get(4)?;
                let status_json: String = row.get(8)?;
                let created_at: String = row.get(11)?;
                let settled_at: Option<String> = row.get(12)?;
                Ok(PaymentTransactionRecord {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    purchase_record_id: row.get(2)?,
                    virtual_card_id: row.get(3)?,
                    provider: serde_json::from_str(&provider_json)
                        .unwrap_or(VirtualCardProviderKind::Mock),
                    provider_transaction_ref: row.get(5)?,
                    merchant: row.get(6)?,
                    amount_cents: row.get::<_, i64>(7)? as u64,
                    status: serde_json::from_str(&status_json)
                        .unwrap_or(PaymentTransactionStatus::Captured),
                    source: row.get(9)?,
                    decline_reason: row.get(10)?,
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                        .unwrap_or_else(|_| chrono::DateTime::default())
                        .with_timezone(&Utc),
                    settled_at: settled_at.and_then(|value| {
                        chrono::DateTime::parse_from_rfc3339(&value)
                            .ok()
                            .map(|parsed| parsed.with_timezone(&Utc))
                    }),
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(transactions)
    }

    pub fn list_payment_transactions_for_card(
        &self,
        card_id: &str,
    ) -> SqlResult<Vec<PaymentTransactionRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, purchase_record_id, virtual_card_id, provider, provider_transaction_ref, merchant, amount_cents, status, source, decline_reason, created_at, settled_at
             FROM payment_transactions
             WHERE virtual_card_id = ?1
             ORDER BY created_at DESC",
        )?;

        let transactions = stmt
            .query_map(params![card_id], |row| {
                let provider_json: String = row.get(4)?;
                let status_json: String = row.get(8)?;
                let created_at: String = row.get(11)?;
                let settled_at: Option<String> = row.get(12)?;
                Ok(PaymentTransactionRecord {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    purchase_record_id: row.get(2)?,
                    virtual_card_id: row.get(3)?,
                    provider: serde_json::from_str(&provider_json)
                        .unwrap_or(VirtualCardProviderKind::Mock),
                    provider_transaction_ref: row.get(5)?,
                    merchant: row.get(6)?,
                    amount_cents: row.get::<_, i64>(7)? as u64,
                    status: serde_json::from_str(&status_json)
                        .unwrap_or(PaymentTransactionStatus::Captured),
                    source: row.get(9)?,
                    decline_reason: row.get(10)?,
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                        .unwrap_or_else(|_| chrono::DateTime::default())
                        .with_timezone(&Utc),
                    settled_at: settled_at.and_then(|value| {
                        chrono::DateTime::parse_from_rfc3339(&value)
                            .ok()
                            .map(|parsed| parsed.with_timezone(&Utc))
                    }),
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(transactions)
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

        self.log_audit_internal(
            &conn,
            None,
            "reset_daily_budgets",
            None,
            "Daily budgets reset",
            None,
        )?;

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

        self.log_audit_internal(
            &conn,
            None,
            "reset_monthly_budgets",
            None,
            "Monthly budgets reset",
            None,
        )?;

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
    pub fn update_agent_spending(
        &self,
        agent_id: &str,
        amount_cents: u64,
        is_daily: bool,
        is_monthly: bool,
    ) -> SqlResult<()> {
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

    pub fn adjust_agent_spending(
        &self,
        agent_id: &str,
        delta_cents: i64,
        is_daily: bool,
        is_monthly: bool,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        if is_daily {
            conn.execute(
                "UPDATE budgets
                 SET daily_spent_cents = MAX(0, daily_spent_cents + ?1)
                 WHERE agent_id = ?2",
                params![delta_cents, agent_id],
            )?;
        }

        if is_monthly {
            conn.execute(
                "UPDATE budgets
                 SET monthly_spent_cents = MAX(0, monthly_spent_cents + ?1)
                 WHERE agent_id = ?2",
                params![delta_cents, agent_id],
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
            let caps_json =
                serde_json::to_string(&m.capabilities).unwrap_or_else(|_| "[]".to_string());
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

        let models = stmt
            .query_map([], |row| {
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
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(models)
    }

    pub fn remove_provider_model(&self, id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM provider_models WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ─── Voice Operations ────────────────────────────────────────────────────

    pub fn upsert_voice_config(&self, config: &crate::voice::VoiceConfig) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let config_json = config.to_json().map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO voice_configs (agent_id, config_json) VALUES (?1, ?2)
             ON CONFLICT(agent_id) DO UPDATE SET config_json = excluded.config_json",
            params![&config.agent_id, config_json],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_voice_config(
        &self,
        agent_id: &str,
    ) -> Result<Option<crate::voice::VoiceConfig>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT config_json FROM voice_configs WHERE agent_id = ?1")
            .map_err(|e| e.to_string())?;

        let json_str: String = match stmt.query_row(params![agent_id], |row| row.get(0)) {
            Ok(val) => val,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };

        let config = crate::voice::VoiceConfig::from_json(&json_str).map_err(|e| e.to_string())?;
        Ok(Some(config))
    }

    pub fn insert_token_usage_record(
        &self,
        record: &crate::models::TokenUsageRecord,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO token_usage_history
                (id, agent_id, conversation_id, timestamp, model, provider, tokens_in, tokens_out, cost_usd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                &record.id,
                &record.agent_id,
                &record.conversation_id,
                &record.timestamp,
                &record.model,
                &record.provider,
                &record.tokens_in,
                &record.tokens_out,
                &record.cost_usd
            ],
        )?;
        Ok(())
    }

    pub fn get_token_usage_history(
        &self,
        agent_id: Option<&str>,
        conversation_id: Option<&str>,
        conversation_id_prefix: Option<&str>,
        days: u32,
    ) -> SqlResult<Vec<crate::models::TokenUsageRecord>> {
        let conn = self.conn.lock().unwrap();

        let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
        let cutoff_str = cutoff.to_rfc3339();

        let mut query = String::from(
            "SELECT id, agent_id, conversation_id, timestamp, model, provider, tokens_in, tokens_out, cost_usd
             FROM token_usage_history
             WHERE timestamp >= ?1"
        );

        let mut sql_params: Vec<&dyn rusqlite::ToSql> = vec![&cutoff_str];
        let mut next_param_idx = 2;

        if let Some(ref a_id) = agent_id {
            query.push_str(&format!(" AND agent_id = ?{}", next_param_idx));
            sql_params.push(a_id);
            next_param_idx += 1;
        }

        if let Some(ref c_id) = conversation_id {
            query.push_str(&format!(" AND conversation_id = ?{}", next_param_idx));
            sql_params.push(c_id);
            next_param_idx += 1;
        }

        // Prefix match — forum sends use session ids like
        // forum_{forumId}_{agentId}_{phase}, so per-forum aggregation needs
        // LIKE 'forum_{forumId}_%'. ESCAPE '\' guards the underscores/percents
        // inside the prefix itself from acting as wildcards.
        let like_pattern;
        if let Some(prefix) = conversation_id_prefix {
            let escaped = prefix
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            like_pattern = format!("{}%", escaped);
            query.push_str(&format!(
                " AND conversation_id LIKE ?{} ESCAPE '\\'",
                next_param_idx
            ));
            sql_params.push(&like_pattern);
            next_param_idx += 1;
        }

        query.push_str(" ORDER BY timestamp ASC");

        let mut stmt = conn.prepare(&query)?;

        let rows = stmt.query_map(rusqlite::params_from_iter(sql_params), |row| {
            Ok(crate::models::TokenUsageRecord {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                conversation_id: row.get(2)?,
                timestamp: row.get(3)?,
                model: row.get(4)?,
                provider: row.get(5)?,
                tokens_in: row.get(6)?,
                tokens_out: row.get(7)?,
                cost_usd: row.get(8)?,
            })
        })?;

        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    pub fn get_system_warnings(&self) -> SqlResult<Vec<crate::models::SystemWarning>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, timestamp, warning_type, message, resolved 
             FROM system_warnings 
             WHERE resolved = 0 
             ORDER BY timestamp DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(crate::models::SystemWarning {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                timestamp: row.get(2)?,
                warning_type: row.get(3)?,
                message: row.get(4)?,
                resolved: row.get(5)?,
            })
        })?;

        let mut warnings = Vec::new();
        for row in rows {
            warnings.push(row?);
        }
        Ok(warnings)
    }

    pub fn resolve_system_warning(&self, warning_id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE system_warnings SET resolved = 1 WHERE id = ?1",
            rusqlite::params![warning_id],
        )?;
        Ok(())
    }

    // ─── Managed companion profiles, grants, resources, and reports ────────

    pub fn insert_companion_profile(&self, profile: &CompanionProfile) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO companion_profiles
                (id, display_name, profile_type, context_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                profile.id,
                profile.display_name,
                profile.profile_type,
                profile.context_json.to_string(),
                profile.created_at,
                profile.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn get_companion_profile(&self, profile_id: &str) -> SqlResult<Option<CompanionProfile>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, display_name, profile_type, context_json, created_at, updated_at
             FROM companion_profiles WHERE id = ?1",
            params![profile_id],
            |row| {
                let context: String = row.get(3)?;
                Ok(CompanionProfile {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    profile_type: row.get(2)?,
                    context_json: serde_json::from_str(&context).unwrap_or_else(|_| json!({})),
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
    }

    pub fn update_companion_profile(&self, profile: &CompanionProfile) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE companion_profiles
             SET display_name = ?1, profile_type = ?2, context_json = ?3, updated_at = ?4
             WHERE id = ?5",
            params![
                profile.display_name,
                profile.profile_type,
                profile.context_json.to_string(),
                profile.updated_at,
                profile.id
            ],
        )?;
        Ok(())
    }

    pub fn insert_companion_grant(&self, grant: &CompanionDeviceGrant) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO companion_device_grants
                (device_id, profile_id, device_name, experience, allowed_agent_ids_json,
                 created_at, last_seen_at, revoked)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                grant.device_id,
                grant.profile_id,
                grant.device_name,
                grant.experience,
                serde_json::to_string(&grant.allowed_agent_ids).unwrap_or_else(|_| "[]".into()),
                grant.created_at,
                grant.last_seen_at,
                grant.revoked
            ],
        )?;
        Ok(())
    }

    pub fn get_companion_grant(&self, device_id: &str) -> SqlResult<Option<CompanionDeviceGrant>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT device_id, profile_id, device_name, experience, allowed_agent_ids_json,
                    created_at, last_seen_at, revoked
             FROM companion_device_grants WHERE device_id = ?1",
            params![device_id],
            |row| {
                let allowed: String = row.get(4)?;
                Ok(CompanionDeviceGrant {
                    device_id: row.get(0)?,
                    profile_id: row.get(1)?,
                    device_name: row.get(2)?,
                    experience: row.get(3)?,
                    allowed_agent_ids: serde_json::from_str(&allowed).unwrap_or_default(),
                    created_at: row.get(5)?,
                    last_seen_at: row.get(6)?,
                    revoked: row.get(7)?,
                })
            },
        )
        .optional()
    }

    pub fn update_companion_grant(&self, grant: &CompanionDeviceGrant) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE companion_device_grants
             SET device_name = ?1, experience = ?2, allowed_agent_ids_json = ?3
             WHERE device_id = ?4 AND revoked = 0",
            params![
                grant.device_name,
                grant.experience,
                serde_json::to_string(&grant.allowed_agent_ids).unwrap_or_else(|_| "[]".into()),
                grant.device_id
            ],
        )?;
        Ok(())
    }

    pub fn list_companion_grants(&self) -> SqlResult<Vec<CompanionDeviceGrant>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT device_id, profile_id, device_name, experience, allowed_agent_ids_json,
                    created_at, last_seen_at, revoked
             FROM companion_device_grants ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let allowed: String = row.get(4)?;
            Ok(CompanionDeviceGrant {
                device_id: row.get(0)?,
                profile_id: row.get(1)?,
                device_name: row.get(2)?,
                experience: row.get(3)?,
                allowed_agent_ids: serde_json::from_str(&allowed).unwrap_or_default(),
                created_at: row.get(5)?,
                last_seen_at: row.get(6)?,
                revoked: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn touch_companion_grant(&self, device_id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE companion_device_grants SET last_seen_at = ?1 WHERE device_id = ?2",
            params![Utc::now().to_rfc3339(), device_id],
        )?;
        Ok(())
    }

    pub fn revoke_companion_grant(&self, device_id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE companion_device_grants SET revoked = 1 WHERE device_id = ?1",
            params![device_id],
        )?;
        Ok(())
    }

    pub fn insert_companion_learning_event(&self, event: &CompanionLearningEvent) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO companion_learning_events
                (id, profile_id, agent_id, session_id, event_type, subject, skill,
                 outcome, score, confidence, evidence, recommended_next, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                event.id,
                event.profile_id,
                event.agent_id,
                event.session_id,
                event.event_type,
                event.subject,
                event.skill,
                event.outcome,
                event.score,
                event.confidence,
                event.evidence,
                event.recommended_next,
                event.created_at
            ],
        )?;
        Ok(())
    }

    pub fn get_companion_messages(
        &self,
        profile_id: &str,
        agent_id: &str,
    ) -> SqlResult<Vec<Message>> {
        let grants = self.list_companion_grants()?;
        let mut messages = Vec::new();
        for grant in grants.into_iter().filter(|grant| {
            !grant.revoked
                && grant.profile_id == profile_id
                && grant.allowed_agent_ids.iter().any(|id| id == agent_id)
        }) {
            let session_id = format!("companion_{}_{}", grant.device_id, agent_id);
            messages.extend(self.get_all_messages(&session_id)?);
        }
        messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
        Ok(messages)
    }

    pub fn insert_companion_report(&self, report: &CompanionReport) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO companion_reports
                (id, profile_id, agent_id, period_start, period_end, report_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                report.id,
                report.profile_id,
                report.agent_id,
                report.period_start,
                report.period_end,
                report.report_json.to_string(),
                report.created_at
            ],
        )?;
        Ok(())
    }

    pub fn list_companion_reports(
        &self,
        profile_id: &str,
        agent_id: &str,
    ) -> SqlResult<Vec<CompanionReport>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, agent_id, period_start, period_end, report_json, created_at
             FROM companion_reports
             WHERE profile_id = ?1 AND agent_id = ?2
             ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![profile_id, agent_id], |row| {
            let report: String = row.get(5)?;
            Ok(CompanionReport {
                id: row.get(0)?,
                profile_id: row.get(1)?,
                agent_id: row.get(2)?,
                period_start: row.get(3)?,
                period_end: row.get(4)?,
                report_json: serde_json::from_str(&report).unwrap_or_else(|_| json!({})),
                created_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn upsert_companion_resource(&self, resource: &CompanionResource) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO companion_resources
                (id, profile_id, agent_id, resource_type, title, version, content_json,
                 source, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                version = companion_resources.version + 1,
                content_json = excluded.content_json,
                source = excluded.source,
                status = excluded.status,
                updated_at = excluded.updated_at",
            params![
                resource.id,
                resource.profile_id,
                resource.agent_id,
                resource.resource_type,
                resource.title,
                resource.version,
                resource.content_json.to_string(),
                resource.source,
                resource.status,
                resource.created_at,
                resource.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn list_companion_resources(
        &self,
        profile_id: &str,
        allowed_agent_ids: &[String],
    ) -> SqlResult<Vec<CompanionResource>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, agent_id, resource_type, title, version, content_json,
                    source, status, created_at, updated_at
             FROM companion_resources
             WHERE profile_id = ?1 AND status = 'published'
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![profile_id], |row| {
            let content: String = row.get(6)?;
            Ok(CompanionResource {
                id: row.get(0)?,
                profile_id: row.get(1)?,
                agent_id: row.get(2)?,
                resource_type: row.get(3)?,
                title: row.get(4)?,
                version: row.get(5)?,
                content_json: serde_json::from_str(&content).unwrap_or_else(|_| json!({})),
                source: row.get(7)?,
                status: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        let mut resources = Vec::new();
        for row in rows {
            let resource = row?;
            if allowed_agent_ids.iter().any(|id| id == &resource.agent_id) {
                resources.push(resource);
            }
        }
        Ok(resources)
    }

    pub fn insert_companion_resource_event(&self, event: &CompanionResourceEvent) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO companion_resource_events
                (id, resource_id, device_id, profile_id, agent_id, action, data_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event.id,
                event.resource_id,
                event.device_id,
                event.profile_id,
                event.agent_id,
                event.action,
                event.data_json.to_string(),
                event.created_at
            ],
        )?;
        Ok(())
    }

    // ─── Web-hosted connection token capture ───────────────────────────────

    pub fn insert_pending_connection(&self, record: &PendingConnectionRecord) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO pending_connections
                (token, agent_id, provider_name, secret_name, token_url, instructions,
                 placeholder, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                record.token,
                record.agent_id,
                record.provider_name,
                record.secret_name,
                record.token_url,
                record.instructions,
                record.placeholder,
                record.created_at,
                record.expires_at
            ],
        )?;
        Ok(())
    }

    pub fn list_pending_connections(&self) -> SqlResult<Vec<PendingConnectionRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT token, agent_id, provider_name, secret_name, token_url, instructions,
                    placeholder, created_at, expires_at
             FROM pending_connections ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PendingConnectionRecord {
                token: row.get(0)?,
                agent_id: row.get(1)?,
                provider_name: row.get(2)?,
                secret_name: row.get(3)?,
                token_url: row.get(4)?,
                instructions: row.get(5)?,
                placeholder: row.get(6)?,
                created_at: row.get(7)?,
                expires_at: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_pending_connection(&self, token: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM pending_connections WHERE token = ?1",
            params![token],
        )?;
        Ok(())
    }

    /// Sweep tokens past their TTL. Returns the number removed.
    pub fn delete_expired_pending_connections(&self, now_iso: &str) -> SqlResult<usize> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM pending_connections WHERE expires_at <= ?1",
            params![now_iso],
        )
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
            paused: false,
            container_id: Some("container-1".to_string()),
            personality: AgentPersonality {
                name: "Curious".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec!["analysis".to_string()],
                guardrails: vec!["no-code".to_string()],
                custom_instructions: "Be helpful".to_string(),
                active_model: None,
                soul_template: None,
                identity_template: None,
            },
            capabilities: AgentCapabilities::default(),
            integrations: vec!["slack".to_string()],
            visual_identity: None,
            memories: vec![],
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
            paused: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Agent 1".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
                active_model: None,
                soul_template: None,
                identity_template: None,
            },
            capabilities: AgentCapabilities::default(),
            integrations: vec![],
            visual_identity: None,
            memories: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        };
        db.insert_agent(&agent).unwrap();

        let conv_id = db.get_or_create_conversation("agent-1").unwrap();
        assert!(!conv_id.is_empty());

        let msg_id = db.insert_message(&conv_id, "user", "Hello").unwrap();
        assert!(!msg_id.is_empty());

        db.insert_message(&conv_id, "assistant", "Hi there")
            .unwrap();

        let messages = db.get_messages(&conv_id, 10).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
    }

    #[test]
    fn test_thread_run_lifecycle_updates_conversation_summary() {
        let db = create_test_db();

        let agent = Agent {
            id: "agent-threads".to_string(),
            name: "Thread Agent".to_string(),
            role: "analyst".to_string(),
            emoji: "🤖".to_string(),
            color: "#00AA88".to_string(),
            status: AgentStatus::Active,
            isolated: false,
            paused: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Thread Agent".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
                active_model: None,
                soul_template: None,
                identity_template: None,
            },
            capabilities: AgentCapabilities::default(),
            integrations: vec![],
            visual_identity: None,
            memories: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        };
        db.insert_agent(&agent).unwrap();

        let conv_id = db.get_or_create_conversation("agent-threads").unwrap();
        let run_id = db
            .start_thread_run(&conv_id, "agent-threads", "user_message")
            .unwrap();

        let running_summary = db
            .list_agent_conversation_summaries("agent-threads", 10)
            .unwrap()
            .into_iter()
            .find(|c| c.id == conv_id)
            .unwrap();
        assert_eq!(running_summary.thread_status, "running");
        assert_eq!(running_summary.active_run_count, 1);
        assert_eq!(running_summary.last_run_status.as_deref(), Some("running"));
        assert_eq!(
            running_summary.last_run_id.as_deref(),
            Some(run_id.as_str())
        );

        db.checkpoint_thread_run(&run_id, "{\"summary\":\"Checkpoint captured\"}")
            .unwrap();

        db.finish_thread_run(&run_id, "completed", None).unwrap();

        let completed_summary = db
            .list_agent_conversation_summaries("agent-threads", 10)
            .unwrap()
            .into_iter()
            .find(|c| c.id == conv_id)
            .unwrap();
        assert_eq!(completed_summary.thread_status, "idle");
        assert_eq!(completed_summary.active_run_count, 0);
        assert_eq!(
            completed_summary.last_run_status.as_deref(),
            Some("completed")
        );
        assert_eq!(completed_summary.checkpoint_count, 1);
        assert!(completed_summary.last_checkpoint_at.is_some());

        let runs = db.list_thread_runs(&conv_id, 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "completed");
        assert_eq!(runs[0].trigger_type, "user_message");
        assert_eq!(
            runs[0].checkpoint_payload_json.as_deref(),
            Some("{\"summary\":\"Checkpoint captured\"}")
        );
    }

    #[test]
    fn test_thread_summary_stays_running_when_multiple_runs_overlap() {
        let db = create_test_db();

        let agent = Agent {
            id: "agent-overlap".to_string(),
            name: "Overlap Agent".to_string(),
            role: "analyst".to_string(),
            emoji: "🤖".to_string(),
            color: "#3366FF".to_string(),
            status: AgentStatus::Active,
            isolated: false,
            paused: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Overlap Agent".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
                active_model: None,
                soul_template: None,
                identity_template: None,
            },
            capabilities: AgentCapabilities::default(),
            integrations: vec![],
            visual_identity: None,
            memories: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        };
        db.insert_agent(&agent).unwrap();

        let conv_id = db.get_or_create_conversation("agent-overlap").unwrap();
        let run_a = db
            .start_thread_run(&conv_id, "agent-overlap", "user_message")
            .unwrap();
        let run_b = db
            .start_thread_run(&conv_id, "agent-overlap", "resume")
            .unwrap();

        db.finish_thread_run(&run_a, "completed", None).unwrap();

        let mid_summary = db
            .list_agent_conversation_summaries("agent-overlap", 10)
            .unwrap()
            .into_iter()
            .find(|c| c.id == conv_id)
            .unwrap();
        assert_eq!(mid_summary.thread_status, "running");
        assert_eq!(mid_summary.active_run_count, 1);

        db.finish_thread_run(&run_b, "failed", Some("{\"error\":\"boom\"}"))
            .unwrap();

        let final_summary = db
            .list_agent_conversation_summaries("agent-overlap", 10)
            .unwrap()
            .into_iter()
            .find(|c| c.id == conv_id)
            .unwrap();
        assert_eq!(final_summary.thread_status, "failed");
        assert_eq!(final_summary.active_run_count, 0);
        assert_eq!(final_summary.last_run_status.as_deref(), Some("failed"));
    }

    #[test]
    fn test_get_conversation_agent_id_returns_thread_owner() {
        let db = create_test_db();

        let alpha = Agent {
            id: "agent-alpha".to_string(),
            name: "Alpha".to_string(),
            role: "analyst".to_string(),
            emoji: "🤖".to_string(),
            color: "#3366FF".to_string(),
            status: AgentStatus::Active,
            isolated: false,
            paused: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Alpha".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
                active_model: None,
                soul_template: None,
                identity_template: None,
            },
            capabilities: AgentCapabilities::default(),
            integrations: vec![],
            visual_identity: None,
            memories: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        };
        let beta = Agent {
            id: "agent-beta".to_string(),
            name: "Beta".to_string(),
            role: "analyst".to_string(),
            emoji: "🤖".to_string(),
            color: "#22AA88".to_string(),
            status: AgentStatus::Active,
            isolated: false,
            paused: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Beta".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
                active_model: None,
                soul_template: None,
                identity_template: None,
            },
            capabilities: AgentCapabilities::default(),
            integrations: vec![],
            visual_identity: None,
            memories: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        };
        db.insert_agent(&alpha).unwrap();
        db.insert_agent(&beta).unwrap();

        let conv_id = "conv_shared_guard";
        db.ensure_conversation(conv_id, "agent-alpha").unwrap();

        assert_eq!(
            db.get_conversation_agent_id(conv_id).unwrap().as_deref(),
            Some("agent-alpha")
        );
        assert_ne!(
            db.get_conversation_agent_id(conv_id).unwrap().as_deref(),
            Some("agent-beta")
        );
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
            paused: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Agent 1".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
                active_model: None,
                soul_template: None,
                identity_template: None,
            },
            capabilities: AgentCapabilities::default(),
            integrations: vec![],
            visual_identity: None,
            memories: vec![],
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

        db.log_audit("agent-1", "created", Some("slack"), "Agent created", None)
            .unwrap();
        db.log_audit("agent-1", "updated", None, "Agent config changed", None)
            .unwrap();

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
            paused: false,
            container_id: None,
            personality: AgentPersonality {
                name: "Agent 1".to_string(),
                communication_style: "direct".to_string(),
                expertise: vec![],
                guardrails: vec![],
                custom_instructions: "".to_string(),
                active_model: None,
                soul_template: None,
                identity_template: None,
            },
            capabilities: AgentCapabilities::default(),
            integrations: vec![],
            visual_identity: None,
            memories: vec![],
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
            hourly_velocity_limit: 5,
            allowed_categories: vec!["software".to_string()],
            allowed_merchants: vec![],
            blocked_merchants: vec![],
            daily_spent_cents: 1000,
            monthly_spent_cents: 5000,
            require_approval_new_merchant: true,
            require_approval_recurring: false,
        };

        db.upsert_budget(&budget).unwrap();

        let retrieved = db.get_budget("agent-1").unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().daily_spent_cents, 1000);

        db.update_agent_spending("agent-1", 500, true, true)
            .unwrap();

        let updated = db.get_budget("agent-1").unwrap().unwrap();
        assert_eq!(updated.daily_spent_cents, 1500);
        assert_eq!(updated.monthly_spent_cents, 5500);
    }

    #[test]
    fn companion_profiles_and_device_grants_are_scoped_and_revocable() {
        let db = create_test_db();
        let now = Utc::now().to_rfc3339();
        let profile = CompanionProfile {
            id: "profile-child-1".into(),
            display_name: "Maya".into(),
            profile_type: "child".into(),
            context_json: json!({"grade": 5}),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        db.insert_companion_profile(&profile).unwrap();
        let grant = CompanionDeviceGrant {
            device_id: "device-ipad-1".into(),
            profile_id: profile.id.clone(),
            device_name: "Maya's iPad".into(),
            experience: "learning".into(),
            allowed_agent_ids: vec!["tutor-maya".into()],
            created_at: now,
            last_seen_at: None,
            revoked: false,
        };
        db.insert_companion_grant(&grant).unwrap();

        let stored = db.get_companion_grant(&grant.device_id).unwrap().unwrap();
        assert_eq!(stored.allowed_agent_ids, vec!["tutor-maya"]);
        assert!(!stored.revoked);

        db.revoke_companion_grant(&grant.device_id).unwrap();
        assert!(
            db.get_companion_grant(&grant.device_id)
                .unwrap()
                .unwrap()
                .revoked
        );
    }

    #[test]
    fn durable_forum_content_round_trips_without_browser_sized_limits() {
        let db = create_test_db();
        let large_body = "x".repeat(2_000_000);
        let content = json!({
            "id": "forum_large",
            "messages": [{"text": large_body}],
            "artifacts": []
        })
        .to_string();
        let summary = json!({
            "id": "forum_large",
            "messages": [],
            "artifacts": [],
            "contentLoaded": false
        })
        .to_string();

        assert!(db
            .upsert_forum_state("forum_large", &summary, &content, false)
            .unwrap());
        assert_eq!(
            db.get_forum_state_json("forum_large").unwrap().unwrap(),
            content
        );
        assert_eq!(db.list_forum_summary_jsons().unwrap(), vec![summary]);
    }

    #[test]
    fn legacy_content_migration_never_overwrites_existing_backend_state() {
        let db = create_test_db();
        db.upsert_forum_state("forum_1", "{\"id\":\"forum_1\"}", "{\"version\":2}", false)
            .unwrap();

        assert!(!db
            .upsert_forum_state("forum_1", "{\"id\":\"forum_1\"}", "{\"version\":1}", true)
            .unwrap());
        assert_eq!(
            db.get_forum_state_json("forum_1").unwrap().as_deref(),
            Some("{\"version\":2}")
        );
    }

    #[test]
    fn durable_mini_apps_round_trip_all_versions() {
        let db = create_test_db();
        let apps = json!([{
            "id": "app_1",
            "versions": (0..25).map(|index| json!({
                "id": format!("version_{}", index),
                "htmlContent": "<main>complete source</main>"
            })).collect::<Vec<_>>()
        }])
        .to_string();

        db.upsert_agent_mini_apps("agent_atlas", &apps, false)
            .unwrap();
        assert_eq!(
            db.get_agent_mini_apps_json("agent_atlas").unwrap().unwrap(),
            apps
        );
    }
}

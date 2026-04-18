use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

// ─── Agent Models ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub role: String,
    pub emoji: String,
    pub color: String,
    pub status: AgentStatus,
    pub isolated: bool,
    pub container_id: Option<String>,
    pub personality: AgentPersonality,
    pub integrations: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub stats: AgentStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Active,
    Sleeping,
    Thinking,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentPersonality {
    pub name: String,
    pub communication_style: String,
    pub expertise: Vec<String>,
    pub guardrails: Vec<String>,
    pub custom_instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentStats {
    pub tasks_today: u32,
    pub messages_handled: u32,
    pub uptime_seconds: u64,
    pub total_cost_usd: f64,
}

// ─── Container Models ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerStatus {
    pub id: String,
    pub name: String,
    pub state: String,
    pub health: String,
    pub memory_mb: f64,
    pub cpu_percent: f64,
    pub port: u16,
}

// ─── Bridge Models ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bridge {
    pub id: String,
    pub name: String,
    pub bridge_type: BridgeType,
    pub enabled: bool,
    pub agent_id: String,
    pub config: BridgeConfig,
    pub permissions: BridgePermissions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeType {
    Imessage,
    Calendar,
    Files,
    Gmail,
    Slack,
    Website,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeConfig {
    /// Source-specific config (e.g., which iMessage threads, which Gmail labels)
    pub scope: serde_json::Value,
    /// Time-bounded access: None = indefinite
    pub expires_at: Option<DateTime<Utc>>,
    /// Push events enabled
    pub push_enabled: bool,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            scope: serde_json::Value::Object(serde_json::Map::new()),
            expires_at: None,
            push_enabled: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgePermissions {
    pub read: bool,
    pub write: bool,
    pub delete: bool,
}

impl Default for BridgePermissions {
    fn default() -> Self {
        Self {
            read: true,
            write: false,
            delete: false,
        }
    }
}

// ─── Payment Models (Deterministic) ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurchaseRequest {
    pub agent_id: String,
    pub description: String,
    pub merchant: String,
    pub amount_cents: u64,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBudget {
    pub agent_id: String,
    pub payments_enabled: bool,
    pub auto_approve_threshold_cents: u64,
    pub per_transaction_limit_cents: u64,
    pub daily_limit_cents: u64,
    pub monthly_limit_cents: u64,
    pub allowed_categories: Vec<String>,
    pub daily_spent_cents: u64,
    pub monthly_spent_cents: u64,
    pub require_approval_new_merchant: bool,
    pub require_approval_recurring: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PurchaseDecision {
    Approved,
    RequiresUserApproval { reason: String },
    Denied { reasons: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurchaseRecord {
    pub id: String,
    pub agent_id: String,
    pub description: String,
    pub merchant: String,
    pub amount_cents: u64,
    pub category: String,
    pub decision: PurchaseDecision,
    pub virtual_card_id: Option<String>,
    pub timestamp: DateTime<Utc>,
}

// ─── Data Flow / Handoff Models ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataFlow {
    pub id: String,
    pub producer_agent_id: String,
    pub consumer_agent_id: String,
    pub name: String,
    pub frequency: FlowFrequency,
    pub schema: FlowSchema,
    pub status: FlowStatus,
    pub created_at: DateTime<Utc>,
    pub last_handoff_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowFrequency {
    Daily,
    Weekly,
    Monthly,
    OnDemand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowSchema {
    pub version: u32,
    pub fields: Vec<FlowField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowField {
    pub name: String,
    pub field_type: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowStatus {
    Active,
    Pending,
    Paused,
}

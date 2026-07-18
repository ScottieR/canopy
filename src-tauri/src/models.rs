use chrono::{DateTime, Utc};
use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

use crate::model_constants;

lazy_static! {
    pub static ref PRICING_REGISTRY: RwLock<HashMap<String, (f64, f64)>> =
        RwLock::new(HashMap::new());
}

// ─── Constants (re-exported from model_constants for back-compat) ─────────────
// Callers should prefer importing from model_constants directly.

pub use model_constants::DEFAULT_ANTHROPIC_MODEL;
pub use model_constants::DEFAULT_GEMINI_MODEL;
pub use model_constants::DEFAULT_OPENAI_MODEL;

/// Returns the best available model string for the given provider, consulting the
/// admin-synced models.json before falling back to the validated constants in model_constants.
///
/// All returned strings are validated against model_constants::validate_model_string.
/// If the dynamic file would produce a malformed string, the constant fallback is used.
pub fn get_dynamic_default_model(provider: &str) -> String {
    use std::fs;
    let data_dir = if let Some(dir) = dirs::data_dir() {
        dir.join("Canopy").join("models.json")
    } else {
        std::path::PathBuf::from("models.json")
    };

    let possible_paths = [
        data_dir,
        std::path::PathBuf::from("../shared/models.json"),
        std::path::PathBuf::from("../../shared/models.json"),
    ];

    for path in &possible_paths {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(strats) = json.get("strategies") {
                    let heavy = strats
                        .get("defaultHeavyModel")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let light = strats
                        .get("defaultLightModel")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    let candidate: Option<String> = match provider {
                        "gemini" => json
                            .get("models")
                            .and_then(|m| m.as_array())
                            .and_then(|arr| {
                                arr.iter().find(|o| {
                                    o.get("provider").and_then(|v| v.as_str())
                                        == Some("Google Gemini")
                                })
                            })
                            .and_then(|entry| entry.get("id").and_then(|v| v.as_str()))
                            .map(|id| format!("google/{}", id)),
                        "openai" => {
                            if heavy.contains("gpt") {
                                Some(format!("openai/{}", heavy))
                            } else if light.contains("gpt") {
                                Some(format!("openai/{}", light))
                            } else {
                                None
                            }
                        }
                        "anthropic" => {
                            // Only accept model names that look like the correct suffix order
                            // (e.g. "claude-sonnet-4-6"), not the reversed "claude-4-6-sonnet".
                            let raw = if heavy.starts_with("claude") {
                                heavy
                            } else {
                                ""
                            };
                            if !raw.is_empty() {
                                Some(format!("anthropic/{}", raw))
                            } else {
                                None
                            }
                        }
                        _ => None,
                    };

                    // Only use the candidate if it passes format validation
                    if let Some(ref s) = candidate {
                        if let Ok(resolved) = model_constants::resolve_model_string(s) {
                            return resolved;
                        } else {
                            tracing::warn!(
                                "Dynamic models.json produced invalid model string '{}' for provider '{}'; \
                                 using hardcoded fallback.",
                                s, provider
                            );
                        }
                    }
                }
            }
        }
    }

    // Validated hardcoded fallbacks — always correct format
    match provider {
        "anthropic" => model_constants::DEFAULT_ANTHROPIC_MODEL.to_string(),
        "openai" => model_constants::DEFAULT_OPENAI_MODEL.to_string(),
        _ => model_constants::DEFAULT_GEMINI_MODEL.to_string(),
    }
}

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
    pub paused: bool,
    pub container_id: Option<String>,
    pub personality: AgentPersonality,
    pub capabilities: AgentCapabilities,
    pub integrations: Vec<String>,
    pub visual_identity: Option<serde_json::Value>,
    pub memories: Vec<AgentMemory>,
    pub created_at: DateTime<Utc>,
    pub stats: AgentStats,
}

// Per-agent web-navigation allowlist storage lives outside the DB to avoid a schema
// migration. The list is persisted as a small JSON file under the agent's browser
// profile dir at ~/Library/Application Support/Canopy/agent-browsers/{id}/allowlist.json
// and read at browser-spawn time to generate a constrained PAC script. See
// `browser_manager::{get_agent_allowed_domains, update_agent_allowed_domains}`.

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
    pub active_model: Option<String>,
    pub soul_template: Option<String>,
    pub identity_template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapabilities {
    #[serde(default)]
    pub ext_network: bool,
    #[serde(default)]
    pub int_network: bool,
    #[serde(default)]
    pub autonomous: bool,
    #[serde(default)]
    pub scheduled: bool,
    #[serde(default)]
    pub memory_write: bool,
    #[serde(default)]
    pub file_read: bool,
    #[serde(default)]
    pub file_write: bool,
    #[serde(default)]
    pub payments: bool,
    #[serde(default)]
    pub spend_auto: bool,

    // OpenClaw Skills
    #[serde(default)]
    pub browser: bool,
    #[serde(default)]
    pub proxy: bool,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub canvas: bool,
    #[serde(default)]
    pub coding: bool,
    #[serde(default)]
    pub gog: bool,
    #[serde(default)]
    pub summarize: bool,
    #[serde(default)]
    pub genui: bool,
    #[serde(default)]
    pub computer_control: bool,
    #[serde(default)]
    pub host_control: bool,
    #[serde(default)]
    pub screen_record: bool,
}

impl Default for AgentCapabilities {
    fn default() -> Self {
        Self {
            ext_network: false,
            int_network: false,
            autonomous: false,
            scheduled: true,    // QOL: Standard cron features allowed by default
            memory_write: true, // QOL: Agents can remember by default
            file_read: false,
            file_write: false,
            payments: false,
            spend_auto: false,
            browser: true, // Default OpenClaw skills
            proxy: false,  // Default OpenClaw doesn't include proxy
            vision: false,
            canvas: false,
            coding: true,
            gog: true,
            summarize: true,
            genui: false,
            computer_control: false,
            host_control: false,
            screen_record: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMemory {
    pub id: String,
    #[serde(rename = "type")]
    pub memory_type: String, // "learned", "experience", "preference", "context"
    pub text: String,
    pub when: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentStats {
    pub tasks_today: u32,
    pub messages_handled: u32,
    pub uptime_seconds: u64,
    pub total_cost_usd: f64,
    #[serde(default)]
    pub total_tokens_in: u64,
    #[serde(default)]
    pub total_tokens_out: u64,
}

impl AgentStats {
    pub fn record_usage(&mut self, model: &str, in_tokens: u64, out_tokens: u64) {
        self.total_tokens_in += in_tokens;
        self.total_tokens_out += out_tokens;

        let registry = PRICING_REGISTRY.read().unwrap();
        let (cost_in_per_m, cost_out_per_m) = if let Some(&costs) = registry.get(model) {
            costs
        } else {
            // Static fallback pricing when the admin-oracle sync hasn't run yet.
            // Keys here are the bare model IDs (without provider prefix) as reported
            // by OpenClaw usage events. Keep in sync with model_constants.rs.
            match model {
                // Anthropic — correct ID is "claude-sonnet-4-6" not "claude-4-6-sonnet"
                "claude-sonnet-4-6" => (3.00, 15.00),
                "claude-haiku-4-5" => (0.25, 1.25),
                "claude-opus-4-6" => (15.00, 75.00),
                "claude-opus-4-7" => (5.00, 25.00),
                // OpenAI
                "gpt-4o-mini" => (0.15, 0.60),
                "gpt-4o" => (2.50, 10.00),
                // Google
                "gemini-2.0-flash" => (0.35, 1.05),
                "gemini-2.0-pro" => (3.50, 10.50),
                "gemini-3.5-flash" => (0.15, 0.60),
                "gemini-3.5-pro" => (1.25, 5.00),
                // xAI
                "grok-beta" => (5.00, 15.00),
                // Unknown model — log and use conservative estimate
                other => {
                    tracing::warn!(
                        "No pricing entry for model '{}'; using generic fallback",
                        other
                    );
                    (1.00, 5.00)
                }
            }
        };

        let cost_in = (in_tokens as f64 / 1_000_000.0) * cost_in_per_m;
        let cost_out = (out_tokens as f64 / 1_000_000.0) * cost_out_per_m;
        self.total_cost_usd += cost_in + cost_out;
    }
}

// ─── Self-Healing Agent Models ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBugReport {
    pub id: String,
    pub agent_id: String,
    pub timestamp: String,
    pub service: String,
    pub error_message: String,
    pub resolved: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BridgeType {
    Imessage,
    Calendar,
    Files,
    Gmail,
    Slack,
    Telegram,
    Discord,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolDescriptor {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpResourceDescriptor {
    pub uri: String,
    pub name: String,
    pub description: String,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpPromptArgumentDescriptor {
    pub name: String,
    pub description: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpPromptDescriptor {
    pub name: String,
    pub description: String,
    pub arguments: Vec<McpPromptArgumentDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerDescriptor {
    pub id: String,
    pub agent_id: String,
    pub bridge_id: String,
    pub name: String,
    pub bridge_type: String,
    pub transport: String,
    pub runtime_mode: String,
    pub enabled: bool,
    pub permissions: BridgePermissions,
    pub scope: serde_json::Value,
    pub tools: Vec<McpToolDescriptor>,
    pub resources: Vec<McpResourceDescriptor>,
    pub prompts: Vec<McpPromptDescriptor>,
}

// ─── Payment Models (Deterministic) ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurchaseRequest {
    pub agent_id: String,
    pub description: String,
    pub merchant: String,
    pub amount_cents: u64,
    pub category: String,
    #[serde(default)]
    pub is_recurring: bool,
}

fn default_hourly_velocity_limit() -> u32 {
    5
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBudget {
    pub agent_id: String,
    pub payments_enabled: bool,
    pub auto_approve_threshold_cents: u64,
    pub per_transaction_limit_cents: u64,
    pub daily_limit_cents: u64,
    pub monthly_limit_cents: u64,
    #[serde(default = "default_hourly_velocity_limit")]
    pub hourly_velocity_limit: u32,
    #[serde(default)]
    pub allowed_categories: Vec<String>,
    #[serde(default)]
    pub allowed_merchants: Vec<String>,
    #[serde(default)]
    pub blocked_merchants: Vec<String>,
    pub daily_spent_cents: u64,
    pub monthly_spent_cents: u64,
    pub require_approval_new_merchant: bool,
    pub require_approval_recurring: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PurchaseDecision {
    Approved,
    RequiresUserApproval {
        reason: String,
        #[serde(default)]
        flags: Vec<String>,
        #[serde(default)]
        approval_id: Option<String>,
    },
    Denied {
        reasons: Vec<String>,
        #[serde(default)]
        flags: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PurchaseApprovalStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VirtualCardProviderKind {
    Mock,
    Privacy,
    LithicSandbox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentProviderConfig {
    pub provider: VirtualCardProviderKind,
    pub privacy_configured: bool,
    pub lithic_sandbox_configured: bool,
    pub lithic_webhook_secret_configured: bool,
    pub active_provider_ready: bool,
    pub using_env_fallback: bool,
    pub webhook_listener_listening: bool,
    pub privacy_webhook_url: Option<String>,
    pub lithic_webhook_url: Option<String>,
    pub webhook_listener_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentProviderUpdate {
    pub provider: VirtualCardProviderKind,
    #[serde(default)]
    pub privacy_api_key: Option<String>,
    #[serde(default)]
    pub lithic_sandbox_api_key: Option<String>,
    #[serde(default)]
    pub lithic_webhook_secret: Option<String>,
    #[serde(default)]
    pub clear_privacy_api_key: bool,
    #[serde(default)]
    pub clear_lithic_sandbox_api_key: bool,
    #[serde(default)]
    pub clear_lithic_webhook_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VirtualCardStatus {
    Active,
    Consumed,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PaymentTransactionStatus {
    Authorized,
    Captured,
    Declined,
    Refunded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurchaseApprovalRequest {
    pub id: String,
    pub agent_id: String,
    pub purchase_record_id: String,
    pub purchase_request: PurchaseRequest,
    pub reason: String,
    #[serde(default)]
    pub flags: Vec<String>,
    pub status: PurchaseApprovalStatus,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualCardRecord {
    pub id: String,
    pub agent_id: String,
    pub purchase_record_id: String,
    pub provider: VirtualCardProviderKind,
    pub provider_card_ref: String,
    pub last_four: String,
    pub amount_cents: u64,
    pub merchant: String,
    pub memo: String,
    pub status: VirtualCardStatus,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentTransactionRecord {
    pub id: String,
    pub agent_id: String,
    pub purchase_record_id: Option<String>,
    pub virtual_card_id: Option<String>,
    pub provider: VirtualCardProviderKind,
    pub provider_transaction_ref: String,
    pub merchant: String,
    pub amount_cents: u64,
    pub status: PaymentTransactionStatus,
    pub source: String,
    pub decline_reason: Option<String>,
    pub created_at: DateTime<Utc>,
    pub settled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentAuditEntry {
    pub id: String,
    pub agent_id: String,
    pub event_type: String,
    pub detail_json: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PurchaseExecutionResult {
    pub agent_id: String,
    pub decision: PurchaseDecision,
    pub purchase_record: PurchaseRecord,
    pub approval_request: Option<PurchaseApprovalRequest>,
    pub virtual_card: Option<VirtualCardRecord>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentDashboard {
    pub agent_id: String,
    pub budget: AgentBudget,
    pub pending_approvals: Vec<PurchaseApprovalRequest>,
    pub recent_purchases: Vec<PurchaseRecord>,
    pub active_virtual_cards: Vec<VirtualCardRecord>,
    pub recent_transactions: Vec<PaymentTransactionRecord>,
    pub recent_audit_entries: Vec<PaymentAuditEntry>,
}

// ─── Data Flow / Handoff Models ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderModel {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub capabilities: Vec<String>,
    pub recommended: bool,
    pub created_at: DateTime<Utc>,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredAgent {
    pub source: String,
    pub id: String,
    pub name: String,
    pub path: String,
}

// ─── Global Configuration ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub name: String,
    pub email: String,
    pub phone: String,
    pub timezone: String,
    pub working_hours: String,
    pub communication_tone: String,
    pub global_directives: String,
}

impl Default for UserProfile {
    fn default() -> Self {
        Self {
            name: "Admin".to_string(),
            email: "".to_string(),
            phone: "".to_string(),
            timezone: "UTC".to_string(),
            working_hours: "9:00 AM - 5:00 PM".to_string(),
            communication_tone: "Professional".to_string(),
            global_directives: "Always cite your sources and optimize for safety.".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackReport {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub title: String,
    pub description: String,
    pub agent_id: Option<String>,
    pub reporter_name: String,
    pub reporter_email: String,
    pub created_at: String,
    pub updated_at: String,
    pub context: serde_json::Value,
    pub remote_status: String,
    pub remote_error: Option<String>,
    pub slack_notified: bool,
    pub dispatched_agent_id: Option<String>,
    pub dispatched_at: Option<String>,
}

// ─── Telemetry & Warnings ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageRecord {
    pub id: String,
    pub agent_id: String,
    pub conversation_id: Option<String>,
    pub timestamp: String,
    pub model: String,
    pub provider: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemWarning {
    pub id: String,
    pub agent_id: String,
    pub timestamp: String,
    pub warning_type: String,
    pub message: String,
    pub resolved: bool,
}

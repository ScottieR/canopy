/// Common test utilities, fixtures, and setup for integration tests

use canopy_lib::models::{
    Agent, AgentStatus, AgentPersonality, AgentCapabilities, AgentStats, AgentBudget,
    Bridge, BridgeType, BridgePermissions, BridgeConfig, PurchaseRequest, PurchaseDecision,
};
use chrono::Utc;
use std::path::PathBuf;
use tempfile::TempDir;

/// Test context with isolated dependencies
pub struct TestContext {
    pub temp_dir: TempDir,
    pub db_path: PathBuf,
}

impl TestContext {
    /// Create a new test context with isolated database
    pub fn new() -> Self {
        let temp_dir = TempDir::new().expect("Failed to create temp directory");
        let db_path = temp_dir.path().join("test.db");

        TestContext {
            temp_dir,
            db_path,
        }
    }

    /// Get the database path for this context
    pub fn db_path(&self) -> &PathBuf {
        &self.db_path
    }
}

impl Drop for TestContext {
    fn drop(&mut self) {
        // Cleanup happens automatically when TempDir is dropped
    }
}

// ─── AGENT FIXTURES ─────────────────────────────────────────────────────────

/// Create a default test agent
pub fn default_test_agent() -> Agent {
    Agent {
        id: "test-agent-1".to_string(),
        name: "Test Agent".to_string(),
        role: "assistant".to_string(),
        emoji: "🦞".to_string(),
        color: "#34D399".to_string(),
        status: AgentStatus::Active,
        isolated: false,
        paused: false,
        container_id: None,
        personality: AgentPersonality {
            name: "Test Agent".to_string(),
            communication_style: "helpful".to_string(),
            expertise: vec!["testing".to_string()],
            guardrails: vec![],
            custom_instructions: "Test agent for unit testing".to_string(),
            active_model: Some("anthropic/claude-sonnet-4-6".to_string()),
            soul_template: None,
            identity_template: None,
        },
        capabilities: AgentCapabilities::default(),
        integrations: vec![],
        visual_identity: None,
        memories: vec![],
        created_at: Utc::now(),
        stats: AgentStats::default(),
    }
}

/// Create a test agent with custom ID
pub fn test_agent_with_id(id: &str) -> Agent {
    let mut agent = default_test_agent();
    agent.id = id.to_string();
    agent.name = format!("Agent {}", id);
    agent
}

/// Create a test agent with custom name
pub fn test_agent_with_name(name: &str) -> Agent {
    let mut agent = default_test_agent();
    agent.name = name.to_string();
    agent.id = format!("agent-{}", name.to_lowercase().replace(' ', "-"));
    agent
}

/// Create an isolated test agent
pub fn test_isolated_agent() -> Agent {
    let mut agent = default_test_agent();
    agent.isolated = true;
    agent
}

/// Create a paused test agent
pub fn test_paused_agent() -> Agent {
    let mut agent = default_test_agent();
    agent.paused = true;
    agent.status = AgentStatus::Stopped;
    agent
}

// ─── BUDGET FIXTURES ────────────────────────────────────────────────────────

/// Create a default test budget
pub fn default_test_budget(agent_id: &str) -> AgentBudget {
    AgentBudget {
        agent_id: agent_id.to_string(),
        payments_enabled: true,
        auto_approve_threshold_cents: 5000,     // $50
        per_transaction_limit_cents: 20000,     // $200
        daily_limit_cents: 50000,               // $500
        monthly_limit_cents: 200000,            // $2000
        allowed_categories: vec![
            "cleaning_supplies".to_string(),
            "office_equipment".to_string(),
            "software".to_string(),
        ],
        daily_spent_cents: 0,
        monthly_spent_cents: 0,
        require_approval_new_merchant: true,
        require_approval_recurring: true,
    }
}

/// Create a budget with payments disabled
pub fn test_budget_payments_disabled(agent_id: &str) -> AgentBudget {
    let mut budget = default_test_budget(agent_id);
    budget.payments_enabled = false;
    budget
}

/// Create a budget with custom daily limit
pub fn test_budget_with_daily_limit(agent_id: &str, daily_limit_cents: u64) -> AgentBudget {
    let mut budget = default_test_budget(agent_id);
    budget.daily_limit_cents = daily_limit_cents;
    budget
}

/// Create a budget with spent amounts
pub fn test_budget_with_spending(
    agent_id: &str,
    daily_spent: u64,
    monthly_spent: u64,
) -> AgentBudget {
    let mut budget = default_test_budget(agent_id);
    budget.daily_spent_cents = daily_spent;
    budget.monthly_spent_cents = monthly_spent;
    budget
}

/// Create a budget with limited categories
pub fn test_budget_with_categories(agent_id: &str, categories: Vec<&str>) -> AgentBudget {
    let mut budget = default_test_budget(agent_id);
    budget.allowed_categories = categories.iter().map(|c| c.to_string()).collect();
    budget
}

// ─── PURCHASE REQUEST FIXTURES ──────────────────────────────────────────────

/// Create a default purchase request
pub fn default_purchase_request(agent_id: &str) -> PurchaseRequest {
    PurchaseRequest {
        agent_id: agent_id.to_string(),
        category: "cleaning_supplies".to_string(),
        amount_cents: 1500, // $15
        merchant: "Test Merchant".to_string(),
        is_recurring: false,
    }
}

/// Create a purchase request with custom amount
pub fn test_purchase_request(agent_id: &str, amount_cents: u64) -> PurchaseRequest {
    let mut req = default_purchase_request(agent_id);
    req.amount_cents = amount_cents;
    req
}

/// Create a purchase request with custom category
pub fn test_purchase_request_with_category(
    agent_id: &str,
    category: &str,
) -> PurchaseRequest {
    let mut req = default_purchase_request(agent_id);
    req.category = category.to_string();
    req
}

// ─── BRIDGE FIXTURES ────────────────────────────────────────────────────────

/// Create a default test bridge
pub fn default_test_bridge() -> Bridge {
    Bridge {
        id: "test-bridge-1".to_string(),
        bridge_type: BridgeType::Slack,
        enabled: true,
        config: BridgeConfig {
            workspace_id: Some("W123456".to_string()),
            bot_user_id: Some("B123456".to_string()),
            channels: vec!["C123456".to_string()],
            ..Default::default()
        },
        permissions: BridgePermissions {
            read: true,
            write: true,
            delete: false,
            admin: false,
        },
        created_at: Utc::now(),
    }
}

/// Create a disabled bridge
pub fn test_disabled_bridge() -> Bridge {
    let mut bridge = default_test_bridge();
    bridge.enabled = false;
    bridge
}

/// Create a read-only bridge
pub fn test_read_only_bridge() -> Bridge {
    let mut bridge = default_test_bridge();
    bridge.permissions = BridgePermissions {
        read: true,
        write: false,
        delete: false,
        admin: false,
    };
    bridge
}

// ─── VALIDATION HELPERS ────────────────────────────────────────────────────

/// Validate an agent ID follows security rules
pub fn validate_test_agent_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 63 {
        return Err("Agent ID must be 1-63 chars".into());
    }
    if !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("Agent ID must be alphanumeric with hyphens/underscores".into());
    }
    if id.contains("..") || id.contains("../") {
        return Err("Agent ID cannot contain path traversal".into());
    }
    if id.contains(';') || id.contains('|') || id.contains('`') || id.contains('$') {
        return Err("Agent ID contains shell metacharacters".into());
    }
    Ok(())
}

/// Validate a workspace path
pub fn validate_test_workspace_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("Workspace path must be absolute".into());
    }
    if path.contains("..") {
        return Err("Workspace path cannot contain ..".into());
    }
    if path.ends_with('/') {
        return Err("Workspace path cannot end with /".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_context_creates_temp_dir() {
        let ctx = TestContext::new();
        assert!(ctx.temp_dir.path().exists());
    }

    #[test]
    fn test_default_agent_is_valid() {
        let agent = default_test_agent();
        assert!(!agent.id.is_empty());
        assert!(!agent.name.is_empty());
        assert_eq!(agent.status, AgentStatus::Active);
        assert!(!agent.isolated);
    }

    #[test]
    fn test_agent_with_id_creates_unique_id() {
        let agent = test_agent_with_id("my-agent");
        assert_eq!(agent.id, "my-agent");
    }

    #[test]
    fn test_isolated_agent_is_marked_isolated() {
        let agent = test_isolated_agent();
        assert!(agent.isolated);
    }

    #[test]
    fn test_paused_agent_is_marked_paused() {
        let agent = test_paused_agent();
        assert!(agent.paused);
        assert_eq!(agent.status, AgentStatus::Stopped);
    }

    #[test]
    fn test_default_budget_is_enabled() {
        let budget = default_test_budget("agent-1");
        assert!(budget.payments_enabled);
        assert!(budget.daily_limit_cents > 0);
        assert!(budget.monthly_limit_cents > budget.daily_limit_cents);
    }

    #[test]
    fn test_disabled_budget() {
        let budget = test_budget_payments_disabled("agent-1");
        assert!(!budget.payments_enabled);
    }

    #[test]
    fn test_budget_with_spending() {
        let budget = test_budget_with_spending("agent-1", 2000, 5000);
        assert_eq!(budget.daily_spent_cents, 2000);
        assert_eq!(budget.monthly_spent_cents, 5000);
    }

    #[test]
    fn test_purchase_request_defaults() {
        let req = default_purchase_request("agent-1");
        assert_eq!(req.agent_id, "agent-1");
        assert_eq!(req.amount_cents, 1500);
        assert!(!req.is_recurring);
    }

    #[test]
    fn test_bridge_is_enabled_by_default() {
        let bridge = default_test_bridge();
        assert!(bridge.enabled);
    }

    #[test]
    fn test_read_only_bridge_has_no_write() {
        let bridge = test_read_only_bridge();
        assert!(bridge.permissions.read);
        assert!(!bridge.permissions.write);
    }

    #[test]
    fn test_validate_agent_id_accepts_valid_ids() {
        assert!(validate_test_agent_id("test-agent").is_ok());
        assert!(validate_test_agent_id("agent_123").is_ok());
        assert!(validate_test_agent_id("a").is_ok());
    }

    #[test]
    fn test_validate_agent_id_rejects_empty() {
        assert!(validate_test_agent_id("").is_err());
    }

    #[test]
    fn test_validate_agent_id_rejects_too_long() {
        let long_id = "a".repeat(64);
        assert!(validate_test_agent_id(&long_id).is_err());
    }

    #[test]
    fn test_validate_agent_id_rejects_path_traversal() {
        assert!(validate_test_agent_id("../../../etc").is_err());
        assert!(validate_test_agent_id("test/../etc").is_err());
    }

    #[test]
    fn test_validate_agent_id_rejects_shell_metacharacters() {
        assert!(validate_test_agent_id("test;echo").is_err());
        assert!(validate_test_agent_id("test|whoami").is_err());
        assert!(validate_test_agent_id("test`echo`").is_err());
        assert!(validate_test_agent_id("test$(whoami)").is_err());
    }

    #[test]
    fn test_validate_workspace_path_accepts_valid() {
        assert!(validate_test_workspace_path("/home/node/.openclaw/agent-1").is_ok());
    }

    #[test]
    fn test_validate_workspace_path_rejects_relative() {
        assert!(validate_test_workspace_path("relative/path").is_err());
    }

    #[test]
    fn test_validate_workspace_path_rejects_traversal() {
        assert!(validate_test_workspace_path("/home/../etc/passwd").is_err());
    }
}

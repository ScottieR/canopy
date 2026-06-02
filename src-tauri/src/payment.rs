use crate::models::{AgentBudget, PurchaseDecision, PurchaseRecord, PurchaseRequest};
use crate::errors::{CanopyError, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use reqwest::Client;

/// The Deterministic Payment Gateway.
///
/// This is NOT an agent. It is pure, deterministic Rust code.
/// It cannot be prompt-injected because it doesn't process natural language.
/// It cannot be socially engineered because it has no intelligence.
/// It's a rules engine with a virtual card API.
///
/// The agent REQUESTS. The gateway DECIDES. The virtual card ENFORCES.

/// Evaluate a purchase request against the agent's budget policy.
/// Returns Approved, RequiresUserApproval, or Denied — deterministically.
#[tauri::command]
pub fn evaluate_purchase(
    request: PurchaseRequest,
    budget: AgentBudget,
) -> Result<PurchaseDecision> {
    // ── RATE LIMITING ──
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check("local-user")?;

    // ── Gate 0: Are payments even enabled for this agent? ──
    if !budget.payments_enabled {
        return Ok(PurchaseDecision::Denied {
            reasons: vec!["Payments are not enabled for this agent".to_string()],
        });
    }

    let mut denial_reasons: Vec<String> = Vec::new();

    // ── Gate 1: Is the category allowed? ──
    if !budget.allowed_categories.iter().any(|c| c == &request.category) {
        denial_reasons.push(format!(
            "Category '{}' is not in this agent's allowed categories",
            request.category
        ));
    }

    // ── Gate 2: Is the amount under the per-transaction limit? ──
    if request.amount_cents > budget.per_transaction_limit_cents {
        denial_reasons.push(format!(
            "Amount ${:.2} exceeds per-transaction limit of ${:.2}",
            request.amount_cents as f64 / 100.0,
            budget.per_transaction_limit_cents as f64 / 100.0
        ));
    }

    // ── Gate 3: Is the agent under its daily budget? ──
    let projected_daily = budget.daily_spent_cents + request.amount_cents;
    if projected_daily > budget.daily_limit_cents {
        denial_reasons.push(format!(
            "Would exceed daily limit: ${:.2} spent + ${:.2} = ${:.2} (limit: ${:.2})",
            budget.daily_spent_cents as f64 / 100.0,
            request.amount_cents as f64 / 100.0,
            projected_daily as f64 / 100.0,
            budget.daily_limit_cents as f64 / 100.0
        ));
    }

    // ── Gate 4: Is the agent under its monthly budget? ──
    let projected_monthly = budget.monthly_spent_cents + request.amount_cents;
    if projected_monthly > budget.monthly_limit_cents {
        denial_reasons.push(format!(
            "Would exceed monthly limit: ${:.2} spent + ${:.2} = ${:.2} (limit: ${:.2})",
            budget.monthly_spent_cents as f64 / 100.0,
            request.amount_cents as f64 / 100.0,
            projected_monthly as f64 / 100.0,
            budget.monthly_limit_cents as f64 / 100.0
        ));
    }

    // ── Decision ──
    if !denial_reasons.is_empty() {
        return Ok(PurchaseDecision::Denied {
            reasons: denial_reasons,
        });
    }

    // All checks passed — does it need user approval?
    if request.amount_cents > budget.auto_approve_threshold_cents {
        return Ok(PurchaseDecision::RequiresUserApproval {
            reason: format!(
                "Amount ${:.2} exceeds auto-approve threshold of ${:.2}",
                request.amount_cents as f64 / 100.0,
                budget.auto_approve_threshold_cents as f64 / 100.0
            ),
        });
    }

    // TODO: Check for new merchant (requires purchase history lookup)
    // TODO: Check for recurring/subscription patterns
    // TODO: Velocity check (purchases per hour)

    Ok(PurchaseDecision::Approved)
}

#[tauri::command]
pub fn get_agent_budget(
    agent_id: String,
    state: tauri::State<'_, crate::db::Database>,
) -> Result<AgentBudget> {
    // Validate agent ID
    crate::validators::agent::validate_id(&agent_id)?;

    let mut config = state.get_budget(&agent_id)?
        .unwrap_or_else(|| AgentBudget {
            agent_id: agent_id.clone(),
            payments_enabled: false,
            auto_approve_threshold_cents: 5000,
            per_transaction_limit_cents: 20000,
            daily_limit_cents: 50000,
            monthly_limit_cents: 200000,
            allowed_categories: vec![],
            daily_spent_cents: 0,
            monthly_spent_cents: 0,
            require_approval_new_merchant: true,
            require_approval_recurring: true,
        });
        
    Ok(config)
}

#[tauri::command]
pub fn update_agent_budget(
    budget: AgentBudget,
    state: tauri::State<'_, crate::db::Database>,
) -> Result<AgentBudget> {
    // Validate agent ID and budget amounts
    crate::validators::agent::validate_id(&budget.agent_id)?;
    crate::validators::budget::validate_amount(budget.auto_approve_threshold_cents as i64)?;
    crate::validators::budget::validate_daily_limit(
        budget.daily_limit_cents as i64,
        Some(budget.monthly_limit_cents as i64),
    )?;
    crate::validators::budget::validate_monthly_limit(
        budget.monthly_limit_cents as i64,
        Some(budget.daily_limit_cents as i64),
    )?;

    state.upsert_budget(&budget)?;
    Ok(budget)
}

#[tauri::command]
pub fn get_purchase_history(
    agent_id: String,
    state: tauri::State<'_, crate::db::Database>,
) -> Result<Vec<PurchaseRecord>> {
    // Validate agent ID
    crate::validators::agent::validate_id(&agent_id)?;

    // Get purchase history - database errors convert automatically via ? operator
    let history = state.get_purchase_history(&agent_id, 50)?;
    Ok(history)
}

// ─── Virtual Card Integration (Privacy.com) ────────

#[derive(Serialize)]
struct PrivacyCreateCardRequest {
    #[serde(rename = "type")]
    card_type: String,
    amount: u32,
    memo: String,
}

#[derive(Deserialize, Debug)]
pub struct PrivacyCardResponse {
    pub token: Option<String>,
    pub last_four: Option<String>,
    pub pan: Option<String>,
}

#[tauri::command]
pub async fn issue_virtual_card(
    agent_id: String,
    amount_cents: u64,
    category: String,
) -> Result<String> {
    // ── RATE LIMITING ──
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check("local-user")?;

    // Validate inputs
    crate::validators::agent::validate_id(&agent_id)?;
    crate::validators::budget::validate_amount(amount_cents as i64)?;
    crate::validators::budget::validate_category(&category)?;

    // SECURITY: Fetch PRIVACY_API_KEY from Keychain (secure storage)
    // Environment variable is only a fallback for development/testing
    let privacy_key = crate::keychain::get_secret("PRIVACY_API_KEY")
        .or_else(|_| {
            // Fallback to environment variable for backward compatibility
            // WARNING: Environment variables are less secure; use keychain instead
            let env_result = std::env::var("PRIVACY_API_KEY");
            if env_result.is_ok() {
                tracing::warn!("PRIVACY_API_KEY read from environment variable - consider migrating to keychain for better security");
            }
            env_result.map_err(|_| CanopyError::Configuration("PRIVACY_API_KEY not found in keychain or environment".into()))
        })?;

    if privacy_key.is_empty() {
        return Err(CanopyError::Configuration("PRIVACY_API_KEY is empty".into()));
    }

    let client = Client::new();

    // Construct Privacy.com payload
    // We lock the card strictly to the requested limit + 10% buffer for taxes/auth holds
    let buffer_amount = amount_cents + (amount_cents / 10);

    let payload = PrivacyCreateCardRequest {
        card_type: "SINGLE_USE".to_string(),
        amount: buffer_amount as u32,
        memo: format!("Agent {} purchase - {}", agent_id, category),
    };

    let response = client
        .post("https://api.privacy.com/v1/card")
        .bearer_auth(privacy_key)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| CanopyError::Request(format!("Privacy.com API connection failed: {}", e)))?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(CanopyError::Request(format!("Privacy.com rejected request: {}", err_text)));
    }

    let card_data: PrivacyCardResponse = response
        .json()
        .await
        .map_err(|e| CanopyError::Serialization(format!("Failed to parse Privacy.com response: {}", e)))?;

    let last4 = card_data.last_four.or(card_data.pan).unwrap_or_else(|| "****".to_string());

    // We successfully minted a burner card
    tracing::info!("Virtual card issued for agent {} (category: {})", agent_id, category);
    Ok(format!("Successfully provisioned virtual card ending in {}. It is locked to ${:.2}.", last4, buffer_amount as f64 / 100.0))
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::models::{AgentBudget, PurchaseDecision, PurchaseRequest};
    use super::*;

    fn default_budget(agent_id: &str) -> AgentBudget {
        AgentBudget {
            agent_id: agent_id.to_string(),
            payments_enabled: true,
            auto_approve_threshold_cents: 5000,     // $50
            per_transaction_limit_cents: 100000,    // $1000
            daily_limit_cents: 50000,               // $500
            monthly_limit_cents: 200000,            // $2,000
            allowed_categories: vec!["cleaning_supplies".to_string(), "office_supplies".to_string()],
            daily_spent_cents: 0,
            monthly_spent_cents: 0,
            require_approval_new_merchant: true,
            require_approval_recurring: true,
        }
    }

    fn purchase_request(agent_id: &str, amount_cents: u64, category: &str) -> PurchaseRequest {
        PurchaseRequest {
            agent_id: agent_id.to_string(),
            description: "Test purchase".to_string(),
            merchant: "Amazon".to_string(),
            amount_cents,
            category: category.to_string(),
            is_recurring: false,
        }
    }

    // ──────────────────────────────────────────────────────────────
    // DETERMINISM TESTS (CRITICAL FOR SECURITY)
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_deterministic_same_input_same_output() {
        // Critical: Same input must always produce the same output
        let budget = default_budget("agent-1");
        let request = purchase_request("agent-1", 3000, "cleaning_supplies");

        let result1 = evaluate_purchase(request.clone(), budget.clone()).unwrap();
        let result2 = evaluate_purchase(request.clone(), budget.clone()).unwrap();

        assert_eq!(
            format!("{:?}", result1),
            format!("{:?}", result2),
            "Determinism violated: same input produced different outputs"
        );
    }

    // ──────────────────────────────────────────────────────────────
    // GATE 0: PAYMENTS_ENABLED TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_payments_disabled_always_denied() {
        let mut budget = default_budget("agent-1");
        budget.payments_enabled = false;
        let request = purchase_request("agent-1", 1000, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Denied { reasons } => {
                assert!(reasons.iter().any(|r| r.contains("not enabled")),
                    "Expected 'not enabled' reason, got: {:?}", reasons);
            }
            _ => panic!("Expected Denied decision, got: {:?}", result),
        }
    }

    // ──────────────────────────────────────────────────────────────
    // GATE 1: CATEGORY ALLOWLIST TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_allowed_category_passes() {
        let budget = default_budget("agent-1");
        let request = purchase_request("agent-1", 3000, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Approved => {},
            PurchaseDecision::RequiresUserApproval { .. } => {},
            _ => panic!("Expected approval decision, got: {:?}", result),
        }
    }

    #[test]
    fn test_disallowed_category_denied() {
        let budget = default_budget("agent-1");
        let request = purchase_request("agent-1", 3000, "jewelry");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Denied { reasons } => {
                assert!(reasons.iter().any(|r| r.contains("not in this agent's allowed categories")),
                    "Expected category rejection, got: {:?}", reasons);
            }
            _ => panic!("Expected Denied, got: {:?}", result),
        }
    }

    #[test]
    fn test_empty_category_allowlist_denies_all() {
        let mut budget = default_budget("agent-1");
        budget.allowed_categories.clear();
        let request = purchase_request("agent-1", 3000, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Denied { reasons } => {
                assert!(!reasons.is_empty(), "Expected denial reason for empty allowlist");
            }
            _ => panic!("Expected Denied, got: {:?}", result),
        }
    }

    // ──────────────────────────────────────────────────────────────
    // GATE 2: PER-TRANSACTION LIMIT TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_under_per_transaction_limit_passes() {
        let mut budget = default_budget("agent-1"); // limit: $1000
        budget.daily_limit_cents = 200000;
        let request = purchase_request("agent-1", 99999, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Approved => {},
            PurchaseDecision::RequiresUserApproval { .. } => {},
            _ => panic!("Expected approval decision, got: {:?}", result),
        }
    }

    #[test]
    fn test_at_per_transaction_limit_passes() {
        let mut budget = default_budget("agent-1"); // limit: $1000
        budget.daily_limit_cents = 200000;
        let request = purchase_request("agent-1", 100000, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Approved => {},
            PurchaseDecision::RequiresUserApproval { .. } => {},
            _ => panic!("Expected approval decision, got: {:?}", result),
        }
    }

    #[test]
    fn test_over_per_transaction_limit_denied() {
        let mut budget = default_budget("agent-1"); // limit: $1000
        budget.daily_limit_cents = 200000;
        let request = purchase_request("agent-1", 100001, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Denied { reasons } => {
                assert!(reasons.iter().any(|r| r.contains("exceeds per-transaction limit")),
                    "Expected transaction limit reason, got: {:?}", reasons);
            }
            _ => panic!("Expected Denied, got: {:?}", result),
        }
    }

    // ──────────────────────────────────────────────────────────────
    // GATE 3: DAILY BUDGET TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_within_daily_budget_passes() {
        let mut budget = default_budget("agent-1");
        budget.daily_spent_cents = 30000; // $300
        let request = purchase_request("agent-1", 19999, "cleaning_supplies"); // $199.99

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Approved => {},
            PurchaseDecision::RequiresUserApproval { .. } => {},
            _ => panic!("Expected approval decision, got: {:?}", result),
        }
    }

    #[test]
    fn test_daily_budget_exhausted_denied() {
        let mut budget = default_budget("agent-1"); // limit: $500
        budget.daily_spent_cents = 49999;
        let request = purchase_request("agent-1", 2000, "cleaning_supplies"); // Would exceed

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Denied { reasons } => {
                assert!(reasons.iter().any(|r| r.contains("exceed daily limit")),
                    "Expected daily limit reason, got: {:?}", reasons);
            }
            _ => panic!("Expected Denied, got: {:?}", result),
        }
    }

    // ──────────────────────────────────────────────────────────────
    // GATE 4: MONTHLY BUDGET TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_within_monthly_budget_passes() {
        let mut budget = default_budget("agent-1");
        budget.monthly_spent_cents = 100000;
        let request = purchase_request("agent-1", 50000, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Approved => {},
            PurchaseDecision::RequiresUserApproval { .. } => {},
            _ => panic!("Expected approval decision, got: {:?}", result),
        }
    }

    #[test]
    fn test_monthly_budget_exhausted_denied() {
        let mut budget = default_budget("agent-1"); // limit: $2,000
        budget.monthly_spent_cents = 199999;
        let request = purchase_request("agent-1", 2000, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Denied { reasons } => {
                assert!(reasons.iter().any(|r| r.contains("exceed monthly limit")),
                    "Expected monthly limit reason, got: {:?}", reasons);
            }
            _ => panic!("Expected Denied, got: {:?}", result),
        }
    }

    // ──────────────────────────────────────────────────────────────
    // AUTO-APPROVE THRESHOLD TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_under_auto_approve_threshold_approved() {
        let budget = default_budget("agent-1"); // threshold: $50
        let request = purchase_request("agent-1", 4999, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Approved => {},
            _ => panic!("Expected Approved, got: {:?}", result),
        }
    }

    #[test]
    fn test_over_auto_approve_threshold_requires_approval() {
        let budget = default_budget("agent-1"); // threshold: $50
        let request = purchase_request("agent-1", 5001, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::RequiresUserApproval { reason } => {
                assert!(reason.contains("exceeds auto-approve threshold"),
                    "Expected threshold reason, got: {}", reason);
            }
            _ => panic!("Expected RequiresUserApproval, got: {:?}", result),
        }
    }

    // ──────────────────────────────────────────────────────────────
    // MULTI-GATE DENIAL TESTS
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_multiple_gates_fail_all_reasons_reported() {
        let mut budget = default_budget("agent-1");
        budget.allowed_categories.clear(); // Gate 1 will fail
        budget.daily_spent_cents = 49000; // Gate 3 will fail with $500 limit
        let request = purchase_request("agent-1", 2000, "jewelry"); // Both gates fail

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Denied { reasons } => {
                assert!(reasons.len() >= 2, "Expected multiple reasons, got: {:?}", reasons);
                assert!(reasons.iter().any(|r| r.contains("allowed categories")));
                assert!(reasons.iter().any(|r| r.contains("exceed daily limit")));
            }
            _ => panic!("Expected Denied, got: {:?}", result),
        }
    }

    // ──────────────────────────────────────────────────────────────
    // EDGE CASES
    // ──────────────────────────────────────────────────────────────

    #[test]
    fn test_zero_dollar_purchase() {
        let budget = default_budget("agent-1");
        let request = purchase_request("agent-1", 0, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Approved => {},
            _ => panic!("Expected Approved for $0 purchase, got: {:?}", result),
        }
    }

    #[test]
    fn test_max_u64_amount_denied() {
        let budget = default_budget("agent-1");
        let request = purchase_request("agent-1", u64::MAX, "cleaning_supplies");

        let result = evaluate_purchase(request, budget).unwrap();
        match result {
            PurchaseDecision::Denied { .. } => {}, // Should fail multiple gates
            _ => panic!("Expected Denied for huge amount, got: {:?}", result),
        }
    }
}

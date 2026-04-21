use crate::models::{AgentBudget, PurchaseDecision, PurchaseRecord, PurchaseRequest};
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
) -> Result<PurchaseDecision, String> {
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
pub fn get_agent_budget(agent_id: String) -> Result<AgentBudget, String> {
    // TODO: Load from persistent store
    // Return default budget for now
    Ok(AgentBudget {
        agent_id,
        payments_enabled: false, // Off by default — user must opt in
        auto_approve_threshold_cents: 5000,     // $50
        per_transaction_limit_cents: 20000,     // $200
        daily_limit_cents: 50000,               // $500
        monthly_limit_cents: 200000,            // $2,000
        allowed_categories: vec![],
        daily_spent_cents: 0,
        monthly_spent_cents: 0,
        require_approval_new_merchant: true,
        require_approval_recurring: true,
    })
}

#[tauri::command]
pub fn update_agent_budget(budget: AgentBudget) -> Result<AgentBudget, String> {
    // TODO: Persist to store
    Ok(budget)
}

#[tauri::command]
pub fn get_purchase_history(agent_id: String) -> Result<Vec<PurchaseRecord>, String> {
    // TODO: Load from persistent store
    Ok(vec![])
}

// ─── Virtual Card Integration (Stripe Issuing) ────────

#[derive(Serialize)]
struct StripeIssuingCardRequest {
    cardholder: String,
    currency: String,
    #[serde(rename = "type")]
    card_type: String,
    status: String,
    spending_controls: StripeSpendingControls,
}

#[derive(Serialize)]
struct StripeSpendingControls {
    spending_limits: Vec<StripeSpendingLimit>,
    allowed_categories: Vec<String>,
}

#[derive(Serialize)]
struct StripeSpendingLimit {
    amount: u64,
    interval: String,
}

#[derive(Deserialize, Debug)]
pub struct VirtualCardResponse {
    pub id: String,
    pub last4: String,
    pub exp_month: u8,
    pub exp_year: u16,
    // The raw PAN and CVV are only available via an additional ephemeral key fetch in Stripe,
    // but for prototyping we return the object reference.
}

#[tauri::command]
pub async fn issue_virtual_card(
    agent_id: String,
    amount_cents: u64,
    category: String,
) -> Result<String, String> {
    // In production, fetch STRIPE_SECRET_KEY securely from Keychain/Enclave
    let stripe_key = crate::keychain::get_secret("STRIPE_SECRET_KEY")
        .or_else(|_| std::env::var("STRIPE_SECRET_KEY"))
        .unwrap_or_default();

    if stripe_key.is_empty() {
        return Err("STRIPE_SECRET_KEY is not configured in the vault. Virtual card issuance aborted.".into());
    }

    let client = Client::new();
    
    // Construct Stripe Issuing payload
    // We lock the card strictly to the requested limit + 10% buffer for taxes/auth holds
    let buffer_amount = amount_cents + (amount_cents / 10);
    
    let payload = StripeIssuingCardRequest {
        cardholder: "ich_123456789".to_string(), // In prod: resolving to the Agent's associated cardholder ID
        currency: "usd".to_string(),
        card_type: "virtual".to_string(),
        status: "active".to_string(),
        spending_controls: StripeSpendingControls {
            spending_limits: vec![StripeSpendingLimit {
                amount: buffer_amount,
                interval: "all_time".to_string(),
            }],
            allowed_categories: vec![category],
        },
    };

    let response = client
        .post("https://api.stripe.com/v1/issuing/cards")
        .bearer_auth(stripe_key)
        .header("Content-Type", "application/x-www-form-urlencoded")
        // Stripe expects form url-encoded data, but for our mock/simulated 
        // endpoint we just use normal JSON, or if we use true Stripe we'd encode to form.
        // For simplicity we serialize as json to show the struct architecture:
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Stripe API connection failed: {}", e))?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(format!("Stripe Issuing rejected request: {}", err_text));
    }

    let card_data: VirtualCardResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Stripe response: {}", e))?;

    // We successfully minted a burner card
    // Note: To extract the full PAN you actually require PCI compliance or Stripe.js, but 
    // for Agent AI the agent typically retrieves the PAN via another /virtual_cards/:id API call.
    Ok(format!("Successfully provisioned virtual card ending in {}. It is locked to ${:.2}.", card_data.last4, buffer_amount as f64 / 100.0))
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

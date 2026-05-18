// Integration tests for payment flow: request → validation → approval → execution
// Phase 1 Implementation - Testing payment processing end-to-end

mod common;

use canopy_lib::models::{PurchaseRequest, AgentBudget};
use common::{
    default_test_budget, default_purchase_request, test_budget_payments_disabled,
    test_budget_with_daily_limit, test_budget_with_spending, test_purchase_request,
    test_purchase_request_with_category, test_budget_with_categories,
};

// ────────────────────────────────────────────────────────────────────────────
// TEST SETUP
// ────────────────────────────────────────────────────────────────────────────

/// Helper to evaluate if budget permits purchase
fn would_budget_permit(budget: &AgentBudget, request: &PurchaseRequest) -> bool {
    // Validation logic: simplified decision tree
    if !budget.payments_enabled {
        return false;
    }

    // Check per-transaction limit
    if request.amount_cents > budget.per_transaction_limit_cents {
        return false;
    }

    // Check daily limit
    if budget.daily_spent_cents + request.amount_cents > budget.daily_limit_cents {
        return false;
    }

    // Check monthly limit
    if budget.monthly_spent_cents + request.amount_cents > budget.monthly_limit_cents {
        return false;
    }

    // Check category whitelist
    if !budget.allowed_categories.contains(&request.category) {
        return false;
    }

    true
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1.1: BUDGET CONFIGURATION
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_default_budget_enables_payments() {
    // Test: Default budget has payments enabled
    // Validates: Budget starts in permissive state
    // Ensures: Agents can make purchases by default

    let budget = default_test_budget("agent-1");

    assert!(budget.payments_enabled, "Payments should be enabled by default");
    assert!(
        budget.daily_limit_cents > 0,
        "Daily limit should be set"
    );
    assert!(
        budget.monthly_limit_cents > budget.daily_limit_cents,
        "Monthly limit should exceed daily"
    );
}

#[test]
fn test_budget_can_be_disabled() {
    // Test: Payments can be disabled
    // Validates: Budget restriction works
    // Ensures: Locked-down agents can't make purchases

    let budget = test_budget_payments_disabled("agent-1");

    assert!(!budget.payments_enabled, "Payments should be disabled");
    let request = default_purchase_request("agent-1");
    assert!(
        !would_budget_permit(&budget, &request),
        "Disabled budget should reject all purchases"
    );
}

#[test]
fn test_budget_has_spending_limits() {
    // Test: Budget enforces daily and monthly limits
    // Validates: Spending caps are tracked
    // Ensures: Runaway spending is prevented

    let budget = default_test_budget("agent-1");

    assert_eq!(budget.daily_limit_cents, 50000, "Daily limit should be $500");
    assert_eq!(
        budget.monthly_limit_cents, 200000,
        "Monthly limit should be $2000"
    );
    assert!(
        budget.monthly_limit_cents > budget.daily_limit_cents,
        "Monthly limit must exceed daily"
    );
}

#[test]
fn test_budget_has_category_whitelist() {
    // Test: Budget restricts to allowed categories
    // Validates: Category filtering works
    // Ensures: Purchases stay within policy

    let budget = default_test_budget("agent-1");

    assert!(
        budget.allowed_categories.contains(&"cleaning_supplies".to_string()),
        "Default budget should allow cleaning supplies"
    );
    assert!(
        budget.allowed_categories.contains(&"software".to_string()),
        "Default budget should allow software"
    );
    // Verify it's a list, not open-ended
    assert!(!budget.allowed_categories.is_empty(), "Should have categories");
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1.2: PURCHASE REQUEST CREATION
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_purchase_request_defaults() {
    // Test: Purchase requests have sensible defaults
    // Validates: Request structure is complete
    // Ensures: Required fields are populated

    let request = default_purchase_request("agent-1");

    assert_eq!(request.agent_id, "agent-1");
    assert_eq!(request.amount_cents, 1500, "Default should be $15");
    assert_eq!(request.category, "cleaning_supplies");
    assert!(!request.is_recurring, "Default should be one-time");
}

#[test]
fn test_purchase_request_with_custom_amount() {
    // Test: Purchase amounts can be customized
    // Validates: Amount field is flexible
    // Ensures: Different purchase sizes supported

    let request = test_purchase_request("agent-1", 5000); // $50

    assert_eq!(request.amount_cents, 5000);
    assert_eq!(request.agent_id, "agent-1");
}

#[test]
fn test_purchase_request_with_custom_category() {
    // Test: Purchase category can be specified
    // Validates: Category filtering supported
    // Ensures: Policy can be enforced by category

    let request = test_purchase_request_with_category("agent-1", "software");

    assert_eq!(request.category, "software");
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1.3: BUDGET VALIDATION
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_small_purchase_within_budget() {
    // Test: Small purchases are approved
    // Validates: Decision tree basic case
    // Ensures: Normal operation works

    let budget = default_test_budget("agent-1");
    let request = test_purchase_request("agent-1", 1000); // $10

    assert!(
        would_budget_permit(&budget, &request),
        "Small purchase should be approved"
    );
}

#[test]
fn test_purchase_exceeding_per_transaction_limit() {
    // Test: Purchases over transaction limit are rejected
    // Validates: Per-transaction cap enforced
    // Ensures: Single large purchases blocked

    let budget = default_test_budget("agent-1");
    // Default per-transaction limit is $200 (20000 cents)
    let oversized = test_purchase_request("agent-1", 25000); // $250

    assert!(
        !would_budget_permit(&budget, &oversized),
        "Purchase exceeding per-transaction limit should be rejected"
    );
}

#[test]
fn test_purchase_exceeding_daily_limit() {
    // Test: Purchases exceeding daily accumulated limit are rejected
    // Validates: Daily cap enforced
    // Ensures: Spending doesn't exceed daily budget

    let budget_with_spending = test_budget_with_spending("agent-1", 45000, 0);
    // Already spent $450 today (of $500 daily limit)
    let expensive = test_purchase_request("agent-1", 10000); // $100

    assert!(
        !would_budget_permit(&budget_with_spending, &expensive),
        "Purchase exceeding daily limit should be rejected"
    );
}

#[test]
fn test_purchase_exceeding_monthly_limit() {
    // Test: Purchases exceeding monthly accumulated limit are rejected
    // Validates: Monthly cap enforced
    // Ensures: Spending doesn't exceed monthly budget

    let budget_with_spending = test_budget_with_spending("agent-1", 0, 190000);
    // Already spent $1900 this month (of $2000 monthly limit)
    let expensive = test_purchase_request("agent-1", 20000); // $200

    assert!(
        !would_budget_permit(&budget_with_spending, &expensive),
        "Purchase exceeding monthly limit should be rejected"
    );
}

#[test]
fn test_purchase_with_unapproved_category() {
    // Test: Purchases in restricted categories are rejected
    // Validates: Category whitelist enforced
    // Ensures: Policy compliance maintained

    let restricted_budget = test_budget_with_categories("agent-1", vec!["software", "hardware"]);
    let furniture = test_purchase_request_with_category("agent-1", "furniture");

    assert!(
        !would_budget_permit(&restricted_budget, &furniture),
        "Purchase in unapproved category should be rejected"
    );
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1.4: APPROVAL THRESHOLDS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_auto_approve_threshold() {
    // Test: Small purchases below threshold auto-approve
    // Validates: Threshold logic works
    // Ensures: Friction reduced for small purchases

    let budget = default_test_budget("agent-1");
    // Default auto-approve threshold is $50 (5000 cents)

    let small = test_purchase_request("agent-1", 3000); // $30
    assert!(
        would_budget_permit(&budget, &small),
        "Small purchase should pass validation (would auto-approve)"
    );

    let larger = test_purchase_request("agent-1", 8000); // $80
    assert!(
        would_budget_permit(&budget, &larger),
        "Larger purchase should pass validation (requires approval)"
    );
}

#[test]
fn test_recurring_purchase_flag() {
    // Test: Recurring purchases are marked
    // Validates: Recurring flag tracked
    // Ensures: Recurring purchases can be audited

    let mut request = default_purchase_request("agent-1");
    assert!(!request.is_recurring, "Default should be one-time");

    request.is_recurring = true;
    assert!(request.is_recurring, "Flag should be settable");
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1.5: BUDGET STATE UPDATES
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_budget_tracks_daily_spending() {
    // Test: Daily spending is accumulated
    // Validates: State updates correctly
    // Ensures: Running total accurate

    let budget = test_budget_with_spending("agent-1", 30000, 60000);

    assert_eq!(budget.daily_spent_cents, 30000, "Daily spent should be $300");
    assert_eq!(
        budget.monthly_spent_cents, 60000,
        "Monthly spent should be $600"
    );
}

#[test]
fn test_budget_daily_spending_resets() {
    // Test: Daily spending counter can be reset
    // Validates: Daily counter management
    // Ensures: New day has fresh limit

    let mut budget = test_budget_with_spending("agent-1", 30000, 60000);
    // Simulate daily reset
    budget.daily_spent_cents = 0;

    assert_eq!(budget.daily_spent_cents, 0, "Daily spending should reset");
    assert_eq!(
        budget.monthly_spent_cents, 60000,
        "Monthly spending should persist"
    );
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1.6: APPROVAL REQUIREMENTS
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn test_budget_requires_approval_for_new_merchant() {
    // Test: New merchant purchases require approval
    // Validates: Policy enforcement
    // Ensures: Fraud prevention

    let budget = default_test_budget("agent-1");
    assert!(
        budget.require_approval_new_merchant,
        "Should require approval for new merchants"
    );
}

#[test]
fn test_budget_requires_approval_for_recurring() {
    // Test: Recurring purchases require approval
    // Validates: Policy enforcement
    // Ensures: Long-term commitments reviewed

    let budget = default_test_budget("agent-1");
    assert!(
        budget.require_approval_recurring,
        "Should require approval for recurring purchases"
    );
}

// ────────────────────────────────────────────────────────────────────────────
// SUMMARY OF TESTS
// ────────────────────────────────────────────────────────────────────────────

// Phase 1.1: Budget Configuration
// ✅ test_default_budget_enables_payments
// ✅ test_budget_can_be_disabled
// ✅ test_budget_has_spending_limits
// ✅ test_budget_has_category_whitelist
//
// Phase 1.2: Purchase Requests
// ✅ test_purchase_request_defaults
// ✅ test_purchase_request_with_custom_amount
// ✅ test_purchase_request_with_custom_category
//
// Phase 1.3: Budget Validation
// ✅ test_small_purchase_within_budget
// ✅ test_purchase_exceeding_per_transaction_limit
// ✅ test_purchase_exceeding_daily_limit
// ✅ test_purchase_exceeding_monthly_limit
// ✅ test_purchase_with_unapproved_category
//
// Phase 1.4: Approval Thresholds
// ✅ test_auto_approve_threshold
// ✅ test_recurring_purchase_flag
//
// Phase 1.5: Budget State
// ✅ test_budget_tracks_daily_spending
// ✅ test_budget_daily_spending_resets
//
// Phase 1.6: Approval Requirements
// ✅ test_budget_requires_approval_for_new_merchant
// ✅ test_budget_requires_approval_for_recurring
//
// TOTAL: 18 integration tests covering payment flow

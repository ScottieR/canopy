use crate::app_state::AppState;
use crate::db::Database;
use crate::errors::{CanopyError, Result};
use crate::models::{
    Agent, AgentBudget, PaymentAuditEntry, PaymentDashboard, PurchaseApprovalRequest,
    PurchaseApprovalStatus, PurchaseDecision, PurchaseExecutionResult, PurchaseRecord,
    PurchaseRequest, VirtualCardProviderKind, VirtualCardRecord, VirtualCardStatus,
};
use chrono::{Duration, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const DEFAULT_ALLOWED_CATEGORIES: &[&str] =
    &["software", "office_supplies", "cleaning_supplies"];
const RECURRING_KEYWORDS: &[&str] = &[
    "subscription",
    "recurring",
    "monthly",
    "annual",
    "yearly",
    "renewal",
    "membership",
    "plan",
    "billing",
];

#[derive(Debug, Clone)]
enum CardProvider {
    Mock,
    Privacy,
}

#[derive(Debug, Clone)]
struct IssuedCard {
    provider: VirtualCardProviderKind,
    provider_card_ref: String,
    last_four: String,
    amount_cents: u64,
    merchant: String,
    memo: String,
    expires_at: Option<chrono::DateTime<Utc>>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct PaymentApprovalRequestedEvent {
    approval: PurchaseApprovalRequest,
    agent_name: String,
}

#[derive(Debug, Clone, Serialize)]
struct PaymentStateChangedEvent {
    agent_id: String,
    reason: String,
}

#[derive(Serialize)]
struct PrivacyCreateCardRequest {
    #[serde(rename = "type")]
    card_type: String,
    amount: u32,
    memo: String,
}

#[derive(Deserialize, Debug)]
struct PrivacyCardResponse {
    token: Option<String>,
    last_four: Option<String>,
    pan: Option<String>,
}

fn default_budget_config(agent_id: &str) -> AgentBudget {
    AgentBudget {
        agent_id: agent_id.to_string(),
        payments_enabled: false,
        auto_approve_threshold_cents: 5_000,
        per_transaction_limit_cents: 20_000,
        daily_limit_cents: 50_000,
        monthly_limit_cents: 200_000,
        hourly_velocity_limit: 5,
        allowed_categories: DEFAULT_ALLOWED_CATEGORIES
            .iter()
            .map(|value| value.to_string())
            .collect(),
        allowed_merchants: vec![],
        blocked_merchants: vec![],
        daily_spent_cents: 0,
        monthly_spent_cents: 0,
        require_approval_new_merchant: true,
        require_approval_recurring: true,
    }
}

fn merchant_matches(pattern: &str, merchant: &str) -> bool {
    let pattern = pattern.trim().to_ascii_lowercase();
    let merchant = merchant.trim().to_ascii_lowercase();
    if pattern.is_empty() {
        return false;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        merchant.starts_with(prefix)
    } else {
        merchant == pattern
    }
}

fn is_recurring_request(request: &PurchaseRequest) -> bool {
    if request.is_recurring {
        return true;
    }
    let combined = format!("{} {}", request.description, request.merchant).to_ascii_lowercase();
    RECURRING_KEYWORDS
        .iter()
        .any(|keyword| combined.contains(keyword))
}

fn is_approved_purchase(decision: &PurchaseDecision) -> bool {
    matches!(decision, PurchaseDecision::Approved)
}

fn recent_approved_purchases<'a>(
    history: &'a [PurchaseRecord],
    now: chrono::DateTime<Utc>,
) -> impl Iterator<Item = &'a PurchaseRecord> {
    history.iter().filter(move |record| {
        record.timestamp <= now && is_approved_purchase(&record.decision)
    })
}

fn evaluate_purchase_with_context(
    request: &PurchaseRequest,
    budget: &AgentBudget,
    history: &[PurchaseRecord],
    allow_auto_approve: bool,
    now: chrono::DateTime<Utc>,
) -> PurchaseDecision {
    let mut denial_reasons = Vec::new();
    let mut approval_flags = Vec::new();

    if !budget.payments_enabled {
        return PurchaseDecision::Denied {
            reasons: vec!["Payments are not enabled for this agent".to_string()],
            flags: vec!["payments_disabled".to_string()],
        };
    }

    if !budget.allowed_categories.is_empty()
        && !budget
            .allowed_categories
            .iter()
            .any(|category| category.eq_ignore_ascii_case(&request.category))
    {
        denial_reasons.push(format!(
            "Category '{}' is not in this agent's allowed categories",
            request.category
        ));
    }

    if !budget.allowed_merchants.is_empty()
        && !budget
            .allowed_merchants
            .iter()
            .any(|pattern| merchant_matches(pattern, &request.merchant))
    {
        denial_reasons.push(format!(
            "Merchant '{}' is not in this agent's allowlist",
            request.merchant
        ));
    }

    if budget
        .blocked_merchants
        .iter()
        .any(|pattern| merchant_matches(pattern, &request.merchant))
    {
        denial_reasons.push(format!(
            "Merchant '{}' is blocked for this agent",
            request.merchant
        ));
    }

    if request.amount_cents > budget.per_transaction_limit_cents {
        denial_reasons.push(format!(
            "Amount ${:.2} exceeds per-transaction limit of ${:.2}",
            request.amount_cents as f64 / 100.0,
            budget.per_transaction_limit_cents as f64 / 100.0
        ));
    }

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

    let one_hour_ago = now - Duration::hours(1);
    let approvals_last_hour = recent_approved_purchases(history, now)
        .filter(|record| record.timestamp >= one_hour_ago)
        .count() as u32;
    if approvals_last_hour >= budget.hourly_velocity_limit {
        denial_reasons.push(format!(
            "Hourly velocity exceeded: {} approved purchases in the last hour (limit: {})",
            approvals_last_hour, budget.hourly_velocity_limit
        ));
    }

    if !denial_reasons.is_empty() {
        return PurchaseDecision::Denied {
            reasons: denial_reasons,
            flags: vec!["policy_denied".to_string()],
        };
    }

    let has_seen_merchant = recent_approved_purchases(history, now).any(|record| {
        merchant_matches(&record.merchant, &request.merchant)
            || merchant_matches(&request.merchant, &record.merchant)
    });
    if budget.require_approval_new_merchant && !has_seen_merchant {
        approval_flags.push("new_merchant".to_string());
    }

    if budget.require_approval_recurring && is_recurring_request(request) {
        approval_flags.push("recurring".to_string());
    }

    if !allow_auto_approve {
        approval_flags.push("spend_auto_disabled".to_string());
    }

    if request.amount_cents > budget.auto_approve_threshold_cents {
        approval_flags.push("exceeds_auto_approve_threshold".to_string());
    }

    if !approval_flags.is_empty() {
        let reason = if approval_flags.contains(&"exceeds_auto_approve_threshold".to_string()) {
            format!(
                "Amount ${:.2} exceeds auto-approve threshold of ${:.2}",
                request.amount_cents as f64 / 100.0,
                budget.auto_approve_threshold_cents as f64 / 100.0
            )
        } else if approval_flags.contains(&"new_merchant".to_string()) {
            "First purchase from this merchant requires review".to_string()
        } else if approval_flags.contains(&"recurring".to_string()) {
            "Recurring or subscription-like purchase requires review".to_string()
        } else {
            "This purchase requires human approval".to_string()
        };
        return PurchaseDecision::RequiresUserApproval {
            reason,
            flags: approval_flags,
            approval_id: None,
        };
    }

    PurchaseDecision::Approved
}

fn validate_budget_input(budget: &AgentBudget) -> Result<()> {
    crate::validators::agent::validate_id(&budget.agent_id)?;
    crate::validators::budget::validate_amount(budget.auto_approve_threshold_cents as i64)?;
    crate::validators::budget::validate_amount(budget.per_transaction_limit_cents as i64)?;
    crate::validators::budget::validate_daily_limit(
        budget.daily_limit_cents as i64,
        Some(budget.monthly_limit_cents as i64),
    )?;
    crate::validators::budget::validate_monthly_limit(
        budget.monthly_limit_cents as i64,
        Some(budget.daily_limit_cents as i64),
    )?;

    if budget.hourly_velocity_limit == 0 {
        return Err(CanopyError::Validation(
            "Hourly velocity limit must be at least 1".to_string(),
        ));
    }

    for category in &budget.allowed_categories {
        crate::validators::budget::validate_category(category)?;
    }
    for merchant in &budget.allowed_merchants {
        validate_merchant_pattern(merchant)?;
    }
    for merchant in &budget.blocked_merchants {
        validate_merchant_pattern(merchant)?;
    }

    Ok(())
}

fn validate_merchant_pattern(pattern: &str) -> Result<()> {
    if pattern.trim().is_empty() || pattern.len() > 128 {
        return Err(CanopyError::Validation(
            "Merchant rules must be 1-128 characters".to_string(),
        ));
    }
    if !pattern.chars().all(|character| {
        character.is_ascii_alphanumeric()
            || matches!(character, ' ' | '.' | '-' | '_' | '*' | '&' | '\'' | '/')
    }) {
        return Err(CanopyError::Validation(
            "Merchant rules contain unsupported characters".to_string(),
        ));
    }
    Ok(())
}

fn ensure_payment_access(
    db: &Database,
    app_state: &AppState,
    agent_id: &str,
) -> Result<Agent> {
    crate::validators::agent::validate_id(agent_id)?;
    if !db.is_agent_owner(agent_id, &app_state.user_id)? {
        return Err(CanopyError::Unauthorized(format!(
            "Agent '{}' is not owned by user '{}'",
            agent_id, app_state.user_id
        )));
    }
    let agent = db
        .get_agent(agent_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Agent '{}' not found", agent_id)))?;
    if !agent.capabilities.payments {
        return Err(CanopyError::Unauthorized(format!(
            "Agent '{}' does not have payment capability enabled",
            agent_id
        )));
    }
    Ok(agent)
}

fn selected_provider() -> Result<CardProvider> {
    let explicit = std::env::var("CANOPY_PAYMENT_PROVIDER")
        .unwrap_or_else(|_| "mock".to_string())
        .to_ascii_lowercase();
    match explicit.as_str() {
        "mock" => Ok(CardProvider::Mock),
        "privacy" => Ok(CardProvider::Privacy),
        "lithic" | "lithic_sandbox" => Ok(CardProvider::Mock),
        value => Err(CanopyError::Configuration(format!(
            "Unknown payment provider '{}'",
            value
        ))),
    }
}

fn build_purchase_record(
    id: String,
    request: &PurchaseRequest,
    decision: PurchaseDecision,
    timestamp: chrono::DateTime<Utc>,
) -> PurchaseRecord {
    PurchaseRecord {
        id,
        agent_id: request.agent_id.clone(),
        description: request.description.clone(),
        merchant: request.merchant.clone(),
        amount_cents: request.amount_cents,
        category: request.category.clone(),
        decision,
        virtual_card_id: None,
        timestamp,
    }
}

fn record_payment_audit(
    db: &Database,
    agent_id: &str,
    event_type: &str,
    detail_json: serde_json::Value,
) -> Result<()> {
    db.record_payment_audit_entry(&PaymentAuditEntry {
        id: Uuid::new_v4().to_string(),
        agent_id: agent_id.to_string(),
        event_type: event_type.to_string(),
        detail_json,
        created_at: Utc::now(),
    })?;
    Ok(())
}

fn emit_payment_state_changed(app: &AppHandle, agent_id: &str, reason: &str) {
    let _ = app.emit(
        "payment_state_changed",
        PaymentStateChangedEvent {
            agent_id: agent_id.to_string(),
            reason: reason.to_string(),
        },
    );
}

async fn issue_card_for_provider(
    provider: CardProvider,
    agent_id: &str,
    request: &PurchaseRequest,
) -> Result<IssuedCard> {
    match provider {
        CardProvider::Mock => issue_mock_card(agent_id, request),
        CardProvider::Privacy => issue_privacy_card(agent_id, request).await,
    }
}

fn issue_mock_card(agent_id: &str, request: &PurchaseRequest) -> Result<IssuedCard> {
    let token = format!("mock-{}-{}", agent_id, request.amount_cents);
    let digits = format!("{:0>4}", request.amount_cents % 10_000);
    Ok(IssuedCard {
        provider: VirtualCardProviderKind::Mock,
        provider_card_ref: token,
        last_four: digits.clone(),
        amount_cents: request.amount_cents,
        merchant: request.merchant.clone(),
        memo: format!("Mock card for {} / {}", request.merchant, request.category),
        expires_at: Some(Utc::now() + Duration::hours(2)),
        message: format!(
            "Mock virtual card ending in {} issued for ${:.2}.",
            digits,
            request.amount_cents as f64 / 100.0
        ),
    })
}

async fn issue_privacy_card(agent_id: &str, request: &PurchaseRequest) -> Result<IssuedCard> {
    let privacy_key = crate::keychain::get_secret("PRIVACY_API_KEY")
        .or_else(|_| {
            let env_result = std::env::var("PRIVACY_API_KEY");
            if env_result.is_ok() {
                tracing::warn!(
                    "PRIVACY_API_KEY read from environment variable - consider migrating to keychain"
                );
            }
            env_result.map_err(|_| {
                CanopyError::Configuration(
                    "PRIVACY_API_KEY not found in keychain or environment".to_string(),
                )
            })
        })?;
    crate::validators::keys::validate_privacy_key(&privacy_key)?;

    let client = Client::new();
    let buffered_amount = request.amount_cents + (request.amount_cents / 10);
    let payload = PrivacyCreateCardRequest {
        card_type: "SINGLE_USE".to_string(),
        amount: buffered_amount as u32,
        memo: format!(
            "Agent {} purchase - {} / {}",
            agent_id, request.merchant, request.category
        ),
    };

    let response = client
        .post("https://api.privacy.com/v1/card")
        .bearer_auth(privacy_key)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            CanopyError::Request(format!("Privacy.com API connection failed: {}", error))
        })?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(CanopyError::Request(format!(
            "Privacy.com rejected request: {}",
            err_text
        )));
    }

    let card_data: PrivacyCardResponse = response.json().await.map_err(|error| {
        CanopyError::Serialization(format!(
            "Failed to parse Privacy.com response: {}",
            error
        ))
    })?;

    let last_four = card_data
        .last_four
        .or(card_data.pan)
        .unwrap_or_else(|| "0000".to_string());
    let provider_card_ref = card_data
        .token
        .unwrap_or_else(|| format!("privacy-{}", Uuid::new_v4()));

    Ok(IssuedCard {
        provider: VirtualCardProviderKind::Privacy,
        provider_card_ref,
        last_four: last_four.clone(),
        amount_cents: buffered_amount,
        merchant: request.merchant.clone(),
        memo: payload.memo,
        expires_at: Some(Utc::now() + Duration::hours(2)),
        message: format!(
            "Privacy.com virtual card ending in {} issued for ${:.2}.",
            last_four,
            buffered_amount as f64 / 100.0
        ),
    })
}

fn build_virtual_card_record(
    agent_id: &str,
    purchase_record_id: &str,
    issued: IssuedCard,
) -> VirtualCardRecord {
    VirtualCardRecord {
        id: Uuid::new_v4().to_string(),
        agent_id: agent_id.to_string(),
        purchase_record_id: purchase_record_id.to_string(),
        provider: issued.provider,
        provider_card_ref: issued.provider_card_ref,
        last_four: issued.last_four,
        amount_cents: issued.amount_cents,
        merchant: issued.merchant,
        memo: issued.memo,
        status: VirtualCardStatus::Active,
        created_at: Utc::now(),
        expires_at: issued.expires_at,
    }
}

async fn finalize_approved_purchase(
    app: &AppHandle,
    db: &Database,
    request: &PurchaseRequest,
    purchase_record: &mut PurchaseRecord,
) -> Result<(VirtualCardRecord, String)> {
    let provider = selected_provider()?;
    let issued = issue_card_for_provider(provider, &request.agent_id, request).await?;
    let message = issued.message.clone();
    let virtual_card = build_virtual_card_record(&request.agent_id, &purchase_record.id, issued);
    purchase_record.virtual_card_id = Some(virtual_card.id.clone());
    purchase_record.decision = PurchaseDecision::Approved;
    purchase_record.timestamp = Utc::now();

    db.update_purchase_record(purchase_record)?;
    db.record_virtual_card(&virtual_card)?;
    db.update_agent_spending(&request.agent_id, request.amount_cents, true, true)?;
    record_payment_audit(
        db,
        &request.agent_id,
        "purchase_approved",
        json!({
            "purchaseRecordId": purchase_record.id,
            "virtualCardId": virtual_card.id,
            "amountCents": request.amount_cents,
            "merchant": request.merchant,
            "provider": virtual_card.provider,
        }),
    )?;
    emit_payment_state_changed(app, &request.agent_id, "approved");

    Ok((virtual_card, message))
}

#[tauri::command]
pub fn evaluate_purchase(
    request: PurchaseRequest,
    budget: AgentBudget,
) -> Result<PurchaseDecision> {
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check("local-user")?;

    Ok(evaluate_purchase_with_context(
        &request,
        &budget,
        &[],
        true,
        Utc::now(),
    ))
}

#[tauri::command]
pub fn get_agent_budget(
    agent_id: String,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<AgentBudget> {
    crate::validators::agent::validate_id(&agent_id)?;
    if !state.is_budget_owner(&agent_id, &app_state.user_id)? {
        return Err(CanopyError::Unauthorized(format!(
            "Budget for agent '{}' is not available to user '{}'",
            agent_id, app_state.user_id
        )));
    }
    Ok(state
        .get_budget(&agent_id)?
        .unwrap_or_else(|| default_budget_config(&agent_id)))
}

#[tauri::command]
pub fn update_agent_budget(
    budget: AgentBudget,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<AgentBudget> {
    if !state.is_budget_owner(&budget.agent_id, &app_state.user_id)? {
        return Err(CanopyError::Unauthorized(format!(
            "Budget for agent '{}' is not modifiable by user '{}'",
            budget.agent_id, app_state.user_id
        )));
    }
    validate_budget_input(&budget)?;
    state.upsert_budget(&budget)?;
    Ok(budget)
}

#[tauri::command]
pub fn get_purchase_history(
    agent_id: String,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<Vec<PurchaseRecord>> {
    if !state.is_budget_owner(&agent_id, &app_state.user_id)? {
        return Err(CanopyError::Unauthorized(format!(
            "Purchase history for agent '{}' is not available to user '{}'",
            agent_id, app_state.user_id
        )));
    }
    Ok(state.get_purchase_history(&agent_id, 100)?)
}

#[tauri::command]
pub async fn request_purchase(
    app_handle: AppHandle,
    request: PurchaseRequest,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PurchaseExecutionResult> {
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check(&app_state.user_id)?;

    crate::validators::agent::validate_id(&request.agent_id)?;
    crate::validators::budget::validate_amount(request.amount_cents as i64)?;
    crate::validators::budget::validate_category(&request.category)?;
    validate_merchant_pattern(&request.merchant)?;

    let agent = ensure_payment_access(&state, &app_state, &request.agent_id)?;
    let budget = state
        .get_budget(&request.agent_id)?
        .unwrap_or_else(|| default_budget_config(&request.agent_id));
    let history = state.get_purchase_history(&request.agent_id, 250)?;

    let purchase_id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let decision = evaluate_purchase_with_context(
        &request,
        &budget,
        &history,
        agent.capabilities.spend_auto,
        now,
    );
    let mut purchase_record = build_purchase_record(purchase_id, &request, decision.clone(), now);
    state.record_purchase(&purchase_record)?;

    match decision {
        PurchaseDecision::Denied { reasons, flags } => {
            record_payment_audit(
                &state,
                &request.agent_id,
                "purchase_denied",
                json!({
                    "purchaseRecordId": purchase_record.id,
                    "reasons": reasons,
                    "flags": flags,
                    "amountCents": request.amount_cents,
                    "merchant": request.merchant,
                }),
            )?;
            emit_payment_state_changed(&app_handle, &request.agent_id, "denied");
            Ok(PurchaseExecutionResult {
                agent_id: request.agent_id.clone(),
                decision: purchase_record.decision.clone(),
                purchase_record,
                approval_request: None,
                virtual_card: None,
                message: Some("Purchase denied by policy".to_string()),
            })
        }
        PurchaseDecision::RequiresUserApproval { reason, flags, .. } => {
            let approval_id = Uuid::new_v4().to_string();
            let approval = PurchaseApprovalRequest {
                id: approval_id.clone(),
                agent_id: request.agent_id.clone(),
                purchase_record_id: purchase_record.id.clone(),
                purchase_request: request.clone(),
                reason: reason.clone(),
                flags: flags.clone(),
                status: PurchaseApprovalStatus::Pending,
                created_at: now,
                resolved_at: None,
                expires_at: Some(now + Duration::days(1)),
            };
            purchase_record.decision = PurchaseDecision::RequiresUserApproval {
                reason,
                flags,
                approval_id: Some(approval_id),
            };
            state.update_purchase_record(&purchase_record)?;
            state.create_payment_approval_request(&approval)?;
            record_payment_audit(
                &state,
                &request.agent_id,
                "purchase_requires_approval",
                json!({
                    "purchaseRecordId": purchase_record.id,
                    "approvalId": approval.id,
                    "merchant": request.merchant,
                    "amountCents": request.amount_cents,
                }),
            )?;
            let _ = app_handle.emit(
                "payment_approval_requested",
                PaymentApprovalRequestedEvent {
                    approval: approval.clone(),
                    agent_name: agent.name,
                },
            );
            emit_payment_state_changed(&app_handle, &request.agent_id, "awaiting_approval");
            Ok(PurchaseExecutionResult {
                agent_id: request.agent_id.clone(),
                decision: purchase_record.decision.clone(),
                purchase_record,
                approval_request: Some(approval),
                virtual_card: None,
                message: Some("Purchase queued for human approval".to_string()),
            })
        }
        PurchaseDecision::Approved => {
            let (virtual_card, message) =
                finalize_approved_purchase(&app_handle, &state, &request, &mut purchase_record)
                    .await?;
            Ok(PurchaseExecutionResult {
                agent_id: request.agent_id.clone(),
                decision: purchase_record.decision.clone(),
                purchase_record,
                approval_request: None,
                virtual_card: Some(virtual_card),
                message: Some(message),
            })
        }
    }
}

#[tauri::command]
pub async fn approve_purchase(
    app_handle: AppHandle,
    approval_id: String,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PurchaseExecutionResult> {
    let mut approval = state
        .get_payment_approval_request(&approval_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Approval '{}' not found", approval_id)))?;
    ensure_payment_access(&state, &app_state, &approval.agent_id)?;

    if approval.status != PurchaseApprovalStatus::Pending {
        return Err(CanopyError::Validation(format!(
            "Approval '{}' is not pending",
            approval_id
        )));
    }

    let mut purchase_record = state
        .get_purchase_record(&approval.purchase_record_id)?
        .ok_or_else(|| {
            CanopyError::NotFound(format!(
                "Purchase record '{}' not found",
                approval.purchase_record_id
            ))
        })?;

    let (virtual_card, message) = finalize_approved_purchase(
        &app_handle,
        &state,
        &approval.purchase_request,
        &mut purchase_record,
    )
    .await?;

    approval.status = PurchaseApprovalStatus::Approved;
    approval.resolved_at = Some(Utc::now());
    state.update_payment_approval_request(&approval)?;

    Ok(PurchaseExecutionResult {
        agent_id: approval.agent_id.clone(),
        decision: purchase_record.decision.clone(),
        purchase_record,
        approval_request: Some(approval),
        virtual_card: Some(virtual_card),
        message: Some(message),
    })
}

#[tauri::command]
pub fn deny_purchase(
    app_handle: AppHandle,
    approval_id: String,
    reason: Option<String>,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PurchaseExecutionResult> {
    let mut approval = state
        .get_payment_approval_request(&approval_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Approval '{}' not found", approval_id)))?;
    ensure_payment_access(&state, &app_state, &approval.agent_id)?;

    if approval.status != PurchaseApprovalStatus::Pending {
        return Err(CanopyError::Validation(format!(
            "Approval '{}' is not pending",
            approval_id
        )));
    }

    let mut purchase_record = state
        .get_purchase_record(&approval.purchase_record_id)?
        .ok_or_else(|| {
            CanopyError::NotFound(format!(
                "Purchase record '{}' not found",
                approval.purchase_record_id
            ))
        })?;

    purchase_record.decision = PurchaseDecision::Denied {
        reasons: vec![reason.unwrap_or_else(|| approval.reason.clone())],
        flags: approval.flags.clone(),
    };
    purchase_record.timestamp = Utc::now();
    state.update_purchase_record(&purchase_record)?;

    approval.status = PurchaseApprovalStatus::Denied;
    approval.resolved_at = Some(Utc::now());
    state.update_payment_approval_request(&approval)?;

    record_payment_audit(
        &state,
        &approval.agent_id,
        "purchase_denied_after_review",
        json!({
            "purchaseRecordId": purchase_record.id,
            "approvalId": approval.id,
            "flags": approval.flags,
        }),
    )?;
    emit_payment_state_changed(&app_handle, &approval.agent_id, "denied_after_review");

    Ok(PurchaseExecutionResult {
        agent_id: approval.agent_id.clone(),
        decision: purchase_record.decision.clone(),
        purchase_record,
        approval_request: Some(approval),
        virtual_card: None,
        message: Some("Purchase denied during human review".to_string()),
    })
}

#[tauri::command]
pub fn list_pending_purchase_approvals(
    agent_id: Option<String>,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<Vec<PurchaseApprovalRequest>> {
    if let Some(agent_id) = agent_id.as_deref() {
        if !state.is_budget_owner(agent_id, &app_state.user_id)? {
            return Err(CanopyError::Unauthorized(format!(
                "Pending purchase approvals for '{}' are unavailable to user '{}'",
                agent_id, app_state.user_id
            )));
        }
    }
    Ok(state.list_payment_approval_requests(agent_id.as_deref(), true)?)
}

#[tauri::command]
pub fn get_virtual_cards_for_agent(
    agent_id: String,
    active_only: Option<bool>,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<Vec<VirtualCardRecord>> {
    if !state.is_budget_owner(&agent_id, &app_state.user_id)? {
        return Err(CanopyError::Unauthorized(format!(
            "Virtual cards for '{}' are unavailable to user '{}'",
            agent_id, app_state.user_id
        )));
    }
    Ok(state.list_virtual_cards(&agent_id, active_only.unwrap_or(true))?)
}

#[tauri::command]
pub fn get_payment_dashboard(
    agent_id: String,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PaymentDashboard> {
    if !state.is_budget_owner(&agent_id, &app_state.user_id)? {
        return Err(CanopyError::Unauthorized(format!(
            "Payment dashboard for '{}' is unavailable to user '{}'",
            agent_id, app_state.user_id
        )));
    }
    Ok(PaymentDashboard {
        agent_id: agent_id.clone(),
        budget: state
            .get_budget(&agent_id)?
            .unwrap_or_else(|| default_budget_config(&agent_id)),
        pending_approvals: state.list_payment_approval_requests(Some(&agent_id), true)?,
        recent_purchases: state.get_purchase_history(&agent_id, 100)?,
        active_virtual_cards: state.list_virtual_cards(&agent_id, true)?,
    })
}

#[tauri::command]
pub async fn issue_virtual_card(
    agent_id: String,
    amount_cents: u64,
    category: String,
    merchant: Option<String>,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<String> {
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check(&app_state.user_id)?;

    ensure_payment_access(&state, &app_state, &agent_id)?;
    crate::validators::budget::validate_amount(amount_cents as i64)?;
    crate::validators::budget::validate_category(&category)?;
    let merchant = merchant.unwrap_or_else(|| "manual-issue".to_string());
    validate_merchant_pattern(&merchant)?;

    let request = PurchaseRequest {
        agent_id: agent_id.clone(),
        description: "Manual virtual card issuance".to_string(),
        merchant,
        amount_cents,
        category,
        is_recurring: false,
    };
    let provider = selected_provider()?;
    let issued = issue_card_for_provider(provider, &agent_id, &request).await?;
    Ok(issued.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_budget(agent_id: &str) -> AgentBudget {
        AgentBudget {
            agent_id: agent_id.to_string(),
            payments_enabled: true,
            auto_approve_threshold_cents: 5_000,
            per_transaction_limit_cents: 100_000,
            daily_limit_cents: 50_000,
            monthly_limit_cents: 200_000,
            hourly_velocity_limit: 5,
            allowed_categories: vec![
                "cleaning_supplies".to_string(),
                "office_supplies".to_string(),
            ],
            allowed_merchants: vec![],
            blocked_merchants: vec![],
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

    #[test]
    fn new_merchant_requires_approval_when_enabled() {
        let budget = default_budget("agent-1");
        let request = purchase_request("agent-1", 1_500, "cleaning_supplies");
        let result = evaluate_purchase_with_context(&request, &budget, &[], true, Utc::now());
        match result {
            PurchaseDecision::RequiresUserApproval { flags, .. } => {
                assert!(flags.iter().any(|flag| flag == "new_merchant"));
            }
            other => panic!("Expected approval, got {:?}", other),
        }
    }

    #[test]
    fn recurring_purchase_requires_approval() {
        let budget = default_budget("agent-1");
        let mut request = purchase_request("agent-1", 1_500, "cleaning_supplies");
        request.description = "Monthly subscription".to_string();
        let result = evaluate_purchase_with_context(&request, &budget, &[], true, Utc::now());
        match result {
            PurchaseDecision::RequiresUserApproval { flags, .. } => {
                assert!(flags.iter().any(|flag| flag == "recurring"));
            }
            other => panic!("Expected approval, got {:?}", other),
        }
    }

    #[test]
    fn blocked_merchant_is_denied() {
        let mut budget = default_budget("agent-1");
        budget.require_approval_new_merchant = false;
        budget.blocked_merchants = vec!["amazon".to_string()];
        let request = purchase_request("agent-1", 1_500, "cleaning_supplies");
        let result = evaluate_purchase_with_context(&request, &budget, &[], true, Utc::now());
        match result {
            PurchaseDecision::Denied { reasons, .. } => {
                assert!(reasons.iter().any(|reason| reason.contains("blocked")));
            }
            other => panic!("Expected denial, got {:?}", other),
        }
    }

    #[test]
    fn spend_auto_disabled_requires_approval_even_under_threshold() {
        let mut budget = default_budget("agent-1");
        budget.require_approval_new_merchant = false;
        let history = vec![PurchaseRecord {
            id: "p-1".to_string(),
            agent_id: "agent-1".to_string(),
            description: "Previous purchase".to_string(),
            merchant: "Amazon".to_string(),
            amount_cents: 500,
            category: "cleaning_supplies".to_string(),
            decision: PurchaseDecision::Approved,
            virtual_card_id: None,
            timestamp: Utc::now() - Duration::hours(2),
        }];
        let request = purchase_request("agent-1", 1_500, "cleaning_supplies");
        let result =
            evaluate_purchase_with_context(&request, &budget, &history, false, Utc::now());
        match result {
            PurchaseDecision::RequiresUserApproval { flags, .. } => {
                assert!(flags.iter().any(|flag| flag == "spend_auto_disabled"));
            }
            other => panic!("Expected approval, got {:?}", other),
        }
    }

    #[test]
    fn mock_provider_is_deterministic() {
        let request = purchase_request("agent-1", 2_345, "cleaning_supplies");
        let first = issue_mock_card("agent-1", &request).unwrap();
        let second = issue_mock_card("agent-1", &request).unwrap();
        assert_eq!(first.provider_card_ref, second.provider_card_ref);
        assert_eq!(first.last_four, second.last_four);
    }
}

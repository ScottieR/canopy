use crate::app_state::AppState;
use crate::db::Database;
use crate::errors::{CanopyError, Result};
use crate::models::{
    Agent, AgentBudget, PaymentAuditEntry, PaymentDashboard, PaymentProviderConfig,
    PaymentProviderUpdate, PaymentTransactionRecord, PaymentTransactionStatus,
    PurchaseApprovalRequest, PurchaseApprovalStatus, PurchaseDecision, PurchaseExecutionResult,
    PurchaseRecord, PurchaseRequest, VirtualCardProviderKind, VirtualCardRecord, VirtualCardStatus,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{Datelike, Duration, Utc};
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use uuid::Uuid;

const DEFAULT_ALLOWED_CATEGORIES: &[&str] =
    &["software", "office_supplies", "cleaning_supplies"];
const PAYMENT_PROVIDER_SLOT: &str = "payment_provider_selected";
const LITHIC_WEBHOOK_SECRET_SLOT: &str = "LITHIC_SANDBOX_WEBHOOK_SECRET";
const DEFAULT_PAYMENT_WEBHOOK_HOST: &str = "127.0.0.1";
const DEFAULT_PAYMENT_WEBHOOK_TIMESTAMP_TOLERANCE_SECS: i64 = 300;
const DEV_PRIVACY_CARD_PREFIX: &str = "privacy-dev-";
const DEV_LITHIC_CARD_PREFIX: &str = "lithic-dev-";
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
    LithicSandbox,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSimulationOutcome {
    Captured,
    Declined,
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

#[derive(Debug, Clone, Default)]
struct PaymentWebhookListenerRuntime {
    listening: bool,
    base_url: Option<String>,
    last_error: Option<String>,
}

#[derive(Default)]
pub struct PaymentWebhookListenerState {
    runtime: RwLock<PaymentWebhookListenerRuntime>,
}

impl PaymentWebhookListenerState {
    async fn set_runtime(&self, runtime: PaymentWebhookListenerRuntime) {
        *self.runtime.write().await = runtime;
    }

    async fn snapshot(&self) -> PaymentWebhookListenerRuntime {
        self.runtime.read().await.clone()
    }
}

#[derive(Serialize)]
struct PrivacyCreateCardRequest {
    #[serde(rename = "type")]
    card_type: String,
    memo: String,
    spend_limit: u32,
    spend_limit_duration: String,
    state: String,
}

#[derive(Serialize)]
struct PrivacyUpdateCardRequest {
    state: String,
}

#[derive(Deserialize, Debug)]
struct PrivacyCardResponse {
    token: Option<String>,
    last_four: Option<String>,
    pan: Option<String>,
}

#[derive(Serialize)]
struct LithicSandboxCreateCardRequest {
    #[serde(rename = "type")]
    card_type: String,
    memo: String,
    spend_limit: u64,
    spend_limit_duration: String,
    state: String,
}

#[derive(Serialize)]
struct LithicSandboxUpdateCardRequest {
    state: String,
    substatus: String,
}

#[derive(Deserialize, Debug)]
struct LithicSandboxCardResponse {
    token: Option<String>,
    last_four: Option<String>,
    pan: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PrivacyTransactionEventMerchant {
    name: Option<String>,
    descriptor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PrivacyTransactionEventPayload {
    token: String,
    amount: u64,
    status: String,
    result: Option<String>,
    decline_reason: Option<String>,
    merchant: Option<PrivacyTransactionEventMerchant>,
    transaction_token: Option<String>,
    event_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LithicTransactionEventMerchant {
    name: Option<String>,
    descriptor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LithicTransactionEventPayload {
    card_token: String,
    amount: u64,
    status: String,
    result: Option<String>,
    decline_reason: Option<String>,
    merchant: Option<LithicTransactionEventMerchant>,
    token: Option<String>,
    transaction_token: Option<String>,
    event_type: Option<String>,
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

fn development_provider_prefix(provider: &VirtualCardProviderKind) -> Option<&'static str> {
    match provider {
        VirtualCardProviderKind::Mock => None,
        VirtualCardProviderKind::Privacy => Some(DEV_PRIVACY_CARD_PREFIX),
        VirtualCardProviderKind::LithicSandbox => Some(DEV_LITHIC_CARD_PREFIX),
    }
}

fn is_development_provider_card(card: &VirtualCardRecord) -> bool {
    development_provider_prefix(&card.provider)
        .map(|prefix| card.provider_card_ref.starts_with(prefix))
        .unwrap_or(false)
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

fn selected_provider_from(explicit: &str) -> Result<CardProvider> {
    match explicit.to_ascii_lowercase().as_str() {
        "mock" => Ok(CardProvider::Mock),
        "privacy" => Ok(CardProvider::Privacy),
        "lithic" | "lithic_sandbox" => Ok(CardProvider::LithicSandbox),
        value => Err(CanopyError::Configuration(format!(
            "Unknown payment provider '{}'",
            value
        ))),
    }
}

fn provider_kind_to_storage_value(provider: &VirtualCardProviderKind) -> &'static str {
    match provider {
        VirtualCardProviderKind::Mock => "mock",
        VirtualCardProviderKind::Privacy => "privacy",
        VirtualCardProviderKind::LithicSandbox => "lithic_sandbox",
    }
}

fn provider_kind_to_runtime(provider: &VirtualCardProviderKind) -> CardProvider {
    match provider {
        VirtualCardProviderKind::Mock => CardProvider::Mock,
        VirtualCardProviderKind::Privacy => CardProvider::Privacy,
        VirtualCardProviderKind::LithicSandbox => CardProvider::LithicSandbox,
    }
}

fn provider_to_kind(provider: &CardProvider) -> VirtualCardProviderKind {
    match provider {
        CardProvider::Mock => VirtualCardProviderKind::Mock,
        CardProvider::Privacy => VirtualCardProviderKind::Privacy,
        CardProvider::LithicSandbox => VirtualCardProviderKind::LithicSandbox,
    }
}

fn has_keychain_secret(key: &str) -> bool {
    #[cfg(test)]
    {
        return has_env_secret(key);
    }

    crate::keychain::get_secret(key)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn read_config_secret(key: &str) -> Option<String> {
    #[cfg(test)]
    {
        return std::env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty());
    }

    crate::keychain::get_secret(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn store_config_secret(key: &str, value: &str) -> Result<()> {
    #[cfg(test)]
    {
        std::env::set_var(key, value);
        return Ok(());
    }

    crate::keychain::store_secret(key, value)
}

fn delete_config_secret(key: &str) -> Result<()> {
    #[cfg(test)]
    {
        std::env::remove_var(key);
        return Ok(());
    }

    crate::keychain::delete_secret_internal(key)
}

fn has_env_secret(key: &str) -> bool {
    std::env::var(key)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn resolve_selected_provider() -> Result<(CardProvider, bool)> {
    if let Some(stored) = read_config_secret(PAYMENT_PROVIDER_SLOT) {
        let stored = stored.trim();
        if !stored.is_empty() {
            return Ok((selected_provider_from(stored)?, false));
        }
    }

    match std::env::var("CANOPY_PAYMENT_PROVIDER") {
        Ok(explicit) => Ok((selected_provider_from(&explicit)?, true)),
        Err(_) => Ok((CardProvider::Mock, false)),
    }
}

fn selected_provider() -> Result<CardProvider> {
    Ok(resolve_selected_provider()?.0)
}

fn payment_webhook_urls(base_url: Option<&str>) -> (Option<String>, Option<String>) {
    match base_url {
        Some(base_url) if !base_url.trim().is_empty() => (
            Some(format!("{}/payment-webhooks/privacy", base_url)),
            Some(format!("{}/payment-webhooks/lithic", base_url)),
        ),
        _ => (None, None),
    }
}

fn current_payment_provider_config(
    webhook_runtime: &PaymentWebhookListenerRuntime,
) -> Result<PaymentProviderConfig> {
    let (provider, using_env_fallback) = resolve_selected_provider()?;
    let privacy_configured = has_keychain_secret("PRIVACY_API_KEY") || has_env_secret("PRIVACY_API_KEY");
    let lithic_sandbox_configured = has_keychain_secret("LITHIC_SANDBOX_API_KEY")
        || has_keychain_secret("LITHIC_API_KEY")
        || has_env_secret("LITHIC_SANDBOX_API_KEY")
        || has_env_secret("LITHIC_API_KEY");
    let lithic_webhook_secret_configured = has_keychain_secret(LITHIC_WEBHOOK_SECRET_SLOT)
        || has_env_secret(LITHIC_WEBHOOK_SECRET_SLOT);
    let (privacy_webhook_url, lithic_webhook_url) =
        payment_webhook_urls(webhook_runtime.base_url.as_deref());

    let active_provider_ready = match provider {
        CardProvider::Mock => true,
        CardProvider::Privacy => privacy_configured,
        CardProvider::LithicSandbox => lithic_sandbox_configured && lithic_webhook_secret_configured,
    };

    Ok(PaymentProviderConfig {
        provider: provider_to_kind(&provider),
        privacy_configured,
        lithic_sandbox_configured,
        lithic_webhook_secret_configured,
        active_provider_ready,
        using_env_fallback,
        webhook_listener_listening: webhook_runtime.listening,
        privacy_webhook_url,
        lithic_webhook_url,
        webhook_listener_error: webhook_runtime.last_error.clone(),
    })
}

fn apply_payment_provider_update(
    update: PaymentProviderUpdate,
    webhook_runtime: &PaymentWebhookListenerRuntime,
) -> Result<PaymentProviderConfig> {
    if update.clear_privacy_api_key {
        delete_config_secret("PRIVACY_API_KEY")?;
    }
    if update.clear_lithic_sandbox_api_key {
        delete_config_secret("LITHIC_SANDBOX_API_KEY")?;
        delete_config_secret("LITHIC_API_KEY")?;
    }
    if update.clear_lithic_webhook_secret {
        delete_config_secret(LITHIC_WEBHOOK_SECRET_SLOT)?;
    }

    if let Some(privacy_key) = update
        .privacy_api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        crate::validators::keys::validate_privacy_key(privacy_key)?;
        store_config_secret("PRIVACY_API_KEY", privacy_key)?;
    }

    if let Some(lithic_key) = update
        .lithic_sandbox_api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        crate::validators::keys::validate_lithic_sandbox_key(lithic_key)?;
        store_config_secret("LITHIC_SANDBOX_API_KEY", lithic_key)?;
    }

    if let Some(webhook_secret) = update
        .lithic_webhook_secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        crate::validators::keys::validate_lithic_webhook_secret(webhook_secret)?;
        store_config_secret(LITHIC_WEBHOOK_SECRET_SLOT, webhook_secret)?;
    }

    store_config_secret(
        PAYMENT_PROVIDER_SLOT,
        provider_kind_to_storage_value(&update.provider),
    )?;

    current_payment_provider_config(webhook_runtime)
}

fn get_privacy_key() -> Result<String> {
    if let Some(value) = read_config_secret("PRIVACY_API_KEY") {
        if has_env_secret("PRIVACY_API_KEY") {
            tracing::warn!(
                "PRIVACY_API_KEY read from environment variable - consider migrating to keychain"
            );
        }
        return Ok(value);
    }

    Err(CanopyError::Configuration(
        "PRIVACY_API_KEY not found in keychain or environment".to_string(),
    ))
}

fn get_lithic_webhook_secret() -> Result<String> {
    if let Some(value) = read_config_secret(LITHIC_WEBHOOK_SECRET_SLOT) {
        if has_env_secret(LITHIC_WEBHOOK_SECRET_SLOT) {
            tracing::warn!(
                "Lithic webhook secret read from environment variable - consider migrating to keychain"
            );
        }
        return Ok(value);
    }

    Err(CanopyError::Configuration(
        "Lithic webhook secret not found in keychain or environment".to_string(),
    ))
}

fn payment_listener_host() -> String {
    std::env::var("CANOPY_PAYMENT_WEBHOOK_HOST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PAYMENT_WEBHOOK_HOST.to_string())
}

fn payment_listener_port() -> u16 {
    std::env::var("CANOPY_PAYMENT_WEBHOOK_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0)
}

fn http_status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

fn http_json_response(status: u16, body: Value) -> Vec<u8> {
    let payload = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        http_status_text(status),
        payload.len()
    )
    .into_bytes()
    .into_iter()
    .chain(payload)
    .collect()
}

fn canonical_json_string(value: &Value) -> Result<String> {
    let mut output = String::new();
    write_canonical_json(value, &mut output)?;
    Ok(output)
}

fn write_canonical_json(value: &Value, output: &mut String) -> Result<()> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(boolean) => {
            if *boolean {
                output.push_str("true");
            } else {
                output.push_str("false");
            }
        }
        Value::Number(number) => output.push_str(&number.to_string()),
        Value::String(string) => {
            output.push_str(&serde_json::to_string(string).map_err(|error| {
                CanopyError::Serialization(format!(
                    "Failed to serialize webhook string value: {}",
                    error
                ))
            })?);
        }
        Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_json(item, output)?;
            }
            output.push(']');
        }
        Value::Object(map) => {
            output.push('{');
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).map_err(|error| {
                    CanopyError::Serialization(format!(
                        "Failed to serialize webhook object key: {}",
                        error
                    ))
                })?);
                output.push(':');
                write_canonical_json(&map[key], output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn calculate_hmac_base64(secret: &[u8], message: &[u8]) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|error| {
        CanopyError::Internal(format!("Failed to initialize HMAC: {}", error))
    })?;
    mac.update(message);
    Ok(BASE64.encode(mac.finalize().into_bytes()))
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn lowercase_headers(headers: &str) -> std::collections::HashMap<String, String> {
    headers
        .lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect()
}

fn verify_privacy_webhook_request(
    headers: &std::collections::HashMap<String, String>,
    body: &[u8],
) -> Result<Value> {
    let request_hmac = headers
        .get("x-privacy-hmac")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            CanopyError::Unauthorized("Missing X-Privacy-HMAC header".to_string())
        })?;
    let api_key = get_privacy_key()?;
    crate::validators::keys::validate_privacy_key(&api_key)?;

    let payload: Value = serde_json::from_slice(body).map_err(|error| {
        CanopyError::Serialization(format!(
            "Invalid Privacy webhook payload: {}",
            error
        ))
    })?;
    let canonical = canonical_json_string(&payload)?;
    let expected = calculate_hmac_base64(api_key.as_bytes(), canonical.as_bytes())?;
    if !constant_time_eq(request_hmac.trim(), &expected) {
        return Err(CanopyError::Unauthorized(
            "Privacy webhook signature verification failed".to_string(),
        ));
    }
    Ok(payload)
}

fn verify_lithic_webhook_request(
    headers: &std::collections::HashMap<String, String>,
    body: &[u8],
) -> Result<Value> {
    let webhook_id = headers
        .get("webhook-id")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CanopyError::Unauthorized("Missing webhook-id header".to_string()))?;
    let timestamp = headers
        .get("webhook-timestamp")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            CanopyError::Unauthorized("Missing webhook-timestamp header".to_string())
        })?;
    let signatures = headers
        .get("webhook-signature")
        .or_else(|| headers.get("x-lithic-signature"))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            CanopyError::Unauthorized("Missing webhook-signature header".to_string())
        })?;

    let secret = get_lithic_webhook_secret()?;
    crate::validators::keys::validate_lithic_webhook_secret(&secret)?;
    let secret_body = secret.strip_prefix("whsec_").unwrap_or(secret.as_str());

    let timestamp_value = timestamp.parse::<i64>().map_err(|_| {
        CanopyError::Unauthorized("Invalid webhook-timestamp header".to_string())
    })?;
    let now = Utc::now().timestamp();
    if (now - timestamp_value).abs() > DEFAULT_PAYMENT_WEBHOOK_TIMESTAMP_TOLERANCE_SECS {
        return Err(CanopyError::Unauthorized(
            "Lithic webhook timestamp is outside the allowed tolerance".to_string(),
        ));
    }

    let signed_content = format!(
        "{}.{}.{}",
        webhook_id.trim(),
        timestamp.trim(),
        String::from_utf8_lossy(body)
    );
    let expected = calculate_hmac_base64(secret_body.as_bytes(), signed_content.as_bytes())?;
    let matches_signature = signatures
        .split_whitespace()
        .filter_map(|entry| entry.split_once(',').map(|(_, signature)| signature).or(Some(entry)))
        .any(|signature| constant_time_eq(signature.trim(), &expected));
    if !matches_signature {
        return Err(CanopyError::Unauthorized(
            "Lithic webhook signature verification failed".to_string(),
        ));
    }

    let payload: Value = serde_json::from_slice(body).map_err(|error| {
        CanopyError::Serialization(format!(
            "Invalid Lithic webhook payload: {}",
            error
        ))
    })?;
    Ok(payload
        .get("payload")
        .cloned()
        .unwrap_or(payload))
}

async fn handle_payment_webhook_request<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    method: &str,
    path: &str,
    headers: &std::collections::HashMap<String, String>,
    body: &[u8],
) -> Result<(u16, Value)> {
    if method.eq_ignore_ascii_case("GET") && path == "/payment-webhooks/health" {
        return Ok((200, json!({ "ok": true })));
    }

    if !method.eq_ignore_ascii_case("POST") {
        return Ok((
            405,
            json!({ "error": "Only POST is supported for payment webhooks" }),
        ));
    }

    let app_state = app_handle.state::<AppState>().clone();
    let db_state = app_handle.state::<Database>().clone();

    match path {
        "/payment-webhooks/privacy" => {
            let payload = verify_privacy_webhook_request(headers, body)?;
            let transaction = handle_privacy_transaction_event_inner(
                app_handle.clone(),
                payload,
                app_state,
                db_state,
            )
            .await?;
            Ok((200, json!({ "ok": true, "transaction_id": transaction.id })))
        }
        "/payment-webhooks/lithic" => {
            let payload = verify_lithic_webhook_request(headers, body)?;
            let transaction = handle_lithic_transaction_event_inner(
                app_handle.clone(),
                payload,
                app_state,
                db_state,
            )
            .await?;
            Ok((200, json!({ "ok": true, "transaction_id": transaction.id })))
        }
        _ => Ok((404, json!({ "error": "Webhook route not found" }))),
    }
}

async fn handle_payment_webhook_connection<R: tauri::Runtime>(
    mut socket: tokio::net::TcpStream,
    app_handle: tauri::AppHandle<R>,
) {
    let mut buf = [0; 8192];
    let mut req_data = Vec::new();
    let mut content_length = 0usize;
    let mut headers_end = None;

    loop {
        match socket.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                req_data.extend_from_slice(&buf[..n]);
                if req_data.len() > 256 * 1024 {
                    let _ = socket
                        .write_all(&http_json_response(
                            413,
                            json!({ "error": "Webhook payload too large" }),
                        ))
                        .await;
                    return;
                }

                if headers_end.is_none() {
                    if let Some(pos) = req_data.windows(4).position(|window| window == b"\r\n\r\n")
                    {
                        headers_end = Some(pos + 4);
                        let headers = String::from_utf8_lossy(&req_data[..pos]);
                        content_length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                if name.eq_ignore_ascii_case("content-length") {
                                    value.trim().parse::<usize>().ok()
                                } else {
                                    None
                                }
                            })
                            .unwrap_or(0);
                    }
                }

                if let Some(headers_end) = headers_end {
                    if req_data.len().saturating_sub(headers_end) >= content_length {
                        break;
                    }
                }
            }
            Err(error) => {
                tracing::warn!("Payment webhook socket read failed: {}", error);
                return;
            }
        }
    }

    let Some(body_start) = headers_end else {
        let _ = socket
            .write_all(&http_json_response(
                400,
                json!({ "error": "Invalid HTTP request" }),
            ))
            .await;
        return;
    };
    let header_text = String::from_utf8_lossy(&req_data[..body_start - 4]);
    let mut request_line_parts = header_text
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = request_line_parts.next().unwrap_or_default();
    let path = request_line_parts.next().unwrap_or("/");
    let headers = lowercase_headers(&header_text);
    let body = &req_data[body_start..body_start + content_length.min(req_data.len().saturating_sub(body_start))];

    let response = match handle_payment_webhook_request(app_handle, method, path, &headers, body).await {
        Ok((status, body)) => http_json_response(status, body),
        Err(CanopyError::Unauthorized(message)) => {
            http_json_response(401, json!({ "error": message }))
        }
        Err(CanopyError::NotFound(message)) => http_json_response(404, json!({ "error": message })),
        Err(CanopyError::Serialization(message)) | Err(CanopyError::Validation(message)) => {
            http_json_response(422, json!({ "error": message }))
        }
        Err(error) => {
            tracing::warn!("Payment webhook processing failed: {}", error);
            http_json_response(500, json!({ "error": error.to_string() }))
        }
    };
    let _ = socket.write_all(&response).await;
}

pub async fn start_payment_webhook_server<R: tauri::Runtime>(
    state: Arc<PaymentWebhookListenerState>,
    app_handle: tauri::AppHandle<R>,
) {
    let host = payment_listener_host();
    let port = payment_listener_port();
    let bind_address = format!("{}:{}", host, port);
    let listener = match TcpListener::bind(&bind_address).await {
        Ok(listener) => listener,
        Err(error) => {
            state
                .set_runtime(PaymentWebhookListenerRuntime {
                    listening: false,
                    base_url: None,
                    last_error: Some(format!(
                        "Failed to bind payment webhook listener on {}: {}",
                        bind_address, error
                    )),
                })
                .await;
            tracing::warn!(
                "Payment webhook listener failed to start on {}: {}",
                bind_address,
                error
            );
            return;
        }
    };

    let local_addr = match listener.local_addr() {
        Ok(local_addr) => local_addr,
        Err(error) => {
            state
                .set_runtime(PaymentWebhookListenerRuntime {
                    listening: false,
                    base_url: None,
                    last_error: Some(format!(
                        "Failed to resolve payment webhook listener address: {}",
                        error
                    )),
                })
                .await;
            tracing::warn!(
                "Payment webhook listener failed to resolve local address: {}",
                error
            );
            return;
        }
    };

    let base_url = format!("http://{}", local_addr);
    state
        .set_runtime(PaymentWebhookListenerRuntime {
            listening: true,
            base_url: Some(base_url.clone()),
            last_error: None,
        })
        .await;
    tracing::info!("Payment webhook listener started at {}", base_url);

    loop {
        match listener.accept().await {
            Ok((socket, _)) => {
                let app_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    handle_payment_webhook_connection(socket, app_handle).await;
                });
            }
            Err(error) => {
                state
                    .set_runtime(PaymentWebhookListenerRuntime {
                        listening: false,
                        base_url: Some(base_url.clone()),
                        last_error: Some(format!("Payment webhook listener stopped: {}", error)),
                    })
                    .await;
                tracing::warn!("Payment webhook listener accept failed: {}", error);
                break;
            }
        }
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

fn emit_payment_state_changed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    agent_id: &str,
    reason: &str,
) {
    let _ = app.emit(
        "payment_state_changed",
        PaymentStateChangedEvent {
            agent_id: agent_id.to_string(),
            reason: reason.to_string(),
        },
    );
}

fn is_same_utc_day(
    left: chrono::DateTime<Utc>,
    right: chrono::DateTime<Utc>,
) -> bool {
    left.date_naive() == right.date_naive()
}

fn is_same_utc_month(
    left: chrono::DateTime<Utc>,
    right: chrono::DateTime<Utc>,
) -> bool {
    left.year() == right.year() && left.month() == right.month()
}

fn expiration_due(expires_at: Option<chrono::DateTime<Utc>>, now: chrono::DateTime<Utc>) -> bool {
    expires_at.map(|value| value <= now).unwrap_or(false)
}

fn expire_approval_if_needed(
    db: &Database,
    approval: &PurchaseApprovalRequest,
    now: chrono::DateTime<Utc>,
) -> Result<bool> {
    if approval.status != PurchaseApprovalStatus::Pending || !expiration_due(approval.expires_at, now)
    {
        return Ok(false);
    }

    let mut expired = approval.clone();
    expired.status = PurchaseApprovalStatus::Expired;
    expired.resolved_at = Some(now);
    db.update_payment_approval_request(&expired)?;

    if let Some(mut purchase_record) = db.get_purchase_record(&approval.purchase_record_id)? {
        if matches!(
            purchase_record.decision,
            PurchaseDecision::RequiresUserApproval { .. }
        ) {
            purchase_record.decision = PurchaseDecision::Denied {
                reasons: vec!["Approval request expired before review".to_string()],
                flags: vec!["approval_expired".to_string()],
            };
            purchase_record.timestamp = now;
            db.update_purchase_record(&purchase_record)?;
        }
    }

    record_payment_audit(
        db,
        &approval.agent_id,
        "purchase_approval_expired",
        json!({
            "approvalId": approval.id,
            "purchaseRecordId": approval.purchase_record_id,
        }),
    )?;

    Ok(true)
}

fn expire_virtual_card_if_needed(
    db: &Database,
    card: &VirtualCardRecord,
    now: chrono::DateTime<Utc>,
) -> Result<bool> {
    if card.status != VirtualCardStatus::Active || !expiration_due(card.expires_at, now) {
        return Ok(false);
    }

    let mut expired = card.clone();
    expired.status = VirtualCardStatus::Expired;
    db.update_virtual_card(&expired)?;

    record_payment_audit(
        db,
        &card.agent_id,
        "virtual_card_expired",
        json!({
            "cardId": card.id,
            "purchaseRecordId": card.purchase_record_id,
            "provider": provider_kind_to_storage_value(&card.provider),
        }),
    )?;

    Ok(true)
}

fn reconcile_payment_state(db: &Database, agent_id: Option<&str>) -> Result<bool> {
    let now = Utc::now();
    let mut changed = false;

    for approval in db.list_payment_approval_requests(agent_id, false)? {
        changed |= expire_approval_if_needed(db, &approval, now)?;
    }

    if let Some(agent_id) = agent_id {
        for card in db.list_virtual_cards(agent_id, false)? {
            changed |= expire_virtual_card_if_needed(db, &card, now)?;
        }
    }

    Ok(changed)
}

fn transaction_status_to_reason(status: &PaymentTransactionStatus) -> &'static str {
    match status {
        PaymentTransactionStatus::Authorized => "transaction_authorized",
        PaymentTransactionStatus::Captured => "transaction_captured",
        PaymentTransactionStatus::Declined => "transaction_declined",
        PaymentTransactionStatus::Refunded => "transaction_refunded",
    }
}

fn transaction_status_to_audit_event(status: &PaymentTransactionStatus) -> &'static str {
    match status {
        PaymentTransactionStatus::Authorized => "payment_transaction_authorized",
        PaymentTransactionStatus::Captured => "payment_transaction_captured",
        PaymentTransactionStatus::Declined => "payment_transaction_declined",
        PaymentTransactionStatus::Refunded => "payment_transaction_refunded",
    }
}

fn transaction_consumes_card(status: &PaymentTransactionStatus) -> bool {
    matches!(
        status,
        PaymentTransactionStatus::Authorized
            | PaymentTransactionStatus::Captured
            | PaymentTransactionStatus::Declined
    )
}

fn parse_provider_transaction_status(raw: &str) -> PaymentTransactionStatus {
    match raw.trim().to_ascii_uppercase().as_str() {
        "AUTHORIZED" | "AUTHORIZATION" | "PENDING" => PaymentTransactionStatus::Authorized,
        "CAPTURED" | "APPROVED" | "SETTLED" | "CLEARED" | "SETTLING" | "CLEARING" => {
            PaymentTransactionStatus::Captured
        }
        "DECLINED" | "DECLINE" | "DENIED" | "VOIDED" | "EXPIRED" | "BOUNCED" => {
            PaymentTransactionStatus::Declined
        }
        "REFUNDED" | "RETURNED" | "REFUND" => PaymentTransactionStatus::Refunded,
        _ => PaymentTransactionStatus::Captured,
    }
}

fn record_transaction_for_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    db: &Database,
    card: &VirtualCardRecord,
    status: PaymentTransactionStatus,
    source: &str,
    decline_reason: Option<String>,
    provider_transaction_ref: Option<String>,
    merchant_override: Option<String>,
    amount_override: Option<u64>,
) -> Result<PaymentTransactionRecord> {
    let now = Utc::now();
    let mut updated_card = card.clone();
    let purchase_record = if card.purchase_record_id.trim().is_empty() {
        None
    } else {
        db.get_purchase_record(&card.purchase_record_id)?
    };

    if transaction_consumes_card(&status) && updated_card.status == VirtualCardStatus::Active {
        updated_card.status = VirtualCardStatus::Consumed;
        db.update_virtual_card(&updated_card)?;
    }

    if matches!(status, PaymentTransactionStatus::Declined) {
        if let Some(mut purchase_record) = purchase_record.clone() {
            if !matches!(purchase_record.decision, PurchaseDecision::Denied { .. }) {
                let original_timestamp = purchase_record.timestamp;
                let decline_message = decline_reason
                    .clone()
                    .unwrap_or_else(|| "Provider declined transaction".to_string());
                purchase_record.decision = PurchaseDecision::Denied {
                    reasons: vec![decline_message.clone()],
                    flags: vec!["provider_transaction_declined".to_string()],
                };
                purchase_record.timestamp = now;
                db.update_purchase_record(&purchase_record)?;
                db.adjust_agent_spending(
                    &card.agent_id,
                    -(card.amount_cents as i64),
                    is_same_utc_day(original_timestamp, now),
                    is_same_utc_month(original_timestamp, now),
                )?;
            }
        }
    }

    let transaction = PaymentTransactionRecord {
        id: Uuid::new_v4().to_string(),
        agent_id: card.agent_id.clone(),
        purchase_record_id: Some(card.purchase_record_id.clone()),
        virtual_card_id: Some(card.id.clone()),
        provider: card.provider.clone(),
        provider_transaction_ref: provider_transaction_ref.unwrap_or_else(|| {
            format!(
                "{}-{}",
                provider_kind_to_storage_value(&card.provider),
                Uuid::new_v4()
            )
        }),
        merchant: merchant_override.unwrap_or_else(|| card.merchant.clone()),
        amount_cents: amount_override.unwrap_or(card.amount_cents),
        status: status.clone(),
        source: source.to_string(),
        decline_reason: decline_reason.clone(),
        created_at: now,
        settled_at: if matches!(
            status,
            PaymentTransactionStatus::Captured
                | PaymentTransactionStatus::Declined
                | PaymentTransactionStatus::Refunded
        ) {
            Some(now)
        } else {
            None
        },
    };
    db.record_payment_transaction(&transaction)?;
    record_payment_audit(
        db,
        &card.agent_id,
        transaction_status_to_audit_event(&status),
        json!({
            "transactionId": transaction.id,
            "cardId": card.id,
            "purchaseRecordId": card.purchase_record_id,
            "provider": provider_kind_to_storage_value(&card.provider),
            "status": status,
            "amountCents": card.amount_cents,
            "merchant": card.merchant,
            "source": source,
            "declineReason": decline_reason,
        }),
    )?;
    emit_payment_state_changed(app, &card.agent_id, transaction_status_to_reason(&status));

    Ok(transaction)
}

async fn record_provider_transaction_event_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    provider: VirtualCardProviderKind,
    provider_card_ref: String,
    provider_transaction_ref: Option<String>,
    merchant: Option<String>,
    amount_cents: u64,
    status: PaymentTransactionStatus,
    decline_reason: Option<String>,
    source: &str,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PaymentTransactionRecord> {
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check(&app_state.user_id)?;

    if let Some(provider_transaction_ref) = provider_transaction_ref.as_deref() {
        if let Some(existing) = state.get_payment_transaction_by_provider_ref(
            &provider,
            provider_transaction_ref,
        )? {
            return Ok(existing);
        }
    }

    let card = state
        .get_virtual_card_by_provider_ref(&provider, &provider_card_ref)?
        .ok_or_else(|| {
            CanopyError::NotFound(format!(
                "Virtual card for provider ref '{}' not found",
                provider_card_ref
            ))
        })?;
    ensure_payment_access(&state, &app_state, &card.agent_id)?;
    reconcile_payment_state(&state, Some(&card.agent_id))?;

    let card = state
        .get_virtual_card_by_provider_ref(&provider, &provider_card_ref)?
        .ok_or_else(|| {
            CanopyError::NotFound(format!(
                "Virtual card for provider ref '{}' not found",
                provider_card_ref
            ))
        })?;

    record_transaction_for_card(
        &app_handle,
        &state,
        &card,
        status,
        source,
        decline_reason,
        provider_transaction_ref,
        merchant,
        Some(amount_cents),
    )
}

async fn issue_card_for_provider(
    provider: CardProvider,
    agent_id: &str,
    request: &PurchaseRequest,
) -> Result<IssuedCard> {
    match provider {
        CardProvider::Mock => issue_mock_card(agent_id, request),
        CardProvider::Privacy => issue_privacy_card(agent_id, request).await,
        CardProvider::LithicSandbox => issue_lithic_sandbox_card(agent_id, request).await,
    }
}

fn issue_development_provider_card_record(
    provider: VirtualCardProviderKind,
    agent_id: &str,
    request: &PurchaseRequest,
) -> Result<IssuedCard> {
    let prefix = development_provider_prefix(&provider).ok_or_else(|| {
        CanopyError::Validation(
            "Use the standard mock provider flow for local mock card issuance.".to_string(),
        )
    })?;
    let last_four = format!("{:0>4}", request.amount_cents % 10_000);
    let provider_label = match provider {
        VirtualCardProviderKind::Privacy => "Privacy.com",
        VirtualCardProviderKind::LithicSandbox => "Lithic Sandbox",
        VirtualCardProviderKind::Mock => "Mock",
    };

    Ok(IssuedCard {
        provider,
        provider_card_ref: format!("{}{}", prefix, Uuid::new_v4()),
        last_four: last_four.clone(),
        amount_cents: request.amount_cents,
        merchant: request.merchant.clone(),
        memo: format!(
            "Development {} test card for {} / {} / {}",
            provider_label, agent_id, request.merchant, request.category
        ),
        expires_at: Some(Utc::now() + Duration::hours(2)),
        message: format!(
            "Development {} test card ending in {} issued locally for ${:.2}.",
            provider_label,
            last_four,
            request.amount_cents as f64 / 100.0
        ),
    })
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
    let privacy_key = get_privacy_key()?;
    crate::validators::keys::validate_privacy_key(&privacy_key)?;

    let client = Client::new();
    let buffered_amount = request.amount_cents + (request.amount_cents / 10);
    let payload = PrivacyCreateCardRequest {
        card_type: "SINGLE_USE".to_string(),
        memo: format!(
            "Agent {} purchase - {} / {}",
            agent_id, request.merchant, request.category
        ),
        spend_limit: buffered_amount as u32,
        spend_limit_duration: "TRANSACTION".to_string(),
        state: "OPEN".to_string(),
    };

    let response = client
        .post("https://api.privacy.com/v1/cards")
        .header("Authorization", format!("api-key {}", privacy_key))
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
        amount_cents: request.amount_cents,
        merchant: request.merchant.clone(),
        memo: payload.memo,
        expires_at: Some(Utc::now() + Duration::hours(2)),
        message: format!(
            "Privacy.com virtual card ending in {} issued for ${:.2}.",
            last_four,
            request.amount_cents as f64 / 100.0
        ),
    })
}

fn get_lithic_sandbox_key() -> Result<String> {
    crate::keychain::get_secret("LITHIC_SANDBOX_API_KEY")
        .or_else(|_| crate::keychain::get_secret("LITHIC_API_KEY"))
        .or_else(|_| {
            let env_result = std::env::var("LITHIC_SANDBOX_API_KEY")
                .or_else(|_| std::env::var("LITHIC_API_KEY"));
            if env_result.is_ok() {
                tracing::warn!(
                    "Lithic sandbox API key read from environment variable - consider migrating to keychain"
                );
            }
            env_result.map_err(|_| {
                CanopyError::Configuration(
                    "Lithic sandbox API key not found in keychain or environment".to_string(),
                )
            })
        })
}

fn build_lithic_sandbox_card_request(
    agent_id: &str,
    request: &PurchaseRequest,
) -> LithicSandboxCreateCardRequest {
    LithicSandboxCreateCardRequest {
        card_type: "SINGLE_USE".to_string(),
        memo: format!(
            "Agent {} purchase - {} / {}",
            agent_id, request.merchant, request.category
        ),
        spend_limit: request.amount_cents,
        spend_limit_duration: "TRANSACTION".to_string(),
        state: "OPEN".to_string(),
    }
}

async fn issue_lithic_sandbox_card(agent_id: &str, request: &PurchaseRequest) -> Result<IssuedCard> {
    let lithic_key = get_lithic_sandbox_key()?;
    crate::validators::keys::validate_lithic_sandbox_key(&lithic_key)?;

    let payload = build_lithic_sandbox_card_request(agent_id, request);
    let client = Client::new();
    let response = client
        .post("https://sandbox.lithic.com/v1/cards")
        .header("Accept", "application/json")
        .header("Authorization", lithic_key)
        .header("Content-Type", "application/json")
        .header("Idempotency-Key", Uuid::new_v4().to_string())
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            CanopyError::Request(format!(
                "Lithic sandbox API connection failed: {}",
                error
            ))
        })?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(CanopyError::Request(format!(
            "Lithic sandbox rejected request: {}",
            err_text
        )));
    }

    let card_data: LithicSandboxCardResponse = response.json().await.map_err(|error| {
        CanopyError::Serialization(format!(
            "Failed to parse Lithic sandbox response: {}",
            error
        ))
    })?;

    let last_four = card_data
        .last_four
        .or_else(|| {
            card_data.pan.as_ref().and_then(|pan| {
                let digits: String = pan.chars().filter(|char| char.is_ascii_digit()).collect();
                if digits.len() >= 4 {
                    Some(digits[digits.len() - 4..].to_string())
                } else {
                    None
                }
            })
        })
        .unwrap_or_else(|| "0000".to_string());
    let provider_card_ref = card_data
        .token
        .unwrap_or_else(|| format!("lithic-sandbox-{}", Uuid::new_v4()));

    Ok(IssuedCard {
        provider: VirtualCardProviderKind::LithicSandbox,
        provider_card_ref,
        last_four: last_four.clone(),
        amount_cents: request.amount_cents,
        merchant: request.merchant.clone(),
        memo: payload.memo,
        expires_at: Some(Utc::now() + Duration::hours(2)),
        message: format!(
            "Lithic sandbox virtual card ending in {} issued for ${:.2}.",
            last_four,
            request.amount_cents as f64 / 100.0
        ),
    })
}

async fn cancel_lithic_sandbox_card(card: &VirtualCardRecord) -> Result<()> {
    if is_development_provider_card(card) {
        return Ok(());
    }

    let lithic_key = get_lithic_sandbox_key()?;
    crate::validators::keys::validate_lithic_sandbox_key(&lithic_key)?;

    let payload = LithicSandboxUpdateCardRequest {
        state: "CLOSED".to_string(),
        substatus: "END_USER_REQUEST".to_string(),
    };

    let client = Client::new();
    let response = client
        .patch(format!(
            "https://sandbox.lithic.com/v1/cards/{}",
            card.provider_card_ref
        ))
        .header("Accept", "application/json")
        .header("Authorization", lithic_key)
        .header("Content-Type", "application/json")
        .header("Idempotency-Key", Uuid::new_v4().to_string())
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            CanopyError::Request(format!(
                "Lithic sandbox card cancellation failed: {}",
                error
            ))
        })?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(CanopyError::Request(format!(
            "Lithic sandbox rejected card cancellation: {}",
            err_text
        )));
    }

    Ok(())
}

async fn cancel_privacy_card(card: &VirtualCardRecord) -> Result<()> {
    if is_development_provider_card(card) {
        return Ok(());
    }

    let privacy_key = get_privacy_key()?;
    crate::validators::keys::validate_privacy_key(&privacy_key)?;

    let payload = PrivacyUpdateCardRequest {
        state: "CLOSED".to_string(),
    };

    let client = Client::new();
    let response = client
        .patch(format!(
            "https://api.privacy.com/v1/cards/{}",
            card.provider_card_ref
        ))
        .header("Authorization", format!("api-key {}", privacy_key))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            CanopyError::Request(format!("Privacy.com card cancellation failed: {}", error))
        })?;

    if !response.status().is_success() {
        let err_text = response.text().await.unwrap_or_default();
        return Err(CanopyError::Request(format!(
            "Privacy.com rejected card cancellation: {}",
            err_text
        )));
    }

    Ok(())
}

async fn cancel_card_with_provider(card: &VirtualCardRecord) -> Result<()> {
    match card.provider {
        VirtualCardProviderKind::Mock => Ok(()),
        VirtualCardProviderKind::LithicSandbox => cancel_lithic_sandbox_card(card).await,
        VirtualCardProviderKind::Privacy => cancel_privacy_card(card).await,
    }
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

fn persist_issued_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    db: &Database,
    request: &PurchaseRequest,
    purchase_record: &mut PurchaseRecord,
    issued: IssuedCard,
) -> Result<(VirtualCardRecord, String)> {
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

async fn finalize_approved_purchase<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    db: &Database,
    request: &PurchaseRequest,
    purchase_record: &mut PurchaseRecord,
) -> Result<(VirtualCardRecord, String)> {
    let provider = selected_provider()?;
    let issued = issue_card_for_provider(provider, &request.agent_id, request).await?;
    persist_issued_card(app, db, request, purchase_record, issued)
}

async fn request_purchase_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
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
    reconcile_payment_state(&state, Some(&request.agent_id))?;
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

async fn approve_purchase_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    approval_id: String,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PurchaseExecutionResult> {
    let approval = state
        .get_payment_approval_request(&approval_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Approval '{}' not found", approval_id)))?;
    ensure_payment_access(&state, &app_state, &approval.agent_id)?;
    reconcile_payment_state(&state, Some(&approval.agent_id))?;
    let mut approval = state
        .get_payment_approval_request(&approval_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Approval '{}' not found", approval_id)))?;

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

fn deny_purchase_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    approval_id: String,
    reason: Option<String>,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PurchaseExecutionResult> {
    let approval = state
        .get_payment_approval_request(&approval_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Approval '{}' not found", approval_id)))?;
    ensure_payment_access(&state, &app_state, &approval.agent_id)?;
    reconcile_payment_state(&state, Some(&approval.agent_id))?;
    let mut approval = state
        .get_payment_approval_request(&approval_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Approval '{}' not found", approval_id)))?;

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
    request_purchase_inner(app_handle, request, state, app_state).await
}

#[tauri::command]
pub async fn approve_purchase(
    app_handle: AppHandle,
    approval_id: String,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PurchaseExecutionResult> {
    approve_purchase_inner(app_handle, approval_id, state, app_state).await
}

#[tauri::command]
pub fn deny_purchase(
    app_handle: AppHandle,
    approval_id: String,
    reason: Option<String>,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PurchaseExecutionResult> {
    deny_purchase_inner(app_handle, approval_id, reason, state, app_state)
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
    reconcile_payment_state(&state, agent_id.as_deref())?;
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
    reconcile_payment_state(&state, Some(&agent_id))?;
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
    reconcile_payment_state(&state, Some(&agent_id))?;
    Ok(PaymentDashboard {
        agent_id: agent_id.clone(),
        budget: state
            .get_budget(&agent_id)?
            .unwrap_or_else(|| default_budget_config(&agent_id)),
        pending_approvals: state.list_payment_approval_requests(Some(&agent_id), true)?,
        recent_purchases: state.get_purchase_history(&agent_id, 100)?,
        active_virtual_cards: state.list_virtual_cards(&agent_id, true)?,
        recent_transactions: state.list_payment_transactions(&agent_id, 100)?,
        recent_audit_entries: state.list_payment_audit_entries(&agent_id, 100)?,
    })
}

#[tauri::command]
pub async fn get_payment_provider_config(
    webhook_state: State<'_, Arc<PaymentWebhookListenerState>>,
) -> Result<PaymentProviderConfig> {
    let runtime = webhook_state.snapshot().await;
    current_payment_provider_config(&runtime)
}

#[tauri::command]
pub async fn configure_payment_provider(
    update: PaymentProviderUpdate,
    webhook_state: State<'_, Arc<PaymentWebhookListenerState>>,
) -> Result<PaymentProviderConfig> {
    let runtime = webhook_state.snapshot().await;
    apply_payment_provider_update(update, &runtime)
}

async fn cancel_virtual_card_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    card_id: String,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<VirtualCardRecord> {
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check(&app_state.user_id)?;

    let card = state
        .get_virtual_card(&card_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Virtual card '{}' not found", card_id)))?;
    ensure_payment_access(&state, &app_state, &card.agent_id)?;
    reconcile_payment_state(&state, Some(&card.agent_id))?;

    let mut card = state
        .get_virtual_card(&card_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Virtual card '{}' not found", card_id)))?;

    if card.status != VirtualCardStatus::Active {
        return Err(CanopyError::Validation(format!(
            "Virtual card '{}' is not active",
            card_id
        )));
    }

    cancel_card_with_provider(&card).await?;
    card.status = VirtualCardStatus::Cancelled;
    state.update_virtual_card(&card)?;

    record_payment_audit(
        &state,
        &card.agent_id,
        "virtual_card_cancelled",
        json!({
            "cardId": card.id,
            "purchaseRecordId": card.purchase_record_id,
            "provider": provider_kind_to_storage_value(&card.provider),
        }),
    )?;
    emit_payment_state_changed(&app_handle, &card.agent_id, "card_cancelled");

    Ok(card)
}

#[tauri::command]
pub async fn cancel_virtual_card(
    app_handle: AppHandle,
    card_id: String,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<VirtualCardRecord> {
    cancel_virtual_card_inner(app_handle, card_id, state, app_state).await
}

async fn simulate_virtual_card_charge_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    card_id: String,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PaymentTransactionRecord> {
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check(&app_state.user_id)?;

    let card = state
        .get_virtual_card(&card_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Virtual card '{}' not found", card_id)))?;
    ensure_payment_access(&state, &app_state, &card.agent_id)?;
    reconcile_payment_state(&state, Some(&card.agent_id))?;

    let mut card = state
        .get_virtual_card(&card_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Virtual card '{}' not found", card_id)))?;

    if card.status != VirtualCardStatus::Active {
        return Err(CanopyError::Validation(format!(
            "Virtual card '{}' is not active",
            card_id
        )));
    }

    match card.provider {
        VirtualCardProviderKind::Mock => {}
        VirtualCardProviderKind::LithicSandbox => {
            return Err(CanopyError::Validation(
                "Lithic sandbox charge simulation must be run against Lithic's official simulate authorization and clearing endpoints outside Canopy because the app does not persist full PAN data.".to_string(),
            ));
        }
        VirtualCardProviderKind::Privacy => {
            return Err(CanopyError::Validation(
                "Privacy.com does not currently support in-app simulated card use from Canopy."
                    .to_string(),
            ));
        }
    }

    record_transaction_for_card(
        &app_handle,
        &state,
        &card,
        PaymentTransactionStatus::Captured,
        "mock_simulated_charge",
        None,
        None,
        None,
        None,
    )
}

#[tauri::command]
pub async fn simulate_virtual_card_charge(
    app_handle: AppHandle,
    card_id: String,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<PaymentTransactionRecord> {
    simulate_virtual_card_charge_inner(app_handle, card_id, state, app_state).await
}

async fn simulate_virtual_card_decline_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    card_id: String,
    state: State<'_, Database>,
    app_state: State<'_, AppState>,
) -> Result<PaymentTransactionRecord> {
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check(&app_state.user_id)?;

    let card = state
        .get_virtual_card(&card_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Virtual card '{}' not found", card_id)))?;
    ensure_payment_access(&state, &app_state, &card.agent_id)?;
    reconcile_payment_state(&state, Some(&card.agent_id))?;

    let card = state
        .get_virtual_card(&card_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Virtual card '{}' not found", card_id)))?;

    if card.status != VirtualCardStatus::Active {
        return Err(CanopyError::Validation(format!(
            "Virtual card '{}' is not active",
            card_id
        )));
    }

    match card.provider {
        VirtualCardProviderKind::Mock => {}
        VirtualCardProviderKind::LithicSandbox => {
            return Err(CanopyError::Validation(
                "Lithic sandbox decline simulation must be run through Lithic's official sandbox tooling outside Canopy.".to_string(),
            ));
        }
        VirtualCardProviderKind::Privacy => {
            return Err(CanopyError::Validation(
                "Privacy.com does not currently support in-app simulated declines from Canopy."
                    .to_string(),
            ));
        }
    }

    record_transaction_for_card(
        &app_handle,
        &state,
        &card,
        PaymentTransactionStatus::Declined,
        "mock_simulated_decline",
        Some("Mock provider simulated decline".to_string()),
        None,
        None,
        None,
    )
}

#[tauri::command]
pub async fn simulate_virtual_card_decline(
    app_handle: AppHandle,
    card_id: String,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<PaymentTransactionRecord> {
    simulate_virtual_card_decline_inner(app_handle, card_id, state, app_state).await
}

async fn handle_privacy_transaction_event_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    event: serde_json::Value,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<PaymentTransactionRecord> {
    let payload: PrivacyTransactionEventPayload = serde_json::from_value(event).map_err(|error| {
        CanopyError::Serialization(format!(
            "Invalid Privacy.com transaction event payload: {}",
            error
        ))
    })?;

    let source = payload
        .event_type
        .clone()
        .unwrap_or_else(|| "privacy_event".to_string());
    let merchant = payload.merchant.and_then(|details| details.name.or(details.descriptor));
    let provider_transaction_ref = payload
        .transaction_token
        .clone()
        .or_else(|| Some(payload.token.clone()));
    let decline_reason = payload
        .decline_reason
        .clone()
        .or_else(|| match parse_provider_transaction_status(&payload.status) {
            PaymentTransactionStatus::Declined => payload.result.clone(),
            _ => None,
        });

    record_provider_transaction_event_inner(
        app_handle,
        VirtualCardProviderKind::Privacy,
        payload.token,
        provider_transaction_ref,
        merchant,
        payload.amount,
        parse_provider_transaction_status(&payload.status),
        decline_reason,
        &source,
        state,
        app_state,
    )
    .await
}

#[tauri::command]
pub async fn handle_privacy_transaction_event(
    app_handle: AppHandle,
    event: serde_json::Value,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<PaymentTransactionRecord> {
    handle_privacy_transaction_event_inner(app_handle, event, app_state, state).await
}

async fn handle_lithic_transaction_event_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    event: serde_json::Value,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<PaymentTransactionRecord> {
    let payload: LithicTransactionEventPayload = serde_json::from_value(event).map_err(|error| {
        CanopyError::Serialization(format!(
            "Invalid Lithic transaction event payload: {}",
            error
        ))
    })?;

    let merchant = payload.merchant.and_then(|details| details.name.or(details.descriptor));
    let provider_transaction_ref = payload
        .transaction_token
        .clone()
        .or(payload.token.clone())
        .or_else(|| Some(payload.card_token.clone()));
    let decline_reason = payload
        .decline_reason
        .clone()
        .or_else(|| match parse_provider_transaction_status(&payload.status) {
            PaymentTransactionStatus::Declined => payload.result.clone(),
            _ => None,
        });
    let source = payload
        .event_type
        .clone()
        .unwrap_or_else(|| "lithic_event".to_string());

    record_provider_transaction_event_inner(
        app_handle,
        VirtualCardProviderKind::LithicSandbox,
        payload.card_token,
        provider_transaction_ref,
        merchant,
        payload.amount,
        parse_provider_transaction_status(&payload.status),
        decline_reason,
        &source,
        state,
        app_state,
    )
    .await
}

#[tauri::command]
pub async fn handle_lithic_transaction_event(
    app_handle: AppHandle,
    event: serde_json::Value,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<PaymentTransactionRecord> {
    handle_lithic_transaction_event_inner(app_handle, event, app_state, state).await
}

async fn simulate_provider_transaction_event_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    card_id: String,
    outcome: ProviderSimulationOutcome,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<PaymentTransactionRecord> {
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check(&app_state.user_id)?;

    let card = state
        .get_virtual_card(&card_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Virtual card '{}' not found", card_id)))?;
    ensure_payment_access(&state, &app_state, &card.agent_id)?;
    reconcile_payment_state(&state, Some(&card.agent_id))?;

    let card = state
        .get_virtual_card(&card_id)?
        .ok_or_else(|| CanopyError::NotFound(format!("Virtual card '{}' not found", card_id)))?;

    if card.status != VirtualCardStatus::Active {
        return Err(CanopyError::Validation(format!(
            "Virtual card '{}' is not active",
            card_id
        )));
    }

    match card.provider {
        VirtualCardProviderKind::Mock => Err(CanopyError::Validation(
            "Mock cards already have dedicated Simulate Use and Simulate Decline controls."
                .to_string(),
        )),
        VirtualCardProviderKind::Privacy => {
            let event_type = match outcome {
                ProviderSimulationOutcome::Captured => "privacy_simulated_capture",
                ProviderSimulationOutcome::Declined => "privacy_simulated_decline",
            };
            let status = match outcome {
                ProviderSimulationOutcome::Captured => "CAPTURED",
                ProviderSimulationOutcome::Declined => "DECLINED",
            };
            let decline_reason = match outcome {
                ProviderSimulationOutcome::Captured => None,
                ProviderSimulationOutcome::Declined => Some("simulated_decline".to_string()),
            };
            let result = match outcome {
                ProviderSimulationOutcome::Captured => None,
                ProviderSimulationOutcome::Declined => Some("simulated_decline".to_string()),
            };
            handle_privacy_transaction_event_inner(
                app_handle,
                json!({
                    "token": card.provider_card_ref,
                    "transaction_token": format!("privacy-sim-{}", Uuid::new_v4()),
                    "amount": card.amount_cents,
                    "status": status,
                    "decline_reason": decline_reason,
                    "result": result,
                    "merchant": { "name": card.merchant },
                    "event_type": event_type
                }),
                app_state,
                state,
            )
            .await
        }
        VirtualCardProviderKind::LithicSandbox => {
            let event_type = match outcome {
                ProviderSimulationOutcome::Captured => "lithic_simulated_capture",
                ProviderSimulationOutcome::Declined => "lithic_simulated_decline",
            };
            let status = match outcome {
                ProviderSimulationOutcome::Captured => "CLEARED",
                ProviderSimulationOutcome::Declined => "DECLINED",
            };
            let decline_reason = match outcome {
                ProviderSimulationOutcome::Captured => None,
                ProviderSimulationOutcome::Declined => Some("simulated_decline".to_string()),
            };
            let result = match outcome {
                ProviderSimulationOutcome::Captured => None,
                ProviderSimulationOutcome::Declined => Some("simulated_decline".to_string()),
            };
            handle_lithic_transaction_event_inner(
                app_handle,
                json!({
                    "card_token": card.provider_card_ref,
                    "token": format!("lithic-sim-{}", Uuid::new_v4()),
                    "amount": card.amount_cents,
                    "status": status,
                    "decline_reason": decline_reason,
                    "result": result,
                    "merchant": { "descriptor": card.merchant },
                    "event_type": event_type
                }),
                app_state,
                state,
            )
            .await
        }
    }
}

#[tauri::command]
pub async fn simulate_provider_transaction_event(
    app_handle: AppHandle,
    card_id: String,
    outcome: ProviderSimulationOutcome,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<PaymentTransactionRecord> {
    simulate_provider_transaction_event_inner(app_handle, card_id, outcome, app_state, state)
        .await
}

async fn issue_development_provider_card_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    agent_id: String,
    amount_cents: u64,
    category: String,
    merchant: Option<String>,
    provider: VirtualCardProviderKind,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<String> {
    #[cfg(not(test))]
    crate::rate_limiter::limiters::PAYMENT_EVAL_LIMITER.check(&app_state.user_id)?;

    if !app_state.dev_mode {
        return Err(CanopyError::Unauthorized(
            "Development provider cards are only available in development builds.".to_string(),
        ));
    }

    if matches!(provider, VirtualCardProviderKind::Mock) {
        return Err(CanopyError::Validation(
            "Use the standard mock provider flow for fully local mock cards.".to_string(),
        ));
    }

    ensure_payment_access(&state, &app_state, &agent_id)?;
    crate::validators::budget::validate_amount(amount_cents as i64)?;
    crate::validators::budget::validate_category(&category)?;
    let merchant = merchant.unwrap_or_else(|| "development-provider-issue".to_string());
    validate_merchant_pattern(&merchant)?;

    let request = PurchaseRequest {
        agent_id: agent_id.clone(),
        description: "Development provider virtual card issuance".to_string(),
        merchant,
        amount_cents,
        category,
        is_recurring: false,
    };
    let mut purchase_record = build_purchase_record(
        Uuid::new_v4().to_string(),
        &request,
        PurchaseDecision::Approved,
        Utc::now(),
    );
    state.record_purchase(&purchase_record)?;

    let issued = issue_development_provider_card_record(provider, &agent_id, &request)?;
    let (_virtual_card, message) =
        persist_issued_card(&app_handle, &state, &request, &mut purchase_record, issued)?;
    Ok(message)
}

#[tauri::command]
pub async fn issue_development_provider_card(
    app_handle: AppHandle,
    agent_id: String,
    amount_cents: u64,
    category: String,
    merchant: Option<String>,
    provider: VirtualCardProviderKind,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<String> {
    issue_development_provider_card_inner(
        app_handle,
        agent_id,
        amount_cents,
        category,
        merchant,
        provider,
        app_state,
        state,
    )
    .await
}

async fn issue_virtual_card_inner<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
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
    let mut purchase_record = build_purchase_record(
        Uuid::new_v4().to_string(),
        &request,
        PurchaseDecision::Approved,
        Utc::now(),
    );
    state.record_purchase(&purchase_record)?;

    let (_virtual_card, message) =
        finalize_approved_purchase(&app_handle, &state, &request, &mut purchase_record).await?;
    Ok(message)
}

#[tauri::command]
pub async fn issue_virtual_card(
    app_handle: AppHandle,
    agent_id: String,
    amount_cents: u64,
    category: String,
    merchant: Option<String>,
    app_state: State<'_, AppState>,
    state: State<'_, Database>,
) -> Result<String> {
    issue_virtual_card_inner(
        app_handle,
        agent_id,
        amount_cents,
        category,
        merchant,
        app_state,
        state,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::AppState;
    use crate::models::{AgentCapabilities, AgentPersonality, AgentStats, AgentStatus};
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use tauri::Manager;
    use tokio::time::{sleep, Duration as TokioDuration, Instant};

    static PAYMENT_PROVIDER_TEST_GUARD: OnceLock<Mutex<()>> = OnceLock::new();

    fn payment_provider_test_guard() -> MutexGuard<'static, ()> {
        PAYMENT_PROVIDER_TEST_GUARD
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn backup_secret(key: &str) -> Option<String> {
        read_config_secret(key)
    }

    fn restore_secret(key: &str, value: Option<String>) {
        if let Some(value) = value {
            let _ = store_config_secret(key, &value);
        } else {
            let _ = delete_config_secret(key);
        }
    }

    fn backup_env(key: &str) -> Option<String> {
        std::env::var(key).ok()
    }

    fn restore_env(key: &str, value: Option<String>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }

    fn test_webhook_runtime() -> PaymentWebhookListenerRuntime {
        PaymentWebhookListenerRuntime {
            listening: true,
            base_url: Some("http://127.0.0.1:18080".to_string()),
            last_error: None,
        }
    }

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

    fn test_agent(agent_id: &str, payments: bool, spend_auto: bool) -> Agent {
        let mut capabilities = AgentCapabilities::default();
        capabilities.payments = payments;
        capabilities.spend_auto = spend_auto;

        Agent {
            id: agent_id.to_string(),
            name: format!("Agent {}", agent_id),
            role: "assistant".to_string(),
            emoji: "bot".to_string(),
            color: "#34D399".to_string(),
            status: AgentStatus::Active,
            isolated: false,
            paused: false,
            container_id: None,
            personality: AgentPersonality {
                name: format!("Agent {}", agent_id),
                communication_style: "helpful".to_string(),
                expertise: vec!["payments".to_string()],
                guardrails: vec![],
                custom_instructions: "Payment test agent".to_string(),
                active_model: Some("anthropic/claude-sonnet-4-6".to_string()),
                soul_template: None,
                identity_template: None,
            },
            capabilities,
            integrations: vec![],
            visual_identity: None,
            memories: vec![],
            created_at: Utc::now(),
            stats: AgentStats::default(),
        }
    }

    async fn wait_for_listener_base_url(
        state: &Arc<PaymentWebhookListenerState>,
    ) -> Result<String> {
        let deadline = Instant::now() + TokioDuration::from_secs(5);
        loop {
            let runtime = state.snapshot().await;
            if runtime.listening {
                if let Some(base_url) = runtime.base_url {
                    return Ok(base_url);
                }
            }
            if Instant::now() >= deadline {
                return Err(CanopyError::Timeout);
            }
            sleep(TokioDuration::from_millis(25)).await;
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

    #[test]
    fn selected_provider_maps_lithic_sandbox() {
        assert!(matches!(
            selected_provider_from("lithic_sandbox").unwrap(),
            CardProvider::LithicSandbox
        ));
        assert!(matches!(
            selected_provider_from("lithic").unwrap(),
            CardProvider::LithicSandbox
        ));
        assert!(selected_provider_from("unknown-provider").is_err());
    }

    #[test]
    fn payment_provider_config_defaults_to_mock_when_unset() {
        let _guard = payment_provider_test_guard();
        let stored_provider = backup_secret(PAYMENT_PROVIDER_SLOT);
        let stored_privacy = backup_secret("PRIVACY_API_KEY");
        let stored_lithic = backup_secret("LITHIC_SANDBOX_API_KEY");
        let stored_lithic_webhook_secret = backup_secret(LITHIC_WEBHOOK_SECRET_SLOT);
        let persisted_provider_env = backup_env(PAYMENT_PROVIDER_SLOT);
        let env_provider = backup_env("CANOPY_PAYMENT_PROVIDER");
        let env_privacy = backup_env("PRIVACY_API_KEY");
        let env_lithic = backup_env("LITHIC_SANDBOX_API_KEY");
        let env_lithic_webhook_secret = backup_env(LITHIC_WEBHOOK_SECRET_SLOT);

        let _ = delete_config_secret(PAYMENT_PROVIDER_SLOT);
        let _ = delete_config_secret("PRIVACY_API_KEY");
        let _ = delete_config_secret("LITHIC_SANDBOX_API_KEY");
        let _ = delete_config_secret(LITHIC_WEBHOOK_SECRET_SLOT);
        std::env::remove_var(PAYMENT_PROVIDER_SLOT);
        std::env::remove_var("CANOPY_PAYMENT_PROVIDER");
        std::env::remove_var("PRIVACY_API_KEY");
        std::env::remove_var("LITHIC_SANDBOX_API_KEY");
        std::env::remove_var(LITHIC_WEBHOOK_SECRET_SLOT);

        let config = current_payment_provider_config(&test_webhook_runtime()).unwrap();
        assert_eq!(config.provider, VirtualCardProviderKind::Mock);
        assert!(!config.privacy_configured);
        assert!(!config.lithic_sandbox_configured);
        assert!(!config.lithic_webhook_secret_configured);
        assert!(config.active_provider_ready);
        assert!(!config.using_env_fallback);
        assert_eq!(
            config.privacy_webhook_url.as_deref(),
            Some("http://127.0.0.1:18080/payment-webhooks/privacy")
        );

        restore_secret(PAYMENT_PROVIDER_SLOT, stored_provider);
        restore_secret("PRIVACY_API_KEY", stored_privacy);
        restore_secret("LITHIC_SANDBOX_API_KEY", stored_lithic);
        restore_secret(LITHIC_WEBHOOK_SECRET_SLOT, stored_lithic_webhook_secret);
        restore_env(PAYMENT_PROVIDER_SLOT, persisted_provider_env);
        restore_env("CANOPY_PAYMENT_PROVIDER", env_provider);
        restore_env("PRIVACY_API_KEY", env_privacy);
        restore_env("LITHIC_SANDBOX_API_KEY", env_lithic);
        restore_env(LITHIC_WEBHOOK_SECRET_SLOT, env_lithic_webhook_secret);
    }

    #[test]
    fn configure_payment_provider_persists_lithic_sandbox_selection() {
        let _guard = payment_provider_test_guard();
        let stored_provider = backup_secret(PAYMENT_PROVIDER_SLOT);
        let stored_lithic = backup_secret("LITHIC_SANDBOX_API_KEY");
        let stored_lithic_webhook_secret = backup_secret(LITHIC_WEBHOOK_SECRET_SLOT);
        let persisted_provider_env = backup_env(PAYMENT_PROVIDER_SLOT);
        let env_provider = backup_env("CANOPY_PAYMENT_PROVIDER");
        let env_lithic = backup_env("LITHIC_SANDBOX_API_KEY");
        let env_lithic_webhook_secret = backup_env(LITHIC_WEBHOOK_SECRET_SLOT);

        let _ = delete_config_secret(PAYMENT_PROVIDER_SLOT);
        let _ = delete_config_secret("LITHIC_SANDBOX_API_KEY");
        let _ = delete_config_secret(LITHIC_WEBHOOK_SECRET_SLOT);
        std::env::remove_var(PAYMENT_PROVIDER_SLOT);
        std::env::remove_var("CANOPY_PAYMENT_PROVIDER");
        std::env::remove_var("LITHIC_SANDBOX_API_KEY");
        std::env::remove_var(LITHIC_WEBHOOK_SECRET_SLOT);

        let config = apply_payment_provider_update(PaymentProviderUpdate {
            provider: VirtualCardProviderKind::LithicSandbox,
            privacy_api_key: None,
            lithic_sandbox_api_key: Some("a".repeat(20)),
            lithic_webhook_secret: Some("whsec_abcdefghijklmnopqrstuvwxyz".to_string()),
            clear_privacy_api_key: false,
            clear_lithic_sandbox_api_key: false,
            clear_lithic_webhook_secret: false,
        }, &test_webhook_runtime())
        .unwrap();

        assert_eq!(config.provider, VirtualCardProviderKind::LithicSandbox);
        assert!(config.lithic_sandbox_configured);
        assert!(config.lithic_webhook_secret_configured);
        assert!(config.active_provider_ready);
        assert!(!config.using_env_fallback);
        assert!(matches!(selected_provider().unwrap(), CardProvider::LithicSandbox));

        restore_secret(PAYMENT_PROVIDER_SLOT, stored_provider);
        restore_secret("LITHIC_SANDBOX_API_KEY", stored_lithic);
        restore_secret(LITHIC_WEBHOOK_SECRET_SLOT, stored_lithic_webhook_secret);
        restore_env(PAYMENT_PROVIDER_SLOT, persisted_provider_env);
        restore_env("CANOPY_PAYMENT_PROVIDER", env_provider);
        restore_env("LITHIC_SANDBOX_API_KEY", env_lithic);
        restore_env(LITHIC_WEBHOOK_SECRET_SLOT, env_lithic_webhook_secret);
    }

    #[test]
    fn privacy_webhook_signature_verification_uses_canonical_sorted_json() {
        let _guard = payment_provider_test_guard();
        let stored_privacy = backup_secret("PRIVACY_API_KEY");
        let env_privacy = backup_env("PRIVACY_API_KEY");
        let _ = delete_config_secret("PRIVACY_API_KEY");
        std::env::remove_var("PRIVACY_API_KEY");
        std::env::set_var("PRIVACY_API_KEY", "privacy_test_key_abcdefghijklmnopqrstuvwxyz");

        let body = br#"{"status":"SETTLED","amount":1500,"token":"privacy-card-1"}"#;
        let payload: Value = serde_json::from_slice(body).unwrap();
        let canonical = canonical_json_string(&payload).unwrap();
        let signature =
            calculate_hmac_base64(b"privacy_test_key_abcdefghijklmnopqrstuvwxyz", canonical.as_bytes())
                .unwrap();
        let headers = std::collections::HashMap::from([(
            "x-privacy-hmac".to_string(),
            signature,
        )]);

        let verified = verify_privacy_webhook_request(&headers, body).unwrap();
        assert_eq!(verified["token"], "privacy-card-1");

        restore_secret("PRIVACY_API_KEY", stored_privacy);
        restore_env("PRIVACY_API_KEY", env_privacy);
    }

    #[tokio::test]
    async fn repeated_provider_event_returns_existing_transaction_without_duplicates() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-idempotent-event-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();
        db_state
            .record_purchase(&PurchaseRecord {
                id: "purchase-idempotent-event".to_string(),
                agent_id: agent_id.to_string(),
                description: "Issued card".to_string(),
                merchant: "Figma".to_string(),
                amount_cents: 5_000,
                category: "software".to_string(),
                decision: PurchaseDecision::Approved,
                virtual_card_id: Some("card-idempotent-event".to_string()),
                timestamp: Utc::now(),
            })
            .unwrap();
        db_state
            .record_virtual_card(&VirtualCardRecord {
                id: "card-idempotent-event".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: "purchase-idempotent-event".to_string(),
                provider: VirtualCardProviderKind::Privacy,
                provider_card_ref: "privacy-idempotent-ref".to_string(),
                last_four: "5000".to_string(),
                amount_cents: 5_000,
                merchant: "Figma".to_string(),
                memo: "Idempotent event card".to_string(),
                status: VirtualCardStatus::Active,
                created_at: Utc::now(),
                expires_at: Some(Utc::now() + Duration::hours(2)),
            })
            .unwrap();

        let first = handle_privacy_transaction_event_inner(
            app.handle().clone(),
            json!({
                "token": "privacy-idempotent-ref",
                "transaction_token": "privacy-idempotent-txn",
                "amount": 5000,
                "status": "SETTLED",
                "merchant": { "descriptor": "Figma" }
            }),
            app_state.clone(),
            db_state.clone(),
        )
        .await
        .unwrap();

        let second = handle_privacy_transaction_event_inner(
            app.handle().clone(),
            json!({
                "token": "privacy-idempotent-ref",
                "transaction_token": "privacy-idempotent-txn",
                "amount": 5000,
                "status": "SETTLED",
                "merchant": { "descriptor": "Figma" }
            }),
            app_state,
            db_state.clone(),
        )
        .await
        .unwrap();

        assert_eq!(first.id, second.id);
        let transactions = db_state.list_payment_transactions(agent_id, 10).unwrap();
        assert_eq!(transactions.len(), 1);
    }

    #[test]
    fn lithic_sandbox_request_uses_single_use_transaction_limit() {
        let request = purchase_request("agent-1", 4_900, "cleaning_supplies");
        let payload = build_lithic_sandbox_card_request("agent-1", &request);
        assert_eq!(payload.card_type, "SINGLE_USE");
        assert_eq!(payload.spend_limit, 4_900);
        assert_eq!(payload.spend_limit_duration, "TRANSACTION");
        assert_eq!(payload.state, "OPEN");
        assert!(payload.memo.contains("Amazon"));
    }

    #[tokio::test]
    async fn request_purchase_auto_approval_issues_card_and_updates_spend() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-auto-approve-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();

        let mut budget = default_budget(agent_id);
        budget.require_approval_new_merchant = false;
        budget.require_approval_recurring = false;
        db_state.upsert_budget(&budget).unwrap();

        let mut request = purchase_request(agent_id, 2_400, "cleaning_supplies");
        request.merchant = "Staples".to_string();

        let result = request_purchase_inner(
            app.handle().clone(),
            request.clone(),
            db_state.clone(),
            app_state.clone(),
        )
        .await
        .unwrap();

        assert!(matches!(result.decision, PurchaseDecision::Approved));
        assert!(result.approval_request.is_none());
        let virtual_card = result
            .virtual_card
            .expect("approved purchases should issue a virtual card");
        assert_eq!(virtual_card.provider, VirtualCardProviderKind::Mock);
        assert_eq!(virtual_card.amount_cents, request.amount_cents);
        assert_eq!(
            result.purchase_record.virtual_card_id.as_deref(),
            Some(virtual_card.id.as_str())
        );

        let stored_budget = db_state.get_budget(agent_id).unwrap().unwrap();
        assert_eq!(stored_budget.daily_spent_cents, request.amount_cents);
        assert_eq!(stored_budget.monthly_spent_cents, request.amount_cents);

        let stored_cards = db_state.list_virtual_cards(agent_id, true).unwrap();
        assert_eq!(stored_cards.len(), 1);
        assert_eq!(stored_cards[0].id, virtual_card.id);

        let history = db_state.get_purchase_history(agent_id, 10).unwrap();
        assert_eq!(history.len(), 1);
        assert!(matches!(history[0].decision, PurchaseDecision::Approved));
    }

    #[tokio::test]
    async fn request_purchase_pending_approval_can_be_approved_and_finalized() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-review-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();

        let mut budget = default_budget(agent_id);
        budget.require_approval_new_merchant = false;
        budget.require_approval_recurring = false;
        db_state.upsert_budget(&budget).unwrap();

        let mut request = purchase_request(agent_id, 9_500, "cleaning_supplies");
        request.merchant = "Figma".to_string();

        let initial = request_purchase_inner(
            app.handle().clone(),
            request.clone(),
            db_state.clone(),
            app_state.clone(),
        )
        .await
        .unwrap();

        let approval = initial
            .approval_request
            .clone()
            .expect("over-threshold purchase should create approval");
        assert!(matches!(
            initial.decision,
            PurchaseDecision::RequiresUserApproval { .. }
        ));
        assert!(initial.virtual_card.is_none());

        let before_budget = db_state.get_budget(agent_id).unwrap().unwrap();
        assert_eq!(before_budget.daily_spent_cents, 0);
        assert_eq!(before_budget.monthly_spent_cents, 0);

        let approved = approve_purchase_inner(
            app.handle().clone(),
            approval.id.clone(),
            db_state.clone(),
            app_state.clone(),
        )
        .await
        .unwrap();

        assert!(matches!(approved.decision, PurchaseDecision::Approved));
        assert_eq!(
            approved.approval_request.unwrap().status,
            PurchaseApprovalStatus::Approved
        );
        assert!(approved.virtual_card.is_some());

        let after_budget = db_state.get_budget(agent_id).unwrap().unwrap();
        assert_eq!(after_budget.daily_spent_cents, request.amount_cents);
        assert_eq!(after_budget.monthly_spent_cents, request.amount_cents);

        let pending =
            list_pending_purchase_approvals(Some(agent_id.to_string()), db_state.clone(), app_state)
                .unwrap();
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn pending_purchase_can_be_denied_without_spend_or_card() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-deny-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();

        let mut budget = default_budget(agent_id);
        budget.require_approval_new_merchant = false;
        budget.require_approval_recurring = false;
        db_state.upsert_budget(&budget).unwrap();

        let request = purchase_request(agent_id, 7_500, "cleaning_supplies");
        let initial = request_purchase_inner(
            app.handle().clone(),
            request.clone(),
            db_state.clone(),
            app_state.clone(),
        )
        .await
        .unwrap();

        let approval = initial
            .approval_request
            .expect("thresholded purchase should create approval");
        let denied = deny_purchase_inner(
            app.handle().clone(),
            approval.id,
            Some("User rejected".to_string()),
            db_state.clone(),
            app_state.clone(),
        )
        .unwrap();

        match denied.decision {
            PurchaseDecision::Denied { reasons, .. } => {
                assert!(reasons.iter().any(|reason| reason == "User rejected"));
            }
            other => panic!("Expected denied purchase, got {:?}", other),
        }
        assert_eq!(
            denied.approval_request.unwrap().status,
            PurchaseApprovalStatus::Denied
        );
        assert!(denied.virtual_card.is_none());

        let stored_budget = db_state.get_budget(agent_id).unwrap().unwrap();
        assert_eq!(stored_budget.daily_spent_cents, 0);
        assert_eq!(stored_budget.monthly_spent_cents, 0);
        assert!(db_state.list_virtual_cards(agent_id, true).unwrap().is_empty());
    }

    #[tokio::test]
    async fn request_purchase_rejects_agents_without_payment_capability() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-disabled-agent";

        db_state
            .insert_agent(&test_agent(agent_id, false, false))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();

        let err = request_purchase_inner(
            app.handle().clone(),
            purchase_request(agent_id, 1_500, "cleaning_supplies"),
            db_state,
            app_state,
        )
        .await
        .unwrap_err();

        assert!(matches!(err, CanopyError::Unauthorized(_)));
    }

    #[test]
    fn payment_dashboard_expires_stale_approval_and_card_state() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-expiration-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();

        let approval_purchase_id = "purchase-expired-approval".to_string();
        db_state
            .record_purchase(&PurchaseRecord {
                id: approval_purchase_id.clone(),
                agent_id: agent_id.to_string(),
                description: "Needs approval".to_string(),
                merchant: "Acme".to_string(),
                amount_cents: 9_900,
                category: "cleaning_supplies".to_string(),
                decision: PurchaseDecision::RequiresUserApproval {
                    reason: "Manual review".to_string(),
                    flags: vec!["review".to_string()],
                    approval_id: Some("approval-expired".to_string()),
                },
                virtual_card_id: None,
                timestamp: Utc::now() - Duration::minutes(10),
            })
            .unwrap();
        db_state
            .create_payment_approval_request(&PurchaseApprovalRequest {
                id: "approval-expired".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: approval_purchase_id.clone(),
                purchase_request: purchase_request(agent_id, 9_900, "cleaning_supplies"),
                reason: "Manual review".to_string(),
                flags: vec!["review".to_string()],
                status: PurchaseApprovalStatus::Pending,
                created_at: Utc::now() - Duration::minutes(10),
                resolved_at: None,
                expires_at: Some(Utc::now() - Duration::minutes(1)),
            })
            .unwrap();

        let card_purchase_id = "purchase-expired-card".to_string();
        db_state
            .record_purchase(&PurchaseRecord {
                id: card_purchase_id.clone(),
                agent_id: agent_id.to_string(),
                description: "Issued card".to_string(),
                merchant: "Staples".to_string(),
                amount_cents: 2_400,
                category: "cleaning_supplies".to_string(),
                decision: PurchaseDecision::Approved,
                virtual_card_id: Some("card-expired".to_string()),
                timestamp: Utc::now() - Duration::minutes(20),
            })
            .unwrap();
        db_state
            .record_virtual_card(&VirtualCardRecord {
                id: "card-expired".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: card_purchase_id,
                provider: VirtualCardProviderKind::Mock,
                provider_card_ref: "mock-card-expired".to_string(),
                last_four: "4242".to_string(),
                amount_cents: 2_400,
                merchant: "Staples".to_string(),
                memo: "Expired mock card".to_string(),
                status: VirtualCardStatus::Active,
                created_at: Utc::now() - Duration::minutes(20),
                expires_at: Some(Utc::now() - Duration::minutes(1)),
            })
            .unwrap();

        let dashboard =
            get_payment_dashboard(agent_id.to_string(), db_state.clone(), app_state).unwrap();

        assert!(dashboard.pending_approvals.is_empty());
        assert!(dashboard.active_virtual_cards.is_empty());

        let approval = db_state
            .get_payment_approval_request("approval-expired")
            .unwrap()
            .unwrap();
        assert_eq!(approval.status, PurchaseApprovalStatus::Expired);

        let purchase = db_state
            .get_purchase_record(&approval_purchase_id)
            .unwrap()
            .unwrap();
        match purchase.decision {
            PurchaseDecision::Denied { reasons, flags } => {
                assert!(reasons.iter().any(|reason| reason.contains("expired")));
                assert!(flags.iter().any(|flag| flag == "approval_expired"));
            }
            other => panic!("Expected expired approval purchase to be denied, got {:?}", other),
        }

        let card = db_state.get_virtual_card("card-expired").unwrap().unwrap();
        assert_eq!(card.status, VirtualCardStatus::Expired);
    }

    #[tokio::test]
    async fn cancel_virtual_card_marks_card_cancelled_and_removes_it_from_dashboard() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-cancel-card-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();

        db_state
            .record_purchase(&PurchaseRecord {
                id: "purchase-cancel-card".to_string(),
                agent_id: agent_id.to_string(),
                description: "Issued card".to_string(),
                merchant: "Staples".to_string(),
                amount_cents: 3_300,
                category: "cleaning_supplies".to_string(),
                decision: PurchaseDecision::Approved,
                virtual_card_id: Some("card-cancel".to_string()),
                timestamp: Utc::now(),
            })
            .unwrap();
        db_state
            .record_virtual_card(&VirtualCardRecord {
                id: "card-cancel".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: "purchase-cancel-card".to_string(),
                provider: VirtualCardProviderKind::Mock,
                provider_card_ref: "mock-card-cancel".to_string(),
                last_four: "3300".to_string(),
                amount_cents: 3_300,
                merchant: "Staples".to_string(),
                memo: "Cancelable mock card".to_string(),
                status: VirtualCardStatus::Active,
                created_at: Utc::now(),
                expires_at: Some(Utc::now() + Duration::hours(2)),
            })
            .unwrap();

        let card = cancel_virtual_card_inner(
            app.handle().clone(),
            "card-cancel".to_string(),
            db_state.clone(),
            app_state.clone(),
        )
        .await
        .unwrap();

        assert_eq!(card.status, VirtualCardStatus::Cancelled);
        assert!(db_state.list_virtual_cards(agent_id, true).unwrap().is_empty());

        let dashboard =
            get_payment_dashboard(agent_id.to_string(), db_state.clone(), app_state).unwrap();
        assert!(dashboard.active_virtual_cards.is_empty());
    }

    #[tokio::test]
    async fn simulate_virtual_card_charge_marks_mock_card_consumed() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-sim-card-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();

        db_state
            .record_purchase(&PurchaseRecord {
                id: "purchase-sim-card".to_string(),
                agent_id: agent_id.to_string(),
                description: "Issued card".to_string(),
                merchant: "Staples".to_string(),
                amount_cents: 3_300,
                category: "cleaning_supplies".to_string(),
                decision: PurchaseDecision::Approved,
                virtual_card_id: Some("card-sim".to_string()),
                timestamp: Utc::now(),
            })
            .unwrap();
        db_state
            .record_virtual_card(&VirtualCardRecord {
                id: "card-sim".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: "purchase-sim-card".to_string(),
                provider: VirtualCardProviderKind::Mock,
                provider_card_ref: "mock-card-sim".to_string(),
                last_four: "3300".to_string(),
                amount_cents: 3_300,
                merchant: "Staples".to_string(),
                memo: "Simulatable mock card".to_string(),
                status: VirtualCardStatus::Active,
                created_at: Utc::now(),
                expires_at: Some(Utc::now() + Duration::hours(2)),
            })
            .unwrap();

        let transaction = simulate_virtual_card_charge_inner(
            app.handle().clone(),
            "card-sim".to_string(),
            db_state.clone(),
            app_state.clone(),
        )
        .await
        .unwrap();

        assert_eq!(transaction.status, PaymentTransactionStatus::Captured);
        assert!(db_state.list_virtual_cards(agent_id, true).unwrap().is_empty());
        let transactions = db_state.list_payment_transactions(agent_id, 10).unwrap();
        assert_eq!(transactions.len(), 1);
        assert_eq!(transactions[0].status, PaymentTransactionStatus::Captured);

        let all_cards = get_virtual_cards_for_agent(
            agent_id.to_string(),
            Some(false),
            db_state.clone(),
            app_state,
        )
        .unwrap();
        assert_eq!(all_cards.len(), 1);
        assert_eq!(all_cards[0].status, VirtualCardStatus::Consumed);
    }

    #[tokio::test]
    async fn simulate_virtual_card_decline_reverses_spend_and_marks_purchase_denied() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-sim-decline-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();

        db_state
            .record_purchase(&PurchaseRecord {
                id: "purchase-sim-decline".to_string(),
                agent_id: agent_id.to_string(),
                description: "Issued card".to_string(),
                merchant: "Staples".to_string(),
                amount_cents: 3_300,
                category: "cleaning_supplies".to_string(),
                decision: PurchaseDecision::Approved,
                virtual_card_id: Some("card-sim-decline".to_string()),
                timestamp: Utc::now(),
            })
            .unwrap();
        db_state
            .record_virtual_card(&VirtualCardRecord {
                id: "card-sim-decline".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: "purchase-sim-decline".to_string(),
                provider: VirtualCardProviderKind::Mock,
                provider_card_ref: "mock-card-sim-decline".to_string(),
                last_four: "3301".to_string(),
                amount_cents: 3_300,
                merchant: "Staples".to_string(),
                memo: "Declinable mock card".to_string(),
                status: VirtualCardStatus::Active,
                created_at: Utc::now(),
                expires_at: Some(Utc::now() + Duration::hours(2)),
            })
            .unwrap();
        db_state
            .update_agent_spending(agent_id, 3_300, true, true)
            .unwrap();

        let transaction = simulate_virtual_card_decline_inner(
            app.handle().clone(),
            "card-sim-decline".to_string(),
            db_state.clone(),
            app_state.clone(),
        )
        .await
        .unwrap();

        assert_eq!(transaction.status, PaymentTransactionStatus::Declined);
        let budget = db_state.get_budget(agent_id).unwrap().unwrap();
        assert_eq!(budget.daily_spent_cents, 0);
        assert_eq!(budget.monthly_spent_cents, 0);

        let purchase = db_state
            .get_purchase_record("purchase-sim-decline")
            .unwrap()
            .unwrap();
        match purchase.decision {
            PurchaseDecision::Denied { reasons, flags } => {
                assert!(reasons.iter().any(|reason| reason.contains("Mock provider simulated decline")));
                assert!(flags.iter().any(|flag| flag == "provider_transaction_declined"));
            }
            other => panic!("Expected denied purchase after simulated decline, got {:?}", other),
        }

        let dashboard =
            get_payment_dashboard(agent_id.to_string(), db_state.clone(), app_state).unwrap();
        assert_eq!(dashboard.recent_transactions.len(), 1);
        assert_eq!(
            dashboard.recent_transactions[0].status,
            PaymentTransactionStatus::Declined
        );
    }

    #[tokio::test]
    async fn privacy_transaction_event_records_captured_transaction() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-privacy-event-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();
        db_state
            .record_purchase(&PurchaseRecord {
                id: "purchase-privacy-event".to_string(),
                agent_id: agent_id.to_string(),
                description: "Issued privacy card".to_string(),
                merchant: "Figma".to_string(),
                amount_cents: 5_390,
                category: "software".to_string(),
                decision: PurchaseDecision::Approved,
                virtual_card_id: Some("card-privacy-event".to_string()),
                timestamp: Utc::now(),
            })
            .unwrap();
        db_state
            .record_virtual_card(&VirtualCardRecord {
                id: "card-privacy-event".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: "purchase-privacy-event".to_string(),
                provider: VirtualCardProviderKind::Privacy,
                provider_card_ref: "privacy-provider-ref".to_string(),
                last_four: "5390".to_string(),
                amount_cents: 5_390,
                merchant: "Figma".to_string(),
                memo: "Privacy event card".to_string(),
                status: VirtualCardStatus::Active,
                created_at: Utc::now(),
                expires_at: Some(Utc::now() + Duration::hours(2)),
            })
            .unwrap();

        let transaction = handle_privacy_transaction_event_inner(
            app.handle().clone(),
            json!({
                "token": "privacy-provider-ref",
                "transaction_token": "privacy-txn-1", // gitleaks:allow -- deterministic test fixture
                "amount": 5390,
                "status": "CAPTURED",
                "merchant": { "name": "Figma" },
                "event_type": "privacy_webhook"
            }),
            app_state.clone(),
            db_state.clone(),
        )
        .await
        .unwrap();

        assert_eq!(transaction.status, PaymentTransactionStatus::Captured);
        assert_eq!(transaction.provider_transaction_ref, "privacy-txn-1");
        assert_eq!(transaction.merchant, "Figma");

        let card = db_state
            .get_virtual_card_by_provider_ref(
                &VirtualCardProviderKind::Privacy,
                "privacy-provider-ref",
            )
            .unwrap()
            .unwrap();
        assert_eq!(card.status, VirtualCardStatus::Consumed);
    }

    #[tokio::test]
    async fn lithic_transaction_event_records_decline_and_reconciles_spend() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-lithic-event-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();
        db_state
            .record_purchase(&PurchaseRecord {
                id: "purchase-lithic-event".to_string(),
                agent_id: agent_id.to_string(),
                description: "Issued lithic card".to_string(),
                merchant: "Staples".to_string(),
                amount_cents: 4_400,
                category: "office_supplies".to_string(),
                decision: PurchaseDecision::Approved,
                virtual_card_id: Some("card-lithic-event".to_string()),
                timestamp: Utc::now(),
            })
            .unwrap();
        db_state
            .record_virtual_card(&VirtualCardRecord {
                id: "card-lithic-event".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: "purchase-lithic-event".to_string(),
                provider: VirtualCardProviderKind::LithicSandbox,
                provider_card_ref: "lithic-provider-ref".to_string(),
                last_four: "4400".to_string(),
                amount_cents: 4_400,
                merchant: "Staples".to_string(),
                memo: "Lithic event card".to_string(),
                status: VirtualCardStatus::Active,
                created_at: Utc::now(),
                expires_at: Some(Utc::now() + Duration::hours(2)),
            })
            .unwrap();
        db_state
            .update_agent_spending(agent_id, 4_400, true, true)
            .unwrap();

        let transaction = handle_lithic_transaction_event_inner(
            app.handle().clone(),
            json!({
                "card_token": "lithic-provider-ref",
                "token": "lithic-txn-1",
                "amount": 4400,
                "status": "DECLINED",
                "decline_reason": "insufficient_funds",
                "merchant": { "name": "Staples" }
            }),
            app_state.clone(),
            db_state.clone(),
        )
        .await
        .unwrap();

        assert_eq!(transaction.status, PaymentTransactionStatus::Declined);
        assert_eq!(transaction.provider_transaction_ref, "lithic-txn-1");
        assert_eq!(transaction.decline_reason.as_deref(), Some("insufficient_funds"));

        let budget = db_state.get_budget(agent_id).unwrap().unwrap();
        assert_eq!(budget.daily_spent_cents, 0);
        assert_eq!(budget.monthly_spent_cents, 0);

        let dashboard =
            get_payment_dashboard(agent_id.to_string(), db_state, app_state).unwrap();
        assert_eq!(dashboard.recent_transactions.len(), 1);
        assert_eq!(
            dashboard.recent_transactions[0].status,
            PaymentTransactionStatus::Declined
        );
    }

    #[tokio::test]
    async fn simulate_provider_transaction_event_routes_privacy_cards_through_reconciliation() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-simulated-provider-event-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();
        db_state
            .record_purchase(&PurchaseRecord {
                id: "purchase-provider-sim".to_string(),
                agent_id: agent_id.to_string(),
                description: "Issued privacy card".to_string(),
                merchant: "Linear".to_string(),
                amount_cents: 7_200,
                category: "software".to_string(),
                decision: PurchaseDecision::Approved,
                virtual_card_id: Some("card-provider-sim".to_string()),
                timestamp: Utc::now(),
            })
            .unwrap();
        db_state
            .record_virtual_card(&VirtualCardRecord {
                id: "card-provider-sim".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: "purchase-provider-sim".to_string(),
                provider: VirtualCardProviderKind::Privacy,
                provider_card_ref: "privacy-provider-sim-ref".to_string(),
                last_four: "7200".to_string(),
                amount_cents: 7_200,
                merchant: "Linear".to_string(),
                memo: "Provider sim card".to_string(),
                status: VirtualCardStatus::Active,
                created_at: Utc::now(),
                expires_at: Some(Utc::now() + Duration::hours(2)),
            })
            .unwrap();

        let transaction = simulate_provider_transaction_event_inner(
            app.handle().clone(),
            "card-provider-sim".to_string(),
            ProviderSimulationOutcome::Captured,
            app_state.clone(),
            db_state.clone(),
        )
        .await
        .unwrap();

        assert_eq!(transaction.status, PaymentTransactionStatus::Captured);
        assert_eq!(transaction.source, "privacy_simulated_capture");
        assert!(transaction.provider_transaction_ref.starts_with("privacy-sim-"));

        let dashboard =
            get_payment_dashboard(agent_id.to_string(), db_state.clone(), app_state.clone()).unwrap();
        assert_eq!(dashboard.recent_transactions.len(), 1);
        assert!(dashboard
            .recent_audit_entries
            .iter()
            .any(|entry| entry.event_type == "payment_transaction_captured"));
    }

    #[tokio::test]
    async fn manual_issue_virtual_card_records_purchase_card_and_spend() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-manual-issue-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();

        let mut budget = default_budget(agent_id);
        budget.require_approval_new_merchant = false;
        budget.require_approval_recurring = false;
        db_state.upsert_budget(&budget).unwrap();

        let message = issue_virtual_card_inner(
            app.handle().clone(),
            agent_id.to_string(),
            3_300,
            "cleaning_supplies".to_string(),
            Some("Staples".to_string()),
            app_state.clone(),
            db_state.clone(),
        )
        .await
        .unwrap();

        assert!(message.contains("Mock virtual card ending in"));

        let dashboard = get_payment_dashboard(agent_id.to_string(), db_state.clone(), app_state).unwrap();
        assert_eq!(dashboard.active_virtual_cards.len(), 1);
        assert_eq!(dashboard.recent_purchases.len(), 1);
        assert!(!dashboard.recent_audit_entries.is_empty());
        assert!(matches!(
            dashboard.recent_purchases[0].decision,
            PurchaseDecision::Approved
        ));
        assert_eq!(dashboard.budget.daily_spent_cents, 3_300);
        assert_eq!(dashboard.budget.monthly_spent_cents, 3_300);
        assert_eq!(dashboard.active_virtual_cards[0].merchant, "Staples");
    }

    #[tokio::test]
    async fn development_provider_issue_records_privacy_style_card_without_network() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-dev-provider-issue-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();

        let message = issue_development_provider_card_inner(
            app.handle().clone(),
            agent_id.to_string(),
            7_200,
            "software".to_string(),
            Some("Linear".to_string()),
            VirtualCardProviderKind::Privacy,
            app_state.clone(),
            db_state.clone(),
        )
        .await
        .unwrap();

        assert!(message.contains("Development Privacy.com test card"));

        let dashboard =
            get_payment_dashboard(agent_id.to_string(), db_state.clone(), app_state.clone())
                .unwrap();
        assert_eq!(dashboard.active_virtual_cards.len(), 1);
        assert_eq!(
            dashboard.active_virtual_cards[0].provider,
            VirtualCardProviderKind::Privacy
        );
        assert!(dashboard.active_virtual_cards[0]
            .provider_card_ref
            .starts_with(DEV_PRIVACY_CARD_PREFIX));
        assert_eq!(dashboard.budget.daily_spent_cents, 7_200);
        assert_eq!(dashboard.budget.monthly_spent_cents, 7_200);
    }

    #[tokio::test]
    async fn cancelling_development_provider_card_stays_local() {
        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let app_state = app.state::<AppState>();
        let agent_id = "payment-dev-provider-cancel-agent";

        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();
        db_state
            .record_purchase(&build_purchase_record(
                "purchase-dev-provider-cancel".to_string(),
                &PurchaseRequest {
                    agent_id: agent_id.to_string(),
                    description: "Synthetic provider card".to_string(),
                    merchant: "Figma".to_string(),
                    amount_cents: 5_500,
                    category: "software".to_string(),
                    is_recurring: false,
                },
                PurchaseDecision::Approved,
                Utc::now(),
            ))
            .unwrap();
        db_state
            .record_virtual_card(&VirtualCardRecord {
                id: "card-dev-provider-cancel".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: "purchase-dev-provider-cancel".to_string(),
                provider: VirtualCardProviderKind::LithicSandbox,
                provider_card_ref: format!("{}{}", DEV_LITHIC_CARD_PREFIX, Uuid::new_v4()),
                last_four: "5500".to_string(),
                amount_cents: 5_500,
                merchant: "Figma".to_string(),
                memo: "Synthetic Lithic test card".to_string(),
                status: VirtualCardStatus::Active,
                created_at: Utc::now(),
                expires_at: Some(Utc::now() + Duration::hours(2)),
            })
            .unwrap();

        let card = cancel_virtual_card_inner(
            app.handle().clone(),
            "card-dev-provider-cancel".to_string(),
            db_state.clone(),
            app_state.clone(),
        )
        .await
        .unwrap();

        assert_eq!(card.status, VirtualCardStatus::Cancelled);

        let dashboard = get_payment_dashboard(agent_id.to_string(), db_state, app_state).unwrap();
        assert!(dashboard.active_virtual_cards.is_empty());
        assert!(dashboard
            .recent_audit_entries
            .iter()
            .any(|entry| entry.event_type == "virtual_card_cancelled"));
    }

    #[tokio::test]
    async fn privacy_webhook_listener_accepts_signed_http_request_and_reconciles_transaction() {
        let _guard = payment_provider_test_guard();
        let stored_privacy_key = backup_secret("PRIVACY_API_KEY");
        let env_privacy_key = backup_env("PRIVACY_API_KEY");
        let env_webhook_host = backup_env("CANOPY_PAYMENT_WEBHOOK_HOST");
        let env_webhook_port = backup_env("CANOPY_PAYMENT_WEBHOOK_PORT");

        store_config_secret(
            "PRIVACY_API_KEY",
            "privacy_test_key_abcdefghijklmnopqrstuvwxyz",
        )
        .unwrap();
        std::env::set_var("CANOPY_PAYMENT_WEBHOOK_HOST", "127.0.0.1");
        std::env::set_var("CANOPY_PAYMENT_WEBHOOK_PORT", "0");

        let app = tauri::test::mock_app();
        app.manage(crate::db::Database::init_in_memory().unwrap());
        app.manage(AppState::new());

        let db_state = app.state::<crate::db::Database>();
        let agent_id = "payment-http-webhook-agent";
        db_state
            .insert_agent(&test_agent(agent_id, true, true))
            .unwrap();
        db_state.upsert_budget(&default_budget(agent_id)).unwrap();
        db_state
            .record_purchase(&build_purchase_record(
                "purchase-http-webhook".to_string(),
                &PurchaseRequest {
                    agent_id: agent_id.to_string(),
                    description: "HTTP webhook purchase".to_string(),
                    merchant: "Linear".to_string(),
                    amount_cents: 7_200,
                    category: "software".to_string(),
                    is_recurring: false,
                },
                PurchaseDecision::Approved,
                Utc::now(),
            ))
            .unwrap();
        db_state
            .record_virtual_card(&VirtualCardRecord {
                id: "card-http-webhook".to_string(),
                agent_id: agent_id.to_string(),
                purchase_record_id: "purchase-http-webhook".to_string(),
                provider: VirtualCardProviderKind::Privacy,
                provider_card_ref: "privacy-http-webhook-ref".to_string(),
                last_four: "7200".to_string(),
                amount_cents: 7_200,
                merchant: "Linear".to_string(),
                memo: "HTTP webhook card".to_string(),
                status: VirtualCardStatus::Active,
                created_at: Utc::now(),
                expires_at: Some(Utc::now() + Duration::hours(2)),
            })
            .unwrap();

        let webhook_state = Arc::new(PaymentWebhookListenerState::default());
        let server_task = tokio::spawn(start_payment_webhook_server(
            webhook_state.clone(),
            app.handle().clone(),
        ));

        let base_url = wait_for_listener_base_url(&webhook_state).await.unwrap();
        let payload = json!({
            "token": "privacy-http-webhook-ref",
            "transaction_token": "privacy-http-webhook-txn",
            "amount": 7_200,
            "status": "CAPTURED",
            "merchant": { "name": "Linear" },
            "event_type": "privacy_http_webhook_test"
        });
        let canonical = canonical_json_string(&payload).unwrap();
        let signature = calculate_hmac_base64(
            b"privacy_test_key_abcdefghijklmnopqrstuvwxyz",
            canonical.as_bytes(),
        )
        .unwrap();

        let response = Client::new()
            .post(format!("{}/payment-webhooks/privacy", base_url))
            .header("X-Privacy-HMAC", signature)
            .json(&payload)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body = response.text().await.unwrap();

        server_task.abort();
        restore_secret("PRIVACY_API_KEY", stored_privacy_key);
        restore_env("PRIVACY_API_KEY", env_privacy_key);
        restore_env("CANOPY_PAYMENT_WEBHOOK_HOST", env_webhook_host);
        restore_env("CANOPY_PAYMENT_WEBHOOK_PORT", env_webhook_port);

        assert!(status.is_success(), "unexpected response body: {}", body);

        let transactions = db_state.list_payment_transactions(agent_id, 10).unwrap();
        assert_eq!(transactions.len(), 1);
        assert_eq!(transactions[0].source, "privacy_http_webhook_test");
        assert_eq!(transactions[0].status, PaymentTransactionStatus::Captured);
    }
}

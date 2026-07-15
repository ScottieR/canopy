use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const OPENAI_ADMIN_SLOT: &str = "provider_management_openai_credential";
const OPENAI_SCOPE_SLOT: &str = "provider_management_openai_scope";
const XAI_MANAGEMENT_SLOT: &str = "provider_management_xai_credential";
const XAI_SCOPE_SLOT: &str = "provider_management_xai_scope";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderManagementStatus {
    provider: String,
    connected: bool,
    scope_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiServiceAccountResponse {
    api_key: OpenAiCreatedKey,
}

#[derive(Debug, Deserialize)]
struct OpenAiCreatedKey {
    value: String,
}

fn slots(provider: &str) -> Result<(&'static str, &'static str), String> {
    match provider.to_ascii_lowercase().as_str() {
        "openai" => Ok((OPENAI_ADMIN_SLOT, OPENAI_SCOPE_SLOT)),
        "xai" | "grok" => Ok((XAI_MANAGEMENT_SLOT, XAI_SCOPE_SLOT)),
        _ => Err("Automatic key creation currently supports OpenAI and xAI".into()),
    }
}

fn secret(slot: &str) -> Option<String> {
    crate::keychain::get_secret(slot).ok().filter(|v| !v.trim().is_empty())
}

#[tauri::command]
pub fn get_provider_management_status(provider: String) -> Result<ProviderManagementStatus, String> {
    let (credential_slot, scope_slot) = slots(&provider)?;
    Ok(ProviderManagementStatus {
        provider: provider.to_ascii_lowercase(),
        connected: secret(credential_slot).is_some() && secret(scope_slot).is_some(),
        scope_id: secret(scope_slot),
    })
}

async fn validate(provider: &str, credential: &str, scope_id: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let request = if provider == "openai" {
        client
            .get(format!("https://api.openai.com/v1/organization/projects/{}", scope_id))
            .bearer_auth(credential)
    } else {
        client
            .get("https://management-api.x.ai/auth/management-keys/validation")
            .bearer_auth(credential)
    };
    let response = request.send().await.map_err(|e| format!("Connection failed: {e}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let detail = response.text().await.unwrap_or_default();
    Err(format!("Provider rejected the management credential ({status}): {}", detail.chars().take(240).collect::<String>()))
}

#[tauri::command]
pub async fn connect_provider_management(
    provider: String,
    credential: String,
    scope_id: String,
) -> Result<ProviderManagementStatus, String> {
    let normalized = match provider.to_ascii_lowercase().as_str() {
        "openai" => "openai",
        "xai" | "grok" => "xai",
        _ => return Err("Automatic key creation currently supports OpenAI and xAI".into()),
    };
    if credential.trim().is_empty() || scope_id.trim().is_empty() {
        return Err("Management credential and scope ID are required".into());
    }
    validate(normalized, credential.trim(), scope_id.trim()).await?;
    let (credential_slot, scope_slot) = slots(normalized)?;
    crate::keychain::store_secret(credential_slot, credential.trim()).map_err(|e| e.to_string())?;
    crate::keychain::store_secret(scope_slot, scope_id.trim()).map_err(|e| e.to_string())?;
    get_provider_management_status(normalized.into())
}

#[tauri::command]
pub fn disconnect_provider_management(provider: String) -> Result<(), String> {
    let (credential_slot, scope_slot) = slots(&provider)?;
    crate::keychain::delete_secret_internal(credential_slot).map_err(|e| e.to_string())?;
    crate::keychain::delete_secret_internal(scope_slot).map_err(|e| e.to_string())?;
    Ok(())
}

async fn create_openai_key(credential: &str, project_id: &str, name: &str) -> Result<String, String> {
    let response = reqwest::Client::new()
        .post(format!("https://api.openai.com/v1/organization/projects/{project_id}/service_accounts"))
        .bearer_auth(credential)
        .json(&json!({ "name": name }))
        .send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("OpenAI key creation failed ({status}): {}", body.chars().take(300).collect::<String>())); }
    serde_json::from_str::<OpenAiServiceAccountResponse>(&body)
        .map(|r| r.api_key.value)
        .map_err(|e| format!("OpenAI returned an unexpected response: {e}"))
}

async fn create_xai_key(credential: &str, team_id: &str, name: &str) -> Result<String, String> {
    let response = reqwest::Client::new()
        .post(format!("https://management-api.x.ai/auth/teams/{team_id}/api-keys"))
        .bearer_auth(credential)
        .json(&json!({ "name": name, "acls": ["api-key:endpoint:*", "api-key:model:*"] }))
        .send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("xAI key creation failed ({status}): {}", body.chars().take(300).collect::<String>())); }
    serde_json::from_str::<Value>(&body).map_err(|e| e.to_string())?
        .get("apiKey").and_then(Value::as_str).map(str::to_string)
        .ok_or_else(|| "xAI did not return the newly created key".into())
}

#[tauri::command]
pub async fn provision_agent_provider_key(agent_id: String, provider: String) -> Result<(), String> {
    crate::validators::agent::validate_id(&agent_id).map_err(|e| e.to_string())?;
    let normalized = match provider.to_ascii_lowercase().as_str() {
        "openai" => "openai",
        "xai" | "grok" => "xai",
        _ => return Err("Automatic key creation currently supports OpenAI and xAI".into()),
    };
    let (credential_slot, scope_slot) = slots(normalized)?;
    let credential = secret(credential_slot).ok_or("Connect provider management first")?;
    let scope_id = secret(scope_slot).ok_or("Provider scope ID is missing")?;
    let name = format!("canopy-agent-{agent_id}");
    let created = if normalized == "openai" {
        create_openai_key(&credential, &scope_id, &name).await?
    } else {
        create_xai_key(&credential, &scope_id, &name).await?
    };
    let target = if normalized == "openai" {
        format!("agent_{agent_id}_openai_key")
    } else {
        format!("agent_{agent_id}_grok_key")
    };
    crate::keychain::store_secret(&target, &created).map_err(|e| e.to_string())?;
    crate::openclaw::sync_agent_api_keys(agent_id).await?;
    Ok(())
}

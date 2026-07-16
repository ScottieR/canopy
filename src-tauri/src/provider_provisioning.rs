use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const OPENAI_ADMIN_SLOT: &str = "provider_management_openai_credential";
const OPENAI_SCOPE_SLOT: &str = "provider_management_openai_scope";
const XAI_MANAGEMENT_SLOT: &str = "provider_management_xai_credential";
const XAI_SCOPE_SLOT: &str = "provider_management_xai_scope";
const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PROVIDER_RESPONSE_BYTES: usize = 64 * 1024;

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
    match normalize_provider(provider)? {
        "openai" => Ok((OPENAI_ADMIN_SLOT, OPENAI_SCOPE_SLOT)),
        "xai" => Ok((XAI_MANAGEMENT_SLOT, XAI_SCOPE_SLOT)),
        _ => unreachable!("normalize_provider only returns supported providers"),
    }
}

fn normalize_provider(provider: &str) -> Result<&'static str, String> {
    match provider.to_ascii_lowercase().as_str() {
        "openai" => Ok("openai"),
        "xai" | "grok" => Ok("xai"),
        _ => Err("Automatic key creation currently supports OpenAI and xAI".into()),
    }
}

fn validate_management_credential(credential: &str) -> Result<(), String> {
    if credential.len() < 20 || credential.len() > 512 {
        return Err("Management credential must be between 20 and 512 characters".into());
    }
    if !credential.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err(
            "Management credential must contain only non-whitespace ASCII characters".into(),
        );
    }
    Ok(())
}

/// Scope IDs are interpolated into provider URL paths, so their grammar must be
/// substantially narrower than a general string. This accepts OpenAI project IDs
/// and xAI team UUIDs while rejecting path traversal, query, and header injection.
fn validate_scope_id(scope_id: &str) -> Result<(), String> {
    if scope_id.is_empty() || scope_id.len() > 128 {
        return Err("Provider scope ID must be between 1 and 128 characters".into());
    }
    if !scope_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Provider scope ID may contain only letters, numbers, '-' and '_'".into());
    }
    Ok(())
}

fn provider_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(PROVIDER_REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Canopy/provider-provisioning")
        .build()
        .map_err(|error| format!("Could not initialize provider connection: {error}"))
}

async fn read_bounded_response(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
    {
        return Err("Provider response exceeded the safe size limit".into());
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Could not read provider response: {error}"))?;
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err("Provider response exceeded the safe size limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn agent_secret_slot(agent_id: &str, provider: &str) -> Result<String, String> {
    match normalize_provider(provider)? {
        "openai" => Ok(format!("agent_{agent_id}_openai_key")),
        "xai" => Ok(format!("agent_{agent_id}_grok_key")),
        _ => unreachable!("normalize_provider only returns supported providers"),
    }
}

fn secret(slot: &str) -> Option<String> {
    crate::keychain::get_secret(slot)
        .ok()
        .filter(|v| !v.trim().is_empty())
}

#[tauri::command]
pub fn get_provider_management_status(
    provider: String,
) -> Result<ProviderManagementStatus, String> {
    let normalized = normalize_provider(&provider)?;
    let (credential_slot, scope_slot) = slots(normalized)?;
    Ok(ProviderManagementStatus {
        provider: normalized.to_string(),
        connected: secret(credential_slot).is_some() && secret(scope_slot).is_some(),
        scope_id: secret(scope_slot),
    })
}

async fn validate(provider: &str, credential: &str, scope_id: &str) -> Result<(), String> {
    let client = provider_client()?;
    let request = if provider == "openai" {
        client
            .get(format!(
                "https://api.openai.com/v1/organization/projects/{}",
                scope_id
            ))
            .bearer_auth(credential)
    } else {
        client
            .get("https://management-api.x.ai/auth/management-keys/validation")
            .bearer_auth(credential)
    };
    let response = request
        .send()
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    Err(format!(
        "Provider rejected the management credential ({status})"
    ))
}

#[tauri::command]
pub async fn connect_provider_management(
    provider: String,
    credential: String,
    scope_id: String,
) -> Result<ProviderManagementStatus, String> {
    let normalized = normalize_provider(&provider)?;
    let credential = credential.trim();
    let scope_id = scope_id.trim();
    validate_management_credential(credential)?;
    validate_scope_id(scope_id)?;
    validate(normalized, credential, scope_id).await?;
    let (credential_slot, scope_slot) = slots(normalized)?;
    crate::keychain::store_secret(credential_slot, credential).map_err(|e| e.to_string())?;
    crate::keychain::store_secret(scope_slot, scope_id).map_err(|e| e.to_string())?;
    get_provider_management_status(normalized.into())
}

#[tauri::command]
pub fn disconnect_provider_management(provider: String) -> Result<(), String> {
    let (credential_slot, scope_slot) = slots(&provider)?;
    crate::keychain::delete_secret_internal(credential_slot).map_err(|e| e.to_string())?;
    crate::keychain::delete_secret_internal(scope_slot).map_err(|e| e.to_string())?;
    Ok(())
}

async fn create_openai_key(
    credential: &str,
    project_id: &str,
    name: &str,
) -> Result<String, String> {
    validate_scope_id(project_id)?;
    let response = provider_client()?
        .post(format!(
            "https://api.openai.com/v1/organization/projects/{project_id}/service_accounts"
        ))
        .bearer_auth(credential)
        .json(&json!({ "name": name }))
        .send()
        .await
        .map_err(|error| format!("OpenAI key creation request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("OpenAI key creation failed ({status})"));
    }
    let body = read_bounded_response(response).await?;
    let created = serde_json::from_slice::<OpenAiServiceAccountResponse>(&body)
        .map(|r| r.api_key.value)
        .map_err(|_| "OpenAI returned an unexpected response".to_string())?;
    crate::validators::keys::validate_openai_key(&created).map_err(|error| error.to_string())?;
    Ok(created)
}

async fn create_xai_key(credential: &str, team_id: &str, name: &str) -> Result<String, String> {
    validate_scope_id(team_id)?;
    let response = provider_client()?
        .post(format!(
            "https://management-api.x.ai/auth/teams/{team_id}/api-keys"
        ))
        .bearer_auth(credential)
        .json(&json!({ "name": name, "acls": ["api-key:endpoint:*", "api-key:model:*"] }))
        .send()
        .await
        .map_err(|error| format!("xAI key creation request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("xAI key creation failed ({status})"));
    }
    let body = read_bounded_response(response).await?;
    let created = serde_json::from_slice::<Value>(&body)
        .map_err(|_| "xAI returned an unexpected response".to_string())?
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "xAI did not return the newly created key".to_string())?;
    crate::validators::keys::validate_xai_key(&created).map_err(|error| error.to_string())?;
    Ok(created)
}

#[tauri::command]
pub async fn provision_agent_provider_key(
    agent_id: String,
    provider: String,
) -> Result<(), String> {
    crate::validators::agent::validate_id(&agent_id).map_err(|e| e.to_string())?;
    let normalized = normalize_provider(&provider)?;
    let (credential_slot, scope_slot) = slots(normalized)?;
    let credential = secret(credential_slot).ok_or("Connect provider management first")?;
    let scope_id = secret(scope_slot).ok_or("Provider scope ID is missing")?;
    validate_management_credential(&credential)?;
    validate_scope_id(&scope_id)?;
    let name = format!("canopy-agent-{agent_id}");
    let created = if normalized == "openai" {
        create_openai_key(&credential, &scope_id, &name).await?
    } else {
        create_xai_key(&credential, &scope_id, &name).await?
    };
    let target = agent_secret_slot(&agent_id, normalized)?;
    crate::keychain::store_secret(&target, &created).map_err(|e| e.to_string())?;
    crate::openclaw::sync_agent_api_keys(agent_id).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn management_inputs_reject_path_query_and_header_injection() {
        for invalid in [
            "../other-project",
            "project/other",
            "project?admin=true",
            "project#fragment",
            "project\r\nInjected-Header",
            "project name",
        ] {
            assert!(validate_scope_id(invalid).is_err(), "accepted {invalid:?}");
        }
        assert!(validate_scope_id("proj_abc-123").is_ok());
        assert!(validate_scope_id("550e8400-e29b-41d4-a716-446655440000").is_ok());

        assert!(
            validate_management_credential(&format!("{}\r\nX-Test: yes", "a".repeat(20))).is_err()
        );
        assert!(validate_management_credential(&format!("{} secret", "a".repeat(20))).is_err());
        assert!(validate_management_credential(&"a".repeat(513)).is_err());
    }

    #[test]
    fn provider_aliases_resolve_to_canonical_isolated_slots() {
        assert_eq!(normalize_provider("OpenAI").unwrap(), "openai");
        assert_eq!(normalize_provider("GROK").unwrap(), "xai");
        assert_eq!(
            agent_secret_slot("agent-one", "openai").unwrap(),
            "agent_agent-one_openai_key"
        );
        assert_eq!(
            agent_secret_slot("agent-two", "grok").unwrap(),
            "agent_agent-two_grok_key"
        );
        assert_ne!(
            agent_secret_slot("agent-one", "openai").unwrap(),
            agent_secret_slot("agent-two", "openai").unwrap()
        );
        assert!(!agent_secret_slot("agent-one", "openai")
            .unwrap()
            .contains("global"));
    }

    #[test]
    fn created_provider_keys_must_pass_runtime_key_validation() {
        assert!(crate::validators::keys::validate_openai_key("not-a-provider-key").is_err());
        assert!(crate::validators::keys::validate_xai_key("short").is_err());
        assert!(
            crate::validators::keys::validate_openai_key(&format!("sk-{}", "a".repeat(40))).is_ok()
        );
        assert!(crate::validators::keys::validate_xai_key(&"x".repeat(24)).is_ok());
    }
}

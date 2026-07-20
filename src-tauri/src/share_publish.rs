// ─── Publish & Share mini-apps (Workstream E, desktop → share service) ───────
//
// Uploads a validated, self-contained HTML mini-app to the Canopy share service
// (canopy-admin `/api/share/*` routes) and manages the anonymous device token.
//
// Design decisions (persona review §8 / plan Workstream E):
//   • Config-gated: if no share service base URL is configured, the UI hides
//     the Publish button entirely (get_share_config) — never a dead-end flow.
//   • Anonymous device token, generated once, stored in the keychain. No
//     account required; the token proves ownership for revoke/republish.
//   • Server re-validates everything (size, static-only). This module still
//     enforces the size cap so oversized payloads fail fast and offline.

use serde::{Deserialize, Serialize};

pub const MAX_SHARE_BYTES: usize = 2 * 1024 * 1024;
const DEVICE_TOKEN_KEY: &str = "canopy_share_device_token";

#[derive(Serialize)]
pub struct ShareConfig {
    pub configured: bool,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
}

const SHARE_BASE_KEY: &str = "canopy_share_base_url";

fn share_base_url() -> Option<String> {
    // Priority: env override (dev) → keychain-stored setting (user/managed).
    if let Ok(url) = std::env::var("CANOPY_SHARE_BASE") {
        let trimmed = url.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    crate::keychain::get_secret(SHARE_BASE_KEY)
        .ok()
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
}

#[tauri::command]
pub fn get_share_config() -> ShareConfig {
    let base = share_base_url();
    ShareConfig {
        configured: base.is_some(),
        base_url: base,
    }
}

fn get_or_create_device_token() -> Result<String, String> {
    if let Ok(existing) = crate::keychain::get_secret(DEVICE_TOKEN_KEY) {
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    // Two v4 UUIDs → 256 bits of OS randomness, no new dependency.
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    crate::keychain::store_secret(DEVICE_TOKEN_KEY, &token)
        .map_err(|e| format!("keychain: {e}"))?;
    Ok(token)
}

/// Share IDs are server-generated but validated here before use in URLs.
pub fn is_valid_share_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Deserialize)]
struct PublishResponse {
    id: String,
}

#[derive(Serialize)]
pub struct PublishedShare {
    pub id: String,
    pub url: String,
}

#[tauri::command]
pub async fn publish_share_artifact(
    html: String,
    title: String,
    agent_name: String,
) -> Result<PublishedShare, String> {
    let base = share_base_url().ok_or("share_service_unconfigured")?;
    if html.trim().is_empty() {
        return Err("empty_document".into());
    }
    if html.len() > MAX_SHARE_BYTES {
        return Err("too_large".into());
    }
    let token = get_or_create_device_token()?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let response = client
        .post(format!("{base}/api/share/publish"))
        .json(&serde_json::json!({
            "html": html,
            "title": title,
            "agentName": agent_name,
            "deviceToken": token,
        }))
        .send()
        .await
        .map_err(|e| format!("publish_failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("publish_rejected: HTTP {status} {body}"));
    }
    let parsed: PublishResponse = response
        .json()
        .await
        .map_err(|e| format!("publish_bad_response: {e}"))?;
    if !is_valid_share_id(&parsed.id) {
        return Err("publish_bad_response: invalid id".into());
    }
    Ok(PublishedShare {
        url: format!("{base}/share/{}", parsed.id),
        id: parsed.id,
    })
}

#[tauri::command]
pub async fn revoke_share_artifact(id: String) -> Result<(), String> {
    let base = share_base_url().ok_or("share_service_unconfigured")?;
    if !is_valid_share_id(&id) {
        return Err("invalid_share_id".into());
    }
    let token = get_or_create_device_token()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let response = client
        .post(format!("{base}/api/share/revoke"))
        .json(&serde_json::json!({ "id": id, "deviceToken": token }))
        .send()
        .await
        .map_err(|e| format!("revoke_failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("revoke_rejected: HTTP {}", response.status()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_ids_are_strictly_validated() {
        assert!(is_valid_share_id("a1B2-c3_d4"));
        assert!(!is_valid_share_id(""));
        assert!(!is_valid_share_id("../../etc/passwd"));
        assert!(!is_valid_share_id("id with spaces"));
        assert!(!is_valid_share_id(&"x".repeat(65)));
        assert!(!is_valid_share_id("<script>"));
    }

    #[test]
    fn size_cap_matches_client() {
        // Keep in sync with MAX_SHARE_BYTES in src/utils/sharePublish.ts.
        assert_eq!(MAX_SHARE_BYTES, 2 * 1024 * 1024);
    }
}

// ─── Model health preflight ──────────────────────────────────────────────────
// Spec: spec-helper-agent-and-orchestrator.md Part 1D ("rate-limited key"
// playbook class) + Part 1C field test of June 9, 2026: the starter task must
// never fire into a dead key. This module makes a minimal real generation
// request per provider (1 output token) — the only reliable way to detect
// quota exhaustion (429), which key-listing endpoints do not surface.
//
// Used by: the onboarding wizard's celebration-step preflight, and The
// Keeper's context payload (so Eddy can diagnose "my agent doesn't talk").

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::keychain;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProviderHealth {
    /// Canonical provider id: "anthropic" | "openai" | "gemini" | "xai"
    pub provider: String,
    /// "ok" | "no_key" | "invalid_key" | "rate_limited" | "model_unavailable" | "error"
    pub status: String,
    /// Human-readable detail for non-ok states (sanitized, no key material)
    pub detail: Option<String>,
    /// The model string that was pinged
    pub model: String,
}

const KEY_NAMES: [(&str, &str); 4] = [
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("gemini", "GEMINI_API_KEY"),
    ("xai", "XAI_API_KEY"),
];

fn default_model(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "claude-sonnet-4-6",
        "openai" => "gpt-4o",
        "xai" => "grok-beta",
        _ => "gemini-3.5-flash",
    }
}

/// Strip an OpenClaw-style "provider/" prefix if the caller passed one.
fn normalize_model(provider: &str, model: Option<String>) -> String {
    match model {
        Some(m) if !m.trim().is_empty() => {
            let m = m.trim();
            m.split_once('/').map(|(_, rest)| rest.to_string()).unwrap_or_else(|| m.to_string())
        }
        _ => default_model(provider).to_string(),
    }
}

fn status_from_http(code: u16, body_snippet: &str) -> (String, Option<String>) {
    match code {
        200 => ("ok".into(), None),
        401 | 403 => (
            "invalid_key".into(),
            Some("The provider rejected the key (unauthorized).".into()),
        ),
        429 => (
            "rate_limited".into(),
            Some("The provider says this key is out of quota or rate-limited.".into()),
        ),
        404 => (
            "model_unavailable".into(),
            Some("The provider doesn't recognize this model for your key.".into()),
        ),
        _ => (
            "error".into(),
            Some(format!("Provider returned HTTP {}: {}", code, body_snippet.chars().take(160).collect::<String>())),
        ),
    }
}

async fn ping_provider(provider: &str, key: &str, model: &str) -> (String, Option<String>) {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(8)).build() {
        Ok(c) => c,
        Err(e) => return ("error".into(), Some(format!("HTTP client error: {}", e))),
    };

    let result = match provider {
        "anthropic" => {
            client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&serde_json::json!({
                    "model": model,
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "hi"}]
                }))
                .send()
                .await
        }
        "openai" | "xai" => {
            let url = if provider == "openai" {
                "https://api.openai.com/v1/chat/completions"
            } else {
                "https://api.x.ai/v1/chat/completions"
            };
            client
                .post(url)
                .bearer_auth(key)
                .json(&serde_json::json!({
                    "model": model,
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "hi"}]
                }))
                .send()
                .await
        }
        _ => {
            // gemini
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
                model, key
            );
            client
                .post(&url)
                .json(&serde_json::json!({
                    "contents": [{"parts": [{"text": "hi"}]}],
                    "generationConfig": {"maxOutputTokens": 1}
                }))
                .send()
                .await
        }
    };

    match result {
        Ok(resp) => {
            let code = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            status_from_http(code, &body)
        }
        Err(e) if e.is_timeout() => ("error".into(), Some("Provider request timed out.".into())),
        Err(e) => ("error".into(), Some(format!("Network error: {}", e))),
    }
}

fn canonical_provider(p: &str) -> String {
    let lower = p.to_lowercase();
    if lower.contains("anthropic") || lower.contains("claude") {
        "anthropic".into()
    } else if lower.contains("openai") || lower.contains("gpt") {
        "openai".into()
    } else if lower.contains("xai") || lower.contains("grok") {
        "xai".into()
    } else {
        "gemini".into()
    }
}

/// Check one provider (when `provider` given) or every provider that has a
/// global key in the keychain (when None). Never returns key material.
#[tauri::command]
pub async fn check_model_health(
    provider: Option<String>,
    model: Option<String>,
    key_override: Option<String>,
) -> Result<Vec<ProviderHealth>, String> {
    // key_override: used by the onboarding wizard to preflight a key the user
    // just pasted (it isn't stored in the keychain until deploy).
    if let (Some(p), Some(k)) = (provider.as_ref(), key_override.as_ref()) {
        if !k.trim().is_empty() {
            let canon = canonical_provider(p);
            let model_str = normalize_model(&canon, model);
            let (status, detail) = ping_provider(&canon, k.trim(), &model_str).await;
            return Ok(vec![ProviderHealth { provider: canon, status, detail, model: model_str }]);
        }
    }
    let targets: Vec<(String, String)> = match provider {
        Some(p) => {
            let canon = canonical_provider(&p);
            let key_name = KEY_NAMES
                .iter()
                .find(|(id, _)| *id == canon)
                .map(|(_, k)| k.to_string())
                .unwrap_or_else(|| "GEMINI_API_KEY".to_string());
            vec![(canon, key_name)]
        }
        None => KEY_NAMES.iter().map(|(p, k)| (p.to_string(), k.to_string())).collect(),
    };

    let mut results = Vec::new();
    for (prov, key_name) in targets {
        let model_str = normalize_model(&prov, model.clone());
        match keychain::get_secret(&key_name) {
            Ok(key) if !key.trim().is_empty() => {
                let (status, detail) = ping_provider(&prov, key.trim(), &model_str).await;
                results.push(ProviderHealth { provider: prov, status, detail, model: model_str });
            }
            _ => {
                // No global key — only report as missing when explicitly asked
                // about this provider; in scan-all mode just skip silent gaps.
                results.push(ProviderHealth {
                    provider: prov,
                    status: "no_key".into(),
                    detail: Some("No key stored for this provider.".into()),
                    model: model_str,
                });
            }
        }
    }
    Ok(results)
}

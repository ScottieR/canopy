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
        "anthropic" => "claude-sonnet-5",
        "openai" => "gpt-5.6-terra",
        "xai" => "grok-4.5",
        _ => "gemini-3.6-flash",
    }
}

/// Strip an OpenClaw-style "provider/" prefix if the caller passed one.
fn normalize_model(provider: &str, model: Option<String>) -> String {
    match model {
        Some(m) if !m.trim().is_empty() => {
            let m = m.trim();
            m.split_once('/')
                .map(|(_, rest)| rest.to_string())
                .unwrap_or_else(|| m.to_string())
        }
        _ => default_model(provider).to_string(),
    }
}

fn validate_model_name(model: &str) -> Result<(), String> {
    if model.is_empty()
        || model.len() > 128
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Model name contains unsupported characters".into());
    }
    Ok(())
}

fn validate_provider_key(provider: &str, key: &str) -> Result<(), String> {
    let result = match provider {
        "anthropic" => crate::validators::keys::validate_anthropic_key(key),
        "openai" => crate::validators::keys::validate_openai_key(key),
        "xai" => crate::validators::keys::validate_xai_key(key),
        "gemini" => crate::validators::keys::validate_gemini_key(key),
        _ => return Err("Unsupported model provider".into()),
    };
    result.map_err(|error| error.to_string())
}

fn status_from_http(code: u16) -> (String, Option<String>) {
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
            Some(format!("Provider returned HTTP {}.", code)),
        ),
    }
}

async fn ping_provider(provider: &str, key: &str, model: &str) -> (String, Option<String>) {
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
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
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                model
            );
            client
                .post(&url)
                .header("x-goog-api-key", key)
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
            status_from_http(code)
        }
        Err(e) if e.is_timeout() => ("error".into(), Some("Provider request timed out.".into())),
        Err(e) => ("error".into(), Some(format!("Network error: {}", e))),
    }
}

fn canonical_provider(p: &str) -> Result<String, String> {
    let lower = p.to_lowercase();
    if lower.contains("anthropic") || lower.contains("claude") {
        Ok("anthropic".into())
    } else if lower.contains("openai") || lower.contains("gpt") {
        Ok("openai".into())
    } else if lower.contains("xai") || lower.contains("grok") {
        Ok("xai".into())
    } else if lower.contains("gemini") || lower.contains("google") {
        Ok("gemini".into())
    } else {
        Err("Unsupported model provider".into())
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
            let canon = canonical_provider(p)?;
            let model_str = normalize_model(&canon, model);
            validate_model_name(&model_str)?;
            if validate_provider_key(&canon, k.trim()).is_err() {
                return Ok(vec![ProviderHealth {
                    provider: canon,
                    status: "invalid_key".into(),
                    detail: Some("The provider key has an invalid format.".into()),
                    model: model_str,
                }]);
            }
            let (status, detail) = ping_provider(&canon, k.trim(), &model_str).await;
            return Ok(vec![ProviderHealth {
                provider: canon,
                status,
                detail,
                model: model_str,
            }]);
        }
    }
    let targets: Vec<(String, String)> = match provider {
        Some(p) => {
            let canon = canonical_provider(&p)?;
            let key_name = KEY_NAMES
                .iter()
                .find(|(id, _)| *id == canon)
                .map(|(_, k)| k.to_string())
                .unwrap_or_else(|| "GEMINI_API_KEY".to_string());
            vec![(canon, key_name)]
        }
        None => KEY_NAMES
            .iter()
            .map(|(p, k)| (p.to_string(), k.to_string()))
            .collect(),
    };

    let mut results = Vec::new();
    for (prov, key_name) in targets {
        let model_str = normalize_model(&prov, model.clone());
        validate_model_name(&model_str)?;
        match keychain::get_secret(&key_name) {
            Ok(key) if !key.trim().is_empty() => {
                if validate_provider_key(&prov, key.trim()).is_err() {
                    results.push(ProviderHealth {
                        provider: prov,
                        status: "invalid_key".into(),
                        detail: Some("The stored provider key has an invalid format.".into()),
                        model: model_str,
                    });
                    continue;
                }
                let (status, detail) = ping_provider(&prov, key.trim(), &model_str).await;
                results.push(ProviderHealth {
                    provider: prov,
                    status,
                    detail,
                    model: model_str,
                });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_and_model_inputs_fail_closed() {
        assert_eq!(canonical_provider("Google Gemini").unwrap(), "gemini");
        assert!(canonical_provider("unknown-provider").is_err());
        assert!(validate_model_name("gemini-2.5-flash").is_ok());
        assert!(validate_model_name("../models/other?key=secret").is_err());
        assert!(validate_model_name("model\r\nInjected: yes").is_err());
    }

    #[test]
    fn health_errors_do_not_echo_provider_response_bodies() {
        let (_, detail) = status_from_http(500);
        let detail = detail.unwrap();
        assert_eq!(detail, "Provider returned HTTP 500.");
        assert!(!detail.contains("secret"));
    }
}

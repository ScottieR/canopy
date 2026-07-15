use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MODE_SLOT: &str = "canopy_helper_mode";
const PROVIDER_SLOT: &str = "canopy_helper_provider";
const MODEL_SLOT: &str = "canopy_helper_model";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanopyHelperConfig {
    mode: String,
    provider: Option<String>,
    model: Option<String>,
    credential_present: bool,
}

fn stored(slot: &str) -> Option<String> {
    crate::keychain::get_secret(slot).ok().filter(|v| !v.trim().is_empty())
}

fn key_slot(provider: &str) -> Result<String, String> {
    match provider.to_ascii_lowercase().as_str() {
        "openai" => Ok("canopy_helper_openai_key".into()),
        "anthropic" => Ok("canopy_helper_anthropic_key".into()),
        "gemini" | "google" => Ok("canopy_helper_gemini_key".into()),
        "xai" | "grok" => Ok("canopy_helper_xai_key".into()),
        _ => Err("Unsupported Eddy provider".into()),
    }
}

fn default_model(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "claude-sonnet-4-5",
        "gemini" => "gemini-2.5-flash",
        "xai" => "grok-4-fast-non-reasoning",
        _ => "gpt-4.1-mini",
    }
}

#[tauri::command]
pub fn get_canopy_helper_config() -> Result<CanopyHelperConfig, String> {
    let mode = stored(MODE_SLOT).unwrap_or_else(|| "hosted".into());
    let provider = stored(PROVIDER_SLOT);
    let model = stored(MODEL_SLOT);
    let credential_present = provider.as_deref()
        .and_then(|p| key_slot(p).ok())
        .and_then(|slot| stored(&slot))
        .is_some();
    Ok(CanopyHelperConfig { mode, provider, model, credential_present })
}

#[tauri::command]
pub fn configure_canopy_helper(
    mode: String,
    provider: Option<String>,
    credential: Option<String>,
    model: Option<String>,
) -> Result<CanopyHelperConfig, String> {
    if !matches!(mode.as_str(), "hosted" | "provider" | "local") {
        return Err("Eddy mode must be hosted, provider, or local".into());
    }
    if mode == "provider" {
        let provider = provider.as_deref().ok_or("Choose a provider")?.to_ascii_lowercase();
        let normalized = if provider == "google" { "gemini" } else if provider == "grok" { "xai" } else { &provider };
        let slot = key_slot(normalized)?;
        if let Some(value) = credential.as_deref().filter(|v| !v.trim().is_empty()) {
            crate::keychain::store_secret(&slot, value.trim()).map_err(|e| e.to_string())?;
        } else if stored(&slot).is_none() {
            return Err("A dedicated Eddy provider key is required".into());
        }
        crate::keychain::store_secret(PROVIDER_SLOT, normalized).map_err(|e| e.to_string())?;
    } else if let Some(provider) = provider.as_deref() {
        crate::keychain::store_secret(PROVIDER_SLOT, provider).map_err(|e| e.to_string())?;
    }
    crate::keychain::store_secret(MODE_SLOT, &mode).map_err(|e| e.to_string())?;
    if let Some(model) = model.as_deref().filter(|v| !v.trim().is_empty()) {
        crate::keychain::store_secret(MODEL_SLOT, model.trim()).map_err(|e| e.to_string())?;
    } else {
        let _ = crate::keychain::delete_secret_internal(MODEL_SLOT);
    }
    get_canopy_helper_config()
}

fn prompt(message: &str, context: &Value, continuity: &Value) -> String {
    format!(
        "You are Eddy, Canopy's concise setup and diagnostics helper. Never claim you changed settings. Give concrete in-app directions.\n\nLatest user message:\n{}\n\nMinimized app context:\n{}\n\nShort-lived continuity:\n{}",
        message,
        serde_json::to_string(context).unwrap_or_else(|_| "{}".into()),
        serde_json::to_string(continuity).unwrap_or_else(|_| "{}".into()),
    )
}

async fn call_openai_compatible(base: &str, key: &str, model: &str, text: &str) -> Result<String, String> {
    let response = reqwest::Client::new().post(base).bearer_auth(key)
        .json(&json!({"model": model, "messages": [{"role":"user", "content": text}], "temperature": 0.2}))
        .send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("Provider request failed ({status})")); }
    body.pointer("/choices/0/message/content").and_then(Value::as_str).map(str::to_string)
        .ok_or_else(|| "Provider returned no reply".into())
}

#[tauri::command]
pub async fn send_canopy_helper_message(message: String, context: Value, continuity: Value) -> Result<Value, String> {
    if message.trim().is_empty() || message.len() > 4000 { return Err("Message must be 1-4000 characters".into()); }
    let config = get_canopy_helper_config()?;
    if config.mode == "hosted" { return Err("Hosted Eddy is handled by the Canopy server".into()); }
    let provider = config.provider.unwrap_or_else(|| "openai".into());
    let model = config.model.unwrap_or_else(|| if config.mode == "local" { "llama3.2:3b".into() } else { default_model(&provider).into() });
    let user_prompt = prompt(message.trim(), &context, &continuity);
    let reply = if config.mode == "local" {
        let response = reqwest::Client::new().post("http://127.0.0.1:11434/api/chat")
            .json(&json!({"model": model, "stream": false, "messages": [{"role":"user", "content": user_prompt}]}))
            .send().await.map_err(|e| format!("Ollama is unavailable: {e}"))?;
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        body.pointer("/message/content").and_then(Value::as_str).map(str::to_string).ok_or("Ollama returned no reply")?
    } else {
        let key = stored(&key_slot(&provider)?).ok_or("Eddy's dedicated provider key is missing")?;
        match provider.as_str() {
            "anthropic" => {
                let response = reqwest::Client::new().post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", key).header("anthropic-version", "2023-06-01")
                    .json(&json!({"model": model, "max_tokens": 900, "messages": [{"role":"user", "content": user_prompt}]}))
                    .send().await.map_err(|e| e.to_string())?;
                let body: Value = response.json().await.map_err(|e| e.to_string())?;
                body.pointer("/content/0/text").and_then(Value::as_str).map(str::to_string).ok_or("Anthropic returned no reply")?
            }
            "gemini" => {
                let response = reqwest::Client::new()
                    .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"))
                    .json(&json!({"contents": [{"parts": [{"text": user_prompt}]}]}))
                    .send().await.map_err(|e| e.to_string())?;
                let body: Value = response.json().await.map_err(|e| e.to_string())?;
                body.pointer("/candidates/0/content/parts/0/text").and_then(Value::as_str).map(str::to_string).ok_or("Gemini returned no reply")?
            }
            "xai" => call_openai_compatible("https://api.x.ai/v1/chat/completions", &key, &model, &user_prompt).await?,
            _ => call_openai_compatible("https://api.openai.com/v1/chat/completions", &key, &model, &user_prompt).await?,
        }
    };
    Ok(json!({"reply": reply}))
}

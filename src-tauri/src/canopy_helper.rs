use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const MODE_SLOT: &str = "canopy_helper_mode";
const PROVIDER_SLOT: &str = "canopy_helper_provider";
const MODEL_SLOT: &str = "canopy_helper_model";
const OFFLINE_MODE: &str = "offline";
const BOOTSTRAP_MODE: &str = "bootstrap";
const MAX_PROVIDER_RESPONSE_BYTES: usize = 1_000_000;

fn bounded_text(value: Option<&Value>, max: usize) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max)
        .collect()
}

fn bounded_count(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .min(10_000)
}

fn sanitize_context(context: &Value) -> Value {
    let agents = context
        .get("agents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(100)
        .map(|agent| {
            let integrations = agent
                .get("integrations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(50)
                .filter_map(|value| {
                    let text = bounded_text(Some(value), 64);
                    (!text.is_empty()).then_some(Value::String(text))
                })
                .collect::<Vec<_>>();
            json!({
                "name": bounded_text(agent.get("name"), 200),
                "status": bounded_text(agent.get("status"), 32),
                "paused": agent.get("paused").and_then(Value::as_bool).unwrap_or(false),
                "isolated": agent.get("isolated").and_then(Value::as_bool).unwrap_or(false),
                "model": bounded_text(agent.get("model"), 120),
                "integrations": integrations,
                "slack_paired": agent.get("slack_paired").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect::<Vec<_>>();
    let provider_health = context
        .get("provider_health")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(10)
        .map(|provider| {
            json!({
                "provider": bounded_text(provider.get("provider"), 32),
                "status": bounded_text(provider.get("status"), 32),
                "model": bounded_text(provider.get("model"), 120),
            })
        })
        .collect::<Vec<_>>();
    let draft_step = context
        .pointer("/onboarding/draft_step")
        .and_then(Value::as_u64)
        .map(|value| value.min(100));

    json!({
        "runtime_ready": context.get("runtime_ready").and_then(Value::as_bool).unwrap_or(false),
        "active_view": bounded_text(context.get("active_view"), 32),
        "onboarding": {
            "in_onboarding": context.pointer("/onboarding/in_onboarding").and_then(Value::as_bool).unwrap_or(false),
            "draft_step": draft_step,
        },
        "usage": {
            "agent_count": bounded_count(context.pointer("/usage/agent_count")),
            "errored_agents": bounded_count(context.pointer("/usage/errored_agents")),
        },
        "agents": agents,
        "provider_health": provider_health,
    })
}

fn sanitize_continuity(continuity: &Value) -> Value {
    let topic = continuity
        .get("topic")
        .and_then(Value::as_str)
        .filter(|value| {
            matches!(
                *value,
                "provider_setup"
                    | "integration_setup"
                    | "diagnostics"
                    | "onboarding"
                    | "persona_draft"
            )
        });
    let provider = continuity
        .get("provider")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "openai" | "anthropic" | "gemini" | "xai"));
    let target_agent = {
        let value = bounded_text(continuity.get("target_agent"), 200);
        (!value.is_empty()).then_some(value)
    };
    json!({
        "topic": topic,
        "target_agent": target_agent,
        "provider": provider,
    })
}

fn continuity_topic(continuity: &Value) -> Option<&str> {
    continuity.get("topic").and_then(Value::as_str)
}

// The server-funded first-run path receives much less than the provider-direct
// diagnostics path. In particular, no agent list, provider health, usage,
// logs, credentials, instructions, or prior conversation turns cross this
// boundary.
fn sanitize_bootstrap_context(context: &Value) -> Value {
    let draft_step = context
        .pointer("/onboarding/draft_step")
        .and_then(Value::as_u64)
        .map(|value| value.min(100));
    json!({
        "runtime_ready": context.get("runtime_ready").and_then(Value::as_bool).unwrap_or(false),
        "active_view": "onboarding",
        "onboarding": {
            "in_onboarding": context.pointer("/onboarding/in_onboarding").and_then(Value::as_bool).unwrap_or(false),
            "draft_step": draft_step,
        },
    })
}

fn validate_model_name(model: &str) -> Result<(), String> {
    if model.is_empty()
        || model.len() > 120
        || model.contains("..")
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("Eddy model must be a simple provider model identifier".into());
    }
    Ok(())
}

fn validate_provider_key(provider: &str, key: &str) -> Result<(), String> {
    let result = match provider {
        "openai" => crate::validators::keys::validate_openai_key(key),
        "anthropic" => crate::validators::keys::validate_anthropic_key(key),
        "gemini" => crate::validators::keys::validate_gemini_key(key),
        "xai" => crate::validators::keys::validate_xai_key(key),
        _ => return Err("Unsupported Eddy provider".into()),
    };
    result.map_err(|error| error.to_string())
}

fn helper_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())
}

async fn bounded_success_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        // Include a bounded slice of the provider's error body — it names the
        // actual problem (unknown model, malformed request, quota) and turning
        // it into a generic status was making field failures undiagnosable.
        let detail = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect::<String>();
        return Err(format!("Provider request failed ({status}): {detail}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
    {
        return Err("Provider response was too large".into());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err("Provider response was too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "Provider returned invalid JSON".into())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanopyHelperConfig {
    mode: String,
    provider: Option<String>,
    model: Option<String>,
    credential_present: bool,
}

fn stored(slot: &str) -> Option<String> {
    crate::keychain::get_secret(slot)
        .ok()
        .filter(|v| !v.trim().is_empty())
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

fn global_key_slot(provider: &str) -> Result<&'static str, String> {
    match provider.to_ascii_lowercase().as_str() {
        "openai" => Ok("OPENAI_API_KEY"),
        "anthropic" => Ok("ANTHROPIC_API_KEY"),
        "gemini" | "google" => Ok("GEMINI_API_KEY"),
        "xai" | "grok" => Ok("XAI_API_KEY"),
        _ => Err("Unsupported Eddy provider".into()),
    }
}

fn provider_credential(provider: &str) -> Option<String> {
    key_slot(provider)
        .ok()
        .and_then(|slot| stored(&slot))
        .or_else(|| global_key_slot(provider).ok().and_then(stored))
        .or_else(|| {
            (provider == "xai")
                .then(|| stored("GROK_API_KEY"))
                .flatten()
        })
}

fn connected_provider() -> Option<String> {
    let preferred = stored(PROVIDER_SLOT)
        .map(|provider| provider.to_ascii_lowercase())
        .filter(|provider| provider_credential(provider).is_some());
    preferred.or_else(|| {
        ["anthropic", "openai", "gemini", "xai"]
            .into_iter()
            .find(|provider| provider_credential(provider).is_some())
            .map(str::to_string)
    })
}

fn resolve_mode(configured: Option<&str>, has_connected_provider: bool) -> String {
    match configured {
        Some("local") => "local".into(),
        Some("provider") if has_connected_provider => "provider".into(),
        Some("provider") => BOOTSTRAP_MODE.into(),
        Some(OFFLINE_MODE) => OFFLINE_MODE.into(),
        // Bootstrap is only the pre-key state. The moment a user provider is
        // available, Eddy switches to a direct request from this Mac.
        Some(BOOTSTRAP_MODE) | Some("hosted") | None if has_connected_provider => "provider".into(),
        Some(BOOTSTRAP_MODE) | Some("hosted") | None => BOOTSTRAP_MODE.into(),
        _ => BOOTSTRAP_MODE.into(),
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
    let configured_mode = stored(MODE_SLOT);
    let provider = connected_provider().or_else(|| stored(PROVIDER_SLOT));
    let mode = resolve_mode(
        configured_mode.as_deref(),
        provider
            .as_deref()
            .is_some_and(|value| provider_credential(value).is_some()),
    );
    let model = stored(MODEL_SLOT);
    let credential_present = provider.as_deref().and_then(provider_credential).is_some();
    Ok(CanopyHelperConfig {
        mode,
        provider,
        model,
        credential_present,
    })
}

#[tauri::command]
pub fn configure_canopy_helper(
    mode: String,
    provider: Option<String>,
    credential: Option<String>,
    model: Option<String>,
) -> Result<CanopyHelperConfig, String> {
    if !matches!(
        mode.as_str(),
        "offline" | "bootstrap" | "hosted" | "provider" | "local"
    ) {
        return Err("Eddy mode must be bootstrap, offline, provider, or local".into());
    }
    // Older UIs may still submit `hosted`; retain first-run AI under the
    // clearer bootstrap name and its narrower server contract.
    let effective_mode = if mode == "hosted" {
        BOOTSTRAP_MODE
    } else {
        &mode
    };
    if effective_mode == "provider" {
        let provider = provider
            .as_deref()
            .ok_or("Choose a provider")?
            .to_ascii_lowercase();
        let normalized = if provider == "google" {
            "gemini"
        } else if provider == "grok" {
            "xai"
        } else {
            &provider
        };
        let slot = key_slot(normalized)?;
        if let Some(value) = credential.as_deref().filter(|v| !v.trim().is_empty()) {
            let value = value.trim();
            validate_provider_key(normalized, value)?;
            crate::keychain::store_secret(&slot, value).map_err(|e| e.to_string())?;
        } else if provider_credential(normalized).is_none() {
            return Err("Connect this provider in Canopy or enter a dedicated Eddy key".into());
        }
        crate::keychain::store_secret(PROVIDER_SLOT, normalized).map_err(|e| e.to_string())?;
    }
    crate::keychain::store_secret(MODE_SLOT, effective_mode).map_err(|e| e.to_string())?;
    if let Some(model) = model.as_deref().filter(|v| !v.trim().is_empty()) {
        let model = model.trim();
        validate_model_name(model)?;
        crate::keychain::store_secret(MODEL_SLOT, model).map_err(|e| e.to_string())?;
    } else {
        let _ = crate::keychain::delete_secret_internal(MODEL_SLOT);
    }
    get_canopy_helper_config()
}

fn prompt(message: &str, context: &Value, continuity: &Value) -> String {
    // Roleplay/agent-session requests must NOT get Eddy's persona — the same
    // marker convention canopy-admin's bootstrap route honors
    // (ROLEPLAY_MARKERS in server.js). Provider mode calls the model directly
    // from this Mac, so the bypass must exist here too, or the drafted agent's
    // voice gets tinted and structured-output turns break.
    let trimmed = message.trim_start();
    if trimmed.starts_with("ROLEPLAY TEST:") || trimmed.starts_with("AGENT SESSION:") {
        return format!(
            "You are a precise roleplay and structured-output engine. The message below contains its own complete instructions: a persona to embody and/or an exact output format. Follow them literally. Never mention Eddy, Canopy internals, drafts, or that you are roleplaying. When a JSON format is specified, reply with ONLY that JSON — no prose, no code fences.\n\n{}",
            message
        );
    }
    if continuity_topic(continuity) == Some("persona_draft") {
        return format!(
            "You are Eddie drafting a new Canopy agent persona. Follow the task exactly and return only the requested JSON object. Do not add prose, code fences, or commentary.\n\n{}",
            message
        );
    }
    let context = sanitize_context(context);
    let continuity = sanitize_continuity(continuity);
    format!(
        "You are Eddy, Canopy's concise setup and diagnostics helper. Never claim you changed settings. Give concrete in-app directions. When the user describes a product bug, friction point, or feature idea, offer to relay it to the Canopy developers in plain language.\n\nLatest user message:\n{}\n\nMinimized app context:\n{}\n\nShort-lived continuity:\n{}",
        message,
        serde_json::to_string(&context).unwrap_or_else(|_| "{}".into()),
        serde_json::to_string(&continuity).unwrap_or_else(|_| "{}".into()),
    )
}

async fn call_openai_compatible(
    base: &str,
    key: &str,
    model: &str,
    text: &str,
    json_mode: bool,
) -> Result<String, String> {
    let mut body = json!({
        "model": model,
        "messages": [{"role":"user", "content": text}],
        "temperature": if json_mode { 0.1 } else { 0.2 }
    });
    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }
    let response = helper_http_client()?
        .post(base)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body = bounded_success_json(response).await?;
    body.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Provider returned no reply".into())
}

async fn call_canopy_bootstrap(
    message: &str,
    context: &Value,
    continuity: &Value,
) -> Result<String, String> {
    if context
        .pointer("/onboarding/in_onboarding")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err("Canopy-funded Eddy assistance is limited to onboarding".into());
    }
    let endpoint = format!(
        "{}/api/canopy-helper/bootstrap",
        crate::admin_api_base_url().trim_end_matches('/')
    );
    let response = helper_http_client()?
        .post(endpoint)
        .json(&json!({
            "message": message,
            "context": sanitize_bootstrap_context(context),
            "continuity": sanitize_continuity(continuity),
        }))
        .send()
        .await
        .map_err(|error| format!("Canopy setup assistant is unavailable: {error}"))?;
    let body = bounded_success_json(response).await?;
    body.get("reply")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|reply| !reply.trim().is_empty())
        .ok_or_else(|| "Canopy setup assistant returned no reply".into())
}

#[tauri::command]
pub async fn send_canopy_helper_message(
    message: String,
    context: Value,
    continuity: Value,
) -> Result<Value, String> {
    if message.trim().is_empty() || message.len() > 4000 {
        return Err("Message must be 1-4000 characters".into());
    }
    let config = get_canopy_helper_config()?;
    if config.mode == OFFLINE_MODE {
        return Err("Eddy is using local rule-based guidance until a provider is connected".into());
    }
    let provider = config.provider.unwrap_or_else(|| "openai".into());
    let topic = continuity_topic(&continuity);
    let persona_draft = topic == Some("persona_draft");
    let model = config.model.unwrap_or_else(|| {
        if config.mode == "local" {
            "llama3.2:3b".into()
        } else {
            default_model(&provider).into()
        }
    });
    let reply = if config.mode == BOOTSTRAP_MODE {
        call_canopy_bootstrap(message.trim(), &context, &continuity).await?
    } else if config.mode == "local" {
        let user_prompt = prompt(message.trim(), &context, &continuity);
        let response = helper_http_client()?.post("http://127.0.0.1:11434/api/chat")
            .json(&json!({"model": model, "stream": false, "messages": [{"role":"user", "content": user_prompt}]}))
            .send().await.map_err(|e| format!("Ollama is unavailable: {e}"))?;
        let body = bounded_success_json(response).await?;
        body.pointer("/message/content")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or("Ollama returned no reply")?
    } else {
        let user_prompt = prompt(message.trim(), &context, &continuity);
        let key = provider_credential(&provider).ok_or("Eddy's provider key is missing")?;
        match provider.as_str() {
            "anthropic" => {
                let response = helper_http_client()?.post("https://api.anthropic.com/v1/messages")
                    .header("x-api-key", key).header("anthropic-version", "2023-06-01")
                    .json(&json!({
                        "model": model,
                        "max_tokens": 900,
                        "system": if persona_draft {
                            Some("Return only valid JSON matching the user's requested schema. No prose, no markdown, no code fences.")
                        } else {
                            None::<&str>
                        },
                        "messages": [{"role":"user", "content": user_prompt}]
                    }))
                    .send().await.map_err(|e| e.to_string())?;
                let body = bounded_success_json(response).await?;
                body.pointer("/content/0/text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or("Anthropic returned no reply")?
            }
            "gemini" => {
                let response = helper_http_client()?
                    .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"))
                    .header("x-goog-api-key", key)
                    .json(&json!({
                        "contents": [{"parts": [{"text": user_prompt}]}],
                        "generationConfig": if persona_draft {
                            json!({ "responseMimeType": "application/json", "temperature": 0.1 })
                        } else {
                            json!({ "temperature": 0.2 })
                        }
                    }))
                    .send().await.map_err(|e| e.to_string())?;
                let body = bounded_success_json(response).await?;
                body.pointer("/candidates/0/content/parts/0/text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or("Gemini returned no reply")?
            }
            "xai" => {
                call_openai_compatible(
                    "https://api.x.ai/v1/chat/completions",
                    &key,
                    &model,
                    &user_prompt,
                    persona_draft,
                )
                .await?
            }
            _ => {
                call_openai_compatible(
                    "https://api.openai.com/v1/chat/completions",
                    &key,
                    &model,
                    &user_prompt,
                    persona_draft,
                )
                .await?
            }
        }
    };
    Ok(json!({"reply": reply}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_context_drops_conversations_logs_credentials_and_instructions() {
        let context = json!({
            "runtime_ready": true,
            "active_view": "architect",
            "raw_logs": "private runtime log",
            "conversation_history": [{"content": "private old turn"}],
            "credential": "secret credential",
            "agents": [{
                "name": "Patch",
                "status": "error",
                "model": "anthropic/claude",
                "integrations": ["github"],
                "permissions": ["host_control"],
                "instructions": "private SOUL.md"
            }],
            "provider_health": [{
                "provider": "anthropic",
                "status": "healthy",
                "model": "claude",
                "detail": "raw provider response"
            }]
        });
        let clean = sanitize_context(&context);
        let encoded = serde_json::to_string(&clean).unwrap();
        for private_value in [
            "private runtime log",
            "private old turn",
            "secret credential",
            "host_control",
            "private SOUL.md",
            "raw provider response",
        ] {
            assert!(!encoded.contains(private_value));
        }
        assert_eq!(clean.pointer("/agents/0/name"), Some(&json!("Patch")));
        assert_eq!(clean.pointer("/agents/0/status"), Some(&json!("error")));
    }

    #[test]
    fn helper_continuity_is_allowlisted_and_bounded() {
        let clean = sanitize_continuity(&json!({
            "topic": "diagnostics",
            "target_agent": "a".repeat(500),
            "provider": "anthropic",
            "secret": "must disappear"
        }));
        assert_eq!(clean.pointer("/topic"), Some(&json!("diagnostics")));
        assert_eq!(
            clean
                .pointer("/target_agent")
                .and_then(Value::as_str)
                .unwrap()
                .len(),
            200
        );
        assert!(!clean.to_string().contains("must disappear"));
    }

    #[test]
    fn persona_draft_topic_is_allowlisted() {
        let clean = sanitize_continuity(&json!({
            "topic": "persona_draft",
            "provider": "openai",
            "target_agent": "Drafty"
        }));
        assert_eq!(clean.pointer("/topic"), Some(&json!("persona_draft")));
        assert_eq!(clean.pointer("/provider"), Some(&json!("openai")));
    }

    #[test]
    fn persona_draft_prompt_stays_structured() {
        let prompt = prompt(
            r#"{"task":"return json"}"#,
            &json!({ "runtime_ready": true, "agents": [{ "name": "Atlas" }] }),
            &json!({ "topic": "persona_draft" }),
        );
        assert!(prompt.contains("return only the requested JSON object"));
        assert!(!prompt.contains("Minimized app context"));
        assert!(prompt.contains(r#"{"task":"return json"}"#));
    }

    #[test]
    fn helper_model_names_cannot_alter_provider_urls() {
        for invalid in [
            "",
            "../../admin",
            "gemini?key=secret",
            "model/name",
            "model name",
        ] {
            assert!(validate_model_name(invalid).is_err());
        }
        assert!(validate_model_name("gemini-2.5-flash").is_ok());
        assert!(validate_model_name("llama3.2:3b").is_ok());
    }

    #[test]
    fn legacy_hosted_mode_migrates_to_user_provider_or_bootstrap() {
        assert_eq!(resolve_mode(Some("hosted"), true), "provider");
        assert_eq!(resolve_mode(Some("hosted"), false), "bootstrap");
        assert_eq!(resolve_mode(None, true), "provider");
        assert_eq!(resolve_mode(None, false), "bootstrap");
    }

    #[test]
    fn explicit_local_and_offline_choices_are_stable() {
        assert_eq!(resolve_mode(Some("local"), true), "local");
        assert_eq!(resolve_mode(Some("offline"), true), "offline");
        assert_eq!(resolve_mode(Some("provider"), false), "bootstrap");
    }

    #[test]
    fn bootstrap_context_contains_setup_state_only() {
        let clean = sanitize_bootstrap_context(&json!({
            "runtime_ready": true,
            "active_view": "architect",
            "onboarding": { "in_onboarding": true, "draft_step": 2, "private_draft": "secret" },
            "conversation_history": ["private turn"],
            "agents": [{ "name": "Patch", "instructions": "private SOUL.md" }],
            "provider_health": [{ "detail": "private provider response" }],
            "credential": "secret key",
            "raw_logs": "private logs"
        }));
        assert_eq!(clean.pointer("/runtime_ready"), Some(&json!(true)));
        assert_eq!(clean.pointer("/active_view"), Some(&json!("onboarding")));
        assert_eq!(clean.pointer("/onboarding/draft_step"), Some(&json!(2)));
        let encoded = clean.to_string();
        for private_value in [
            "secret",
            "private turn",
            "Patch",
            "private SOUL.md",
            "private provider response",
            "secret key",
            "private logs",
        ] {
            assert!(!encoded.contains(private_value));
        }
    }

    #[test]
    fn provider_key_slots_keep_helper_overrides_separate() {
        assert_eq!(key_slot("openai").unwrap(), "canopy_helper_openai_key");
        assert_eq!(global_key_slot("openai").unwrap(), "OPENAI_API_KEY");
        assert_eq!(key_slot("xai").unwrap(), "canopy_helper_xai_key");
        assert_eq!(global_key_slot("xai").unwrap(), "XAI_API_KEY");
    }
}

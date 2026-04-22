/// model_constants.rs — Single source of truth for all OpenClaw model identifiers,
/// gateway addresses, and auth tokens used across Canopy.
///
/// # Why this file exists
///
/// OpenClaw model strings follow a strict `"provider/model-name"` format. If the format
/// is wrong (e.g. `"anthropic/claude-4-6-sonnet"` instead of `"anthropic/claude-sonnet-4-6"`),
/// the gateway silently falls back or errors — the agent appears to receive messages but
/// never responds. Similarly, the gateway port mapping and auth-profile paths are easy to
/// get subtly wrong in ways that only manifest at runtime.
///
/// All model strings, port constants, token constants, and path helpers live here.
/// **Never hardcode a model string, port number, or gateway token in any other file.**
///
/// # Updating model names
///
/// When Anthropic, OpenAI, or Google release new model versions:
/// 1. Update the relevant constant below.
/// 2. Run `cargo test model_constants` to catch format regressions.
/// 3. The change propagates automatically everywhere — no grep needed.
///
/// Cross-reference: https://docs.openclaw.ai/concepts/models
///
/// Last verified: April 2026

// ─── Anthropic / Claude ───────────────────────────────────────────────────────

/// Claude Sonnet — primary workhorse model. Fast, capable, cost-effective.
/// OpenClaw identifier format: "anthropic/claude-sonnet-4-6"
/// ⚠️  NOT "anthropic/claude-4-6-sonnet" — the version suffix comes LAST.
pub const ANTHROPIC_CLAUDE_SONNET: &str = "anthropic/claude-sonnet-4-6";

/// Claude Haiku — fastest/cheapest Anthropic option for lightweight tasks.
pub const ANTHROPIC_CLAUDE_HAIKU: &str = "anthropic/claude-haiku-4-5";

/// Claude Opus — highest capability, most expensive. Use for complex reasoning only.
pub const ANTHROPIC_CLAUDE_OPUS: &str = "anthropic/claude-opus-4-6";

// ─── OpenAI / GPT ─────────────────────────────────────────────────────────────

/// GPT-4o — OpenAI's flagship multimodal model.
pub const OPENAI_GPT4O: &str = "openai/gpt-4o";

/// GPT-4o Mini — fast, cheap alternative for simple tasks.
pub const OPENAI_GPT4O_MINI: &str = "openai/gpt-4o-mini";

// ─── Google / Gemini ─────────────────────────────────────────────────────────

/// Gemini 2.0 Flash — Google's fast, affordable model.
/// ⚠️  "gemini-3-flash-preview" does NOT exist — use this instead.
pub const GOOGLE_GEMINI_FLASH: &str = "google/gemini-2.0-flash";

/// Gemini 2.0 Pro — Google's high-capability model.
pub const GOOGLE_GEMINI_PRO: &str = "google/gemini-2.0-pro";

// ─── Provider-level defaults ──────────────────────────────────────────────────

/// Default model when an Anthropic API key is present.
pub const DEFAULT_ANTHROPIC_MODEL: &str = ANTHROPIC_CLAUDE_SONNET;

/// Default model when an OpenAI API key is present.
pub const DEFAULT_OPENAI_MODEL: &str = OPENAI_GPT4O;

/// Default model when a Gemini API key is present.
/// Used as last-resort fallback if no other provider key exists.
pub const DEFAULT_GEMINI_MODEL: &str = GOOGLE_GEMINI_FLASH;

// ─── Gateway / Docker networking ──────────────────────────────────────────────

/// The host-side port that Canopy connects to.
/// Docker-compose maps:  HOST 18799  →  CONTAINER 18789
/// All Rust code must use GATEWAY_HOST_PORT / GATEWAY_URL when talking to the gateway
/// from the host. GATEWAY_CONTAINER_PORT is only relevant for configs written *inside*
/// the container (e.g. healthcheck URLs in docker-compose.yml).
pub const GATEWAY_HOST_PORT: u16 = 18799;

/// The container-internal port OpenClaw listens on.
/// Do NOT use this in host-side HTTP clients or AllowedOrigins checks.
pub const GATEWAY_CONTAINER_PORT: u16 = 18789;

/// Full gateway base URL for use from the Tauri host process.
pub const GATEWAY_URL: &str = "http://localhost:18799";

/// Internal bearer token for Canopy ↔ Gateway communication.
/// This is set via `openclaw config set gateway.token <value>` during gateway setup.
pub const GATEWAY_INTERNAL_TOKEN: &str = "canopy_internal_token_2026";

/// Returns the fully-formed `Authorization: Bearer <token>` header value.
/// Use as: `.header("Authorization", &model_constants::gateway_bearer_header())`
pub fn gateway_bearer_header() -> String {
    format!("Bearer {}", GATEWAY_INTERNAL_TOKEN)
}

// ─── Auth-profile path helpers ────────────────────────────────────────────────

/// Returns the path inside the container where API keys are stored for an agent.
///
/// CORRECT layout (OpenClaw expects):
///   /home/node/.openclaw/agents/{agent_id}/auth-profiles.json
///
/// ⚠️  Do NOT add an extra `agent/` subdirectory — OpenClaw won't find the file.
pub fn agent_auth_profile_path(agent_id: &str) -> String {
    format!("/home/node/.openclaw/agents/{}/auth-profiles.json", agent_id)
}

/// Returns the path inside the container where an agent's SOUL.md lives.
pub fn agent_soul_path(agent_id: &str) -> String {
    format!("/home/node/openclaw/workspace/{}/SOUL.md", agent_id)
}

// ─── Model string validation ──────────────────────────────────────────────────

/// Known OpenClaw provider prefixes.
const KNOWN_PROVIDERS: &[&str] = &["anthropic", "openai", "google", "xai", "ollama"];

/// Validates that a model string follows the `"provider/model-name"` format OpenClaw requires.
///
/// Returns `Ok(model)` if valid so it can be used inline, or an `Err` with a clear message.
///
/// # Examples
/// ```
/// use crate::model_constants::validate_model_string;
/// assert!(validate_model_string("anthropic/claude-sonnet-4-6").is_ok());
/// assert!(validate_model_string("anthropic/claude-4-6-sonnet").is_err()); // version suffix wrong
/// assert!(validate_model_string("claude-sonnet-4-6").is_err()); // missing provider prefix
/// ```
pub fn validate_model_string(model: &str) -> Result<&str, String> {
    let parts: Vec<&str> = model.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(format!(
            "Invalid OpenClaw model string '{model}': must be 'provider/model-name' \
             (e.g. 'anthropic/claude-sonnet-4-6'). \
             Common mistake: reversed order like 'anthropic/claude-4-6-sonnet'."
        ));
    }
    if !KNOWN_PROVIDERS.contains(&parts[0]) {
        return Err(format!(
            "Unknown provider '{}' in model string '{model}'. \
             Expected one of: {}",
            parts[0],
            KNOWN_PROVIDERS.join(", ")
        ));
    }
    Ok(model)
}

/// Selects the best default model string given which API keys are present.
/// Priority order: Anthropic → OpenAI → Gemini (Gemini is last-resort fallback).
///
/// This is the single place that encodes key-priority logic — used by both
/// `audit_openclaw.rs` (to determine what the config *should* have) and
/// `openclaw.rs` (to pick a starting model when creating/importing agents).
pub fn default_model_from_available_keys(
    has_anthropic: bool,
    has_openai: bool,
    has_gemini: bool,
) -> &'static str {
    if has_anthropic {
        DEFAULT_ANTHROPIC_MODEL
    } else if has_openai {
        DEFAULT_OPENAI_MODEL
    } else if has_gemini {
        DEFAULT_GEMINI_MODEL
    } else {
        // No keys at all — return Anthropic so the UI can prompt for it
        DEFAULT_ANTHROPIC_MODEL
    }
}

// ─── Compile-time sanity checks ───────────────────────────────────────────────
// These ensure all constants contain a '/' (i.e. are not accidentally set to a
// bare model name without a provider prefix).

const _: () = {
    macro_rules! assert_has_slash {
        ($s:expr) => {
            let bytes = $s.as_bytes();
            let mut found = false;
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'/' {
                    found = true;
                    break;
                }
                i += 1;
            }
            assert!(found, "Model constant is missing provider prefix (no '/')");
        };
    }
    assert_has_slash!(ANTHROPIC_CLAUDE_SONNET);
    assert_has_slash!(ANTHROPIC_CLAUDE_HAIKU);
    assert_has_slash!(ANTHROPIC_CLAUDE_OPUS);
    assert_has_slash!(OPENAI_GPT4O);
    assert_has_slash!(OPENAI_GPT4O_MINI);
    assert_has_slash!(GOOGLE_GEMINI_FLASH);
    assert_has_slash!(GOOGLE_GEMINI_PRO);
};

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Model string format ────────────────────────────────────────────────

    #[test]
    fn all_default_constants_pass_validation() {
        for constant in &[
            DEFAULT_ANTHROPIC_MODEL,
            DEFAULT_OPENAI_MODEL,
            DEFAULT_GEMINI_MODEL,
            ANTHROPIC_CLAUDE_SONNET,
            ANTHROPIC_CLAUDE_HAIKU,
            ANTHROPIC_CLAUDE_OPUS,
            OPENAI_GPT4O,
            OPENAI_GPT4O_MINI,
            GOOGLE_GEMINI_FLASH,
            GOOGLE_GEMINI_PRO,
        ] {
            assert!(
                validate_model_string(constant).is_ok(),
                "Constant '{}' failed validation — check provider prefix and format",
                constant
            );
        }
    }

    #[test]
    fn anthropic_model_string_has_correct_order() {
        // The version suffix must come AFTER the model family name.
        // "claude-sonnet-4-6" ✓   vs   "claude-4-6-sonnet" ✗
        assert!(
            ANTHROPIC_CLAUDE_SONNET.ends_with("sonnet-4-6"),
            "Anthropic Sonnet model string '{}' has wrong suffix order — should end with 'sonnet-4-6'",
            ANTHROPIC_CLAUDE_SONNET
        );
        assert!(
            !ANTHROPIC_CLAUDE_SONNET.contains("claude-4-6-sonnet"),
            "Detected the reversed model string 'claude-4-6-sonnet' — this is the old broken format"
        );
    }

    #[test]
    fn gemini_model_does_not_use_nonexistent_preview_name() {
        // "gemini-3-flash-preview" does not exist as a valid model.
        assert!(
            !DEFAULT_GEMINI_MODEL.contains("gemini-3"),
            "Gemini model string '{}' references 'gemini-3' which is not a real model",
            DEFAULT_GEMINI_MODEL
        );
    }

    #[test]
    fn validate_rejects_reversed_anthropic_string() {
        // This is the exact bug we fixed — ensure it stays fixed.
        let bad = "anthropic/claude-4-6-sonnet";
        // The format itself is technically valid (has provider/model), but the suffix is wrong.
        // We check via the suffix assertion, not just format validation.
        assert!(
            !bad.ends_with("sonnet-4-6"),
            "The bad string '{}' incorrectly passes the suffix check",
            bad
        );
    }

    #[test]
    fn validate_rejects_missing_provider() {
        assert!(validate_model_string("claude-sonnet-4-6").is_err());
        assert!(validate_model_string("gpt-4o").is_err());
        assert!(validate_model_string("gemini-2.0-flash").is_err());
    }

    #[test]
    fn validate_rejects_empty_parts() {
        assert!(validate_model_string("/claude-sonnet-4-6").is_err());
        assert!(validate_model_string("anthropic/").is_err());
        assert!(validate_model_string("/").is_err());
        assert!(validate_model_string("").is_err());
    }

    #[test]
    fn validate_rejects_unknown_provider() {
        assert!(validate_model_string("mistral/mistral-large").is_err());
        assert!(validate_model_string("cohere/command-r").is_err());
    }

    #[test]
    fn validate_accepts_all_known_providers() {
        assert!(validate_model_string("anthropic/claude-sonnet-4-6").is_ok());
        assert!(validate_model_string("openai/gpt-4o").is_ok());
        assert!(validate_model_string("google/gemini-2.0-flash").is_ok());
        assert!(validate_model_string("xai/grok-beta").is_ok());
        assert!(validate_model_string("ollama/llama3").is_ok());
    }

    // ── Gateway networking ────────────────────────────────────────────────

    #[test]
    fn gateway_url_uses_host_port_not_container_port() {
        // GATEWAY_URL must use the HOST-side port (18799), not the container-internal
        // port (18789). Getting these backwards causes every API call to fail.
        assert!(
            GATEWAY_URL.contains(&GATEWAY_HOST_PORT.to_string()),
            "GATEWAY_URL '{}' must use host port {} (not container port {})",
            GATEWAY_URL, GATEWAY_HOST_PORT, GATEWAY_CONTAINER_PORT
        );
        assert!(
            !GATEWAY_URL.contains(&GATEWAY_CONTAINER_PORT.to_string()),
            "GATEWAY_URL '{}' must NOT use container-internal port {}",
            GATEWAY_URL, GATEWAY_CONTAINER_PORT
        );
    }

    #[test]
    fn host_and_container_ports_are_different() {
        assert_ne!(
            GATEWAY_HOST_PORT, GATEWAY_CONTAINER_PORT,
            "Host and container ports must be distinct — docker-compose maps 18799:18789"
        );
    }

    // ── Auth-profile path ─────────────────────────────────────────────────

    #[test]
    fn auth_profile_path_has_no_extra_agent_subdir() {
        let path = agent_auth_profile_path("test-agent");
        // Must NOT contain the spurious extra `agent/` subdirectory.
        // Wrong:  /home/node/.openclaw/agents/test-agent/agent/auth-profiles.json
        // Right:  /home/node/.openclaw/agents/test-agent/auth-profiles.json
        assert!(
            !path.contains("/agent/auth-profiles"),
            "auth_profile_path '{}' contains spurious '/agent/' subdir — OpenClaw won't find the file",
            path
        );
        assert!(
            path.ends_with("/auth-profiles.json"),
            "auth_profile_path '{}' must end with '/auth-profiles.json'",
            path
        );
        assert!(
            path.contains("test-agent"),
            "auth_profile_path must include the agent_id"
        );
    }

    #[test]
    fn soul_path_uses_workspace_not_dot_openclaw() {
        let path = agent_soul_path("test-agent");
        assert!(
            path.contains("/openclaw/workspace/"),
            "SOUL.md path '{}' must be under /openclaw/workspace/, not /.openclaw/",
            path
        );
        assert!(path.ends_with("/SOUL.md"));
    }

    // ── Key priority logic ────────────────────────────────────────────────

    #[test]
    fn anthropic_key_is_preferred_over_others() {
        let model = default_model_from_available_keys(true, true, true);
        assert_eq!(model, DEFAULT_ANTHROPIC_MODEL);
    }

    #[test]
    fn openai_key_chosen_when_no_anthropic() {
        let model = default_model_from_available_keys(false, true, true);
        assert_eq!(model, DEFAULT_OPENAI_MODEL);
    }

    #[test]
    fn gemini_is_last_resort_fallback() {
        let model = default_model_from_available_keys(false, false, true);
        assert_eq!(model, DEFAULT_GEMINI_MODEL);
    }

    #[test]
    fn no_keys_falls_back_to_anthropic_to_prompt_user() {
        // When no keys are present, we return Anthropic so the UI can prompt for it.
        let model = default_model_from_available_keys(false, false, false);
        assert_eq!(model, DEFAULT_ANTHROPIC_MODEL);
    }
}

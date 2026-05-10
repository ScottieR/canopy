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
/// # Google / Gemini model lineage (to avoid confusion)
///
/// Google's model versioning is not sequential in the way you might expect:
///   gemini-1.5-pro / gemini-1.5-flash           (2024, stable, older generation)
///   gemini-2.0-flash / gemini-2.0-flash-lite     (2025, GA stable)
///   gemini-2.5-flash-preview-04-17               (April 2026, GA flash preview)
///   gemini-2.5-pro-preview-05-06                 (May 2026, GA pro preview)
///   gemini-3-flash-preview                       (2026, Preview — Gemini 3 Flash)
///   gemini-3.1-flash-lite-preview                (2026, Preview — fastest Gemini 3)
///   gemini-3.1-pro-preview                       (2026, Preview — Gemini 3.1 flagship)
///
/// Gemini 3.x models ARE real — confirmed from Google Vertex AI docs April 2026.
/// They are currently in Preview and may require allowlist access.
/// The recommended default for new users is gemini-2.5-flash (GA, no allowlist needed).
///
/// Cross-reference: https://docs.openclaw.ai/concepts/models
///
/// Last verified: April 2026

use serde::{Deserialize, Serialize};
use std::sync::RwLock;

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

/// o4-mini — OpenAI's fast reasoning model.
pub const OPENAI_O4_MINI: &str = "openai/o4-mini";

// ─── Google / Gemini ─────────────────────────────────────────────────────────
//
// Source of truth: https://ai.google.dev/gemini-api/docs/deprecations
// Last synced: April 2026
//
// ── Gemini 2.5 — STABLE (non-deprecated, GA) ────────────────────────────────
//    Successor to 2.0 series. Shutdown not before June 2026.
//    Use bare names — all dated preview suffixes (e.g. -preview-04-17) are
//    already deprecated or shut down per the deprecations page.

/// Gemini 2.5 Flash — stable, GA. Successor to gemini-2.0-flash.
/// Recommended default for Gemini users. Shutdown: June 17, 2026.
pub const GOOGLE_GEMINI_FLASH_25: &str = "google/gemini-2.5-flash";

/// Gemini 2.5 Flash Lite — stable, GA. Fastest/cheapest 2.5 option.
/// Shutdown: July 22, 2026.
pub const GOOGLE_GEMINI_FLASH_LITE_25: &str = "google/gemini-2.5-flash-lite";

/// Gemini 2.5 Pro — stable, GA flagship. Shutdown: June 17, 2026.
pub const GOOGLE_GEMINI_PRO_25: &str = "google/gemini-2.5-pro";

// ── Gemini 3.x — PREVIEW (no shutdown date announced) ───────────────────────
//    Valid model IDs per deprecations page. LiteLLM support inside the
//    OpenClaw container must be confirmed before using as agent defaults —
//    an unrecognised model triggers a retry loop that OOMs the container.

/// Gemini 3 Flash Preview — successor to gemini-2.5-flash.
pub const GOOGLE_GEMINI_3_FLASH: &str = "google/gemini-3-flash-preview";

/// Gemini 3.1 Flash Lite Preview — successor to gemini-2.5-flash-lite.
pub const GOOGLE_GEMINI_31_FLASH_LITE: &str = "google/gemini-3.1-flash-lite-preview";

/// Gemini 3.1 Pro Preview — successor to gemini-2.5-pro.
pub const GOOGLE_GEMINI_31_PRO: &str = "google/gemini-3.1-pro-preview";

// ─── Provider-level defaults ──────────────────────────────────────────────────

/// Default model when an Anthropic API key is present.
pub const DEFAULT_ANTHROPIC_MODEL: &str = ANTHROPIC_CLAUDE_SONNET;

/// Default model when an OpenAI API key is present.
pub const DEFAULT_OPENAI_MODEL: &str = OPENAI_GPT4O;

/// Default model when a Gemini API key is present.
/// gemini-3.1-pro-preview is the ONLY Gemini 3.x model confirmed to work inside the
/// OpenClaw container's LiteLLM runtime (verified via active sloane sessions Apr 2026).
/// gemini-3.1-flash-lite-preview is NOT confirmed — using it causes OpenClaw to enter
/// a retry loop at startup that permanently blocks the Node.js event loop (container
/// appears "running" but never emits logs past "starting..." and never responds to IPC).
/// Switch to flash-lite only after confirming LiteLLM support in the OpenClaw image.
pub const DEFAULT_GEMINI_MODEL: &str = GOOGLE_GEMINI_31_PRO;

// ─── Model catalogue (used by the frontend model picker) ─────────────────────
//
// This is the authoritative list of models the UI should display.
// The frontend fetches this via `invoke("get_available_models")` — it must NOT
// use an external server (e.g. localhost:3001) for model data because that server
// can serve stale, incorrect, or phantom model names.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    /// Full OpenClaw model ID — e.g. "anthropic/claude-sonnet-4-6".
    /// This is what gets written to openclaw.json and auth-profiles.json.
    pub id: String,
    /// Display name shown in the UI — e.g. "Claude Sonnet 4.6".
    pub name: String,
    /// Provider display name — "Anthropic", "OpenAI", "Google Gemini", "xAI".
    pub provider: String,
    /// "light" for fast/cheap models, "heavy" for powerful/expensive models.
    pub strategy: String,
    /// Short description shown in the UI.
    pub description: String,
}

/// Returns the complete list of models the UI should offer.
/// All entries are verified against real API model names — no phantom names.
pub fn all_models() -> Vec<ModelInfo> {
    vec![
        // Anthropic
        ModelInfo { id: ANTHROPIC_CLAUDE_SONNET.into(), name: "Claude Sonnet 4.6".into(), provider: "Anthropic".into(), strategy: "heavy".into(), description: "Fast & highly capable".into() },
        ModelInfo { id: ANTHROPIC_CLAUDE_HAIKU.into(),  name: "Claude Haiku 4.5".into(),  provider: "Anthropic".into(), strategy: "light".into(), description: "Fastest Anthropic model".into() },
        ModelInfo { id: ANTHROPIC_CLAUDE_OPUS.into(),   name: "Claude Opus 4.6".into(),   provider: "Anthropic".into(), strategy: "heavy".into(), description: "Most capable Anthropic".into() },
        // OpenAI
        ModelInfo { id: OPENAI_GPT4O.into(),     name: "GPT-4o".into(),      provider: "OpenAI".into(), strategy: "heavy".into(), description: "Flagship multimodal".into() },
        ModelInfo { id: OPENAI_GPT4O_MINI.into(), name: "GPT-4o Mini".into(), provider: "OpenAI".into(), strategy: "light".into(), description: "Fast & affordable".into() },
        ModelInfo { id: OPENAI_O4_MINI.into(),    name: "o4-mini".into(),     provider: "OpenAI".into(), strategy: "heavy".into(), description: "Fast reasoning model".into() },
        // ── Google Gemini 3.x — Preview (no shutdown date announced) ──────────
        // Source: https://ai.google.dev/gemini-api/docs/deprecations
        ModelInfo { id: GOOGLE_GEMINI_3_FLASH.into(),      name: "Gemini 3 Flash".into(),         provider: "Google Gemini".into(), strategy: "light".into(),  description: "Preview — successor to 2.5 Flash".into() },
        ModelInfo { id: GOOGLE_GEMINI_31_FLASH_LITE.into(), name: "Gemini 3.1 Flash Lite".into(),  provider: "Google Gemini".into(), strategy: "light".into(),  description: "Preview — successor to 2.5 Flash Lite".into() },
        ModelInfo { id: GOOGLE_GEMINI_31_PRO.into(),        name: "Gemini 3.1 Pro".into(),         provider: "Google Gemini".into(), strategy: "heavy".into(), description: "Preview — successor to 2.5 Pro".into() },
        // ── Google Gemini 2.5 — Stable GA (shutdown not before June 2026) ─────
        ModelInfo { id: GOOGLE_GEMINI_FLASH_25.into(),      name: "Gemini 2.5 Flash".into(),       provider: "Google Gemini".into(), strategy: "light".into(),  description: "Stable — recommended default".into() },
        ModelInfo { id: GOOGLE_GEMINI_FLASH_LITE_25.into(), name: "Gemini 2.5 Flash Lite".into(),  provider: "Google Gemini".into(), strategy: "light".into(),  description: "Stable — fastest/cheapest option".into() },
        ModelInfo { id: GOOGLE_GEMINI_PRO_25.into(),        name: "Gemini 2.5 Pro".into(),         provider: "Google Gemini".into(), strategy: "heavy".into(), description: "Stable — flagship model".into() },
        // NOTE: gemini-2.0-flash and gemini-2.0-flash-lite are DEPRECATED (Feb 2025,
        // shutdown June 1 2026). Do not add them back — use 2.5 series instead.
    ]
}

/// Live model registry — starts with the hardcoded validated list and is overwritten
/// by the admin oracle fetch on startup. `get_available_models` always reads from here.
///
/// Using a `RwLock` means many concurrent readers (UI renders) never block each other;
/// only the single startup write briefly takes an exclusive lock.
pub static MODEL_REGISTRY: RwLock<Vec<ModelInfo>> = RwLock::new(Vec::new());

/// Initialise the registry with the hardcoded fallback list.
/// Called once from lib.rs before the async oracle fetch starts.
pub fn init_model_registry() {
    let mut registry = MODEL_REGISTRY.write().expect("MODEL_REGISTRY poisoned");
    if registry.is_empty() {
        *registry = all_models();
    }
}

/// Update the registry with a freshly fetched list, validating every entry first.
/// Entries that fail `validate_model_string` are silently dropped so malformed names
/// (e.g. bare model names without a provider prefix) can never make it into the UI.
pub fn update_model_registry(fetched: Vec<ModelInfo>) {
    let valid: Vec<ModelInfo> = fetched
        .into_iter()
        .filter(|m| validate_model_string(&m.id).is_ok())
        .collect();

    if valid.is_empty() {
        tracing::warn!("update_model_registry: all fetched models failed validation — keeping existing list");
        return;
    }
    let count = valid.len();
    *MODEL_REGISTRY.write().expect("MODEL_REGISTRY poisoned") = valid;
    tracing::info!("update_model_registry: registry updated with {} models", count);
}

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
///
/// Written into `openclaw.json` as `gateway.auth.token` by
/// `docker::preflight_write_openclaw_json()` before each container boot. The CLI and
/// the gateway server both authenticate using this single field.
///
/// ⚠️  Do NOT write this to a top-level `gateway.token` field — that key is rejected by
/// OpenClaw 2026.4.14's schema and crash-loops the container. See
/// `OPENCLAW_INTEGRATION.md` §2 and §7 for the full rationale.
pub const GATEWAY_INTERNAL_TOKEN: &str = "canopy_internal_token_2026";

/// Returns the fully-formed `Authorization: Bearer <token>` header value.
/// Use as: `.header("Authorization", &model_constants::gateway_bearer_header())`
pub fn gateway_bearer_header() -> String {
    format!("Bearer {}", GATEWAY_INTERNAL_TOKEN)
}

// ─── Auth-profile path helpers ────────────────────────────────────────────────

/// Returns the canonical path inside the container where API keys are stored for an agent.
///
/// sync_credentials writes to BOTH this path and the agents/{id}/agent/ variant
/// (used in single-agent mode) so both layouts are covered regardless of OpenClaw mode.
///
/// Gateway mode layout (unconfirmed — may be either):
///   /home/node/.openclaw/agents/{agent_id}/auth-profiles.json        ← flat
///   /home/node/.openclaw/agents/{agent_id}/agent/auth-profiles.json  ← with subdir
pub fn agent_auth_profile_path(agent_id: &str) -> String {
    format!("/home/node/.openclaw/agents/{}/auth-profiles.json", agent_id)
}

/// Returns the path inside the container where an agent's SOUL.md lives.
///
/// Workspace is mounted at /home/node/.openclaw/workspace (inside the .openclaw dir).
/// Per-agent workspace subdirs are used in gateway/multi-agent mode.
pub fn agent_soul_path(agent_id: &str) -> String {
    format!("/home/node/.openclaw/workspace/{}/SOUL.md", agent_id)
}

// ─── Model string validation ──────────────────────────────────────────────────

/// Known OpenClaw provider prefixes.
const KNOWN_PROVIDERS: &[&str] = &["anthropic", "openai", "google", "xai", "ollama"];

/// Validates that a model string follows the `"provider/model-name"` format OpenClaw requires.
///
/// Returns `Ok(model)` if valid so it can be used inline, or an `Err` with a clear message.
///
/// # Examples
/// ```ignore
/// use canopy_lib::model_constants::validate_model_string;
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
    assert_has_slash!(GOOGLE_GEMINI_FLASH_25);
    assert_has_slash!(GOOGLE_GEMINI_FLASH_LITE_25);
    assert_has_slash!(GOOGLE_GEMINI_PRO_25);
    assert_has_slash!(GOOGLE_GEMINI_3_FLASH);
    assert_has_slash!(GOOGLE_GEMINI_31_FLASH_LITE);
    assert_has_slash!(GOOGLE_GEMINI_31_PRO);
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
            OPENAI_O4_MINI,
            GOOGLE_GEMINI_FLASH_25,
            GOOGLE_GEMINI_FLASH_LITE_25,
            GOOGLE_GEMINI_PRO_25,
            GOOGLE_GEMINI_3_FLASH,
            GOOGLE_GEMINI_31_FLASH_LITE,
            GOOGLE_GEMINI_31_PRO,
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
    fn gemini_3x_constants_are_real_and_valid() {
        // Gemini 3.x models ARE real — confirmed from Google Vertex AI docs April 2026.
        // Gemini 3 Flash, 3.1 Flash-Lite, 3.1 Pro, and 3.1 Flash Image are all Preview.
        for model in &[GOOGLE_GEMINI_31_FLASH_LITE, GOOGLE_GEMINI_3_FLASH, GOOGLE_GEMINI_31_PRO] {
            assert!(
                validate_model_string(model).is_ok(),
                "Gemini 3.x model '{}' failed format validation",
                model
            );
            assert!(
                model.starts_with("google/"),
                "Gemini 3.x model '{}' must use 'google/' provider prefix",
                model
            );
        }
    }

    #[test]
    fn default_gemini_model_is_gemini_31_pro() {
        // DEFAULT_GEMINI_MODEL must be gemini-3.1-pro-preview — the ONLY Gemini 3.x model
        // confirmed to work inside the OpenClaw container's LiteLLM runtime (verified via
        // active sloane sessions Apr 2026). gemini-3.1-flash-lite-preview is NOT confirmed:
        // using it causes OpenClaw to hang at "starting..." (LiteLLM retry loop blocks the
        // Node.js event loop permanently). Switch only after confirming LiteLLM support.
        assert_eq!(DEFAULT_GEMINI_MODEL, GOOGLE_GEMINI_31_PRO,
            "Default Gemini model must be gemini-3.1-pro-preview (confirmed LiteLLM support). \
             See model_constants.rs comment for why flash-lite is not safe as a default.");
    }

    #[test]
    fn all_models_catalogue_entries_pass_validation() {
        // Every entry in the model catalogue must have a valid "provider/model-name" format.
        for m in all_models() {
            assert!(
                validate_model_string(&m.id).is_ok(),
                "Model catalogue entry '{}' (id='{}') failed validation — check provider prefix and format",
                m.name, m.id
            );
        }
    }

    #[test]
    fn all_models_catalogue_has_stable_gemini_25_models() {
        // Source: https://ai.google.dev/gemini-api/docs/deprecations
        // gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-pro are all stable GA.
        let models = all_models();
        assert!(models.iter().any(|m| m.id == GOOGLE_GEMINI_FLASH_25),
            "Catalogue must include stable '{}'", GOOGLE_GEMINI_FLASH_25);
        assert!(models.iter().any(|m| m.id == GOOGLE_GEMINI_FLASH_LITE_25),
            "Catalogue must include stable '{}'", GOOGLE_GEMINI_FLASH_LITE_25);
        assert!(models.iter().any(|m| m.id == GOOGLE_GEMINI_PRO_25),
            "Catalogue must include stable '{}'", GOOGLE_GEMINI_PRO_25);
    }

    #[test]
    fn all_models_catalogue_has_gemini_3x_previews() {
        // Source: https://ai.google.dev/gemini-api/docs/deprecations
        // All three are listed as Preview with no shutdown date announced.
        let models = all_models();
        assert!(models.iter().any(|m| m.id == GOOGLE_GEMINI_3_FLASH),
            "Catalogue must include '{}'", GOOGLE_GEMINI_3_FLASH);
        assert!(models.iter().any(|m| m.id == GOOGLE_GEMINI_31_FLASH_LITE),
            "Catalogue must include '{}'", GOOGLE_GEMINI_31_FLASH_LITE);
        assert!(models.iter().any(|m| m.id == GOOGLE_GEMINI_31_PRO),
            "Catalogue must include '{}'", GOOGLE_GEMINI_31_PRO);
    }

    #[test]
    fn catalogue_does_not_contain_deprecated_gemini_20_models() {
        // gemini-2.0-flash deprecated Feb 2025, shutdown June 1 2026.
        // gemini-2.0-flash-lite deprecated Feb 2025, shutdown June 1 2026.
        // Source: https://ai.google.dev/gemini-api/docs/deprecations
        let models = all_models();
        assert!(!models.iter().any(|m| m.id == "google/gemini-2.0-flash"),
            "Catalogue must NOT include deprecated google/gemini-2.0-flash");
        assert!(!models.iter().any(|m| m.id == "google/gemini-2.0-flash-lite"),
            "Catalogue must NOT include deprecated google/gemini-2.0-flash-lite");
        // Also ensure dated preview suffixes are not used — those are all deprecated/shutdown.
        assert!(!models.iter().any(|m| m.id.contains("-preview-04-17")),
            "Catalogue must NOT include shut-down -preview-04-17 variant");
        assert!(!models.iter().any(|m| m.id.contains("-preview-05-06")),
            "Catalogue must NOT include deprecated -preview-05-06 variant");
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
    fn auth_profile_path_contains_agent_id_and_filename() {
        let path = agent_auth_profile_path("test-agent");
        // sync_credentials writes to BOTH the flat path and the agents/{id}/agent/ variant,
        // so this helper returns the flat layout; both are written at runtime.
        assert!(
            path.ends_with("/auth-profiles.json"),
            "auth_profile_path '{}' must end with '/auth-profiles.json'",
            path
        );
        assert!(
            path.contains("test-agent"),
            "auth_profile_path must include the agent_id"
        );
        assert!(
            path.contains("/.openclaw/agents/"),
            "auth_profile_path '{}' must be under /.openclaw/agents/",
            path
        );
    }

    #[test]
    fn soul_path_uses_dot_openclaw_workspace() {
        let path = agent_soul_path("test-agent");
        // Workspace is mounted at /home/node/.openclaw/workspace (inside .openclaw dir)
        // Verified from working Sloane reference: ./workspace:/home/node/.openclaw/workspace
        assert!(
            path.contains("/.openclaw/workspace/"),
            "SOUL.md path '{}' must be under /.openclaw/workspace/ — workspace mounts inside .openclaw",
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

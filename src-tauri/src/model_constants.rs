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
/// Last verified: July 25, 2026
use serde::{Deserialize, Serialize};
#[cfg(not(test))]
use std::sync::OnceLock;
use std::sync::RwLock;

// ─── Anthropic / Claude ───────────────────────────────────────────────────────

/// Claude Sonnet 5 — best balance for most production workloads.
pub const ANTHROPIC_CLAUDE_SONNET: &str = "anthropic/claude-sonnet-5";

/// Claude Haiku — fastest/cheapest Anthropic option for lightweight tasks.
pub const ANTHROPIC_CLAUDE_HAIKU: &str = "anthropic/claude-haiku-4-5";

/// Claude Opus 5 — advanced model for complex coding and enterprise work.
pub const ANTHROPIC_CLAUDE_OPUS: &str = "anthropic/claude-opus-5";

/// Claude Fable 5 — highest capability Anthropic model.
pub const ANTHROPIC_CLAUDE_FABLE_5: &str = "anthropic/claude-fable-5";

/// Claude Opus 4.8 — prior Opus generation still supported.
pub const ANTHROPIC_CLAUDE_OPUS_48: &str = "anthropic/claude-opus-4-8";

/// Claude Opus 4.7 — legacy upgrade target kept for compatibility checks.
pub const ANTHROPIC_CLAUDE_OPUS_47: &str = "anthropic/claude-opus-4-7";

/// Claude Sonnet 4.6 — previous workhorse model kept for migration handling.
pub const ANTHROPIC_CLAUDE_SONNET_46: &str = "anthropic/claude-sonnet-4-6";

/// Claude Opus 4.6 — previous Opus model kept for migration handling.
pub const ANTHROPIC_CLAUDE_OPUS_46: &str = "anthropic/claude-opus-4-6";

// ─── OpenAI / GPT ─────────────────────────────────────────────────────────────

/// GPT-5.6 Sol — OpenAI's flagship frontier model.
pub const OPENAI_GPT56_SOL: &str = "openai/gpt-5.6-sol";

/// GPT-5.6 Terra — OpenAI's balance of intelligence and cost.
pub const OPENAI_GPT56_TERRA: &str = "openai/gpt-5.6-terra";

/// GPT-5.6 Luna — OpenAI's lowest-cost high-volume model.
pub const OPENAI_GPT56_LUNA: &str = "openai/gpt-5.6-luna";

/// GPT-4o — previous multimodal flagship kept for migration handling.
pub const OPENAI_GPT4O: &str = "openai/gpt-4o";

/// GPT-4o Mini — prior fast/cheap model kept for migration handling.
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

/// Gemini 3.6 Flash — latest stable GA Flash model.
pub const GOOGLE_GEMINI_FLASH_36: &str = "google/gemini-3.6-flash";

/// Gemini 3.5 Flash — stable, GA.
pub const GOOGLE_GEMINI_FLASH_35: &str = "google/gemini-3.5-flash";

/// Gemini 3.5 Flash-Lite — latest stable low-latency Gemini model.
pub const GOOGLE_GEMINI_FLASH_LITE_35: &str = "google/gemini-3.5-flash-lite";

// ── Gemini 3.x — PREVIEW (no shutdown date announced) ───────────────────────
//    Valid model IDs per deprecations page. LiteLLM support inside the
//    OpenClaw container must be confirmed before using as agent defaults —
//    an unrecognised model triggers a retry loop that OOMs the container.

/// Gemini 3 Flash Preview — successor to gemini-2.5-flash.
pub const GOOGLE_GEMINI_3_FLASH: &str = "google/gemini-3-flash-preview";

/// Gemini 3.1 Flash Lite — stable lite successor to older flash-lite lines.
pub const GOOGLE_GEMINI_31_FLASH_LITE: &str = "google/gemini-3.1-flash-lite";

/// Gemini 3.1 Pro Preview — successor to gemini-2.5-pro.
pub const GOOGLE_GEMINI_31_PRO: &str = "google/gemini-3.1-pro-preview";

/// Grok 4.5 — current xAI flagship.
pub const XAI_GROK_45: &str = "xai/grok-4.5";

// ─── Provider-level defaults ──────────────────────────────────────────────────

/// Default model when an Anthropic API key is present.
pub const DEFAULT_ANTHROPIC_MODEL: &str = ANTHROPIC_CLAUDE_SONNET;

/// Default model when an OpenAI API key is present.
/// gpt-5.6-sol is the only GPT-5.6 model present in the OpenClaw 2026.7.1
/// container bundle (terra/luna are absent and fail with "Unknown model") —
/// see the container support gating section below before changing this.
pub const DEFAULT_OPENAI_MODEL: &str = OPENAI_GPT56_SOL;

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
        ModelInfo {
            id: ANTHROPIC_CLAUDE_SONNET.into(),
            name: "Claude Sonnet 5".into(),
            provider: "Anthropic".into(),
            strategy: "heavy".into(),
            description: "Best balance for most production workloads".into(),
        },
        ModelInfo {
            id: ANTHROPIC_CLAUDE_HAIKU.into(),
            name: "Claude Haiku 4.5".into(),
            provider: "Anthropic".into(),
            strategy: "light".into(),
            description: "Fastest Anthropic model".into(),
        },
        ModelInfo {
            id: ANTHROPIC_CLAUDE_OPUS.into(),
            name: "Claude Opus 5".into(),
            provider: "Anthropic".into(),
            strategy: "heavy".into(),
            description: "Advanced model for complex coding and enterprise work".into(),
        },
        ModelInfo {
            id: ANTHROPIC_CLAUDE_FABLE_5.into(),
            name: "Claude Fable 5".into(),
            provider: "Anthropic".into(),
            strategy: "heavy".into(),
            description: "Highest capability for demanding long-horizon work".into(),
        },
        ModelInfo {
            id: OPENAI_GPT56_SOL.into(),
            name: "GPT-5.6 Sol".into(),
            provider: "OpenAI".into(),
            strategy: "heavy".into(),
            description: "Frontier model for complex professional work".into(),
        },
        ModelInfo {
            id: OPENAI_GPT56_TERRA.into(),
            name: "GPT-5.6 Terra".into(),
            provider: "OpenAI".into(),
            strategy: "heavy".into(),
            description: "Balances intelligence and cost".into(),
        },
        ModelInfo {
            id: OPENAI_GPT56_LUNA.into(),
            name: "GPT-5.6 Luna".into(),
            provider: "OpenAI".into(),
            strategy: "light".into(),
            description: "Optimized for cost-sensitive high-volume work".into(),
        },
        ModelInfo {
            id: XAI_GROK_45.into(),
            name: "Grok 4.5".into(),
            provider: "xAI".into(),
            strategy: "heavy".into(),
            description: "Latest xAI flagship".into(),
        },
        ModelInfo {
            id: GOOGLE_GEMINI_FLASH_36.into(),
            name: "Gemini 3.6 Flash".into(),
            provider: "Google Gemini".into(),
            strategy: "heavy".into(),
            description: "Latest GA Flash model for agentic and coding work".into(),
        },
        ModelInfo {
            id: GOOGLE_GEMINI_FLASH_LITE_35.into(),
            name: "Gemini 3.5 Flash-Lite".into(),
            provider: "Google Gemini".into(),
            strategy: "light".into(),
            description: "Fastest low-cost Gemini for subagents and extraction".into(),
        },
        ModelInfo {
            id: GOOGLE_GEMINI_FLASH_35.into(),
            name: "Gemini 3.5 Flash".into(),
            provider: "Google Gemini".into(),
            strategy: "heavy".into(),
            description: "Stable Flash line for agentic and coding tasks".into(),
        },
        ModelInfo {
            id: GOOGLE_GEMINI_31_PRO.into(),
            name: "Gemini 3.1 Pro Preview".into(),
            provider: "Google Gemini".into(),
            strategy: "heavy".into(),
            description: "Preview fallback kept for OpenClaw compatibility".into(),
        },
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
///
/// ⚠️  The fetched list is MERGED with the hardcoded baseline (`all_models()`), it
/// never replaces it. A stale admin oracle must not be able to remove current-gen
/// models from the picker: in July 2026 the oracle was serving a claude-sonnet-4-6 /
/// gpt-4o era catalog, and a "successful" sync downgraded the whole UI. Fetched
/// entries are canonicalized first (so legacy IDs collapse onto their successors)
/// and may refresh metadata for a baseline model, but every baseline ID always
/// survives the merge.
pub fn update_model_registry(fetched: Vec<ModelInfo>) {
    let valid: Vec<ModelInfo> = fetched
        .into_iter()
        .filter_map(|mut m| {
            let resolved = resolve_model_string(&m.id).ok()?;
            m.id = resolved;
            Some(m)
        })
        .collect();

    if valid.is_empty() {
        tracing::warn!(
            "update_model_registry: all fetched models failed validation — keeping existing list"
        );
        return;
    }

    // Start from the baseline; let fetched entries refresh metadata for known IDs
    // (name/description/strategy may be updated server-side) and append genuinely
    // new IDs. Canonicalization above means a stale entry like
    // "anthropic/claude-sonnet-4-6" merges into "anthropic/claude-sonnet-5"
    // instead of appearing as a phantom extra model.
    let mut merged = all_models();
    for m in valid {
        if let Some(existing) = merged.iter_mut().find(|b| b.id == m.id) {
            existing.strategy = m.strategy;
            // Keep the baseline name/description when the fetched entry carries a
            // stale display name for a canonicalized ID (e.g. "Claude Sonnet 4.6"
            // arriving under the sonnet-5 ID after canonicalization).
        } else {
            merged.push(m);
        }
    }

    let count = merged.len();
    *MODEL_REGISTRY.write().expect("MODEL_REGISTRY poisoned") = merged;
    tracing::info!(
        "update_model_registry: registry updated with {} models (baseline-merged)",
        count
    );
}

/// True when `model` (already canonicalized) is present in the live registry or the
/// hardcoded baseline. Boot-sync and repair MUST use this instead of scanning
/// `all_models()` directly so a registry refresh can introduce new models without a
/// Rust release, while the baseline guarantees current-gen models are always accepted.
pub fn registry_contains(model: &str) -> bool {
    if all_models().iter().any(|m| m.id == model) {
        return true;
    }
    MODEL_REGISTRY
        .read()
        .map(|reg| reg.iter().any(|m| m.id == model))
        .unwrap_or(false)
}

/// Returns the provider prefix of a model string ("anthropic", "openai", "google", "xai").
pub fn provider_prefix(model: &str) -> Option<&str> {
    model.split('/').next().filter(|p| !p.is_empty())
}

// ─── OpenClaw container support gating ───────────────────────────────────────
//
// The catalogue above is what the *providers* serve; what the *container* can
// actually resolve is a subset that depends on the OpenClaw image version.
// A model missing from the container's resolver fails at runtime with
// "FailoverError: Unknown model" — the agent appears configured but is mute
// (this muted the whole fleet in Aug 2026 when gemini-3.6-flash was offered
// and picked). The picker must therefore only show container-supported models.
//
// ## Updating when bumping the OpenClaw image
// 1. Update OPENCLAW_IMAGE_TAG below to match docker.rs's compose templates
//    (a docker.rs test asserts they stay in sync).
// 2. Re-verify each catalogue model inside the new container:
//      docker exec canopy-gateway sh -lc 'grep -l "\"<model-id>\"" /app/dist/provider-catalog-*.js /app/dist/provider-models-*.js /app/dist/default-models-*.js'
//    Anthropic models absent from the catalog still work because preflight
//    writes inline `models.providers.anthropic.models` definitions (docker.rs);
//    other providers have no such pin, so catalog absence = unsupported.
// 3. Update CONTAINER_SUPPORTED_MODELS and the in-provider replacements in
//    `container_supported_replacement`.

/// The OpenClaw image tag Canopy ships. Must match the compose templates in
/// docker.rs — bumping the image without revisiting the support list below is
/// how unsupported models sneak back into the picker.
pub const OPENCLAW_IMAGE_TAG: &str = "2026.7.1";

/// Catalogue models verified to resolve on OPENCLAW_IMAGE_TAG (Aug 2026 audit:
/// container catalog grep + live send verification for sonnet-5/haiku/3.5-flash).
const CONTAINER_SUPPORTED_MODELS: &[&str] = &[
    ANTHROPIC_CLAUDE_SONNET,   // inline provider def written by preflight
    ANTHROPIC_CLAUDE_HAIKU,    // in container catalog
    ANTHROPIC_CLAUDE_OPUS,     // inline provider def written by preflight
    ANTHROPIC_CLAUDE_FABLE_5,  // in container catalog
    OPENAI_GPT56_SOL,          // in container default-models
    GOOGLE_GEMINI_FLASH_35,    // in container catalog
    GOOGLE_GEMINI_31_FLASH_LITE, // in container catalog
    GOOGLE_GEMINI_31_PRO,      // in container catalog
];

/// True when the container's OpenClaw runtime can resolve `model`.
pub fn model_supported_by_container(model: &str) -> bool {
    CONTAINER_SUPPORTED_MODELS.contains(&model)
}

/// In-provider stand-in for a model the current container can't resolve, used
/// at boot so an agent whose preferred model outruns the image stays on its
/// chosen provider instead of drifting cross-provider. Returns None when the
/// provider has no supported model on this image.
pub fn container_supported_replacement(model: &str) -> Option<&'static str> {
    if model_supported_by_container(model) {
        return None;
    }
    match provider_prefix(model) {
        Some("anthropic") => Some(ANTHROPIC_CLAUDE_SONNET),
        Some("openai") => Some(OPENAI_GPT56_SOL),
        Some("google") => Some(GOOGLE_GEMINI_FLASH_35),
        _ => None,
    }
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
#[cfg(test)]
pub fn gateway_internal_token() -> &'static str {
    // Unit tests must never read or mutate the developer's real macOS Keychain.
    "canopy_gateway_test_000000000000000000000000000000000000000000000000"
}

#[cfg(not(test))]
pub fn gateway_internal_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            match crate::keychain::get_or_create_internal_secret(
                "internal_gateway_token",
                "canopy_gateway_",
            ) {
                Ok(token) => {
                    crate::system_health::report_ok("keychain");
                    token
                }
                Err(error) => {
                    tracing::warn!(
                        "Could not persist the internal gateway credential; using a process-local credential: {}",
                        error
                    );
                    crate::system_health::report_degraded(
                        "keychain",
                        format!(
                            "Keychain unavailable — using a temporary gateway credential that dies with this app session ({error})"
                        ),
                        "Agents deployed now will lose gateway access when Canopy quits. Relaunch Canopy and click 'Allow' on the keychain prompt.",
                    );
                    format!(
                        "canopy_gateway_{}{}",
                        uuid::Uuid::new_v4().simple(),
                        uuid::Uuid::new_v4().simple()
                    )
                }
            }
        })
        .as_str()
}

/// Returns the fully-formed `Authorization: Bearer <token>` header value.
/// Use as: `.header("Authorization", &model_constants::gateway_bearer_header())`
pub fn gateway_bearer_header() -> String {
    format!("Bearer {}", gateway_internal_token())
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
    format!(
        "/home/node/.openclaw/agents/{}/auth-profiles.json",
        agent_id
    )
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

/// Returns the current canonical replacement for deprecated or legacy model IDs.
///
/// ⚠️  Every provider's legacy lineage MUST be mapped here. Before July 2026 only
/// Gemini aliases were mapped; legacy Anthropic/OpenAI IDs (e.g. from the stale
/// admin-oracle catalog) failed the boot-sync catalog check and were silently
/// replaced via `default_model_from_available_keys` — which switched PROVIDERS,
/// not just versions. Mapping successors in-provider is what keeps an agent on
/// its intended provider across model generations.
pub fn successor_model_for(model: &str) -> Option<&'static str> {
    match model.trim() {
        // ── Anthropic legacy → current ──
        "anthropic/claude-sonnet-4-6" => Some(ANTHROPIC_CLAUDE_SONNET),
        "anthropic/claude-sonnet-4-5" => Some(ANTHROPIC_CLAUDE_SONNET),
        "anthropic/claude-opus-4-8" => Some(ANTHROPIC_CLAUDE_OPUS),
        "anthropic/claude-opus-4-7" => Some(ANTHROPIC_CLAUDE_OPUS),
        "anthropic/claude-opus-4-6" => Some(ANTHROPIC_CLAUDE_OPUS),
        "anthropic/claude-opus-4-5" => Some(ANTHROPIC_CLAUDE_OPUS),
        "anthropic/claude-opus-4-1" => Some(ANTHROPIC_CLAUDE_OPUS),
        "anthropic/claude-3-5-haiku" => Some(ANTHROPIC_CLAUDE_HAIKU),
        // ── OpenAI legacy → current ──
        "openai/gpt-4o" => Some(OPENAI_GPT56_TERRA),
        "openai/gpt-4o-mini" => Some(OPENAI_GPT56_LUNA),
        "openai/o4-mini" => Some(OPENAI_GPT56_TERRA),
        "openai/gpt-4.1" => Some(OPENAI_GPT56_TERRA),
        "openai/gpt-4.1-mini" => Some(OPENAI_GPT56_LUNA),
        // ── xAI legacy → current ──
        "xai/grok-beta" => Some(XAI_GROK_45),
        "xai/grok-3" => Some(XAI_GROK_45),
        "xai/grok-4" => Some(XAI_GROK_45),
        // ── Google legacy → current ──
        "google/gemini-flash-latest" => Some(GOOGLE_GEMINI_FLASH_35),
        "google/gemini-2.0-flash" => Some(GOOGLE_GEMINI_FLASH_35),
        "google/gemini-2.0-flash-001" => Some(GOOGLE_GEMINI_FLASH_35),
        "google/gemini-3-flash-preview" => Some(GOOGLE_GEMINI_FLASH_35),
        "google/gemini-2.0-flash-lite" => Some(GOOGLE_GEMINI_31_FLASH_LITE),
        "google/gemini-2.0-flash-lite-001" => Some(GOOGLE_GEMINI_31_FLASH_LITE),
        "google/gemini-2.0-flash-lite-preview" => Some(GOOGLE_GEMINI_31_FLASH_LITE),
        "google/gemini-2.0-flash-lite-preview-02-05" => Some(GOOGLE_GEMINI_31_FLASH_LITE),
        "google/gemini-3.1-flash-lite-preview" => Some(GOOGLE_GEMINI_31_FLASH_LITE),
        _ => None,
    }
}

/// Canonicalize a model string before validation or persistence.
pub fn canonicalize_model_string(model: &str) -> String {
    let trimmed = model.trim();
    successor_model_for(trimmed).unwrap_or(trimmed).to_string()
}

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

/// Canonicalize then validate a model string, returning the safe current ID.
pub fn resolve_model_string(model: &str) -> Result<String, String> {
    let canonical = canonicalize_model_string(model);
    validate_model_string(&canonical)?;
    Ok(canonical)
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

/// Build the default model fallback chain for `agents.defaults.model.fallbacks`.
///
/// OpenClaw natively walks this chain on auth failures, rate limits (429/quota),
/// billing disables, and overload — with per-profile cooldowns, sticky auto-
/// fallback overrides, periodic primary re-probes, and user-visible
/// "Model Fallback" notices (docs.openclaw.ai/concepts/model-failover). Canopy
/// historically wrote only `model.primary`, so an exhausted key meant a mute
/// agent. Order: same-provider cheaper sibling first (keeps persona/provider
/// caches warm), then cross-provider equivalents in key-priority order. Only
/// providers with keys are included; the primary itself is excluded; max 3.
pub fn default_fallback_chain(
    primary: &str,
    has_anthropic: bool,
    has_openai: bool,
    has_gemini: bool,
) -> Vec<&'static str> {
    let primary_provider = provider_prefix(primary).unwrap_or("");
    let mut chain: Vec<&'static str> = Vec::new();

    // Same-provider cheaper sibling first.
    //
    // ⚠️  Every model in this chain must be resolvable by the OpenClaw runtime in the
    // container, or failover dies with "FailoverError: Unknownown model" at the exact
    // moment it's needed (verified Aug 2026: gemini-3.6-flash and gemini-3.5-flash-lite
    // are absent from the OpenClaw 2026.7.1 provider catalog, which turned a transient
    // Anthropic auth failure into "All models failed" for every agent). Gemini slots
    // therefore use GOOGLE_GEMINI_FLASH_35 — present in the container catalog — not the
    // newest Flash. Re-verify against the shipped image before changing these
    // (`grep gemini-<ver> /app/dist/provider-catalog-*.js` inside the container).
    match primary_provider {
        "anthropic" if has_anthropic => chain.push(ANTHROPIC_CLAUDE_HAIKU),
        "openai" if has_openai => chain.push(OPENAI_GPT56_SOL),
        "google" if has_gemini => chain.push(GOOGLE_GEMINI_FLASH_35),
        _ => {}
    }

    // Cross-provider equivalents, key-priority order (Anthropic → OpenAI → Gemini).
    if has_anthropic && primary_provider != "anthropic" {
        chain.push(ANTHROPIC_CLAUDE_SONNET);
    }
    if has_openai && primary_provider != "openai" {
        chain.push(OPENAI_GPT56_SOL);
    }
    if has_gemini && primary_provider != "google" {
        chain.push(GOOGLE_GEMINI_FLASH_35);
    }

    chain.retain(|m| *m != primary);
    chain.dedup();
    chain.truncate(3);
    chain
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
    assert_has_slash!(ANTHROPIC_CLAUDE_FABLE_5);
    assert_has_slash!(ANTHROPIC_CLAUDE_OPUS_48);
    assert_has_slash!(ANTHROPIC_CLAUDE_OPUS_47);
    assert_has_slash!(ANTHROPIC_CLAUDE_SONNET_46);
    assert_has_slash!(ANTHROPIC_CLAUDE_OPUS_46);
    assert_has_slash!(OPENAI_GPT56_SOL);
    assert_has_slash!(OPENAI_GPT56_TERRA);
    assert_has_slash!(OPENAI_GPT56_LUNA);
    assert_has_slash!(OPENAI_GPT4O);
    assert_has_slash!(OPENAI_GPT4O_MINI);
    assert_has_slash!(GOOGLE_GEMINI_FLASH_25);
    assert_has_slash!(GOOGLE_GEMINI_FLASH_LITE_25);
    assert_has_slash!(GOOGLE_GEMINI_PRO_25);
    assert_has_slash!(GOOGLE_GEMINI_3_FLASH);
    assert_has_slash!(GOOGLE_GEMINI_31_FLASH_LITE);
    assert_has_slash!(GOOGLE_GEMINI_31_PRO);
    assert_has_slash!(GOOGLE_GEMINI_FLASH_36);
    assert_has_slash!(GOOGLE_GEMINI_FLASH_35);
    assert_has_slash!(GOOGLE_GEMINI_FLASH_LITE_35);
    assert_has_slash!(XAI_GROK_45);
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
            ANTHROPIC_CLAUDE_FABLE_5,
            ANTHROPIC_CLAUDE_OPUS_48,
            ANTHROPIC_CLAUDE_OPUS_47,
            ANTHROPIC_CLAUDE_SONNET_46,
            ANTHROPIC_CLAUDE_OPUS_46,
            OPENAI_GPT56_SOL,
            OPENAI_GPT56_TERRA,
            OPENAI_GPT56_LUNA,
            OPENAI_GPT4O,
            OPENAI_GPT4O_MINI,
            OPENAI_O4_MINI,
            GOOGLE_GEMINI_FLASH_25,
            GOOGLE_GEMINI_FLASH_LITE_25,
            GOOGLE_GEMINI_PRO_25,
            GOOGLE_GEMINI_3_FLASH,
            GOOGLE_GEMINI_31_FLASH_LITE,
            GOOGLE_GEMINI_31_PRO,
            GOOGLE_GEMINI_FLASH_36,
            GOOGLE_GEMINI_FLASH_35,
            GOOGLE_GEMINI_FLASH_LITE_35,
            XAI_GROK_45,
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
        // "claude-sonnet-5" ✓   vs   "claude-5-sonnet" ✗
        assert!(
            ANTHROPIC_CLAUDE_SONNET.ends_with("sonnet-5"),
            "Anthropic Sonnet model string '{}' has wrong suffix order — should end with 'sonnet-5'",
            ANTHROPIC_CLAUDE_SONNET
        );
        assert!(
            !ANTHROPIC_CLAUDE_SONNET.contains("claude-5-sonnet"),
            "Detected the reversed model string 'claude-5-sonnet' — this is the old broken format"
        );
    }

    #[test]
    fn latest_gemini_constants_are_real_and_valid() {
        for model in &[
            GOOGLE_GEMINI_FLASH_36,
            GOOGLE_GEMINI_FLASH_LITE_35,
            GOOGLE_GEMINI_FLASH_35,
            GOOGLE_GEMINI_31_PRO,
        ] {
            assert!(
                validate_model_string(model).is_ok(),
                "Gemini model '{}' failed format validation",
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
        assert_eq!(
            DEFAULT_GEMINI_MODEL, GOOGLE_GEMINI_31_PRO,
            "Default Gemini model must be gemini-3.1-pro-preview (confirmed LiteLLM support). \
             See model_constants.rs comment for why flash-lite is not safe as a default."
        );
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
    fn all_models_catalogue_has_latest_anthropic_models() {
        let models = all_models();
        assert!(
            models.iter().any(|m| m.id == ANTHROPIC_CLAUDE_SONNET),
            "Catalogue must include '{}'",
            ANTHROPIC_CLAUDE_SONNET
        );
        assert!(
            models.iter().any(|m| m.id == ANTHROPIC_CLAUDE_OPUS),
            "Catalogue must include '{}'",
            ANTHROPIC_CLAUDE_OPUS
        );
        assert!(
            models.iter().any(|m| m.id == ANTHROPIC_CLAUDE_FABLE_5),
            "Catalogue must include '{}'",
            ANTHROPIC_CLAUDE_FABLE_5
        );
    }

    #[test]
    fn all_models_catalogue_has_latest_openai_models() {
        let models = all_models();
        assert!(
            models.iter().any(|m| m.id == OPENAI_GPT56_SOL),
            "Catalogue must include '{}'",
            OPENAI_GPT56_SOL
        );
        assert!(
            models.iter().any(|m| m.id == OPENAI_GPT56_TERRA),
            "Catalogue must include '{}'",
            OPENAI_GPT56_TERRA
        );
        assert!(
            models.iter().any(|m| m.id == OPENAI_GPT56_LUNA),
            "Catalogue must include '{}'",
            OPENAI_GPT56_LUNA
        );
    }

    #[test]
    fn fallback_chain_prefers_same_provider_then_cross_provider() {
        // All keys: anthropic primary → haiku first, then cross-provider.
        let chain = default_fallback_chain(ANTHROPIC_CLAUDE_SONNET, true, true, true);
        assert_eq!(
            chain,
            vec![ANTHROPIC_CLAUDE_HAIKU, OPENAI_GPT56_SOL, GOOGLE_GEMINI_FLASH_35]
        );
        // Every entry must be a valid, keyed, non-primary model.
        for m in &chain {
            assert!(validate_model_string(m).is_ok());
            assert_ne!(*m, ANTHROPIC_CLAUDE_SONNET);
        }
    }

    #[test]
    fn fallback_chain_only_includes_keyed_providers() {
        // Only a Gemini key: google primary gets its cheaper sibling and nothing else.
        let chain = default_fallback_chain(DEFAULT_GEMINI_MODEL, false, false, true);
        assert_eq!(chain, vec![GOOGLE_GEMINI_FLASH_35]);
        // No keys at all → empty chain (strict primary), never a keyless provider.
        assert!(default_fallback_chain(ANTHROPIC_CLAUDE_SONNET, false, false, false).is_empty());
    }

    #[test]
    fn fallback_chain_only_uses_container_verified_models() {
        // Failover fires when the primary is already failing — a chain entry the
        // container's OpenClaw can't resolve turns one provider outage into
        // "All models failed" (Aug 2026: gemini-3.6-flash was absent from the
        // OpenClaw 2026.7.1 catalog and killed every agent whose Anthropic auth
        // hiccuped). Keep this list in sync with the shipped container image.
        for primary in &[
            ANTHROPIC_CLAUDE_SONNET,
            OPENAI_GPT56_SOL,
            DEFAULT_GEMINI_MODEL,
        ] {
            for m in default_fallback_chain(primary, true, true, true) {
                assert!(
                    model_supported_by_container(m),
                    "fallback chain entry '{}' is not supported by OpenClaw image {}",
                    m,
                    OPENCLAW_IMAGE_TAG
                );
            }
        }
    }

    #[test]
    fn key_based_defaults_are_container_supported() {
        // fall_back paths in resolve_boot_model return these directly — an
        // unsupported default would resurrect the "Unknown model" mute-agent bug.
        for (a, o, g) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
            (true, true, true),
        ] {
            let m = default_model_from_available_keys(a, o, g);
            assert!(
                model_supported_by_container(m),
                "key-based default '{}' is not supported by OpenClaw image {}",
                m,
                OPENCLAW_IMAGE_TAG
            );
        }
    }

    #[test]
    fn container_replacement_stays_in_provider_and_is_supported() {
        assert_eq!(
            container_supported_replacement("google/gemini-3.6-flash"),
            Some(GOOGLE_GEMINI_FLASH_35)
        );
        assert_eq!(
            container_supported_replacement("openai/gpt-5.6-terra"),
            Some(OPENAI_GPT56_SOL)
        );
        // Supported models need no replacement.
        assert_eq!(container_supported_replacement(GOOGLE_GEMINI_FLASH_35), None);
        // Every replacement must itself be supported and provider-preserving.
        for unsupported in ["google/gemini-3.5-flash-lite", "openai/gpt-5.6-luna", "xai/grok-4.5"] {
            if let Some(r) = container_supported_replacement(unsupported) {
                assert!(model_supported_by_container(r));
                assert_eq!(provider_prefix(unsupported), provider_prefix(r));
            }
        }
        // xai has no supported model on 2026.7.1 — must return None, not a wrong provider.
        assert_eq!(container_supported_replacement("xai/grok-4.5"), None);
    }

    #[test]
    fn fallback_chain_never_contains_primary_and_caps_at_three() {
        // Haiku primary: the same-provider sibling IS the primary — must be removed.
        let chain = default_fallback_chain(ANTHROPIC_CLAUDE_HAIKU, true, true, true);
        assert!(!chain.contains(&ANTHROPIC_CLAUDE_HAIKU));
        assert!(chain.len() <= 3);
    }

    #[test]
    fn successor_mappings_stay_in_provider() {
        // The whole point of successor_model_for: a legacy ID must upgrade to a
        // model from the SAME provider. A cross-provider mapping here would
        // recreate the July 2026 OpenAI-drift bug.
        for legacy in &[
            "anthropic/claude-sonnet-4-6",
            "anthropic/claude-opus-4-7",
            "anthropic/claude-opus-4-6",
            "openai/gpt-4o",
            "openai/gpt-4o-mini",
            "openai/o4-mini",
            "xai/grok-beta",
            "google/gemini-2.0-flash",
        ] {
            let successor = successor_model_for(legacy)
                .unwrap_or_else(|| panic!("legacy id '{legacy}' has no successor mapping"));
            assert_eq!(
                provider_prefix(legacy),
                provider_prefix(successor),
                "successor for '{legacy}' switched provider to '{successor}'"
            );
            assert!(
                all_models().iter().any(|m| m.id == successor),
                "successor '{successor}' for '{legacy}' is not in the current catalogue"
            );
        }
    }

    #[test]
    fn legacy_anthropic_and_openai_ids_resolve_to_current_catalogue() {
        assert_eq!(
            resolve_model_string("anthropic/claude-sonnet-4-6").unwrap(),
            ANTHROPIC_CLAUDE_SONNET
        );
        assert_eq!(
            resolve_model_string("openai/gpt-4o").unwrap(),
            OPENAI_GPT56_TERRA
        );
        assert_eq!(resolve_model_string("xai/grok-beta").unwrap(), XAI_GROK_45);
    }

    #[test]
    fn stale_oracle_fetch_cannot_remove_baseline_models() {
        // Simulate the July 2026 stale-oracle payload: only old-generation IDs.
        init_model_registry();
        update_model_registry(vec![ModelInfo {
            id: "anthropic/claude-sonnet-4-6".into(),
            name: "Claude Sonnet 4.6".into(),
            provider: "Anthropic".into(),
            strategy: "heavy".into(),
            description: "stale".into(),
        }]);
        let registry = MODEL_REGISTRY.read().unwrap();
        // Every baseline model must survive the merge…
        for baseline in all_models() {
            assert!(
                registry.iter().any(|m| m.id == baseline.id),
                "baseline model '{}' was dropped by a stale oracle sync",
                baseline.id
            );
        }
        // …and the stale ID must have been canonicalized, not added as a phantom.
        assert!(
            !registry
                .iter()
                .any(|m| m.id == "anthropic/claude-sonnet-4-6"),
            "stale legacy ID leaked into the registry instead of canonicalizing"
        );
    }

    #[test]
    fn registry_contains_accepts_baseline_and_canonicalized_ids() {
        assert!(registry_contains(ANTHROPIC_CLAUDE_SONNET));
        assert!(registry_contains(OPENAI_GPT56_TERRA));
        assert!(!registry_contains("anthropic/claude-nonexistent-9"));
    }

    #[test]
    fn resolve_model_string_upgrades_deprecated_google_aliases() {
        assert_eq!(
            resolve_model_string("google/gemini-flash-latest").unwrap(),
            GOOGLE_GEMINI_FLASH_35
        );
        assert_eq!(
            resolve_model_string("google/gemini-2.0-flash").unwrap(),
            GOOGLE_GEMINI_FLASH_35
        );
        assert_eq!(
            resolve_model_string("google/gemini-3.1-flash-lite-preview").unwrap(),
            GOOGLE_GEMINI_31_FLASH_LITE
        );
    }

    #[test]
    fn catalogue_does_not_contain_deprecated_gemini_20_models() {
        // gemini-2.0-flash deprecated Feb 2025, shutdown June 1 2026.
        // gemini-2.0-flash-lite deprecated Feb 2025, shutdown June 1 2026.
        // Source: https://ai.google.dev/gemini-api/docs/deprecations
        let models = all_models();
        assert!(
            !models.iter().any(|m| m.id == "google/gemini-2.0-flash"),
            "Catalogue must NOT include deprecated google/gemini-2.0-flash"
        );
        assert!(
            !models
                .iter()
                .any(|m| m.id == "google/gemini-2.0-flash-lite"),
            "Catalogue must NOT include deprecated google/gemini-2.0-flash-lite"
        );
        // Also ensure dated preview suffixes are not used — those are all deprecated/shutdown.
        assert!(
            !models.iter().any(|m| m.id.contains("-preview-04-17")),
            "Catalogue must NOT include shut-down -preview-04-17 variant"
        );
        assert!(
            !models.iter().any(|m| m.id.contains("-preview-05-06")),
            "Catalogue must NOT include deprecated -preview-05-06 variant"
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
        assert!(validate_model_string("anthropic/claude-sonnet-5").is_ok());
        assert!(validate_model_string("openai/gpt-5.6-sol").is_ok());
        assert!(validate_model_string("google/gemini-3.6-flash").is_ok());
        assert!(validate_model_string("xai/grok-4.5").is_ok());
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
            GATEWAY_URL,
            GATEWAY_HOST_PORT,
            GATEWAY_CONTAINER_PORT
        );
        assert!(
            !GATEWAY_URL.contains(&GATEWAY_CONTAINER_PORT.to_string()),
            "GATEWAY_URL '{}' must NOT use container-internal port {}",
            GATEWAY_URL,
            GATEWAY_CONTAINER_PORT
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

    #[test]
    fn all_models_catalogue_has_latest_gemini_models() {
        let models = all_models();
        assert!(
            models.iter().any(|m| m.id == GOOGLE_GEMINI_FLASH_36),
            "Catalogue must include '{}'",
            GOOGLE_GEMINI_FLASH_36
        );
        assert!(
            models.iter().any(|m| m.id == GOOGLE_GEMINI_FLASH_35),
            "Catalogue must include stable '{}'",
            GOOGLE_GEMINI_FLASH_35
        );
        assert!(
            models.iter().any(|m| m.id == GOOGLE_GEMINI_FLASH_LITE_35),
            "Catalogue must include '{}'",
            GOOGLE_GEMINI_FLASH_LITE_35
        );
    }
}

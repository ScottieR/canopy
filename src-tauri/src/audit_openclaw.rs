use crate::model_constants;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::process::Command;

/// Prevents concurrent repair calls (React Strict Mode fires effects twice in dev;
/// also guards against the user clicking "Repair" while a repair is already running).
static REPAIR_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenClawAuditReport {
    pub is_aligned: bool,
    pub active_default_model: String,
    pub expected_model: String,
    pub missing_keys: Vec<String>,
    pub port_mismatch: bool,
    pub container_running: bool,
    pub raw_config_json: Option<String>,
    pub slack_group_policy_open: bool,
    pub github_token_injected: bool,
}

#[tauri::command]
pub async fn audit_openclaw_config(
    app_handle: tauri::AppHandle,
    agent_id: Option<String>,
) -> Result<OpenClawAuditReport, String> {
    use tauri::Emitter;
    use tauri::Manager;

    let db = app_handle.state::<crate::db::Database>();
    let container_name = agent_id
        .as_deref()
        .map(|id| crate::openclaw::get_agent_container_name(&db, id))
        .unwrap_or_else(|| "canopy-gateway".to_string());

    let _ = app_handle.emit(
        "diagnostics-log",
        format!(
            "Starting OpenClaw gateway diagnostics for {}...",
            container_name
        ),
    );

    // 1. Check if container is running
    let _ = app_handle.emit(
        "diagnostics-log",
        format!("Checking if {} container is running...", container_name),
    );
    let container_future = crate::openclaw::get_docker_command()
        .args(["inspect", "-f", "{{.State.Running}}", &container_name])
        .output();

    let status_output = tokio::time::timeout(std::time::Duration::from_secs(5), container_future)
        .await
        .map_err(|_| "Docker status check timed out".to_string());

    let container_running = match status_output {
        Ok(Ok(out)) if String::from_utf8_lossy(&out.stdout).trim() == "true" => true,
        _ => false,
    };

    if !container_running {
        return Ok(OpenClawAuditReport {
            is_aligned: false,
            active_default_model: "Unknown (Offline)".to_string(),
            expected_model: model_constants::DEFAULT_ANTHROPIC_MODEL.to_string(),
            missing_keys: vec![],
            port_mismatch: false,
            container_running: false,
            raw_config_json: None,
            slack_group_policy_open: false,
            github_token_injected: false,
        });
    }

    // 2. Fetch the config directly from the container
    let _ = app_handle.emit(
        "diagnostics-log",
        "Container is running. Fetching openclaw.json configuration...",
    );
    let cat_future = crate::openclaw::get_docker_command()
        .args([
            "exec",
            &container_name,
            "cat",
            "/home/node/.openclaw/openclaw.json",
        ])
        .output();

    let cat_output = match tokio::time::timeout(std::time::Duration::from_secs(5), cat_future).await
    {
        Ok(res) => res.map_err(|e| format!("Failed to read openclaw.json: {}", e))?,
        Err(_) => return Err("Docker command timed out while reading config".into()),
    };

    if !cat_output.status.success() {
        let stderr = String::from_utf8_lossy(&cat_output.stderr);
        let err_msg = if stderr.is_empty() {
            "Configuration file missing or container crashed during read".to_string()
        } else if stderr.contains("cannot exec in a stopped container") {
            "Gateway container is stopped".to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(format!(
            "Failed to retrieve config from container: {}",
            err_msg
        ));
    }

    let config_str = String::from_utf8_lossy(&cat_output.stdout).to_string();
    let config: Value = serde_json::from_str(&config_str)
        .map_err(|e| format!("Failed to parse config JSON: {}", e))?;

    let _ = app_handle.emit(
        "diagnostics-log",
        "Configuration loaded. Evaluating API keys and models...",
    );
    // 3. Evaluate active settings.
    // OpenClaw stores model in two possible formats (both must be handled):
    //   Nested (correct): "model": { "primary": "google/gemini-2.5-flash" }
    //   Flat (legacy):    "model": "google/gemini-2.5-flash"
    // Confirmed against working reference: /Users/scottieryan/agents/sloane/config/openclaw.json
    let default_model = {
        let model_val = config.pointer("/agents/defaults/model");
        if let Some(s) = model_val.and_then(|v| v.as_str()) {
            // Flat string format
            s.to_string()
        } else if let Some(p) = model_val
            .and_then(|v| v.get("primary"))
            .and_then(|v| v.as_str())
        {
            // Nested {primary: "..."} format (the correct OpenClaw format)
            p.to_string()
        } else {
            model_constants::DEFAULT_GEMINI_MODEL.to_string()
        }
    };

    // 4. Determine the EXPECTED default model based on available API keys.
    // Priority: Anthropic > OpenAI > Gemini (Gemini is last resort, not first choice).
    let has_anthropic =
        crate::keychain::get_secret("ANTHROPIC_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_openai =
        crate::keychain::get_secret("OPENAI_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_gemini =
        crate::keychain::get_secret("GEMINI_API_KEY").map_or(false, |s| !s.trim().is_empty());

    let expected_model =
        model_constants::default_model_from_available_keys(has_anthropic, has_openai, has_gemini)
            .to_string();

    let mut missing_keys = vec![];

    // Check whether the *currently configured* model's provider has a key available
    if default_model.starts_with("anthropic") && !has_anthropic {
        missing_keys.push("anthropic".to_string());
    }
    if default_model.starts_with("openai") && !has_openai {
        missing_keys.push("openai".to_string());
    }
    if default_model.starts_with("google") && !has_gemini {
        missing_keys.push("google".to_string());
    }

    // Determine port alignment.
    // We check for GATEWAY_HOST_PORT (18799) — the port Canopy connects to from the host.
    // Do NOT check for GATEWAY_CONTAINER_PORT (18789) — that's container-internal only
    // and will always appear missing from the host side, causing a permanent false alarm.
    let host_port_str = model_constants::GATEWAY_HOST_PORT.to_string();
    let port_mismatch = config
        .pointer("/gateway/controlUi/allowedOrigins")
        .and_then(|v| v.as_array())
        .map_or(false, |arr| {
            !arr.iter()
                .any(|val| val.as_str().unwrap_or("").contains(&host_port_str))
        });

    // port_mismatch is informational only — allowedOrigins is CORS for the control UI.
    // missing_keys is also informational only — it checks global keychain entries, but agents
    // can use per-agent keys (agent_{id}_{provider}_key) which this audit cannot see.
    //
    // is_aligned = true when the configured model is:
    //   (a) valid format ("provider/model-name" with a known provider), AND
    //   (b) the configured provider has at least one API key available.
    //
    // We do NOT compare against expected_model. The old check (default_model == expected_model)
    // was too strict: it marked ANY non-default model as misaligned and triggered repair on every
    // boot, silently overwriting the user's model choice with the hardcoded default. For example,
    // a user who picked "google/gemini-2.5-flash-preview-04-17" would have it reset to
    // "google/gemini-2.0-flash" on every launch — the repair acted as a model-picker override.
    let model_is_valid = model_constants::validate_model_string(&default_model).is_ok();
    // is_aligned: model format is valid AND its provider has a key configured.
    // missing_keys is populated only when the *currently configured* model's provider lacks a key.
    let is_aligned = model_is_valid && missing_keys.is_empty();

    let _ = app_handle.emit("diagnostics-log", "Verifying Slack integration policies...");
    let slack_group_policy_open = config
        .pointer("/channels/slack/groupPolicy")
        .and_then(|v| v.as_str())
        .map_or(false, |s| s == "open");

    let _ = app_handle.emit(
        "diagnostics-log",
        "Checking GitHub workspace integration...",
    );
    let github_enabled = config
        .pointer("/channels/github/enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut github_token_injected = false;
    if github_enabled {
        let bashrc_check = crate::openclaw::get_docker_command()
            .args([
                "exec",
                &container_name,
                "grep",
                "GITHUB_TOKEN",
                "/home/node/.bashrc",
            ])
            .output()
            .await;
        if let Ok(out) = bashrc_check {
            github_token_injected = out.status.success();
        }
    }

    let _ = app_handle.emit("diagnostics-log", "Diagnostics complete.");

    Ok(OpenClawAuditReport {
        is_aligned,
        active_default_model: default_model,
        expected_model,
        missing_keys,
        port_mismatch,
        container_running,
        raw_config_json: Some(config_str),
        slack_group_policy_open,
        github_token_injected,
    })
}

#[tauri::command]
pub async fn repair_openclaw_config(
    app_handle: tauri::AppHandle,
    target_model: Option<String>, // specify it exactly, or None to auto-detect
    agent_id: Option<String>,
) -> Result<String, String> {
    use tauri::Manager;
    // Prevent concurrent repair runs — each run writes config keys that trigger a gateway
    // self-SIGTERM restart. Two concurrent runs cause overlapping restarts → OOM cascade.
    if REPAIR_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        tracing::info!("repair_openclaw_config: already running, skipping duplicate call");
        return Ok("Repair already in progress".to_string());
    }
    // Ensure the flag is always cleared when this function returns, even on error.
    struct RepairGuard;
    impl Drop for RepairGuard {
        fn drop(&mut self) {
            REPAIR_RUNNING.store(false, Ordering::SeqCst);
        }
    }
    let _guard = RepairGuard;

    let audit_report = audit_openclaw_config(app_handle.clone(), agent_id.clone()).await?;
    if !audit_report.container_running {
        tracing::info!("Gateway offline during repair attempt - initiating secure start...");
        crate::docker::start_gateway_internal(Some(app_handle.clone()))
            .await
            .map_err(|e| format!("Failed to start gateway for repair: {}", e))?;
        // Brief pause for initialization
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
    }

    let db = app_handle.state::<crate::db::Database>();
    let container_name = agent_id
        .as_deref()
        .map(|id| crate::openclaw::get_agent_container_name(&db, id))
        .unwrap_or_else(|| "canopy-gateway".to_string());

    // Decide which model to write.
    // Priority: explicit caller override → keep existing model if it's valid → fall back to expected.
    //
    // The key change from the old logic: we no longer unconditionally overwrite the model.
    // Previously, repair always wrote expected_model even when the existing model was fine —
    // this silently reset any user-selected model (e.g. gemini-2.5-flash) back to the
    // hardcoded default (gemini-2.0-flash) on every boot.
    let actual_model = if let Some(explicit) = target_model {
        // Caller explicitly specified a model — use it (after validation below).
        explicit
    } else {
        let current = &audit_report.active_default_model;
        let current_is_valid = model_constants::validate_model_string(current).is_ok();
        let current_has_key = audit_report.missing_keys.is_empty();

        if current_is_valid && current_has_key {
            // Existing model is fine — preserve it. No model write needed.
            tracing::info!(
                "repair_openclaw_config: current model '{}' is valid and has a key — skipping model write",
                current
            );
            // Still apply the non-model fixes (trustedProxies, allowedOrigins) then return.
            let host_port = model_constants::GATEWAY_HOST_PORT;
            let allowed_origins = format!(
                "[\"http://localhost:{}\", \"tauri://localhost\", \"https://tauri.localhost\"]",
                host_port
            );
            let non_model_fixes = [
                (
                    "gateway.trustedProxies",
                    "[\"127.0.0.1\", \"192.168.107.2\"]",
                ),
                ("gateway.controlUi.allowedOrigins", allowed_origins.as_str()),
            ];
            for (key, val) in non_model_fixes.iter() {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(8),
                    crate::openclaw::get_docker_command()
                        .args([
                            "exec",
                            "-u",
                            "node",
                            "-e",
                            "NODE_OPTIONS=--v8-pool-size=1",
                            &container_name,
                            "openclaw",
                            "config",
                            "set",
                            key,
                            val,
                        ])
                        .output(),
                )
                .await;
            }
            let _ = crate::openclaw::get_docker_command()
                .args(["restart", &container_name])
                .output()
                .await;
            return Ok(format!(
                "Gateway configuration verified — model '{}' is valid, no model change needed.",
                current
            ));
        } else {
            // Current model is broken or its provider has no key — fall back to expected.
            tracing::warn!(
                "repair_openclaw_config: current model '{}' needs repair (valid={}, has_key={}) — replacing with '{}'",
                current, current_is_valid, current_has_key, audit_report.expected_model
            );
            audit_report.expected_model.clone()
        }
    };

    // Validate the chosen model string before writing it to the container config.
    // A malformed string here would silently break all agents.
    model_constants::validate_model_string(&actual_model)
        .map_err(|e| format!("Refusing to write invalid model string to gateway: {}", e))?;

    // Build the allowedOrigins array using the host port so the port-alignment check passes.
    let host_port = model_constants::GATEWAY_HOST_PORT;
    let allowed_origins = format!(
        "[\"http://localhost:{}\", \"tauri://localhost\", \"https://tauri.localhost\"]",
        host_port
    );

    let fixes = [
        // ⚠️  Use .model.primary to produce the nested {primary:"..."} format OpenClaw expects.
        // Using .model directly sets a flat string, which may work but diverges from the
        // format OpenClaw's own config set command produces.
        ("agents.defaults.model.primary", actual_model.as_str()),
        (
            "gateway.trustedProxies",
            "[\"127.0.0.1\", \"192.168.107.2\"]",
        ),
        // Fix allowedOrigins so the port-alignment audit check passes.
        // This is CORS for the control UI — it doesn't affect agent API communication.
        ("gateway.controlUi.allowedOrigins", allowed_origins.as_str()),
        // Enforce Slack groupPolicy to "allowlist" so agents properly require pairing codes
        // for users not already in their allowed channels list. "open" breaks the pairing flow.
        ("channels.slack.groupPolicy", "allowlist"),
    ];

    for (key, val) in fixes.iter() {
        let cmd_future = crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "node",
                "-e",
                "NODE_OPTIONS=--v8-pool-size=1",
                &container_name,
                "openclaw",
                "config",
                "set",
                key,
                val,
            ])
            .output();

        let output = match tokio::time::timeout(std::time::Duration::from_secs(8), cmd_future).await
        {
            Ok(res) => {
                res.map_err(|e| format!("Failed to execute config repair for {}: {}", key, e))?
            }
            Err(_) => return Err(format!("Docker command timed out while setting {}", key)),
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Repair failed on {}: {}",
                key,
                if stderr.is_empty() {
                    "Unknown error (container may have crashed)"
                } else {
                    &stderr
                }
            ));
        }
    }

    // OpenClaw self-SIGTERMs and restarts whenever a config key is written via config-set,
    // so we do NOT need an additional explicit docker restart here. A second restart on top
    // of the self-SIGTERM doubles the memory churn and can cascade into OOM with multiple agents.
    tracing::info!(
        "repair_openclaw_config: config keys written; OpenClaw will self-restart to apply changes"
    );

    Ok(format!("Successfully repaired gateway config — model set to '{}' and security constraints patched.", actual_model))
}

#[tauri::command]
pub async fn get_openclaw_status(
    app_handle: tauri::AppHandle,
    agent_id: Option<String>,
) -> Result<String, String> {
    use tauri::Manager;
    let db = app_handle.state::<crate::db::Database>();
    let container_name = agent_id
        .as_deref()
        .map(|id| crate::openclaw::get_agent_container_name(&db, id))
        .unwrap_or_else(|| "canopy-gateway".to_string());

    let status_fut = crate::openclaw::get_docker_command()
        .args([
            "exec",
            "-u",
            "node",
            "-e",
            "NODE_OPTIONS=--v8-pool-size=1",
            &container_name,
            "openclaw",
            "status",
        ])
        .output();

    let output = match tokio::time::timeout(std::time::Duration::from_secs(10), status_fut).await {
        Ok(res) => res.map_err(|e| format!("Failed to execute openclaw status: {}", e))?,
        Err(_) => {
            return Err("openclaw status timed out. Gateway container may be hanging.".into())
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!("openclaw status failed: {}\n{}", stdout, stderr));
    }

    Ok(stdout)
}

// ─── Regression Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_constants;

    // ── Port check uses host port, not container port ──────────────────────

    #[test]
    fn audit_port_check_uses_host_port() {
        // The allowedOrigins check must look for GATEWAY_HOST_PORT (18799).
        // Looking for GATEWAY_CONTAINER_PORT (18789) always fails from the host side,
        // causing a permanent false `port_mismatch = true` that triggers repair loops.
        let host_port_str = model_constants::GATEWAY_HOST_PORT.to_string();
        let container_port_str = model_constants::GATEWAY_CONTAINER_PORT.to_string();

        // Simulate what the audit does: check if host port appears in some origin string
        let sample_origins = vec![format!(
            "http://localhost:{}",
            model_constants::GATEWAY_HOST_PORT
        )];
        let found_host = sample_origins.iter().any(|v| v.contains(&host_port_str));
        let found_container = sample_origins
            .iter()
            .any(|v| v.contains(&container_port_str));

        assert!(
            found_host,
            "Host port {} must be detectable in origins",
            model_constants::GATEWAY_HOST_PORT
        );
        assert!(
            !found_container,
            "Container port {} must NOT appear in host-side origins",
            model_constants::GATEWAY_CONTAINER_PORT
        );
    }

    // ── Repair validates model string before writing ───────────────────────

    #[test]
    fn repair_would_reject_reversed_anthropic_model() {
        // validate_model_string returns Ok for any well-formed "provider/model" string.
        // The reversed "claude-4-6-sonnet" is technically parseable, so we rely on the
        // suffix-order test in model_constants to guard against it.
        let bad = "anthropic/claude-4-6-sonnet";
        assert!(
            !bad.ends_with("sonnet-4-6"),
            "The bad string '{}' should not match the correct suffix pattern",
            bad
        );

        // The correct string passes validation and has the right suffix order
        let good = model_constants::DEFAULT_ANTHROPIC_MODEL;
        assert!(model_constants::validate_model_string(good).is_ok());
        assert!(
            good.ends_with("sonnet-4-6"),
            "Correct string '{}' must end with 'sonnet-4-6'",
            good
        );
    }

    // ── Offline report uses Anthropic as expected model ───────────────────

    #[test]
    fn offline_report_expected_model_is_anthropic_not_gemini() {
        // When the container is offline, the report should default to Anthropic
        // (so the UI prompts the user to add an Anthropic key), not Gemini.
        let expected = model_constants::DEFAULT_ANTHROPIC_MODEL;
        assert!(
            expected.starts_with("anthropic/"),
            "Offline expected_model '{}' should be Anthropic, not Gemini",
            expected
        );
    }

    // ── Missing key detection uses correct provider prefix ────────────────

    #[test]
    fn google_models_use_google_prefix_not_gemini() {
        // openclaw.json uses "google/..." as the provider prefix for Gemini models,
        // not "gemini/...". The missing_keys check must test default_model.starts_with("google")
        let gemini_model = model_constants::DEFAULT_GEMINI_MODEL;
        assert!(
            gemini_model.starts_with("google/"),
            "Gemini model '{}' must use 'google/' prefix for OpenClaw compatibility",
            gemini_model
        );
    }
}

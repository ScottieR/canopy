use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenClawAuditReport {
    pub is_aligned: bool,
    pub active_default_model: String,
    pub expected_model: String,
    pub missing_keys: Vec<String>,
    pub port_mismatch: bool,
    pub container_running: bool,
    pub raw_config_json: Option<String>,
}

#[tauri::command]
pub async fn audit_openclaw_config(
    app_handle: tauri::AppHandle,
) -> Result<OpenClawAuditReport, String> {
    // 1. Check if container is running
    let container_future = crate::openclaw::get_docker_command()
        .args(["inspect", "-f", "{{.State.Running}}", "canopy-gateway"])
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
             expected_model: crate::models::DEFAULT_GEMINI_MODEL.to_string(),
             missing_keys: vec![],
             port_mismatch: false,
             container_running: false,
             raw_config_json: None,
        });
    }

    // 2. Fetch the config directly from the container
    let cat_future = crate::openclaw::get_docker_command()
        .args(["exec", "canopy-gateway", "cat", "/home/node/.openclaw/openclaw.json"])
        .output();

    let cat_output = match tokio::time::timeout(std::time::Duration::from_secs(5), cat_future).await {
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
        return Err(format!("Failed to retrieve config from container: {}", err_msg));
    }

    let config_str = String::from_utf8_lossy(&cat_output.stdout).to_string();
    let config: Value = serde_json::from_str(&config_str)
        .map_err(|e| format!("Failed to parse config JSON: {}", e))?;

    // 3. Evaluate active settings
    let default_model = config.pointer("/agents/defaults/model")
        .and_then(|v| v.as_str())
        .unwrap_or(&crate::models::get_dynamic_default_model("anthropic"))
        .to_string();

    // 4. Determine our EXPECTED default model based on available keys
    // If no keys, it defaults to the gemini fallback model.
    let mut expected_model = crate::models::get_dynamic_default_model("gemini");
    let mut missing_keys = vec![];

    let has_openai = crate::keychain::get_secret("OPENAI_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_anthropic = crate::keychain::get_secret("ANTHROPIC_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_gemini = crate::keychain::get_secret("GEMINI_API_KEY").map_or(false, |s| !s.trim().is_empty());

    if has_gemini {
        expected_model = crate::models::get_dynamic_default_model("gemini");
    } else if has_openai {
        expected_model = crate::models::get_dynamic_default_model("openai");
    } else if has_anthropic {
        expected_model = crate::models::get_dynamic_default_model("anthropic");
    }

    if default_model.starts_with("anthropic") && !has_anthropic {
        missing_keys.push("anthropic".to_string());
    }
    if default_model.starts_with("openai") && !has_openai {
        missing_keys.push("openai".to_string());
    }
    if default_model.starts_with("gemini") && !has_gemini {
        missing_keys.push("gemini".to_string());
    }

    // Determine port alignment (checking controlUi allowedOrigins)
    let port_mismatch = config.pointer("/gateway/controlUi/allowedOrigins")
        .and_then(|v| v.as_array())
        .map_or(false, |arr| !arr.iter().any(|val| val.as_str().unwrap_or("").contains("18789")));

    let is_aligned = missing_keys.is_empty() && !port_mismatch && default_model == expected_model;

    Ok(OpenClawAuditReport {
        is_aligned,
        active_default_model: default_model,
        expected_model,
        missing_keys,
        port_mismatch,
        container_running,
        raw_config_json: Some(config_str),
    })
}

#[tauri::command]
pub async fn repair_openclaw_config(
    app_handle: tauri::AppHandle,
    target_model: Option<String> // specify it exactly, or None to auto-detect
) -> Result<String, String> {
    let mut model_to_set = target_model;

    let audit_report = audit_openclaw_config(app_handle.clone()).await?;
    if !audit_report.container_running {
        tracing::info!("Gateway offline during repair attempt - initiating secure start...");
        crate::docker::start_gateway().await.map_err(|e| format!("Failed to start gateway for repair: {}", e))?;
        // Brief pause for initialization
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
    }

    if model_to_set.is_none() {
        model_to_set = Some(audit_report.expected_model);
    }

    let actual_model = model_to_set.unwrap();

    let fixes = [
        ("agents.defaults.model", actual_model.as_str()),
        ("gateway.trustedProxies", "[\"127.0.0.1\", \"192.168.107.2\"]"),
        ("channels.slack.groupPolicy", "allowlist"),
    ];

    for (key, val) in fixes.iter() {
        let cmd_future = crate::openclaw::get_docker_command()
            .args(["exec", "canopy-gateway", "openclaw", "config", "set", key, val])
            .output();

        let output = match tokio::time::timeout(std::time::Duration::from_secs(8), cmd_future).await {
            Ok(res) => res.map_err(|e| format!("Failed to execute config repair for {}: {}", key, e))?,
            Err(_) => return Err(format!("Docker command timed out while setting {}", key)),
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Repair failed on {}: {}", key, if stderr.is_empty() { "Unknown error (container may have crashed)" } else { &stderr }));
        }
    }

    // A gateway restart is required to apply trustedProxies and groupPolicy changes
    crate::openclaw::get_docker_command()
        .args(["restart", "canopy-gateway"])
        .output()
        .await
        .map_err(|e| format!("Failed to restart gateway: {}", e))?;

    Ok(format!("Successfully aligned defaults to {} and patched security constraints.", actual_model))
}

#[tauri::command]
pub async fn get_openclaw_status() -> Result<String, String> {
    let status_fut = crate::openclaw::get_docker_command()
        .args(["exec", "canopy-gateway", "openclaw", "status"])
        .output();

    let output = match tokio::time::timeout(std::time::Duration::from_secs(10), status_fut).await {
         Ok(res) => res.map_err(|e| format!("Failed to execute openclaw status: {}", e))?,
         Err(_) => return Err("openclaw status timed out. Gateway container may be hanging.".into()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!("openclaw status failed: {}\n{}", stdout, stderr));
    }

    Ok(stdout)
}

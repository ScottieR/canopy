use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;
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
    let status_output = Command::new("docker")
        .args(["inspect", "-f", "{{.State.Running}}", "canopy-gateway"])
        .output();

    let container_running = match status_output {
        Ok(out) if String::from_utf8_lossy(&out.stdout).trim() == "true" => true,
        _ => false,
    };

    if !container_running {
        return Ok(OpenClawAuditReport {
             is_aligned: false,
             active_default_model: "Unknown (Offline)".to_string(),
             expected_model: "google/gemini-3.1-flash".to_string(),
             missing_keys: vec![],
             port_mismatch: false,
             container_running: false,
             raw_config_json: None,
        });
    }

    // 2. Fetch the config directly from the container
    let cat_output = Command::new("docker")
        .args(["exec", "canopy-gateway", "cat", "/home/node/.openclaw/openclaw.json"])
        .output()
        .map_err(|e| format!("Failed to read openclaw.json: {}", e))?;

    if !cat_output.status.success() {
        return Err(format!("Failed to retrieve config from container: {}", String::from_utf8_lossy(&cat_output.stderr)));
    }

    let config_str = String::from_utf8_lossy(&cat_output.stdout).to_string();
    let config: Value = serde_json::from_str(&config_str)
        .map_err(|e| format!("Failed to parse config JSON: {}", e))?;

    // 3. Evaluate active settings
    let default_model = config.pointer("/agents/defaults/model")
        .and_then(|v| v.as_str())
        .unwrap_or("anthropic/claude-4-6-sonnet")
        .to_string();

    // 4. Determine our EXPECTED default model based on available keys
    // If no keys, it defaults to google/gemini-3.1-flash.
    let mut expected_model = "google/gemini-3.1-flash".to_string();
    let mut missing_keys = vec![];

    let has_openai = crate::keychain::get_secret("OPENAI_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_anthropic = crate::keychain::get_secret("ANTHROPIC_API_KEY").map_or(false, |s| !s.trim().is_empty());
    let has_gemini = crate::keychain::get_secret("GEMINI_API_KEY").map_or(false, |s| !s.trim().is_empty());

    if has_gemini {
        expected_model = "google/gemini-3.1-flash".to_string();
    } else if has_openai {
        expected_model = "openai/gpt-4o".to_string();
    } else if has_anthropic {
        expected_model = "anthropic/claude-4-6-sonnet".to_string();
    }

    // If default_model is anthropic but we lack keys, it's misaligned!
    if default_model.starts_with("anthropic") && !has_anthropic {
        missing_keys.push("anthropic".to_string());
    }
    if default_model.starts_with("openai") && !has_openai {
        missing_keys.push("openai".to_string());
    }
    if default_model.starts_with("google") && !has_gemini {
        missing_keys.push("google".to_string());
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

    if model_to_set.is_none() {
        let report = audit_openclaw_config(app_handle.clone()).await?;
        model_to_set = Some(report.expected_model);
    }

    let actual_model = model_to_set.unwrap();

    // Use docker exec to cleanly modify the JSON using OpenClaw's own schema updater
    let cmd_status = Command::new("docker")
        .args([
            "exec", "canopy-gateway", 
            "openclaw", "config", "set", "agents.defaults.model", &actual_model
        ])
        .output()
        .map_err(|e| format!("Failed to execute config repair: {}", e))?;

    if !cmd_status.status.success() {
        return Err(format!("Repair failed: {}", String::from_utf8_lossy(&cmd_status.stderr)));
    }

    Ok(format!("Successfully aligned defaults to {}", actual_model))
}

#[tauri::command]
pub async fn get_openclaw_status() -> Result<String, String> {
    let output = Command::new("docker")
        .args(["exec", "canopy-gateway", "openclaw", "status"])
        .output()
        .map_err(|e| format!("Failed to execute openclaw status: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!("openclaw status failed: {}\n{}", stdout, stderr));
    }

    Ok(stdout)
}

use crate::db::{Database, SecurityAlert};
use chrono::Utc;
use std::collections::HashMap;
use std::fs;
use tauri::Emitter;
use tauri::Manager;
use tokio::time::{sleep, Duration};
use uuid::Uuid;

// Map of Agent ID -> Last checked timestamp for terminal history
// to avoid alerting on the same event multiple times.
lazy_static::lazy_static! {
    static ref LAST_CHECKED: std::sync::Mutex<HashMap<String, String>> = std::sync::Mutex::new(HashMap::new());
}

pub fn start_sniffer_daemon(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            sleep(Duration::from_secs(10)).await;

            let db = match app_handle.try_state::<Database>() {
                Some(state) => state,
                None => continue,
            };

            let agents = match db.list_agents() {
                Ok(a) => a,
                Err(_) => continue,
            };

            let workspace_base = match dirs::data_dir() {
                Some(dir) => dir.join("Canopy").join("openclaw-state").join("workspace"),
                None => continue,
            };

            for agent in agents {
                if agent.paused {
                    continue; // Skip already paused agents
                }

                let history_file = workspace_base
                    .join(&agent.id)
                    .join(".terminal_history.json");
                if !history_file.exists() {
                    continue;
                }

                let content = match fs::read_to_string(&history_file) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let history: Vec<serde_json::Value> = match serde_json::from_str(&content) {
                    Ok(h) => h,
                    Err(_) => continue,
                };

                let last_ts = {
                    let last_checked = LAST_CHECKED.lock().unwrap();
                    last_checked.get(&agent.id).cloned().unwrap_or_default()
                };
                let mut new_last_ts = last_ts.clone();

                for entry in history {
                    if let Some(ts) = entry.get("timestamp").and_then(|t| t.as_str()) {
                        if ts <= last_ts.as_str() {
                            continue;
                        }
                        if ts > new_last_ts.as_str() {
                            new_last_ts = ts.to_string();
                        }

                        if let Some(command) = entry.get("command").and_then(|c| c.as_str()) {
                            let (is_suspicious, severity, reason) =
                                analyze_command_for_egress(command);

                            if is_suspicious {
                                let alert = SecurityAlert {
                                    id: Uuid::new_v4().to_string(),
                                    agent_id: agent.id.clone(),
                                    timestamp: Utc::now().to_rfc3339(),
                                    severity: severity.clone(),
                                    description: reason.clone(),
                                    resolved: false,
                                };

                                let _ = db.insert_security_alert(&alert);

                                // Automatically pause the agent if severity is Critical
                                if severity == "Critical" || severity == "High" {
                                    tracing::warn!(
                                        "Auto-pausing agent {} due to high-risk network egress: {}",
                                        agent.id,
                                        reason
                                    );
                                    let _ = db.set_agent_paused(&agent.id, true);

                                    let container_name =
                                        crate::openclaw::get_agent_container_name(&db, &agent.id);
                                    let _ = crate::openclaw::get_docker_command()
                                        .args([
                                            "exec",
                                            "-u",
                                            "node",
                                            "-e",
                                            "NODE_OPTIONS=--v8-pool-size=1",
                                            &container_name,
                                            "openclaw",
                                            "agents",
                                            "remove",
                                            &agent.id,
                                        ])
                                        .output()
                                        .await;

                                    // Stop the machine browser if running
                                    let browser_manager = app_handle
                                        .state::<crate::browser_manager::BrowserManager>(
                                    );
                                    let _ = browser_manager.stop_browser(&agent.id).await;
                                }

                                // Emit event to frontend to show the red badge
                                let _ = app_handle.emit("security_alert_created", &alert);
                            }
                        }
                    }
                }

                {
                    let mut last_checked = LAST_CHECKED.lock().unwrap();
                    last_checked.insert(agent.id.clone(), new_last_ts);
                }
            }
        }
    });
}

fn analyze_command_for_egress(command: &str) -> (bool, String, String) {
    let lower_cmd = command.to_lowercase();

    // Ignore the approved secure export bridge
    if lower_cmd.contains("18802/export_file") {
        return (false, "".to_string(), "".to_string());
    }

    // Heuristics for unauthorized file uploads
    if lower_cmd.contains("curl")
        && (lower_cmd.contains("-f ")
            || lower_cmd.contains("--form")
            || lower_cmd.contains("--data-binary")
            || lower_cmd.contains("-t "))
    {
        return (
            true,
            "High".to_string(),
            format!(
                "Detected unauthorized HTTP file upload via curl: {}",
                command.chars().take(100).collect::<String>()
            ),
        );
    }

    if lower_cmd.contains("wget") && lower_cmd.contains("--post-file") {
        return (
            true,
            "High".to_string(),
            "Detected unauthorized HTTP file upload via wget.".to_string(),
        );
    }

    if lower_cmd.contains("scp ") || lower_cmd.contains("rsync ") || lower_cmd.contains("sftp ") {
        return (
            true,
            "Critical".to_string(),
            "Detected SSH/SFTP file exfiltration attempt.".to_string(),
        );
    }

    if lower_cmd.contains("nc -") || lower_cmd.contains("netcat") {
        return (
            true,
            "Critical".to_string(),
            "Detected raw socket connection (potential reverse shell or exfiltration).".to_string(),
        );
    }

    if lower_cmd.contains("setinputfiles") {
        // Playwright file upload signature
        return (
            true,
            "Medium".to_string(),
            "Detected automated browser file upload.".to_string(),
        );
    }

    (false, "".to_string(), "".to_string())
}

#[tauri::command]
pub async fn get_network_security_alerts(
    db: tauri::State<'_, Database>,
) -> Result<Vec<SecurityAlert>, String> {
    db.get_active_security_alerts().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resolve_network_security_alert(
    db: tauri::State<'_, Database>,
    alert_id: String,
) -> Result<(), String> {
    db.resolve_security_alert(&alert_id)
        .map_err(|e| e.to_string())
}

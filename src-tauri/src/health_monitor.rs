use tauri::Emitter;
use tauri::Manager;
use tokio::time::{sleep, Duration};

pub fn start_health_monitor_daemon(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Brief initial delay to let the gateway start before we begin polling.
        sleep(Duration::from_secs(30)).await;

        loop {
            check_gateway_health(&app_handle).await;
            sleep(Duration::from_secs(60)).await;
        }
    });
}

/// Lightweight two-step gateway health check.
///
/// Step 1: `docker inspect` — fast syscall, tells us if the container process exists
///         and is in "running" state. No docker exec, no Node.js involvement.
///
/// Step 2: HTTP probe to /health — confirms the OpenClaw HTTP server is actually
///         accepting connections (not just that the process is alive).
///
/// Emits a `gateway-health` Tauri event so the frontend can show a reconnect prompt
/// if the gateway goes offline mid-session without a user-triggered action.
async fn check_gateway_health(app_handle: &tauri::AppHandle) {
    use crate::model_constants::gateway_url;
    use crate::openclaw::get_docker_command;

    // Step 1: Is the container running?
    let container_running = match tokio::time::timeout(
        Duration::from_secs(5),
        get_docker_command()
            .args([
                "inspect",
                "--format",
                "{{.State.Running}}",
                crate::flavor::gateway_container(),
            ])
            .output(),
    )
    .await
    {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).trim() == "true",
        _ => false,
    };

    if !container_running {
        tracing::warn!("health_monitor: canopy-gateway container is not running");
        let _ = app_handle.emit("gateway-health", serde_json::json!({ "status": "offline" }));
        return;
    }

    // Step 2: HTTP probe — is the gateway actually serving requests?
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            let _ = app_handle.emit("gateway-health", serde_json::json!({ "status": "active" }));
            return;
        }
    };

    let gateway_ok = client
        .get(format!("{}/health/stats", gateway_url()))
        .header(
            "Authorization",
            &crate::model_constants::gateway_bearer_header(),
        )
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    let status = if gateway_ok { "active" } else { "degraded" };
    tracing::debug!("health_monitor: gateway status = {}", status);
    let _ = app_handle.emit("gateway-health", serde_json::json!({ "status": status }));
}

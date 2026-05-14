use tauri::Manager;
use tokio::time::{sleep, Duration};
use crate::db::Database;
use crate::models::AgentBugReport;
use chrono::Utc;

pub fn start_health_monitor_daemon(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            // Background polling disabled to reduce event loop saturation and API rate limits.
            // Diagnostics and bug reporting now occur Just-In-Time (JIT) when an agent
            // is called up for a task (in `openclaw::send_message_internal`) or when 
            // the user explicitly pulls up the Diagnostics UI.
            sleep(Duration::from_secs(3600)).await;
        }
    });
}

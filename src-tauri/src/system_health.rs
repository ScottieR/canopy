use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

/// Startup-subsystem health registry.
///
/// Several subsystems (JIT auth server, dispatch WebSocket relay, keychain,
/// Slack token lookup) can fail at startup in ways that are survivable but
/// leave whole features silently dead — historically these were ERROR/WARN
/// logs only. Call sites report into this registry instead; the frontend
/// subscribes via the `system-health-changed` event (full snapshot payload)
/// and the `get_system_health` command, and shows a status indicator only
/// when something is degraded or failed.
///
/// Reporting is infallible and never blocks the reporting subsystem: if the
/// AppHandle isn't wired yet (report before `init`) the state is still
/// recorded and the snapshot is emitted once `init` runs.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Ok,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentHealth {
    /// Stable component id, e.g. "jit_server". Also used as the display key.
    pub component: String,
    pub status: HealthStatus,
    /// Short human-readable reason. None when status is Ok.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// What the user can do about it, e.g. "Close the other copy of Canopy".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

/// BTreeMap so snapshots have a stable order for the UI and tests.
static REGISTRY: OnceLock<Mutex<BTreeMap<String, ComponentHealth>>> = OnceLock::new();
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

fn registry() -> &'static Mutex<BTreeMap<String, ComponentHealth>> {
    REGISTRY.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Wire the registry to the app so reports emit `system-health-changed`.
/// Emits the current snapshot immediately in case subsystems reported
/// before setup completed.
pub fn init(app_handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app_handle);
    emit_snapshot();
}

pub fn report_ok(component: &str) {
    report(ComponentHealth {
        component: component.to_string(),
        status: HealthStatus::Ok,
        reason: None,
        remediation: None,
    });
}

pub fn report_degraded(component: &str, reason: impl Into<String>, remediation: impl Into<String>) {
    report(ComponentHealth {
        component: component.to_string(),
        status: HealthStatus::Degraded,
        reason: Some(reason.into()),
        remediation: Some(remediation.into()),
    });
}

pub fn report_failed(component: &str, reason: impl Into<String>, remediation: impl Into<String>) {
    report(ComponentHealth {
        component: component.to_string(),
        status: HealthStatus::Failed,
        reason: Some(reason.into()),
        remediation: Some(remediation.into()),
    });
}

fn report(entry: ComponentHealth) {
    {
        let mut map = registry().lock().unwrap_or_else(|p| p.into_inner());
        let unchanged = map.get(&entry.component) == Some(&entry);
        if unchanged {
            return;
        }
        map.insert(entry.component.clone(), entry);
    }
    emit_snapshot();
}

pub fn snapshot() -> Vec<ComponentHealth> {
    registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .values()
        .cloned()
        .collect()
}

fn emit_snapshot() {
    if let Some(handle) = APP_HANDLE.get() {
        let _ = handle.emit("system-health-changed", snapshot());
    }
}

#[tauri::command]
pub fn get_system_health() -> Vec<ComponentHealth> {
    snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The registry is a process-global; tests share it. Use distinct component
    // ids per test so they don't step on each other under parallel execution.

    #[test]
    fn report_and_snapshot_round_trip() {
        report_failed(
            "test_rt_jit",
            "Port 18802 in use",
            "Close the other copy of Canopy",
        );
        let entry = snapshot()
            .into_iter()
            .find(|c| c.component == "test_rt_jit")
            .expect("reported component missing from snapshot");
        assert_eq!(entry.status, HealthStatus::Failed);
        assert_eq!(entry.reason.as_deref(), Some("Port 18802 in use"));
        assert_eq!(
            entry.remediation.as_deref(),
            Some("Close the other copy of Canopy")
        );
    }

    #[test]
    fn later_report_overwrites_earlier_state() {
        report_degraded("test_ow_keychain", "Keychain unavailable", "Relaunch");
        report_ok("test_ow_keychain");
        let entry = snapshot()
            .into_iter()
            .find(|c| c.component == "test_ow_keychain")
            .unwrap();
        assert_eq!(entry.status, HealthStatus::Ok);
        assert!(entry.reason.is_none());
        assert!(entry.remediation.is_none());
    }

    #[test]
    fn ok_entries_serialize_without_null_noise() {
        report_ok("test_ser_dispatch");
        let entry = snapshot()
            .into_iter()
            .find(|c| c.component == "test_ser_dispatch")
            .unwrap();
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "component": "test_ser_dispatch", "status": "ok" })
        );
    }

    #[test]
    fn snapshot_is_sorted_by_component_id() {
        report_ok("test_sort_b");
        report_ok("test_sort_a");
        let ids: Vec<String> = snapshot()
            .into_iter()
            .map(|c| c.component)
            .filter(|c| c.starts_with("test_sort_"))
            .collect();
        assert_eq!(ids, vec!["test_sort_a", "test_sort_b"]);
    }
}

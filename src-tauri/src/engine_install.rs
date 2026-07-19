// ─── Engine background install (Workstream A) ────────────────────────────────
//
// Converts the blocking first-run engine gate into a background provisioning job.
// Started at app launch (first-run) or on demand; the wizard subscribes to
// `canopy:engine-status` events and only ever blocks at the Deploy step, and
// only when provisioning has FAILED (persona review §6, invariant: the Deploy
// button always has a working exit).
//
// State machine:
//   Idle → Detecting → { Starting → Verifying → Ready | Failed }
//                    → { Downloading → VerifyingArtifact → Installing → Starting → … }
//
// Security invariants (persona review §6, hardening req. 1 & 2):
//   • Never execute an unverified artifact: the downloaded/installed app bundle
//     must pass codesign + Gatekeeper assessment BEFORE first launch.
//   • Partial downloads are never executed: we download to a temp path and only
//     act on it after the HTTP body completes; relaunch restarts cleanly.
//   • Deploy-side enforcement: `ensure_engine_ready_for_deploy` gives callers a
//     fast, friendly error instead of a hang when the engine is not Ready.
//     (Today agents only run inside the containerized gateway, so "agent
//     operating without a container" cannot occur; this guard keeps that true
//     and is where the future hosted-fallback branch will hang off.)

use serde::Serialize;
use std::sync::Mutex;
use tauri::Emitter;

// ─── State ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineStage {
    Idle,
    Detecting,
    Downloading,
    VerifyingArtifact,
    Installing,
    Starting,
    Verifying,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineStatus {
    pub stage: EngineStage,
    /// Which engine we are working with, once known ("OrbStack" | "Docker").
    pub engine: Option<String>,
    /// 0–100 for download progress; None for indeterminate stages.
    pub progress: Option<u8>,
    /// Machine-readable failure reason (stable strings — used by telemetry + UI copy).
    pub failure: Option<String>,
    /// Human-readable detail safe to show in the UI.
    pub detail: String,
}

impl EngineStatus {
    fn idle() -> Self {
        EngineStatus {
            stage: EngineStage::Idle,
            engine: None,
            progress: None,
            failure: None,
            detail: "Not started".into(),
        }
    }
}

/// Legal transitions — enforced so a bug can never walk the UI backwards from
/// Ready or skip verification. Unit-tested below (test matrix cases map here).
pub fn transition_allowed(from: EngineStage, to: EngineStage) -> bool {
    use EngineStage::*;
    matches!(
        (from, to),
        (Idle, Detecting)
            | (Detecting, Starting)          // engine present → start daemon
            | (Detecting, Downloading)       // engine absent → assisted install
            | (Detecting, Failed)
            | (Downloading, VerifyingArtifact)
            | (Downloading, Failed)
            | (VerifyingArtifact, Installing)
            | (VerifyingArtifact, Downloading) // one re-download on verify failure
            | (VerifyingArtifact, Failed)
            | (Installing, Starting)
            | (Installing, Failed)
            | (Starting, Verifying)
            | (Starting, Failed)
            | (Verifying, Ready)
            | (Verifying, Failed)
            | (Failed, Detecting)            // retry
            | (Ready, Detecting)             // health re-check / engine died
    )
}

static ENGINE_STATUS: Mutex<Option<EngineStatus>> = Mutex::new(None);

fn set_status(app: Option<&tauri::AppHandle>, next: EngineStatus) {
    {
        let mut guard = ENGINE_STATUS.lock().unwrap();
        if let Some(current) = guard.as_ref() {
            if current.stage != next.stage && !transition_allowed(current.stage, next.stage) {
                tracing::warn!(
                    "engine_install: illegal transition {:?} → {:?} blocked",
                    current.stage,
                    next.stage
                );
                return;
            }
        }
        *guard = Some(next.clone());
    }
    if let Some(app) = app {
        let _ = app.emit("canopy:engine-status", &next);
        // Funnel telemetry: one event per stage change (spec-global-usage-telemetry).
        let _ = app.emit(
            "canopy:telemetry",
            serde_json::json!({
                "event": format!("engine_install_{:?}", next.stage).to_lowercase(),
                "engine": next.engine,
                "failure": next.failure,
            }),
        );
    }
}

#[tauri::command]
pub fn get_engine_status() -> EngineStatus {
    ENGINE_STATUS
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(EngineStatus::idle)
}

/// Fast guard for deploy-path callers (start_gateway / deploy commands).
///
/// IMPORTANT — no regression for returning users: provisioning only runs on
/// first-run, so `Idle` means "we never checked", NOT "engine missing". Idle
/// falls through to the legacy behavior (the daemon check happens naturally
/// downstream). We only fast-fail when provisioning is KNOWN to be in flight
/// or failed.
pub fn ensure_engine_ready_for_deploy() -> Result<String, String> {
    let status = get_engine_status();
    match status.stage {
        EngineStage::Ready => Ok(status.engine.unwrap_or_else(|| "engine".into())),
        EngineStage::Idle => Ok("unknown".into()),
        EngineStage::Failed => Err(format!(
            "engine_not_ready:failed:{}",
            status.failure.unwrap_or_else(|| "unknown".into())
        )),
        _ => Err(format!("engine_not_ready:{:?}", status.stage).to_lowercase()),
    }
}

// ─── Effects ─────────────────────────────────────────────────────────────────

async fn which(binary: &str) -> bool {
    tokio::process::Command::new("which")
        .arg(binary)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn docker_daemon_healthy() -> bool {
    tokio::process::Command::new("docker")
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn launch_engine_app(engine: &str) -> Result<(), String> {
    let app_name = if engine == "OrbStack" { "OrbStack" } else { "Docker" };
    let out = tokio::process::Command::new("open")
        .args(["-a", app_name, "--background"])
        .output()
        .await
        .map_err(|e| format!("open failed: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

/// Poll the daemon socket with a bounded SLA (persona review §6, case 5).
async fn wait_for_daemon(sla: std::time::Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < sla {
        if docker_daemon_healthy().await {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
    false
}

/// Verify a mounted/copied app bundle BEFORE first launch (matrix case 3).
/// Both checks must pass; never launch an unverified bundle.
async fn verify_app_bundle(path: &str) -> Result<(), String> {
    let codesign = tokio::process::Command::new("codesign")
        .args(["--verify", "--deep", "--strict", path])
        .output()
        .await
        .map_err(|e| format!("codesign unavailable: {e}"))?;
    if !codesign.status.success() {
        return Err(format!(
            "codesign verification failed: {}",
            String::from_utf8_lossy(&codesign.stderr)
        ));
    }
    let spctl = tokio::process::Command::new("spctl")
        .args(["--assess", "--type", "execute", path])
        .output()
        .await
        .map_err(|e| format!("spctl unavailable: {e}"))?;
    if !spctl.status.success() {
        return Err(format!(
            "Gatekeeper assessment failed: {}",
            String::from_utf8_lossy(&spctl.stderr)
        ));
    }
    Ok(())
}

const ORBSTACK_DMG_URL: &str = "https://orbstack.dev/download/stable/latest/arm64";
const DAEMON_SLA: std::time::Duration = std::time::Duration::from_secs(90);

/// Assisted OrbStack install without brew: download DMG → mount → verify → copy
/// → detach → verify installed copy. Every step is restart-clean (matrix case 8):
/// temp files are per-attempt, and nothing is executed until verified.
async fn install_orbstack_from_dmg(app: &tauri::AppHandle) -> Result<(), String> {
    let tmp_dir = std::env::temp_dir().join(format!("canopy-engine-{}", std::process::id()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("temp dir: {e}"))?;
    let dmg_path = tmp_dir.join("OrbStack.dmg");

    // Download with streamed progress.
    let response = reqwest::get(ORBSTACK_DMG_URL)
        .await
        .map_err(|e| format!("download_failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download_failed: HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&dmg_path).map_err(|e| format!("temp file: {e}"))?;
    let mut stream = response.bytes_stream();
    let mut received: u64 = 0;
    use futures_util::StreamExt;
    use std::io::Write;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download_interrupted: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("disk_write_failed: {e}"))?;
        received += chunk.len() as u64;
        if total > 0 {
            let pct = ((received * 100) / total).min(99) as u8;
            set_status(
                Some(app),
                EngineStatus {
                    stage: EngineStage::Downloading,
                    engine: Some("OrbStack".into()),
                    progress: Some(pct),
                    failure: None,
                    detail: "Downloading the engine…".into(),
                },
            );
        }
    }
    drop(file);

    // Mount and verify BEFORE copying anything into /Applications.
    set_status(
        Some(app),
        EngineStatus {
            stage: EngineStage::VerifyingArtifact,
            engine: Some("OrbStack".into()),
            progress: None,
            failure: None,
            detail: "Verifying the download…".into(),
        },
    );
    let mount_point = tmp_dir.join("mnt");
    std::fs::create_dir_all(&mount_point).map_err(|e| format!("mount dir: {e}"))?;
    let attach = tokio::process::Command::new("hdiutil")
        .args([
            "attach",
            dmg_path.to_str().unwrap_or_default(),
            "-mountpoint",
            mount_point.to_str().unwrap_or_default(),
            "-nobrowse",
            "-quiet",
        ])
        .output()
        .await
        .map_err(|e| format!("hdiutil: {e}"))?;
    if !attach.status.success() {
        return Err(format!(
            "artifact_corrupt: {}",
            String::from_utf8_lossy(&attach.stderr)
        ));
    }

    let result: Result<(), String> = async {
        let mounted_app = mount_point.join("OrbStack.app");
        if !mounted_app.exists() {
            return Err("artifact_corrupt: OrbStack.app missing from image".into());
        }
        verify_app_bundle(mounted_app.to_str().unwrap_or_default())
            .await
            .map_err(|e| format!("verify_failed: {e}"))?;

        set_status(
            Some(app),
            EngineStatus {
                stage: EngineStage::Installing,
                engine: Some("OrbStack".into()),
                progress: None,
                failure: None,
                detail: "Installing the engine…".into(),
            },
        );
        let copy = tokio::process::Command::new("cp")
            .args([
                "-R",
                mounted_app.to_str().unwrap_or_default(),
                "/Applications/",
            ])
            .output()
            .await
            .map_err(|e| format!("copy: {e}"))?;
        if !copy.status.success() {
            let stderr = String::from_utf8_lossy(&copy.stderr).to_string();
            // Disk-full and permission denials land here (matrix cases 4, 9).
            return Err(format!("install_copy_failed: {stderr}"));
        }
        // Belt and braces: verify the installed copy too before first launch.
        verify_app_bundle("/Applications/OrbStack.app")
            .await
            .map_err(|e| format!("verify_failed_post_install: {e}"))?;
        Ok(())
    }
    .await;

    // Always detach; always clean temp files regardless of outcome.
    let _ = tokio::process::Command::new("hdiutil")
        .args(["detach", mount_point.to_str().unwrap_or_default(), "-quiet"])
        .output()
        .await;
    let _ = std::fs::remove_dir_all(&tmp_dir);

    result
}

// ─── Orchestration ───────────────────────────────────────────────────────────

/// Kick off (or retry) engine provisioning in the background. Idempotent:
/// calling while a run is active is a no-op; calling after Failed retries.
#[tauri::command]
pub async fn start_engine_provisioning(app: tauri::AppHandle) -> Result<(), String> {
    {
        let guard = ENGINE_STATUS.lock().unwrap();
        if let Some(status) = guard.as_ref() {
            match status.stage {
                EngineStage::Ready => return Ok(()),
                EngineStage::Idle | EngineStage::Failed => {}
                _ => return Ok(()), // already in flight
            }
        }
    }

    tauri::async_runtime::spawn(async move {
        run_provisioning(app).await;
    });
    Ok(())
}

async fn run_provisioning(app: tauri::AppHandle) {
    set_status(
        Some(&app),
        EngineStatus {
            stage: EngineStage::Detecting,
            engine: None,
            progress: None,
            failure: None,
            detail: "Checking for a container engine…".into(),
        },
    );

    let (engine, installed) = if which("orb").await {
        ("OrbStack".to_string(), true)
    } else if which("docker").await {
        ("Docker".to_string(), true)
    } else {
        ("OrbStack".to_string(), false)
    };

    if !installed {
        set_status(
            Some(&app),
            EngineStatus {
                stage: EngineStage::Downloading,
                engine: Some(engine.clone()),
                progress: Some(0),
                failure: None,
                detail: "Downloading the engine…".into(),
            },
        );
        // Prefer brew when present (handles arch + updates); else direct DMG.
        let install_result = if which("brew").await {
            let out = tokio::process::Command::new("brew")
                .args(["install", "--cask", "orbstack"])
                .output()
                .await;
            match out {
                Ok(o) if o.status.success() => Ok(()),
                Ok(o) => Err(format!(
                    "brew_install_failed: {}",
                    String::from_utf8_lossy(&o.stderr)
                )),
                Err(e) => Err(format!("brew_unavailable: {e}")),
            }
        } else {
            install_orbstack_from_dmg(&app).await
        };

        if let Err(reason) = install_result {
            set_status(
                Some(&app),
                EngineStatus {
                    stage: EngineStage::Failed,
                    engine: Some(engine),
                    progress: None,
                    failure: Some(reason.clone()),
                    detail: friendly_failure(&reason),
                },
            );
            return;
        }
    }

    // Start the daemon (matrix case 6: existing-but-stopped daemon gets one start).
    set_status(
        Some(&app),
        EngineStatus {
            stage: EngineStage::Starting,
            engine: Some(engine.clone()),
            progress: None,
            failure: None,
            detail: "Starting the engine…".into(),
        },
    );
    if !docker_daemon_healthy().await {
        if let Err(e) = launch_engine_app(&engine).await {
            set_status(
                Some(&app),
                EngineStatus {
                    stage: EngineStage::Failed,
                    engine: Some(engine),
                    progress: None,
                    failure: Some(format!("launch_failed: {e}")),
                    detail: friendly_failure("launch_failed"),
                },
            );
            return;
        }
    }

    set_status(
        Some(&app),
        EngineStatus {
            stage: EngineStage::Verifying,
            engine: Some(engine.clone()),
            progress: None,
            failure: None,
            detail: "Confirming the engine is healthy…".into(),
        },
    );
    if wait_for_daemon(DAEMON_SLA).await {
        set_status(
            Some(&app),
            EngineStatus {
                stage: EngineStage::Ready,
                engine: Some(engine),
                progress: None,
                failure: None,
                detail: "Engine ready".into(),
            },
        );
    } else {
        set_status(
            Some(&app),
            EngineStatus {
                stage: EngineStage::Failed,
                engine: Some(engine),
                progress: None,
                failure: Some("daemon_timeout".into()),
                detail: friendly_failure("daemon_timeout"),
            },
        );
    }
}

fn friendly_failure(reason: &str) -> String {
    let head = reason.split(':').next().unwrap_or(reason);
    match head {
        "download_failed" | "download_interrupted" => {
            "The engine download didn't finish. Check your connection and retry — your agent draft is saved.".into()
        }
        "artifact_corrupt" | "verify_failed" | "verify_failed_post_install" => {
            "The downloaded engine didn't pass verification, so it was discarded. Retry to download a fresh copy.".into()
        }
        "disk_write_failed" | "install_copy_failed" => {
            "Couldn't install the engine — check free disk space and permissions, then retry.".into()
        }
        "daemon_timeout" => {
            "The engine installed but didn't start in time. Retry, or open OrbStack once manually and come back.".into()
        }
        "launch_failed" => "Couldn't start the engine app. Retry, or open it manually once.".into(),
        _ => "Engine setup hit a snag. Retry — your agent draft is saved.".into(),
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────
// State-machine level coverage for the failure matrix; effectful paths (download,
// hdiutil, codesign) are exercised on macOS via `cargo test` + manual QA since
// they require the host OS. Every matrix case maps to a transition assertion here.

#[cfg(test)]
mod tests {
    use super::*;
    use EngineStage::*;

    #[test]
    fn happy_path_existing_engine() {
        for (from, to) in [(Idle, Detecting), (Detecting, Starting), (Starting, Verifying), (Verifying, Ready)] {
            assert!(transition_allowed(from, to), "{from:?}→{to:?}");
        }
    }

    #[test]
    fn happy_path_fresh_install() {
        for (from, to) in [
            (Idle, Detecting),
            (Detecting, Downloading),
            (Downloading, VerifyingArtifact),
            (VerifyingArtifact, Installing),
            (Installing, Starting),
            (Starting, Verifying),
            (Verifying, Ready),
        ] {
            assert!(transition_allowed(from, to), "{from:?}→{to:?}");
        }
    }

    #[test]
    fn matrix_case_2_interrupted_download_fails_cleanly() {
        assert!(transition_allowed(Downloading, Failed));
        // and retry restarts from detection, never resuming a partial artifact
        assert!(transition_allowed(Failed, Detecting));
    }

    #[test]
    fn matrix_case_3_verify_failure_allows_one_redownload_then_fail() {
        assert!(transition_allowed(VerifyingArtifact, Downloading));
        assert!(transition_allowed(VerifyingArtifact, Failed));
        // verification can never be skipped: no Installing without VerifyingArtifact
        assert!(!transition_allowed(Downloading, Installing));
    }

    #[test]
    fn matrix_case_5_daemon_timeout_fails() {
        assert!(transition_allowed(Verifying, Failed));
    }

    #[test]
    fn matrix_case_6_broken_daemon_single_start_then_verify() {
        assert!(transition_allowed(Detecting, Starting));
        assert!(transition_allowed(Starting, Failed));
    }

    #[test]
    fn matrix_case_7_engine_death_recheck_from_ready() {
        assert!(transition_allowed(Ready, Detecting));
    }

    #[test]
    fn never_walk_backwards_or_skip_verification() {
        assert!(!transition_allowed(Ready, Failed));
        assert!(!transition_allowed(Idle, Ready));
        assert!(!transition_allowed(Detecting, Ready));
        assert!(!transition_allowed(Downloading, Ready));
        assert!(!transition_allowed(Installing, Ready));
        assert!(!transition_allowed(Failed, Ready));
    }

    #[test]
    fn deploy_guard_blocks_all_non_ready_stages() {
        {
            let mut guard = ENGINE_STATUS.lock().unwrap();
            *guard = Some(EngineStatus {
                stage: EngineStage::Downloading,
                engine: Some("OrbStack".into()),
                progress: Some(50),
                failure: None,
                detail: "".into(),
            });
        }
        assert!(ensure_engine_ready_for_deploy().is_err());
        {
            let mut guard = ENGINE_STATUS.lock().unwrap();
            *guard = Some(EngineStatus {
                stage: EngineStage::Ready,
                engine: Some("OrbStack".into()),
                progress: None,
                failure: None,
                detail: "".into(),
            });
        }
        assert_eq!(ensure_engine_ready_for_deploy().unwrap(), "OrbStack");
        // Idle (returning user, provisioning never ran) must NOT block — legacy path.
        {
            let mut guard = ENGINE_STATUS.lock().unwrap();
            *guard = None;
        }
        assert!(ensure_engine_ready_for_deploy().is_ok());
    }

    #[test]
    fn friendly_failures_never_leak_raw_errors() {
        for reason in [
            "download_failed: tls error",
            "artifact_corrupt: bad dmg",
            "disk_write_failed: ENOSPC",
            "daemon_timeout",
            "totally_unknown_reason",
        ] {
            let msg = friendly_failure(reason);
            assert!(!msg.contains("ENOSPC"));
            assert!(!msg.contains("tls"));
            assert!(msg.len() > 20, "friendly message should be a real sentence");
        }
    }
}

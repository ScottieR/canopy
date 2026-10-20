use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserStatus {
    pub agent_id: String,
    pub port: u16,
    pub cdp_endpoint: String,
    pub profile_path: String,
    pub is_running: bool,
    pub mode: BrowserMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserMode {
    Automated,
    InteractiveAuth,
}

pub struct BrowserManager {
    active_browsers: Arc<Mutex<HashMap<String, (Child, BrowserStatus)>>>,
    interactive_browsers: Arc<Mutex<HashMap<String, (Child, BrowserStatus)>>>,
    /// Per-agent visual-stream state — a refcount of how many UI consumers are
    /// currently subscribed (BrowserTab, BrowserPopout, etc.) plus the JoinHandle
    /// for the stream task. The stream task runs while count > 0 and is aborted
    /// when the count drops to 0.
    ///
    /// Refcounting prevents the previous behaviour where the 2 FPS screenshot loop
    /// ran for Chrome's entire lifetime regardless of whether any UI was watching,
    /// piling `browser_stream_frame` Tauri events into the webview event queue —
    /// our prime suspect for the "white screen after idle" crash.
    stream_handles: Arc<Mutex<HashMap<String, (u32, tauri::async_runtime::JoinHandle<()>)>>>,
    /// Tier 5 — one dedicated, persistent Chrome per agent that has `web_sandbox_browser`
    /// enabled. Deliberately a THIRD map, not reused from `active_browsers`: those Chrome
    /// instances are the shared/isolated automation browser OpenClaw's `browser`/`gog`
    /// skills drive (key "shared-browser" for non-isolated agents, or the agent's own id
    /// for isolated ones — see `effective_browsing_profile`), always start from a clean
    /// slate, and live under `agent-browsers/{key}/`. Tier 5's browser is a distinct
    /// resource on every axis: its own map entry (so stopping/reaping one never touches
    /// the other), its own profile directory (`agent-sandbox-browsers/{agent_id}/`, see
    /// `prepare_agent_sandbox_browser_profile`), and — like every Chrome this file spawns
    /// — its own OS-assigned debugging port (`--remote-debugging-port=0`), so there is no
    /// way for it to collide with another Chrome's port even accidentally.
    sandbox_browsers: Arc<Mutex<HashMap<String, (Child, BrowserStatus)>>>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            active_browsers: Arc::new(Mutex::new(HashMap::new())),
            interactive_browsers: Arc::new(Mutex::new(HashMap::new())),
            stream_handles: Arc::new(Mutex::new(HashMap::new())),
            sandbox_browsers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn kill_leftover_processes(&self, agent_id: &str) {
        // Scope the match to THIS flavor's exact profile directory. The previous
        // pattern (`agent-browsers/{id}`) also matched a sibling flavor's Chrome
        // (`Canopy Dev/agent-browsers/shared-browser` vs `Canopy/…`) and any agent
        // whose id merely starts with this one (`agent-boots` vs `agent-boots2`), so
        // one spawn could SIGKILL a different, live managed Chrome seconds after it
        // came up.
        let pattern = match crate::flavor::canopy_data_dir() {
            Some(dir) => leftover_process_pattern(
                &dir.join("agent-browsers").join(agent_id).to_string_lossy(),
            ),
            None => format!("agent-browsers/{}( |/|$)", regex_escape(agent_id)),
        };

        tracing::info!(
            "Cleaning up leftover Chrome processes for agent {}",
            agent_id
        );

        // Graceful SIGTERM. pkill exits 1 when nothing matched — the common case on
        // a clean spawn — so skip the 500ms grace period and SIGKILL sweep then;
        // that delay sat directly on the cold-start path of every first CDP probe.
        let matched = tokio::process::Command::new("pkill")
            .args(["-f", &pattern])
            .output()
            .await
            .map(|o| o.status.code() != Some(1))
            .unwrap_or(true);
        if !matched {
            return;
        }

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Forceful SIGKILL fallback
        let _ = tokio::process::Command::new("pkill")
            .args(["-9", "-f", &pattern])
            .output()
            .await;
    }

    pub async fn start_browser(
        &self,
        app_handle: tauri::AppHandle,
        agent_id: &str,
    ) -> Result<BrowserStatus> {
        self.start_browser_with_options(app_handle, agent_id, false)
            .await
    }

    async fn start_browser_with_options(
        &self,
        app_handle: tauri::AppHandle,
        agent_id: &str,
        restore_last_session: bool,
    ) -> Result<BrowserStatus> {
        // Never silently kill a LIVE trusted-login window to make room for an
        // automated Chrome — the user may be mid-sign-in (and Google logins
        // can take minutes with 2FA). Callers that legitimately transition out
        // of interactive mode (finish_interactive_auth_session) stop the
        // interactive session explicitly BEFORE calling here. Dead entries
        // (window closed by hand) are reaped so they don't block the spawn.
        {
            let mut interactive = self.interactive_browsers.lock().await;
            let alive = match interactive.get_mut(agent_id) {
                Some((child, _)) => matches!(child.try_wait(), Ok(None)),
                None => false,
            };
            if alive {
                return Err(anyhow::anyhow!(
                    "A trusted-login window is open for {} — resume automation (or close it) before starting the automated browser",
                    agent_id
                ));
            }
            interactive.remove(agent_id);
        }
        let mut active = self.active_browsers.lock().await;

        // Kill existing if any
        if let Some((mut child, _)) = active.remove(agent_id) {
            let _ = child.kill().await;
        }

        // Pre-flight Health Check: Kill leftovers from crashed sessions
        self.kill_leftover_processes(agent_id).await;

        let profile = prepare_agent_browser_profile(agent_id)?;

        // Try to find Google Chrome on macOS
        let chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        if !std::path::Path::new(chrome_path).exists() {
            return Err(anyhow::anyhow!(
                "Google Chrome not found at {}. Please install it to use Machine Browser.",
                chrome_path
            ));
        }

        let args = build_chrome_args(
            &profile.profile_path,
            &profile.pac_url,
            BrowserMode::Automated,
            Some("about:blank"),
            restore_last_session,
        );
        let (child, port, cdp_endpoint) = spawn_chrome_and_wait_for_cdp(chrome_path, args)
            .await
            .with_context(|| format!("Chrome profile at {}", profile.profile_path))?;
        tracing::info!(
            "Started Chrome for agent {} with PID {} at {}",
            agent_id,
            child.id().unwrap_or(0),
            cdp_endpoint
        );

        let status = BrowserStatus {
            agent_id: agent_id.to_string(),
            port,
            cdp_endpoint: cdp_endpoint.clone(),
            profile_path: profile.profile_path,
            is_running: true,
            mode: BrowserMode::Automated,
        };

        active.insert(agent_id.to_string(), (child, status.clone()));

        // NOTE: Visual streaming is NO LONGER auto-started here. Previously this
        // function kicked off a 2 FPS screenshot loop that ran for Chrome's entire
        // lifetime, regardless of whether any UI was actually watching — piling
        // `browser_stream_frame` Tauri events into the webview event queue and
        // gradually exhausting renderer memory ("white screen after idle" crash).
        //
        // The visual stream is now opt-in via `start_browser_stream`, which the
        // BrowserTab calls on mount and tears down on unmount. Other paths that
        // need Chrome (the JIT bridge, the shared bridge, agent tools) don't need
        // visuals and shouldn't pay the cost of capturing them.
        let _ = app_handle; // keep the AppHandle parameter for future use

        Ok(status)
    }

    pub async fn start_interactive_auth_session(
        &self,
        agent_id: &str,
        start_url: Option<&str>,
    ) -> Result<BrowserStatus> {
        // Reuse the existing login window only if its Chrome is actually still
        // running. A user who closed the window manually leaves a dead Child in
        // the map — returning its status here would "activate" a window that no
        // longer exists. Reap dead entries and fall through to a fresh spawn.
        if let Some(status) = {
            let mut active = self.interactive_browsers.lock().await;
            // Two-phase probe/mutate — see get_status for why.
            let alive = match active.get_mut(agent_id) {
                Some((child, status)) => match child.try_wait() {
                    Ok(None) => Some(status.clone()), // alive — reuse
                    _ => None,
                },
                None => None,
            };
            if alive.is_none() {
                active.remove(agent_id); // no-op when absent
            }
            alive
        } {
            activate_google_chrome().await;
            return Ok(status);
        }

        let current_url = match self.get_automated_status(agent_id).await? {
            Some(status) => capture_browser_url(status.port).await.ok().flatten(),
            None => None,
        };

        self.stop_automated_browser(agent_id).await?;
        self.kill_leftover_processes(agent_id).await;

        let profile = prepare_agent_browser_profile(agent_id)?;
        let chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        if !std::path::Path::new(chrome_path).exists() {
            return Err(anyhow::anyhow!(
                "Google Chrome not found at {}. Please install it to use Machine Browser.",
                chrome_path
            ));
        }

        let launch_url = start_url
            .or(current_url.as_deref())
            .unwrap_or("https://accounts.google.com/");

        let child = Command::new(chrome_path)
            .args(build_chrome_args(
                &profile.profile_path,
                &profile.pac_url,
                BrowserMode::InteractiveAuth,
                Some(launch_url),
                false,
            ))
            .spawn()
            .context("Failed to spawn interactive auth Chrome process")?;

        let status = BrowserStatus {
            agent_id: agent_id.to_string(),
            port: 0,
            cdp_endpoint: String::new(),
            profile_path: profile.profile_path,
            is_running: true,
            mode: BrowserMode::InteractiveAuth,
        };

        {
            let mut interactive = self.interactive_browsers.lock().await;
            interactive.insert(agent_id.to_string(), (child, status.clone()));
        }

        activate_google_chrome().await;
        Ok(status)
    }

    pub async fn finish_interactive_auth_session(
        &self,
        app_handle: tauri::AppHandle,
        agent_id: &str,
    ) -> Result<BrowserStatus> {
        self.stop_interactive_browser(agent_id).await?;
        self.start_browser_with_options(app_handle, agent_id, true)
            .await
    }

    // ─── Tier 5: agent-owned sandboxed Chromium ────────────────────────────────

    /// Starts (or reuses, if already running) this agent's dedicated sandboxed Chrome.
    /// Unlike `start_browser`, this always passes `restore_last_session: true` — Tier
    /// 5's whole point is that the agent stays logged into services it's been approved
    /// for across Canopy restarts, not that every session starts from a clean slate.
    pub async fn start_sandbox_browser(&self, agent_id: &str) -> Result<BrowserStatus> {
        {
            let mut sandbox = self.sandbox_browsers.lock().await;
            if let Some((child, status)) = sandbox.get_mut(agent_id) {
                if matches!(child.try_wait(), Ok(None)) {
                    return Ok(status.clone()); // already running — reuse the live session
                }
            }
            sandbox.remove(agent_id); // reap a dead entry, if any
        }

        let profile = prepare_agent_sandbox_browser_profile(agent_id)?;
        let chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        if !std::path::Path::new(chrome_path).exists() {
            return Err(anyhow::anyhow!(
                "Google Chrome not found at {}. Please install it to use the sandboxed agent browser.",
                chrome_path
            ));
        }

        let args = build_chrome_args(
            &profile.profile_path,
            &profile.pac_url,
            BrowserMode::Automated,
            Some("about:blank"),
            true, // restore_last_session — see doc comment above
        );
        let (child, port, cdp_endpoint) = spawn_chrome_and_wait_for_cdp(chrome_path, args).await?;

        let status = BrowserStatus {
            agent_id: agent_id.to_string(),
            port,
            cdp_endpoint,
            profile_path: profile.profile_path,
            is_running: true,
            mode: BrowserMode::Automated,
        };

        let mut sandbox = self.sandbox_browsers.lock().await;
        sandbox.insert(agent_id.to_string(), (child, status.clone()));
        Ok(status)
    }

    pub async fn stop_sandbox_browser(&self, agent_id: &str) -> Result<()> {
        let mut sandbox = self.sandbox_browsers.lock().await;
        if let Some((mut child, _)) = sandbox.remove(agent_id) {
            let _ = child.kill().await;
        }
        drop(sandbox);

        // Same graceful-then-forceful pattern as kill_leftover_processes, scoped to this
        // agent's sandbox profile path specifically — cannot match `agent-browsers/{id}`
        // (the automation browser's pattern) since "agent-sandbox-browsers" never
        // contains "agent-browsers" as a contiguous substring.
        let pattern = format!("agent-sandbox-browsers/{}", agent_id);
        let _ = tokio::process::Command::new("pkill")
            .args(["-f", &pattern])
            .output()
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let _ = tokio::process::Command::new("pkill")
            .args(["-9", "-f", &pattern])
            .output()
            .await;
        Ok(())
    }

    pub async fn get_sandbox_status(&self, agent_id: &str) -> Result<Option<BrowserStatus>> {
        let sandbox = self.sandbox_browsers.lock().await;
        Ok(sandbox.get(agent_id).map(|(_, status)| status.clone()))
    }

    /// Only for `agent_browser_*`: starts the sandbox browser if it isn't already
    /// running, then returns its CDP endpoint for the caller to act on.
    async fn ensure_sandbox_browser_cdp_endpoint(&self, agent_id: &str) -> Result<String, String> {
        if let Some(status) = self
            .get_sandbox_status(agent_id)
            .await
            .map_err(|e| e.to_string())?
        {
            if status_is_connectable(&status) {
                return Ok(status.cdp_endpoint);
            }
        }
        self.start_sandbox_browser(agent_id)
            .await
            .map(|s| s.cdp_endpoint)
            .map_err(|e| e.to_string())
    }

    /// Increment the subscriber refcount for an agent's visual stream. Starts the
    /// 2 FPS loop on first subscriber. Idempotent on each call — N start calls need
    /// N matching stop calls to actually tear down. Called by UI consumers
    /// (BrowserTab, BrowserPopout) on mount.
    pub async fn start_browser_stream(
        &self,
        app_handle: tauri::AppHandle,
        agent_id: &str,
    ) -> Result<()> {
        let mut handles = self.stream_handles.lock().await;
        if let Some((count, _)) = handles.get_mut(agent_id) {
            *count += 1;
            return Ok(());
        }
        // First subscriber — spawn the stream task if Chrome is up.
        let cdp_url = {
            let active = self.active_browsers.lock().await;
            match active.get(agent_id) {
                Some((_, status)) => status.cdp_endpoint.clone(),
                None => return Ok(()), // browser not running yet — caller will retry on next browser spawn
            }
        };
        let agent_id_owned = agent_id.to_string();
        let handle = tauri::async_runtime::spawn(async move {
            stream_browser_visuals(app_handle, agent_id_owned, cdp_url).await;
        });
        handles.insert(agent_id.to_string(), (1, handle));
        Ok(())
    }

    /// Decrement the subscriber refcount. Aborts the stream task once the count
    /// hits zero. Idempotent — extra stops are no-ops.
    pub async fn stop_browser_stream(&self, agent_id: &str) {
        let mut handles = self.stream_handles.lock().await;
        let should_abort = match handles.get_mut(agent_id) {
            Some((count, _)) => {
                if *count > 1 {
                    *count -= 1;
                    false
                } else {
                    true
                }
            }
            None => false,
        };
        if should_abort {
            if let Some((_, h)) = handles.remove(agent_id) {
                h.abort();
            }
        }
    }

    pub async fn stop_browser(&self, agent_id: &str) -> Result<()> {
        self.stop_automated_browser(agent_id).await?;
        self.stop_interactive_browser(agent_id).await?;
        Ok(())
    }

    async fn stop_automated_browser(&self, agent_id: &str) -> Result<()> {
        // Abort any visual-stream task first so it can't try to send screenshots
        // to a Chrome that's about to die. Force-removes regardless of refcount —
        // if Chrome's dying, there's nothing to stream anyway.
        {
            let mut handles = self.stream_handles.lock().await;
            if let Some((_count, h)) = handles.remove(agent_id) {
                h.abort();
            }
        }

        let mut active = self.active_browsers.lock().await;
        if let Some((mut child, _)) = active.remove(agent_id) {
            let pid = child.id().unwrap_or(0);
            match child.kill().await {
                Ok(_) => tracing::info!(
                    "Successfully terminated Chrome process (PID {}) for agent {}",
                    pid,
                    agent_id
                ),
                Err(e) => tracing::error!(
                    "Failed to gracefully kill Chrome process (PID {}) for agent {}: {}",
                    pid,
                    agent_id,
                    e
                ),
            }
        }

        // Improved Process Cleanup: ensure child processes are fully reaped
        self.kill_leftover_processes(agent_id).await;

        Ok(())
    }

    async fn stop_interactive_browser(&self, agent_id: &str) -> Result<()> {
        let mut interactive = self.interactive_browsers.lock().await;
        if let Some((mut child, _)) = interactive.remove(agent_id) {
            let pid = child.id().unwrap_or(0);
            match child.kill().await {
                Ok(_) => tracing::info!(
                    "Successfully terminated interactive Chrome process (PID {}) for agent {}",
                    pid,
                    agent_id
                ),
                Err(e) => tracing::error!(
                    "Failed to gracefully kill interactive Chrome process (PID {}) for agent {}: {}",
                    pid,
                    agent_id,
                    e
                ),
            }
        }

        self.kill_leftover_processes(agent_id).await;
        Ok(())
    }

    pub async fn get_status(&self, agent_id: &str) -> Result<Option<BrowserStatus>> {
        // Reap-then-read for the interactive map. If the user closes the login
        // window themselves (instead of clicking "resume automation"), the Child
        // exits but its entry stays here — and that stale entry has port 0 and an
        // EMPTY cdp_endpoint. Returning it shadows the automated browser forever:
        // the JIT proxy and shared bridge get an unconnectable endpoint on every
        // request, and the agent reports it "has no connection to the browser"
        // until the app is restarted. try_wait() is non-blocking, so this check
        // is effectively free.
        {
            let mut interactive = self.interactive_browsers.lock().await;
            // Two-phase (probe, then mutate) so the `get_mut` borrow is fully
            // released before `remove` — borrowck rejects a remove inside the
            // match arms.
            let alive_status = match interactive.get_mut(agent_id) {
                Some((child, status)) => match child.try_wait() {
                    Ok(None) => Some(status.clone()), // still alive
                    _ => None,                        // exited or unknown
                },
                None => None,
            };
            match alive_status {
                Some(status) => return Ok(Some(status)),
                None => {
                    // Exited (user closed the window) or unknown — drop the
                    // stale entry and fall through to the automated map.
                    if interactive.remove(agent_id).is_some() {
                        tracing::info!(
                            "get_status: reaping dead interactive-auth session for {}",
                            agent_id
                        );
                    }
                }
            }
        }

        let active = self.active_browsers.lock().await;
        if let Some((_, status)) = active.get(agent_id) {
            Ok(Some(status.clone()))
        } else {
            Ok(None)
        }
    }

    async fn get_automated_status(&self, agent_id: &str) -> Result<Option<BrowserStatus>> {
        let active = self.active_browsers.lock().await;
        Ok(active.get(agent_id).map(|(_, status)| status.clone()))
    }

    /// The automated Chrome for `agent_id` if its process is still alive and it has a
    /// CDP endpoint. A dead entry (Chrome crashed / was killed externally) is reaped
    /// here, so callers never hand out a GUID belonging to a corpse.
    async fn live_automated_status(&self, agent_id: &str) -> Option<BrowserStatus> {
        let mut active = self.active_browsers.lock().await;
        // Two-phase probe/mutate — see get_status for why.
        let alive = match active.get_mut(agent_id) {
            Some((child, status)) => match child.try_wait() {
                Ok(None) => Some(status_is_connectable(status).then(|| status.clone())),
                _ => None,
            },
            None => return None,
        };
        match alive {
            Some(status) => status,
            None => {
                tracing::info!("Reaping exited automated Chrome for {}", agent_id);
                active.remove(agent_id);
                None
            }
        }
    }

    /// Return this agent's live automated Chrome, spawning one ONLY if none is running.
    ///
    /// Every lazy-spawn path (shared bridge, JIT proxies, web_tools rendering) must go
    /// through here rather than calling `start_browser` directly: `start_browser` always
    /// kills the existing instance first, so two near-simultaneous callers that both saw
    /// "no browser" used to spawn back-to-back, the second killing the first's Chrome
    /// within seconds of spawn. Any client that had already read the first instance's
    /// `/devtools/browser/<guid>` from /json/version then got a 404 on the WebSocket
    /// upgrade. Serialised per profile by `resolve_lock_for`.
    pub async fn ensure_automated_browser(
        &self,
        app_handle: tauri::AppHandle,
        agent_id: &str,
    ) -> Result<BrowserStatus> {
        let _guard = resolve_lock_for(agent_id).lock().await;
        if let Some(status) = self.live_automated_status(agent_id).await {
            return Ok(status);
        }
        self.start_browser(app_handle, agent_id).await
    }

    /// Recover from a refused connect to `stale_endpoint`. If another caller already
    /// replaced that Chrome, reuse the replacement instead of killing it; otherwise stop
    /// the stale automated instance (never a trusted-login window) and spawn a fresh one.
    pub async fn recover_automated_browser(
        &self,
        app_handle: tauri::AppHandle,
        agent_id: &str,
        stale_endpoint: &str,
    ) -> Result<BrowserStatus> {
        let _guard = resolve_lock_for(agent_id).lock().await;
        if let Some(status) = self.live_automated_status(agent_id).await {
            if status.cdp_endpoint != stale_endpoint {
                return Ok(status);
            }
        }
        self.stop_automated_browser(agent_id).await?;
        self.start_browser(app_handle, agent_id).await
    }
}

/// The profile id whose Chrome this agent actually browses with through
/// OpenClaw's Chrome tool. Gateway agents all attach via the shared bridge, so
/// their effective profile is "shared-browser"; isolated agents attach via
/// their own JIT proxy, so it's their own agent id.
///
/// Trusted-login windows and the BrowserTab UI must target THIS profile, not
/// the raw agent id. Before this mapping existed, trusted logins landed in the
/// per-agent profile that gateway agents never browse — the agent then found
/// itself logged out and attempted the sign-in itself inside the CDP-attached
/// automated Chrome, which Google rejects with "This browser or app may not be
/// secure".
///
/// If per-agent bridge routing lands later, gateway agents flip back to their
/// own id HERE and everything downstream follows.
fn effective_browsing_profile(app_handle: &tauri::AppHandle, agent_id: &str) -> String {
    use tauri::Manager;
    let db = app_handle.state::<crate::db::Database>();
    match db.get_agent(agent_id) {
        Ok(Some(agent)) if agent.isolated => agent_id.to_string(),
        Ok(Some(_)) => "shared-browser".to_string(),
        // Unknown id (already a profile id like "shared-browser", or a stale
        // agent) — pass through unchanged.
        _ => agent_id.to_string(),
    }
}

/// True if this status describes a Chrome we can actually open a CDP connection
/// to. Interactive-auth sessions run WITHOUT remote debugging (port 0, empty
/// cdp_endpoint) and must never be handed to the JIT proxy or shared bridge —
/// parsing their empty endpoint is what used to panic the JIT connection task.
fn status_is_connectable(status: &BrowserStatus) -> bool {
    status.mode == BrowserMode::Automated && !status.cdp_endpoint.is_empty() && status.port != 0
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_machine_browser(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<BrowserStatus, String> {
    let status = state
        .start_browser(app_handle.clone(), &agent_id)
        .await
        .map_err(|e| e.to_string())?;

    // Point the agent at the JIT proxy port (NOT the raw Chrome CDP URL). Two reasons:
    //
    //  1. Chrome's DevTools server rejects any Host header that isn't `localhost` or an
    //     IP address (DNS-rebinding protection). The container's connection naturally
    //     sends `Host: host.docker.internal:<port>`, which Chrome refuses with
    //     "Host header is specified and is not an IP address or localhost". The JIT
    //     proxy rewrites the Host header to `127.0.0.1:<chrome_port>` before forwarding.
    //
    //  2. Chrome's WebSocket URL includes a per-session GUID (`/devtools/browser/<guid>`)
    //     that changes every restart. The JIT proxy looks up the current GUID at
    //     connection time, so the agent's stored env var stays stable across Chrome
    //     respawns. Pointing at the raw URL would leave the agent with a dead GUID
    //     the moment Chrome restarts.
    //
    // Same env URL shape used by `sync_agent_skills` when the user toggles the browser
    // capability — single source of truth for "where does the agent connect".
    let proxy_port = enable_jit_proxy(app_handle.clone(), agent_id.clone())
        .await
        .map_err(|e| e.to_string())?;
    let ws_endpoint = browser_bridge_url("ws", proxy_port, &agent_id);
    use tauri::Manager;
    let db = app_handle.state::<crate::db::Database>();
    let container_name = crate::openclaw::get_agent_container_name(&db, &agent_id);

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
            "edit",
            &agent_id,
            "--env",
            &format!("PLAYWRIGHT_CDP_ENDPOINT={}", ws_endpoint),
        ])
        .output()
        .await;

    Ok(status)
}

#[tauri::command]
pub async fn stop_machine_browser(
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<(), String> {
    state
        .stop_browser(&agent_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_browser_status(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<Option<BrowserStatus>, String> {
    let profile_id = effective_browsing_profile(&app_handle, &agent_id);
    state
        .get_status(&profile_id)
        .await
        .map_err(|e| e.to_string())
}

// ─── Tier 5: agent-owned sandboxed Chromium — Tauri commands ─────────────────────

async fn require_sandbox_browser_capability(
    db: &tauri::State<'_, crate::db::Database>,
    agent_id: &str,
) -> Result<(), String> {
    let agent = db
        .get_agent(agent_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "agent not found".to_string())?;
    if !agent.capabilities.web_sandbox_browser {
        return Err(
            "this agent does not have the Sandboxed Browser (web_sandbox_browser) capability enabled"
                .to_string(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn launch_agent_browser(
    state: tauri::State<'_, BrowserManager>,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<BrowserStatus, String> {
    require_sandbox_browser_capability(&db, &agent_id).await?;
    state
        .start_sandbox_browser(&agent_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn close_agent_browser(
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<(), String> {
    state
        .stop_sandbox_browser(&agent_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_browser_navigate(
    state: tauri::State<'_, BrowserManager>,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    url: String,
) -> Result<(), String> {
    require_sandbox_browser_capability(&db, &agent_id).await?;
    let parsed = url::Url::parse(url.trim()).map_err(|_| format!("'{url}' is not a valid URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http:// and https:// URLs are supported".to_string());
    }
    let cdp_endpoint = state.ensure_sandbox_browser_cdp_endpoint(&agent_id).await?;
    crate::web_tools::cdp_navigate(&cdp_endpoint, &url).await
}

#[tauri::command]
pub async fn agent_browser_get_content(
    state: tauri::State<'_, BrowserManager>,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<serde_json::Value, String> {
    require_sandbox_browser_capability(&db, &agent_id).await?;
    let cdp_endpoint = state.ensure_sandbox_browser_cdp_endpoint(&agent_id).await?;
    let (title, text) = crate::web_tools::cdp_get_content(&cdp_endpoint).await?;
    Ok(serde_json::json!({ "title": title, "text": text }))
}

#[tauri::command]
pub async fn agent_browser_click(
    state: tauri::State<'_, BrowserManager>,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    selector: String,
) -> Result<(), String> {
    require_sandbox_browser_capability(&db, &agent_id).await?;
    let cdp_endpoint = state.ensure_sandbox_browser_cdp_endpoint(&agent_id).await?;
    crate::web_tools::cdp_click(&cdp_endpoint, &selector).await
}

#[tauri::command]
pub async fn agent_browser_type(
    state: tauri::State<'_, BrowserManager>,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    selector: String,
    text: String,
) -> Result<(), String> {
    require_sandbox_browser_capability(&db, &agent_id).await?;
    let cdp_endpoint = state.ensure_sandbox_browser_cdp_endpoint(&agent_id).await?;
    crate::web_tools::cdp_type(&cdp_endpoint, &selector, &text).await
}

#[tauri::command]
pub async fn agent_browser_screenshot(
    state: tauri::State<'_, BrowserManager>,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<String, String> {
    require_sandbox_browser_capability(&db, &agent_id).await?;
    let cdp_endpoint = state.ensure_sandbox_browser_cdp_endpoint(&agent_id).await?;
    crate::web_tools::cdp_screenshot(&cdp_endpoint).await
}

/// Called by BrowserTab on mount. Begins the 2 FPS visual-stream loop for this
/// agent, but only if Chrome is already running. Safe to call multiple times.
#[tauri::command]
pub async fn start_browser_stream(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<(), String> {
    let profile_id = effective_browsing_profile(&app_handle, &agent_id);
    state
        .start_browser_stream(app_handle, &profile_id)
        .await
        .map_err(|e| e.to_string())
}

/// Called by BrowserTab on unmount. Stops the visual-stream loop for this agent.
/// Idempotent — safe to call even if no stream is running.
#[tauri::command]
pub async fn stop_browser_stream(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<(), String> {
    let profile_id = effective_browsing_profile(&app_handle, &agent_id);
    state.stop_browser_stream(&profile_id).await;
    Ok(())
}

#[tauri::command]
pub async fn start_browser_interactive_auth(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
    start_url: Option<String>,
) -> Result<BrowserStatus, String> {
    // Open the trusted-login window on the profile the agent actually browses
    // with, so the session the user establishes is the one the agent sees.
    let profile_id = effective_browsing_profile(&app_handle, &agent_id);
    state
        .start_interactive_auth_session(&profile_id, start_url.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn finish_browser_interactive_auth(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<BrowserStatus, String> {
    let profile_id = effective_browsing_profile(&app_handle, &agent_id);
    state
        .finish_interactive_auth_session(app_handle, &profile_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ping_agent_browser(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<bool, String> {
    let profile_id = effective_browsing_profile(&app_handle, &agent_id);
    let status = state
        .get_status(&profile_id)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(status) = status {
        if !status.is_running {
            return Ok(false);
        }

        // Interactive-auth sessions run without remote debugging (port 0) — there
        // is no CDP HTTP server to ping. Don't waste a 3s timeout on localhost:0.
        if status.port == 0 {
            return Ok(false);
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .map_err(|e| e.to_string())?;

        let res = client
            .get(&format!("http://localhost:{}/json/version", status.port))
            .send()
            .await;

        match res {
            Ok(response) => Ok(response.status().is_success()),
            Err(_) => Ok(false),
        }
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn reset_machine_browsers(state: tauri::State<'_, BrowserManager>) -> Result<(), String> {
    let mut active = state.active_browsers.lock().await;
    active.clear();

    tracing::info!("Force-resetting all machine browser processes...");

    // Graceful SIGTERM
    let _ = tokio::process::Command::new("pkill")
        .args(["-f", "agent-browsers/agent-"])
        .output()
        .await;

    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Forceful SIGKILL
    let _ = tokio::process::Command::new("pkill")
        .args(["-9", "-f", "agent-browsers/agent-"])
        .output()
        .await;

    tracing::info!("All browser processes successfully reset.");
    Ok(())
}

/// Per-agent-id "only one resolve at a time" lock for the shared bridge.
///
/// The bridge's resolve_endpoint() does a `get_status` followed by `start_browser`
/// if needed. Without serialization, two near-simultaneous bridge connections can
/// both observe `get_status == None`, both call `start_browser`, and the second one
/// kills the Chrome the first one just spawned (because `start_browser` removes any
/// existing entry at the top before spawning). Whichever task lost the race then
/// gets `Connection refused` when it tries to use its now-dead Chrome.
///
/// Acquiring this lock once across get-then-start guarantees only one resolve runs
/// at a time for the shared browser. Actual CDP traffic still flows fully in parallel
/// — the lock is held only during the (fast) status check and (slow but one-time)
/// spawn, not during the WebSocket lifetime.
///
/// One key per agent id; the shared bridge always uses "shared-browser". Keeping it
/// per-agent leaves the door open for future per-agent Chromes without a refactor.
fn resolve_lock_for(agent_id: &str) -> &'static tokio::sync::Mutex<()> {
    use std::sync::Mutex as StdMutex;
    use std::sync::OnceLock;
    static LOCKS: OnceLock<
        StdMutex<std::collections::HashMap<String, &'static tokio::sync::Mutex<()>>>,
    > = OnceLock::new();
    let locks = LOCKS.get_or_init(|| StdMutex::new(std::collections::HashMap::new()));
    let mut map = locks.lock().expect("resolve_lock_for: LOCKS poisoned");
    if let Some(m) = map.get(agent_id) {
        return m;
    }
    // Leak a fresh Mutex so we can return a `&'static`. The set of agent ids is bounded
    // (current users, ever) so the leak is bounded too.
    let leaked: &'static tokio::sync::Mutex<()> = Box::leak(Box::new(tokio::sync::Mutex::new(())));
    map.insert(agent_id.to_string(), leaked);
    leaked
}

/// Fixed port for the gateway's shared browser bridge.
///
/// OpenClaw's `browser.cdpUrl` config is a single global value, so all agents reach
/// Chrome through this one port. The shared bridge is started once at gateway boot
/// (see `ensure_shared_browser_bridge`) and lives for the lifetime of the Tauri app.
///
/// Chosen in the same numeric neighbourhood as other Canopy internal ports
/// (gateway: 18799, JIT: 18802) so they're easy to spot together when troubleshooting.
pub const SHARED_BRIDGE_PORT: u16 = 19800;

/// Return a process-stable, installation-local capability for a browser bridge.
///
/// The bridge must listen on all interfaces so Docker Desktop/OrbStack containers can
/// reach it through `host.docker.internal`. A high-entropy path capability prevents
/// other LAN clients from driving the user's authenticated browser. The value is kept
/// in the encrypted vault and is intentionally unavailable to frontend IPC.
fn safe_browser_bridge_scope(scope: &str) -> String {
    let safe_scope: String = scope
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    if safe_scope.is_empty() {
        "invalid-scope".to_string()
    } else {
        safe_scope
    }
}

#[cfg(test)]
pub(crate) fn browser_bridge_token(scope: &str) -> String {
    // Keep unit tests deterministic and completely isolated from the host Keychain.
    format!(
        "canopy_browser_test_{}_000000000000000000000000000000000000000000000000",
        safe_browser_bridge_scope(scope)
    )
}

#[cfg(not(test))]
pub(crate) fn browser_bridge_token(scope: &str) -> String {
    use std::sync::{Mutex as StdMutex, OnceLock};
    static TOKENS: OnceLock<StdMutex<HashMap<String, String>>> = OnceLock::new();

    let safe_scope = safe_browser_bridge_scope(scope);
    let tokens = TOKENS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut tokens = tokens.lock().expect("browser bridge token cache poisoned");
    if let Some(token) = tokens.get(&safe_scope) {
        return token.clone();
    }

    let key = format!("internal_browser_bridge_{}", safe_scope);
    let token = crate::keychain::get_or_create_internal_secret(&key, "canopy_browser_")
        .unwrap_or_else(|error| {
            tracing::warn!(
                "Could not persist browser bridge capability for {}; using a process-local capability: {}",
                safe_scope,
                error
            );
            format!(
                "canopy_browser_{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            )
        });
    tokens.insert(safe_scope, token.clone());
    token
}

pub(crate) fn browser_bridge_url(scheme: &str, port: u16, scope: &str) -> String {
    format!(
        "{}://host.docker.internal:{}/{}",
        scheme,
        port,
        browser_bridge_token(scope)
    )
}

/// Validate and remove the unguessable first path segment before forwarding to Chrome.
/// The returned request has the same method/version and all original headers, but Chrome
/// sees `/`, `/json/version`, or `/devtools/...` instead of the private capability.
fn authenticate_bridge_request(headers: &str, expected_token: &str) -> Option<String> {
    let trimmed = headers.trim_end_matches("\r\n");
    let mut lines = trimmed.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    let path_and_query = parts.next()?;
    let version = parts.next()?;
    if parts.next().is_some() || !version.starts_with("HTTP/") {
        return None;
    }

    let (path, query) = path_and_query
        .split_once('?')
        .map_or((path_and_query, None), |(path, query)| (path, Some(query)));
    let expected_prefix = format!("/{}", expected_token);
    let stripped_path = if path == expected_prefix {
        "/"
    } else {
        path.strip_prefix(&(expected_prefix + "/"))?
    };
    let normalized_path = if stripped_path.starts_with('/') {
        stripped_path.to_string()
    } else {
        format!("/{}", stripped_path)
    };
    let normalized_target = query.map_or(normalized_path.clone(), |query| {
        format!("{}?{}", normalized_path, query)
    });

    let mut out = format!("{} {} {}\r\n", method, normalized_target, version);
    for line in lines {
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str("\r\n");
    Some(out)
}

/// How long a bridge must see no connections before it stops its automated Chrome.
///
/// JIT proxies used 10s — short enough that an agent pausing to think between browser
/// actions lost its Chrome (and every open tab) and came back holding a dead
/// `/devtools/browser/<guid>`. Both bridge kinds now share the shared bridge's 60s,
/// which balances memory against cold-start latency on reconnect.
const BRIDGE_IDLE_SHUTDOWN: std::time::Duration = std::time::Duration::from_secs(60);

/// How long OpenClaw should wait on a bridge HTTP probe / WebSocket handshake
/// (`browser.remoteCdpTimeoutMs` / `remoteCdpHandshakeTimeoutMs`, written by docker.rs).
///
/// Chrome is spawned lazily by the FIRST request to reach a bridge — which, with
/// `attachOnly: true`, is OpenClaw's /json/version reachability probe. The bridge holds
/// that request open until Chrome is listening (leftover cleanup + up to
/// `CHROME_DEVTOOLS_READY_TIMEOUT`), but OpenClaw's default 1500ms client timeout gave
/// up long before a cold Chrome could answer, and it then threw
/// `attachOnly is enabled and profile "openclaw" is not running`.
pub const OPENCLAW_REMOTE_CDP_TIMEOUT_MS: u64 = 20_000;

/// Connection bookkeeping for a bridge's idle shutdown.
///
/// `epoch` advances on every new connection, so an idle timer armed when the count hit
/// zero only fires if NO connection came and went while it slept. The previous bare
/// counter let a timer armed by an early connection kill Chrome moments after a later
/// connection had just used it (and handed out its GUID).
#[derive(Default)]
struct BridgeActivity {
    open: std::sync::atomic::AtomicUsize,
    epoch: std::sync::atomic::AtomicU64,
}

impl BridgeActivity {
    fn enter(&self) {
        use std::sync::atomic::Ordering::SeqCst;
        self.epoch.fetch_add(1, SeqCst);
        self.open.fetch_add(1, SeqCst);
    }

    /// Returns the epoch to hand to `still_idle` when this was the last open connection.
    fn leave(&self) -> Option<u64> {
        use std::sync::atomic::Ordering::SeqCst;
        let epoch = self.epoch.load(SeqCst);
        (self.open.fetch_sub(1, SeqCst) == 1).then_some(epoch)
    }

    fn still_idle(&self, epoch: u64) -> bool {
        use std::sync::atomic::Ordering::SeqCst;
        self.open.load(SeqCst) == 0 && self.epoch.load(SeqCst) == epoch
    }
}

/// Everything that distinguishes one CDP bridge listener from another. The shared
/// bridge and every per-agent JIT proxy run the same connection handler
/// (`handle_cdp_bridge_connection`) — they used to be two ~250-line copies that had
/// drifted apart (only one serialised Chrome spawns, for example).
#[derive(Clone)]
struct CdpBridge {
    /// Log prefix ("Shared bridge" / "JIT Proxy").
    label: &'static str,
    /// BrowserManager key of the Chrome this bridge fronts.
    profile_id: String,
    /// Port this bridge listens on — leaked Chrome origins are rewritten to it.
    port: u16,
    /// Capability path segment every request must start with.
    token: String,
}

/// Start the gateway-wide browser bridge that OpenClaw connects to as its `cdpUrl`.
///
/// Idempotent — if the port is already bound, returns immediately. Routes ALL
/// connections to a single shared Chrome (profile "shared-browser") so OpenClaw can use
/// a single global cdpUrl. Per-agent data isolation still works because OpenClaw creates
/// a separate Playwright BrowserContext for each agent session.
pub async fn ensure_shared_browser_bridge(app_handle: tauri::AppHandle) -> Result<(), String> {
    const SHARED_AGENT_ID: &str = "shared-browser";

    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", SHARED_BRIDGE_PORT)).await {
        Ok(l) => l,
        Err(_) => return Ok(()), // already bound — bridge is running
    };
    tracing::info!(
        "Shared browser bridge listening on port {}",
        SHARED_BRIDGE_PORT
    );
    spawn_cdp_bridge(
        app_handle,
        listener,
        CdpBridge {
            label: "Shared bridge",
            profile_id: SHARED_AGENT_ID.to_string(),
            port: SHARED_BRIDGE_PORT,
            token: browser_bridge_token(SHARED_AGENT_ID),
        },
    );
    Ok(())
}

/// First port of the JIT-proxy range; ports are `[BASE, BASE + SPAN)`.
const JIT_PROXY_PORT_BASE: u16 = 10000;
const JIT_PROXY_PORT_SPAN: u16 = 1000;

/// The JIT-proxy port for an agent.
///
/// Single source of truth — this same value is used when (a) binding the proxy
/// listener, (b) writing PLAYWRIGHT_CDP_ENDPOINT into the agent's env, and (c) writing
/// `browser.cdpUrl` into an isolated container's openclaw.json.
///
/// This used to be `10000 + DefaultHasher(agent_id) % 1000` with no collision handling:
/// `agent-boots` and `agent-sterling` both landed on 10741, and because
/// `enable_jit_proxy` treated a failed bind as "already running", the second agent was
/// silently handed the first agent's proxy. DefaultHasher's algorithm is also
/// unspecified across Rust releases, so it was never safe to persist.
///
/// Now: start from a stable FNV-1a hash, probe forward past ports already assigned to
/// other agents, and persist the assignment (`jit-proxy-ports.json` in the data dir) so
/// an agent keeps its port across restarts regardless of the order agents are seen in.
pub fn jit_proxy_port_for(agent_id: &str) -> u16 {
    let mut registry = jit_port_registry()
        .lock()
        .expect("jit port registry poisoned");
    if let Some(port) = registry.get(agent_id) {
        return *port;
    }
    let port = allocate_jit_proxy_port(agent_id, &registry);
    registry.insert(agent_id.to_string(), port);
    persist_jit_port_registry(&registry);
    port
}

/// Pick a port for `agent_id` that no OTHER agent in `assigned` holds: the agent's
/// stable-hash slot, or the next free slot after it (wrapping within the range).
fn allocate_jit_proxy_port(agent_id: &str, assigned: &HashMap<String, u16>) -> u16 {
    let taken: std::collections::HashSet<u16> = assigned
        .iter()
        .filter(|(id, _)| id.as_str() != agent_id)
        .map(|(_, port)| *port)
        .collect();
    let start = (fnv1a_64(agent_id.as_bytes()) % u64::from(JIT_PROXY_PORT_SPAN)) as u16;
    (0..JIT_PROXY_PORT_SPAN)
        .map(|step| JIT_PROXY_PORT_BASE + (start + step) % JIT_PROXY_PORT_SPAN)
        .find(|port| !taken.contains(port))
        // Range exhausted (1000 agents). Fall back to the hash slot — enable_jit_proxy's
        // bind then fails loudly instead of sharing another agent's listener.
        .unwrap_or(JIT_PROXY_PORT_BASE + start)
}

/// 64-bit FNV-1a — tiny, and unlike `DefaultHasher` its output is fixed forever.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn jit_port_registry() -> &'static std::sync::Mutex<HashMap<String, u16>> {
    static REGISTRY: std::sync::OnceLock<std::sync::Mutex<HashMap<String, u16>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| {
        let raw = jit_port_registry_path()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_default();
        std::sync::Mutex::new(parse_jit_port_registry(&raw))
    })
}

#[cfg(not(test))]
fn jit_port_registry_path() -> Option<PathBuf> {
    crate::flavor::canopy_data_dir().map(|dir| dir.join("jit-proxy-ports.json"))
}

/// Unit tests never read or write the user's real data dir.
#[cfg(test)]
fn jit_port_registry_path() -> Option<PathBuf> {
    None
}

/// Parse the persisted `{agent_id: port}` map, dropping out-of-range ports and any
/// duplicate port (first agent id in sorted order keeps it; the other is reallocated).
fn parse_jit_port_registry(raw: &str) -> HashMap<String, u16> {
    let parsed: std::collections::BTreeMap<String, u16> =
        serde_json::from_str(raw).unwrap_or_default();
    let range = JIT_PROXY_PORT_BASE..JIT_PROXY_PORT_BASE + JIT_PROXY_PORT_SPAN;
    let mut seen = std::collections::HashSet::new();
    parsed
        .into_iter()
        .filter(|(_, port)| range.contains(port) && seen.insert(*port))
        .collect()
}

fn persist_jit_port_registry(registry: &HashMap<String, u16>) {
    let Some(path) = jit_port_registry_path() else {
        return;
    };
    let sorted: std::collections::BTreeMap<&String, &u16> = registry.iter().collect();
    let result = serde_json::to_string_pretty(&sorted)
        .map_err(|e| e.to_string())
        .and_then(|body| {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&path, body).map_err(|e| e.to_string())
        });
    if let Err(e) = result {
        // The in-memory assignment still keeps this process consistent.
        tracing::warn!("Could not persist JIT proxy ports to {:?}: {}", path, e);
    }
}

/// agent_id → port for every JIT listener THIS process has bound.
fn jit_listeners() -> &'static tokio::sync::Mutex<HashMap<String, u16>> {
    static LISTENERS: std::sync::OnceLock<tokio::sync::Mutex<HashMap<String, u16>>> =
        std::sync::OnceLock::new();
    LISTENERS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

pub async fn enable_jit_proxy(
    app_handle: tauri::AppHandle,
    agent_id: String,
) -> Result<u16, String> {
    let proxy_port = jit_proxy_port_for(&agent_id);

    // Held across the bind so two concurrent calls for the same agent can't both miss
    // the registry and have the loser misreport the winner's bind as a conflict.
    let mut listeners = jit_listeners().lock().await;
    if listeners.get(&agent_id) == Some(&proxy_port) {
        return Ok(proxy_port); // our listener for this agent is already running
    }
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", proxy_port)).await {
        Ok(l) => l,
        // NOT "already running for me" — our own listeners are all in `listeners`. The
        // port is held by something else (a stale Canopy, another flavor, an unrelated
        // service), and handing it out would point this agent at someone else's proxy.
        Err(e) => {
            return Err(format!(
                "JIT proxy port {} for {} is held by another listener: {}",
                proxy_port, agent_id, e
            ))
        }
    };
    listeners.insert(agent_id.clone(), proxy_port);
    drop(listeners);

    tracing::info!(
        "JIT Proxy listening on port {} for {}",
        proxy_port,
        agent_id
    );
    spawn_cdp_bridge(
        app_handle,
        listener,
        CdpBridge {
            label: "JIT Proxy",
            token: browser_bridge_token(&agent_id),
            profile_id: agent_id,
            port: proxy_port,
        },
    );
    Ok(proxy_port)
}

/// Accept loop shared by the shared bridge and every JIT proxy. Each connection is
/// handled on its own task; once the last one closes and the bridge stays quiet for
/// `BRIDGE_IDLE_SHUTDOWN`, the fronted automated Chrome is stopped.
fn spawn_cdp_bridge(
    app_handle: tauri::AppHandle,
    listener: tokio::net::TcpListener,
    bridge: CdpBridge,
) {
    let activity = Arc::new(BridgeActivity::default());
    tauri::async_runtime::spawn(async move {
        loop {
            let (client_stream, peer_addr) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(e) => {
                    tracing::warn!("{}: accept failed: {}", bridge.label, e);
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }
            };
            // Trace every accepted TCP connection so we can answer "did OpenClaw
            // actually try to connect?" without inferring from Chrome-lifecycle events.
            tracing::info!(
                "{}: accepted connection from {} for {}",
                bridge.label,
                peer_addr,
                bridge.profile_id
            );
            let app = app_handle.clone();
            let bridge = bridge.clone();
            let activity = activity.clone();
            tauri::async_runtime::spawn(async move {
                activity.enter();
                handle_cdp_bridge_connection(&app, &bridge, client_stream).await;
                let Some(epoch) = activity.leave() else {
                    return;
                };
                tokio::time::sleep(BRIDGE_IDLE_SHUTDOWN).await;
                // Re-check under the resolve lock: a connection that arrived meanwhile
                // is either visible in `activity` already, or blocks on this lock and
                // spawns a fresh Chrome after the stop instead of racing it.
                let _guard = resolve_lock_for(&bridge.profile_id).lock().await;
                if activity.still_idle(epoch) {
                    tracing::info!(
                        "{}: idle {}s — stopping Chrome for {}",
                        bridge.label,
                        BRIDGE_IDLE_SHUTDOWN.as_secs(),
                        bridge.profile_id
                    );
                    use tauri::Manager;
                    // Automated only: a trusted-login window must survive idle
                    // shutdown (the user may take minutes to finish signing in).
                    let _ = app
                        .state::<BrowserManager>()
                        .stop_automated_browser(&bridge.profile_id)
                        .await;
                }
            });
        }
    });
}

/// Host, port and `/devtools/browser/<guid>` path of a Chrome CDP WebSocket URL.
fn cdp_target(cdp_endpoint: &str) -> Option<(String, u16, String)> {
    let url = url::Url::parse(cdp_endpoint).ok()?;
    let port = url.port().filter(|p| *p != 0)?;
    let host = url.host_str().unwrap_or("127.0.0.1").to_string();
    Some((host, port, url.path().to_string()))
}

/// Answer a bridge client with a short plain-text error instead of a silent close, so
/// OpenClaw/Playwright surface an actionable reason rather than "socket hang up".
async fn respond_bridge_error(
    client_stream: &mut tokio::net::TcpStream,
    status: &str,
    message: &str,
) {
    use tokio::io::AsyncWriteExt;
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        message.len(),
        message
    );
    let _ = client_stream.write_all(response.as_bytes()).await;
}

async fn handle_cdp_bridge_connection(
    app: &tauri::AppHandle,
    bridge: &CdpBridge,
    mut client_stream: tokio::net::TcpStream,
) {
    use tauri::Manager;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    // Authenticate before starting or connecting to Chrome. This listener must be
    // reachable from Docker, so an unauthenticated LAN connection must not be able to
    // trigger a browser spawn or consume proxy work.
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];
    let mut header_end: Option<usize> = None;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while header_end.is_none() && std::time::Instant::now() < deadline {
        let n = match client_stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_header_terminator(&buf) {
            header_end = Some(pos);
        }
        if buf.len() > 64 * 1024 {
            break;
        }
    }
    let Some(end) = header_end else {
        tracing::warn!("{}: rejected incomplete HTTP request", bridge.label);
        return;
    };
    let (headers, body) = buf.split_at(end + 4);
    let headers_str = String::from_utf8_lossy(headers);
    let Some(authenticated_headers) = authenticate_bridge_request(&headers_str, &bridge.token)
    else {
        let _ = client_stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        tracing::warn!(
            "{}: rejected unauthenticated connection for {}",
            bridge.label,
            bridge.profile_id
        );
        return;
    };

    let browser_manager = app.state::<BrowserManager>();

    // A live trusted-login window owns this profile (the user is signing in to a site
    // by hand). It runs WITHOUT remote debugging, so it is not a CDP target — and
    // spawning an automated Chrome would kill their window mid-login. Refuse loudly;
    // the next attempt after "resume automation" succeeds.
    if let Ok(Some(status)) = browser_manager.get_status(&bridge.profile_id).await {
        if status.mode == BrowserMode::InteractiveAuth {
            tracing::warn!(
                "{}: trusted-login window open for {} — refusing CDP until automation resumes",
                bridge.label,
                bridge.profile_id
            );
            respond_bridge_error(
                &mut client_stream,
                "503 Service Unavailable",
                "A trusted-login window is open for this browser profile; resume automation in Canopy first.",
            )
            .await;
            return;
        }
    }

    // Resolve a live Chrome, lazily spawning one. This deliberately BLOCKS the request —
    // including OpenClaw's `attachOnly` /json/version reachability probe, which is the
    // request that triggers a cold spawn — until Chrome is actually listening. The wait
    // is bounded: leftover cleanup plus `CHROME_DEVTOOLS_READY_TIMEOUT` (15s) for the
    // spawn itself. OpenClaw's matching client timeout is OPENCLAW_REMOTE_CDP_TIMEOUT_MS.
    let status = match browser_manager
        .ensure_automated_browser(app.clone(), &bridge.profile_id)
        .await
    {
        Ok(status) => status,
        Err(e) => {
            tracing::error!(
                "{}: Chrome spawn failed for {}: {:#}",
                bridge.label,
                bridge.profile_id,
                e
            );
            respond_bridge_error(
                &mut client_stream,
                "503 Service Unavailable",
                "Canopy could not start the managed browser.",
            )
            .await;
            return;
        }
    };
    let Some((mut chrome_host, mut chrome_port, mut chrome_path)) =
        cdp_target(&status.cdp_endpoint)
    else {
        tracing::error!(
            "{}: unparseable CDP endpoint {:?} for {}",
            bridge.label,
            status.cdp_endpoint,
            bridge.profile_id
        );
        respond_bridge_error(
            &mut client_stream,
            "502 Bad Gateway",
            "Bad managed-browser endpoint.",
        )
        .await;
        return;
    };

    // Self-heal a dead Chrome: if the endpoint refuses the connection (crashed, pkill'd,
    // or OOM'd between the liveness check and now), recover once through the resolve
    // lock — reusing a replacement another connection already spawned rather than
    // killing it — and retry.
    let connected = match TcpStream::connect((chrome_host.as_str(), chrome_port)).await {
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
            tracing::warn!(
                "{}: Chrome at {}:{} is dead ({}); respawning for {}",
                bridge.label,
                chrome_host,
                chrome_port,
                e,
                bridge.profile_id
            );
            match browser_manager
                .recover_automated_browser(app.clone(), &bridge.profile_id, &status.cdp_endpoint)
                .await
                .ok()
                .and_then(|fresh| cdp_target(&fresh.cdp_endpoint))
            {
                Some((host, port, path)) => {
                    // The fresh Chrome has a new port AND a new /devtools/browser/<guid>
                    // path — update all three so the rewrite below targets the live
                    // instance, not the corpse.
                    chrome_host = host;
                    chrome_port = port;
                    chrome_path = path;
                    TcpStream::connect((chrome_host.as_str(), chrome_port)).await
                }
                None => Err(std::io::Error::other("managed browser respawn failed")),
            }
        }
        other => other,
    };
    let mut chrome_stream = match connected {
        Ok(stream) => stream,
        Err(e) => {
            tracing::error!(
                "{}: could not reach Chrome at {}:{} for {}: {}",
                bridge.label,
                chrome_host,
                chrome_port,
                bridge.profile_id,
                e
            );
            respond_bridge_error(
                &mut client_stream,
                "502 Bad Gateway",
                "The managed browser is not reachable.",
            )
            .await;
            return;
        }
    };
    tracing::debug!(
        "{}: connected to Chrome CDP at {}:{}",
        bridge.label,
        chrome_host,
        chrome_port
    );

    // Chrome DevTools enforces TWO protections we have to satisfy:
    //   1. The `Host:` header must be `localhost` or an IP address (DNS-rebinding
    //      protection) — the container sends `Host: host.docker.internal:PORT`.
    //   2. The path must match an existing target — for the browser WebSocket that is
    //      the CURRENT `/devtools/browser/<guid>`, which `rewrite_request_line` maps
    //      bare `/` and any (possibly stale) browser GUID onto.
    let rewritten = rewrite_cdp_request_headers(&authenticated_headers, chrome_port, &chrome_path);
    if let Err(e) = chrome_stream.write_all(rewritten.as_bytes()).await {
        tracing::warn!("{}: failed to write headers to Chrome: {}", bridge.label, e);
        return;
    }
    if !body.is_empty() {
        let _ = chrome_stream.write_all(body).await;
    }

    // Relay Chrome's response:
    //   • HTTP 101 (WebSocket upgrade) → flush headers, then tunnel bidirectionally.
    //   • /json/version & /json/list → the JSON body leaks Chrome's internal
    //     `127.0.0.1:<chrome_port>` in `webSocketDebuggerUrl`, which the container
    //     can't reach. Rewrite it to this bridge's own origin (capability included), so
    //     the URL OpenClaw's `attachOnly` preflight hands to Playwright comes straight
    //     back through here — where a GUID that has since gone stale is still mapped
    //     onto the live browser.
    //   • Anything else → flush and tunnel; no URL leak to fix.
    let bridge_origin = format!("host.docker.internal:{}/{}", bridge.port, bridge.token);
    let chrome_origin = format!("127.0.0.1:{}", chrome_port);
    if let Err(e) = relay_chrome_response_to_client(
        &mut chrome_stream,
        &mut client_stream,
        &chrome_origin,
        &bridge_origin,
    )
    .await
    {
        tracing::warn!(
            "{}: response relay failed for {}: {}",
            bridge.label,
            bridge.profile_id,
            e
        );
    }
}

/// Find the index of the byte BEFORE the `\r\n\r\n` end-of-headers terminator.
/// Returns None if not found.
fn find_header_terminator(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Rewrite an outbound HTTP request from the JIT proxy to Chrome's CDP socket.
///
/// Two transformations:
///   1. `Host:` header → `Host: 127.0.0.1:<chrome_port>`. Chrome's DevTools server
///      rejects any other Host value as a DNS-rebinding defence — without this rewrite
///      the agent's container-side Playwright connection times out with
///      "Host header is specified and is not an IP address or localhost".
///   2. A bare `GET / HTTP/...` or any `/devtools/browser/<guid>` (stale or not)
///      becomes `<chrome_path>` so the upgrade hits the live browser endpoint — see
///      `rewrite_request_line`. Any other path is forwarded unchanged so
///      `/json/version`, `/json/list`, and `/devtools/page/...` all work too.
///
/// Pure function — broken out so we can unit-test the header surgery without spinning
/// up a real socket.
fn rewrite_cdp_request_headers(headers: &str, chrome_port: u16, chrome_path: &str) -> String {
    let target_host = format!("127.0.0.1:{}", chrome_port);
    let mut out = String::with_capacity(headers.len() + 64);
    let mut first_line = true;
    let mut host_replaced = false;

    // The input ends with `\r\n\r\n` (HTTP header terminator). Splitting on `\r\n`
    // yields trailing empty strings; if we naively `line + "\r\n"` every iteration we
    // end up with `\r\n\r\n\r\n`. Chrome's DevTools HTTP parser treats the extra
    // CRLF as malformed body framing and slams the connection shut with no response —
    // which is exactly the "Empty reply from server" we kept seeing despite the
    // forward log claiming success.
    //
    // Strip all trailing CRLFs from the input so we control the terminator ourselves.
    let trimmed = headers.trim_end_matches("\r\n");

    for line in trimmed.split("\r\n") {
        if first_line {
            first_line = false;
            // Map `/` and any browser GUID onto the live browser target; leave every
            // other explicit path the client sent in place.
            if let Some(rewritten) = rewrite_request_line(line, chrome_path) {
                out.push_str(&rewritten);
            } else {
                out.push_str(line);
            }
            out.push_str("\r\n");
            continue;
        }

        // Case-insensitive Host: header check.
        let line_trimmed = line.trim_start();
        if line_trimmed.len() >= 5 && line_trimmed[..5].eq_ignore_ascii_case("host:") {
            out.push_str("Host: ");
            out.push_str(&target_host);
            out.push_str("\r\n");
            host_replaced = true;
            continue;
        }

        out.push_str(line);
        out.push_str("\r\n");
    }

    // If the client omitted a Host header entirely, inject ours so Chrome accepts.
    if !host_replaced {
        out.push_str("Host: ");
        out.push_str(&target_host);
        out.push_str("\r\n");
    }

    // Append the single header terminator — exactly one extra CRLF, no more.
    out.push_str("\r\n");

    out
}

/// Relay Chrome's response back to the client, rewriting any leaked Chrome-internal
/// address (`127.0.0.1:<chrome_port>`) to the bridge address (`host.docker.internal:<SHARED_BRIDGE_PORT>`).
///
/// Three response shapes to handle:
///
///   1. **HTTP 101 Switching Protocols** — the WebSocket upgrade. Headers don't carry
///      addressable URLs we care about. Flush the response headers verbatim and then
///      tunnel both directions for the frame traffic.
///
///   2. **HTTP 200 with a JSON body** (`/json/version`, `/json/list`, etc) — Chrome
///      embeds `webSocketDebuggerUrl: ws://127.0.0.1:<chrome_port>/...` in the body.
///      Buffer the full body, do a literal string replace of `chrome_origin` →
///      `bridge_origin`, recompute `Content-Length`, send the corrected response.
///      This is the path OpenClaw's `attachOnly` preflight depends on.
///
///   3. **Anything else** — flush whatever we already buffered and stream the rest
///      with `copy_bidirectional`. Most code paths through Chrome's DevTools server
///      don't hit this branch.
async fn relay_chrome_response_to_client(
    chrome_stream: &mut tokio::net::TcpStream,
    client_stream: &mut tokio::net::TcpStream,
    chrome_origin: &str,
    bridge_origin: &str,
) -> std::io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Read until end-of-headers. Same 5-second deadline as the request side.
    let mut resp = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];
    let mut header_end: Option<usize> = None;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while header_end.is_none() && std::time::Instant::now() < deadline {
        let n = match chrome_stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return Err(e),
        };
        resp.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_header_terminator(&resp) {
            header_end = Some(pos);
            break;
        }
        if resp.len() > 256 * 1024 {
            break;
        }
    }

    let Some(end) = header_end else {
        // No headers received — Chrome closed before sending anything.
        return Ok(());
    };

    let (headers_bytes, already_body) = resp.split_at(end + 4);
    let headers_str = String::from_utf8_lossy(headers_bytes).to_string();

    // Detect WebSocket upgrade — first line will be "HTTP/1.1 101 Switching Protocols".
    let status_line = headers_str.lines().next().unwrap_or("");
    let is_upgrade = status_line.contains(" 101 ");

    if is_upgrade {
        // Headers carry no leaked URL — forward verbatim, then tunnel WebSocket frames.
        client_stream.write_all(headers_bytes).await?;
        if !already_body.is_empty() {
            client_stream.write_all(already_body).await?;
        }
        let _ = tokio::io::copy_bidirectional(client_stream, chrome_stream).await;
        return Ok(());
    }

    // Parse Content-Length if present so we know how much body to expect.
    let content_length = parse_content_length(&headers_str);

    // Buffer the full body. With Content-Length we read exactly that many bytes
    // (already_body might already contain part of it). Without Content-Length the
    // server signals EOF by closing — read to EOF.
    let mut body = Vec::from(already_body);
    match content_length {
        Some(total) => {
            while body.len() < total {
                let to_read = (total - body.len()).min(chunk.len());
                let n = chrome_stream.read(&mut chunk[..to_read]).await?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..n]);
            }
        }
        None => {
            // No Content-Length — drain until EOF.
            loop {
                let n = chrome_stream.read(&mut chunk).await?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..n]);
            }
        }
    }

    // Rewrite the leaked Chrome origin in the body. This is a literal string replace —
    // safe because the chrome_port is unique per Chrome spawn and `127.0.0.1:NNNNN`
    // is unlikely to appear elsewhere in the response.
    let body_str = String::from_utf8_lossy(&body).to_string();
    let rewritten_body = body_str.replace(chrome_origin, bridge_origin);
    let body_bytes = rewritten_body.into_bytes();

    // Rebuild the response with a fixed Content-Length matching the new body. We also
    // drop any `Transfer-Encoding: chunked` header (Chrome's /json/* never uses it,
    // but defensive). All other headers passthrough.
    let new_headers = rebuild_response_headers(&headers_str, body_bytes.len());

    client_stream.write_all(new_headers.as_bytes()).await?;
    client_stream.write_all(&body_bytes).await?;
    Ok(())
}

/// Extract `Content-Length` value from an HTTP header block, if present.
fn parse_content_length(headers: &str) -> Option<usize> {
    for line in headers.split("\r\n") {
        let trimmed = line.trim_start();
        if trimmed.len() >= 15 && trimmed[..15].eq_ignore_ascii_case("content-length:") {
            return trimmed[15..].trim().parse::<usize>().ok();
        }
    }
    None
}

/// Reproduce a response header block with `Content-Length` set to `new_length` and
/// any `Transfer-Encoding` header removed (since we always emit a fixed-length body).
fn rebuild_response_headers(headers: &str, new_length: usize) -> String {
    let trimmed = headers.trim_end_matches("\r\n");
    let mut out = String::with_capacity(trimmed.len() + 32);
    let mut first_line = true;
    let mut content_length_emitted = false;

    for line in trimmed.split("\r\n") {
        if first_line {
            first_line = false;
            out.push_str(line);
            out.push_str("\r\n");
            continue;
        }
        let lc = line.trim_start();
        if lc.len() >= 15 && lc[..15].eq_ignore_ascii_case("content-length:") {
            out.push_str(&format!("Content-Length: {}\r\n", new_length));
            content_length_emitted = true;
            continue;
        }
        if lc.len() >= 18 && lc[..18].eq_ignore_ascii_case("transfer-encoding:") {
            continue; // skip — we're sending fixed length
        }
        out.push_str(line);
        out.push_str("\r\n");
    }

    // If the original response didn't carry Content-Length (rare for /json/*), inject one.
    if !content_length_emitted {
        out.push_str(&format!("Content-Length: {}\r\n", new_length));
    }

    out.push_str("\r\n");
    out
}

const BROWSER_TARGET_PATH: &str = "/devtools/browser";

/// Point a request at the LIVE Chrome's browser target when it addresses the browser:
/// bare `/` (Playwright with a no-path CDP URL) or ANY `/devtools/browser/<guid>`.
///
/// The GUID changes on every Chrome spawn. A client holding one from an earlier
/// /json/version — or from before an idle shutdown / crash respawn — used to be
/// forwarded verbatim and get a 404 / socket hang up on the WebSocket upgrade. A bridge
/// fronts exactly one browser, so any browser GUID can only mean "this bridge's
/// browser". Page/worker targets (`/devtools/page/<id>`) and `/json/*` are untouched.
/// Returns None when the line should be forwarded as-is.
fn rewrite_request_line(line: &str, chrome_path: &str) -> Option<String> {
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    let version = parts.next()?;
    if parts.next().is_some() || !is_browser_target_path(chrome_path) {
        return None;
    }
    let (path, query) = target
        .split_once('?')
        .map_or((target, None), |(path, query)| (path, Some(query)));
    if (path != "/" && !is_browser_target_path(path)) || path == chrome_path {
        return None;
    }
    Some(match query {
        Some(query) => format!("{} {}?{} {}", method, chrome_path, query, version),
        None => format!("{} {} {}", method, chrome_path, version),
    })
}

fn is_browser_target_path(path: &str) -> bool {
    path.strip_prefix(BROWSER_TARGET_PATH)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

#[cfg(test)]
mod jit_proxy_tests {
    use super::{authenticate_bridge_request, rewrite_cdp_request_headers, rewrite_request_line};

    #[test]
    fn bridge_capability_is_required_and_removed_before_forwarding() {
        let request = "GET /secret-cap/json/version?verbose=1 HTTP/1.1\r\nHost: host.docker.internal:19800\r\n\r\n";
        let authenticated =
            authenticate_bridge_request(request, "secret-cap").expect("valid capability");
        assert!(authenticated.starts_with("GET /json/version?verbose=1 HTTP/1.1\r\n"));
        assert!(!authenticated.contains("secret-cap"));

        assert!(authenticate_bridge_request(request, "wrong-cap").is_none());
        assert!(authenticate_bridge_request(
            "GET /secret-cap-extra/json/version HTTP/1.1\r\nHost: x\r\n\r\n",
            "secret-cap"
        )
        .is_none());
        assert!(authenticate_bridge_request(
            "GET /json/version HTTP/1.1\r\nHost: x\r\n\r\n",
            "secret-cap"
        )
        .is_none());
    }

    #[test]
    fn bridge_capability_root_maps_to_chrome_root() {
        let authenticated = authenticate_bridge_request(
            "GET /secret-cap HTTP/1.1\r\nHost: x\r\n\r\n",
            "secret-cap",
        )
        .expect("valid capability");
        assert!(authenticated.starts_with("GET / HTTP/1.1\r\n"));
    }

    #[test]
    fn host_header_is_rewritten_to_loopback() {
        let req =
            "GET / HTTP/1.1\r\nHost: host.docker.internal:10042\r\nUpgrade: websocket\r\n\r\n";
        let out = rewrite_cdp_request_headers(req, 54198, "/devtools/browser/abc-123");
        assert!(
            out.contains("Host: 127.0.0.1:54198\r\n"),
            "rewrite missing: {}",
            out
        );
        // Original Host line must be gone.
        assert!(
            !out.contains("host.docker.internal"),
            "stale Host survived: {}",
            out
        );
    }

    #[test]
    fn root_path_is_rewritten_to_chrome_browser_path() {
        let req = "GET / HTTP/1.1\r\nHost: host.docker.internal:10042\r\n\r\n";
        let out = rewrite_cdp_request_headers(req, 54198, "/devtools/browser/abc-123");
        assert!(
            out.starts_with("GET /devtools/browser/abc-123 HTTP/1.1\r\n"),
            "got: {}",
            out
        );
    }

    #[test]
    fn explicit_path_is_preserved() {
        let req = "GET /json/version HTTP/1.1\r\nHost: x.example:80\r\n\r\n";
        let out = rewrite_cdp_request_headers(req, 54198, "/devtools/browser/abc");
        assert!(
            out.starts_with("GET /json/version HTTP/1.1\r\n"),
            "got: {}",
            out
        );
    }

    #[test]
    fn missing_host_header_gets_injected() {
        let req = "GET /json/version HTTP/1.1\r\nUpgrade: websocket\r\n\r\n";
        let out = rewrite_cdp_request_headers(req, 54198, "/devtools/browser/abc");
        assert!(
            out.contains("Host: 127.0.0.1:54198\r\n"),
            "Host not injected: {}",
            out
        );
    }

    #[test]
    fn rewrite_request_line_only_rewrites_root() {
        assert_eq!(
            rewrite_request_line("GET / HTTP/1.1", "/devtools/browser/x").as_deref(),
            Some("GET /devtools/browser/x HTTP/1.1")
        );
        assert_eq!(
            rewrite_request_line("GET /json/version HTTP/1.1", "/devtools/browser/x"),
            None
        );
        assert_eq!(rewrite_request_line("POST / HTTP/1.1", "/"), None); // no useful rewrite if chrome_path is /
    }

    #[test]
    fn stale_browser_guid_is_rewritten_to_live_browser_path() {
        // Regression: a GUID from an earlier Chrome (read off /json/version before a
        // respawn) used to be forwarded verbatim → Chrome 404 on the WS upgrade.
        assert_eq!(
            rewrite_request_line(
                "GET /devtools/browser/dead-guid HTTP/1.1",
                "/devtools/browser/live-guid"
            )
            .as_deref(),
            Some("GET /devtools/browser/live-guid HTTP/1.1")
        );
        assert_eq!(
            rewrite_request_line("GET /devtools/browser HTTP/1.1", "/devtools/browser/live")
                .as_deref(),
            Some("GET /devtools/browser/live HTTP/1.1")
        );
        // Query strings survive the rewrite.
        assert_eq!(
            rewrite_request_line(
                "GET /devtools/browser/old?x=1 HTTP/1.1",
                "/devtools/browser/new"
            )
            .as_deref(),
            Some("GET /devtools/browser/new?x=1 HTTP/1.1")
        );
        // The live path itself needs no rewrite.
        assert_eq!(
            rewrite_request_line(
                "GET /devtools/browser/live HTTP/1.1",
                "/devtools/browser/live"
            ),
            None
        );
    }

    #[test]
    fn non_browser_targets_are_never_rewritten() {
        for line in [
            "GET /devtools/page/ABC HTTP/1.1",
            "GET /json/list HTTP/1.1",
            "GET /devtools/browserx/abc HTTP/1.1",
        ] {
            assert_eq!(
                rewrite_request_line(line, "/devtools/browser/live"),
                None,
                "{line}"
            );
        }
    }

    #[test]
    fn stale_guid_upgrade_reaches_live_browser_through_full_header_rewrite() {
        let authenticated = authenticate_bridge_request(
            "GET /cap/devtools/browser/dead-guid HTTP/1.1\r\nHost: host.docker.internal:19800\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
            "cap",
        )
        .expect("valid capability");
        let out = rewrite_cdp_request_headers(&authenticated, 54198, "/devtools/browser/live-guid");
        assert!(
            out.starts_with("GET /devtools/browser/live-guid HTTP/1.1\r\n"),
            "got: {out}"
        );
        assert!(out.contains("Host: 127.0.0.1:54198\r\n"));
        assert!(out.contains("Upgrade: websocket\r\n"));
    }

    /// /json/version's `webSocketDebuggerUrl` must come back pointing at the bridge
    /// (capability included), never at Chrome's container-unreachable loopback port.
    #[tokio::test]
    async fn json_version_websocket_url_is_rewritten_to_bridge_origin() {
        use super::relay_chrome_response_to_client;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};

        let chrome = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let chrome_port = chrome.local_addr().unwrap().port();
        let body = format!(
            r#"{{"Browser":"Chrome/140","webSocketDebuggerUrl":"ws://127.0.0.1:{chrome_port}/devtools/browser/guid-1"}}"#
        );
        let fake_chrome = tokio::spawn(async move {
            let (mut s, _) = chrome.accept().await.unwrap();
            let mut req = [0u8; 1024];
            let _ = s.read(&mut req).await;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            s.write_all(resp.as_bytes()).await.unwrap();
        });

        let client_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(client_listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut bridge_side, _) = client_listener.accept().await.unwrap();

        let mut chrome_stream = TcpStream::connect(("127.0.0.1", chrome_port))
            .await
            .unwrap();
        chrome_stream
            .write_all(b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        relay_chrome_response_to_client(
            &mut chrome_stream,
            &mut bridge_side,
            &format!("127.0.0.1:{chrome_port}"),
            "host.docker.internal:19800/cap",
        )
        .await
        .unwrap();
        drop(bridge_side);
        fake_chrome.await.unwrap();

        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(
            body.contains(r#""webSocketDebuggerUrl":"ws://host.docker.internal:19800/cap/devtools/browser/guid-1""#),
            "got: {body}"
        );
        assert!(!body.contains("127.0.0.1"), "leaked chrome origin: {body}");
        assert!(headers.contains(&format!("Content-Length: {}", body.len())));
    }

    #[test]
    fn output_ends_with_exactly_one_blank_line() {
        // Regression test for the "Empty reply from server" bug: a previous version
        // of this rewriter produced `\r\n\r\n\r\n` at the end, which Chrome's DevTools
        // HTTP parser treats as malformed body framing — Chrome closes the connection
        // with no response, the bridge propagates a zero-byte close to the client,
        // and curl reports `(52) Empty reply from server`.
        let req =
            "GET / HTTP/1.1\r\nHost: host.docker.internal:10042\r\nUpgrade: websocket\r\n\r\n";
        let out = rewrite_cdp_request_headers(req, 54198, "/devtools/browser/abc-123");
        assert!(out.ends_with("\r\n\r\n"), "missing terminator: {:?}", out);
        assert!(
            !out.ends_with("\r\n\r\n\r\n"),
            "extra trailing CRLF: {:?}",
            out
        );
        // Belt-and-suspenders: exactly one occurrence of the header terminator should
        // appear in the output (anywhere — there's no body bytes, so it's only at the end).
        let count = out.matches("\r\n\r\n").count();
        assert_eq!(
            count, 1,
            "expected exactly one \\r\\n\\r\\n terminator, got {} in: {:?}",
            count, out
        );
    }

    #[test]
    fn output_with_no_explicit_host_still_well_formed() {
        let req = "GET /json/version HTTP/1.1\r\nUpgrade: websocket\r\n\r\n";
        let out = rewrite_cdp_request_headers(req, 54198, "/devtools/browser/abc");
        assert!(out.ends_with("\r\n\r\n"), "missing terminator: {:?}", out);
        assert!(
            !out.ends_with("\r\n\r\n\r\n"),
            "extra trailing CRLF: {:?}",
            out
        );
        assert!(out.contains("Host: 127.0.0.1:54198\r\n"));
    }

    // ─── Response-rewriting helpers ───────────────────────────────────────────
    use super::{parse_content_length, rebuild_response_headers};

    #[test]
    fn parse_content_length_handles_basic_case() {
        let headers =
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 421\r\n\r\n";
        assert_eq!(parse_content_length(headers), Some(421));
    }

    #[test]
    fn parse_content_length_is_case_insensitive() {
        let headers = "HTTP/1.1 200 OK\r\ncontent-length: 99\r\n\r\n";
        assert_eq!(parse_content_length(headers), Some(99));
    }

    #[test]
    fn parse_content_length_absent_returns_none() {
        let headers = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n";
        assert_eq!(parse_content_length(headers), None);
    }

    #[test]
    fn rebuild_response_headers_replaces_content_length() {
        let headers =
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 421\r\n\r\n";
        let rebuilt = rebuild_response_headers(headers, 500);
        assert!(rebuilt.contains("Content-Length: 500\r\n"));
        assert!(!rebuilt.contains("Content-Length: 421"));
        // Original status + Content-Type preserved.
        assert!(rebuilt.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(rebuilt.contains("Content-Type: application/json\r\n"));
        // Single terminator.
        assert!(rebuilt.ends_with("\r\n\r\n"));
        assert!(!rebuilt.ends_with("\r\n\r\n\r\n"));
    }

    #[test]
    fn rebuild_response_headers_strips_transfer_encoding() {
        let headers = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
        let rebuilt = rebuild_response_headers(headers, 100);
        assert!(!rebuilt.to_lowercase().contains("transfer-encoding"));
        assert!(rebuilt.contains("Content-Length: 100\r\n"));
    }

    #[test]
    fn rebuild_response_headers_injects_content_length_when_missing() {
        let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n";
        let rebuilt = rebuild_response_headers(headers, 42);
        assert!(rebuilt.contains("Content-Length: 42\r\n"));
    }

    // ─── JIT proxy port allocation ────────────────────────────────────────────
    use super::{
        allocate_jit_proxy_port, fnv1a_64, jit_proxy_port_for, parse_jit_port_registry,
        JIT_PROXY_PORT_BASE, JIT_PROXY_PORT_SPAN,
    };
    use std::collections::HashMap;

    #[test]
    fn jit_ports_for_boots_and_sterling_differ() {
        // Regression: both used to hash to 10741 and the second agent silently got the
        // first one's proxy.
        let boots = jit_proxy_port_for("agent-boots");
        let sterling = jit_proxy_port_for("agent-sterling");
        assert_ne!(boots, sterling);
        // Stable within the process for every caller (listener, env var, openclaw.json).
        assert_eq!(jit_proxy_port_for("agent-boots"), boots);
        assert_eq!(jit_proxy_port_for("agent-sterling"), sterling);
    }

    #[test]
    fn colliding_agent_probes_forward_to_a_free_port() {
        let preferred = allocate_jit_proxy_port("agent-new", &HashMap::new());
        let mut assigned = HashMap::from([("agent-old".to_string(), preferred)]);
        let port = allocate_jit_proxy_port("agent-new", &assigned);
        assert_ne!(port, preferred, "must not share another agent's port");
        assert!((JIT_PROXY_PORT_BASE..JIT_PROXY_PORT_BASE + JIT_PROXY_PORT_SPAN).contains(&port));

        // An agent's own existing assignment never counts as a collision.
        assigned.remove("agent-old");
        assigned.insert("agent-new".to_string(), preferred);
        assert_eq!(allocate_jit_proxy_port("agent-new", &assigned), preferred);
    }

    #[test]
    fn collision_probe_wraps_at_end_of_range() {
        let last = JIT_PROXY_PORT_BASE + JIT_PROXY_PORT_SPAN - 1;
        // Occupy every port except the first so the probe must wrap to find it.
        let assigned: HashMap<String, u16> = (JIT_PROXY_PORT_BASE + 1..=last)
            .map(|p| (format!("agent-{p}"), p))
            .collect();
        assert_eq!(
            allocate_jit_proxy_port("agent-x", &assigned),
            JIT_PROXY_PORT_BASE
        );
    }

    #[test]
    fn preferred_slot_uses_stable_fnv1a_hash() {
        // Pinned FNV-1a test vectors: the preferred port must never change between Rust
        // releases the way DefaultHasher's output may.
        assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63_dc4c_8601_ec8c);
        let expected = JIT_PROXY_PORT_BASE + (fnv1a_64(b"agent-boots") % 1000) as u16;
        assert_eq!(
            allocate_jit_proxy_port("agent-boots", &HashMap::new()),
            expected
        );
    }

    #[test]
    fn persisted_registry_drops_out_of_range_and_duplicate_ports() {
        let parsed = parse_jit_port_registry(
            r#"{"agent-a": 10741, "agent-b": 10741, "agent-c": 80, "agent-d": 10002}"#,
        );
        assert_eq!(parsed.get("agent-a"), Some(&10741));
        assert_eq!(
            parsed.get("agent-b"),
            None,
            "duplicate port must be reallocated"
        );
        assert_eq!(
            parsed.get("agent-c"),
            None,
            "out-of-range port must be reallocated"
        );
        assert_eq!(parsed.get("agent-d"), Some(&10002));
        assert!(parse_jit_port_registry("not json").is_empty());
    }
}

#[cfg(test)]
mod bridge_lifecycle_tests {
    use super::{leftover_process_pattern, parse_devtools_listening_line, BridgeActivity};

    #[test]
    fn idle_timer_fires_only_when_nothing_happened_since_it_was_armed() {
        let activity = BridgeActivity::default();
        activity.enter();
        let epoch = activity.leave().expect("last connection closed");
        assert!(activity.still_idle(epoch));

        // A connection that came AND went while the timer slept must cancel it —
        // previously the stale timer killed Chrome right after that connection had
        // used it (and handed out its GUID).
        activity.enter();
        let later = activity.leave().expect("closed again");
        assert!(!activity.still_idle(epoch));
        assert!(activity.still_idle(later));
    }

    #[test]
    fn idle_timer_is_not_armed_while_connections_remain_open() {
        let activity = BridgeActivity::default();
        activity.enter();
        activity.enter();
        assert_eq!(activity.leave(), None);
        let epoch = activity.leave().expect("now idle");
        activity.enter(); // new connection still open
        assert!(!activity.still_idle(epoch));
    }

    #[test]
    fn devtools_listening_line_is_parsed() {
        assert_eq!(
            parse_devtools_listening_line(
                "\nDevTools listening on ws://127.0.0.1:54198/devtools/browser/abc-123\n"
            ),
            Some((
                54198,
                "ws://127.0.0.1:54198/devtools/browser/abc-123".to_string()
            ))
        );
        assert_eq!(
            parse_devtools_listening_line("[123:ERROR:gpu] something"),
            None
        );
        assert_eq!(
            parse_devtools_listening_line(
                "DevTools listening on ws://127.0.0.1:0/devtools/browser/x"
            ),
            None
        );
    }

    #[test]
    fn leftover_pattern_is_scoped_to_the_exact_profile_dir() {
        let pattern = leftover_process_pattern(
            "/Users/u/Library/Application Support/Canopy/agent-browsers/agent-boots",
        );
        assert_eq!(
            pattern,
            r"/Users/u/Library/Application Support/Canopy/agent-browsers/agent-boots( |/|$)"
        );
        assert_eq!(
            leftover_process_pattern("/d/Canopy (Dev)/agent-browsers/a.b"),
            r"/d/Canopy \(Dev\)/agent-browsers/a\.b( |/|$)"
        );
    }

    /// Run the pattern through the real ERE engine pkill uses: it must match the
    /// agent's own Chrome command lines but not a prefix-sibling agent or another
    /// flavor's profile.
    #[test]
    fn leftover_pattern_matches_only_its_own_chrome() {
        let pattern = leftover_process_pattern("/d/Canopy Dev/agent-browsers/shared-browser");
        let matches = |cmdline: &str| {
            std::process::Command::new("grep")
                .args(["-Eq", &pattern])
                .stdin({
                    let mut f = tempfile::tempfile().unwrap();
                    use std::io::{Seek, Write};
                    writeln!(f, "{cmdline}").unwrap();
                    f.rewind().unwrap();
                    f
                })
                .status()
                .unwrap()
                .success()
        };
        assert!(matches(
            "Chrome --user-data-dir=/d/Canopy Dev/agent-browsers/shared-browser --no-first-run"
        ));
        assert!(matches(
            "Chrome Helper --user-data-dir=/d/Canopy Dev/agent-browsers/shared-browser"
        ));
        assert!(!matches(
            "Chrome --user-data-dir=/d/Canopy/agent-browsers/shared-browser --x"
        ));
        assert!(!matches(
            "Chrome --user-data-dir=/d/Canopy Dev/agent-browsers/shared-browser2 --x"
        ));
    }
}

#[cfg(test)]
mod connectability_tests {
    use super::{status_is_connectable, BrowserMode, BrowserStatus};

    fn status(mode: BrowserMode, port: u16, endpoint: &str) -> BrowserStatus {
        BrowserStatus {
            agent_id: "agent-test".into(),
            port,
            cdp_endpoint: endpoint.into(),
            profile_path: "/tmp/p".into(),
            is_running: true,
            mode,
        }
    }

    #[test]
    fn automated_with_endpoint_is_connectable() {
        let s = status(
            BrowserMode::Automated,
            54198,
            "ws://127.0.0.1:54198/devtools/browser/abc",
        );
        assert!(status_is_connectable(&s));
    }

    #[test]
    fn interactive_auth_is_never_connectable() {
        // Regression: interactive-auth statuses (port 0, empty endpoint) used to
        // flow into the JIT proxy, where `Url::parse("").unwrap()` panicked the
        // connection task — agents reported "no connection to your browser".
        let s = status(BrowserMode::InteractiveAuth, 0, "");
        assert!(!status_is_connectable(&s));
    }

    #[test]
    fn automated_with_empty_endpoint_is_not_connectable() {
        let s = status(BrowserMode::Automated, 54198, "");
        assert!(!status_is_connectable(&s));
    }

    #[test]
    fn automated_with_port_zero_is_not_connectable() {
        let s = status(
            BrowserMode::Automated,
            0,
            "ws://127.0.0.1:0/devtools/browser/abc",
        );
        assert!(!status_is_connectable(&s));
    }
}

#[cfg(test)]
mod browser_launch_tests {
    use super::{build_chrome_args, BrowserMode};

    #[test]
    fn automated_browser_launch_keeps_remote_debugging_and_starts_offscreen() {
        let args = build_chrome_args(
            "/tmp/agent-profile",
            "data:pac",
            BrowserMode::Automated,
            Some("about:blank"),
            false,
        );

        assert!(args.iter().any(|arg| arg == "--remote-debugging-port=0"));
        assert!(args
            .iter()
            .any(|arg| arg == "--remote-debugging-address=127.0.0.1"));
        assert!(args.iter().any(|arg| arg.starts_with("--window-position=")));
        assert!(args.iter().any(|arg| arg == "about:blank"));
    }

    #[test]
    fn interactive_auth_launch_drops_remote_debugging_and_uses_requested_url() {
        let args = build_chrome_args(
            "/tmp/agent-profile",
            "data:pac",
            BrowserMode::InteractiveAuth,
            Some("https://accounts.google.com/"),
            false,
        );

        assert!(!args
            .iter()
            .any(|arg| arg.starts_with("--remote-debugging-port")));
        assert!(!args
            .iter()
            .any(|arg| arg.starts_with("--remote-debugging-address")));
        assert!(args.iter().any(|arg| arg == "--window-position=0,0"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("https://accounts.google.com/")
        );
    }

    #[test]
    fn resumed_automation_restores_last_session() {
        let args = build_chrome_args(
            "/tmp/agent-profile",
            "data:pac",
            BrowserMode::Automated,
            Some("about:blank"),
            true,
        );

        assert!(args.iter().any(|arg| arg == "--restore-last-session"));
    }
}

#[tauri::command]
pub async fn show_browser(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<(), String> {
    let profile_id = effective_browsing_profile(&app_handle, &agent_id);
    let status = state
        .get_status(&profile_id)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(status) = status {
        if status.mode == BrowserMode::InteractiveAuth {
            activate_google_chrome().await;
            return Ok(());
        }
    }

    // 1) Move the window onto the primary monitor via CDP setWindowBounds.
    move_browser(&state, &profile_id, 0, 0)
        .await
        .map_err(|e| e.to_string())?;

    // 2) Bring Chrome to OS-level focus so the user actually sees it. CDP's
    //    `Browser.setWindowBounds` repositions the window but doesn't raise it above
    //    other apps. Without this step the window slides on-screen but stays behind
    //    whatever app the user has focused — they have to alt-tab to find it.
    //
    //    Note: this activates ALL Google Chrome processes (macOS treats them as one
    //    application bundle). Other agent browsers stay parked at their off-screen
    //    coordinates so they remain invisible — only their process focus changes.
    activate_google_chrome().await;

    Ok(())
}

#[tauri::command]
pub async fn hide_browser(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<(), String> {
    let profile_id = effective_browsing_profile(&app_handle, &agent_id);
    let status = state
        .get_status(&profile_id)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(status) = status {
        if status.mode == BrowserMode::InteractiveAuth {
            return Err(
                "Interactive auth window stays visible until you resume automation.".into(),
            );
        }
    }

    // Move the window back to the safe off-screen coordinate computed in
    // `compute_offscreen_position` (left of all monitors, above all monitors).
    let (x, y) = compute_offscreen_position();
    move_browser(&state, &profile_id, x, y)
        .await
        .map_err(|e| e.to_string())
}

async fn activate_google_chrome() {
    let _ = tokio::process::Command::new("osascript")
        .args(["-e", r#"tell application "Google Chrome" to activate"#])
        .output()
        .await;
}

struct PreparedBrowserProfile {
    profile_path: String,
    pac_url: String,
}

fn prepare_agent_browser_profile(agent_id: &str) -> Result<PreparedBrowserProfile> {
    let data_dir = crate::flavor::canopy_data_dir()
        .context("Could not find data directory")?
        .join("agent-browsers")
        .join(agent_id);

    std::fs::create_dir_all(&data_dir)?;
    let profile_path = data_dir.to_string_lossy().to_string();

    let openclaw_state_dir = crate::flavor::canopy_data_dir()
        .context("Could not find data directory")?
        .join("openclaw-state")
        .join("workspace")
        .join(agent_id);
    std::fs::create_dir_all(&openclaw_state_dir)?;
    let download_path = openclaw_state_dir.to_string_lossy().to_string();

    let default_dir = data_dir.join("Default");
    std::fs::create_dir_all(&default_dir)?;
    let prefs_path = default_dir.join("Preferences");
    let prefs_json = serde_json::json!({
        "download": {
            "default_directory": download_path,
            "prompt_for_download": false,
            "directory_upgrade": true
        },
        "savefile": {
            "default_directory": download_path
        }
    });
    std::fs::write(&prefs_path, serde_json::to_string(&prefs_json)?)?;

    let allowlist = read_agent_allowlist(agent_id);
    let pac_script = build_pac_script(allowlist.as_deref());
    use base64::Engine;
    let pac_base64 = base64::engine::general_purpose::STANDARD.encode(&pac_script);
    let pac_url = format!(
        "data:application/x-ns-proxy-autoconfig;base64,{}",
        pac_base64
    );

    Ok(PreparedBrowserProfile {
        profile_path,
        pac_url,
    })
}

/// Tier 5's profile prep. Intentionally a separate directory namespace
/// (`agent-sandbox-browsers/{agent_id}/`, not `agent-browsers/{agent_id}/`) so this
/// Chrome's cookies/logins never overlap with — or get cleaned up alongside — the
/// shared/isolated automation browser `prepare_agent_browser_profile` sets up. Still
/// reuses `build_pac_script(None)` for the same always-on SSRF block (localhost,
/// RFC1918, file://) the automation browser gets; Tier 5 just has no allowlist concept
/// of its own (that's a `browser`-skill/OpenClaw feature, not part of this capability).
fn prepare_agent_sandbox_browser_profile(agent_id: &str) -> Result<PreparedBrowserProfile> {
    let data_dir = crate::flavor::canopy_data_dir()
        .context("Could not find data directory")?
        .join("agent-sandbox-browsers")
        .join(agent_id);
    std::fs::create_dir_all(&data_dir)?;
    let profile_path = data_dir.to_string_lossy().to_string();

    let pac_script = build_pac_script(None);
    use base64::Engine;
    let pac_base64 = base64::engine::general_purpose::STANDARD.encode(&pac_script);
    let pac_url = format!(
        "data:application/x-ns-proxy-autoconfig;base64,{}",
        pac_base64
    );

    Ok(PreparedBrowserProfile {
        profile_path,
        pac_url,
    })
}

/// Budget for a spawned Chrome to print its DevTools URL. Previously 5s — too tight for
/// the first spawn against a cold profile dir, where Gatekeeper assessment, Spotlight
/// indexing, and macOS defaults seeding can push startup past 5 seconds. 15s costs
/// nothing on warm spawns (Chrome usually prints in ~1s).
const CHROME_DEVTOOLS_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Spawns `chrome_path` with `args` and waits (15s budget) for it to print its DevTools
/// WebSocket URL to stderr. Shared by the automation browser and Tier 5's sandbox
/// browser so both get the same stderr handling.
///
/// stderr is read as raw BYTES and drained for Chrome's whole lifetime. The previous
/// `lines().next_line()` reader returned `Err` on the first non-UTF-8 byte Chrome
/// logged, which (a) ended the "DevTools listening" search early — surfacing as a
/// spurious "failed to parse" spawn failure — and (b) ended the drain task, dropping
/// the pipe's read end so Chrome's subsequent stderr writes hit a closed pipe.
async fn spawn_chrome_and_wait_for_cdp(
    chrome_path: &str,
    args: Vec<String>,
) -> Result<(Child, u16, String)> {
    use std::process::Stdio;
    use tokio::io::AsyncBufReadExt;

    let mut child = Command::new(chrome_path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("Failed to spawn Chrome process")?;

    let stderr = child
        .stderr
        .take()
        .context("Chrome stderr pipe was not captured")?;
    let mut reader = tokio::io::BufReader::new(stderr);

    let find_url = async {
        let mut line = Vec::with_capacity(256);
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line).await {
                // EOF / read error: Chrome exited (or closed stderr) before listening.
                Ok(0) | Err(_) => return None,
                Ok(_) => {
                    if let Some(found) =
                        parse_devtools_listening_line(&String::from_utf8_lossy(&line))
                    {
                        return Some(found);
                    }
                }
            }
        }
    };

    let (port, cdp_endpoint) = match tokio::time::timeout(CHROME_DEVTOOLS_READY_TIMEOUT, find_url)
        .await
    {
        Ok(Some(found)) => found,
        Ok(None) => {
            let status = child.try_wait().ok().flatten();
            let _ = child.kill().await;
            return Err(anyhow::anyhow!(
                "Chrome exited before printing its DevTools URL (status: {:?}) — the user-data-dir may be locked by another Chrome",
                status
            ));
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(anyhow::anyhow!(
                "Chrome didn't print its DevTools URL within {}s — the user-data-dir may be locked",
                CHROME_DEVTOOLS_READY_TIMEOUT.as_secs()
            ));
        }
    };

    // Keep the read end of the pipe open and drained for as long as Chrome runs.
    tauri::async_runtime::spawn(async move {
        let _ = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await;
    });

    Ok((child, port, cdp_endpoint))
}

/// Parse Chrome's `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<guid>`
/// stderr line into `(port, ws_url)`. None for any other line.
fn parse_devtools_listening_line(line: &str) -> Option<(u16, String)> {
    const MARKER: &str = "DevTools listening on ";
    let start = line.find(MARKER)? + MARKER.len();
    let ws_url = line[start..].trim();
    let parsed = url::Url::parse(ws_url).ok()?;
    if parsed.scheme() != "ws" {
        return None;
    }
    let port = parsed.port().filter(|p| *p != 0)?;
    Some((port, ws_url.to_string()))
}

/// Escape POSIX extended-regex metacharacters so a filesystem path can be used as a
/// literal inside a `pkill -f` pattern.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if matches!(
            c,
            '.' | '[' | ']' | '{' | '}' | '(' | ')' | '*' | '+' | '?' | '^' | '$' | '|' | '\\'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `pkill -f` pattern matching Chrome processes whose command line references exactly
/// `profile_path` — the path must be followed by a space, `/`, or end of line so an
/// agent id that is a prefix of another (`agent-boots` / `agent-boots2`) never matches.
fn leftover_process_pattern(profile_path: &str) -> String {
    format!("{}( |/|$)", regex_escape(profile_path))
}

fn build_chrome_args(
    profile_path: &str,
    pac_url: &str,
    mode: BrowserMode,
    start_url: Option<&str>,
    restore_last_session: bool,
) -> Vec<String> {
    let (left, top) = match mode {
        BrowserMode::Automated => compute_offscreen_position(),
        BrowserMode::InteractiveAuth => (0, 0),
    };

    let mut args = vec![
        format!("--user-data-dir={}", profile_path),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        format!("--window-position={},{}", left, top),
        "--window-size=1280,800".to_string(),
        "--disable-extensions".to_string(),
        "--deny-permission-prompts".to_string(),
        "--disable-sync".to_string(),
        "--disable-features=TranslateUI".to_string(),
        format!("--proxy-pac-url={}", pac_url),
    ];

    if mode == BrowserMode::Automated {
        args.push("--remote-debugging-port=0".to_string());
        args.push("--remote-debugging-address=127.0.0.1".to_string());
    }

    if restore_last_session {
        args.push("--restore-last-session".to_string());
    }

    args.push(start_url.unwrap_or("about:blank").to_string());
    args
}

async fn capture_browser_url(port: u16) -> Result<Option<String>> {
    if port == 0 {
        return Ok(None);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()?;
    let targets = client
        .get(format!("http://127.0.0.1:{}/json/list", port))
        .send()
        .await?
        .json::<Vec<serde_json::Value>>()
        .await?;

    Ok(targets
        .into_iter()
        .find(|target| target.get("type").and_then(|v| v.as_str()) == Some("page"))
        .and_then(|target| {
            target
                .get("url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .filter(|url| !url.is_empty() && url != "about:blank"))
}

async fn move_browser(state: &BrowserManager, agent_id: &str, left: i32, top: i32) -> Result<()> {
    let cdp_url = match state.get_status(agent_id).await? {
        Some(s) => s.cdp_endpoint,
        None => return Err(anyhow::anyhow!("Browser not running")),
    };

    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::Message;

    let (mut ws_stream, _) = connect_async(&cdp_url)
        .await
        .context("Failed to connect to CDP")?;

    let req1 = serde_json::json!({
        "id": 1,
        "method": "Browser.getWindowForTarget"
    });
    ws_stream
        .send(Message::Text(req1.to_string().into()))
        .await?;

    let mut window_id = None;
    while let Some(msg) = ws_stream.next().await {
        if let Ok(Message::Text(text)) = msg {
            if let Ok(resp) = serde_json::from_str::<serde_json::Value>(&text) {
                if resp.get("id").and_then(|id| id.as_i64()) == Some(1) {
                    window_id = resp.pointer("/result/windowId").and_then(|id| id.as_i64());
                    break;
                }
            }
        }
    }

    if let Some(wid) = window_id {
        let req2 = serde_json::json!({
            "id": 2,
            "method": "Browser.setWindowBounds",
            "params": {
                "windowId": wid,
                "bounds": {
                    "windowState": "normal",
                    "left": left,
                    "top": top,
                    "width": 1280,
                    "height": 800
                }
            }
        });
        ws_stream
            .send(Message::Text(req2.to_string().into()))
            .await?;
    }

    Ok(())
}

// ─── Per-agent web-navigation allowlist ───────────────────────────────────────
//
// The allowlist is stored as a small JSON file at:
//   ~/Library/Application Support/Canopy/agent-browsers/{agent_id}/allowlist.json
//
// Shape: `{"domains": ["example.com", "*.google.com"]}`
//
// Persistence is intentionally a separate file (not in the SQLite agents table) so
// adding/removing this feature doesn't require a DB migration. The file lives next to
// the agent's Chrome profile so deleting the agent's browser dir wipes the allowlist
// alongside cookies/history — single point of truth.

fn allowlist_path_for(agent_id: &str) -> Option<std::path::PathBuf> {
    crate::flavor::canopy_data_dir().map(|d| {
        d.join("agent-browsers")
            .join(agent_id)
            .join("allowlist.json")
    })
}

fn read_agent_allowlist(agent_id: &str) -> Option<Vec<String>> {
    let path = allowlist_path_for(agent_id)?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let arr = v.get("domains")?.as_array()?;
    let domains: Vec<String> = arr
        .iter()
        .filter_map(|d| d.as_str().map(|s| s.trim().to_lowercase()))
        .filter(|s| !s.is_empty())
        .collect();
    if domains.is_empty() {
        None
    } else {
        Some(domains)
    }
}

/// Build the PAC (Proxy Auto-Config) script for an agent.
///
/// Always blocks SSRF (localhost, RFC1918, file://). If `allowlist` is `Some(non-empty)`,
/// the script additionally denies any host that doesn't match a listed domain.
/// Wildcard `*.example.com` matches any subdomain of example.com AND example.com itself.
fn build_pac_script(allowlist: Option<&[String]>) -> String {
    let allowlist_clause = match allowlist {
        Some(domains) if !domains.is_empty() => {
            // Build a JS array literal of (host pattern, allow_subdomains) pairs.
            // We split into two checks so `*.foo.com` matches `foo.com` AND `*.foo.com`,
            // while `foo.com` (no wildcard) matches ONLY `foo.com`.
            let entries: Vec<String> = domains
                .iter()
                .map(|d| {
                    let d_clean = d.trim().to_lowercase();
                    if let Some(stripped) = d_clean.strip_prefix("*.") {
                        // Wildcard: match `stripped` exactly OR any subdomain of `stripped`.
                        format!(r#"["{}",true]"#, stripped.replace('"', ""))
                    } else {
                        format!(r#"["{}",false]"#, d_clean.replace('"', ""))
                    }
                })
                .collect();
            format!(
                r#"
                var allowed = [{}];
                var allowed_match = false;
                for (var i = 0; i < allowed.length; i++) {{
                    var pattern = allowed[i][0];
                    var includeSub = allowed[i][1];
                    if (host === pattern) {{ allowed_match = true; break; }}
                    if (includeSub && host.length > pattern.length &&
                        host.substring(host.length - pattern.length - 1) === ("." + pattern)) {{
                        allowed_match = true; break;
                    }}
                }}
                if (!allowed_match) return "PROXY 127.0.0.1:99999";
                "#,
                entries.join(",")
            )
        }
        _ => String::new(),
    };

    format!(
        r#"function FindProxyForURL(url, host) {{
    // SSRF block — always on, regardless of allowlist setting.
    if (shExpMatch(host, "127.0.0.1") ||
        shExpMatch(host, "localhost") ||
        shExpMatch(host, "192.168.*") ||
        shExpMatch(host, "10.*") ||
        shExpMatch(host, "172.16.*") ||
        url.startsWith("file://")) {{
        return "PROXY 127.0.0.1:99999";
    }}
    {}
    return "DIRECT";
}}"#,
        allowlist_clause
    )
}

/// Returns the current allowlist for an agent (empty array → open web access).
#[tauri::command]
pub async fn get_agent_allowed_domains(agent_id: String) -> Result<Vec<String>, String> {
    Ok(read_agent_allowlist(&agent_id).unwrap_or_default())
}

/// Replace the agent's allowlist with `domains`. An empty list disables the allowlist
/// (open web access, still subject to SSRF block). Restarts the agent's browser if it's
/// currently running so the new PAC takes effect.
#[tauri::command]
pub async fn update_agent_allowed_domains(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
    domains: Vec<String>,
) -> Result<(), String> {
    if !agent_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid agent id {:?}", agent_id));
    }

    // Normalize: trim, lowercase, drop blanks, dedupe.
    let mut normalized: Vec<String> = domains
        .into_iter()
        .map(|d| d.trim().to_lowercase())
        .filter(|d| !d.is_empty())
        .collect();
    normalized.sort();
    normalized.dedup();

    let path = allowlist_path_for(&agent_id)
        .ok_or_else(|| "could not resolve allowlist path".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
    }

    let body = serde_json::json!({ "domains": normalized });
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&body).unwrap_or_default(),
    )
    .map_err(|e| format!("write failed: {}", e))?;

    // If the browser is currently alive, kill it so the next JIT spawn picks up the
    // new PAC. We can't change PAC on a running Chrome instance.
    let needs_restart = state
        .get_status(&agent_id)
        .await
        .map_err(|e| e.to_string())?
        .is_some();
    if needs_restart {
        state
            .stop_browser(&agent_id)
            .await
            .map_err(|e| e.to_string())?;
        // Don't auto-respawn — the next agent action that needs the browser will trigger
        // the JIT proxy to start a fresh Chrome with the updated PAC.
        let _ = app_handle; // reserved for future events
    }
    Ok(())
}

/// Compute a safe off-screen coordinate that avoids ALL connected monitors.
///
/// Why this isn't trivially `(-3000, 0)`:
///   • Multi-monitor desktops commonly extend horizontally either left OR right of the
///     primary display, so `-3000` lands inside a left-side monitor on dual-screen Macs.
///   • Some setups also stack monitors vertically, so a small y-offset above the primary
///     can also land inside a screen.
///
/// Strategy: query macOS for the bounding rectangle of every active display and place the
/// hidden window 3000 px LEFT and 1500 px ABOVE that rectangle. Both "off the left edge"
/// and "off the top edge" are uncommon directions for monitor extension, so combining
/// them is robust against typical dual-/triple-monitor layouts.
///
/// Falls back to (-3000, -1500) if the AppleScript probe fails (e.g. permission denied,
/// non-mac dev environment).
fn compute_offscreen_position() -> (i32, i32) {
    // Cache the result for the lifetime of the process — monitor topology rarely changes
    // mid-session and the AppleScript probe is ~50 ms.
    use std::sync::OnceLock;
    static CACHED: OnceLock<(i32, i32)> = OnceLock::new();
    if let Some(p) = CACHED.get() {
        return *p;
    }

    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let probe = std::process::Command::new("osascript")
        .args([
            "-e",
            // Returns "minX,minY,maxX,maxY" across all displays.
            // `bounds of every desktop` returns each display's {x,y,w,h} rect; we fold
            // them into a single bounding rectangle.
            r#"tell application "Finder"
                set b to bounds of window of desktop
                return (item 1 of b as string) & "," & (item 2 of b as string) & "," & (item 3 of b as string) & "," & (item 4 of b as string)
            end tell"#,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();

    // Finder can be unresponsive while macOS is restoring a session or when a
    // headless test process has no GUI session. Never let browser startup (or
    // the test suite) wait indefinitely for this cosmetic placement probe.
    let probe = probe.ok().and_then(|mut child| {
        let deadline = Instant::now() + Duration::from_millis(750);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut stdout = Vec::new();
                    let read_ok = child
                        .stdout
                        .take()
                        .is_some_and(|mut pipe| pipe.read_to_end(&mut stdout).is_ok());
                    return (status.success() && read_ok).then_some(stdout);
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(None) | Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
    });

    let (left, top) = match probe {
        Some(stdout) => {
            let raw = String::from_utf8_lossy(&stdout).trim().to_string();
            let parts: Vec<i32> = raw
                .split(',')
                .filter_map(|s| s.trim().parse().ok())
                .collect();
            if parts.len() == 4 {
                let (min_x, min_y) = (parts[0], parts[1]);
                // 3000 px LEFT of the leftmost monitor edge, 1500 px ABOVE the topmost edge.
                (min_x.saturating_sub(3000), min_y.saturating_sub(1500))
            } else {
                tracing::warn!(
                    "compute_offscreen_position: unparseable Finder bounds {:?}",
                    raw
                );
                (-3000, -1500)
            }
        }
        _ => {
            // AppleScript unavailable or failed (e.g. dev container, permission denied).
            // Fall back to the previous fixed coordinate, just go up too.
            (-3000, -1500)
        }
    };

    let result = (left, top);
    let _ = CACHED.set(result);
    tracing::info!(
        "compute_offscreen_position: hidden browser parked at ({}, {})",
        left,
        top
    );
    result
}

async fn stream_browser_visuals(app_handle: tauri::AppHandle, agent_id: String, cdp_url: String) {
    let mut retries = 0;
    loop {
        match try_stream_browser_visuals(&app_handle, &agent_id, &cdp_url).await {
            Ok(_) => break,
            Err(e) if retries < 5 => {
                retries += 1;
                eprintln!(
                    "Browser stream disconnected, reconnecting in 3s (attempt {}/5): {}",
                    retries, e
                );
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
            }
            Err(e) => {
                eprintln!("Browser stream failed after 5 retries: {}", e);
                break;
            }
        }
    }
}

async fn try_stream_browser_visuals(
    app_handle: &tauri::AppHandle,
    agent_id: &str,
    cdp_url: &str,
) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    use tauri::Emitter;
    use tokio::time::{sleep, timeout, Duration};
    use tokio_tungstenite::connect_async;

    // Outer reconnect loop. Each iteration attempts one full connect-and-stream cycle.
    // On mid-stream disconnect we fall through to the top and reconnect; on persistent
    // connect failures we back off and eventually give up (Chrome was intentionally stopped).
    let mut connect_failures = 0u32;

    'reconnect: loop {
        let ws = timeout(Duration::from_secs(5), connect_async(cdp_url)).await;
        let mut ws_stream = match ws {
            Ok(Ok((stream, _))) => {
                connect_failures = 0;
                stream
            }
            Ok(Err(e)) => {
                connect_failures += 1;
                tracing::debug!(
                    "stream_browser_visuals: CDP connect failed for {} (attempt {}): {}",
                    agent_id,
                    connect_failures,
                    e
                );
                if connect_failures >= 20 {
                    tracing::warn!(
                        "stream_browser_visuals: giving up for {} after {} failures",
                        agent_id,
                        connect_failures
                    );
                    return Ok(());
                }
                // Fast retries first, then slow — avoids hammering a starting Chrome.
                sleep(Duration::from_millis(if connect_failures <= 5 {
                    500
                } else {
                    3_000
                }))
                .await;
                continue 'reconnect;
            }
            Err(_) => {
                // connect_async itself timed out
                connect_failures += 1;
                if connect_failures >= 10 {
                    tracing::warn!(
                        "stream_browser_visuals: connect timed out too many times for {}",
                        agent_id
                    );
                    return Ok(());
                }
                sleep(Duration::from_millis(500)).await;
                continue 'reconnect;
            }
        };

        let mut msg_id = 1i64;
        let mut interval = tokio::time::interval(Duration::from_millis(500)); // 2 FPS

        'stream: loop {
            interval.tick().await;

            let req = serde_json::json!({
                "id": msg_id,
                "method": "Page.captureScreenshot",
                "params": { "format": "jpeg", "quality": 50 }
            });

            if ws_stream
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    req.to_string().into(),
                ))
                .await
                .is_err()
            {
                // Send failed — WebSocket dropped. Sleep briefly then let 'reconnect
                // try a fresh connection.
                sleep(Duration::from_millis(500)).await;
                break 'stream;
            }

            // Wait for the screenshot response. Bound by a timeout so a frozen Chrome
            // (page hang, renderer crash) doesn't block this task forever.
            'response: loop {
                match timeout(Duration::from_secs(10), ws_stream.next()).await {
                    Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
                        if let Ok(resp) = serde_json::from_str::<serde_json::Value>(&text) {
                            if resp.get("id").and_then(|id| id.as_i64()) == Some(msg_id) {
                                if let Some(data) =
                                    resp.pointer("/result/data").and_then(|d| d.as_str())
                                {
                                    let _ = app_handle.emit(
                                        "browser_stream_frame",
                                        serde_json::json!({
                                            "agent_id": agent_id,
                                            "frame": data
                                        }),
                                    );
                                }
                                break 'response;
                            }
                            // Non-matching id (CDP event) — keep waiting for our response.
                        }
                    }
                    Ok(Some(Ok(_))) => {
                        // Non-text frame (ping/pong/binary) — keep waiting.
                    }
                    Ok(Some(Err(_))) | Ok(None) => {
                        // WebSocket error or clean close — reconnect.
                        sleep(Duration::from_millis(500)).await;
                        break 'stream;
                    }
                    Err(_) => {
                        // 10s timeout: Chrome is unresponsive (hung page or renderer crash).
                        tracing::warn!(
                            "stream_browser_visuals: screenshot response timed out for {}",
                            agent_id
                        );
                        sleep(Duration::from_millis(500)).await;
                        break 'stream;
                    }
                }
            }

            msg_id += 1;
        }
        // 'stream ended — 'reconnect loops back to try a fresh connection.
    }
}

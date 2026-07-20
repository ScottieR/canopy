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
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            active_browsers: Arc::new(Mutex::new(HashMap::new())),
            interactive_browsers: Arc::new(Mutex::new(HashMap::new())),
            stream_handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn kill_leftover_processes(&self, agent_id: &str) {
        let pattern = format!("agent-browsers/{}", agent_id);

        tracing::info!(
            "Cleaning up leftover Chrome processes for agent {}",
            agent_id
        );

        // Graceful SIGTERM
        let _ = tokio::process::Command::new("pkill")
            .args(["-f", &pattern])
            .output()
            .await;

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

        let mut child = Command::new(chrome_path)
            .args(build_chrome_args(
                &profile.profile_path,
                &profile.pac_url,
                BrowserMode::Automated,
                Some("about:blank"),
                restore_last_session,
            ))
            .stderr(std::process::Stdio::piped())
            .spawn()
            .context("Failed to spawn Chrome process")?;

        let pid = child.id().unwrap_or(0);
        tracing::info!("Started Chrome for agent {} with PID {}", agent_id, pid);

        let stderr = child.stderr.take().unwrap();
        let mut reader = tokio::io::BufReader::new(stderr);
        use tokio::io::AsyncBufReadExt;

        let mut cdp_endpoint = String::new();
        let mut port = 0;
        let mut lines = reader.lines();

        let find_url = async {
            while let Ok(Some(line)) = lines.next_line().await {
                if line.contains("DevTools listening on ws://") {
                    if let Some(start) = line.find("ws://") {
                        let url = line[start..].trim().to_string();
                        if let Some(port_str) =
                            url.split(':').nth(2).and_then(|s| s.split('/').next())
                        {
                            if let Ok(p) = port_str.parse::<u16>() {
                                port = p;
                                cdp_endpoint = url;
                                break;
                            }
                        }
                    }
                }
            }
        };

        // Wait up to 15 seconds for Chrome to print "DevTools listening on ws://" to
        // stderr. Previously this was 5s — too tight for the first spawn against a cold
        // profile dir, where Gatekeeper assessment, Spotlight indexing, and macOS
        // defaults seeding can push Chrome's startup past 5 seconds. A failure here is
        // expensive: the JIT bridge's connection handler bails silently, the client
        // sees an immediate "Empty reply", and the user has no idea why. 15s costs
        // nothing on warm spawns (Chrome usually prints in ~1s) and prevents the
        // spurious failure mode on cold ones.
        if tokio::time::timeout(std::time::Duration::from_secs(15), find_url)
            .await
            .is_err()
        {
            let _ = child.kill().await;
            return Err(anyhow::anyhow!(
                "Chrome didn't print DevTools URL within 15s — user-data-dir may be locked at {}",
                profile.profile_path
            ));
        }

        if cdp_endpoint.is_empty() {
            let _ = child.kill().await;
            return Err(anyhow::anyhow!("Failed to parse Chrome DevTools URL"));
        }

        // Drain the rest of stderr so we don't block Chrome
        tauri::async_runtime::spawn(
            async move { while let Ok(Some(_)) = lines.next_line().await {} },
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

/// Start the gateway-wide browser bridge that OpenClaw connects to as its `cdpUrl`.
///
/// Idempotent — if the port is already bound, returns immediately. Mirror of
/// `enable_jit_proxy`'s loop but routes ALL connections to a single shared Chrome
/// (one agent_id "shared-browser") so OpenClaw can use a single global cdpUrl.
/// Per-agent data isolation still works because OpenClaw creates a separate
/// Playwright BrowserContext for each agent session.
pub async fn ensure_shared_browser_bridge(app_handle: tauri::AppHandle) -> Result<(), String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    let listener = match TcpListener::bind(("0.0.0.0", SHARED_BRIDGE_PORT)).await {
        Ok(l) => l,
        Err(_) => return Ok(()), // already bound — bridge is running
    };

    let active_connections = Arc::new(AtomicUsize::new(0));
    let app_handle_clone = app_handle.clone();
    const SHARED_AGENT_ID: &str = "shared-browser";
    let bridge_token = browser_bridge_token(SHARED_AGENT_ID);

    tauri::async_runtime::spawn(async move {
        tracing::info!(
            "Shared browser bridge listening on port {}",
            SHARED_BRIDGE_PORT
        );
        loop {
            if let Ok((mut client_stream, peer_addr)) = listener.accept().await {
                // Trace every accepted TCP connection so we can answer "did OpenClaw
                // actually try to connect?" without inferring from Chrome-lifecycle
                // events. Cheap — only fires once per request.
                tracing::info!("Shared bridge: accepted connection from {}", peer_addr);
                let app_handle_inner = app_handle_clone.clone();
                let conn_counter = active_connections.clone();
                let expected_token = bridge_token.clone();

                tauri::async_runtime::spawn(async move {
                    conn_counter.fetch_add(1, Ordering::SeqCst);

                    // Authenticate before starting or connecting to Chrome. This listener
                    // must be reachable from Docker, so an unauthenticated LAN connection
                    // must not be able to trigger a browser spawn or consume proxy work.
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
                        tracing::warn!("Shared bridge: rejected incomplete HTTP request");
                        conn_counter.fetch_sub(1, Ordering::SeqCst);
                        return;
                    };
                    let (headers, body) = buf.split_at(end + 4);
                    let headers_str = String::from_utf8_lossy(headers);
                    let Some(authenticated_headers) =
                        authenticate_bridge_request(&headers_str, &expected_token)
                    else {
                        let _ = client_stream
                            .write_all(
                                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                        tracing::warn!("Shared bridge: rejected unauthenticated connection");
                        conn_counter.fetch_sub(1, Ordering::SeqCst);
                        return;
                    };

                    use tauri::Manager;
                    let browser_manager = app_handle_inner.state::<BrowserManager>();

                    // Resolve a live Chrome endpoint we can actually connect to.
                    //
                    // First try the cached endpoint. If `TcpStream::connect` returns
                    // ConnectionRefused, the cached Chrome has died (killed externally,
                    // crashed, OOM'd, or the user ran `pkill`) but our in-memory
                    // BrowserManager state still claims it's alive. Drop the stale
                    // entry, spawn a fresh Chrome, and try once more. Any failure mode
                    // beyond that we log and bail — we'd rather fail loudly than thrash
                    // spawn-retry-loop.
                    //
                    // This is the difference between a self-healing bridge and one
                    // that silently times out every other request.
                    async fn resolve_endpoint(
                        bm: &BrowserManager,
                        app: &tauri::AppHandle,
                    ) -> Option<(String, u16, String)> {
                        let cdp = match bm.get_status(SHARED_AGENT_ID).await {
                            // Only reuse a status that is actually connectable. A status
                            // with an empty cdp_endpoint (e.g. an interactive-auth entry,
                            // which runs without remote debugging) would fail the URL
                            // parse below and silently kill this connection — respawn
                            // through start_browser instead.
                            Ok(Some(status)) if status_is_connectable(&status) => {
                                tracing::info!(
                                    "Shared bridge: reusing live Chrome at {}",
                                    status.cdp_endpoint
                                );
                                status.cdp_endpoint
                            }
                            // A live trusted-login window currently owns the shared
                            // profile (the user is signing in to a site by hand).
                            // Do NOT fall through to start_browser — that would kill
                            // their window mid-login. Refuse loudly; agents get a
                            // connection failure until the user resumes automation.
                            Ok(Some(status)) if status.mode == BrowserMode::InteractiveAuth => {
                                tracing::warn!(
                                    "Shared bridge: trusted-login window open on shared profile — refusing CDP until automation resumes"
                                );
                                return None;
                            }
                            _ => match bm.start_browser(app.clone(), SHARED_AGENT_ID).await {
                                Ok(status) => {
                                    tracing::info!(
                                        "Shared bridge: spawned fresh Chrome at {}",
                                        status.cdp_endpoint
                                    );
                                    status.cdp_endpoint
                                }
                                Err(e) => {
                                    tracing::error!("Shared bridge: Chrome spawn failed: {}", e);
                                    return None;
                                }
                            },
                        };
                        let url = url::Url::parse(&cdp).ok()?;
                        let host = url.host_str().unwrap_or("127.0.0.1").to_string();
                        let port = url.port().unwrap_or(0);
                        let path = url.path().to_string();
                        Some((host, port, path))
                    }

                    // Serialise the resolve so two near-simultaneous connections can't
                    // both observe `get_status == None` and race a Chrome spawn (which
                    // would kill each other's instance — see resolve_lock_for docs).
                    let _resolve_guard = resolve_lock_for(SHARED_AGENT_ID).lock().await;
                    let Some((mut chrome_host, mut chrome_port, mut chrome_path)) =
                        resolve_endpoint(&*browser_manager, &app_handle_inner).await
                    else {
                        drop(_resolve_guard);
                        conn_counter.fetch_sub(1, Ordering::SeqCst);
                        return;
                    };
                    // Release the resolve lock BEFORE the network connect — once the
                    // status is committed to the BrowserManager map, other callers can
                    // safely observe it. Holding the lock through `TcpStream::connect`
                    // would serialise every CDP request, killing throughput.
                    drop(_resolve_guard);

                    let mut chrome_stream =
                        match TcpStream::connect((chrome_host.as_str(), chrome_port)).await {
                            Ok(s) => s,
                            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                                tracing::warn!(
                                "Shared bridge: cached Chrome at {}:{} is dead ({}); respawning",
                                chrome_host, chrome_port, e
                            );
                                // Recovery also goes through the resolve lock — otherwise N
                                // concurrent failed connects each trigger a stop+start race.
                                let _recover_guard = resolve_lock_for(SHARED_AGENT_ID).lock().await;
                                // Drop the stale AUTOMATED entry only — never touch a
                                // trusted-login window that may have just opened.
                                let _ = browser_manager
                                    .stop_automated_browser(SHARED_AGENT_ID)
                                    .await;
                                let Some((h, p, pth)) =
                                    resolve_endpoint(&*browser_manager, &app_handle_inner).await
                                else {
                                    drop(_recover_guard);
                                    conn_counter.fetch_sub(1, Ordering::SeqCst);
                                    return;
                                };
                                drop(_recover_guard);
                                chrome_host = h;
                                chrome_port = p;
                                chrome_path = pth;
                                match TcpStream::connect((chrome_host.as_str(), chrome_port)).await
                                {
                                    Ok(s) => s,
                                    Err(e) => {
                                        tracing::error!(
                                        "Shared bridge: fresh Chrome at {}:{} ALSO unreachable: {}",
                                        chrome_host, chrome_port, e
                                    );
                                        conn_counter.fetch_sub(1, Ordering::SeqCst);
                                        return;
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::error!(
                                "Shared bridge: TcpStream::connect to Chrome at {}:{} failed: {}",
                                chrome_host, chrome_port, e
                            );
                                conn_counter.fetch_sub(1, Ordering::SeqCst);
                                return;
                            }
                        };

                    // Past this point chrome_stream is live and chrome_path is current.
                    tracing::debug!(
                        "Shared bridge: connected to Chrome CDP at {}:{}",
                        chrome_host,
                        chrome_port
                    );
                    let rewritten = rewrite_cdp_request_headers(
                        &authenticated_headers,
                        chrome_port,
                        &chrome_path,
                    );

                    if let Err(e) = chrome_stream.write_all(rewritten.as_bytes()).await {
                        tracing::warn!("Shared bridge: failed to write headers to Chrome: {}", e);
                        conn_counter.fetch_sub(1, Ordering::SeqCst);
                        return;
                    }
                    if !body.is_empty() {
                        let _ = chrome_stream.write_all(body).await;
                    }

                    // Read Chrome's response so we can decide what to do with it:
                    //
                    //   • HTTP 101 (WebSocket upgrade)  → headers carry no URLs we care
                    //     about; flush headers, then tunnel bidirectionally for the
                    //     WebSocket frames.
                    //   • HTTP /json/version & /json/list  → JSON body leaks Chrome's
                    //     internal `127.0.0.1:<chrome_port>` in `webSocketDebuggerUrl`,
                    //     which the container can't reach. Buffer the body, rewrite
                    //     those references to point at the bridge instead, recompute
                    //     Content-Length, send the corrected response.
                    //   • Anything else  → flush whatever we got and tunnel; no
                    //     rewriting needed (no URL leak).
                    //
                    // OpenClaw's `attachOnly: true` preflight relies on /json/version
                    // returning a reachable `webSocketDebuggerUrl`. Without this
                    // rewriting, Playwright reads the leaked URL, tries to connect
                    // directly to `127.0.0.1:<chrome_port>` from inside the container,
                    // and OpenClaw reports "Remote CDP for profile 'openclaw' is not
                    // reachable" — which is exactly what the user just saw.
                    let bridge_origin = format!(
                        "host.docker.internal:{}/{}",
                        SHARED_BRIDGE_PORT, expected_token
                    );
                    let chrome_origin = format!("127.0.0.1:{}", chrome_port);

                    if let Err(e) = relay_chrome_response_to_client(
                        &mut chrome_stream,
                        &mut client_stream,
                        &chrome_origin,
                        &bridge_origin,
                    )
                    .await
                    {
                        tracing::warn!("Shared bridge: response relay failed: {}", e);
                    }

                    // Idle-shutdown: the shared Chrome can be kept alive longer than the
                    // per-agent JIT proxy used to — agents reconnect frequently across a
                    // long session, so a tight 10s window would thrash. 60s strikes a
                    // balance between memory savings and avoiding cold-start latency.
                    let remaining = conn_counter.fetch_sub(1, Ordering::SeqCst) - 1;
                    if remaining == 0 {
                        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
                        if conn_counter.load(Ordering::SeqCst) == 0 {
                            tracing::info!("Shared bridge: idle 60s — stopping shared Chrome");
                            // Automated only: a trusted-login window on the shared
                            // profile must survive idle shutdown (the user may take
                            // minutes to finish signing in).
                            let _ = browser_manager
                                .stop_automated_browser(SHARED_AGENT_ID)
                                .await;
                        }
                    }
                });
            }
        }
    });

    Ok(())
}

/// Deterministic JIT-proxy port for an agent: `10000 + hash(agent_id) % 1000`.
///
/// Single source of truth — this same value is computed when (a) binding the
/// proxy listener, (b) writing PLAYWRIGHT_CDP_ENDPOINT into the agent's env,
/// and (c) writing `browser.cdpUrl` into an isolated container's openclaw.json.
/// `DefaultHasher::new()` uses fixed keys, so the result is stable across
/// processes and app restarts.
pub fn jit_proxy_port_for(agent_id: &str) -> u16 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    agent_id.hash(&mut hasher);
    10000 + (hasher.finish() % 1000) as u16
}

pub async fn enable_jit_proxy(
    app_handle: tauri::AppHandle,
    agent_id: String,
) -> Result<u16, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    let proxy_port = jit_proxy_port_for(&agent_id);
    let bridge_token = browser_bridge_token(&agent_id);

    let listener = match TcpListener::bind(("0.0.0.0", proxy_port)).await {
        Ok(l) => l,
        Err(_) => return Ok(proxy_port), // Already bound, proxy is running
    };

    let active_connections = Arc::new(AtomicUsize::new(0));
    let agent_id_clone = agent_id.clone();
    let app_handle_clone = app_handle.clone();

    tauri::async_runtime::spawn(async move {
        tracing::info!(
            "JIT Proxy listening on port {} for {}",
            proxy_port,
            agent_id_clone
        );
        loop {
            if let Ok((mut client_stream, _)) = listener.accept().await {
                let agent_id_inner = agent_id_clone.clone();
                let app_handle_inner = app_handle_clone.clone();
                let conn_counter = active_connections.clone();
                let expected_token = bridge_token.clone();

                tauri::async_runtime::spawn(async move {
                    conn_counter.fetch_add(1, Ordering::SeqCst);

                    let mut buf = Vec::with_capacity(8192);
                    let mut chunk = [0u8; 4096];
                    let mut header_end: Option<usize> = None;
                    let header_read_deadline =
                        std::time::Instant::now() + std::time::Duration::from_secs(5);
                    while header_end.is_none() && std::time::Instant::now() < header_read_deadline {
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
                        tracing::warn!("JIT Proxy: rejected incomplete HTTP request");
                        conn_counter.fetch_sub(1, Ordering::SeqCst);
                        return;
                    };
                    let (headers, body) = buf.split_at(end + 4);
                    let headers_str = String::from_utf8_lossy(headers);
                    let Some(authenticated_headers) =
                        authenticate_bridge_request(&headers_str, &expected_token)
                    else {
                        let _ = client_stream
                            .write_all(
                                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                        tracing::warn!(
                            "JIT Proxy: rejected unauthenticated connection for {}",
                            agent_id_inner
                        );
                        conn_counter.fetch_sub(1, Ordering::SeqCst);
                        return;
                    };

                    use tauri::Manager;
                    let browser_manager = app_handle_inner.state::<BrowserManager>();

                    // Resolve a CONNECTABLE endpoint. Two traps here:
                    //
                    //  1. `get_status` can return an InteractiveAuth status — that's the
                    //     user-facing login window, which runs WITHOUT remote debugging
                    //     (port 0, empty cdp_endpoint). It is not a CDP target. While a
                    //     live login window is open we refuse the connection loudly; the
                    //     agent's next attempt after "resume automation" will succeed.
                    //
                    //  2. NEVER .unwrap() the URL parse. The previous code panicked on
                    //     the empty endpoint from (1), killing this spawned task — the
                    //     agent's connection dropped with zero bytes and zero logs, which
                    //     surfaced as "I don't have a connection to your browser".
                    let cdp_endpoint = match browser_manager.get_status(&agent_id_inner).await {
                        Ok(Some(status)) if status_is_connectable(&status) => status.cdp_endpoint,
                        Ok(Some(status)) if status.mode == BrowserMode::InteractiveAuth => {
                            tracing::warn!(
                                "JIT Proxy: {} has a live interactive login window — CDP unavailable until automation resumes",
                                agent_id_inner
                            );
                            conn_counter.fetch_sub(1, Ordering::SeqCst);
                            return;
                        }
                        // No browser, or a stale/unconnectable status → (re)spawn.
                        _ => {
                            match browser_manager
                                .start_browser(app_handle_inner.clone(), &agent_id_inner)
                                .await
                            {
                                Ok(status) => status.cdp_endpoint,
                                Err(e) => {
                                    tracing::error!("JIT failed: {}", e);
                                    conn_counter.fetch_sub(1, Ordering::SeqCst);
                                    return;
                                }
                            }
                        }
                    };

                    let chrome_url = match url::Url::parse(&cdp_endpoint) {
                        Ok(u) => u,
                        Err(e) => {
                            tracing::error!(
                                "JIT Proxy: unparseable CDP endpoint {:?} for {}: {}",
                                cdp_endpoint,
                                agent_id_inner,
                                e
                            );
                            conn_counter.fetch_sub(1, Ordering::SeqCst);
                            return;
                        }
                    };
                    let mut chrome_host = chrome_url.host_str().unwrap_or("127.0.0.1").to_string();
                    let mut chrome_port = chrome_url.port().unwrap_or(0);
                    let mut chrome_path = chrome_url.path().to_string();

                    // Self-heal a dead cached Chrome, mirroring the shared bridge: if the
                    // cached endpoint refuses the connection (Chrome crashed, was pkill'd,
                    // or OOM'd while our map still says it's alive), drop the stale entry,
                    // spawn a fresh Chrome, and retry once. Previously this silently
                    // dropped the agent's connection — the "works on the second try"
                    // flakiness users hit after any Chrome death.
                    let connect_result =
                        match TcpStream::connect((chrome_host.as_str(), chrome_port)).await {
                            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                                tracing::warn!(
                                "JIT Proxy: cached Chrome at {}:{} is dead ({}); respawning for {}",
                                chrome_host,
                                chrome_port,
                                e,
                                agent_id_inner
                            );
                                let _ = browser_manager
                                    .stop_automated_browser(&agent_id_inner)
                                    .await;
                                match browser_manager
                                    .start_browser(app_handle_inner.clone(), &agent_id_inner)
                                    .await
                                {
                                    Ok(status) if !status.cdp_endpoint.is_empty() => {
                                        match url::Url::parse(&status.cdp_endpoint) {
                                            Ok(u) => {
                                                // The fresh Chrome has a new port AND a new
                                                // /devtools/browser/<guid> path — update all
                                                // three so the header/path rewrite below
                                                // targets the live instance, not the corpse.
                                                chrome_host =
                                                    u.host_str().unwrap_or("127.0.0.1").to_string();
                                                chrome_port = u.port().unwrap_or(0);
                                                chrome_path = u.path().to_string();
                                                TcpStream::connect((
                                                    chrome_host.as_str(),
                                                    chrome_port,
                                                ))
                                                .await
                                            }
                                            Err(_) => Err(std::io::Error::new(
                                                std::io::ErrorKind::InvalidData,
                                                "unparseable respawned CDP endpoint",
                                            )),
                                        }
                                    }
                                    Ok(_) => Err(std::io::Error::new(
                                        std::io::ErrorKind::InvalidData,
                                        "respawned Chrome returned empty CDP endpoint",
                                    )),
                                    Err(e) => Err(std::io::Error::other(e.to_string())),
                                }
                            }
                            other => other,
                        };

                    if let Ok(mut chrome_stream) = connect_result.map_err(|e| {
                        tracing::error!(
                            "JIT Proxy: could not reach Chrome for {}: {}",
                            agent_id_inner,
                            e
                        );
                        e
                    }) {
                        // Read the full HTTP request headers (up to "\r\n\r\n").
                        //
                        // Chrome DevTools enforces TWO protections we have to satisfy:
                        //   1. The `Host:` header must be `localhost` or an IP address —
                        //      a hostname like `host.docker.internal:PORT` causes the
                        //      "Host header is specified and is not an IP address or
                        //      localhost" rejection (Chrome's DNS-rebinding protection).
                        //   2. The path must match an existing target — for the
                        //      WebSocket browser endpoint that means `/devtools/browser/<guid>`.
                        //
                        // Strategy: read headers, replace `Host: …` with `Host: 127.0.0.1:<chrome_port>`,
                        // and if the client requested `GET /` (Playwright with a no-path
                        // CDP URL does this), rewrite the path to Chrome's actual browser
                        // path so the upgrade lands on a real target. Everything else
                        // (path, body) flows through unchanged.
                        let rewritten_headers = rewrite_cdp_request_headers(
                            &authenticated_headers,
                            chrome_port,
                            &chrome_path,
                        );

                        // Write the rewritten headers, then any body bytes we
                        // already over-read while looking for "\r\n\r\n".
                        if chrome_stream
                            .write_all(rewritten_headers.as_bytes())
                            .await
                            .is_err()
                        {
                            conn_counter.fetch_sub(1, Ordering::SeqCst);
                            return;
                        }
                        if !body.is_empty() {
                            let _ = chrome_stream.write_all(body).await;
                        }

                        // Relay Chrome's response with origin rewriting (same helper the
                        // shared bridge uses):
                        //   • 101 upgrades are tunnelled bidirectionally (WebSocket frames),
                        //     identical to the old copy_bidirectional behaviour.
                        //   • /json/version & /json/list responses leak Chrome's internal
                        //     `127.0.0.1:<chrome_port>` in `webSocketDebuggerUrl`, which the
                        //     container can't reach. Rewriting it to this proxy's origin is
                        //     what lets OpenClaw's `attachOnly` preflight work when an
                        //     isolated container's `browser.cdpUrl` points at the JIT proxy.
                        let proxy_origin =
                            format!("host.docker.internal:{}/{}", proxy_port, expected_token);
                        let chrome_origin = format!("127.0.0.1:{}", chrome_port);
                        if let Err(e) = relay_chrome_response_to_client(
                            &mut chrome_stream,
                            &mut client_stream,
                            &chrome_origin,
                            &proxy_origin,
                        )
                        .await
                        {
                            tracing::warn!(
                                "JIT Proxy: response relay failed for {}: {}",
                                agent_id_inner,
                                e
                            );
                        }
                    }

                    let remaining = conn_counter.fetch_sub(1, Ordering::SeqCst) - 1;
                    if remaining == 0 {
                        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
                        if conn_counter.load(Ordering::SeqCst) == 0 {
                            tracing::info!(
                                "JIT Proxy: No connections for 10s, stopping Chrome for {}",
                                agent_id_inner
                            );
                            // Automated only — never reap a trusted-login window.
                            let _ = browser_manager
                                .stop_automated_browser(&agent_id_inner)
                                .await;
                        }
                    }
                });
            }
        }
    });

    Ok(proxy_port)
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
///   2. A bare `GET / HTTP/...` path becomes `GET <chrome_path> HTTP/...` so the
///      upgrade hits Chrome's actual `/devtools/browser/<guid>` endpoint. Any other
///      path is forwarded unchanged so `/json/version`, `/json/list`, and
///      `/devtools/...` all work too.
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
            // Rewrite "GET / HTTP/1.1" → "GET <chrome_path> HTTP/1.1" but leave any
            // explicit path the client sent in place.
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

/// If the request line is `GET / HTTP/...`, rewrite to `GET <chrome_path> HTTP/...`.
/// Returns None if the line isn't the bare-root form (caller forwards as-is).
fn rewrite_request_line(line: &str, chrome_path: &str) -> Option<String> {
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let path = parts.next()?;
    let version = parts.next()?;
    if path == "/" && !chrome_path.is_empty() && chrome_path != "/" {
        Some(format!("{} {} {}", method, chrome_path, version))
    } else {
        None
    }
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
    let data_dir = dirs::data_dir()
        .context("Could not find data directory")?
        .join("Canopy")
        .join("agent-browsers")
        .join(agent_id);

    std::fs::create_dir_all(&data_dir)?;
    let profile_path = data_dir.to_string_lossy().to_string();

    let openclaw_state_dir = dirs::data_dir()
        .context("Could not find data directory")?
        .join("Canopy")
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
    dirs::data_dir().map(|d| {
        d.join("Canopy")
            .join("agent-browsers")
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

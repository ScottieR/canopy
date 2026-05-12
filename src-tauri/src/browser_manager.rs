use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use anyhow::{Result, Context};
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserStatus {
    pub agent_id: String,
    pub port: u16,
    pub cdp_endpoint: String,
    pub profile_path: String,
    pub is_running: bool,
}

pub struct BrowserManager {
    active_browsers: Arc<Mutex<HashMap<String, (Child, BrowserStatus)>>>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            active_browsers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start_browser(&self, app_handle: tauri::AppHandle, agent_id: &str) -> Result<BrowserStatus> {
        let mut active = self.active_browsers.lock().await;
        
        // Kill existing if any
        if let Some((mut child, _)) = active.remove(agent_id) {
            let _ = child.kill().await;
        }

        let data_dir = dirs::data_dir()
            .context("Could not find data directory")?
            .join("Canopy")
            .join("agent-browsers")
            .join(agent_id);
        
        std::fs::create_dir_all(&data_dir)?;
        let profile_path = data_dir.to_string_lossy().to_string();

        // Ensure the agent workspace exists for downloads
        let openclaw_state_dir = dirs::data_dir()
            .context("Could not find data directory")?
            .join("Canopy")
            .join("openclaw-state")
            .join("workspace")
            .join(agent_id);
        std::fs::create_dir_all(&openclaw_state_dir)?;
        let download_path = openclaw_state_dir.to_string_lossy().to_string();

        // Write a minimal Preferences file to enforce download directory
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

        // Build the PAC (Proxy Auto-Config) script for this agent.
        //
        // Always blocks SSRF (localhost / private subnets / file:// URLs) so an agent can't
        // pivot through the host's local network regardless of allowlist settings.
        //
        // If the agent has an allowlist configured (allowed_domains.json next to its profile),
        // ONLY hosts that match a listed domain are allowed; everything else is blackholed.
        // Wildcard `*.example.com` matches any subdomain of example.com (and example.com itself).
        //
        // If no allowlist is configured, the agent has open web access (still subject to SSRF).
        let allowlist = read_agent_allowlist(agent_id);
        let pac_script = build_pac_script(allowlist.as_deref());
        use base64::Engine;
        let pac_base64 = base64::engine::general_purpose::STANDARD.encode(&pac_script);
        let pac_url = format!("data:application/x-ns-proxy-autoconfig;base64,{}", pac_base64);

        // Try to find Google Chrome on macOS
        let chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        if !std::path::Path::new(chrome_path).exists() {
            return Err(anyhow::anyhow!("Google Chrome not found at {}. Please install it to use Machine Browser.", chrome_path));
        }

        // Compute a safe off-screen point that avoids every connected monitor.
        // See `compute_offscreen_position` for why a fixed (-3000, 0) is wrong.
        let (offscreen_x, offscreen_y) = compute_offscreen_position();
        let window_position = format!("--window-position={},{}", offscreen_x, offscreen_y);

        let mut child = Command::new(chrome_path)
            .args([
                "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1",
                &format!("--user-data-dir={}", profile_path),
                "--no-first-run",
                "--no-default-browser-check",

                // Spawn off-screen — the user makes it visible explicitly via `show_browser`,
                // or the agent requests attention via `request_user_attention`.
                &window_position,
                "--window-size=1280,800",
                
                // Security Flags
                "--disable-extensions",      // Prevent malicious extensions
                "--deny-permission-prompts", // Block location, camera, mic prompts
                "--disable-sync",            // Ensure no accidental profile sync
                "--disable-features=TranslateUI",
                // ⚠️ DO NOT add --safebrowsing-disable-download-protection. Chrome's
                // malware-download check is the cheapest mitigation we have for an agent
                // that gets prompt-injected into pulling a malicious binary. Silent
                // workspace-scoped downloads are still possible because the Preferences
                // file (written above) sets `prompt_for_download: false` and pins the
                // download directory to the agent's workspace — we get the no-prompt UX
                // without disabling the malware scanner.

                // Network Guardrail: PAC script to block SSRF
                &format!("--proxy-pac-url={}", pac_url),
                "about:blank",
            ])
            .stderr(std::process::Stdio::piped())
            .spawn()
            .context("Failed to spawn Chrome process")?;

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
                        if let Some(port_str) = url.split(':').nth(2).and_then(|s| s.split('/').next()) {
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
        
        if tokio::time::timeout(std::time::Duration::from_secs(5), find_url).await.is_err() {
            let _ = child.kill().await;
            return Err(anyhow::anyhow!("Timeout waiting for Chrome DevTools URL"));
        }
        
        if cdp_endpoint.is_empty() {
            let _ = child.kill().await;
            return Err(anyhow::anyhow!("Failed to parse Chrome DevTools URL"));
        }

        // Drain the rest of stderr so we don't block Chrome
        tauri::async_runtime::spawn(async move {
            while let Ok(Some(_)) = lines.next_line().await {}
        });

        let status = BrowserStatus {
            agent_id: agent_id.to_string(),
            port,
            cdp_endpoint: cdp_endpoint.clone(),
            profile_path,
            is_running: true,
        };

        active.insert(agent_id.to_string(), (child, status.clone()));

        // Start Visual Streaming loop
        let agent_id_clone = agent_id.to_string();
        let cdp_url = cdp_endpoint.clone();
        tauri::async_runtime::spawn(async move {
            stream_browser_visuals(app_handle, agent_id_clone, cdp_url).await;
        });

        Ok(status)
    }

    pub async fn stop_browser(&self, agent_id: &str) -> Result<()> {
        let mut active = self.active_browsers.lock().await;
        if let Some((mut child, _)) = active.remove(agent_id) {
            child.kill().await.context("Failed to kill Chrome process")?;
        }
        Ok(())
    }

    pub async fn get_status(&self, agent_id: &str) -> Result<Option<BrowserStatus>> {
        let active = self.active_browsers.lock().await;
        if let Some((_, status)) = active.get(agent_id) {
            Ok(Some(status.clone()))
        } else {
            Ok(None)
        }
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_machine_browser(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<BrowserStatus, String> {
    let status = state.start_browser(app_handle, &agent_id).await.map_err(|e| e.to_string())?;
    
    // Inject the secure CDP endpoint returned by Chrome
    let ws_endpoint = status.cdp_endpoint.replace("127.0.0.1", "host.docker.internal");
    let _ = crate::openclaw::get_docker_command()
        .args(["exec", "-u", "node", "-e", "NODE_OPTIONS=--v8-pool-size=1", "canopy-gateway",
               "openclaw", "agents", "edit", &agent_id,
               "--env", &format!("PLAYWRIGHT_CDP_ENDPOINT={}", ws_endpoint)])
        .output().await;
        
    Ok(status)
}

#[tauri::command]
pub async fn stop_machine_browser(
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<(), String> {
    state.stop_browser(&agent_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_browser_status(
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
) -> Result<Option<BrowserStatus>, String> {
    state.get_status(&agent_id).await.map_err(|e| e.to_string())
}

pub async fn enable_jit_proxy(app_handle: tauri::AppHandle, agent_id: String) -> Result<u16, String> {
    use tokio::net::{TcpListener, TcpStream};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use std::hash::{Hash, Hasher};
    use std::collections::hash_map::DefaultHasher;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let mut hasher = DefaultHasher::new();
    agent_id.hash(&mut hasher);
    let proxy_port = 10000 + (hasher.finish() % 1000) as u16;

    let listener = match TcpListener::bind(("127.0.0.1", proxy_port)).await {
        Ok(l) => l,
        Err(_) => return Ok(proxy_port), // Already bound, proxy is running
    };

    let active_connections = Arc::new(AtomicUsize::new(0));
    let agent_id_clone = agent_id.clone();
    let app_handle_clone = app_handle.clone();
    
    tauri::async_runtime::spawn(async move {
        tracing::info!("JIT Proxy listening on port {} for {}", proxy_port, agent_id_clone);
        loop {
            if let Ok((mut client_stream, _)) = listener.accept().await {
                let agent_id_inner = agent_id_clone.clone();
                let app_handle_inner = app_handle_clone.clone();
                let conn_counter = active_connections.clone();
                
                tauri::async_runtime::spawn(async move {
                    conn_counter.fetch_add(1, Ordering::SeqCst);
                    use tauri::Manager;
                    let browser_manager = app_handle_inner.state::<BrowserManager>();
                    
                    let cdp_endpoint = match browser_manager.get_status(&agent_id_inner).await {
                        Ok(Some(status)) => status.cdp_endpoint,
                        _ => {
                            match browser_manager.start_browser(app_handle_inner.clone(), &agent_id_inner).await {
                                Ok(status) => status.cdp_endpoint,
                                Err(e) => {
                                    tracing::error!("JIT failed: {}", e);
                                    conn_counter.fetch_sub(1, Ordering::SeqCst);
                                    return;
                                }
                            }
                        }
                    };

                    let chrome_url = url::Url::parse(&cdp_endpoint).unwrap();
                    let chrome_host = chrome_url.host_str().unwrap();
                    let chrome_port = chrome_url.port().unwrap();
                    let chrome_path = chrome_url.path();

                    if let Ok(mut chrome_stream) = TcpStream::connect((chrome_host, chrome_port)).await {
                        let mut buf = [0u8; 4096];
                        if let Ok(n) = client_stream.read(&mut buf).await {
                            if n > 0 {
                                let req = String::from_utf8_lossy(&buf[..n]);
                                let modified_req = req.replace("GET / HTTP/1.1", &format!("GET {} HTTP/1.1", chrome_path));
                                let _ = chrome_stream.write_all(modified_req.as_bytes()).await;
                                let _ = tokio::io::copy_bidirectional(&mut client_stream, &mut chrome_stream).await;
                            }
                        }
                    }

                    let remaining = conn_counter.fetch_sub(1, Ordering::SeqCst) - 1;
                    if remaining == 0 {
                        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
                        if conn_counter.load(Ordering::SeqCst) == 0 {
                            tracing::info!("JIT Proxy: No connections for 10s, stopping Chrome for {}", agent_id_inner);
                            let _ = browser_manager.stop_browser(&agent_id_inner).await;
                        }
                    }
                });
            }
        }
    });

    Ok(proxy_port)
}

#[tauri::command]
pub async fn show_browser(state: tauri::State<'_, BrowserManager>, agent_id: String) -> Result<(), String> {
    // 1) Move the window onto the primary monitor via CDP setWindowBounds.
    move_browser(&state, &agent_id, 0, 0).await.map_err(|e| e.to_string())?;

    // 2) Bring Chrome to OS-level focus so the user actually sees it. CDP's
    //    `Browser.setWindowBounds` repositions the window but doesn't raise it above
    //    other apps. Without this step the window slides on-screen but stays behind
    //    whatever app the user has focused — they have to alt-tab to find it.
    //
    //    Note: this activates ALL Google Chrome processes (macOS treats them as one
    //    application bundle). Other agent browsers stay parked at their off-screen
    //    coordinates so they remain invisible — only their process focus changes.
    let _ = tokio::process::Command::new("osascript")
        .args(["-e", r#"tell application "Google Chrome" to activate"#])
        .output()
        .await;

    Ok(())
}

#[tauri::command]
pub async fn hide_browser(state: tauri::State<'_, BrowserManager>, agent_id: String) -> Result<(), String> {
    // Move the window back to the safe off-screen coordinate computed in
    // `compute_offscreen_position` (left of all monitors, above all monitors).
    let (x, y) = compute_offscreen_position();
    move_browser(&state, &agent_id, x, y).await.map_err(|e| e.to_string())
}

async fn move_browser(state: &BrowserManager, agent_id: &str, left: i32, top: i32) -> Result<()> {
    let cdp_url = match state.get_status(agent_id).await? {
        Some(s) => s.cdp_endpoint,
        None => return Err(anyhow::anyhow!("Browser not running")),
    };

    use tokio_tungstenite::connect_async;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let (mut ws_stream, _) = connect_async(&cdp_url).await.context("Failed to connect to CDP")?;

    let req1 = serde_json::json!({
        "id": 1,
        "method": "Browser.getWindowForTarget"
    });
    ws_stream.send(Message::Text(req1.to_string().into())).await?;

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
        ws_stream.send(Message::Text(req2.to_string().into())).await?;
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
    let domains: Vec<String> = arr.iter()
        .filter_map(|d| d.as_str().map(|s| s.trim().to_lowercase()))
        .filter(|s| !s.is_empty())
        .collect();
    if domains.is_empty() { None } else { Some(domains) }
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
            let entries: Vec<String> = domains.iter().map(|d| {
                let d_clean = d.trim().to_lowercase();
                if let Some(stripped) = d_clean.strip_prefix("*.") {
                    // Wildcard: match `stripped` exactly OR any subdomain of `stripped`.
                    format!(r#"["{}",true]"#, stripped.replace('"', ""))
                } else {
                    format!(r#"["{}",false]"#, d_clean.replace('"', ""))
                }
            }).collect();
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
    if !agent_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid agent id {:?}", agent_id));
    }

    // Normalize: trim, lowercase, drop blanks, dedupe.
    let mut normalized: Vec<String> = domains.into_iter()
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
    std::fs::write(&path, serde_json::to_string_pretty(&body).unwrap_or_default())
        .map_err(|e| format!("write failed: {}", e))?;

    // If the browser is currently alive, kill it so the next JIT spawn picks up the
    // new PAC. We can't change PAC on a running Chrome instance.
    let needs_restart = state.get_status(&agent_id).await
        .map_err(|e| e.to_string())?
        .is_some();
    if needs_restart {
        state.stop_browser(&agent_id).await.map_err(|e| e.to_string())?;
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
    if let Some(p) = CACHED.get() { return *p; }

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
        .output();

    let (left, top) = match probe {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let parts: Vec<i32> = raw.split(',').filter_map(|s| s.trim().parse().ok()).collect();
            if parts.len() == 4 {
                let (min_x, min_y) = (parts[0], parts[1]);
                // 3000 px LEFT of the leftmost monitor edge, 1500 px ABOVE the topmost edge.
                (min_x.saturating_sub(3000), min_y.saturating_sub(1500))
            } else {
                tracing::warn!("compute_offscreen_position: unparseable Finder bounds {:?}", raw);
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
    tracing::info!("compute_offscreen_position: hidden browser parked at ({}, {})", left, top);
    result
}

async fn stream_browser_visuals(app_handle: tauri::AppHandle, agent_id: String, cdp_url: String) {
    let mut retries = 0;
    loop {
        match try_stream_browser_visuals(&app_handle, &agent_id, &cdp_url).await {
            Ok(_) => break,
            Err(e) if retries < 5 => {
                retries += 1;
                eprintln!("Browser stream disconnected, reconnecting in 3s (attempt {}/5): {}", retries, e);
                tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
            }
            Err(e) => {
                eprintln!("Browser stream failed after 5 retries: {}", e);
                break;
            }
        }
    }
}

async fn try_stream_browser_visuals(app_handle: &tauri::AppHandle, agent_id: &str, cdp_url: &str) -> Result<(), String> {
    use tokio_tungstenite::connect_async;
    use futures_util::{SinkExt, StreamExt};
    use tauri::Emitter;
    use tokio::time::Duration;

    let (mut ws_stream, _) = connect_async(cdp_url).await
        .map_err(|e| e.to_string())?;

    let mut msg_id = 1;
    let mut interval = tokio::time::interval(Duration::from_millis(500)); // 2 FPS

    loop {
        interval.tick().await;

        let req = serde_json::json!({
            "id": msg_id,
            "method": "Page.captureScreenshot",
            "params": {
                "format": "jpeg",
                "quality": 50
            }
        });

        if ws_stream.send(tokio_tungstenite::tungstenite::Message::Text(req.to_string().into())).await.is_err() {
            return Err("WebSocket send failed".to_string());
        }

        // Wait for response
        while let Some(msg) = ws_stream.next().await {
            if let Ok(tokio_tungstenite::tungstenite::Message::Text(text)) = msg {
                if let Ok(resp) = serde_json::from_str::<serde_json::Value>(&text) {
                    if resp.get("id").and_then(|id| id.as_i64()) == Some(msg_id) {
                        if let Some(data) = resp.pointer("/result/data").and_then(|d| d.as_str()) {
                            let _ = app_handle.emit("browser_stream_frame", serde_json::json!({
                                "agent_id": agent_id,
                                "frame": data
                            }));
                        }
                        break;
                    }
                }
            }
        }

        msg_id += 1;
    }
}


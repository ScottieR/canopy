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

        // Generate a PAC (Proxy Auto-Config) script to block Host SSRF
        // This prevents the agent from navigating to localhost or local network IPs from the host.
        let pac_script = r#"
            function FindProxyForURL(url, host) {
                // Block local subnets and file paths
                if (shExpMatch(host, "127.0.0.1") || 
                    shExpMatch(host, "localhost") || 
                    shExpMatch(host, "192.168.*") || 
                    shExpMatch(host, "10.*") || 
                    shExpMatch(host, "172.16.*") ||
                    url.startsWith("file://")) {
                    return "PROXY 127.0.0.1:99999"; // Blackhole invalid port
                }
                return "DIRECT";
            }
        "#;
        use base64::Engine;
        let pac_base64 = base64::engine::general_purpose::STANDARD.encode(pac_script);
        let pac_url = format!("data:application/x-ns-proxy-autoconfig;base64,{}", pac_base64);

        // Try to find Google Chrome on macOS
        let chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        if !std::path::Path::new(chrome_path).exists() {
            return Err(anyhow::anyhow!("Google Chrome not found at {}. Please install it to use Machine Browser.", chrome_path));
        }

        let mut child = Command::new(chrome_path)
            .args([
                "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1", 
                &format!("--user-data-dir={}", profile_path),
                "--no-first-run",
                "--no-default-browser-check",
                
                // Hide off-screen!
                "--window-position=-3000,0",
                "--window-size=1280,800",
                
                // Security Flags
                "--disable-extensions", // Prevent malicious extensions
                "--deny-permission-prompts", // Block location, camera, mic prompts
                "--disable-sync", // Ensure no accidental profile sync
                "--disable-features=TranslateUI",
                "--safebrowsing-disable-download-protection", // Allow raw downloads to workspace without prompt
                
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
        .args(["exec", "-u", "node", "canopy-gateway", "openclaw", "agents", "edit", &agent_id, "--env", &format!("PLAYWRIGHT_CDP_ENDPOINT={}", ws_endpoint)])
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
    move_browser(&state, &agent_id, 0).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hide_browser(state: tauri::State<'_, BrowserManager>, agent_id: String) -> Result<(), String> {
    move_browser(&state, &agent_id, -3000).await.map_err(|e| e.to_string())
}

async fn move_browser(state: &BrowserManager, agent_id: &str, left: i32) -> Result<()> {
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
                    "top": 0,
                    "width": 1280,
                    "height": 800
                }
            }
        });
        ws_stream.send(Message::Text(req2.to_string().into())).await?;
    }

    Ok(())
}

async fn stream_browser_visuals(app_handle: tauri::AppHandle, agent_id: String, cdp_url: String) {
    use tokio_tungstenite::connect_async;
    use futures_util::{SinkExt, StreamExt};
    use tauri::Emitter;
    use tokio::time::{sleep, Duration};

    let mut retry_count = 0;
    let max_retries = 5;
    
    let (mut ws_stream, _) = loop {
        match connect_async(&cdp_url).await {
            Ok(ws) => break ws,
            Err(e) => {
                retry_count += 1;
                if retry_count >= max_retries {
                    tracing::error!("Failed to connect to CDP websocket for visual streaming: {}", e);
                    return;
                }
                sleep(Duration::from_millis(500)).await;
            }
        }
    };

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
            break;
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


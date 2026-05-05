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
    pub profile_path: String,
    pub is_running: bool,
}

pub struct BrowserManager {
    // Map agent_id to (ChildProcess, Port)
    active_browsers: Arc<Mutex<HashMap<String, (Child, u16)>>>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            active_browsers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start_browser(&self, agent_id: &str, port: u16) -> Result<BrowserStatus> {
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

        let child = Command::new(chrome_path)
            .args([
                &format!("--remote-debugging-port={}", port),
                // Expose CDP only to localhost (OrbStack forwards from container)
                "--remote-debugging-address=127.0.0.1", 
                &format!("--user-data-dir={}", profile_path),
                "--no-first-run",
                "--no-default-browser-check",
                
                // Security Flags
                "--disable-extensions", // Prevent malicious extensions
                "--deny-permission-prompts", // Block location, camera, mic prompts
                "--disable-sync", // Ensure no accidental profile sync
                "--disable-features=TranslateUI",
                "--safebrowsing-disable-download-protection", // Allow raw downloads to workspace without prompt
                
                // Network Guardrail: PAC script to block SSRF
                &format!("--proxy-pac-url={}", pac_url),

                // "--headless", // We want it headed for visual guardrails!
                "about:blank",
            ])
            .spawn()
            .context("Failed to spawn Chrome process")?;

        active.insert(agent_id.to_string(), (child, port));

        Ok(BrowserStatus {
            agent_id: agent_id.to_string(),
            port,
            profile_path,
            is_running: true,
        })
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
        if let Some((_, port)) = active.get(agent_id) {
            let data_dir = dirs::data_dir()
                .context("Could not find data directory")?
                .join("Canopy")
                .join("agent-browsers")
                .join(agent_id);
            
            Ok(Some(BrowserStatus {
                agent_id: agent_id.to_string(),
                port: *port,
                profile_path: data_dir.to_string_lossy().to_string(),
                is_running: true,
            }))
        } else {
            Ok(None)
        }
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_machine_browser(
    state: tauri::State<'_, BrowserManager>,
    agent_id: String,
    port: Option<u16>,
) -> Result<BrowserStatus, String> {
    let port = port.unwrap_or(9222); // Default to standard CDP port
    state.start_browser(&agent_id, port).await.map_err(|e| e.to_string())
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

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use tracing::{debug, error, info};

#[derive(Debug, Serialize, Deserialize)]
pub struct GoogleTokenResponse {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub scope: Option<String>,
    pub token_type: Option<String>,
    pub error: Option<String>,
}

// OAuth client credentials are safe to embed in desktop app binaries — Google's own
// documentation states that the "client secret" for desktop/native apps is not truly
// secret, because anyone can extract it from the binary. The env var override exists
// for local development only; production builds use these compile-time constants.
const GOOGLE_OAUTH_CLIENT_ID: &str = "677940720803-9ainnmmjh1ac4aeagq4ln3gll1v2t65f.apps.googleusercontent.com";
const GOOGLE_OAUTH_CLIENT_SECRET: &str = "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";

/// Start Google OAuth flow by opening the browser and listening for a local redirect
#[tauri::command]
pub async fn start_google_oauth(
    scopes: Vec<String>,
    read_only: Option<bool>,
) -> Result<GoogleTokenResponse, String> {
    // Prefer runtime env var (works during `tauri dev`); fall back to embedded constants
    // so the flow works in production builds where .env is not loaded at runtime.
    let client_id = std::env::var("GOOGLE_CLIENT_ID")
        .unwrap_or_else(|_| GOOGLE_OAUTH_CLIENT_ID.to_string());
    let client_secret = std::env::var("GOOGLE_CLIENT_SECRET")
        .unwrap_or_else(|_| GOOGLE_OAUTH_CLIENT_SECRET.to_string());
    let read_only = read_only.unwrap_or(false);

    // Find available port for redirect listener
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind port: {}", e))?;
    let port = listener.local_addr()
        .map_err(|e| format!("Failed to get port: {}", e))?
        .port();

    debug!("OAuth redirect listener on port {}", port);

    let redirect_uri = format!("http://localhost:{}", port);
    
    // Combine requested scopes plus standard email/profile
    let mut requested_scopes = vec![
        "https://www.googleapis.com/auth/userinfo.email".to_string(),
        "https://www.googleapis.com/auth/userinfo.profile".to_string()
    ];
    
    for scope in &scopes {
        if scope == "email" {
            requested_scopes.push("https://www.googleapis.com/auth/gmail.readonly".to_string());
            if !read_only {
                // Only request send/modify for write strategies (YOLO mode)
                requested_scopes.push("https://www.googleapis.com/auth/gmail.send".to_string());
                requested_scopes.push("https://www.googleapis.com/auth/gmail.modify".to_string());
            }
        }
        if scope == "calendar" {
            requested_scopes.push("https://www.googleapis.com/auth/calendar.readonly".to_string());
            if !read_only {
                // Only request write access for non-read-only strategies
                requested_scopes.push("https://www.googleapis.com/auth/calendar.events".to_string());
            }
        }
        if scope == "drive" {
            requested_scopes.push("https://www.googleapis.com/auth/drive.readonly".to_string());
            if !read_only {
                requested_scopes.push("https://www.googleapis.com/auth/drive.file".to_string());
            }
        }
    }

    let scope_string = requested_scopes.join(" ");

    // Build OAuth URL
    let oauth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        client_id,
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scope_string)
    );

    // Open browser
    if let Err(e) = open::that(&oauth_url) {
        error!("Failed to open browser: {}", e);
        return Err(format!("Failed to open browser: {}", e));
    }

    info!("Opened Google OAuth URL in browser");

    // Wait for redirect with timeout
    let timeout = std::time::Duration::from_secs(300); // 5 minutes
    listener.set_nonblocking(false)
        .map_err(|e| format!("Failed to configure listener: {}", e))?;

    // Read the HTTP request (blocking, with timeout)
    let code = tokio::task::spawn_blocking(move || {
        let (stream, _) = listener.accept()
            .map_err(|e| format!("Failed to accept connection: {}", e))?;

        stream.set_read_timeout(Some(timeout))
            .map_err(|e| format!("Failed to set timeout: {}", e))?;

        let mut buffer = [0u8; 2048];
        let n = std::io::Read::read(&mut &stream, &mut buffer)
            .map_err(|e| format!("Failed to read: {}", e))?;

        let request = String::from_utf8_lossy(&buffer[..n]);

        // Parse code from query string
        let code = request
            .lines()
            .next()
            .and_then(|line| {
                line.split_whitespace().nth(1).and_then(|path| {
                    path.split("code=").nth(1).map(|c| c.split('&').next().unwrap_or(""))
                })
            })
            .ok_or_else(|| "No code in redirect".to_string())?
            .to_string();

        // Send a simple HTML response to the browser
        let response = "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/html\r\n\r\n<html><head><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f4f0;color:#303330;}</style></head><body><div style='text-align:center;padding:40px;background:white;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,0.05);'> <h1 style='color:#3c6663;margin-top:0'>Google Connected!</h1> <p style='color:#636E72;font-size:16px;'>Canopy has successfully captured your credentials locally.</p> <p style='font-size:14px;opacity:0.6;margin-bottom:0;'>You may safely close this tab and return to the app.</p></div></body></html>";
        let _ = std::io::Write::write_all(&mut &stream, response.as_bytes());

        Ok::<String, String>(code)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))??;

    info!("Received Google OAuth code, exchanging for tokens...");

    // Exchange code for token
    let client = Client::new();
    let token_res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Token request failed: {}", e))?;

    if !token_res.status().is_success() {
        let err_text = token_res.text().await.unwrap_or_default();
        error!("Google token api error: {}", err_text);
        return Err(format!("Token exchange failed: {}", err_text));
    }

    let token_data: GoogleTokenResponse = token_res
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    if let Some(err) = &token_data.error {
        return Err(format!("Google token exchange error: {}", err));
    }

    // ── Persist tokens to keychain so re-auth isn't needed after app restart ──
    // Determine a stable prefix per service so email and calendar tokens don't clobber each other
    let service_prefix = if scopes.iter().any(|s| s == "email") { 
        "google-email" 
    } else if scopes.iter().any(|s| s == "drive") {
        "google-drive"
    } else { 
        "google-calendar" 
    };

    if let Some(access_token) = &token_data.access_token {
        let _ = crate::keychain::store_secret(
            &format!("{}-access-token", service_prefix),
            access_token,
        );
        // ── Forward token to OpenClaw so the agent can actually use the integration ──
        let channel_key = if scopes.iter().any(|s| s == "email") { 
            "gmail" 
        } else if scopes.iter().any(|s| s == "drive") {
            "googleDrive"
        } else { 
            "googleCalendar" 
        };
        let config_pairs: &[(&str, &str)] = &[
            ("enabled", "true"),
            ("accessToken", access_token.as_str()),
            ("clientId", &client_id),
            ("clientSecret", &client_secret),
        ];
        for (field, val) in config_pairs {
            let key = format!("channels.{}.{}", channel_key, field);
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                crate::openclaw::get_docker_command()
                    .args(["exec", "canopy-gateway", "openclaw", "config", "set", &key, val])
                    .output(),
            ).await;
        }
        if let Some(refresh_token) = &token_data.refresh_token {
            let _ = crate::keychain::store_secret(
                &format!("{}-refresh-token", service_prefix),
                refresh_token,
            );
            let key = format!("channels.{}.refreshToken", channel_key);
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                crate::openclaw::get_docker_command()
                    .args(["exec", "canopy-gateway", "openclaw", "config", "set", &key, refresh_token.as_str()])
                    .output(),
            ).await;
        }
        info!("Google {} tokens saved to keychain and forwarded to OpenClaw gateway", service_prefix);
    }

    Ok(token_data)
}

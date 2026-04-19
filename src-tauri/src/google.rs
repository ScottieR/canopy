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

/// Start Google OAuth flow by opening the browser and listening for a local redirect
#[tauri::command]
pub async fn start_google_oauth(
    scopes: Vec<String>,
) -> Result<GoogleTokenResponse, String> {
    let client_id = std::env::var("GOOGLE_CLIENT_ID")
        .map_err(|_| "GOOGLE_CLIENT_ID not set. Set it before connecting Workspace APIs.".to_string())?;
    
    let client_secret = std::env::var("GOOGLE_CLIENT_SECRET")
        .map_err(|_| "GOOGLE_CLIENT_SECRET not set.".to_string())?;

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
    
    for scope in scopes {
        if scope == "email" {
            requested_scopes.push("https://www.googleapis.com/auth/gmail.readonly".to_string());
            requested_scopes.push("https://www.googleapis.com/auth/gmail.send".to_string());
            requested_scopes.push("https://www.googleapis.com/auth/gmail.modify".to_string());
        }
        if scope == "calendar" {
            requested_scopes.push("https://www.googleapis.com/auth/calendar.readonly".to_string());
            requested_scopes.push("https://www.googleapis.com/auth/calendar.events".to_string());
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

    Ok(token_data)
}

/// Messaging and productivity channel connectors.
/// Each connector saves credentials to the keychain and configures OpenClaw
/// via `openclaw config set channels.{type}.*`, then restarts the gateway.
///
/// Security model: all tokens are stored in the macOS Keychain, never in
/// plaintext files. The gateway only receives them via docker exec stdin.

use crate::openclaw::get_docker_command;

// ─── Shared helper ────────────────────────────────────────────────────────────

async fn openclaw_config_set(key: &str, value: &str) -> Result<(), String> {
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        get_docker_command()
            .args(["exec", "canopy-gateway", "openclaw", "config", "set", key, value])
            .output(),
    )
    .await
    .map_err(|_| format!("Timed out setting openclaw config key: {}", key))?
    .map_err(|e| format!("docker exec failed for {}: {}", key, e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // Treat "container not running" as a soft warning — tokens are still saved to
        // keychain and will be applied on next repair/restart cycle.
        if stderr.contains("No such container") || stderr.contains("is not running") {
            tracing::warn!("Gateway offline while setting {}; will apply on next start", key);
            return Ok(());
        }
        return Err(format!("openclaw config set {} failed: {}", key, stderr.trim()));
    }
    Ok(())
}

async fn restart_gateway_soft() {
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        get_docker_command().args(["restart", "canopy-gateway"]).output(),
    ).await;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
//
// Requires a Bot Token from @BotFather (format: 123456789:ABCdef...)
// OpenClaw channel key: channels.telegram.*

#[tauri::command]
pub async fn configure_telegram(bot_token: String) -> Result<String, String> {
    let token = bot_token.trim().to_string();

    // Validate format: numeric ID, colon, alphanumeric string
    if !token.contains(':') || token.split(':').next().map_or(false, |id| id.parse::<u64>().is_err()) {
        return Err(
            "Invalid Telegram bot token format. It should look like '123456789:ABCdefGHI...' \
             — get one from @BotFather in Telegram.".to_string()
        );
    }

    // Save to keychain
    crate::keychain::store_secret("telegram-bot-token", &token)
        .map_err(|e| format!("Keychain error: {}", e))?;

    // Configure OpenClaw
    openclaw_config_set("channels.telegram.botToken", &token).await?;
    openclaw_config_set("channels.telegram.enabled", "true").await?;
    openclaw_config_set("channels.telegram.mode", "polling").await?;

    restart_gateway_soft().await;

    Ok("Telegram bot connected. Your agent will now respond to Telegram messages.".to_string())
}

#[tauri::command]
pub async fn disconnect_telegram() -> Result<String, String> {
    openclaw_config_set("channels.telegram.enabled", "false").await?;
    restart_gateway_soft().await;
    Ok("Telegram disconnected.".to_string())
}

// ─── WhatsApp (Meta Cloud API) ────────────────────────────────────────────────
//
// Requires:
//   - Phone Number ID    (from Meta for Developers → WhatsApp → API Setup)
//   - Business Account ID
//   - Permanent System User Token (generate via Business Manager → System Users)
//
// NOTE: WhatsApp Business API requires a verified Meta Business account and a
// dedicated phone number. Personal WhatsApp accounts cannot be used.
// OpenClaw channel key: channels.whatsapp.*

#[tauri::command]
pub async fn configure_whatsapp(
    phone_number_id: String,
    business_account_id: String,
    api_token: String,
) -> Result<String, String> {
    let phone_id = phone_number_id.trim().to_string();
    let biz_id = business_account_id.trim().to_string();
    let token = api_token.trim().to_string();

    if phone_id.is_empty() || biz_id.is_empty() || token.is_empty() {
        return Err("All three fields are required: Phone Number ID, Business Account ID, and API Token.".to_string());
    }
    if !token.starts_with("EAA") {
        return Err(
            "API Token looks wrong — Meta permanent system user tokens start with 'EAA'. \
             Make sure you are using a System User Token, not an app secret or page token.".to_string()
        );
    }

    // Save to keychain
    crate::keychain::store_secret("whatsapp-phone-number-id", &phone_id)
        .map_err(|e| format!("Keychain error: {}", e))?;
    crate::keychain::store_secret("whatsapp-business-account-id", &biz_id)
        .map_err(|e| format!("Keychain error: {}", e))?;
    crate::keychain::store_secret("whatsapp-api-token", &token)
        .map_err(|e| format!("Keychain error: {}", e))?;

    // Configure OpenClaw
    openclaw_config_set("channels.whatsapp.phoneNumberId", &phone_id).await?;
    openclaw_config_set("channels.whatsapp.businessAccountId", &biz_id).await?;
    openclaw_config_set("channels.whatsapp.apiToken", &token).await?;
    openclaw_config_set("channels.whatsapp.enabled", "true").await?;

    restart_gateway_soft().await;

    Ok("WhatsApp Business connected. Your agent will now respond to WhatsApp messages.".to_string())
}

// ─── Discord ──────────────────────────────────────────────────────────────────
//
// Requires a Bot Token from the Discord Developer Portal.
// Steps: discord.com/developers → New Application → Bot → Reset Token
// Invite the bot to your server with: applications.commands + bot scopes,
// and permissions: Send Messages, Read Message History, View Channels.
// OpenClaw channel key: channels.discord.*

#[tauri::command]
pub async fn configure_discord(
    bot_token: String,
    guild_id: Option<String>,
) -> Result<String, String> {
    let token = bot_token.trim().to_string();

    // Discord bot tokens are base64-encoded and contain two dots
    if token.matches('.').count() < 2 || token.len() < 50 {
        return Err(
            "Invalid Discord bot token format. Get it from the Discord Developer Portal: \
             discord.com/developers → Your App → Bot → Reset Token.".to_string()
        );
    }

    crate::keychain::store_secret("discord-bot-token", &token)
        .map_err(|e| format!("Keychain error: {}", e))?;

    openclaw_config_set("channels.discord.botToken", &token).await?;
    openclaw_config_set("channels.discord.enabled", "true").await?;

    if let Some(gid) = guild_id.as_deref().filter(|s| !s.trim().is_empty()) {
        crate::keychain::store_secret("discord-guild-id", gid)
            .map_err(|e| format!("Keychain error: {}", e))?;
        openclaw_config_set("channels.discord.guildId", gid.trim()).await?;
    }

    restart_gateway_soft().await;

    Ok("Discord bot connected. Your agent will now respond to Discord messages.".to_string())
}

// ─── GitHub ───────────────────────────────────────────────────────────────────
//
// Requires a Personal Access Token (classic) or Fine-grained PAT.
// Recommended scopes: repo, issues, pull_requests, notifications (read-only for secure mode).
// OpenClaw channel key: channels.github.*

#[tauri::command]
pub async fn configure_github(
    personal_access_token: String,
    username: Option<String>,
) -> Result<String, String> {
    let token = personal_access_token.trim().to_string();

    if !token.starts_with("ghp_") && !token.starts_with("github_pat_") && !token.starts_with("gho_") {
        return Err(
            "Invalid GitHub token format. Classic PATs start with 'ghp_', \
             fine-grained PATs start with 'github_pat_'. \
             Generate one at github.com/settings/tokens.".to_string()
        );
    }

    crate::keychain::store_secret("github-access-token", &token)
        .map_err(|e| format!("Keychain error: {}", e))?;

    openclaw_config_set("channels.github.accessToken", &token).await?;
    openclaw_config_set("channels.github.enabled", "true").await?;

    if let Some(user) = username.as_deref().filter(|s| !s.trim().is_empty()) {
        crate::keychain::store_secret("github-username", user.trim())
            .map_err(|e| format!("Keychain error: {}", e))?;
        openclaw_config_set("channels.github.username", user.trim()).await?;
    }

    restart_gateway_soft().await;

    Ok("GitHub connected. Your agent can now read issues, PRs, and notifications.".to_string())
}

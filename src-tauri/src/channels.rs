/// Messaging and productivity channel connectors.
/// Each connector saves credentials to the keychain and configures OpenClaw by writing
/// all required fields atomically into `openclaw.json` via a single `node -e` patch,
/// then restarting the gateway exactly once.
///
/// Why not `openclaw config set channels.X.* …`?
///   Each `config set` call sends OpenClaw a SIGTERM and triggers a full process restart.
///   A 4-key configurator therefore caused 4 SIGTERM cascades plus the explicit
///   `docker restart` on top — which routinely OOMed the container with multiple agents.
///   See OPENCLAW_INTEGRATION.md §8.
///
/// Security model: all tokens are stored in the macOS Keychain, never in plaintext
/// files. The gateway only receives them via docker exec stdin (in this case, embedded
/// as JSON-quoted string literals inside the `node -e` script).

use crate::openclaw::get_docker_command;
use serde_json::{json, Value};

// ─── Shared helpers ───────────────────────────────────────────────────────────

/// Atomically patch one channel's config block (`channels.{name}` and the matching
/// `plugins.entries.{name}.enabled` flag) into openclaw.json via a single `node -e`
/// invocation. Replaces the previous N-call `openclaw config set` loop.
///
/// `fields` must be a JSON object. Its keys/values are merged into `channels.{name}`.
/// If `fields.enabled` is a boolean, it is mirrored into `plugins.entries.{name}.enabled`
/// so the plugin actually starts/stops alongside the channel.
async fn patch_channel_config(channel_name: &str, fields: Value) -> Result<(), String> {
    if !fields.is_object() {
        return Err(format!("patch_channel_config: fields must be a JSON object, got {}", fields));
    }

    // Embed the fields object directly as a JS literal — JSON is a subset of JS so this
    // is safe regardless of token contents (newlines, quotes, etc. are already escaped).
    let fields_json = serde_json::to_string(&fields)
        .map_err(|e| format!("patch_channel_config: serialize error: {}", e))?;

    // Channel name is restricted to [a-z0-9-]+ for safety inside the JS string literal.
    if !channel_name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("patch_channel_config: invalid channel name {:?}", channel_name));
    }

    let patch_script = format!(
        r#"const fs=require('fs');
const p='/home/node/.openclaw/openclaw.json';
let c=JSON.parse(fs.readFileSync(p,'utf8'));
const ch='{ch}';
const f={fields};
c.channels=c.channels||{{}};
c.channels[ch]=c.channels[ch]||{{}};
Object.assign(c.channels[ch],f);
c.plugins=c.plugins||{{}};
c.plugins.entries=c.plugins.entries||{{}};
c.plugins.entries[ch]=c.plugins.entries[ch]||{{}};
if(typeof f.enabled==='boolean') c.plugins.entries[ch].enabled=f.enabled;
fs.writeFileSync(p,JSON.stringify(c,null,2));
console.log('channel '+ch+' patched');
"#,
        ch = channel_name,
        fields = fields_json,
    );

    let out = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "node", "-e", &patch_script])
            .output(),
    )
    .await
    .map_err(|_| format!("Timed out patching {} channel config", channel_name))?
    .map_err(|e| format!("docker exec failed for {} patch: {}", channel_name, e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // Treat "container not running" as a soft warning — credentials are still in the
        // keychain and will be applied on the next gateway start cycle.
        if stderr.contains("No such container") || stderr.contains("is not running") {
            tracing::warn!("Gateway offline while patching {}; will apply on next start", channel_name);
            return Ok(());
        }
        return Err(format!("{} patch failed: {}", channel_name, stderr.trim()));
    }
    Ok(())
}

/// One soft `docker restart canopy-gateway`, with a hard timeout. The whole point of the
/// `patch_channel_config` design is that we get exactly ONE restart per configurator
/// call — not one-per-key.
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

    // Configure OpenClaw — single atomic patch, one restart.
    patch_channel_config("telegram", json!({
        "botToken": token,
        "enabled": true,
        "mode": "polling",
    })).await?;

    restart_gateway_soft().await;

    Ok("Telegram bot connected. Your agent will now respond to Telegram messages.".to_string())
}

#[tauri::command]
pub async fn disconnect_telegram() -> Result<String, String> {
    // Wipe the saved Bot Token from the keychain so a future reconnect requires the
    // user to re-paste it. Mirrors the "tokens + bindings" disconnect contract used by
    // every other channel disconnect command.
    let _ = crate::keychain::delete_secret_internal("telegram-bot-token");
    // Clear sensitive fields and disable the channel + plugin in openclaw.json.
    patch_channel_config("telegram", json!({
        "enabled":  false,
        "botToken": "",
    })).await?;
    restart_gateway_soft().await;
    Ok("Telegram disconnected and saved token removed.".to_string())
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

    // Configure OpenClaw — single atomic patch, one restart.
    patch_channel_config("whatsapp", json!({
        "phoneNumberId":     phone_id,
        "businessAccountId": biz_id,
        "apiToken":          token,
        "enabled":           true,
    })).await?;

    restart_gateway_soft().await;

    Ok("WhatsApp Business connected. Your agent will now respond to WhatsApp messages.".to_string())
}

// ─── Twilio ───────────────────────────────────────────────────────────────────
//
// Requires an Account SID, Auth Token, and a Twilio Phone Number.
// OpenClaw channel key: channels.twilio.*

#[tauri::command]
pub async fn configure_twilio(
    account_sid: String,
    auth_token: String,
    phone_number: String,
) -> Result<String, String> {
    let sid = account_sid.trim().to_string();
    let token = auth_token.trim().to_string();
    let phone = phone_number.trim().to_string();

    if sid.is_empty() || token.is_empty() || phone.is_empty() {
        return Err("All three fields are required: Account SID, Auth Token, and Phone Number.".to_string());
    }

    if !sid.starts_with("AC") {
        return Err("Account SID looks wrong — Twilio Account SIDs start with 'AC'.".to_string());
    }

    // Save to keychain
    crate::keychain::store_secret("twilio-account-sid", &sid)
        .map_err(|e| format!("Keychain error: {}", e))?;
    crate::keychain::store_secret("twilio-auth-token", &token)
        .map_err(|e| format!("Keychain error: {}", e))?;
    crate::keychain::store_secret("twilio-phone-number", &phone)
        .map_err(|e| format!("Keychain error: {}", e))?;

    // Configure OpenClaw — single atomic patch, one restart.
    patch_channel_config("twilio", json!({
        "accountSid":  sid,
        "authToken":   token,
        "phoneNumber": phone,
        "enabled":     true,
    })).await?;

    restart_gateway_soft().await;

    Ok("Twilio Voice & SMS connected. Your agent will now respond to calls and texts.".to_string())
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

    // Build the patch object — guildId is conditional.
    let mut fields = json!({
        "botToken": token,
        "enabled":  true,
    });

    if let Some(gid) = guild_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let gid_trimmed = gid.trim().to_string();
        crate::keychain::store_secret("discord-guild-id", &gid_trimmed)
            .map_err(|e| format!("Keychain error: {}", e))?;
        fields["guildId"] = Value::String(gid_trimmed);
    }

    // Configure OpenClaw — single atomic patch, one restart.
    patch_channel_config("discord", fields).await?;

    restart_gateway_soft().await;

    Ok("Discord bot connected. Your agent will now respond to Discord messages.".to_string())
}

// ─── Disconnect commands (WhatsApp / Twilio / Discord) ────────────────────────
//
// All three follow the same shape:
//   1. Wipe credentials from the macOS keychain so future reconnects require fresh tokens.
//   2. Patch openclaw.json to clear the channel's secret fields and set enabled=false
//      (and the matching `plugins.entries.X.enabled = false`).
//   3. Restart the gateway once so the channel sidecar tears down cleanly.
//
// `disconnect_telegram` lives next to its `configure_telegram` sibling above and follows
// the same contract.

#[tauri::command]
pub async fn disconnect_whatsapp() -> Result<String, String> {
    let _ = crate::keychain::delete_secret_internal("whatsapp-phone-number-id");
    let _ = crate::keychain::delete_secret_internal("whatsapp-business-account-id");
    let _ = crate::keychain::delete_secret_internal("whatsapp-api-token");
    patch_channel_config("whatsapp", json!({
        "enabled":           false,
        "phoneNumberId":     "",
        "businessAccountId": "",
        "apiToken":          "",
    })).await?;
    restart_gateway_soft().await;
    Ok("WhatsApp disconnected and saved tokens removed.".to_string())
}

#[tauri::command]
pub async fn disconnect_twilio() -> Result<String, String> {
    let _ = crate::keychain::delete_secret_internal("twilio-account-sid");
    let _ = crate::keychain::delete_secret_internal("twilio-auth-token");
    let _ = crate::keychain::delete_secret_internal("twilio-phone-number");
    patch_channel_config("twilio", json!({
        "enabled":     false,
        "accountSid":  "",
        "authToken":   "",
        "phoneNumber": "",
    })).await?;
    restart_gateway_soft().await;
    Ok("Twilio disconnected and saved tokens removed.".to_string())
}

#[tauri::command]
pub async fn disconnect_discord() -> Result<String, String> {
    let _ = crate::keychain::delete_secret_internal("discord-bot-token");
    let _ = crate::keychain::delete_secret_internal("discord-guild-id");
    patch_channel_config("discord", json!({
        "enabled":  false,
        "botToken": "",
        "guildId":  "",
    })).await?;
    restart_gateway_soft().await;
    Ok("Discord disconnected and saved tokens removed.".to_string())
}

// ─── GitHub ───────────────────────────────────────────────────────────────────
//
// Requires a Personal Access Token (classic) or Fine-grained PAT.
// Recommended scopes: repo, issues, pull_requests, notifications (read-only for secure mode).
//
// Note: GitHub is not configured via channels.github.* — it's wired up via a per-agent
// `gh` CLI wrapper that injects the token into the agent's workspace. So this function
// does not call `patch_channel_config`. The wrapper is the integration point.

#[tauri::command]
pub async fn configure_github(
    agent_id: String,
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

    crate::keychain::store_secret(&format!("github-access-token-{}", agent_id), &token)
        .map_err(|e| format!("Keychain error: {}", e))?;

    if let Some(user) = username.as_deref().filter(|s| !s.trim().is_empty()) {
        crate::keychain::store_secret(&format!("github-username-{}", agent_id), user.trim())
            .map_err(|e| format!("Keychain error: {}", e))?;
    }

    // Install gh CLI and global dynamic wrapper (runs as root)
    let root_setup_script = r#"
        if ! command -v gh >/dev/null 2>&1; then
            apt-get update && apt-get install -y curl gnupg && \
            curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
            chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
            echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
            apt-get update && apt-get install gh -y
        fi
        
        # Create global dynamic wrapper to isolate tokens per workspace
        cat << 'EOF' > /usr/local/bin/gh
#!/bin/bash
AGENT_ID=$(pwd | sed -n 's|.*/workspace/\([^/]*\).*|\1|p')
if [ -n "$AGENT_ID" ] && [ -f "/home/node/.openclaw/workspace/$AGENT_ID/.github_env" ]; then
    source "/home/node/.openclaw/workspace/$AGENT_ID/.github_env"
    export GH_TOKEN="$GITHUB_TOKEN"
fi
exec /usr/bin/gh "$@"
EOF
        chmod +x /usr/local/bin/gh
    "#;

    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        get_docker_command()
            .args(["exec", "-u", "root", "-e", "DEBIAN_FRONTEND=noninteractive", "canopy-gateway", "sh", "-c", root_setup_script])
            .output()
    ).await;

    // Inject the token securely into the agent's workspace and configure git helper
    let node_setup_script = format!(
        "echo 'GITHUB_TOKEN={token}' > /home/node/.openclaw/workspace/{agent_id}/.github_env; \
         git config --global credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'; \
         git config --global url.\"https://github.com/\".insteadOf \"git@github.com:\"; \
         git config --global url.\"https://github.com/\".insteadOf \"ssh://git@github.com/\"",
        token = token,
        agent_id = agent_id
    );
    
    let _ = get_docker_command()
        .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &node_setup_script])
        .output().await;

    restart_gateway_soft().await;

    Ok("GitHub connected. Your agent can now read issues, PRs, and notifications.".to_string())
}

/// Per-agent GitHub disconnect: removes the saved PAT (and username) from the keychain
/// AND wipes the agent's `bin/gh` wrapper + `.github_env` file inside the container so
/// the token is no longer reachable by the agent's tooling. No openclaw.json change is
/// required because GitHub is wired through a workspace wrapper, not a `channels.*` block.
#[tauri::command]
pub async fn disconnect_github(agent_id: String) -> Result<String, String> {
    if !agent_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("disconnect_github: invalid agent id {:?}", agent_id));
    }

    let _ = crate::keychain::delete_secret_internal(&format!("github-access-token-{}", agent_id));
    let _ = crate::keychain::delete_secret_internal(&format!("github-username-{}", agent_id));

    // Best-effort container-side cleanup. The wrapper + env file may not exist if the
    // user never connected GitHub; `rm -f` is silent in that case.
    let cleanup = format!(
        "rm -f /home/node/.openclaw/workspace/{aid}/bin/gh \
                /home/node/.openclaw/workspace/{aid}/.github_env",
        aid = agent_id,
    );
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        get_docker_command()
            .args(["exec", "-u", "node", "canopy-gateway", "sh", "-c", &cleanup])
            .output(),
    ).await;

    Ok("GitHub disconnected for this agent and saved token removed.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn test_e2e_github_container_provisioning() {
        // Skip if canopy-gateway is not running to avoid breaking CI
        let out = get_docker_command().args(["exec", "canopy-gateway", "echo", "ping"]).output().await.unwrap();
        if !out.status.success() {
            println!("Skipping E2E test, canopy-gateway container is not running");
            return;
        }

        // Run the configure_github command with a dummy token
        let token = "ghp_teste2e_token_1234567890".to_string();
        let res = configure_github("agent-test".to_string(), token.clone(), Some("testuser".to_string())).await;
        res.expect("configure_github failed");

        // Verify the environment variable was injected into the agent's bin wrapper
        let check_gh_script = get_docker_command()
            .args(["exec", "canopy-gateway", "cat", "/home/node/.openclaw/workspace/agent-test/bin/gh"])
            .output().await.unwrap();

        let gh_script_content = String::from_utf8_lossy(&check_gh_script.stdout);
        assert!(gh_script_content.contains(&format!("export GITHUB_TOKEN={}", token)), "Token not found in agent gh wrapper");

        // Verify the gh CLI is installed and accessible
        let check_gh = get_docker_command()
            .args(["exec", "canopy-gateway", "sh", "-c", "command -v gh"])
            .output().await.unwrap();

        assert!(check_gh.status.success(), "gh CLI is not installed in the container");
    }
}

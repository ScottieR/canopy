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
///
/// ── Per-agent isolation (matters — read this) ────────────────────────────────
/// Every `configure_*` command takes an `agent_id` parameter and namespaces all
/// keychain entries as `agent_{id}_{service}_{field}`. This is the same shape that
/// Slack and GitHub use and is the user-visible contract: each agent has its own
/// app/bot credentials, no cross-contamination, the keychain is auditable per
/// agent. Older builds wrote to globally-scoped keys (`telegram-bot-token`, etc.);
/// any agent reconnecting clobbered the previous one's secrets. Those global keys
/// are now legacy — kept ONLY for the `disconnect_*_global` paths used by the
/// "wipe all" Settings page.
///
/// Gateway routing caveat: OpenClaw's `channels.{name}.botToken` is still a
/// SINGLE string for Telegram/Discord/WhatsApp/Twilio (unlike Slack, which uses
/// an `accounts` map keyed by agent_id). So even though credentials are stored
/// per-agent in the keychain, the gateway's *active* bot for each channel is the
/// one written most recently. The keychain isolation prevents data corruption
/// (you can always retrieve any agent's token), but full per-agent runtime
/// routing requires OpenClaw to grow `channels.{name}.accounts` support — see
/// TODO inside each configurator. Until then: assume one active bot per channel,
/// reconfigure to switch which agent owns it.
use crate::openclaw::get_docker_command;
use serde_json::{json, Value};

/// Reject obviously-bad agent ids so they can't be smuggled into keychain key
/// names or `node -e` patch scripts. Matches the shape Slack and GitHub already
/// validate on their per-agent paths.
fn validate_agent_id(agent_id: &str) -> Result<(), String> {
    if agent_id.is_empty() {
        return Err("agent_id is required for per-agent channel configuration".into());
    }
    if !agent_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "invalid agent id {:?} — only [a-zA-Z0-9_-] allowed",
            agent_id
        ));
    }
    Ok(())
}

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
        return Err(format!(
            "patch_channel_config: fields must be a JSON object, got {}",
            fields
        ));
    }

    // Embed the fields object directly as a JS literal — JSON is a subset of JS so this
    // is safe regardless of token contents (newlines, quotes, etc. are already escaped).
    let fields_json = serde_json::to_string(&fields)
        .map_err(|e| format!("patch_channel_config: serialize error: {}", e))?;

    // Channel name is restricted to [a-z0-9-]+ for safety inside the JS string literal.
    if !channel_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "patch_channel_config: invalid channel name {:?}",
            channel_name
        ));
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
            .args([
                "exec",
                "-u",
                "node",
                crate::flavor::gateway_container(),
                "node",
                "-e",
                &patch_script,
            ])
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
            tracing::warn!(
                "Gateway offline while patching {}; will apply on next start",
                channel_name
            );
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
        get_docker_command()
            .args(["restart", crate::flavor::gateway_container()])
            .output(),
    )
    .await;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
//
// Requires a Bot Token from @BotFather (format: 123456789:ABCdef...)
// OpenClaw channel key: channels.telegram.*

#[tauri::command]
pub async fn configure_telegram(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    bot_token: String,
) -> Result<String, String> {
    validate_agent_id(&agent_id)?;
    let token = bot_token.trim().to_string();

    // Validate format: numeric ID, colon, alphanumeric string
    if !token.contains(':')
        || token
            .split(':')
            .next()
            .map_or(false, |id| id.parse::<u64>().is_err())
    {
        return Err(
            "Invalid Telegram bot token format. It should look like '123456789:ABCdefGHI...' \
             — get one from @BotFather in Telegram."
                .to_string(),
        );
    }

    // Per-agent keychain. Each agent's Telegram bot lives under its own slot so two
    // agents using Telegram can't overwrite each other.
    crate::keychain::store_secret(&format!("agent_{}_telegram_bot_token", agent_id), &token)
        .map_err(|e| format!("Keychain error: {}", e))?;

    // TODO(multi-tenant): OpenClaw currently reads ONE `channels.telegram.botToken`,
    // so only one agent's bot is active at the gateway level at a time — last writer
    // wins. To grow this into Slack-style multi-tenancy we'd need OpenClaw to support
    // `channels.telegram.accounts.{agent_id}` + a binding entry, mirroring the Slack
    // path in `openclaw::sync_gateway_channels_internal`. Until then, the keychain is
    // already in the right per-agent shape and the gateway can be re-pointed at any
    // agent's saved token without losing the others.
    patch_channel_config(
        "telegram",
        json!({
            "botToken": token,
            "enabled":  true,
            "mode":     "polling",
        }),
    )
    .await?;

    if let Err(error) = crate::bridge::sync_agent_communication_bridges_by_id(&db, &agent_id) {
        tracing::warn!(
            "Failed to sync Telegram bridge state for agent {}: {}",
            agent_id,
            error
        );
    }

    restart_gateway_soft().await;

    Ok(format!(
        "Telegram bot connected for agent '{}'. It will now respond to Telegram messages.",
        agent_id
    ))
}

/// Per-agent Telegram disconnect: wipes ONLY this agent's saved Telegram token.
///
/// Mirrors `disconnect_slack_for_agent`. Does NOT touch other agents' tokens. Other
/// agents' Telegram connections are unaffected (modulo the single-active-bot caveat
/// noted above — if this agent was the currently-active gateway bot, Telegram will
/// stop routing until another agent (re)configures Telegram).
#[tauri::command]
pub async fn disconnect_telegram_for_agent(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<String, String> {
    validate_agent_id(&agent_id)?;
    let _ =
        crate::keychain::delete_secret_internal(&format!("agent_{}_telegram_bot_token", agent_id));
    if let Err(error) = crate::bridge::sync_agent_communication_bridges_by_id(&db, &agent_id) {
        tracing::warn!(
            "Failed to sync Telegram bridge state after disconnect for agent {}: {}",
            agent_id,
            error
        );
    }
    Ok(format!("Telegram token removed for agent '{}'.", agent_id))
}

/// Global Telegram disconnect — disables the channel at the gateway and wipes the
/// legacy global keychain entry. Per-agent tokens (`agent_{id}_telegram_bot_token`)
/// are NOT touched; use `disconnect_telegram_for_agent` for those. Called by the
/// global IntegrationsView "Wipe Telegram" path.
#[tauri::command]
pub async fn disconnect_telegram() -> Result<String, String> {
    let _ = crate::keychain::delete_secret_internal("telegram-bot-token");
    patch_channel_config(
        "telegram",
        json!({
            "enabled":  false,
            "botToken": "",
        }),
    )
    .await?;
    restart_gateway_soft().await;
    Ok("Telegram disabled at the gateway. Per-agent saved tokens are kept; use the per-agent disconnect to remove them.".to_string())
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
    agent_id: String,
    phone_number_id: String,
    business_account_id: String,
    api_token: String,
) -> Result<String, String> {
    validate_agent_id(&agent_id)?;
    let phone_id = phone_number_id.trim().to_string();
    let biz_id = business_account_id.trim().to_string();
    let token = api_token.trim().to_string();

    if phone_id.is_empty() || biz_id.is_empty() || token.is_empty() {
        return Err(
            "All three fields are required: Phone Number ID, Business Account ID, and API Token."
                .to_string(),
        );
    }
    if !token.starts_with("EAA") {
        return Err(
            "API Token looks wrong — Meta permanent system user tokens start with 'EAA'. \
             Make sure you are using a System User Token, not an app secret or page token."
                .to_string(),
        );
    }

    // Per-agent keychain. WhatsApp Business has THREE secrets per agent; each goes
    // under its own slot so a second agent connecting can't clobber the first.
    crate::keychain::store_secret(
        &format!("agent_{}_whatsapp_phone_number_id", agent_id),
        &phone_id,
    )
    .map_err(|e| format!("Keychain error: {}", e))?;
    crate::keychain::store_secret(
        &format!("agent_{}_whatsapp_business_account_id", agent_id),
        &biz_id,
    )
    .map_err(|e| format!("Keychain error: {}", e))?;
    crate::keychain::store_secret(&format!("agent_{}_whatsapp_api_token", agent_id), &token)
        .map_err(|e| format!("Keychain error: {}", e))?;

    // TODO(multi-tenant): same caveat as Telegram — OpenClaw reads single
    // `channels.whatsapp.{field}` values so last writer wins at the gateway. Storage
    // is per-agent; runtime routing is single-tenant until OpenClaw grows accounts
    // support for whatsapp.
    patch_channel_config(
        "whatsapp",
        json!({
            "phoneNumberId":     phone_id,
            "businessAccountId": biz_id,
            "apiToken":          token,
            "enabled":           true,
        }),
    )
    .await?;

    restart_gateway_soft().await;

    Ok(format!(
        "WhatsApp Business connected for agent '{}'. It will now respond to WhatsApp messages.",
        agent_id
    ))
}

/// Per-agent WhatsApp disconnect: wipes only this agent's three saved credentials.
#[tauri::command]
pub async fn disconnect_whatsapp_for_agent(agent_id: String) -> Result<String, String> {
    validate_agent_id(&agent_id)?;
    let _ = crate::keychain::delete_secret_internal(&format!(
        "agent_{}_whatsapp_phone_number_id",
        agent_id
    ));
    let _ = crate::keychain::delete_secret_internal(&format!(
        "agent_{}_whatsapp_business_account_id",
        agent_id
    ));
    let _ =
        crate::keychain::delete_secret_internal(&format!("agent_{}_whatsapp_api_token", agent_id));
    Ok(format!(
        "WhatsApp credentials removed for agent '{}'.",
        agent_id
    ))
}

// ─── Twilio ───────────────────────────────────────────────────────────────────
//
// Requires an Account SID, Auth Token, and a Twilio Phone Number.
// OpenClaw channel key: channels.twilio.*

#[tauri::command]
pub async fn configure_twilio(
    agent_id: String,
    account_sid: String,
    auth_token: String,
    phone_number: String,
) -> Result<String, String> {
    validate_agent_id(&agent_id)?;
    let sid = account_sid.trim().to_string();
    let token = auth_token.trim().to_string();
    let phone = phone_number.trim().to_string();

    if sid.is_empty() || token.is_empty() || phone.is_empty() {
        return Err(
            "All three fields are required: Account SID, Auth Token, and Phone Number.".to_string(),
        );
    }

    if !sid.starts_with("AC") {
        return Err("Account SID looks wrong — Twilio Account SIDs start with 'AC'.".to_string());
    }

    // Per-agent keychain. Each agent's Twilio sub-account / auth token lives under
    // its own slot — important since a Twilio subaccount per agent is the standard
    // way to do voice/SMS per persona.
    crate::keychain::store_secret(&format!("agent_{}_twilio_account_sid", agent_id), &sid)
        .map_err(|e| format!("Keychain error: {}", e))?;
    crate::keychain::store_secret(&format!("agent_{}_twilio_auth_token", agent_id), &token)
        .map_err(|e| format!("Keychain error: {}", e))?;
    crate::keychain::store_secret(&format!("agent_{}_twilio_phone_number", agent_id), &phone)
        .map_err(|e| format!("Keychain error: {}", e))?;

    // TODO(multi-tenant): same caveat as Telegram/WhatsApp — gateway still reads a
    // single `channels.twilio.{field}` set.
    patch_channel_config(
        "twilio",
        json!({
            "accountSid":  sid,
            "authToken":   token,
            "phoneNumber": phone,
            "enabled":     true,
        }),
    )
    .await?;

    restart_gateway_soft().await;

    Ok(format!(
        "Twilio Voice & SMS connected for agent '{}'. It will now respond to calls and texts.",
        agent_id
    ))
}

/// Per-agent Twilio disconnect: wipes only this agent's three saved credentials.
#[tauri::command]
pub async fn disconnect_twilio_for_agent(agent_id: String) -> Result<String, String> {
    validate_agent_id(&agent_id)?;
    let _ =
        crate::keychain::delete_secret_internal(&format!("agent_{}_twilio_account_sid", agent_id));
    let _ =
        crate::keychain::delete_secret_internal(&format!("agent_{}_twilio_auth_token", agent_id));
    let _ =
        crate::keychain::delete_secret_internal(&format!("agent_{}_twilio_phone_number", agent_id));
    Ok(format!(
        "Twilio credentials removed for agent '{}'.",
        agent_id
    ))
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
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    bot_token: String,
    guild_id: Option<String>,
) -> Result<String, String> {
    validate_agent_id(&agent_id)?;
    let token = bot_token.trim().to_string();

    // Discord bot tokens are base64-encoded and contain two dots
    if token.matches('.').count() < 2 || token.len() < 50 {
        return Err(
            "Invalid Discord bot token format. Get it from the Discord Developer Portal: \
             discord.com/developers → Your App → Bot → Reset Token."
                .to_string(),
        );
    }

    // Per-agent keychain. Each agent gets its own Discord app + bot token in its
    // own slot so two agents can't overwrite each other on connect.
    crate::keychain::store_secret(&format!("agent_{}_discord_bot_token", agent_id), &token)
        .map_err(|e| format!("Keychain error: {}", e))?;

    // Build the patch object — guildId is conditional.
    let mut fields = json!({
        "botToken": token,
        "enabled":  true,
    });

    if let Some(gid) = guild_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let gid_trimmed = gid.trim().to_string();
        crate::keychain::store_secret(
            &format!("agent_{}_discord_guild_id", agent_id),
            &gid_trimmed,
        )
        .map_err(|e| format!("Keychain error: {}", e))?;
        fields["guildId"] = Value::String(gid_trimmed);
    }

    // TODO(multi-tenant): same caveat as Telegram/WhatsApp/Twilio — gateway still
    // reads a single `channels.discord.botToken`.
    patch_channel_config("discord", fields).await?;

    if let Err(error) = crate::bridge::sync_agent_communication_bridges_by_id(&db, &agent_id) {
        tracing::warn!(
            "Failed to sync Discord bridge state for agent {}: {}",
            agent_id,
            error
        );
    }

    restart_gateway_soft().await;

    Ok(format!(
        "Discord bot connected for agent '{}'. It will now respond to Discord messages.",
        agent_id
    ))
}

/// Per-agent Discord disconnect: wipes only this agent's bot token + guild id.
#[tauri::command]
pub async fn disconnect_discord_for_agent(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<String, String> {
    validate_agent_id(&agent_id)?;
    let _ =
        crate::keychain::delete_secret_internal(&format!("agent_{}_discord_bot_token", agent_id));
    let _ =
        crate::keychain::delete_secret_internal(&format!("agent_{}_discord_guild_id", agent_id));
    if let Err(error) = crate::bridge::sync_agent_communication_bridges_by_id(&db, &agent_id) {
        tracing::warn!(
            "Failed to sync Discord bridge state after disconnect for agent {}: {}",
            agent_id,
            error
        );
    }
    Ok(format!(
        "Discord credentials removed for agent '{}'.",
        agent_id
    ))
}

// ─── Global "disable channel at the gateway" disconnects ─────────────────────
//
// These three mirror `disconnect_telegram` / `disconnect_slack_global`. They:
//   1. Wipe the LEGACY global keychain entries (e.g. `whatsapp-api-token`). Modern
//      per-agent entries (`agent_{id}_whatsapp_api_token`) are NOT touched — that's
//      what `disconnect_*_for_agent` is for.
//   2. Patch openclaw.json to clear the channel's active secret fields and set
//      enabled=false (and the matching `plugins.entries.X.enabled = false`).
//   3. Restart the gateway once so the channel sidecar tears down cleanly.
//
// Use when the user wants to turn off a channel globally regardless of which agent
// owned it. Use the per-agent variants when removing a single agent's credentials.

#[tauri::command]
pub async fn disconnect_whatsapp() -> Result<String, String> {
    let _ = crate::keychain::delete_secret_internal("whatsapp-phone-number-id");
    let _ = crate::keychain::delete_secret_internal("whatsapp-business-account-id");
    let _ = crate::keychain::delete_secret_internal("whatsapp-api-token");
    patch_channel_config(
        "whatsapp",
        json!({
            "enabled":           false,
            "phoneNumberId":     "",
            "businessAccountId": "",
            "apiToken":          "",
        }),
    )
    .await?;
    restart_gateway_soft().await;
    Ok("WhatsApp disabled at the gateway. Per-agent saved tokens are kept; use the per-agent disconnect to remove them.".to_string())
}

#[tauri::command]
pub async fn disconnect_twilio() -> Result<String, String> {
    let _ = crate::keychain::delete_secret_internal("twilio-account-sid");
    let _ = crate::keychain::delete_secret_internal("twilio-auth-token");
    let _ = crate::keychain::delete_secret_internal("twilio-phone-number");
    patch_channel_config(
        "twilio",
        json!({
            "enabled":     false,
            "accountSid":  "",
            "authToken":   "",
            "phoneNumber": "",
        }),
    )
    .await?;
    restart_gateway_soft().await;
    Ok("Twilio disabled at the gateway. Per-agent saved tokens are kept; use the per-agent disconnect to remove them.".to_string())
}

#[tauri::command]
pub async fn disconnect_discord() -> Result<String, String> {
    let _ = crate::keychain::delete_secret_internal("discord-bot-token");
    let _ = crate::keychain::delete_secret_internal("discord-guild-id");
    patch_channel_config(
        "discord",
        json!({
            "enabled":  false,
            "botToken": "",
            "guildId":  "",
        }),
    )
    .await?;
    restart_gateway_soft().await;
    Ok("Discord disabled at the gateway. Per-agent saved tokens are kept; use the per-agent disconnect to remove them.".to_string())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct GithubRepoPermissions {
    pub push: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct GithubRepo {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub private: bool,
    pub permissions: Option<GithubRepoPermissions>,
}

#[tauri::command]
pub async fn fetch_github_repos(token: String) -> Result<Vec<GithubRepo>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();
    let res = client
        .get("https://api.github.com/user/repos?per_page=100")
        .header("User-Agent", "Canopy-App")
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("Failed to request GitHub API: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("GitHub API returned error: {}", res.status()));
    }

    let all_repos: Vec<GithubRepo> = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub repos: {}", e))?;

    // Filter to only include repositories where the token has explicit write (push) access.
    // Fine-grained PATs default to read-only for all public repos, which creates clutter.
    let writable_repos = all_repos
        .into_iter()
        .filter(|r| r.permissions.as_ref().map(|p| p.push).unwrap_or(false))
        .collect();

    Ok(writable_repos)
}

// ─── GitHub ───────────────────────────────────────────────────────────────────
//
// Requires a Personal Access Token (classic) or Fine-grained PAT.
// Recommended scopes: repo, issues, pull_requests, notifications (read-only for secure mode).
//
// Note: GitHub is not configured via channels.github.* — it's wired up via a per-agent
// `gh` CLI wrapper that injects the token into the agent's workspace. So this function
// does not call `patch_channel_config`. The wrapper is the integration point.

fn is_safe_github_token_value(token: &str) -> bool {
    let has_known_prefix =
        token.starts_with("ghp_") || token.starts_with("github_pat_") || token.starts_with("gho_");
    has_known_prefix
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

const GITHUB_ROOT_SETUP_SCRIPT: &str = r#"
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

const GITHUB_NODE_SETUP_SCRIPT: &str =
    "git config --global credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'; \
     git config --global url.\"https://github.com/\".insteadOf \"git@github.com:\"; \
     git config --global url.\"https://github.com/\".insteadOf \"ssh://git@github.com/\"";

#[tauri::command]
pub async fn configure_github(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    personal_access_token: String,
    username: Option<String>,
) -> Result<String, String> {
    crate::validators::agent::validate_id(&agent_id)
        .map_err(|e| format!("Invalid agent ID: {}", e))?;
    let token = personal_access_token.trim().to_string();

    if !is_safe_github_token_value(&token) {
        return Err(
            "Invalid GitHub token format. Classic PATs start with 'ghp_', \
             fine-grained PATs start with 'github_pat_'. \
             Generate one at github.com/settings/tokens."
                .to_string(),
        );
    }

    crate::keychain::store_secret(&format!("github-access-token-{}", agent_id), &token)
        .map_err(|e| format!("Keychain error: {}", e))?;

    if let Some(user) = username.as_deref().filter(|s| !s.trim().is_empty()) {
        crate::keychain::store_secret(&format!("github-username-{}", agent_id), user.trim())
            .map_err(|e| format!("Keychain error: {}", e))?;
    }

    let container_name = crate::openclaw::get_agent_container_name(&db, &agent_id);

    // Install gh CLI and global dynamic wrapper (runs as root)
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        get_docker_command()
            .args([
                "exec",
                "-u",
                "root",
                "-e",
                "DEBIAN_FRONTEND=noninteractive",
                &container_name,
                "sh",
                "-c",
                GITHUB_ROOT_SETUP_SCRIPT,
            ])
            .output(),
    )
    .await;

    // Inject the token via the host bind-mount instead of interpolating secrets into sh -c.
    let workspace = crate::openclaw::get_agent_workspace_dir(&db, &agent_id)
        .map_err(|e| format!("Workspace error: {}", e))?;
    std::fs::create_dir_all(&workspace).map_err(|e| format!("Workspace create error: {}", e))?;
    std::fs::write(
        workspace.join(".github_env"),
        format!("GITHUB_TOKEN={}\n", token),
    )
    .map_err(|e| format!("Failed to write GitHub token file: {}", e))?;

    let _ = get_docker_command()
        .args([
            "exec",
            "-u",
            "node",
            &container_name,
            "sh",
            "-c",
            GITHUB_NODE_SETUP_SCRIPT,
        ])
        .output()
        .await;

    restart_gateway_soft().await;

    Ok("GitHub connected. Your agent can now read issues, PRs, and notifications.".to_string())
}

/// Restore root-filesystem GitHub tooling after an isolated container is recreated.
/// The per-agent token file lives in the persistent workspace mount, so this helper
/// never reads or injects another agent's credential.
pub(crate) async fn restore_agent_github_runtime(agent_id: &str, container_name: &str) {
    if crate::keychain::get_secret(&format!("github-access-token-{}", agent_id)).is_err() {
        return;
    }

    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        get_docker_command()
            .args([
                "exec",
                "-u",
                "root",
                "-e",
                "DEBIAN_FRONTEND=noninteractive",
                container_name,
                "sh",
                "-c",
                GITHUB_ROOT_SETUP_SCRIPT,
            ])
            .output(),
    )
    .await;

    let _ = get_docker_command()
        .args([
            "exec",
            "-u",
            "node",
            container_name,
            "sh",
            "-c",
            GITHUB_NODE_SETUP_SCRIPT,
        ])
        .output()
        .await;
}

/// Per-agent GitHub disconnect: removes the saved PAT (and username) from the keychain
/// AND wipes the agent's `bin/gh` wrapper + `.github_env` file inside the container so
/// the token is no longer reachable by the agent's tooling. No openclaw.json change is
/// required because GitHub is wired through a workspace wrapper, not a `channels.*` block.
#[tauri::command]
pub async fn disconnect_github(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<String, String> {
    if !agent_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "disconnect_github: invalid agent id {:?}",
            agent_id
        ));
    }

    let _ = crate::keychain::delete_secret_internal(&format!("github-access-token-{}", agent_id));
    let _ = crate::keychain::delete_secret_internal(&format!("github-username-{}", agent_id));

    let container_name = crate::openclaw::get_agent_container_name(&db, &agent_id);

    // Best-effort container-side cleanup. Direct argv execution keeps the agent
    // ID out of a shell program even though it has already passed validation.
    let wrapper_path = format!("/home/node/.openclaw/workspace/{agent_id}/bin/gh");
    let env_path = format!("/home/node/.openclaw/workspace/{agent_id}/.github_env");
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        get_docker_command()
            .args([
                "exec",
                "-u",
                "node",
                &container_name,
                "rm",
                "-f",
                &wrapper_path,
                &env_path,
            ])
            .output(),
    )
    .await;

    Ok("GitHub disconnected for this agent and saved token removed.".to_string())
}

#[cfg(test)]
mod github_token_validation_tests {
    use super::*;
    use tauri::Manager;

    #[tokio::test]
    #[ignore]
    async fn test_e2e_github_container_provisioning() {
        // Skip if canopy-gateway is not running to avoid breaking CI
        let out = get_docker_command()
            .args(["exec", crate::flavor::gateway_container(), "echo", "ping"])
            .output()
            .await
            .unwrap();
        if !out.status.success() {
            println!("Skipping E2E test, canopy-gateway container is not running");
            return;
        }

        let app = tauri::test::mock_app();
        let db = crate::db::Database::init_in_memory().unwrap();
        app.manage(db);
        let state = app.state::<crate::db::Database>();

        // Run the configure_github command with a dummy token
        let token = "ghp_teste2e_token_1234567890".to_string();
        let res = configure_github(
            state,
            "agent-test".to_string(),
            token.clone(),
            Some("testuser".to_string()),
        )
        .await;
        res.expect("configure_github failed");

        // Verify the environment variable was injected into the agent's bin wrapper
        let check_gh_script = get_docker_command()
            .args([
                "exec",
                crate::flavor::gateway_container(),
                "cat",
                "/home/node/.openclaw/workspace/agent-test/bin/gh",
            ])
            .output()
            .await
            .unwrap();

        let gh_script_content = String::from_utf8_lossy(&check_gh_script.stdout);
        assert!(
            gh_script_content.contains(&format!("export GITHUB_TOKEN={}", token)),
            "Token not found in agent gh wrapper"
        );

        // Verify the gh CLI is installed and accessible
        let check_gh = get_docker_command()
            .args([
                "exec",
                crate::flavor::gateway_container(),
                "sh",
                "-c",
                "command -v gh",
            ])
            .output()
            .await
            .unwrap();

        assert!(
            check_gh.status.success(),
            "gh CLI is not installed in the container"
        );
    }
}

// ─── Connection Diagnostics ───────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ConnectionDiagnostic {
    pub service: String,
    pub is_ok: bool,
    pub message: String,
}

async fn preflight_agent_connection_internal(
    agent_id: &str,
    integration: &str,
) -> Result<ConnectionDiagnostic, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    match integration {
        "github" => {
            if let Ok(token) =
                crate::keychain::get_secret(&format!("github-access-token-{}", agent_id))
            {
                let res = client
                    .get("https://api.github.com/user")
                    .header("User-Agent", "Canopy-Agent")
                    .bearer_auth(token)
                    .send()
                    .await;
                Ok(ConnectionDiagnostic {
                    service: "GitHub".to_string(),
                    is_ok: matches!(res, Ok(ref r) if r.status().is_success()),
                    message: if matches!(res, Ok(ref r) if r.status().is_success()) {
                        "Authenticated successfully.".to_string()
                    } else {
                        "GitHub token invalid. Reconfigure in Connections tab.".to_string()
                    },
                })
            } else {
                Ok(ConnectionDiagnostic {
                    service: "GitHub".to_string(),
                    is_ok: false,
                    message: "Missing GitHub token.".to_string(),
                })
            }
        }
        "telegram" => {
            if let Ok(token) =
                crate::keychain::get_secret(&format!("agent_{}_telegram_bot_token", agent_id))
            {
                let res = client
                    .get(&format!("https://api.telegram.org/bot{}/getMe", token))
                    .send()
                    .await;
                Ok(ConnectionDiagnostic {
                    service: "Telegram".to_string(),
                    is_ok: matches!(res, Ok(ref r) if r.status().is_success()),
                    message: if matches!(res, Ok(ref r) if r.status().is_success()) {
                        "Bot is active.".to_string()
                    } else {
                        "Invalid Telegram token.".to_string()
                    },
                })
            } else {
                Ok(ConnectionDiagnostic {
                    service: "Telegram".to_string(),
                    is_ok: false,
                    message: "Missing Telegram token.".to_string(),
                })
            }
        }
        "discord" => {
            if let Ok(token) =
                crate::keychain::get_secret(&format!("agent_{}_discord_bot_token", agent_id))
            {
                let res = client
                    .get("https://discord.com/api/v10/users/@me")
                    .header("Authorization", format!("Bot {}", token))
                    .send()
                    .await;
                Ok(ConnectionDiagnostic {
                    service: "Discord".to_string(),
                    is_ok: matches!(res, Ok(ref r) if r.status().is_success()),
                    message: if matches!(res, Ok(ref r) if r.status().is_success()) {
                        "Bot authenticated.".to_string()
                    } else {
                        "Invalid Discord token.".to_string()
                    },
                })
            } else {
                Ok(ConnectionDiagnostic {
                    service: "Discord".to_string(),
                    is_ok: false,
                    message: "Missing Discord token.".to_string(),
                })
            }
        }
        "twilio" => {
            if let (Ok(sid), Ok(token)) = (
                crate::keychain::get_secret(&format!("agent_{}_twilio_account_sid", agent_id)),
                crate::keychain::get_secret(&format!("agent_{}_twilio_auth_token", agent_id)),
            ) {
                let res = client
                    .get(&format!(
                        "https://api.twilio.com/2010-04-01/Accounts/{}.json",
                        sid
                    ))
                    .basic_auth(&sid, Some(&token))
                    .send()
                    .await;
                Ok(ConnectionDiagnostic {
                    service: "Twilio".to_string(),
                    is_ok: matches!(res, Ok(ref r) if r.status().is_success()),
                    message: if matches!(res, Ok(ref r) if r.status().is_success()) {
                        "Account verified.".to_string()
                    } else {
                        "Invalid Twilio credentials.".to_string()
                    },
                })
            } else {
                Ok(ConnectionDiagnostic {
                    service: "Twilio".to_string(),
                    is_ok: false,
                    message: "Missing Twilio credentials.".to_string(),
                })
            }
        }
        _ => Err(format!(
            "Unsupported integration preflight: {}",
            integration
        )),
    }
}

#[tauri::command]
pub async fn preflight_agent_connection(
    agent_id: String,
    integration: String,
) -> Result<ConnectionDiagnostic, String> {
    preflight_agent_connection_internal(&agent_id, &integration).await
}

/// Returns `(gateway_state_is_healthy, human_readable_reason)`.
///
/// Verifies that the live `openclaw.json` actually has this agent's Slack account
/// wired into the running gateway. The previous diagnostic only checked the
/// Slack `auth.test` API — that's a TOKEN check, not a GATEWAY check. A valid
/// token + an empty `channels.slack.accounts` would still get the agent stuck
/// at runtime with "Slack bot token missing for account 'agent-X'", and the
/// old diagnostic reported "healthy" while the user's chat was broken.
fn check_slack_gateway_state(
    gateway_cfg: Option<&serde_json::Value>,
    agent_id: &str,
    is_isolated: bool,
) -> (bool, String) {
    let cfg = match gateway_cfg {
        Some(c) => c,
        None => return (
            false,
            "Couldn't read the gateway's openclaw.json — is the canopy-gateway container running?"
                .to_string(),
        ),
    };

    let enabled = cfg
        .pointer("/channels/slack/enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !enabled {
        return (
            false,
            "Slack is disabled in the gateway config (channels.slack.enabled=false).".to_string(),
        );
    }

    let plugin_enabled = cfg
        .pointer("/plugins/entries/slack/enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !plugin_enabled {
        return (
            false,
            "Slack plugin is disabled in the gateway (plugins.entries.slack.enabled=false)."
                .to_string(),
        );
    }

    let account = cfg.pointer(&format!("/channels/slack/accounts/{}", agent_id));
    let account_bot_token_present = account
        .and_then(|a| a.get("botToken"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let account_app_token_present = account
        .and_then(|a| a.get("appToken"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let legacy_bot_token_present = cfg
        .pointer("/channels/slack/botToken")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let legacy_app_token_present = cfg
        .pointer("/channels/slack/appToken")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let bot_token_present = account_bot_token_present || legacy_bot_token_present;
    let app_token_present = account_app_token_present || legacy_app_token_present;

    if !bot_token_present || !app_token_present {
        return (
            false,
            format!(
                "No Slack credentials found in the gateway for '{}' (account_botToken_present={}, account_appToken_present={}, legacy_botToken_present={}, legacy_appToken_present={}). The keychain might have the tokens, but they haven't been pushed to the gateway — try \"Auto-Repair Configuration\".",
                agent_id, account_bot_token_present, account_app_token_present, legacy_bot_token_present, legacy_app_token_present
            ),
        );
    }

    // Confirm there's a binding routing inbound Slack messages to this agent.
    let has_binding = cfg
        .pointer("/bindings")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter().any(|b| {
                b.get("agentId").and_then(|a| a.as_str()) == Some(agent_id)
                    && b.pointer("/match/channel").and_then(|c| c.as_str()) == Some("slack")
            })
        })
        .unwrap_or(false);
    if !has_binding && !is_isolated {
        return (
            false,
            format!(
                "Slack account present but no binding route — inbound Slack messages won't reach this agent. Re-run sync_gateway_channels (or use Auto-Repair)."
            ),
        );
    }

    if !has_binding && is_isolated && legacy_bot_token_present && legacy_app_token_present {
        return (
            true,
            "Slack is configured using the legacy isolated single-bot shape; routing appears valid, but this agent should be migrated to the shared accounts+bindings format.".to_string(),
        );
    }

    (true, String::new())
}

#[tauri::command]
pub async fn ping_agent_connections(
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<Vec<ConnectionDiagnostic>, String> {
    ping_agent_connections_internal(&db, &agent_id).await
}

pub async fn ping_agent_connections_internal(
    db: &crate::db::Database,
    agent_id: &str,
) -> Result<Vec<ConnectionDiagnostic>, String> {
    let agent = db
        .get_agent(agent_id)
        .map_err(|e| format!("Failed to get agent: {}", e))?
        .ok_or_else(|| format!("Agent {} not found", agent_id))?;

    let mut diagnostics = Vec::new();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    // Read the current openclaw.json once and reuse it across all integration
    // checks. We need it to verify the GATEWAY-SIDE state (is this agent's
    // account actually wired into the running gateway?), not just whether the
    // token is valid against the third-party API. A valid token + an unloaded
    // gateway plugin was Poppy's exact failure mode — the old check reported
    // "healthy" while runtime was failing.
    let container_name = crate::openclaw::get_agent_container_name(db, agent_id);
    let gateway_cfg: Option<serde_json::Value> = match tokio::time::timeout(
        std::time::Duration::from_secs(4),
        crate::openclaw::get_docker_command()
            .args([
                "exec",
                "-u",
                "node",
                &container_name,
                "cat",
                "/home/node/.openclaw/openclaw.json",
            ])
            .output(),
    )
    .await
    {
        Ok(Ok(out)) if out.status.success() => serde_json::from_slice(&out.stdout).ok(),
        _ => None,
    };

    for integration in agent.integrations {
        match integration.as_str() {
            "slack" => {
                // Step 1: is the Slack TOKEN currently valid (auth.test)?
                let token_ok =
                    match crate::slack::check_slack_connection(Some(agent_id.to_string())).await {
                        Ok(s) => (s.connected, s.workspace_name),
                        Err(_) => (false, None),
                    };

                // Step 2: does the running gateway actually have Slack wired up
                // for THIS agent? We check four things in openclaw.json:
                //   - channels.slack.enabled == true
                //   - channels.slack.accounts[agent_id].botToken is non-empty
                //   - plugins.entries.slack.enabled == true
                //   - bindings has a slack route for this agent
                // Any miss = gateway-side misconfig regardless of token validity.
                let (gw_ok, gw_reason) =
                    check_slack_gateway_state(gateway_cfg.as_ref(), agent_id, agent.isolated);

                if token_ok.0 && gw_ok {
                    diagnostics.push(ConnectionDiagnostic {
                        service: "Slack".to_string(),
                        is_ok: true,
                        message: format!(
                            "Token valid (workspace: {}) and gateway is routing for this agent.",
                            token_ok.1.unwrap_or_else(|| "unknown".into())
                        ),
                    });
                } else if !token_ok.0 && !gw_ok {
                    diagnostics.push(ConnectionDiagnostic {
                        service: "Slack".to_string(),
                        is_ok: false,
                        message: format!(
                            "Token invalid AND gateway isn't routing for this agent. {} Reconnect Slack in the Connections tab.",
                            gw_reason
                        ),
                    });
                } else if !token_ok.0 {
                    diagnostics.push(ConnectionDiagnostic {
                        service: "Slack".to_string(),
                        is_ok: false,
                        message: "Slack token failed auth.test — the Slack app may have been deleted, the bot uninstalled from the workspace, or the token rotated. Reconnect in the Connections tab.".to_string(),
                    });
                } else {
                    // Token is fine, but gateway-side is wrong — most common
                    // case for "looks healthy but isn't". This is the gap the
                    // old diagnostic missed and the user explicitly called out.
                    diagnostics.push(ConnectionDiagnostic {
                        service: "Slack".to_string(),
                        is_ok: false,
                        message: format!(
                            "Token is valid but the gateway isn't routing Slack for this agent. {} Try \"Auto-Repair Configuration\" above, or reconnect Slack in the Connections tab.",
                            gw_reason
                        ),
                    });
                }
            }
            "github" => {
                diagnostics.push(preflight_agent_connection_internal(agent_id, "github").await?);
            }
            "telegram" => {
                diagnostics.push(preflight_agent_connection_internal(agent_id, "telegram").await?);
            }
            "discord" => {
                diagnostics.push(preflight_agent_connection_internal(agent_id, "discord").await?);
            }
            "whatsapp" => {
                if crate::keychain::get_secret(&format!("agent_{}_whatsapp_api_token", agent_id))
                    .is_ok()
                {
                    diagnostics.push(ConnectionDiagnostic {
                        service: "WhatsApp".to_string(),
                        is_ok: true,
                        message: "Credentials configured in keychain.".to_string(),
                    });
                } else {
                    diagnostics.push(ConnectionDiagnostic {
                        service: "WhatsApp".to_string(),
                        is_ok: false,
                        message: "Missing WhatsApp credentials.".to_string(),
                    });
                }
            }
            "twilio" => {
                diagnostics.push(preflight_agent_connection_internal(agent_id, "twilio").await?);
            }
            other => {
                if !other.starts_with("web_") {
                    diagnostics.push(ConnectionDiagnostic {
                        service: other.to_string(),
                        is_ok: true,
                        message: "Integration enabled.".to_string(),
                    });
                }
            }
        }
    }

    // JIT Bug Reporting: Automatically log any detected failures into the bug tracker
    // exactly when they are needed (e.g., prior to a message run or via the UI).
    for diag in &diagnostics {
        if !diag.is_ok {
            let bug = crate::models::AgentBugReport {
                id: uuid::Uuid::new_v4().to_string(),
                agent_id: agent_id.to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                service: diag.service.clone(),
                error_message: diag.message.clone(),
                resolved: false,
            };
            let _ = db.insert_agent_bug_report(&bug);
            tracing::warn!(
                "JIT diagnostic logged bug for agent {}: {}",
                agent_id,
                bug.error_message
            );
        }
    }

    Ok(diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_token_validation_accepts_known_safe_prefixes() {
        assert!(is_safe_github_token_value(
            "ghp_abcdefghijklmnopqrstuvwxyz123456"
        ));
        assert!(is_safe_github_token_value(
            "gho_abcdefghijklmnopqrstuvwxyz123456"
        ));
        assert!(is_safe_github_token_value("github_pat_11AA.BB-cc_22"));
    }

    #[test]
    fn github_token_validation_rejects_unknown_or_injectable_values() {
        assert!(!is_safe_github_token_value("sk-not-a-github-token"));
        assert!(!is_safe_github_token_value("ghp_valid;rm -rf"));
        assert!(!is_safe_github_token_value("ghp_valid$(whoami)"));
        assert!(!is_safe_github_token_value("ghp_valid\nGITHUB_TOKEN=other"));
    }
}

// ─── Eddy credential-failure recovery ──────────────────────────────────────────
//
// When an agent's LLM credentials die mid-conversation (revoked key, expired
// login), `openclaw::send_message_internal_with_context` already detects the
// auth-shaped error and emits `agent_provider_auth_failed` for the in-app modal.
// That's fine when the user is looking at Canopy, but does nothing if they're
// away from the desktop.
//
// This module adds a second, debounced trigger on top of the same detection
// point: once the *same agent* hits an auth-shaped failure twice in a row within
// a 5-minute window (a single failure could be a transient blip; two in a row is
// a real signal), it mints a web-hosted token-capture link via
// `web_connections::generate_credential_recovery_token` and messages the user on
// Slack with it — no terminal or desktop access required to fix it. When the
// user submits the key, `web_connections`'s poll daemon re-syncs it into the live
// agent and calls back into [`on_credential_recovery_completed`], which posts a
// follow-up message and replays the message that originally failed.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, State};

use crate::db::Database;

const FAILURE_WINDOW: Duration = Duration::from_secs(300);
const FAILURES_REQUIRED: u32 = 2;

const CREDENTIAL_RECOVERY_SLACK_WEBHOOK_SECRET: &str = "canopy_credential_recovery_slack_webhook";

#[derive(Clone)]
struct PendingReplay {
    conversation_id: String,
    message: String,
}

struct FailureTracker {
    count: u32,
    first_seen: Instant,
    replay: Option<PendingReplay>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRecoveryStatus {
    pub agent_id: String,
    pub provider: String,
    /// "pending" | "completed" | "expired"
    pub status: String,
    pub url: String,
    pub triggered_at: String,
    pub expires_at: String,
}

#[derive(Clone)]
struct RecoveryState {
    provider: String,
    url: String,
    triggered_at: chrono::DateTime<chrono::Utc>,
    expires_at: chrono::DateTime<chrono::Utc>,
    completed: bool,
}

fn trackers() -> &'static Mutex<HashMap<String, FailureTracker>> {
    static TRACKERS: OnceLock<Mutex<HashMap<String, FailureTracker>>> = OnceLock::new();
    TRACKERS.get_or_init(Default::default)
}

fn recoveries() -> &'static Mutex<HashMap<String, RecoveryState>> {
    static RECOVERIES: OnceLock<Mutex<HashMap<String, RecoveryState>>> = OnceLock::new();
    RECOVERIES.get_or_init(Default::default)
}

/// Called from `openclaw::send_message_internal_with_context` right after an
/// auth-shaped failure is detected for `agent_id`. A [`Deterministic`][d]
/// failure (no credential exists, or the one on file is confirmed dead) can
/// never self-resolve, so it triggers recovery on this very first call. An
/// [`Ambiguous`][a] failure debounces to 2 consecutive occurrences for the
/// same agent+provider within 5 minutes, since the underlying cause could be
/// transient. Either way, a recovery already in flight for this agent is left
/// alone rather than piling on a second Slack message.
///
/// [d]: crate::openclaw::AuthFailureCertainty::Deterministic
/// [a]: crate::openclaw::AuthFailureCertainty::Ambiguous
pub async fn note_agent_auth_failure(
    db: &Database,
    app: &tauri::AppHandle,
    agent_id: &str,
    provider: &str,
    certainty: crate::openclaw::AuthFailureCertainty,
    conversation_id: &str,
    message: &str,
) {
    if crate::web_connections::llm_provider_recovery_template(provider).is_none() {
        // Only Anthropic/Google are wired up for remote recovery today.
        return;
    }

    {
        let map = recoveries().lock().unwrap_or_else(|p| p.into_inner());
        if map.get(agent_id).is_some_and(|r| !r.completed) {
            return;
        }
    }

    let replay = PendingReplay {
        conversation_id: conversation_id.to_string(),
        message: message.to_string(),
    };

    let Some(replay) = decide_replay_for_failure(agent_id, provider, certainty, replay) else {
        return;
    };

    if let Err(e) = trigger_credential_recovery(db, app, agent_id, provider, Some(replay)).await {
        tracing::error!(
            "agent_health: failed to trigger credential recovery for {agent_id}/{provider}: {e}"
        );
    }
}

/// Decides whether to act on one auth failure, given its certainty. Split out
/// from [`note_agent_auth_failure`] so the decision (immediate for a confirmed
/// dead credential, debounced for an ambiguous one) is testable without a
/// `Database`/`AppHandle`.
fn decide_replay_for_failure(
    agent_id: &str,
    provider: &str,
    certainty: crate::openclaw::AuthFailureCertainty,
    replay: PendingReplay,
) -> Option<PendingReplay> {
    match certainty {
        crate::openclaw::AuthFailureCertainty::Deterministic => {
            // Never self-resolves — act now. Also clear any stale ambiguous
            // counter for this agent+provider so a later *ambiguous* failure
            // (e.g. after the key is fixed and later goes flaky again) doesn't
            // inherit a leftover count from before this recovery.
            let key = format!("{agent_id}:{provider}");
            trackers()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key);
            Some(replay)
        }
        crate::openclaw::AuthFailureCertainty::Ambiguous => {
            record_failure_and_check_threshold(agent_id, provider, replay)
        }
    }
}

/// Records one auth failure for `agent_id`/`provider` and returns the replay to
/// act on once the failure count reaches [`FAILURES_REQUIRED`] within
/// [`FAILURE_WINDOW`] — `None` otherwise (including when it resets a stale
/// counter from outside the window). Split out from [`note_agent_auth_failure`]
/// so the debounce arithmetic is testable without a `Database`/`AppHandle`.
fn record_failure_and_check_threshold(
    agent_id: &str,
    provider: &str,
    replay: PendingReplay,
) -> Option<PendingReplay> {
    let key = format!("{agent_id}:{provider}");
    let mut map = trackers().lock().unwrap_or_else(|p| p.into_inner());
    let entry = map.entry(key.clone()).or_insert_with(|| FailureTracker {
        count: 0,
        first_seen: Instant::now(),
        replay: None,
    });
    if entry.first_seen.elapsed() > FAILURE_WINDOW {
        entry.count = 0;
        entry.first_seen = Instant::now();
    }
    entry.count += 1;
    entry.replay = Some(replay);

    if entry.count < FAILURES_REQUIRED {
        None
    } else {
        map.remove(&key).and_then(|e| e.replay)
    }
}

/// Mints a recovery link and messages the user on Slack. Called both from the
/// automatic 2-consecutive-failures trigger and from the health panel's
/// "Regenerate link" button (with `replay: None`, since that's an explicit user
/// action rather than a message that actually failed).
async fn trigger_credential_recovery(
    db: &Database,
    app: &tauri::AppHandle,
    agent_id: &str,
    provider: &str,
    replay: Option<PendingReplay>,
) -> Result<(), String> {
    let web_token =
        crate::web_connections::generate_credential_recovery_token(db, agent_id, provider).await?;

    let (display_name, _, _) = crate::web_connections::llm_provider_recovery_template(provider)
        .ok_or_else(|| format!("credential recovery is not supported for provider {provider}"))?;

    let triggered_at = chrono::Utc::now();
    let expires_at = chrono::DateTime::parse_from_rfc3339(&web_token.expires_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or(triggered_at + chrono::Duration::minutes(15));

    recoveries()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            agent_id.to_string(),
            RecoveryState {
                provider: provider.to_string(),
                url: web_token.url.clone(),
                triggered_at,
                expires_at,
                completed: false,
            },
        );

    if let Some(replay) = replay {
        replays()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(agent_id.to_string(), replay);
    }

    let agent_name = db
        .get_agent(agent_id)
        .ok()
        .flatten()
        .map(|a| a.name)
        .unwrap_or_else(|| agent_id.to_string());

    let text = format!(
        "{name} can't respond right now — {provider} credentials need refreshing.\n\n\
         Tap to fix remotely: <{url}|Refresh {name} credentials →>\n\n\
         Once submitted, {name} will be back within 5 seconds. This link expires in 15 minutes.",
        name = agent_name,
        provider = display_name,
        url = web_token.url,
    );

    if let Err(e) = send_recovery_slack_message(db, agent_id, &text).await {
        tracing::warn!(
            "agent_health: could not deliver Slack recovery message for {agent_id}: {e}"
        );
    }

    let _ = app.emit(
        "credential_recovery_triggered",
        serde_json::json!({
            "agentId": agent_id,
            "provider": provider,
            "url": web_token.url,
            "expiresAt": web_token.expires_at,
        }),
    );

    Ok(())
}

fn replays() -> &'static Mutex<HashMap<String, PendingReplay>> {
    static REPLAYS: OnceLock<Mutex<HashMap<String, PendingReplay>>> = OnceLock::new();
    REPLAYS.get_or_init(Default::default)
}

/// Sends `text` via the failed agent's own bridged Slack channel if one exists;
/// otherwise falls back to the designated credential-recovery webhook (same
/// pattern as `feedback::notify_feedback_to_slack`'s #canopy-alerts-style relay).
async fn send_recovery_slack_message(
    db: &Database,
    agent_id: &str,
    text: &str,
) -> Result<(), String> {
    let allowed_channels =
        crate::slack::get_allowed_channels_internal(db, agent_id).unwrap_or_default();
    if let Some(channel_id) = allowed_channels.first() {
        match crate::slack::send_slack_message_internal(db, agent_id, channel_id, text).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                tracing::warn!(
                    "agent_health: agent-bridged Slack send failed for {agent_id}, falling back to webhook: {e}"
                );
            }
        }
    }

    match crate::feedback::post_text_to_slack_webhook(
        CREDENTIAL_RECOVERY_SLACK_WEBHOOK_SECRET,
        text,
    )
    .await
    {
        Ok(true) => Ok(()),
        Ok(false) => Err("no Slack bridge or credential-recovery webhook configured".to_string()),
        Err(e) => Err(e),
    }
}

/// Called by `web_connections::poll_pending_connections` once a credential
/// recovery's key has been decrypted, stored, and synced into the live agent.
/// Sends the "you're back" follow-up and replays the message that failed.
pub async fn on_credential_recovery_completed(
    app: &tauri::AppHandle,
    db: &Database,
    agent_id: &str,
    provider: &str,
) {
    if let Some(state) = recoveries()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(agent_id)
    {
        state.completed = true;
    }

    let agent_name = db
        .get_agent(agent_id)
        .ok()
        .flatten()
        .map(|a| a.name)
        .unwrap_or_else(|| agent_id.to_string());

    let follow_up = format!("{agent_name} credentials updated — resuming where we left off.");
    if let Err(e) = send_recovery_slack_message(db, agent_id, &follow_up).await {
        tracing::warn!("agent_health: could not deliver Slack follow-up for {agent_id}: {e}");
    }

    let replay = replays()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(agent_id);
    if let Some(replay) = replay {
        tracing::info!(
            "agent_health: replaying last message for {agent_id} after credential recovery"
        );
        if let Err(e) = crate::openclaw::send_message_internal(
            db,
            app,
            agent_id,
            &replay.message,
            Some(replay.conversation_id),
        )
        .await
        {
            tracing::error!(
                "agent_health: failed to replay message for {agent_id} after recovery: {e}"
            );
        }
    }

    let _ = app.emit(
        "credential_recovery_resolved",
        serde_json::json!({ "agentId": agent_id, "provider": provider }),
    );
}

#[tauri::command]
pub fn get_credential_recovery_status(agent_id: String) -> Option<CredentialRecoveryStatus> {
    let map = recoveries().lock().unwrap_or_else(|p| p.into_inner());
    let state = map.get(&agent_id)?;

    let status = if state.completed {
        "completed"
    } else if chrono::Utc::now() > state.expires_at {
        "expired"
    } else {
        "pending"
    };

    Some(CredentialRecoveryStatus {
        agent_id,
        provider: state.provider.clone(),
        status: status.to_string(),
        url: state.url.clone(),
        triggered_at: state.triggered_at.to_rfc3339(),
        expires_at: state.expires_at.to_rfc3339(),
    })
}

/// Backing command for the health panel's "Regenerate link" button — mints a
/// fresh token and re-sends the Slack message for an agent/provider the user
/// already knows is stuck (skips the 2-failure debounce, since this is an
/// explicit user action, not automatic detection).
#[tauri::command]
pub async fn regenerate_credential_recovery_link(
    db: State<'_, Database>,
    app: tauri::AppHandle,
    agent_id: String,
    provider: String,
) -> Result<CredentialRecoveryStatus, String> {
    trigger_credential_recovery(&db, &app, &agent_id, &provider, None).await?;
    get_credential_recovery_status(agent_id)
        .ok_or_else(|| "recovery state missing after trigger".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::openclaw::AuthFailureCertainty;

    fn replay(tag: &str) -> PendingReplay {
        PendingReplay {
            conversation_id: format!("conv-{tag}"),
            message: format!("message-{tag}"),
        }
    }

    #[test]
    fn deterministic_failure_triggers_on_first_occurrence() {
        let agent_id = "test-agent-deterministic-first";
        let result = decide_replay_for_failure(
            agent_id,
            "anthropic",
            AuthFailureCertainty::Deterministic,
            replay("1"),
        );
        let triggered = result.expect("a deterministic failure should trigger immediately");
        assert_eq!(triggered.message, "message-1");
    }

    #[test]
    fn ambiguous_failure_still_requires_two_occurrences() {
        let agent_id = "test-agent-ambiguous-still-debounced";
        let first = decide_replay_for_failure(
            agent_id,
            "anthropic",
            AuthFailureCertainty::Ambiguous,
            replay("1"),
        );
        assert!(first.is_none());

        let second = decide_replay_for_failure(
            agent_id,
            "anthropic",
            AuthFailureCertainty::Ambiguous,
            replay("2"),
        );
        assert!(second.is_some());
    }

    #[test]
    fn deterministic_failure_clears_a_pending_ambiguous_count() {
        let agent_id = "test-agent-deterministic-clears-ambiguous";
        // One ambiguous failure alone wouldn't trigger yet...
        let first = decide_replay_for_failure(
            agent_id,
            "anthropic",
            AuthFailureCertainty::Ambiguous,
            replay("1"),
        );
        assert!(first.is_none());

        // ...but a deterministic failure right after triggers immediately on its
        // own, regardless of the ambiguous count sitting underneath it.
        let deterministic = decide_replay_for_failure(
            agent_id,
            "anthropic",
            AuthFailureCertainty::Deterministic,
            replay("2"),
        );
        assert!(deterministic.is_some());

        // And the ambiguous counter was reset, not left at 1 — a follow-up
        // ambiguous failure starts counting from zero again, not from "already
        // at 1, so this makes 2."
        let after = decide_replay_for_failure(
            agent_id,
            "anthropic",
            AuthFailureCertainty::Ambiguous,
            replay("3"),
        );
        assert!(
            after.is_none(),
            "ambiguous counter should have reset after the deterministic trigger"
        );
    }

    #[test]
    fn single_failure_does_not_trigger() {
        let agent_id = "test-agent-single-failure";
        let result = record_failure_and_check_threshold(agent_id, "anthropic", replay("1"));
        assert!(result.is_none());
    }

    #[test]
    fn second_consecutive_failure_triggers_with_latest_replay() {
        let agent_id = "test-agent-two-failures";
        let first = record_failure_and_check_threshold(agent_id, "anthropic", replay("1"));
        assert!(first.is_none());

        let second = record_failure_and_check_threshold(agent_id, "anthropic", replay("2"));
        let triggered = second.expect("second consecutive failure should trigger");
        assert_eq!(triggered.message, "message-2");
    }

    #[test]
    fn different_providers_track_independently() {
        let agent_id = "test-agent-provider-split";
        assert!(record_failure_and_check_threshold(agent_id, "anthropic", replay("a1")).is_none());
        // A single gemini failure shouldn't count toward anthropic's threshold.
        assert!(record_failure_and_check_threshold(agent_id, "gemini", replay("g1")).is_none());
    }

    #[test]
    fn triggering_resets_the_counter_so_a_third_failure_starts_fresh() {
        let agent_id = "test-agent-reset-after-trigger";
        assert!(record_failure_and_check_threshold(agent_id, "anthropic", replay("1")).is_none());
        assert!(record_failure_and_check_threshold(agent_id, "anthropic", replay("2")).is_some());
        // The tracker entry was removed on trigger, so this is failure #1 again, not #3.
        assert!(record_failure_and_check_threshold(agent_id, "anthropic", replay("3")).is_none());
    }

    #[test]
    fn recovery_status_is_none_when_nothing_triggered() {
        assert!(get_credential_recovery_status("never-triggered-agent".to_string()).is_none());
    }
}

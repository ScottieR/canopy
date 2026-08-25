use crate::app_state::AppState;
use crate::db::Database;
use crate::errors::{CanopyError, Result as CanopyResult};
use crate::models::FeedbackReport;
use crate::validators;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

const FEEDBACK_SLACK_WEBHOOK_SECRET: &str = "canopy_feedback_slack_webhook";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmissionInput {
    pub kind: String,
    pub title: String,
    pub description: String,
    pub agent_id: Option<String>,
    pub current_view: Option<String>,
    pub include_diagnostics: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackNotificationSettings {
    pub slack_configured: bool,
}

fn normalize_feedback_kind(kind: &str) -> CanopyResult<String> {
    match kind.trim() {
        "bug" | "feature_request" | "ux_pain" | "other" => Ok(kind.trim().to_string()),
        _ => Err(CanopyError::Validation(
            "Feedback kind must be bug, feature_request, ux_pain, or other".into(),
        )),
    }
}

fn validate_feedback_submission(submission: &FeedbackSubmissionInput) -> CanopyResult<()> {
    normalize_feedback_kind(&submission.kind)?;

    let title = submission.title.trim();
    if title.is_empty() {
        return Err(CanopyError::Validation(
            "Feedback title cannot be empty".into(),
        ));
    }
    if title.len() > 160 {
        return Err(CanopyError::Validation(
            "Feedback title must be 160 characters or fewer".into(),
        ));
    }

    let description = submission.description.trim();
    if description.is_empty() {
        return Err(CanopyError::Validation(
            "Feedback description cannot be empty".into(),
        ));
    }
    if description.len() > 10_000 {
        return Err(CanopyError::Validation(
            "Feedback description must be 10000 characters or fewer".into(),
        ));
    }

    if let Some(agent_id) = submission.agent_id.as_deref() {
        crate::validators::agent::validate_id(agent_id)?;
    }

    Ok(())
}

async fn sync_feedback_report_to_admin(report: &FeedbackReport) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(format!("{}/api/feedback", crate::admin_api_base_url()))
        .json(&json!({ "feedback": report }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "admin feedback sync returned {}",
            response.status()
        ))
    }
}

/// Posts `text` to the Slack incoming webhook stored under `secret_name`, if one is
/// configured. Returns `Ok(false)` (not an error) when nothing is configured, so
/// callers can treat "no webhook set up" the same as "notification skipped" rather
/// than a failure. Shared by feedback relay and agent_health's credential-recovery
/// fallback notification — see `agent_health::send_recovery_slack_message`.
pub async fn post_text_to_slack_webhook(secret_name: &str, text: &str) -> Result<bool, String> {
    let webhook = match crate::keychain::get_secret(secret_name) {
        Ok(value) if !value.trim().is_empty() => value,
        Ok(_) => return Ok(false),
        Err(crate::errors::CanopyError::NotFound(_)) => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(webhook)
        .json(&json!({ "text": text }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if response.status().is_success() {
        Ok(true)
    } else {
        Err(format!("slack webhook returned {}", response.status()))
    }
}

async fn notify_feedback_to_slack(report: &FeedbackReport) -> Result<bool, String> {
    let reporter = if report.reporter_email.trim().is_empty() {
        report.reporter_name.clone()
    } else {
        format!("{} <{}>", report.reporter_name, report.reporter_email)
    };

    let agent_line = report
        .agent_id
        .as_ref()
        .map(|agent_id| format!("\nAgent: `{}`", agent_id))
        .unwrap_or_default();

    let text = format!(
        "*New Canopy feedback received*\nType: `{}`\nTitle: {}\nReporter: {}{}\n\n{}",
        report.kind, report.title, reporter, agent_line, report.description
    );

    post_text_to_slack_webhook(FEEDBACK_SLACK_WEBHOOK_SECRET, &text).await
}

#[tauri::command]
pub fn get_feedback_notification_settings() -> CanopyResult<FeedbackNotificationSettings> {
    let slack_configured = crate::keychain::get_secret(FEEDBACK_SLACK_WEBHOOK_SECRET)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    Ok(FeedbackNotificationSettings { slack_configured })
}

#[tauri::command]
pub fn configure_feedback_slack_notifications(webhook_url: Option<String>) -> CanopyResult<()> {
    match webhook_url {
        Some(value) if !value.trim().is_empty() => {
            validators::integrations::validate_webhook_url(value.trim())?;
            crate::keychain::store_secret(FEEDBACK_SLACK_WEBHOOK_SECRET, value.trim())?;
        }
        _ => {
            crate::keychain::delete_secret_internal(FEEDBACK_SLACK_WEBHOOK_SECRET)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn list_feedback_reports(db: State<'_, Database>) -> CanopyResult<Vec<FeedbackReport>> {
    db.list_feedback_reports()
        .map_err(|e| CanopyError::Database(e.to_string()))
}

#[tauri::command]
pub fn mark_feedback_report_dispatched(
    db: State<'_, Database>,
    state: State<'_, AppState>,
    report_id: String,
    agent_id: String,
) -> CanopyResult<()> {
    crate::validators::agent::validate_id(&agent_id)?;

    let report = db
        .get_feedback_report(&report_id)
        .map_err(|e| CanopyError::Database(e.to_string()))?
        .ok_or_else(|| CanopyError::NotFound("Feedback report not found".into()))?;

    if !db.is_agent_owner(&agent_id, &state.user_id)? {
        return Err(CanopyError::Unauthorized(
            "You don't have permission to dispatch feedback to this agent".into(),
        ));
    }

    if report.status == "sent_to_engineer" {
        return Ok(());
    }

    db.mark_feedback_report_dispatched(&report_id, &agent_id)
        .map_err(|e| CanopyError::Database(e.to_string()))
}

#[tauri::command]
pub async fn submit_feedback_report(
    db: State<'_, Database>,
    state: State<'_, AppState>,
    submission: FeedbackSubmissionInput,
) -> CanopyResult<FeedbackReport> {
    validate_feedback_submission(&submission)?;

    if let Some(agent_id) = submission.agent_id.as_deref() {
        if !db.is_agent_owner(agent_id, &state.user_id)? {
            return Err(CanopyError::Unauthorized(
                "You don't have permission to submit feedback for this agent".into(),
            ));
        }
    }

    let profile = db.get_user_profile().unwrap_or_default();
    let agent_snapshot = if submission.include_diagnostics {
        if let Some(agent_id) = submission.agent_id.as_deref() {
            db.get_agent(agent_id)
                .map_err(|e| CanopyError::Database(e.to_string()))?
                .map(|agent| {
                    json!({
                        "id": agent.id,
                        "name": agent.name,
                        "role": agent.role,
                        "status": agent.status,
                        "isolated": agent.isolated,
                        "paused": agent.paused,
                        "integrations": agent.integrations,
                        "activeModel": agent.personality.active_model,
                    })
                })
        } else {
            None
        }
    } else {
        None
    };

    let now = chrono::Utc::now().to_rfc3339();
    let report = FeedbackReport {
        id: uuid::Uuid::new_v4().to_string(),
        kind: normalize_feedback_kind(&submission.kind)?,
        status: "new".to_string(),
        title: submission.title.trim().to_string(),
        description: submission.description.trim().to_string(),
        agent_id: submission.agent_id.clone(),
        reporter_name: profile.name.clone(),
        reporter_email: profile.email.clone(),
        created_at: now.clone(),
        updated_at: now,
        context: json!({
            "currentView": submission.current_view,
            "includeDiagnostics": submission.include_diagnostics,
            "platform": std::env::consts::OS,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "timezone": profile.timezone.clone(),
            "userId": state.user_id.clone(),
            "agentSnapshot": agent_snapshot,
        }),
        remote_status: "pending".to_string(),
        remote_error: None,
        slack_notified: false,
        dispatched_agent_id: None,
        dispatched_at: None,
    };

    db.insert_feedback_report(&report)
        .map_err(|e| CanopyError::Database(e.to_string()))?;

    let (remote_result, slack_result) = tokio::join!(
        sync_feedback_report_to_admin(&report),
        notify_feedback_to_slack(&report)
    );

    let remote_status = if remote_result.is_ok() {
        "sent"
    } else {
        "failed"
    };
    let remote_error = remote_result.err();
    let slack_notified = slack_result.unwrap_or(false);

    db.update_feedback_report_delivery(
        &report.id,
        remote_status,
        remote_error.as_deref(),
        slack_notified,
    )
    .map_err(|e| CanopyError::Database(e.to_string()))?;

    db.get_feedback_report(&report.id)
        .map_err(|e| CanopyError::Database(e.to_string()))?
        .ok_or_else(|| CanopyError::Internal("Feedback report disappeared after insert".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_kind_validation_accepts_known_values() {
        assert_eq!(normalize_feedback_kind("bug").unwrap(), "bug");
        assert_eq!(
            normalize_feedback_kind("feature_request").unwrap(),
            "feature_request"
        );
        assert_eq!(normalize_feedback_kind("ux_pain").unwrap(), "ux_pain");
        assert_eq!(normalize_feedback_kind("other").unwrap(), "other");
    }

    #[test]
    fn feedback_kind_validation_rejects_unknown_values() {
        assert!(normalize_feedback_kind("feature").is_err());
        assert!(normalize_feedback_kind("incident").is_err());
    }
}

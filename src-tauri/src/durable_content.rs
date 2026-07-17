use crate::db::Database;
use serde_json::Value;
use tauri::State;

fn validate_content_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 200 {
        return Err(format!("{} must be between 1 and 200 characters", label));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(format!("{} contains unsupported characters", label));
    }
    Ok(())
}

/// Produce the catalog record kept in WebKit localStorage. All potentially
/// unbounded bodies remain exclusively in SQLite until the forum is activated.
fn forum_summary(forum: &Value) -> Result<Value, String> {
    let mut summary = forum
        .as_object()
        .cloned()
        .ok_or_else(|| "Forum state must be a JSON object".to_string())?;
    let derived_agent_message_count = summary
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter(|message| message.get("sender").and_then(Value::as_str) == Some("agent"))
                .count() as u64
        })
        .unwrap_or(0);
    let derived_artifact_count = summary
        .get("artifacts")
        .and_then(Value::as_array)
        .map(|artifacts| artifacts.len() as u64)
        .unwrap_or(0);
    let agent_message_count = if derived_agent_message_count == 0 {
        summary
            .get("agentMessageCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    } else {
        derived_agent_message_count
    };
    let artifact_count = if derived_artifact_count == 0 {
        summary
            .get("artifactCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    } else {
        derived_artifact_count
    };
    summary.insert("agentMessageCount".into(), Value::from(agent_message_count));
    summary.insert("artifactCount".into(), Value::from(artifact_count));
    summary.insert("messages".into(), Value::Array(vec![]));
    summary.insert("artifacts".into(), Value::Array(vec![]));
    summary.insert("blackboardContent".into(), Value::String(String::new()));
    summary.insert("blackboardHistory".into(), Value::Array(vec![]));
    summary.insert("blackboardBlock".into(), Value::Null);
    summary.insert("scratchpadContent".into(), Value::String(String::new()));
    summary.insert("contentLoaded".into(), Value::Bool(false));
    Ok(Value::Object(summary))
}

#[tauri::command]
pub fn save_forum_state(
    db: State<'_, Database>,
    forum_id: String,
    forum: Value,
    if_absent: Option<bool>,
) -> Result<(), String> {
    validate_content_id(&forum_id, "Forum ID")?;
    if forum.get("id").and_then(Value::as_str) != Some(forum_id.as_str()) {
        return Err("Forum ID does not match the forum payload".into());
    }
    let summary = forum_summary(&forum)?;
    let summary_json = serde_json::to_string(&summary).map_err(|e| e.to_string())?;
    let content_json = serde_json::to_string(&forum).map_err(|e| e.to_string())?;
    db.upsert_forum_state(
        &forum_id,
        &summary_json,
        &content_json,
        if_absent.unwrap_or(false),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_forum_state(db: State<'_, Database>, forum_id: String) -> Result<Option<Value>, String> {
    validate_content_id(&forum_id, "Forum ID")?;
    db.get_forum_state_json(&forum_id)
        .map_err(|e| e.to_string())?
        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        .transpose()
}

#[tauri::command]
pub fn list_forum_summaries(db: State<'_, Database>) -> Result<Vec<Value>, String> {
    db.list_forum_summary_jsons()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        .collect()
}

#[tauri::command]
pub fn delete_forum_state(db: State<'_, Database>, forum_id: String) -> Result<(), String> {
    validate_content_id(&forum_id, "Forum ID")?;
    db.delete_forum_state(&forum_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_agent_mini_apps(
    db: State<'_, Database>,
    agent_id: String,
    mini_apps: Value,
    if_absent: Option<bool>,
) -> Result<(), String> {
    validate_content_id(&agent_id, "Agent ID")?;
    if !mini_apps.is_array() {
        return Err("Mini-app state must be a JSON array".into());
    }
    let content_json = serde_json::to_string(&mini_apps).map_err(|e| e.to_string())?;
    db.upsert_agent_mini_apps(&agent_id, &content_json, if_absent.unwrap_or(false))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_agent_mini_apps(
    db: State<'_, Database>,
    agent_id: String,
) -> Result<Option<Value>, String> {
    validate_content_id(&agent_id, "Agent ID")?;
    db.get_agent_mini_apps_json(&agent_id)
        .map_err(|e| e.to_string())?
        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        .transpose()
}

#[tauri::command]
pub fn delete_agent_mini_apps(db: State<'_, Database>, agent_id: String) -> Result<(), String> {
    validate_content_id(&agent_id, "Agent ID")?;
    db.delete_agent_mini_apps(&agent_id)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn forum_catalog_excludes_unbounded_content_without_mutating_source() {
        let source = json!({
            "id": "forum_1",
            "title": "A forum",
            "messages": [{"sender": "agent", "text": "important"}],
            "artifacts": [{"content": "full artifact"}],
            "blackboardContent": "full board",
            "blackboardHistory": [{"content": "old"}],
            "blackboardBlock": {"type": "html", "content": "<main />"},
            "scratchpadContent": "notes"
        });
        let summary = forum_summary(&source).unwrap();

        assert_eq!(summary["messages"], json!([]));
        assert_eq!(summary["artifacts"], json!([]));
        assert_eq!(summary["blackboardContent"], "");
        assert_eq!(summary["contentLoaded"], false);
        assert_eq!(summary["agentMessageCount"], 1);
        assert_eq!(summary["artifactCount"], 1);
        assert_eq!(source["messages"][0]["text"], "important");
    }

    #[test]
    fn content_ids_reject_command_or_path_syntax() {
        assert!(validate_content_id("forum_safe-1", "Forum ID").is_ok());
        assert!(validate_content_id("../../forum", "Forum ID").is_err());
        assert!(validate_content_id("forum;drop", "Forum ID").is_err());
    }
}

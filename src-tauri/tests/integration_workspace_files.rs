// Integration tests for workspace file operations: upload → read base64 → validation
mod common;

use canopy_lib::models::{Agent, AgentCapabilities, AgentPersonality, AgentStats, AgentStatus};
use canopy_lib::openclaw::{read_workspace_file_base64, upload_workspace_file};
use tauri::Manager;

#[tokio::test]
async fn test_workspace_file_upload_and_read_base64() {
    let ctx = common::TestContext::new();
    std::env::set_var("CANOPY_DATA_DIR", ctx.temp_dir.path());

    let app = tauri::test::mock_app();
    // Initialize temporary database in the mock app
    let db = canopy_lib::db::Database::init_in_memory().unwrap();
    app.manage(db);

    let db_state = app.state::<canopy_lib::db::Database>();

    // Insert a dummy agent to avoid missing agent errors
    let random_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let agent_id = format!("test-file-agent-{}", random_suffix);
    let agent = Agent {
        id: agent_id.clone(),
        name: "Test File Agent".to_string(),
        role: "assistant".to_string(),
        emoji: "🤖".to_string(),
        color: "#123456".to_string(),
        status: AgentStatus::Active,
        isolated: false,
        paused: false,
        container_id: None,
        personality: AgentPersonality {
            name: "Test File Agent".to_string(),
            communication_style: "helpful".to_string(),
            expertise: vec![],
            guardrails: vec![],
            custom_instructions: "".to_string(),
            active_model: None,
            soul_template: None,
            identity_template: None,
        },
        capabilities: AgentCapabilities::default(),
        integrations: vec![],
        visual_identity: None,
        memories: vec![],
        created_at: chrono::Utc::now(),
        stats: AgentStats::default(),
    };
    db_state.insert_agent(&agent).unwrap();

    // Test 1: Upload a standard image file using standard base64 encoding (e.g. data URL format)
    let filename = "test_image.png".to_string();
    let base64_image_data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".to_string();

    let upload_result = upload_workspace_file(
        db_state.clone(),
        agent_id.clone(),
        filename.clone(),
        base64_image_data.clone(),
    )
    .await;
    assert!(
        upload_result.is_ok(),
        "Failed to upload workspace file: {:?}",
        upload_result
    );

    // Test 2: Read workspace file back as base64 and verify MIME type and content matches
    let read_result =
        read_workspace_file_base64(db_state.clone(), agent_id.clone(), filename.clone()).await;
    assert!(
        read_result.is_ok(),
        "Failed to read workspace file: {:?}",
        read_result
    );

    let returned_data_url = read_result.unwrap();
    assert!(
        returned_data_url.starts_with("data:image/png;base64,"),
        "MIME type mismatch: {}",
        returned_data_url
    );
    assert!(
        returned_data_url.contains("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"),
        "Data content mismatch"
    );

    // Test 3: Path traversal rejection in upload
    let invalid_filename = "../malicious.txt".to_string();
    let upload_traversal = upload_workspace_file(
        db_state.clone(),
        agent_id.clone(),
        invalid_filename.clone(),
        "data:text/plain;base64,dGVzdA==".to_string(),
    )
    .await;
    assert!(
        upload_traversal.is_err(),
        "Path traversal in upload was not rejected"
    );
    assert_eq!(upload_traversal.unwrap_err(), "Invalid filename");

    // Test 4: Path traversal rejection in read
    let read_traversal =
        read_workspace_file_base64(db_state.clone(), agent_id.clone(), invalid_filename).await;
    assert!(
        read_traversal.is_err(),
        "Path traversal in read was not rejected"
    );
    assert_eq!(read_traversal.unwrap_err(), "Invalid filename");

    // Test 5: Non-existent file returns empty string
    let non_existent_result = read_workspace_file_base64(
        db_state.clone(),
        agent_id.clone(),
        "does_not_exist.png".to_string(),
    )
    .await;
    assert!(non_existent_result.is_ok());
    assert_eq!(non_existent_result.unwrap(), "");
}

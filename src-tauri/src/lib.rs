#![allow(unused)]

mod model_constants; // Single source of truth for model strings, ports, and path helpers
mod docker;
mod openclaw;
mod keychain;
mod bridge;
mod payment;
mod models;
mod db;
mod imessage;
mod audit;
mod audit_openclaw;
mod voice;
mod slack;
mod google;
mod channels;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            // Initialize SQLite database
            match db::Database::init(&handle) {
                Ok(database) => {
                    tracing::info!("SQLite database initialized");
                    handle.manage(database);
                }
                Err(e) => {
                    tracing::error!("Failed to initialize database: {}", e);
                    return Err(Box::new(e));
                }
            }

            // Initialize voice session manager
            handle.manage(voice::VoiceSessionManager::new());

            // Initialize OrbStack/Docker connection on startup
            let handle_clone = handle.clone();
            tauri::async_runtime::spawn(async move {
                match docker::DockerManager::init().await {
                    Ok(manager) => {
                        tracing::info!("Docker connection established via OrbStack");
                        handle_clone.manage(manager);
                    }
                    Err(e) => {
                        tracing::warn!("Docker not available: {}. Will prompt for OrbStack install.", e);
                    }
                }
            });
            
            // Sync pricing asynchronously from Admin Oracle
            tauri::async_runtime::spawn(async move {
                tracing::info!("Attempting to fetch remote LLM pricing sync...");
                if let Ok(resp) = reqwest::get("http://localhost:3001/api/pricing").await {
                    if let Ok(pricing_json) = resp.json::<std::collections::HashMap<String, serde_json::Value>>().await {
                        let mut registry = models::PRICING_REGISTRY.write().unwrap();
                        for (model_name, costs) in pricing_json {
                            let cost_in = costs.get("in").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let cost_out = costs.get("out").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            registry.insert(model_name, (cost_in, cost_out));
                        }
                        tracing::info!("Synced dynamic LLM pricing rules into registry.");
                    }
                } else {
                    tracing::warn!("Failed to fetch pricing from admin oracle, retaining local fallbacks.");
                }
            });

            Ok(())
        })
        // Agent management commands
        .invoke_handler(tauri::generate_handler![
            // Docker / OrbStack
            docker::check_orbstack_installed,
            docker::install_orbstack,
            docker::get_container_status,
            docker::start_gateway,
            docker::stop_gateway,
            docker::hard_reset_infrastructure,
            // OpenClaw agent CRUD
            openclaw::create_agent,
            openclaw::list_agents,
            openclaw::get_agent,
            openclaw::update_agent_personality,
            openclaw::update_agent_visuals,
            openclaw::update_agent_capabilities,
            openclaw::update_agent_integrations,
            openclaw::update_agent_memories,
            openclaw::update_agent_details,
            openclaw::toggle_agent_isolation,
            openclaw::delete_agent,
            openclaw::send_message,
            openclaw::get_conversation_history,
            openclaw::get_agent_health,
            openclaw::check_agent_status,
            openclaw::import_agent,
            openclaw::scan_local_agents,
            openclaw::import_discovered_agent,
            openclaw::repair_gateway,
            openclaw::sync_credentials,
            openclaw::update_agent_model,
            openclaw::approve_slack_pairing,
            openclaw::get_user_profile,
            openclaw::save_user_profile,
            openclaw::get_global_audit_log,
            // Integrations / Bridges
            bridge::list_bridges,
            bridge::enable_bridge,
            bridge::disable_bridge,
            bridge::get_bridge_config,
            bridge::update_bridge_config,
            bridge::get_bridge_status,
            bridge::list_available_bridge_types,
            // iMessage bridge
            imessage::check_full_disk_access,
            imessage::list_imessage_threads,
            imessage::read_imessage_messages,
            imessage::get_allowed_imessage_threads,
            imessage::update_allowed_imessage_threads,
            imessage::start_imessage_watcher,
            imessage::stop_imessage_watcher,
            // Keychain
            keychain::store_secret_cmd,
            keychain::store_batch_secrets_cmd,
            keychain::get_secret_cmd,
            keychain::delete_secret_cmd,
            keychain::auto_discover_keys_cmd,
            // Payment gateway (deterministic)
            payment::evaluate_purchase,
            payment::get_agent_budget,
            payment::update_agent_budget,
            payment::get_purchase_history,
            payment::issue_virtual_card,
            // Slack integration
            slack::start_slack_oauth,
            slack::check_slack_connection,
            slack::list_slack_channels,
            slack::read_slack_messages,
            slack::send_slack_message,
            slack::get_allowed_slack_channels,
            slack::update_allowed_slack_channels,
            slack::start_slack_listener,
            slack::stop_slack_listener,
            // Google
            google::start_google_oauth,
            // Messaging / productivity channels
            channels::configure_telegram,
            channels::configure_whatsapp,
            channels::configure_discord,
            channels::configure_github,
            // Voice mode
            voice::get_voice_config,
            voice::update_voice_config,
            voice::send_voice_message,
            voice::start_voice_session,
            voice::end_voice_session,
            voice::get_voice_data_dir,
            voice::cleanup_voice_cache,
            voice::transcribe_audio,
            voice::synthesize_speech,
            // Audit logging
            audit::get_audit_log,
            audit::get_audit_summary,
            audit::search_audit_log,
            audit::export_audit_log,
            audit::get_security_alerts,
            // OpenClaw Audit
            audit_openclaw::audit_openclaw_config,
            audit_openclaw::repair_openclaw_config,
            audit_openclaw::get_openclaw_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Canopy")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                use tauri::Manager;
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}

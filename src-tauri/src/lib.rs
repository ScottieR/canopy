#![allow(unused)]

// Central error type for consistent error handling across all modules
pub mod errors;

// Centralized input validation framework
pub mod validators;

// Application state for user context and authorization
pub mod app_state;

// Rate limiting for expensive operations
pub mod rate_limiter;

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
mod jit_server;
mod browser_manager;
mod security_scanner;
mod activity_sniffer;
mod health_monitor;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    // Seed MODEL_REGISTRY with the hardcoded validated fallback list before any async work.
    // The async oracle fetch below will overwrite this once the admin server responds.
    model_constants::init_model_registry();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            // Initialize AppState with user context
            let app_state = app_state::AppState::new();
            tracing::info!("AppState initialized for user: {}", app_state.user_id);
            handle.manage(app_state);

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

            // Initialize Machine Browser manager
            handle.manage(browser_manager::BrowserManager::new());

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
            
            // Start JIT Server for Agent Authorization
            let jit_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                jit_server::start_jit_server(jit_handle).await;
            });
            
            // Start Activity Sniffer Daemon
            activity_sniffer::start_sniffer_daemon(handle.clone());
            
            // Start Health Monitor Daemon
            health_monitor::start_health_monitor_daemon(handle.clone());
            
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

            // Sync model list asynchronously from Admin Oracle.
            // The registry starts with the hardcoded validated fallback list (seeded above);
            // this overwrites it once the oracle responds. Validation inside
            // `update_model_registry` drops any phantom / malformed names before storing.
            tauri::async_runtime::spawn(async move {
                tracing::info!("Attempting to fetch model list from admin oracle...");
                match reqwest::get("http://localhost:3001/api/models").await {
                    Ok(resp) => {
                        match resp.json::<serde_json::Value>().await {
                            Ok(body) => {
                                // Admin oracle returns { "models": [ { id, name, provider, strategy, description, costIn, costOut } ] }
                                if let Some(arr) = body.get("models").and_then(|v| v.as_array()) {
                                    let fetched: Vec<model_constants::ModelInfo> = arr
                                        .iter()
                                        .filter_map(|m| {
                                            Some(model_constants::ModelInfo {
                                                id: m.get("id")?.as_str()?.to_string(),
                                                name: m.get("name")?.as_str()?.to_string(),
                                                provider: m.get("provider")?.as_str()?.to_string(),
                                                strategy: m.get("strategy").and_then(|v| v.as_str()).unwrap_or("heavy").to_string(),
                                                description: m.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                            })
                                        })
                                        .collect();
                                    model_constants::update_model_registry(fetched);
                                } else {
                                    tracing::warn!("Admin oracle /api/models missing 'models' array — keeping fallback list");
                                }
                            }
                            Err(e) => {
                                tracing::warn!("Failed to parse model list from admin oracle: {} — keeping fallback list", e);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to reach admin oracle for model list: {} — keeping fallback list", e);
                    }
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
            openclaw::run_agent_command,
            openclaw::update_agent_personality,
            openclaw::update_agent_visuals,
            openclaw::update_agent_capabilities,
            openclaw::update_agent_integrations,
            openclaw::update_agent_memories,
            openclaw::update_agent_details,
            openclaw::toggle_agent_isolation,
            openclaw::set_agent_paused,
            openclaw::delete_agent,
            openclaw::send_message,
            openclaw::get_conversation_history,
            openclaw::get_agent_health,
            openclaw::check_agent_status,
            openclaw::get_gateway_log_tail,
            openclaw::import_agent,
            openclaw::scan_local_agents,
            openclaw::import_discovered_agent,
            openclaw::repair_gateway,
            openclaw::sync_credentials,
            openclaw::sync_agent_api_keys,
            openclaw::sync_global_api_key,
            openclaw::update_agent_model,
            openclaw::approve_slack_pairing,
            openclaw::get_user_profile,
            openclaw::save_user_profile,
            openclaw::get_global_audit_log,
            openclaw::get_agent_activity_heatmap,
            openclaw::ping_agent_routing,
            openclaw::get_agent_browser_history,
            openclaw::preflight_cleanup,
            openclaw::boot_sync_agents,
            openclaw::sync_gateway_channels,
            openclaw::get_available_models,
            openclaw::get_connectors_config,
            openclaw::get_openclaw_status_json,
            openclaw::read_workspace_file,
            openclaw::write_workspace_file,
            openclaw::upload_workspace_file,
            openclaw::copy_file_to_workspace,
            openclaw::set_preferences_template,
            // Machine Browser
            browser_manager::start_machine_browser,
            browser_manager::stop_machine_browser,
            browser_manager::get_browser_status,
            browser_manager::ping_agent_browser,
            browser_manager::reset_machine_browsers,
            browser_manager::show_browser,
            browser_manager::hide_browser,
            browser_manager::get_agent_allowed_domains,
            browser_manager::update_agent_allowed_domains,
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
            imessage::open_full_disk_access_settings,
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
            keychain::get_web_credentials_cmd,
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
            slack::disconnect_slack_for_agent,
            slack::disconnect_slack_global,
            // Google
            google::start_google_oauth,
            // Messaging / productivity channels
            channels::configure_telegram,
            channels::configure_whatsapp,
            channels::configure_discord,
            channels::configure_github,
            channels::fetch_github_repos,
            channels::configure_twilio,
            channels::disconnect_telegram,
            channels::disconnect_telegram_for_agent,
            channels::disconnect_whatsapp,
            channels::disconnect_whatsapp_for_agent,
            channels::disconnect_discord,
            channels::disconnect_discord_for_agent,
            channels::disconnect_twilio,
            channels::disconnect_twilio_for_agent,
            channels::disconnect_github,
            channels::ping_agent_connections,
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
            // MCP Interceptor
            jit_server::approve_jit_request,
            jit_server::resolve_export_request,
            jit_server::request_user_attention,
            jit_server::resolve_permission_request,
            // Activity Sniffer
            activity_sniffer::get_network_security_alerts,
            activity_sniffer::resolve_network_security_alert,
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

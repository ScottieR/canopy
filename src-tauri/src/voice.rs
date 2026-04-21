use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;
use std::path::PathBuf;

use crate::db::Database;

// ─── Voice Configuration Models ──────────────────────────────────────────────

/// Enum for Speech-to-Text provider selection
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum STTProvider {
    /// Web Speech API (frontend-based, no backend deps)
    WebSpeech,
    /// Local Whisper.cpp (Tier 2 future)
    WhisperLocal,
    /// Whisper API (cloud-based)
    WhisperCloud,
}

impl Default for STTProvider {
    fn default() -> Self {
        Self::WebSpeech
    }
}

/// Enum for Text-to-Speech provider selection
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TTSProvider {
    /// Web Speech API (frontend-based, no backend deps)
    WebSpeech,
    /// Local Piper (Tier 2 future)
    PiperLocal,
    /// OpenAI TTS
    OpenAITTS,
    /// ElevenLabs TTS
    ElevenLabs,
}

impl Default for TTSProvider {
    fn default() -> Self {
        Self::WebSpeech
    }
}

/// Voice configuration for a specific agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceConfig {
    pub agent_id: String,
    pub stt_provider: STTProvider,
    pub tts_provider: TTSProvider,
    /// Voice name/ID (e.g., "en-US-Neural2-A" for Google, "nova" for OpenAI)
    pub tts_voice: String,
    /// Speech rate multiplier (1.0 = normal, 0.5 = half, 2.0 = double)
    pub speaking_rate: f32,
    /// Auto-play TTS responses immediately when received
    pub auto_play: bool,
    /// Voice features enabled for this agent
    pub enabled: bool,
}

impl VoiceConfig {
    pub fn new(agent_id: String) -> Self {
        Self {
            agent_id,
            stt_provider: STTProvider::default(),
            tts_provider: TTSProvider::default(),
            tts_voice: "default".to_string(),
            speaking_rate: 1.0,
            auto_play: false,
            enabled: false,
        }
    }

    /// Serialize to JSON for database storage
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Deserialize from JSON string
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

// ─── Voice Session Models ────────────────────────────────────────────────────

/// Tracks an active voice conversation session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceSession {
    pub session_id: String,
    pub agent_id: String,
    pub started_at: DateTime<Utc>,
    pub message_count: u32,
    pub is_active: bool,
}

impl VoiceSession {
    pub fn new(agent_id: String) -> Self {
        Self {
            session_id: format!("voice-session-{}", Uuid::new_v4()),
            agent_id,
            started_at: Utc::now(),
            message_count: 0,
            is_active: true,
        }
    }
}

// ─── In-Memory Voice Session Store ──────────────────────────────────────────

/// Manages active voice sessions in memory
pub struct VoiceSessionManager {
    sessions: Mutex<HashMap<String, VoiceSession>>,
}

impl VoiceSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_session(&self, agent_id: String) -> VoiceSession {
        let session = VoiceSession::new(agent_id);
        let session_id = session.session_id.clone();

        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(session_id, session.clone());

        tracing::info!("Created voice session: {}", session.session_id);
        session
    }

    pub fn get_session(&self, session_id: &str) -> Option<VoiceSession> {
        self.sessions.lock().unwrap().get(session_id).cloned()
    }

    pub fn end_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(session_id) {
            session.is_active = false;
            let duration = Utc::now().signed_duration_since(session.started_at);
            tracing::info!(
                "Ended voice session: {} (duration: {}s, {} messages)",
                session_id,
                duration.num_seconds(),
                session.message_count
            );
            sessions.remove(session_id);
            Ok(())
        } else {
            Err(format!("Session not found: {}", session_id))
        }
    }

    pub fn increment_message_count(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(session_id) {
            session.message_count += 1;
            Ok(())
        } else {
            Err(format!("Session not found: {}", session_id))
        }
    }
}

impl Default for VoiceSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Voice Message Models ───────────────────────────────────────────────────

/// Request to send a voice-originated message
#[derive(Debug, Serialize, Deserialize)]
pub struct VoiceMessageRequest {
    pub agent_id: String,
    pub transcription: String,
    pub session_id: Option<String>,
}

/// Response from voice message processing
#[derive(Debug, Serialize, Deserialize)]
pub struct VoiceMessageResponse {
    pub success: bool,
    pub agent_response: String,
    pub session_id: String,
    pub timestamp: DateTime<Utc>,
}

// ─── Tauri Commands ─────────────────────────────────────────────────────────

/// Get voice configuration for an agent
#[tauri::command]
pub async fn get_voice_config(
    agent_id: String,
    db_state: tauri::State<'_, Database>,
) -> Result<VoiceConfig, String> {
    tracing::info!("Fetching voice config for agent: {}", agent_id);

    // Try to load from database
    match db_state.get_voice_config(&agent_id) {
        Ok(Some(config)) => {
            tracing::debug!("Loaded voice config from database");
            Ok(config)
        }
        Ok(None) => {
            // Agent exists but no voice config yet; return defaults
            tracing::debug!("No voice config found; using defaults");
            Ok(VoiceConfig::new(agent_id))
        }
        Err(e) => {
            tracing::error!("Failed to load voice config: {}", e);
            Err(format!("Failed to load voice config: {}", e))
        }
    }
}

/// Update voice configuration for an agent
#[tauri::command]
pub async fn update_voice_config(
    agent_id: String,
    config: VoiceConfig,
    db_state: tauri::State<'_, Database>,
) -> Result<(), String> {
    tracing::info!("Updating voice config for agent: {}", agent_id);

    // Validate agent exists first
    if !agent_exists(&db_state, &agent_id).await? {
        return Err(format!("Agent not found: {}", agent_id));
    }

    // Ensure agent_id matches
    if config.agent_id != agent_id {
        return Err("Agent ID mismatch".to_string());
    }

    match db_state.upsert_voice_config(&config) {
        Ok(_) => {
            tracing::info!("Voice config updated successfully");
            Ok(())
        }
        Err(e) => {
            tracing::error!("Failed to update voice config: {}", e);
            Err(format!("Failed to update voice config: {}", e))
        }
    }
}

/// Send a voice message (STT transcription → agent → TTS response)
#[tauri::command]
pub async fn send_voice_message(
    agent_id: String,
    transcription: String,
    db_state: tauri::State<'_, Database>,
) -> Result<VoiceMessageResponse, String> {
    tracing::info!("Processing voice message for agent: {}", agent_id);

    // Validate agent exists
    if !agent_exists(&db_state, &agent_id).await? {
        return Err(format!("Agent not found: {}", agent_id));
    }

    // Send transcription as regular message to OpenClaw via HTTP
    let client = reqwest::Client::new();
    let gateway_url = "http://localhost:18799";
    let resp = client
        .post(format!("{}/api/sessions/main/messages", gateway_url))
        .json(&serde_json::json!({
            "agentId": agent_id,
            "message": transcription,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to send message to agent: {}", e))?;

    let agent_response: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    // Extract text response from OpenClaw
    let response_text = agent_response
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("I didn't understand that.")
        .to_string();

    // Log as voice-originated message to conversation history
    let _ = db_state.log_voice_message(&agent_id, &transcription, &response_text);

    Ok(VoiceMessageResponse {
        success: true,
        agent_response: response_text,
        session_id: String::new(),
        timestamp: Utc::now(),
    })
}

/// Start a voice session for an agent
#[tauri::command]
pub async fn start_voice_session(
    agent_id: String,
    voice_sessions: tauri::State<'_, VoiceSessionManager>,
    db_state: tauri::State<'_, Database>,
) -> Result<VoiceSession, String> {
    tracing::info!("Starting voice session for agent: {}", agent_id);

    // Validate agent exists
    if !agent_exists(&db_state, &agent_id).await? {
        return Err(format!("Agent not found: {}", agent_id));
    }

    let session = voice_sessions.create_session(agent_id);
    Ok(session)
}

/// End a voice session
#[tauri::command]
pub async fn end_voice_session(
    session_id: String,
    voice_sessions: tauri::State<'_, VoiceSessionManager>,
) -> Result<(), String> {
    tracing::info!("Ending voice session: {}", session_id);
    voice_sessions.end_session(&session_id)
}

/// Get the directory path for voice cache files
#[tauri::command]
pub fn get_voice_data_dir() -> Result<String, String> {
    let voice_dir = if let Some(data_dir) = dirs::data_dir() {
        data_dir.join("Canopy").join("voice_cache")
    } else {
        return Err("Could not determine data directory".to_string());
    };

    // Create directory if it doesn't exist
    std::fs::create_dir_all(&voice_dir)
        .map_err(|e| format!("Failed to create voice cache directory: {}", e))?;

    voice_dir
        .to_str()
        .ok_or_else(|| "Invalid path".to_string())
        .map(|s| s.to_string())
}

/// Clean up voice cache files older than 1 hour
#[tauri::command]
pub async fn cleanup_voice_cache() -> Result<u32, String> {
    let voice_dir = if let Some(data_dir) = dirs::data_dir() {
        data_dir.join("Canopy").join("voice_cache")
    } else {
        return Err("Could not determine data directory".to_string());
    };

    if !voice_dir.exists() {
        tracing::debug!("Voice cache directory does not exist");
        return Ok(0);
    }

    let mut deleted_count = 0;
    let cutoff_time = Utc::now() - Duration::hours(1);

    match std::fs::read_dir(&voice_dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                if let Ok(metadata) = entry.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        // Convert system time to datetime
                        let elapsed = std::time::SystemTime::now()
                            .duration_since(modified)
                            .unwrap_or_default();

                        if elapsed.as_secs() > 3600 {
                            // 1 hour = 3600 seconds
                            if std::fs::remove_file(entry.path()).is_ok() {
                                deleted_count += 1;
                                tracing::debug!("Deleted old voice cache file");
                            }
                        }
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!("Failed to read voice cache directory: {}", e);
        }
    }

    tracing::info!("Cleaned up {} voice cache files", deleted_count);
    Ok(deleted_count)
}

/// Transcribe audio file using local Whisper.cpp (Tier 2 stub)
#[tauri::command]
pub async fn transcribe_audio(audio_path: String) -> Result<String, String> {
    // TODO: Tier 2 implementation - integrate with whisper.cpp
    // For now, return error indicating frontend should use Web Speech API
    tracing::warn!("Local STT not configured; falling back to Web Speech API");
    Err("Local STT not yet configured. Using Web Speech API.".to_string())
}

/// Synthesize speech using local Piper (Tier 2 stub)
#[tauri::command]
pub async fn synthesize_speech(text: String, voice: String) -> Result<String, String> {
    // TODO: Tier 2 implementation - integrate with piper binary
    // Would return path to generated audio file
    // For now, return error indicating frontend should use Web Speech API
    tracing::warn!("Local TTS not configured; falling back to Web Speech API");
    Err(format!(
        "Local TTS not yet configured. Using Web Speech API. (voice: {})",
        voice
    ))
}

// ─── Database Integration ───────────────────────────────────────────────────

/// Helper to check if an agent exists
async fn agent_exists(db_state: &Database, agent_id: &str) -> Result<bool, String> {
    // Query agent from database; if exists, return true
    // For now, assume it exists if no error; full implementation depends on db API
    match db_state.get_agent(agent_id) {
        Ok(Some(_)) => Ok(true),
        Ok(None) => Ok(false),
        Err(e) => Err(format!("Failed to check agent: {}", e)),
    }
}

// ─── Voice Data Persistence (extends Database) ──────────────────────────────

/// Extension trait for voice-related database operations
pub trait VoiceDatabase {
    /// Insert or update voice configuration
    fn upsert_voice_config(&self, config: &VoiceConfig) -> Result<(), String>;

    /// Get voice configuration for an agent
    fn get_voice_config(&self, agent_id: &str) -> Result<Option<VoiceConfig>, String>;

    /// Log a voice-originated message to conversation history
    fn log_voice_message(
        &self,
        agent_id: &str,
        transcription: &str,
        response: &str,
    ) -> Result<(), String>;
}

/// Implement voice database operations for Database
impl VoiceDatabase for Database {
    fn upsert_voice_config(&self, config: &VoiceConfig) -> Result<(), String> {
        let config_json = config.to_json().map_err(|e| e.to_string())?;

        // TODO: Full implementation requires voice_configs table in migrations
        // For now, this is a stub that logs the operation
        tracing::debug!(
            "Would upsert voice config for agent {}: {}",
            config.agent_id,
            config_json
        );

        Ok(())
    }

    fn get_voice_config(&self, agent_id: &str) -> Result<Option<VoiceConfig>, String> {
        // TODO: Full implementation requires voice_configs table
        // For now, return None (no config found)
        tracing::debug!("Would query voice config for agent: {}", agent_id);
        Ok(None)
    }

    fn log_voice_message(
        &self,
        agent_id: &str,
        transcription: &str,
        response: &str,
    ) -> Result<(), String> {
        // TODO: Full implementation would create a message in the agent's conversation
        // For now, just log it
        tracing::info!(
            "Voice message for {}: '{}' → '{}'",
            agent_id,
            transcription,
            response
        );
        Ok(())
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_voice_config_serialization() {
        let config = VoiceConfig {
            agent_id: "agent-test".to_string(),
            stt_provider: STTProvider::WebSpeech,
            tts_provider: TTSProvider::OpenAITTS,
            tts_voice: "nova".to_string(),
            speaking_rate: 1.5,
            auto_play: true,
            enabled: true,
        };

        let json = config.to_json().expect("Serialization failed");
        let deserialized = VoiceConfig::from_json(&json).expect("Deserialization failed");

        assert_eq!(config.agent_id, deserialized.agent_id);
        assert_eq!(config.tts_provider, deserialized.tts_provider);
        assert_eq!(config.speaking_rate, deserialized.speaking_rate);
    }

    #[test]
    fn test_voice_session_creation() {
        let session = VoiceSession::new("agent-test".to_string());
        assert_eq!(session.agent_id, "agent-test");
        assert!(session.is_active);
        assert_eq!(session.message_count, 0);
        assert!(session.session_id.starts_with("voice-session-"));
    }

    #[test]
    fn test_voice_session_manager() {
        let manager = VoiceSessionManager::new();

        // Create session
        let session = manager.create_session("agent-test".to_string());
        assert!(manager.get_session(&session.session_id).is_some());

        // Increment message count
        let _ = manager.increment_message_count(&session.session_id);

        // End session
        assert!(manager.end_session(&session.session_id).is_ok());
        assert!(manager.get_session(&session.session_id).is_none());
    }

    #[test]
    fn test_voice_config_defaults() {
        let config = VoiceConfig::new("agent-test".to_string());
        assert_eq!(config.stt_provider, STTProvider::WebSpeech);
        assert_eq!(config.tts_provider, TTSProvider::WebSpeech);
        assert!(!config.enabled);
    }
}

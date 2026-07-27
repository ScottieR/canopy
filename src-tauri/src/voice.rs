use chrono::{DateTime, Duration, Utc};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use uuid::Uuid;
use base64::Engine as _;

use crate::db::Database;
use crate::keychain::get_secret;

// ─── Voice Configuration Models ──────────────────────────────────────────────

/// Enum for Speech-to-Text provider selection
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum STTProvider {
    /// Legacy browser speech-recognition path.
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
    /// Legacy browser speech-synthesis path.
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
        Self::OpenAITTS
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
            tts_voice: "alloy".to_string(),
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

fn validate_voice_message_input(agent_id: &str, transcription: &str) -> Result<(), String> {
    crate::validators::agent::validate_id(agent_id).map_err(|error| error.to_string())?;
    if transcription.trim().is_empty() || transcription.len() > 64 * 1024 {
        return Err("Voice transcription must be between 1 byte and 64 KiB".into());
    }
    Ok(())
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
    validate_voice_message_input(&agent_id, &transcription)?;
    tracing::info!("Processing voice message for agent: {}", agent_id);

    // ── RATE LIMITING ──
    crate::rate_limiter::limiters::VOICE_TRANSCRIBE_LIMITER
        .check("local-user")
        .map_err(|e| e.to_string())?;

    // Validate agent exists
    if !agent_exists(&db_state, &agent_id).await? {
        return Err(format!("Agent not found: {}", agent_id));
    }

    // Send transcription as regular message to OpenClaw via HTTP
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Failed to initialize local runtime connection".to_string())?;
    let gateway_url = crate::model_constants::GATEWAY_URL;
    let resp = client
        .post(format!("{}/api/sessions/main/messages", gateway_url))
        .header(
            "Authorization",
            crate::model_constants::gateway_bearer_header(),
        )
        .json(&serde_json::json!({
            "agentId": agent_id,
            "message": transcription,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to send message to agent: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Local runtime returned HTTP {}", resp.status()));
    }
    if resp
        .content_length()
        .is_some_and(|length| length > 1024 * 1024)
    {
        return Err("Local runtime response exceeded the safe size limit".into());
    }
    let mut response_bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Could not read local runtime response".to_string())?;
        if response_bytes.len().saturating_add(chunk.len()) > 1024 * 1024 {
            return Err("Local runtime response exceeded the safe size limit".into());
        }
        response_bytes.extend_from_slice(&chunk);
    }
    let agent_response: serde_json::Value = serde_json::from_slice(&response_bytes)
        .map_err(|_| "Local runtime returned an invalid response".to_string())?;

    // Extract text response from OpenClaw
    let response_text = agent_response
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("I didn't understand that.")
        .to_string();

    // Log as voice-originated message to conversation history
    // TODO: log to database if desired.
    tracing::info!(
        "Voice message completed for {} (input_bytes={}, output_bytes={})",
        agent_id,
        transcription.len(),
        response_text.len()
    );

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

/// Transcribe audio file using a managed cloud transcription provider.
#[tauri::command]
pub async fn transcribe_audio(audio_path: String) -> Result<String, String> {
    crate::rate_limiter::limiters::VOICE_TRANSCRIBE_LIMITER
        .check("local-user")
        .map_err(|e| e.to_string())?;

    let path = PathBuf::from(audio_path.trim());
    if !path.exists() || !path.is_file() {
        return Err("Audio file not found".into());
    }

    let api_key = get_agent_or_global_secret(None, "openai_key", "OPENAI_API_KEY")
        .ok_or_else(|| "Speech transcription is unavailable because no OpenAI API key is configured".to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Failed to initialize transcription client".to_string())?;

    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.wav")
        .to_string();
    let mime = mime_guess::from_path(&path)
        .first_raw()
        .unwrap_or("audio/wav")
        .to_string();
    let audio_bytes = fs::read(&path).map_err(|e| format!("Failed to read audio file: {}", e))?;
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(filename)
        .mime_str(&mime)
        .map_err(|e| format!("Invalid audio MIME type: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .text("model", "gpt-4o-mini-transcribe")
        .part("file", part);

    let response = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Transcription request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = body.chars().take(240).collect::<String>();
        return Err(format!("Transcription failed with HTTP {}: {}", status, detail));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to decode transcription response: {}", e))?;
    payload
        .get("text")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Transcription response did not contain text".to_string())
}

/// Synthesize speech using local Piper (Tier 2 stub)
#[tauri::command]
pub async fn synthesize_speech(text: String, voice: String) -> Result<String, String> {
    synthesize_with_openai(text, &voice, 1.0, None).await
}

#[tauri::command]
pub async fn synthesize_agent_speech(
    agent_id: String,
    text: String,
    db_state: tauri::State<'_, Database>,
) -> Result<String, String> {
    crate::rate_limiter::limiters::VOICE_TRANSCRIBE_LIMITER
        .check("local-user")
        .map_err(|e| e.to_string())?;

    if !agent_exists(&db_state, &agent_id).await? {
        return Err(format!("Agent not found: {}", agent_id));
    }

    let agent = match db_state.get_agent(&agent_id) {
        Ok(Some(agent)) => agent,
        Ok(None) => return Err(format!("Agent not found: {}", agent_id)),
        Err(err) => return Err(format!("Failed to load agent: {}", err)),
    };

    let config = match db_state.get_voice_config(&agent_id) {
        Ok(Some(cfg)) => cfg,
        Ok(None) => VoiceConfig::new(agent_id.clone()),
        Err(err) => return Err(format!("Failed to load voice config: {}", err)),
    };

    let clean = text.trim();
    if clean.is_empty() {
        return Err("Speech text cannot be empty".into());
    }

    let mut failures: Vec<String> = Vec::new();
    let explicit_elevenlabs_voice =
        config.tts_provider == TTSProvider::ElevenLabs
            && resolve_elevenlabs_voice_id(&config.tts_voice).is_some();

    if explicit_elevenlabs_voice {
        if let Ok(path) = synthesize_with_elevenlabs(
            clean.to_string(),
            &config.tts_voice,
            config.speaking_rate,
            Some(&agent_id),
        )
        .await
        {
            return Ok(path);
        }
        failures.push(format!(
            "ElevenLabs custom voice '{}' was unavailable",
            config.tts_voice
        ));
    }

    let active_provider = native_tts_provider_for_model(agent.personality.active_model.as_deref());
    for provider in native_tts_fallback_order(active_provider) {
        match synthesize_with_native_provider(
            provider,
            clean.to_string(),
            &config.tts_voice,
            config.speaking_rate,
            Some(&agent_id),
        )
        .await
        {
            Ok(path) => return Ok(path),
            Err(err) => failures.push(format!("{}: {}", native_tts_provider_label(provider), err)),
        }
    }

    Err(format!(
        "No managed TTS provider succeeded for agent {}. {}",
        agent_id,
        failures.join(" | ")
    ))
}

const OPENAI_TTS_ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";
const GEMINI_TTS_ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const XAI_TTS_ENDPOINT: &str = "https://api.x.ai/v1/tts";
const ELEVENLABS_TTS_ENDPOINT: &str = "https://api.elevenlabs.io/v1/text-to-speech";
const OPENAI_TTS_MODEL: &str = "gpt-4o-mini-tts";
const GEMINI_TTS_MODEL: &str = "gemini-3.1-flash-tts-preview";
const ELEVENLABS_TTS_MODEL: &str = "eleven_multilingual_v2";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeTtsProvider {
    OpenAI,
    Gemini,
    XAI,
    Anthropic,
}

fn voice_cache_dir() -> Result<PathBuf, String> {
    let voice_dir = if let Some(data_dir) = dirs::data_dir() {
        data_dir.join("Canopy").join("voice_cache")
    } else {
        return Err("Could not determine data directory".to_string());
    };
    fs::create_dir_all(&voice_dir)
        .map_err(|e| format!("Failed to create voice cache directory: {}", e))?;
    Ok(voice_dir)
}

fn write_voice_cache_file(prefix: &str, ext: &str, bytes: &[u8]) -> Result<String, String> {
    let voice_dir = voice_cache_dir()?;
    let path = voice_dir.join(format!("{}-{}.{}", prefix, Uuid::new_v4(), ext));
    fs::write(&path, bytes).map_err(|e| format!("Failed to write voice audio: {}", e))?;
    path.to_str()
        .ok_or_else(|| "Invalid audio path".to_string())
        .map(|s| s.to_string())
}

fn get_agent_or_global_secret(agent_id: Option<&str>, suffix: &str, global_key: &str) -> Option<String> {
    if let Some(agent) = agent_id {
        let agent_key = format!("agent_{}_{}", agent, suffix);
        if let Ok(value) = get_secret(&agent_key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    if let Ok(value) = get_secret(global_key) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    std::env::var(global_key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn sanitize_voice_rate(rate: f32, min: f32, max: f32, default: f32) -> f32 {
    if !rate.is_finite() {
        return default;
    }
    rate.clamp(min, max)
}

fn native_tts_provider_for_model(model: Option<&str>) -> Option<NativeTtsProvider> {
    let provider = model?.split_once('/')?.0.to_ascii_lowercase();
    match provider.as_str() {
        "openai" => Some(NativeTtsProvider::OpenAI),
        "google" | "gemini" => Some(NativeTtsProvider::Gemini),
        "xai" | "grok" => Some(NativeTtsProvider::XAI),
        "anthropic" | "claude" => Some(NativeTtsProvider::Anthropic),
        _ => None,
    }
}

fn native_tts_fallback_order(primary: Option<NativeTtsProvider>) -> Vec<NativeTtsProvider> {
    let mut order = match primary {
        Some(NativeTtsProvider::OpenAI) => vec![NativeTtsProvider::OpenAI, NativeTtsProvider::Gemini, NativeTtsProvider::XAI],
        Some(NativeTtsProvider::Gemini) => vec![NativeTtsProvider::Gemini, NativeTtsProvider::OpenAI, NativeTtsProvider::XAI],
        Some(NativeTtsProvider::XAI) => vec![NativeTtsProvider::XAI, NativeTtsProvider::OpenAI, NativeTtsProvider::Gemini],
        Some(NativeTtsProvider::Anthropic) | None => vec![NativeTtsProvider::OpenAI, NativeTtsProvider::Gemini, NativeTtsProvider::XAI],
    };
    order.dedup();
    order
}

fn native_tts_provider_label(provider: NativeTtsProvider) -> &'static str {
    match provider {
        NativeTtsProvider::OpenAI => "OpenAI",
        NativeTtsProvider::Gemini => "Google Gemini",
        NativeTtsProvider::XAI => "xAI",
        NativeTtsProvider::Anthropic => "Anthropic",
    }
}

async fn synthesize_with_native_provider(
    provider: NativeTtsProvider,
    text: String,
    voice: &str,
    speaking_rate: f32,
    agent_id: Option<&str>,
) -> Result<String, String> {
    match provider {
        NativeTtsProvider::OpenAI => synthesize_with_openai(text, voice, speaking_rate, agent_id).await,
        NativeTtsProvider::Gemini => synthesize_with_gemini(text, voice, speaking_rate, agent_id).await,
        NativeTtsProvider::XAI => synthesize_with_xai(text, voice, speaking_rate, agent_id).await,
        NativeTtsProvider::Anthropic => Err("Anthropic does not expose a native TTS API for this path".into()),
    }
}

fn resolve_openai_voice(voice: &str) -> &str {
    match voice {
        "alloy" | "echo" | "fable" | "nova" | "onyx" | "shimmer" => voice,
        "ash" | "ballad" | "coral" | "sage" | "verse" | "marin" | "cedar" => voice,
        _ => "alloy",
    }
}

fn openai_voice_instructions(voice: &str) -> &'static str {
    match voice {
        "echo" => "Speak with crisp, direct, quietly technical confidence. Keep the delivery focused and grounded.",
        "fable" => "Speak with warm editorial precision. Sound articulate, thoughtful, and a little expressive without becoming theatrical.",
        "nova" => "Speak with bright curiosity and clarity. Sound sharp, energetic, and confident without rushing.",
        "onyx" => "Speak with grounded authority. Sound strategic, calm, and assured.",
        "shimmer" => "Speak with polished reassurance. Sound precise, attentive, and composed.",
        _ => "Speak in a steady, welcoming, easy-to-trust tone.",
    }
}

fn is_builtin_canopy_voice(voice: &str) -> bool {
    matches!(voice, "alloy" | "echo" | "fable" | "nova" | "onyx" | "shimmer")
}

fn resolve_gemini_voice(voice: &str) -> &str {
    match voice {
        "echo" => "Enceladus",
        "fable" => "Puck",
        "nova" => "Puck",
        "onyx" => "Kore",
        "shimmer" => "Enceladus",
        "alloy" => "Kore",
        _ => "Kore",
    }
}

fn resolve_xai_voice_id(voice: &str) -> &str {
    match voice {
        "echo" => "rex",
        "fable" => "ara",
        "nova" => "eve",
        "onyx" => "leo",
        "shimmer" => "sal",
        "alloy" => "eve",
        _ => "eve",
    }
}

fn resolve_elevenlabs_voice_id(voice: &str) -> Option<String> {
    if !is_builtin_canopy_voice(voice) {
        let trimmed = voice.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

async fn synthesize_with_openai(
    text: String,
    voice: &str,
    speaking_rate: f32,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let api_key = get_agent_or_global_secret(agent_id, "openai_key", "OPENAI_API_KEY")
        .ok_or_else(|| "OpenAI TTS is unavailable because no OpenAI API key is configured".to_string())?;

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Failed to initialize OpenAI TTS client".to_string())?;

    let response = client
        .post(OPENAI_TTS_ENDPOINT)
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "model": OPENAI_TTS_MODEL,
            "input": text,
            "voice": resolve_openai_voice(voice),
            "instructions": openai_voice_instructions(voice),
            "response_format": "mp3",
            "speed": sanitize_voice_rate(speaking_rate, 0.5, 1.5, 1.0),
        }))
        .send()
        .await
        .map_err(|e| format!("OpenAI TTS request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = body.chars().take(240).collect::<String>();
        return Err(format!("OpenAI TTS failed with HTTP {}: {}", status, detail));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read OpenAI TTS audio: {}", e))?;
    write_voice_cache_file("openai-tts", "mp3", &bytes)
}

fn wrap_pcm_as_wav(pcm: &[u8], sample_rate: u32, channels: u16, bits_per_sample: u16) -> Vec<u8> {
    let byte_rate = sample_rate * channels as u32 * bits_per_sample as u32 / 8;
    let block_align = channels * bits_per_sample / 8;
    let data_len = pcm.len() as u32;
    let riff_len = 36 + data_len;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_len.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

async fn synthesize_with_gemini(
    text: String,
    voice: &str,
    _speaking_rate: f32,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let api_key = get_agent_or_global_secret(agent_id, "gemini_key", "GEMINI_API_KEY")
        .ok_or_else(|| "Gemini TTS is unavailable because no Gemini API key is configured".to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Failed to initialize Gemini TTS client".to_string())?;

    let styled_input = format!("{}\n\n{}", openai_voice_instructions(voice), text);

    let response = client
        .post(GEMINI_TTS_ENDPOINT)
        .header("x-goog-api-key", api_key)
        .json(&serde_json::json!({
            "model": GEMINI_TTS_MODEL,
            "input": styled_input,
            "response_format": { "type": "audio" },
            "generation_config": {
                "speech_config": [
                    { "voice": resolve_gemini_voice(voice) }
                ]
            }
        }))
        .send()
        .await
        .map_err(|e| format!("Gemini TTS request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = body.chars().take(240).collect::<String>();
        return Err(format!("Gemini TTS failed with HTTP {}: {}", status, detail));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to decode Gemini TTS response: {}", e))?;
    let audio_b64 = payload
        .get("output_audio")
        .and_then(|value| value.get("data"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Gemini TTS response did not contain output_audio.data".to_string())?;
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(audio_b64)
        .map_err(|e| format!("Failed to decode Gemini audio: {}", e))?;
    let wav = wrap_pcm_as_wav(&pcm, 24_000, 1, 16);
    write_voice_cache_file("gemini-tts", "wav", &wav)
}

async fn synthesize_with_xai(
    text: String,
    voice: &str,
    speaking_rate: f32,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let api_key = get_agent_or_global_secret(agent_id, "grok_key", "XAI_API_KEY")
        .or_else(|| get_agent_or_global_secret(agent_id, "grok_key", "GROK_API_KEY"))
        .ok_or_else(|| "xAI TTS is unavailable because no xAI API key is configured".to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Failed to initialize xAI TTS client".to_string())?;

    let response = client
        .post(XAI_TTS_ENDPOINT)
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "text": text,
            "voice_id": resolve_xai_voice_id(voice),
            "language": "en",
            "speed": sanitize_voice_rate(speaking_rate, 0.75, 1.25, 1.0),
        }))
        .send()
        .await
        .map_err(|e| format!("xAI TTS request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = body.chars().take(240).collect::<String>();
        return Err(format!("xAI TTS failed with HTTP {}: {}", status, detail));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read xAI TTS audio: {}", e))?;
    write_voice_cache_file("xai-tts", "mp3", &bytes)
}

async fn synthesize_with_elevenlabs(
    text: String,
    voice: &str,
    speaking_rate: f32,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let voice_id = resolve_elevenlabs_voice_id(voice)
        .ok_or_else(|| format!("No ElevenLabs voice ID configured for '{}'", voice))?;
    let api_key = get_agent_or_global_secret(agent_id, "elevenlabs_key", "ELEVENLABS_API_KEY")
        .ok_or_else(|| "ElevenLabs TTS is unavailable because no ElevenLabs API key is configured".to_string())?;

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Failed to initialize ElevenLabs TTS client".to_string())?;

    let response = client
        .post(format!(
            "{}/{}?output_format=mp3_44100_128",
            ELEVENLABS_TTS_ENDPOINT, voice_id
        ))
        .header("xi-api-key", api_key)
        .json(&serde_json::json!({
            "text": text,
            "model_id": ELEVENLABS_TTS_MODEL,
            "voice_settings": {
                "speed": sanitize_voice_rate(speaking_rate, 0.7, 1.2, 1.0),
                "stability": 0.45,
                "similarity_boost": 0.8,
                "style": 0.2,
                "use_speaker_boost": true
            }
        }))
        .send()
        .await
        .map_err(|e| format!("ElevenLabs TTS request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = body.chars().take(240).collect::<String>();
        return Err(format!("ElevenLabs TTS failed with HTTP {}: {}", status, detail));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read ElevenLabs TTS audio: {}", e))?;
    write_voice_cache_file("elevenlabs-tts", "mp3", &bytes)
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
        assert_eq!(config.tts_provider, TTSProvider::OpenAITTS);
        assert_eq!(config.tts_voice, "alloy");
        assert!(!config.enabled);
    }

    #[test]
    fn openai_voice_resolution_uses_supported_defaults() {
        assert_eq!(resolve_openai_voice("nova"), "nova");
        assert_eq!(resolve_openai_voice("custom"), "alloy");
        assert!(resolve_elevenlabs_voice_id("alloy").is_none());
        assert_eq!(
            resolve_elevenlabs_voice_id("voice_123abc").as_deref(),
            Some("voice_123abc")
        );
    }

    #[test]
    fn voice_messages_reject_invalid_agent_ids_and_unbounded_transcripts() {
        assert!(validate_voice_message_input("agent-test", "hello").is_ok());
        assert!(validate_voice_message_input("agent; touch /tmp/pwned", "hello").is_err());
        assert!(validate_voice_message_input("agent-test", "  ").is_err());
        assert!(validate_voice_message_input("agent-test", &"x".repeat(64 * 1024 + 1)).is_err());
    }
}

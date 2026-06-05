// live_voice.rs — bidirectional realtime voice bridge.
//
// Opens a WebSocket from the Tauri host to OpenClaw's "realtime brain" endpoint
// (added in OpenClaw v2026.4.24, backed by Gemini Live). Forwards inbound PCM
// audio from the frontend's mic to the model, and emits outbound audio +
// status events back to the frontend so the playback worklet can render them.
//
// Wire format (Gemini Live via OpenClaw's adapter):
//   - First message: JSON setup payload identifying the agent + session.
//   - Subsequent client → server: binary frames of LINEAR16 PCM @ 16kHz mono.
//   - Server → client: binary frames of LINEAR16 PCM @ 24kHz mono +
//     interleaved JSON status frames (turn_start, turn_complete, error).
//
// Failure surface:
//   - If OpenClaw is too old (no /v1/realtime route), the WS handshake fails
//     with a 404. We catch it and surface a structured error the frontend can
//     translate to a user-facing "OpenClaw needs updating" message.
//   - Network drops just close the channel; the frontend can restart.

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::model_constants::{GATEWAY_HOST_PORT, GATEWAY_INTERNAL_TOKEN};

// ─── State ────────────────────────────────────────────────────────────────

/// One live voice session — bidirectional WS + a channel to push outbound
/// audio frames to the Tauri-side writer task.
struct LiveVoiceSession {
    session_id: String,
    /// agent_id this session is bound to. Live audio for a different agent
    /// must open its own session — we don't multiplex agents on one WS.
    agent_id: String,
    /// Sender used by send_live_voice_audio to push PCM into the WS writer.
    /// Dropping it closes the writer, which closes the WS.
    audio_tx: mpsc::UnboundedSender<OutboundFrame>,
}

/// Frame the audio-writer task sends to the WS. We unify audio + control
/// frames in one channel so ordering is preserved.
enum OutboundFrame {
    /// LINEAR16 PCM @ 16kHz mono, base64-encoded (decoded before send).
    AudioPcm16(Vec<u8>),
    /// Signal that the user finished speaking — Gemini Live uses this to
    /// know it can finalize VAD and start responding.
    EndOfTurn,
    /// Clean shutdown — closes the WS gracefully.
    Close,
}

/// Map of session_id → active session. Owned by Tauri-managed state.
#[derive(Default)]
pub struct LiveVoiceState {
    sessions: Arc<Mutex<HashMap<String, LiveVoiceSession>>>,
}

// ─── Frontend payloads ────────────────────────────────────────────────────

/// What we return when a session starts. The frontend keys subsequent
/// send/end calls by `session_id`.
#[derive(Serialize)]
pub struct LiveVoiceStartResponse {
    pub session_id: String,
}

/// Tauri events emitted back to the frontend. We use a single event name
/// (`canopy://live-voice/event`) with a discriminated payload so the frontend
/// can listen once and dispatch internally — cheaper than many event names.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
enum LiveVoiceEvent {
    /// Inbound audio chunk from the model. PCM16 @ 24kHz mono, base64.
    #[serde(rename = "audio")]
    Audio {
        session_id: String,
        pcm_base64: String,
    },
    /// Model started speaking (start of a turn).
    #[serde(rename = "turn_start")]
    TurnStart { session_id: String },
    /// Model finished speaking.
    #[serde(rename = "turn_complete")]
    TurnComplete { session_id: String },
    /// Model emitted an interim transcript snippet (best-effort).
    #[serde(rename = "transcript")]
    Transcript {
        session_id: String,
        role: String, // "user" | "agent"
        text: String,
        is_final: bool,
    },
    /// Session closed cleanly.
    #[serde(rename = "closed")]
    Closed { session_id: String, reason: String },
    /// Recoverable error — frontend can retry / surface a toast.
    #[serde(rename = "error")]
    Error {
        session_id: String,
        code: String, // e.g. "OPENCLAW_TOO_OLD", "AUTH_FAILED", "NETWORK"
        message: String,
    },
}

// ─── Commands ─────────────────────────────────────────────────────────────

/// Start a new live voice session for an agent. Opens a WS to OpenClaw's
/// realtime brain endpoint and spawns the reader/writer tasks. Returns the
/// session_id the frontend will use for subsequent send/end calls.
#[tauri::command]
pub async fn start_live_voice_session(
    app: AppHandle,
    state: State<'_, LiveVoiceState>,
    agent_id: String,
    forum_id: Option<String>,
) -> Result<LiveVoiceStartResponse, String> {
    // Forum sessions are still 1:1 audio channels; the id only adds model context.
    crate::validators::agent::validate_id(&agent_id).map_err(|e| e.to_string())?;

    let session_id = format!(
        "lv_{}_{}",
        chrono::Utc::now().timestamp_millis(),
        nanoid_like(8)
    );

    // OpenClaw v2026.4.24+ exposes the realtime brain over WS at this path.
    // The host port is 18799 (mapped to container 18789). We bear-token-auth
    // with the same internal token the rest of the gateway uses.
    let ws_url = format!(
        "ws://localhost:{}/v1/realtime?agent={}",
        GATEWAY_HOST_PORT,
        urlencoding::encode(&agent_id)
    );

    // Build the connect request. tokio-tungstenite auto-fills the handshake
    // headers (Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version,
    // Host); we only need to add our custom Authorization + protocol header.
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("Failed to build WS request: {}", e))?;
    let headers = request.headers_mut();
    headers.insert(
        "Authorization",
        format!("Bearer {}", GATEWAY_INTERNAL_TOKEN)
            .parse()
            .map_err(|e| format!("Bad auth header: {}", e))?,
    );
    headers.insert(
        "Sec-WebSocket-Protocol",
        "openclaw.realtime.v1"
            .parse()
            .map_err(|e| format!("Bad protocol header: {}", e))?,
    );

    let (ws_stream, response) = match connect_async(request).await {
        Ok(pair) => pair,
        Err(e) => {
            // The most actionable error is "endpoint doesn't exist" — that
            // means OpenClaw is too old. We detect it via the HTTP status if
            // available, otherwise fall back to a generic error.
            let msg = e.to_string();
            let code = if msg.contains("404") || msg.contains("Not Found") {
                "OPENCLAW_TOO_OLD"
            } else if msg.contains("401") || msg.contains("403") {
                "AUTH_FAILED"
            } else {
                "NETWORK"
            };
            return Err(format!("{}: {}", code, msg));
        }
    };
    tracing::info!(
        "live_voice: connected agent={} status={}",
        agent_id,
        response.status()
    );

    let (mut ws_sink, mut ws_stream) = ws_stream.split();

    // Send the setup payload first — this is what OpenClaw uses to identify
    // the agent + bind the Gemini Live session. Format follows the documented
    // Live API "setup" message shape but routed through OpenClaw's adapter.
    let setup_payload = serde_json::json!({
        "setup": {
            "agent_id": agent_id,
            "forum_id": forum_id,
            "audio_format": {
                "input_sample_rate": 16000,
                "output_sample_rate": 24000,
                "encoding": "LINEAR16",
                "channels": 1,
            },
            "interim_transcripts": true,  // we want incremental captions for the UI
        }
    });
    if let Err(e) = ws_sink.send(Message::Text(setup_payload.to_string())).await {
        return Err(format!("NETWORK: failed to send setup: {}", e));
    }

    // Channels: frontend → writer task → WS sink.
    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<OutboundFrame>();

    // Writer task: drains the channel, encodes frames, forwards to WS.
    let writer_session_id = session_id.clone();
    tokio::spawn(async move {
        while let Some(frame) = audio_rx.recv().await {
            match frame {
                OutboundFrame::AudioPcm16(bytes) => {
                    if let Err(e) = ws_sink.send(Message::Binary(bytes)).await {
                        tracing::warn!(
                            "live_voice [{}]: write failed: {} — closing",
                            writer_session_id,
                            e
                        );
                        break;
                    }
                }
                OutboundFrame::EndOfTurn => {
                    let payload = serde_json::json!({ "client_event": "end_of_turn" });
                    let _ = ws_sink.send(Message::Text(payload.to_string())).await;
                }
                OutboundFrame::Close => {
                    let _ = ws_sink.close().await;
                    break;
                }
            }
        }
    });

    // Reader task: pulls frames from WS, emits Tauri events keyed by session.
    let reader_session_id = session_id.clone();
    let app_for_reader = app.clone();
    let sessions_for_reader = state.sessions.clone();
    tokio::spawn(async move {
        let emit = |evt: LiveVoiceEvent| {
            let _ = app_for_reader.emit("canopy://live-voice/event", &evt);
        };

        while let Some(msg_res) = ws_stream.next().await {
            let msg = match msg_res {
                Ok(m) => m,
                Err(e) => {
                    emit(LiveVoiceEvent::Error {
                        session_id: reader_session_id.clone(),
                        code: "NETWORK".into(),
                        message: format!("read failed: {}", e),
                    });
                    break;
                }
            };
            match msg {
                Message::Binary(bytes) => {
                    // Inbound audio frame. Base64-encode for the event so we
                    // don't have to deal with binary in Tauri's IPC.
                    let pcm_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    emit(LiveVoiceEvent::Audio {
                        session_id: reader_session_id.clone(),
                        pcm_base64,
                    });
                }
                Message::Text(txt) => {
                    // Control frame. Parse and re-emit as a typed Tauri event.
                    match serde_json::from_str::<serde_json::Value>(&txt) {
                        Ok(json) => {
                            let kind = json.get("event").and_then(|v| v.as_str()).unwrap_or("");
                            match kind {
                                "turn_start" => emit(LiveVoiceEvent::TurnStart {
                                    session_id: reader_session_id.clone(),
                                }),
                                "turn_complete" => emit(LiveVoiceEvent::TurnComplete {
                                    session_id: reader_session_id.clone(),
                                }),
                                "transcript" => {
                                    let role = json
                                        .get("role")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("agent")
                                        .to_string();
                                    let text = json
                                        .get("text")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let is_final = json
                                        .get("is_final")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);
                                    emit(LiveVoiceEvent::Transcript {
                                        session_id: reader_session_id.clone(),
                                        role,
                                        text,
                                        is_final,
                                    });
                                }
                                "error" => {
                                    let code = json
                                        .get("code")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("UNKNOWN")
                                        .to_string();
                                    let message = json
                                        .get("message")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    emit(LiveVoiceEvent::Error {
                                        session_id: reader_session_id.clone(),
                                        code,
                                        message,
                                    });
                                }
                                _ => {
                                    tracing::debug!(
                                        "live_voice [{}]: unknown control event: {}",
                                        reader_session_id,
                                        txt
                                    );
                                }
                            }
                        }
                        Err(_) => {
                            tracing::warn!(
                                "live_voice [{}]: non-JSON text frame: {}",
                                reader_session_id,
                                txt
                            );
                        }
                    }
                }
                Message::Close(frame) => {
                    let reason = frame
                        .map(|f| format!("{} ({})", f.reason, f.code))
                        .unwrap_or_else(|| "remote closed".into());
                    emit(LiveVoiceEvent::Closed {
                        session_id: reader_session_id.clone(),
                        reason,
                    });
                    break;
                }
                _ => {}
            }
        }

        // Reader exited — clean the session from state so its sender drops
        // and the writer task can finish.
        let mut sessions = sessions_for_reader.lock().await;
        sessions.remove(&reader_session_id);
        tracing::info!("live_voice [{}]: session cleaned up", reader_session_id);
    });

    // Register the live session for future audio sends + close.
    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            LiveVoiceSession {
                session_id: session_id.clone(),
                agent_id: agent_id.clone(),
                audio_tx,
            },
        );
    }

    Ok(LiveVoiceStartResponse { session_id })
}

/// Forward a chunk of PCM audio (LINEAR16 @ 16kHz mono, base64) from the
/// frontend's mic worklet to the open WS session.
#[tauri::command]
pub async fn send_live_voice_audio(
    state: State<'_, LiveVoiceState>,
    session_id: String,
    pcm_base64: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pcm_base64.as_bytes())
        .map_err(|e| format!("Invalid base64 PCM: {}", e))?;
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found (already closed?)".to_string())?;
    session
        .audio_tx
        .send(OutboundFrame::AudioPcm16(bytes))
        .map_err(|_| "Session writer dropped".to_string())?;
    Ok(())
}

/// Tell the model the user has finished speaking. Useful when the frontend
/// has its own VAD and wants to signal turn boundaries explicitly rather
/// than relying on server-side VAD.
#[tauri::command]
pub async fn end_live_voice_turn(
    state: State<'_, LiveVoiceState>,
    session_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    session
        .audio_tx
        .send(OutboundFrame::EndOfTurn)
        .map_err(|_| "Session writer dropped".to_string())?;
    Ok(())
}

/// Close a live voice session — sends a clean close frame and removes the
/// session from state.
#[tauri::command]
pub async fn end_live_voice_session(
    state: State<'_, LiveVoiceState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.remove(&session_id) {
        let _ = session.audio_tx.send(OutboundFrame::Close);
        tracing::info!(
            "live_voice [{}]: closed by client (agent={})",
            session.session_id,
            session.agent_id
        );
    }
    Ok(())
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/// Tiny nanoid-like generator — we want session IDs that are short, URL-safe,
/// and don't pull in a new dependency just for this.
fn nanoid_like(n: usize) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut s = String::with_capacity(n);
    let alphabet = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as usize)
        .unwrap_or(0);
    for _ in 0..n {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        s.push(alphabet[(seed >> 32) as usize % alphabet.len()] as char);
    }
    s
}

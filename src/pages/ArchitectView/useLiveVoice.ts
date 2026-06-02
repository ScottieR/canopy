// useLiveVoice — React hook that owns the live voice session lifecycle.
//
// Responsibilities:
//   1. Mic permission + getUserMedia
//   2. AudioWorklet setup (capture + playback)
//   3. Tauri command calls (start/send/end-turn/close)
//   4. Tauri event subscription for inbound audio + status/transcript
//   5. Barge-in: when the local mic shows energy while the agent is speaking,
//      flush playback so the user's input takes priority
//
// Consumers (LiveVoiceOverlay, ForumStage live button) get a small surface:
//   { state, transcript, agentSpeaking, userSpeaking, start, stop }
//
// Errors are pushed onto `state.error` rather than throwing — the overlay
// renders them with one-click actions like "Retry" or "Open OpenClaw docs".

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { registerLiveVoiceWorklets } from "./liveVoiceWorklets";

// ─── Types ────────────────────────────────────────────────────────────────

export type LiveVoiceStatus =
  | "idle"          // never started or fully closed
  | "connecting"    // mic + WS handshake in flight
  | "live"          // running normally
  | "closing"       // user asked to stop, cleanup in flight
  | "error";        // unrecoverable — see `error`

export type LiveVoiceErrorCode =
  | "MIC_DENIED"
  | "MIC_UNAVAILABLE"
  | "OPENCLAW_TOO_OLD"
  | "AUTH_FAILED"
  | "NETWORK"
  | "UNKNOWN";

export interface LiveVoiceError {
  code: LiveVoiceErrorCode;
  message: string;
}

export interface TranscriptLine {
  id: string;
  role: "user" | "agent";
  text: string;
  isFinal: boolean;
}

export interface UseLiveVoiceOpts {
  agentId: string;
  /** Optional forum ID — passed to OpenClaw so it can scope context. */
  forumId?: string;
  /** Called when the session ends for any reason. UI uses this to close the overlay. */
  onClose?: (reason: string) => void;
}

export interface UseLiveVoiceResult {
  status: LiveVoiceStatus;
  error: LiveVoiceError | null;
  /** True while the playback worklet is rendering non-silent samples. */
  agentSpeaking: boolean;
  /** True while local mic energy is above a low threshold. */
  userSpeaking: boolean;
  /** Append-only rolling list of transcript lines. Last item may be interim. */
  transcript: TranscriptLine[];
  /** Currently muted? Mic is still being captured for VAD, just not sent. */
  muted: boolean;
  setMuted: (m: boolean) => void;
  /** Start the session — must be called from a user gesture for mic permission. */
  start: () => Promise<void>;
  /** Stop the session cleanly. */
  stop: () => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Encode an Int16 PCM buffer to base64 — what the Rust command expects. */
function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  // btoa needs a binary string; build in chunks to avoid argument-length limits.
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}

/** Decode base64 PCM16 into a Float32 array (normalized to -1..1). */
function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, len / 2);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) {
    out[i] = i16[i] < 0 ? i16[i] / 0x8000 : i16[i] / 0x7fff;
  }
  return out;
}

// ─── The hook ─────────────────────────────────────────────────────────────

export function useLiveVoice({ agentId, forumId, onClose }: UseLiveVoiceOpts): UseLiveVoiceResult {
  const [status, setStatus] = useState<LiveVoiceStatus>("idle");
  const [error, setError] = useState<LiveVoiceError | null>(null);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [muted, setMuted] = useState(false);

  // Refs to long-lived audio infrastructure. Kept in refs (not state) so
  // restarting the session doesn't re-create them mid-render.
  const sessionIdRef = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | null>(null);
  const playbackNodeRef = useRef<AudioWorkletNode | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mutedRef = useRef(false);
  // VAD energy tracker — rolling RMS of recent mic frames for the userSpeaking flag.
  const recentEnergyRef = useRef(0);

  // Keep muted ref in sync — the worklet handler closes over it and we don't
  // want to rebind the message handler every time it flips.
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  // Centralized teardown so error paths and normal stop both go through the
  // same code. Idempotent — safe to call twice.
  const cleanup = useCallback(async (reason: string) => {
    setStatus("closing");
    const sid = sessionIdRef.current;
    sessionIdRef.current = null;

    if (unlistenRef.current) {
      try { unlistenRef.current(); } catch {}
      unlistenRef.current = null;
    }
    if (sid) {
      try { await invoke("end_live_voice_session", { sessionId: sid }); } catch {}
    }
    if (captureNodeRef.current) {
      try { captureNodeRef.current.disconnect(); } catch {}
      captureNodeRef.current = null;
    }
    if (playbackNodeRef.current) {
      try { playbackNodeRef.current.port.postMessage({ type: "flush" }); } catch {}
      try { playbackNodeRef.current.disconnect(); } catch {}
      playbackNodeRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { await audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    setStatus("idle");
    setAgentSpeaking(false);
    setUserSpeaking(false);
    onClose?.(reason);
  }, [onClose]);

  // ── Start ───────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (status === "live" || status === "connecting") return;
    setError(null);
    setTranscript([]);
    setStatus("connecting");

    // 1. Mic permission. Done first so the user sees the browser prompt
    //    BEFORE we open a WS to the server — easier to recover from refusal.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e: any) {
      const denied = String(e?.name || "").includes("NotAllowed");
      setError({
        code: denied ? "MIC_DENIED" : "MIC_UNAVAILABLE",
        message: denied
          ? "Microphone access was denied. Allow it in System Settings → Privacy → Microphone."
          : `Couldn't access the microphone: ${e?.message || e}`,
      });
      setStatus("error");
      return;
    }
    micStreamRef.current = stream;

    // 2. AudioContext + worklets.
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    try {
      await registerLiveVoiceWorklets(ctx);
    } catch (e) {
      setError({ code: "UNKNOWN", message: `Failed to load audio engine: ${e}` });
      setStatus("error");
      stream.getTracks().forEach(t => t.stop());
      await ctx.close();
      return;
    }

    // 3. Listen for inbound Tauri events BEFORE starting the session — the
    //    backend may emit early frames if the model warms up fast.
    const unlisten = await listen<any>("canopy://live-voice/event", (evt) => {
      const payload = evt.payload;
      if (!payload || typeof payload !== "object") return;
      const t = payload.type as string;
      if (t === "audio") {
        const f32 = base64ToFloat32(payload.pcm_base64);
        playbackNodeRef.current?.port.postMessage(
          { type: "push", samples: f32, sampleRate: 24000 },
          [f32.buffer],
        );
      } else if (t === "turn_start") {
        setAgentSpeaking(true);
      } else if (t === "turn_complete") {
        // Worklet's "silence" event will flip agentSpeaking back to false once
        // the ring buffer drains.
      } else if (t === "transcript") {
        setTranscript(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          // Coalesce consecutive same-role interim lines so we don't spam
          // the UI with one entry per token.
          if (last && last.role === payload.role && !last.isFinal) {
            next[next.length - 1] = { ...last, text: payload.text, isFinal: !!payload.is_final };
          } else {
            next.push({
              id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              role: payload.role,
              text: payload.text,
              isFinal: !!payload.is_final,
            });
          }
          return next;
        });
      } else if (t === "closed") {
        cleanup(payload.reason || "remote closed");
      } else if (t === "error") {
        const code = (payload.code as LiveVoiceErrorCode) || "UNKNOWN";
        setError({ code, message: payload.message || "Unknown error" });
        setStatus("error");
        cleanup("error");
      }
    });
    unlistenRef.current = unlisten;

    // 4. Open the live session in Rust.
    let sessionId: string;
    try {
      const res = await invoke<{ session_id: string }>("start_live_voice_session", {
        agentId,
        forumId: forumId ?? null,
      });
      sessionId = res.session_id;
      sessionIdRef.current = sessionId;
    } catch (e: any) {
      // The Rust command surfaces structured errors like
      // "OPENCLAW_TOO_OLD: foo" — split out the prefix for nicer messaging.
      const raw = String(e || "");
      const m = raw.match(/^([A-Z_]+):\s*(.*)$/);
      const code = (m?.[1] as LiveVoiceErrorCode) || "UNKNOWN";
      const message = m?.[2] || raw;
      setError({ code, message });
      setStatus("error");
      await cleanup("start failed");
      return;
    }

    // 5. Wire up capture: mic → CapWorklet → port.postMessage → invoke.
    const src = ctx.createMediaStreamSource(stream);
    const cap = new AudioWorkletNode(ctx, "canopy-mic-capture");
    cap.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg || msg.type !== "pcm16") return;
      const samples = msg.samples as Int16Array;

      // Simple RMS for the userSpeaking flag + barge-in.
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length) / 0x7fff;
      // Smooth so the indicator doesn't strobe.
      recentEnergyRef.current = recentEnergyRef.current * 0.7 + rms * 0.3;
      const speaking = recentEnergyRef.current > 0.04;
      setUserSpeaking(speaking);
      // Barge-in: if the user is talking and the agent is mid-utterance,
      // flush the playback ring buffer so the user's voice takes priority.
      if (speaking && agentSpeaking) {
        playbackNodeRef.current?.port.postMessage({ type: "flush" });
        setAgentSpeaking(false);
      }

      if (mutedRef.current) return;
      const b64 = int16ToBase64(samples);
      invoke("send_live_voice_audio", {
        sessionId,
        pcmBase64: b64,
      }).catch(() => { /* writer may have closed — cleanup will surface it */ });
    };
    src.connect(cap);
    // Capture worklet has no audio output — it only posts messages. We still
    // connect it to a silent merger so the graph stays alive in some browsers
    // that GC disconnected processors.
    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    cap.connect(silentSink).connect(ctx.destination);
    captureNodeRef.current = cap;

    // 6. Wire up playback: PlayWorklet → ctx.destination.
    const play = new AudioWorkletNode(ctx, "canopy-audio-playback");
    play.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === "active") setAgentSpeaking(true);
      else if (m.type === "silence") setAgentSpeaking(false);
    };
    play.connect(ctx.destination);
    playbackNodeRef.current = play;

    setStatus("live");
  }, [agentId, forumId, status, agentSpeaking, cleanup]);

  // Stop wraps cleanup so consumers don't have to think about "reason".
  const stop = useCallback(async () => {
    await cleanup("user");
  }, [cleanup]);

  // Auto-cleanup on unmount.
  useEffect(() => {
    return () => {
      // Fire-and-forget — component is going away.
      void cleanup("unmount");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status, error, agentSpeaking, userSpeaking, transcript,
    muted, setMuted, start, stop,
  };
}

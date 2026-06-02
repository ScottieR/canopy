// LiveVoiceOverlay — full-window dim overlay shown while live voice is active.
//
// Pure UI on top of useLiveVoice. The hook owns all session state; this
// component just renders it. Works for both the 1:1 Home case and the forum
// case (where ForumStage passes the currently-addressed agent + forumId).

import React, { useEffect } from "react";
import { AgentData } from "../../store/worldStore";
import { LobsterIcon } from "../../components/World/LobsterIcon";
import { useLiveVoice, LiveVoiceErrorCode } from "./useLiveVoice";

interface Props {
  agent: AgentData;
  /** Forum id if this live session is inside a forum — purely for the
   *  backend's setup payload + a small "in {forum}" subtitle. */
  forumId?: string;
  /** Subtitle shown below the agent name. Defaults to "Live conversation". */
  subtitle?: string;
  onClose: () => void;
}

// Friendly explanations for the structured error codes the hook surfaces.
function errorHelp(code: LiveVoiceErrorCode): { title: string; help: string } {
  switch (code) {
    case "MIC_DENIED":
      return {
        title: "Microphone access denied",
        help: "Open System Settings → Privacy & Security → Microphone and turn Canopy on, then try again.",
      };
    case "MIC_UNAVAILABLE":
      return {
        title: "No microphone available",
        help: "Plug in a mic or check that another app isn't holding it.",
      };
    case "OPENCLAW_TOO_OLD":
      return {
        title: "OpenClaw needs updating",
        help: "Live voice requires OpenClaw 2026.4.24 or newer. Update the container and try again.",
      };
    case "AUTH_FAILED":
      return {
        title: "Couldn't authenticate with OpenClaw",
        help: "The gateway rejected the live session token. A repair from the Diagnostics tab usually fixes this.",
      };
    case "NETWORK":
      return {
        title: "Connection dropped",
        help: "OpenClaw became unreachable. Make sure OrbStack is running, then try again.",
      };
    default:
      return { title: "Something went wrong", help: "Try again, or restart the gateway from Diagnostics." };
  }
}

export function LiveVoiceOverlay({ agent, forumId, subtitle, onClose }: Props) {
  const live = useLiveVoice({
    agentId: agent.id,
    forumId,
    onClose: (_reason) => onClose(),
  });

  // Auto-start when the overlay mounts. Doing it here (rather than at the
  // caller) keeps the contract simple: open the overlay = open the session.
  // The first AudioContext create + getUserMedia is a user gesture because
  // the overlay only opens in response to a click.
  useEffect(() => {
    if (live.status === "idle") {
      void live.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape key closes — most users reach for it when something feels stuck.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void live.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);

  const ringScale = live.agentSpeaking ? 1.18 : 1;
  const ringOpacity = live.agentSpeaking ? 0.45 : 0.15;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(8, 16, 18, 0.78)", backdropFilter: "blur(20px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Manrope', system-ui, sans-serif",
      }}
    >
      <div style={{
        width: "min(560px, 92vw)", maxHeight: "92vh", overflow: "hidden",
        display: "flex", flexDirection: "column", alignItems: "center",
        padding: "32px 28px 24px", color: "#fff", textAlign: "center",
      }}>
        {/* Subtitle line — quietly explains context. */}
        <div style={{
          fontSize: 11, fontWeight: 600, letterSpacing: "0.12em",
          textTransform: "uppercase", color: "rgba(255,255,255,0.45)", marginBottom: 4,
        }}>
          {live.status === "connecting" ? "Connecting…" :
           live.status === "live" ? "Live" :
           live.status === "closing" ? "Hanging up…" :
           live.status === "error" ? "Couldn't connect" : "Idle"}
        </div>

        {/* Avatar with pulsing ring during agent speech. */}
        <div style={{
          position: "relative",
          width: 200, height: 200, marginTop: 8, marginBottom: 20,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            position: "absolute", inset: 0, borderRadius: "50%",
            background: `radial-gradient(circle, ${agent.robeColor || "#3c6663"}55 0%, transparent 70%)`,
            transform: `scale(${ringScale})`,
            opacity: ringOpacity,
            transition: "all 0.35s ease",
          }} />
          <div style={{
            position: "absolute", inset: 24, borderRadius: "50%",
            background: `${agent.robeColor || "#3c6663"}20`,
            boxShadow: `0 0 0 2px ${agent.robeColor || "#3c6663"}60`,
          }} />
          <LobsterIcon
            size={140}
            role={agent.role}
            agentImage={agent.image}
            shellColor={agent.robeColor}
            accentColor={agent.accentColor}
            reactState={
              live.agentSpeaking ? "thinking" :
              live.status === "error" ? "error" :
              live.status === "live" ? "idle" : "off"
            }
          />
        </div>

        {/* Name + subtitle */}
        <div style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>{agent.name}</div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginTop: 2 }}>
          {subtitle || (forumId ? `In project · ${agent.role}` : `Live conversation · ${agent.role}`)}
        </div>

        {/* Error card — replaces the indicators when something blocks us. */}
        {live.status === "error" && live.error && (() => {
          const help = errorHelp(live.error.code);
          return (
            <div style={{
              marginTop: 24, padding: 18, borderRadius: 14, maxWidth: 460,
              background: "rgba(229,115,115,0.15)", border: "1px solid rgba(229,115,115,0.4)",
              textAlign: "left",
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#ffb3b3", marginBottom: 6 }}>{help.title}</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.75)", lineHeight: 1.5, marginBottom: 8 }}>{help.help}</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "'Geist Mono', monospace" }}>
                {live.error.message}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button
                  onClick={() => void live.start()}
                  style={{ padding: "8px 16px", borderRadius: 10, border: "none", background: "#fff", color: "#0a1314", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                >Try again</button>
                <button
                  onClick={onClose}
                  style={{ padding: "8px 16px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.3)", background: "transparent", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                >Close</button>
              </div>
            </div>
          );
        })()}

        {/* Live indicators — only when we're actually live. */}
        {live.status === "live" && (
          <div style={{ display: "flex", gap: 12, marginTop: 24, marginBottom: 16 }}>
            <Indicator on={live.userSpeaking} label="You" />
            <Indicator on={live.agentSpeaking} label={agent.name} />
          </div>
        )}

        {/* Transcript ticker — last ~3 lines. Quiet, low-contrast. Not a
            substitute for the real chat log; this is the in-the-moment
            captioning while audio is in flight. The full conversation lands
            in the chat thread after the session ends. */}
        {live.transcript.length > 0 && (
          <div style={{
            width: "100%", maxWidth: 460, marginTop: 8,
            display: "flex", flexDirection: "column", gap: 6,
            minHeight: 80, maxHeight: 140, overflowY: "auto",
            padding: "0 4px",
          }}>
            {live.transcript.slice(-4).map(line => (
              <div key={line.id} style={{
                fontSize: 13, lineHeight: 1.45, textAlign: "left",
                color: line.role === "user" ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.95)",
                opacity: line.isFinal ? 1 : 0.7,
                fontStyle: line.isFinal ? "normal" : "italic",
              }}>
                <span style={{ fontWeight: 600, marginRight: 6 }}>
                  {line.role === "user" ? "You" : agent.name}:
                </span>
                {line.text}
              </div>
            ))}
          </div>
        )}

        {/* Bottom action bar — mute, end call. Mute keeps the session alive
            but stops sending mic frames; useful when something private is
            happening on the user's end. */}
        {(live.status === "live" || live.status === "connecting" || live.status === "closing") && (
          <div style={{ display: "flex", gap: 12, marginTop: 28 }}>
            <button
              onClick={() => live.setMuted(!live.muted)}
              disabled={live.status !== "live"}
              title={live.muted ? "Unmute" : "Mute"}
              style={{
                width: 56, height: 56, borderRadius: "50%", border: "none", cursor: "pointer",
                background: live.muted ? "rgba(229,115,115,0.25)" : "rgba(255,255,255,0.10)",
                color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                opacity: live.status === "live" ? 1 : 0.5,
              }}
            >
              {live.muted ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              )}
            </button>
            <button
              onClick={() => void live.stop()}
              title="End call"
              style={{
                height: 56, padding: "0 22px", borderRadius: 28, border: "none", cursor: "pointer",
                background: "#E5575A", color: "#fff", fontWeight: 700, fontSize: 14,
                display: "flex", alignItems: "center", gap: 10,
                boxShadow: "0 6px 18px rgba(229,87,90,0.4)",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.68 13.32a16 16 0 0 0 2 2l1.6-1.6a2 2 0 0 1 2.11-.45c.92.3 1.91.46 2.93.46a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A19 19 0 0 1 1 5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2c0 1.02.16 2.01.46 2.94a2 2 0 0 1-.45 2.1L6.4 11.6"/>
                <line x1="23" y1="1" x2="1" y2="23"/>
              </svg>
              End call
            </button>
          </div>
        )}

        {/* Footer caption — keeps the user oriented about what's happening
            and reminds them about the (still-young) V1 caveats. */}
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 18, maxWidth: 380, lineHeight: 1.5 }}>
          Live voice runs on your Mac through OpenClaw → Gemini Live. Press <kbd style={{ fontFamily: "inherit", background: "rgba(255,255,255,0.1)", padding: "1px 6px", borderRadius: 4 }}>Esc</kbd> to end.
        </div>
      </div>
    </div>
  );
}

// Small dot+label combo used for "You speaking" / "{agent} speaking".
function Indicator({ on, label }: { on: boolean; label: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
      borderRadius: 999,
      background: on ? "rgba(74,158,150,0.25)" : "rgba(255,255,255,0.06)",
      border: `1px solid ${on ? "rgba(74,158,150,0.5)" : "rgba(255,255,255,0.1)"}`,
      transition: "all 0.2s ease",
    }}>
      <div style={{
        width: 8, height: 8, borderRadius: "50%",
        background: on ? "#4A9E96" : "rgba(255,255,255,0.3)",
        boxShadow: on ? "0 0 8px rgba(74,158,150,0.7)" : "none",
        animation: on ? "pulse 1.2s ease-in-out infinite" : "none",
      }} />
      <span style={{ fontSize: 11, color: "#fff", fontWeight: 600, letterSpacing: "0.02em" }}>{label}</span>
    </div>
  );
}

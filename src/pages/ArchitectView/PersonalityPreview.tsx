// PersonalityPreview — "Hear them" panel for the Instructions tab.
//
// Lets the user feel how their agent now responds after a personality edit:
// pick a canned prompt, the agent's reply types out character-by-character
// next to a small Lobster avatar. Auto-fires once after every successful save
// so the user gets immediate feedback on a personality change.
//
// V1 caveat: previews go through the agent's real chat path and are persisted
// to its conversation history. A future Tauri command (`preview_agent_reply`)
// would let this be ephemeral. Until then, the panel says so explicitly.

import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData } from "../../store/worldStore";
import { glass } from "../../App";
import { LobsterIcon } from "../../components/World/LobsterIcon";

export type PersonalityPreviewHandle = {
  runPreview: (prompt?: string) => void;
};

// Three canned prompts that probe different facets of the personality:
// 1) a meta opener that surfaces voice + identity
// 2) a casual situational prompt that surfaces tone + helpfulness
// 3) an emotional-load prompt that surfaces warmth / boundaries
const CANONICAL_PROMPTS: { label: string; prompt: string }[] = [
  { label: "Say hello",           prompt: "Introduce yourself in one or two sentences — like we're meeting for the first time." },
  { label: "I'm running late",    prompt: "Hey, I'm running 5 minutes late to our standup. What do you say?" },
  { label: "Rough morning",       prompt: "I'm having a rough morning. Say something to me." },
];

export const PersonalityPreview = forwardRef<PersonalityPreviewHandle, { agent: AgentData }>(
  function PersonalityPreview({ agent }, ref) {
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [reply, setReply] = useState<string>("");          // The full reply once it arrives.
    const [displayed, setDisplayed] = useState<string>("");  // The typed-out prefix shown on screen.
    const [isLoading, setIsLoading] = useState(false);
    const [hasRun, setHasRun] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Track in-flight requests so a fast save→save doesn't show a stale reply.
    const reqIdRef = useRef(0);

    const runPreview = useCallback(async (overridePrompt?: string) => {
      const idx = overridePrompt
        ? CANONICAL_PROMPTS.findIndex(p => p.prompt === overridePrompt)
        : selectedIdx;
      const prompt = overridePrompt || CANONICAL_PROMPTS[idx].prompt;
      if (idx >= 0) setSelectedIdx(idx);

      const myReq = ++reqIdRef.current;
      setIsLoading(true);
      setError(null);
      setReply("");
      setDisplayed("");
      setHasRun(true);

      try {
        const response: any = await invoke("send_message", {
          agentId: agent.id,
          message: prompt,
          sessionId: `preview_${agent.id}`,
        });
        // Stale request — a newer preview has been kicked off in the meantime.
        if (myReq !== reqIdRef.current) return;
        const text = typeof response === "object"
          ? (response?.response || response?.content || JSON.stringify(response))
          : String(response);
        setReply(text);
      } catch (e: any) {
        if (myReq !== reqIdRef.current) return;
        const msg = String(e);
        // Most common case: agent is still warming up. Don't dump a stacktrace on the user.
        if (msg.includes("1012") || msg.includes("service restart") || msg.includes("warming")) {
          setError(`${agent.name} is still waking up. Try again in a few seconds.`);
        } else if (msg.includes("No API key") || msg.includes("api_key")) {
          setError(`${agent.name} needs an API key — set one in Skills & Access.`);
        } else {
          setError(`${agent.name} couldn't reply right now.`);
        }
      } finally {
        if (myReq === reqIdRef.current) setIsLoading(false);
      }
    }, [agent.id, agent.name, selectedIdx]);

    useImperativeHandle(ref, () => ({ runPreview }), [runPreview]);

    // Typewriter effect — reveal the reply at ~16ms per character, capped so very
    // long replies still finish in a reasonable time.
    useEffect(() => {
      if (!reply) return;
      let cancelled = false;
      let i = 0;
      // Speed up for long replies so the user isn't waiting 20 seconds for a 500-char message.
      const step = reply.length > 300 ? 6 : reply.length > 150 ? 10 : 16;
      const tick = () => {
        if (cancelled) return;
        i = Math.min(reply.length, i + 1);
        setDisplayed(reply.slice(0, i));
        if (i < reply.length) {
          setTimeout(tick, step);
        }
      };
      tick();
      return () => { cancelled = true; };
    }, [reply]);

    return (
      <div style={{ ...glass(0.5), padding: 20, borderRadius: 16, marginTop: 24, marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)" }}>Hear {agent.name}</div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>
              See how the personality you've shaped lands. Save first, then try a sample. <span style={{ color: "var(--text-muted)" }}>Previews go through {agent.name} and are saved to their chat history.</span>
            </div>
          </div>
        </div>

        {/* Prompt chip selector */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {CANONICAL_PROMPTS.map((p, i) => {
            const selected = i === selectedIdx && hasRun;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => { setSelectedIdx(i); runPreview(p.prompt); }}
                disabled={isLoading}
                title={p.prompt}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: selected ? "1px solid #218380" : "1px solid var(--border-subtle)",
                  background: selected ? "rgba(33,131,128,0.10)" : "var(--surface-card)",
                  color: selected ? "#218380" : "var(--text-main)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: isLoading ? "wait" : "pointer",
                  fontFamily: "inherit",
                  opacity: isLoading && !selected ? 0.5 : 1,
                  transition: "all 0.15s ease",
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {/* Reply bubble */}
        {hasRun && (
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{
              width: 40, height: 40, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: `${agent.robeColor || "#CCC"}15`,
              boxShadow: `0 0 0 1px ${agent.robeColor || "#CCC"}40`,
              // Subtle idle-bounce while the reply is streaming in.
              animation: isLoading || (displayed.length > 0 && displayed.length < reply.length) ? "personality-preview-bounce 1.2s ease-in-out infinite" : "none",
            }}>
              <LobsterIcon
                size={36}
                role={agent.role}
                agentImage={agent.image}
                shellColor={agent.robeColor}
                accentColor={agent.accentColor}
              />
            </div>
            <div style={{
              flex: 1,
              background: "var(--surface-card)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 14,
              padding: "12px 16px",
              fontSize: 14,
              lineHeight: 1.55,
              color: "var(--text-main)",
              minHeight: 48,
              whiteSpace: "pre-wrap",
            }}>
              {error ? (
                <span style={{ color: "var(--text-sub)", fontStyle: "italic" }}>{error}</span>
              ) : displayed ? (
                <>
                  {displayed}
                  {/* Blinking caret while typing. */}
                  {displayed.length < reply.length && (
                    <span style={{ display: "inline-block", width: 2, height: "1em", background: "var(--text-main)", marginLeft: 2, verticalAlign: "text-bottom", animation: "personality-preview-blink 1s steps(2, end) infinite" }} />
                  )}
                </>
              ) : isLoading ? (
                <span style={{ color: "var(--text-sub)" }}>
                  Thinking
                  <span style={{ display: "inline-block", animation: "personality-preview-dots 1.4s infinite" }}>…</span>
                </span>
              ) : null}
            </div>
          </div>
        )}

        {!hasRun && (
          <div style={{ fontSize: 12, color: "var(--text-sub)", fontStyle: "italic" }}>
            Pick a sample above to see how {agent.name} sounds with the current personality.
          </div>
        )}

        <style>{`
          @keyframes personality-preview-bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-3px); }
          }
          @keyframes personality-preview-blink {
            0%, 50% { opacity: 1; }
            50.01%, 100% { opacity: 0; }
          }
          @keyframes personality-preview-dots {
            0%, 20% { opacity: 0; }
            50% { opacity: 1; }
            100% { opacity: 0; }
          }
        `}</style>
      </div>
    );
  }
);

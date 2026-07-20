// ─── Test-drive chat (Meet {Name} studio) ────────────────────────────────────
// Talk to the DRAFT before deploying. Runs through the user's connected
// provider (or on-device model) from the local Tauri boundary, so personality
// tweaks can be tested without sending draft instructions to Canopy's server.
// Capped turns; graceful offline copy before a provider is available.

import React, { useRef, useState } from "react";
import { requestCanopyHelper } from "../../utils/canopyHelperClient";

const MAX_TEST_TURNS = 5;
const HELPER_TIMEOUT_MS = 20_000;

type TestMessage = { role: "user" | "agent"; text: string };

/** Keep the whole payload under the helper endpoint's 4000-char message cap. */
export function buildTestDriveMessage(personality: string, agentName: string, userMessage: string): string {
  const boundedPersonality = personality.trim().slice(0, 2400);
  const boundedUser = userMessage.trim().slice(0, 600);
  return [
    `ROLEPLAY TEST: You are strictly roleplaying a drafted agent so the user can feel its personality before deploying. Stay fully in character. Reply in 1-3 short paragraphs, no meta-commentary, no mention of Eddie or drafts.`,
    `THE AGENT'S PERSONALITY:\n${boundedPersonality || `You are ${agentName}, a helpful agent.`}`,
    `USER SAYS: ${boundedUser}`,
  ].join("\n\n");
}

export function TestDriveChat({
  personality,
  agentName,
}: {
  personality: string;
  agentName: string;
}) {
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const userTurns = messages.filter(message => message.role === "user").length;
  const turnsLeft = MAX_TEST_TURNS - userTurns;

  const send = async () => {
    const text = input.trim();
    if (!text || busy || turnsLeft <= 0) return;
    setInput("");
    setMessages(prev => [...prev, { role: "user", text }]);
    setBusy(true);
    try {
      const reply = await Promise.race([
        requestCanopyHelper(
          buildTestDriveMessage(personality, agentName, text),
          { active_view: "onboarding", onboarding: { in_onboarding: true } },
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Test drive timed out")), HELPER_TIMEOUT_MS)),
      ]);
      setMessages(prev => [...prev, { role: "agent", text: reply }]);
    } catch {
      setMessages(prev => [...prev, {
        role: "agent",
        text: `(Test line is unreachable right now — ${agentName} will be fully chatty once deployed. Keep tweaking; your changes are saved.)`,
      }]);
    } finally {
      setBusy(false);
      setTimeout(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, 50);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#3c6663", marginBottom: 8 }}>
        Try talking to {agentName || "your agent"}
      </div>
      <div ref={scrollRef} style={{ flex: 1, minHeight: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "4px 2px", marginBottom: 10 }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 12.5, color: "var(--text-sub)", lineHeight: 1.6, padding: "10px 12px", borderRadius: 12, background: "rgba(60,102,99,0.05)", border: "1px dashed rgba(60,102,99,0.2)" }}>
            Say anything — ask how they'd handle your week, or test their tone.
            Edit the personality on the left and the very next reply changes with it.
          </div>
        )}
        {messages.map((message, index) => (
          <div
            key={index}
            style={{
              alignSelf: message.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "88%",
              padding: "9px 12px",
              borderRadius: message.role === "user" ? "14px 14px 4px 14px" : "4px 14px 14px 14px",
              background: message.role === "user" ? "rgba(60,102,99,0.9)" : "rgba(0,0,0,0.045)",
              color: message.role === "user" ? "#F0FDF4" : "var(--text-main)",
              fontSize: 13,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
            }}
          >
            {message.text}
          </div>
        ))}
        {busy && (
          <div style={{ alignSelf: "flex-start", fontSize: 12, color: "var(--text-sub)", padding: "6px 10px" }}>
            {agentName || "Agent"} is typing…
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") send(); }}
          placeholder={turnsLeft > 0 ? `Message ${agentName || "your agent"}…` : "Test limit reached — deploy to keep talking"}
          disabled={busy || turnsLeft <= 0}
          style={{ flex: 1, padding: "11px 13px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.1)", fontSize: 13, outline: "none", background: "var(--surface-card)", color: "var(--text-main)", fontFamily: "inherit" }}
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || !input.trim() || turnsLeft <= 0}
          style={{ padding: "11px 16px", borderRadius: 12, border: "none", background: busy || !input.trim() || turnsLeft <= 0 ? "var(--border-subtle)" : "linear-gradient(135deg, #3c6663, #609995)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: busy || !input.trim() || turnsLeft <= 0 ? "default" : "pointer", fontFamily: "inherit" }}
        >
          Send
        </button>
      </div>
      {userTurns > 0 && turnsLeft > 0 && (
        <div style={{ fontSize: 10.5, color: "var(--text-sub)", opacity: 0.6, marginTop: 6 }}>
          {turnsLeft} test {turnsLeft === 1 ? "message" : "messages"} left before deploy
        </div>
      )}
    </div>
  );
}

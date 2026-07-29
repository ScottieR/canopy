import React, { useEffect, useRef, useState } from "react";

import { requestCanopyHelper } from "../../utils/canopyHelperClient";
import {
  InterviewTurn,
  MAX_INTERVIEW_QUESTIONS,
  buildInterviewMessage,
  fallbackOpeningQuestion,
  parseInterviewReply,
} from "../../utils/draftInterview";
import { reportTelemetryEvent } from "../../store/worldStore";

const HELPER_TIMEOUT_MS = 20_000;

/**
 * Beat 1 (plan Phase 3): the drafted agent interviews the user on the
 * discovery screen. Each exchange can emit identity notes that the parent
 * merges into the personality file (the "identity file writes itself" magic).
 *
 * Offline-graceful: opening question renders instantly from a template; if
 * the helper is unreachable the conversation degrades to a friendly notice —
 * the draft flow itself never blocks on this panel.
 */
/** Compact, human-readable reason for a helper failure (mirrors TestDriveChat's
 *  taxonomy) — shown so "an error" is never mysterious, always retryable. */
function describeInterviewFailure(error: unknown): string {
  const raw = String(error || "").trim();
  if (/timed out/i.test(raw)) return "the reply took too long";
  if (/offline/i.test(raw)) return "no AI provider or local model is connected yet";
  if (/canopy_helper_no_key/i.test(raw) || /No ANTHROPIC_API_KEY/i.test(raw)) return "the helper server is missing its model credentials";
  if (/connection refused|failed to fetch|dns|unavailable/i.test(raw)) return "the local helper service couldn't be reached";
  // Pass the provider's own detail through (Rust now includes status + body
  // snippet) — a flattened "model request failed" was undiagnosable in the field.
  if (/canopy_helper_llm_error|Provider request failed|empty reply/i.test(raw)) return `the model request failed — ${raw.slice(0, 200)}`;
  return raw ? raw.slice(0, 200) : "an unknown error on this device";
}

export function DraftInterviewChat({
  agentName,
  roleTitle,
  personality,
  discoveryInput,
  onIdentityNotes,
  tall = false,
}: {
  agentName: string;
  roleTitle: string;
  personality: string;
  discoveryInput: string;
  onIdentityNotes: (notes: string) => void;
  /** Larger transcript area (used when the interview is the panel body). */
  tall?: boolean;
}) {
  const [transcript, setTranscript] = useState<InterviewTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [done, setDone] = useState(false);
  const questionsAskedRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const lastFailedMessageRef = useRef<string | null>(null);

  // Latest personality/props without re-triggering the opening effect.
  const personalityRef = useRef(personality);
  personalityRef.current = personality;

  const callAgent = async (userMessage: string | null, currentTranscript: InterviewTurn[]) => {
    const message = buildInterviewMessage({
      agentName,
      roleTitle,
      personality: personalityRef.current,
      discoveryInput,
      transcript: currentTranscript,
      userMessage,
      questionsAsked: questionsAskedRef.current,
    });
    const raw = await Promise.race([
      requestCanopyHelper(message, { active_view: "onboarding", onboarding: { in_onboarding: true } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Interview timed out")), HELPER_TIMEOUT_MS)),
    ]);
    return parseInterviewReply(raw);
  };

  // Opening turn: template question renders immediately; the live agent
  // replaces it if the helper answers in time.
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    const template = fallbackOpeningQuestion(agentName, roleTitle, discoveryInput);
    setTranscript([{ role: "agent", text: template }]);
    questionsAskedRef.current = 1;
    reportTelemetryEvent("draft_interview_opened", {});
    (async () => {
      try {
        const reply = await callAgent(null, []);
        if (reply.say) {
          setTranscript([{ role: "agent", text: reply.say }]);
          if (reply.identityNotes) onIdentityNotes(reply.identityNotes);
        }
      } catch {
        // Template question stands; stay optimistic until a send fails.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy || offline || done) return;
    setInput("");
    const next: InterviewTurn[] = [...transcript, { role: "user" as const, text }];
    setTranscript(next);
    setBusy(true);
    try {
      const reply = await callAgent(text, next);
      if (reply.identityNotes) {
        onIdentityNotes(reply.identityNotes);
        reportTelemetryEvent("draft_interview_notes_captured", {});
      }
      const say = reply.say || `Got it — noted.`;
      setTranscript(prev => [...prev, { role: "agent", text: say }]);
      if (!reply.done) questionsAskedRef.current += 1;
      if (reply.done || questionsAskedRef.current > MAX_INTERVIEW_QUESTIONS) {
        setDone(true);
        reportTelemetryEvent("draft_interview_completed", { questions: questionsAskedRef.current });
      }
    } catch (error) {
      setOffline(true);
      lastFailedMessageRef.current = text;
      reportTelemetryEvent("draft_interview_error", { reason: describeInterviewFailure(error).slice(0, 60) });
      setTranscript(prev => [...prev, {
        role: "agent",
        text: `(I can't reply live right now — ${describeInterviewFailure(error)}. Everything you've told me is saved, and I'll be fully conversational once deployed.)`,
      }]);
    } finally {
      setBusy(false);
    }
  };

  const retry = () => {
    setOffline(false);
    const failed = lastFailedMessageRef.current;
    lastFailedMessageRef.current = null;
    if (failed) {
      // Drop the failure notice, restore the input, and let them resend.
      setTranscript(prev => prev.slice(0, -1));
      setInput(failed);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#3c6663", marginBottom: 8 }}>
        {agentName} has a question for you
      </div>
      <div ref={scrollRef} style={{ maxHeight: tall ? 400 : 220, minHeight: tall ? 240 : undefined, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "2px 2px 4px", marginBottom: 10 }}>
        {transcript.map((t, i) => (
          <div key={i} style={{
            alignSelf: t.role === "user" ? "flex-end" : "flex-start",
            maxWidth: "88%", padding: "10px 14px", fontSize: 13, lineHeight: 1.55,
            borderRadius: t.role === "user" ? "14px 8px 14px 14px" : "8px 14px 14px 14px",
            background: t.role === "user" ? "rgba(60,102,99,0.10)" : "var(--surface-card)",
            border: t.role === "user" ? "1px solid rgba(60,102,99,0.16)" : "1px solid rgba(0,0,0,0.06)",
            color: "var(--text-main)", whiteSpace: "pre-wrap",
          }}>
            {t.text}
          </div>
        ))}
        {busy && (
          <div style={{ alignSelf: "flex-start", fontSize: 12, color: "var(--text-muted)", padding: "6px 10px" }}>
            {agentName} is thinking…
          </div>
        )}
        {done && (
          <div style={{ alignSelf: "center", fontSize: 11.5, color: "#3c6663", fontWeight: 700, padding: "4px 10px", background: "rgba(60,102,99,0.07)", borderRadius: 999 }}>
            Identity notes saved ✓ — continue when ready
          </div>
        )}
      </div>
      {offline && (
        <button
          type="button"
          onClick={retry}
          style={{ alignSelf: "flex-start", padding: "8px 14px", borderRadius: 10, border: "1px solid rgba(60,102,99,0.25)", background: "rgba(60,102,99,0.06)", color: "#3c6663", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
        >Try again</button>
      )}
      {!done && !offline && (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") void send(); }}
            placeholder="Answer in your own words…"
            style={{
              flex: 1, padding: "10px 14px", borderRadius: 10, fontSize: 13,
              border: "1px solid rgba(0,0,0,0.10)", background: "var(--surface-card)",
              color: "var(--text-main)", outline: "none", fontFamily: "inherit",
            }}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim() || busy}
            style={{
              padding: "0 16px", borderRadius: 10, border: "none", fontSize: 12.5, fontWeight: 700,
              background: input.trim() && !busy ? "#3c6663" : "rgba(0,0,0,0.06)",
              color: input.trim() && !busy ? "var(--surface-card)" : "var(--text-muted)",
              cursor: input.trim() && !busy ? "pointer" : "default", fontFamily: "inherit",
            }}
          >Send</button>
        </div>
      )}
    </div>
  );
}

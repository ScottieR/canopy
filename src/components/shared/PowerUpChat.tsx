import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  PowerUpAsk,
  PowerUpChip,
  PowerUpScriptInput,
  buildPowerUpScript,
  routeFreeTextToChip,
  skipReply,
  unmatchedFreeTextReply,
} from "../../utils/powerUpScript";
import {
  PowerUpHostState,
  buildAgentTurnMessage,
  createHostState,
  parseAgentTurn,
  recordAnswer,
  recordAskShown,
  validateAndBuildAsk,
} from "../../utils/powerUpAgentLoop";
import { getIntegrationEntry } from "../../utils/integrationCatalog";
import type { HeartbeatTask } from "../../utils/heartbeats";
import { requestCanopyHelper } from "../../utils/canopyHelperClient";
import { reportTelemetryEvent } from "../../store/worldStore";

const AGENT_TURN_TIMEOUT_MS = 20_000;

/** Single accept chip and not the close = nothing to decide; auto-advances. */
const isPureConfirmation = (ask: PowerUpAsk) =>
  ask.type !== "close" && ask.chips.length === 1 && ask.chips[0].kind === "accept";

/**
 * Beat 3 — "Give {Name} power" as a conversation.
 *
 * TWO ENGINES, ONE SURFACE (plan §2.1b):
 *  - "agent" mode (default): a REAL agent loop — the drafted persona picks its
 *    next action each turn via the hosted helper; the host validates every
 *    action against the closed catalog, dedupe rules, and the ask budget
 *    (powerUpAgentLoop.ts), and owns every warning card and side effect.
 *  - "script" mode: the deterministic powerUpScript — instant, offline, and
 *    the automatic fallback the moment an agent turn fails or gets clamped.
 *
 * The PARENT owns every side effect (companion windows, OAuth, pairing) via
 * callbacks — nothing launches without an explicit user click here.
 */

export type PowerUpChatProps = {
  agentName: string;
  scriptInput: PowerUpScriptInput;
  connectedIntegrations: string[];
  onSetupIntegration: (key: string) => void;
  onChannelChoice: (kind: "mobile" | "telegram" | "slack" | "later") => void;
  onHeartbeatToggle: (name: string, enabled: boolean) => void;
  /** AI-generated routine accepted/declined (agent loop's custom heartbeats). */
  onCustomHeartbeat?: (task: HeartbeatTask, accepted: boolean) => void;
  onOpenBrainSetup: () => void;
  onOpenAdvanced: () => void;
  onDeploy: () => void;
  onBack: () => void;
  portrait?: React.ReactNode;
  /** Set false to skip the live loop entirely (tests / explicit offline). */
  liveAgentEnabled?: boolean;
  /** Auto-advance pure confirmations (onboarding-config knob). */
  autoAdvanceConfirmations?: boolean;
  /** Show the setup-plan rail (parent decides based on viewport width). */
  wideLayout?: boolean;
  /** Onboarding-config variant label — tagged onto every telemetry event. */
  configVariant?: string;
};

type PlanItemStatus = "done" | "skipped" | "current" | "upcoming";

type PlanItem = {
  id: string;
  label: string;
  detail?: string;
};

type TranscriptEntry = {
  id: string;
  from: "agent" | "user";
  text: string;
  warning?: string;
};

export function PowerUpChat(props: PowerUpChatProps) {
  const {
    agentName, scriptInput, connectedIntegrations,
    onSetupIntegration, onChannelChoice, onHeartbeatToggle, onCustomHeartbeat,
    onOpenBrainSetup, onOpenAdvanced, onDeploy, onBack, portrait,
    liveAgentEnabled = true,
    autoAdvanceConfirmations = true,
    wideLayout = true,
    configVariant = "default",
  } = props;

  // Every event carries the config variant so the admin funnel can compare
  // onboarding tweaks side by side.
  const track = (eventType: string, properties: Record<string, unknown> = {}) =>
    reportTelemetryEvent(eventType, { ...properties, config_variant: configVariant });

  const scriptAsks = useMemo(() => buildPowerUpScript(scriptInput), [scriptInput]);
  const closeAsk = scriptAsks[scriptAsks.length - 1];

  const hostStateRef = useRef<PowerUpHostState>(createHostState(scriptInput));
  const [mode, setMode] = useState<"agent" | "script">(liveAgentEnabled ? "agent" : "script");
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const [scriptCursor, setScriptCursor] = useState(0);
  const [agentAsk, setAgentAsk] = useState<PowerUpAsk | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [freeText, setFreeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingConnections, setPendingConnections] = useState<string[]>([]);
  // Setup-plan rail: what we're about to set up, with live ✓ / skipped state —
  // visible progress AND visible cost of leaving early (Scottie's feedback).
  const [planStatus, setPlanStatus] = useState<Record<string, "done" | "skipped">>({});
  // Agent-generated asks (custom routines, off-plan connections) join the rail live.
  const [extraPlanItems, setExtraPlanItems] = useState<PlanItem[]>([]);
  const shownAtRef = useRef<number>(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const consecutiveSaysRef = useRef(0);

  const currentAsk: PowerUpAsk | null = mode === "agent" ? agentAsk : (scriptAsks[scriptCursor] ?? null);

  // The canonical plan shown in the rail — derived from the deterministic
  // script (the agent loop uses the same ask ids, so both engines light it up).
  const planItems: PlanItem[] = useMemo(() => {
    const items: PlanItem[] = [];
    for (const ask of scriptAsks) {
      if (ask.type === "channel") items.push({ id: "channel", label: "Stay in touch", detail: "Updates reach you anywhere" });
      else if (ask.type === "connection" && ask.integrationKey) {
        const entry = getIntegrationEntry(ask.integrationKey);
        items.push({ id: ask.id, label: entry?.label || ask.integrationKey, detail: entry?.desc });
      }
      else if (ask.type === "heartbeat" && ask.heartbeatName) {
        const hb = (scriptInput.readyHeartbeats || []).find(h => h.name === ask.heartbeatName);
        items.push({ id: ask.id, label: hb?.title || "Routine", detail: hb?.scheduleLabel });
      }
      else if (ask.type === "brain") items.push({ id: "brain", label: "How they think", detail: scriptInput.brainDetected ? "Found automatically" : "One-minute setup" });
    }
    items.push({ id: "close", label: `Put ${agentName} to work`, detail: "Deploy + first task" });
    return items;
  }, [scriptAsks, scriptInput, agentName]);

  const statusFor = (item: PlanItem): PlanItemStatus => {
    if (planStatus[item.id]) return planStatus[item.id];
    if (currentAsk && (currentAsk.id === item.id || (item.id === "channel" && currentAsk.type === "channel") || (item.id === "brain" && currentAsk.type === "brain"))) return "current";
    return "upcoming";
  };

  const markPlan = (askOrId: PowerUpAsk | string, status: "done" | "skipped") => {
    const id = typeof askOrId === "string"
      ? askOrId
      : askOrId.type === "channel" ? "channel" : askOrId.type === "brain" ? "brain" : askOrId.id;
    setPlanStatus(prev => ({ ...prev, [id]: status }));
  };

  const appendEntries = (entries: TranscriptEntry[]) =>
    setTranscript(prev => {
      const existing = new Set(prev.map(e => e.id));
      return [...prev, ...entries.filter(e => !existing.has(e.id))];
    });

  const fireAskShown = (ask: PowerUpAsk) => {
    shownAtRef.current = Date.now();
    track("powerup_ask_shown", {
      ask_type: ask.type,
      key: ask.integrationKey || ask.heartbeatName || null,
      source: ask.source,
    });
  };

  const presentAsk = (ask: PowerUpAsk, viaAgent: boolean) => {
    appendEntries([{
      id: `ask-${ask.id}`,
      from: "agent",
      text: ask.message,
      warning: ask.sensitivityWarning,
    }]);
    if (viaAgent) {
      recordAskShown(hostStateRef.current, ask);
      setAgentAsk(ask);
      // Agent-generated items the deterministic plan didn't predict (custom
      // routines, off-plan connections) appear in the rail as they arrive.
      const railId = ask.type === "channel" ? "channel" : ask.type === "brain" ? "brain" : ask.id;
      const known = planItems.some(i => i.id === railId);
      if (!known && (ask.type === "heartbeat" || ask.type === "connection")) {
        setExtraPlanItems(prev => prev.some(i => i.id === railId) ? prev : [...prev, {
          id: railId,
          label: ask.customHeartbeat?.title
            || (ask.integrationKey ? (getIntegrationEntry(ask.integrationKey)?.label || ask.integrationKey) : "Routine"),
          detail: ask.customHeartbeat?.scheduleLabel,
        }]);
      }
    }
    fireAskShown(ask);
  };

  /** Falls back to the deterministic script, skipping anything already covered. */
  const fallBackToScript = (reason: string) => {
    if (modeRef.current === "script") return;
    track("powerup_agent_fallback", { reason });
    const host = hostStateRef.current;
    // Find the first scripted ask not yet covered by the agent conversation.
    let idx = scriptAsks.findIndex(a => {
      if (a.type === "mission") return transcript.length === 0; // only if nothing shown yet
      if (a.type === "close") return true;
      if (host.asked.has(a.id)) return false;
      if (a.type === "channel" && host.channelResolved) return false;
      if (a.type === "brain" && host.brainResolved) return false;
      if (a.integrationKey && (host.connected.has(a.integrationKey) || host.declined.has(a.integrationKey))) return false;
      return true;
    });
    if (idx === -1) idx = scriptAsks.length - 1;
    setMode("script");
    setScriptCursor(idx);
  };

  const requestAgentTurn = async (userMessage: string | null) => {
    const host = hostStateRef.current;
    setBusy(true);
    setAgentAsk(null);
    try {
      const message = buildAgentTurnMessage(
        host,
        transcript.map(t => ({ role: t.from, text: t.text })),
        userMessage,
      );
      const raw = await Promise.race([
        requestCanopyHelper(message, { active_view: "onboarding", onboarding: { in_onboarding: true } }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Agent turn timed out")), AGENT_TURN_TIMEOUT_MS)),
      ]);
      const turn = parseAgentTurn(raw);
      if (!turn) { fallBackToScript("unparseable_turn"); return; }
      const validated = validateAndBuildAsk(turn, host);
      if (!validated) { fallBackToScript("clamped_action"); return; }

      if (validated.kind === "say") {
        appendEntries([{ id: `say-${Date.now()}`, from: "agent", text: validated.text }]);
        // No "Go on" chips (Scottie's field feedback): a say-only turn
        // auto-continues once; twice in a row means the agent is stalling —
        // hand over to the deterministic script.
        consecutiveSaysRef.current += 1;
        if (consecutiveSaysRef.current >= 2) {
          fallBackToScript("agent_stalling");
          return;
        }
        void requestAgentTurn("(please continue with your next setup step)");
        return;
      }
      if (validated.kind === "close") {
        appendEntries([{ id: `pre-close-${Date.now()}`, from: "agent", text: turn.say }]);
        presentAsk(closeAsk, false);
        setAgentAsk(closeAsk);
        return;
      }
      presentAsk(validated.ask, true);
      // Pure confirmations from the agent (e.g. detected-brain "nothing to
      // do ✓") auto-continue — the user only clicks on real choices. Counted
      // with say-only turns so a stalling agent (2 non-interactive turns in a
      // row) hands over to the script instead of looping.
      if (autoAdvanceConfirmations && isPureConfirmation(validated.ask)) {
        if (validated.ask.type === "brain") markPlan("brain", "done");
        consecutiveSaysRef.current += 1;
        if (consecutiveSaysRef.current >= 2) {
          fallBackToScript("agent_stalling");
          return;
        }
        window.setTimeout(() => { void requestAgentTurn("(acknowledged)"); }, 900);
      } else {
        consecutiveSaysRef.current = 0;
      }
    } catch {
      fallBackToScript("helper_unreachable");
    } finally {
      setBusy(false);
    }
  };

  // ── Opening ──
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (liveAgentEnabled) {
      void requestAgentTurn(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Script mode: seed the transcript whenever the cursor moves. Pure
  // confirmations (single accept chip — mission, detected-brain) auto-advance
  // after a beat: users should only ever click on REAL choices (Scottie's
  // field feedback — no "Let's go"/"Continue" busywork).
  useEffect(() => {
    if (mode !== "script") return;
    const ask = scriptAsks[scriptCursor];
    if (!ask) return;
    appendEntries([{
      id: `ask-${ask.id}`,
      from: "agent",
      text: ask.message,
      warning: ask.sensitivityWarning,
    }]);
    fireAskShown(ask);
    if (autoAdvanceConfirmations && isPureConfirmation(ask)) {
      if (ask.type === "brain") markPlan("brain", "done");
      const timer = window.setTimeout(() => setScriptCursor(c => c + 1), 900);
      return () => window.clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, scriptCursor]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript, busy]);

  // Success acks when the parent confirms a pending integration connected.
  useEffect(() => {
    const nowConnected = pendingConnections.filter(k => connectedIntegrations.includes(k));
    if (nowConnected.length === 0) return;
    setPendingConnections(prev => prev.filter(k => !nowConnected.includes(k)));
    for (const key of nowConnected) {
      hostStateRef.current.connected.add(key);
      const entry = getIntegrationEntry(key);
      appendEntries([{
        id: `connected-${key}-${Date.now()}`,
        from: "agent",
        text: `${entry?.label || key} is connected — I can already feel the difference. ✓`,
      }]);
      track("powerup_setup_result", { key, ok: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedIntegrations]);

  const advance = (chipLabel: string) => {
    if (modeRef.current === "agent") {
      void requestAgentTurn(chipLabel);
    } else {
      setScriptCursor(c => c + 1);
    }
  };

  const answer = (chip: PowerUpChip, viaFreeText = false) => {
    const ask = currentAsk;
    if (!ask || busy) return;
    track("powerup_ask_answered", {
      ask_type: ask.type,
      key: ask.integrationKey || ask.heartbeatName || null,
      action: chip.kind,
      via: viaFreeText ? "free_text" : "chip",
      source: ask.source,
      ms_since_shown: Date.now() - shownAtRef.current,
    });

    const entries: TranscriptEntry[] = [
      { id: `user-${ask.id}-${chip.id}-${Date.now()}`, from: "user", text: chip.label },
    ];
    const host = hostStateRef.current;

    switch (ask.type) {
      case "mission":
        break;
      case "channel": {
        host.channelResolved = true;
        markPlan("channel", chip.id === "channel-later" ? "skipped" : "done");
        if (chip.id === "channel-mobile") {
          onChannelChoice("mobile");
          entries.push({ id: `ack-${chip.id}-${Date.now()}`, from: "agent", text: `Perfect — once I'm deployed I'll get your phone paired. If I dive straight into your first task, just tap "Pair my phone" on my page and I'll have the code ready.` });
        } else if (chip.id === "channel-telegram") {
          onChannelChoice("telegram");
          entries.push({ id: `ack-${chip.id}-${Date.now()}`, from: "agent", text: `Opening the Telegram setup window — finish there and I'll have a direct line to you.` });
        } else if (chip.id === "channel-slack") {
          onChannelChoice("slack");
          entries.push({ id: `ack-${chip.id}-${Date.now()}`, from: "agent", text: `Great — we'll pair Slack right after I'm deployed.` });
        } else {
          onChannelChoice("later");
          entries.push({ id: `ack-${chip.id}-${Date.now()}`, from: "agent", text: skipReply(ask, agentName) });
        }
        break;
      }
      case "connection": {
        const key = ask.integrationKey!;
        recordAnswer(host, ask, chip.kind === "accept");
        markPlan(ask, chip.kind === "accept" ? "done" : "skipped");
        if (chip.kind === "accept") {
          onSetupIntegration(key);
          setPendingConnections(prev => [...prev, key]);
          entries.push({ id: `ack-${chip.id}-${Date.now()}`, from: "agent", text: `I opened the setup window — finish it there and I'll confirm here the moment it's live.` });
        } else {
          entries.push({ id: `ack-${chip.id}-${Date.now()}`, from: "agent", text: skipReply(ask, agentName) });
        }
        break;
      }
      case "heartbeat": {
        const name = ask.heartbeatName!;
        if (ask.customHeartbeat) {
          onCustomHeartbeat?.(ask.customHeartbeat, chip.kind === "accept");
        } else {
          onHeartbeatToggle(name, chip.kind === "accept");
        }
        markPlan(ask, chip.kind === "accept" ? "done" : "skipped");
        entries.push({
          id: `ack-${chip.id}-${Date.now()}`, from: "agent",
          text: chip.kind === "accept" ? `Locked in. That one's on me now.` : skipReply(ask, agentName),
        });
        break;
      }
      case "brain": {
        host.brainResolved = true;
        markPlan("brain", chip.id === "brain-later" ? "skipped" : "done");
        if (chip.id === "brain-setup") {
          onOpenBrainSetup();
          appendEntries(entries);
          return;
        }
        if (chip.kind === "decline") {
          entries.push({ id: `ack-${chip.id}-${Date.now()}`, from: "agent", text: skipReply(ask, agentName) });
        }
        break;
      }
      case "close": {
        if (chip.id === "deploy") {
          track("powerup_deploy_clicked", { engine: modeRef.current === "agent" ? "agent_loop" : "script" });
          markPlan("close", "done");
          appendEntries(entries);
          onDeploy();
          return;
        }
        if (chip.id === "review") {
          track("powerup_advanced_opened", { from: "close_ask" });
          appendEntries(entries);
          onOpenAdvanced();
          return;
        }
        break;
      }
    }

    appendEntries(entries);
    if (ask.type === "close") return;
    advance(chip.label);
  };

  const submitFreeText = () => {
    const text = freeText.trim();
    if (!text || busy) return;
    setFreeText("");
    const ask = currentAsk;

    // Agent mode: free text goes straight to the agent — that's the point.
    if (modeRef.current === "agent") {
      appendEntries([{ id: `ft-${Date.now()}`, from: "user", text }]);
      void requestAgentTurn(text);
      return;
    }

    if (!ask) return;
    const chip = routeFreeTextToChip(text, ask);
    if (chip) {
      appendEntries([{ id: `ft-${Date.now()}`, from: "user", text }]);
      answer(chip, true);
      return;
    }
    track("powerup_free_text_unmatched", { ask_type: ask.type });
    appendEntries([
      { id: `ft-${Date.now()}`, from: "user", text },
      { id: `ft-ack-${Date.now()}`, from: "agent", text: unmatchedFreeTextReply(agentName) },
    ]);
  };

  const bubbleBase: React.CSSProperties = {
    maxWidth: 560, padding: "14px 18px", fontSize: 14, lineHeight: 1.65,
    whiteSpace: "pre-wrap", fontFamily: "inherit",
  };

  const chipRow = currentAsk && !busy && !(autoAdvanceConfirmations && isPureConfirmation(currentAsk)) ? (
    // Chips live INSIDE the message flow, directly under the last agent
    // message — the action sits next to the words asking for it.
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, paddingTop: 2 }}>
      {currentAsk.chips.map(chip => (
        <button
          key={chip.id}
          type="button"
          onClick={() => answer(chip)}
          style={{
            padding: "10px 18px", borderRadius: 999, fontSize: 13, fontWeight: 700,
            cursor: "pointer", fontFamily: "inherit",
            border: chip.kind === "accept" ? "none" : "1px solid rgba(0,0,0,0.10)",
            background: chip.kind === "accept" ? "linear-gradient(135deg, #3c6663, #609995)" : "var(--surface-card)",
            color: chip.kind === "accept" ? "var(--surface-card)" : "var(--text-sub)",
          }}
        >
          {chip.label}
        </button>
      ))}
    </div>
  ) : null;

  const STATUS_GLYPH: Record<PlanItemStatus, { glyph: string; color: string }> = {
    done:     { glyph: "✓", color: "#3c6663" },
    skipped:  { glyph: "–", color: "var(--text-muted)" },
    current:  { glyph: "●", color: "#D4A04A" },
    upcoming: { glyph: "○", color: "var(--text-muted)" },
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: wideLayout ? "minmax(0, 1fr) 248px" : "1fr", gap: 24, height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 14, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
          {portrait}
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)" }}>{agentName}</div>
            <div style={{ fontSize: 12, color: "var(--text-sub)" }}>getting set up to work for you</div>
          </div>
        </div>

        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 2px", display: "flex", flexDirection: "column", gap: 12 }}>
          {transcript.map(entry => (
            <div key={entry.id} style={{ display: "flex", flexDirection: "column", alignItems: entry.from === "user" ? "flex-end" : "flex-start", gap: 8 }}>
              <div style={{
                ...bubbleBase,
                borderRadius: entry.from === "user" ? "18px 10px 18px 18px" : "10px 18px 18px 18px",
                background: entry.from === "user" ? "rgba(60,102,99,0.10)" : "var(--surface-card)",
                border: entry.from === "user" ? "1px solid rgba(60,102,99,0.16)" : "1px solid rgba(0,0,0,0.06)",
                color: "var(--text-main)",
              }}>
                {entry.text}
              </div>
              {entry.warning && (
                <div style={{
                  ...bubbleBase,
                  maxWidth: 520, fontSize: 12.5, borderRadius: 12,
                  background: "rgba(212,160,74,0.10)", border: "1px solid rgba(212,160,74,0.28)",
                  color: "#8A5F13",
                }}>
                  ⚠️ {entry.warning}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div style={{ alignSelf: "flex-start", fontSize: 12.5, color: "var(--text-muted)", padding: "4px 8px" }}>
              {agentName} is thinking…
            </div>
          )}
          {chipRow}
        </div>

        <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
          <input
            value={freeText}
            onChange={e => setFreeText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submitFreeText(); }}
            placeholder={`Or just tell ${agentName || "them"} in your own words…`}
            style={{
              flex: 1, padding: "12px 16px", borderRadius: 12, fontSize: 13.5,
              border: "1px solid rgba(0,0,0,0.10)", background: "var(--surface-card)",
              color: "var(--text-main)", outline: "none", fontFamily: "inherit",
            }}
          />
          <button
            type="button"
            onClick={submitFreeText}
            disabled={!freeText.trim() || busy}
            style={{
              padding: "0 18px", borderRadius: 12, border: "none", fontSize: 13, fontWeight: 700,
              background: freeText.trim() && !busy ? "#3c6663" : "rgba(0,0,0,0.06)",
              color: freeText.trim() && !busy ? "var(--surface-card)" : "var(--text-muted)",
              cursor: freeText.trim() && !busy ? "pointer" : "default", fontFamily: "inherit",
            }}
          >
            Send
          </button>
        </div>

        <button
          type="button"
          onClick={() => { reportTelemetryEvent("powerup_advanced_opened", { from: "footer_link" }); onOpenAdvanced(); }}
          style={{
            alignSelf: "center", marginTop: 10, padding: 4, border: "none", background: "transparent",
            color: "var(--text-muted)", fontSize: 12, fontWeight: 600, cursor: "pointer",
            textDecoration: "underline", textUnderlineOffset: 3, fontFamily: "inherit",
          }}
        >
          Prefer a checklist? See everything {agentName || "your agent"} can connect
        </button>

        {/* Same bottom bar as beats 1 and 2: Back + primary, bottom-right,
            identical styling. Deploy here = the close ask's deploy path. */}
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", paddingTop: 14, marginTop: 6, borderTop: "1px solid rgba(0,0,0,0.05)" }}>
          <button
            type="button"
            onClick={onBack}
            style={{ padding: "12px 28px", borderRadius: 12, border: "none", background: "var(--surface-base)", color: "var(--text-sub)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
          >Back</button>
          <button
            type="button"
            onClick={() => {
              track("powerup_deploy_clicked", { engine: modeRef.current === "agent" ? "agent_loop" : "script", via: "footer" });
              markPlan("close", "done");
              onDeploy();
            }}
            style={{ padding: "12px 28px", borderRadius: 12, border: "none", background: "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
          >Deploy {agentName} →</button>
        </div>
      </div>

      {/* Setup-plan rail: everything about to be set up, with live progress.
          Leaving early is an informed choice — skipped items stay visible. */}
      {wideLayout && (
        <div style={{ padding: "18px 16px", borderRadius: 18, background: "var(--surface-base)", border: "1px solid rgba(0,0,0,0.05)", alignSelf: "start", position: "sticky", top: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.07em", textTransform: "uppercase", color: "#3c6663", marginBottom: 12 }}>
            {agentName}&apos;s setup plan
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[...planItems.slice(0, -1), ...extraPlanItems, planItems[planItems.length - 1]].map(item => {
              const status = statusFor(item);
              const { glyph, color } = STATUS_GLYPH[status];
              return (
                <div key={item.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", opacity: status === "skipped" ? 0.65 : 1 }}>
                  <span style={{ width: 18, height: 18, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color, background: status === "done" ? "rgba(60,102,99,0.12)" : status === "current" ? "rgba(212,160,74,0.16)" : "rgba(0,0,0,0.05)" }}>
                    {glyph}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: status === "skipped" ? "var(--text-muted)" : "var(--text-main)", textDecoration: status === "skipped" ? "line-through" : "none" }}>
                      {item.label}
                    </div>
                    {item.detail && (
                      <div style={{ fontSize: 11, color: "var(--text-sub)", lineHeight: 1.4 }}>
                        {status === "skipped" ? "Skipped — add anytime later" : item.detail}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {Object.values(planStatus).includes("skipped") && (
            <div style={{ marginTop: 12, fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
              Skipped items live in "See everything {agentName} can connect" below the chat.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

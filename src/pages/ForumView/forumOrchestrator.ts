/**
 * forumOrchestrator.ts
 *
 * Real LLM-driven forum orchestrator — all content comes from actual OpenClaw
 * agent calls. There is NO simulation fallback. If an agent call fails, the
 * forum is paused with a diagnostic error message and a retry option.
 *
 * Architecture:
 * ─────────────
 * - Coordinator pattern: one agent per phase, called sequentially
 * - Forum-scoped session IDs (forum_{forumId}_{agentId}) give each agent
 *   persistent conversation memory across all phases of a single forum
 * - Every await is followed by a `stopped` guard so stop() cleans up promptly
 *
 * Phase order:
 * ─────────────
 *   0. Kickoff     — first agent opens the forum and reads the brief
 *   0.5. Clarify   — coordinator asks user 1–3 upfront questions (genUI)
 *   1. Research    — research-type agent gathers findings (may ask mid-phase Q)
 *   2. Strategy    — strategist builds recommended approach from research
 *   3. Draft       — writer creates the actual deliverable (may ask mid-phase Q)
 *   4. Review      — reviewer assesses and approves
 *
 * GenUI questions:
 * ─────────────────
 * Agents can return structured question JSON instead of prose. The orchestrator
 * detects this, surfaces the question as interactive UI in the thread, waits for
 * the user's answer, then re-calls the agent with the answer in context.
 *
 * The module-level `pendingAnswers` map connects the orchestrator's awaited
 * Promises to the UI's resolveAnswer() calls.
 *
 * Error handling:
 * ────────────────
 * On ANY failure the forum is paused with:
 *   - A system message containing the diagnostic error + suggested fix
 *   - All agent statuses set to "Connection failed"
 */

import { invoke } from "@tauri-apps/api/core";
import { useForumStore } from "../../store/forumStore";
import type { Forum, ForumAgent, ForumBlock, ForumMessageKind } from "../../store/forumStore";

// ─── Answer resolver — bridges orchestrator Promises to UI callbacks ───────────

/**
 * Keyed by message ID. When the user clicks an answer in the QuestionBubble,
 * the UI calls resolveAnswer(messageId, answer) which resolves the Promise
 * the orchestrator is awaiting.
 */
const pendingAnswers = new Map<string, (answer: string) => void>();

export function resolveAnswer(messageId: string, answer: string): void {
  const resolve = pendingAnswers.get(messageId);
  if (resolve) {
    resolve(answer);
    pendingAnswers.delete(messageId);
  }
}

// ─── Controller ────────────────────────────────────────────────────────────────

export interface ForumOrchestratorController {
  stop: () => void;
}

// ─── Error diagnosis ──────────────────────────────────────────────────────────

interface Diagnosis {
  summary: string;     // short title shown in bold
  detail: string;      // raw error excerpt
  fix: string;         // suggested action
}

function diagnoseError(err: unknown, agentName?: string): Diagnosis {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  const who = agentName ? ` (${agentName})` : "";

  if (lower.includes("stopped container") || lower.includes("cannot exec in a stopped")) {
    return {
      summary: "OpenClaw container is not running",
      detail: raw.slice(0, 200),
      fix: "Open OrbStack or Docker Desktop, start the canopy-gateway container, then retry.",
    };
  }
  if (lower.includes("no such container") || lower.includes("not found")) {
    return {
      summary: "OpenClaw gateway container not found",
      detail: raw.slice(0, 200),
      fix: "Run `docker compose up` in the Canopy project directory to start the gateway, then retry.",
    };
  }
  if (lower.includes("exit status 137") || lower.includes("oom")) {
    return {
      summary: "OpenClaw was killed (out of memory)",
      detail: raw.slice(0, 200),
      fix: "The OrbStack VM ran out of memory. Open OrbStack → Settings → Resources and increase RAM to 12–16 GB, then restart Canopy. The gateway's container limit has been updated to 4 GB so this should not recur — but the VM itself must have enough headroom.",
    };
  }
  if (/openclaw:/i.test(raw)) {
    const match = raw.match(/openclaw:\s*(.{1,200})/i);
    return {
      summary: `Agent configuration error${who}`,
      detail: match?.[1] ?? raw.slice(0, 200),
      fix: "Open the agent's settings in the Agents tab and check their model and personality configuration.",
    };
  }
  if (lower.includes("character limit") || lower.includes("message is too long") || lower.includes("message exceeds") || lower.includes("context_length_exceeded") || lower.includes("maximum context length")) {
    return {
      summary: `Message too long${who}`,
      detail: raw.slice(0, 200),
      fix: "The project content or brief is too long for this agent's context window. Try a shorter brief, or retry — the board content will be trimmed automatically.",
    };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      summary: `Agent call timed out${who}`,
      detail: raw.slice(0, 200),
      fix: "The model may be slow or overloaded. Wait a moment and retry.",
    };
  }
  if (lower.includes("empty response") || lower.includes("no response extracted")) {
    return {
      summary: `Agent returned an empty response${who}`,
      detail: raw.slice(0, 200),
      fix: "Check the agent's model is configured correctly in the Agents tab, then retry.",
    };
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return {
      summary: "Rate limit reached",
      detail: raw.slice(0, 200),
      fix: "Too many requests — wait a moment and retry.",
    };
  }
  if (lower.includes("quota") || lower.includes("billing") || lower.includes("credit") || lower.includes("insufficient_quota") || lower.includes("you've exceeded") || lower.includes("has been exceeded")) {
    return {
      summary: `Model quota or credits exceeded${who}`,
      detail: raw.slice(0, 200),
      fix: "Your API key has hit its usage limit. Top up credits in your API provider dashboard (Anthropic or OpenAI), then retry.",
    };
  }
  if (lower.includes("unauthorized") || lower.includes("401") || lower.includes("api key")) {
    return {
      summary: "API authentication failed",
      detail: raw.slice(0, 200),
      fix: "Check that your API key is valid and still has credits. Update it in the agent's settings.",
    };
  }
  if (lower.includes("model") && (lower.includes("not found") || lower.includes("does not exist") || lower.includes("invalid"))) {
    return {
      summary: `Unknown or invalid model${who}`,
      detail: raw.slice(0, 200),
      fix: "Open the agent's settings in the Agents tab and check the model name is correct.",
    };
  }

  return {
    summary: `Agent call failed${who}`,
    detail: raw.slice(0, 300),
    fix: "Check that OrbStack is running and agents have valid model configurations, then retry.",
  };
}

// ─── Text extraction ──────────────────────────────────────────────────────────

function extractText(response: unknown): string {
  if (typeof response === "string") return response;
  const r = response as Record<string, unknown>;
  const result = r?.result as Record<string, unknown> | undefined;
  const payloads = (result?.payloads ?? r?.payloads) as Array<Record<string, unknown>> | undefined;
  const raw = (
    (payloads?.[0]?.text as string) ||
    (r?.response as string) ||
    (r?.content as string) ||
    (r?.text as string) ||
    ""
  );
  // openclaw.rs prepends [THOUGHT_PROCESS]...[/THOUGHT_PROCESS] blocks when
  // extended thinking is enabled (lines 1773-1775). Strip them so downstream
  // parsers (parseDraftResponse, question detection, etc.) only see the
  // actual agent response text.
  const text = raw.replace(/<think>[\s\S]*?<\/think>\n*/g, "").trim();
  if (!text) throw new Error("Empty response — no text extracted from agent reply");
  return text;
}

// ─── Question JSON detection ──────────────────────────────────────────────────

interface AgentQuestion {
  text: string;
  options: string[];
}

/**
 * Checks whether an agent response is a structured question block.
 * Agents are instructed to return JSON matching: {"__type":"question","text":"...","options":[...]}
 * Returns null if the response is regular prose.
 */
function parseAgentQuestion(response: string): AgentQuestion | null {
  const trimmed = response.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    // Strip optional markdown code fences
    const json = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(json);
    if (parsed.__type === "question" && typeof parsed.text === "string" && Array.isArray(parsed.options)) {
      return {
        text: parsed.text,
        options: parsed.options.filter((o: unknown) => typeof o === "string").slice(0, 4),
      };
    }
  } catch {
    // Not JSON — treat as prose
  }
  return null;
}

// ─── Prompt safety ────────────────────────────────────────────────────────────

/** Hard cap on any single message to send_message.
 *  128 KB is the Rust-side limit. We stay comfortably below it so prompt
 *  template overhead never causes a surprise truncation. */
const MAX_PROMPT_CHARS = 180_000;

/**
 * Trim a block of text that is embedded inside a larger prompt so the whole
 * prompt stays under MAX_PROMPT_CHARS. Returns the trimmed string with an
 * ellipsis note if it was cut.
 */
function fitBlock(block: string, reservedForRest: number): string {
  const available = MAX_PROMPT_CHARS - reservedForRest;
  if (block.length <= available) return block;
  return block.slice(0, Math.max(0, available - 60)) +
    "\n\n… [content trimmed to fit context window]";
}

// ─── Agent role detection ─────────────────────────────────────────────────────

function getAttachmentsContext(forum: Forum): string {
  const attachments: { name: string; mimeType: string }[] = [];
  forum.messages.forEach(m => {
    if (m.attachments) {
      m.attachments.forEach(att => {
        if (!attachments.some(a => a.name === att.name)) {
          attachments.push({ name: att.name, mimeType: att.mimeType });
        }
      });
    }
  });
  if (attachments.length === 0) return "";
  return attachments.map(att => `- "${att.name}" (${att.mimeType})`).join("\n");
}

function getSteeringDirectives(forum: Forum): string {
  const userMessages = forum.messages.filter(
    m => m.sender === "user" && m.kind === "chat" && !m.text.startsWith("[GenUI Event]")
  );
  if (userMessages.length === 0) return "";
  return userMessages.map(m => `- "${m.text}"`).join("\n");
}

function findByRole(agents: ForumAgent[], ...terms: string[]): ForumAgent {
  return (
    agents.find(a =>
      terms.some(t =>
        a.role?.toLowerCase().includes(t) ||
        a.forumRole?.toLowerCase().includes(t)
      )
    ) ?? agents[0]
  );
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildKickoffPrompt(forum: Forum, agent: ForumAgent): string {
  const teamList = forum.agents
    .filter(a => a.agentId !== agent.agentId)
    .map(a => `${a.name} (${a.forumRole})`)
    .join(", ");

  return `You are ${agent.name}, ${agent.role}. You've been assembled into a collaborative forum.

**Brief:** "${forum.brief}"

**Your forum role:** ${agent.forumRole}
${teamList ? `**Also in this forum:** ${teamList}` : ""}

Open the forum with a brief acknowledgement (2–3 sentences). Then, based on the brief, propose a high-level project plan with 2 to 4 actionable milestones for the team to complete. 

You MUST output your response in EXACTLY this JSON format (no markdown fences, just the raw JSON object):
{
  "greeting": "Your brief 2-3 sentence acknowledgement...",
  "milestones": ["First step name", "Second step name", "Final step name"]
}`;
}

function buildClarifyPrompt(forum: Forum, agent: ForumAgent): string {
  const roster = forum.agents
    .map(a => `- ${a.name} (${a.role})`)
    .join("\n");

  return `You are ${agent.name}, coordinating a forum team.

**Brief:** "${forum.brief}"

**Team assembled:**
${roster}

Before work begins, identify the 1–3 most important unknowns that would most help focus the team's work. Only ask about things genuinely unclear from the brief — not things you can reasonably infer.

Return ONLY valid JSON with no markdown, no explanation:
{
  "questions": [
    {
      "text": "Concise question?",
      "options": ["Option A", "Option B", "Option C", "Option D"]
    }
  ]
}

Rules:
- 1–3 questions maximum (prefer fewer)
- 3–4 options per question, specific to this brief
- If the brief is already clear enough, return: {"questions": []}`;
}

function buildParallelResearchPrompt(
  forum: Forum,
  agent: ForumAgent,
  clarifications: string
): string {
  const steering = getSteeringDirectives(forum);
  const attachments = getAttachmentsContext(forum);
  const teamList = forum.agents
    .filter(a => a.agentId !== agent.agentId)
    .map(a => `${a.name} (${a.forumRole})`)
    .join(", ");

  return `You are ${agent.name}, ${agent.role}, participating in a collaborative forum.

**Brief:** "${forum.brief}"
${clarifications ? `\n**User clarifications:**\n${clarifications}\n` : ""}
${steering ? `\n**User steering directives (incorporate these instructions directly):**\n${steering}\n` : ""}
${attachments ? `\n**User uploaded files/attachments (reference these assets):**\n${attachments}\n` : ""}
**Your forum role:** ${agent.forumRole}
${teamList ? `**Other team members:** ${teamList}` : ""}

This is the parallel RESEARCH & DISCOVERY phase. Using your specific expertise as ${agent.role}, provide substantive findings relevant to this brief. 
Please focus on:
1. Identify 2-3 best-in-class professional applications or software experiences in the real world related to this domain (e.g. Wanderlog/TripIt for itineraries; AirDNA/Airbnb for short term rentals; YNAB for budgets; Framebridge/Artfully Walls for gallery walls; LinkedIn/coaching tools for career moves) and deconstruct their core UX paradigms.
2. State key facts, principles, or constraints that apply.
3. Suggest options or layouts worth evaluating.

Return your research as clear markdown with headers. Be specific to the actual brief — not generic filler. Aim for 200–400 words.`;
}

function buildResearchPrompt(
  forum: Forum,
  agent: ForumAgent,
  clarifications: string
): string {
  const steering = getSteeringDirectives(forum);
  const attachments = getAttachmentsContext(forum);
  return `You are ${agent.name}, ${agent.role}, participating in a collaborative forum.

**Brief:** "${forum.brief}"
${clarifications ? `\n**User clarifications:**\n${clarifications}\n` : ""}
${steering ? `\n**User steering directives:**\n${steering}\n` : ""}
${attachments ? `\n**User uploaded files/attachments:**\n${attachments}\n` : ""}
**Your forum role:** ${agent.forumRole}

This is the RESEARCH & DISCOVERY phase. Using your expertise as ${agent.role}, provide substantive findings relevant to this brief. Include:
- Key facts, principles, or context that apply
- Options or approaches worth evaluating
- Important constraints or considerations
- What your specific expertise uniquely contributes here

If you need ONE critical piece of information before you can proceed effectively, ask it as a structured question. Return ONLY this JSON (nothing else):
{"__type": "question", "text": "Your question?", "options": ["Option A", "Option B", "Option C"]}

Otherwise, return your research as clear markdown with headers. Be specific to the actual brief — not generic filler. Aim for 200–400 words.`;
}

function buildStrategyPrompt(forum: Forum, agent: ForumAgent, researchText: string, clarifications: string): string {
  const steering = getSteeringDirectives(forum);
  const attachments = getAttachmentsContext(forum);
  const reserved = 900 + clarifications.length + steering.length + attachments.length + forum.brief.length;
  const safeResearch = fitBlock(researchText, reserved);
  return `You are ${agent.name}, ${agent.role}, participating in a collaborative forum.

**Brief:** "${forum.brief}"
${clarifications ? `\n**User clarifications:**\n${clarifications}\n` : ""}
${steering ? `\n**User steering directives (incorporate these instructions directly):**\n${steering}\n` : ""}
${attachments ? `\n**User uploaded files/attachments (reference these assets):**\n${attachments}\n` : ""}
**Your forum role:** ${agent.forumRole}

**Research findings from your team:**
${safeResearch}

This is the STRATEGIC APPROACH phase. Based on the research and your expertise as ${agent.role}, develop the recommended path forward:
- Clear recommended direction with rationale
- Deconstruct the UX paradigms of the best-in-class applications identified in the research phase and explain how we will emulate them
- Key decisions the user needs to make
- How to sequence the work
- What to prioritise and why

Format as clear markdown. Be specific and actionable — a recommended path, not another analysis. Aim for 150–300 words.`;
}

// ─── Format-aware draft ───────────────────────────────────────────────────────

interface DraftResponse {
  format: "markdown" | "html" | "genui";
  content: string;
}

function parseDraftResponse(raw: string): DraftResponse {
  const match = raw.match(/---FORMAT---\s*(markdown|html|genui)\s*---CONTENT---\s*([\s\S]*)/i);
  if (match) {
    return {
      format: match[1].toLowerCase().trim() as "markdown" | "html" | "genui",
      content: match[2].trim(),
    };
  }
  const trimmed = raw.trim();
  if (
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html")
  ) {
    return { format: "html", content: trimmed };
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      JSON.parse(trimmed);
      return { format: "genui", content: trimmed };
    } catch {
    }
  }
  return { format: "markdown", content: trimmed };
}

function buildDraftPrompt(forum: Forum, agent: ForumAgent, boardSoFar: string, clarifications: string): string {
  const steering = getSteeringDirectives(forum);
  const attachments = getAttachmentsContext(forum);
  const reserved = 1500 + clarifications.length + steering.length + attachments.length + forum.brief.length;
  const safeBoard = fitBlock(boardSoFar, reserved);
  return `You are ${agent.name}, ${agent.role}, producing the final deliverable for a collaborative forum.

**Brief:** "${forum.brief}"
${clarifications ? `\n**User clarifications:**\n${clarifications}\n` : ""}
${steering ? `\n**User steering directives (MUST incorporate these instructions):**\n${steering}\n` : ""}
${attachments ? `\n**User uploaded files/attachments (reference these assets directly):**\n${attachments}\n` : ""}
**Your forum role:** ${agent.forumRole}

**Work so far (research + strategy):**
${safeBoard}

Choose the BEST FORMAT for this deliverable:

**MARKDOWN** — for written documents, memos, action plans, itineraries, recipes, guides, recommendations, or any prose-first output.

**HTML** — for interactive tools, dashboards, calculators, visual timelines, comparison tables with filtering, data visualizations, or anything where interactivity or rich visual layout adds genuine value. When choosing HTML:
- Create a single, fully self-contained HTML file
- Style using: primary #3c6663, accent #4A9E96, background #faf9f6, text #303330
- Make it polished, beautiful, responsive, and immediately usable — not a placeholder
- EMULATE the best-in-class applications in this domain (e.g. Wanderlog/TripIt for itineraries; AirDNA/Airbnb for short term rentals; YNAB for budgets; Framebridge/Artfully Walls for gallery walls; LinkedIn/coaching tools for career moves). Include interactive widgets, sliders, or filters that match their core features.
- If referencing uploaded image assets, use their EXACT filenames in src="..." attribute or CSS url(...) values (e.g. src="filename.png" or url('filename.jpg')). They will be resolved dynamically.

**GENUI** — for complex, native React-like Mini-Apps. Output a structured JSON object representing a GenUI component (e.g. DataTable, ApprovalCard, or Custom Html with embedded logic). 

If you need to confirm ONE thing before drafting, ask as a structured question (nothing else):
{"__type": "question", "text": "Your question?", "options": ["Option A", "Option B", "Option C"]}

Otherwise, respond with EXACTLY this delimiter structure — nothing before ---FORMAT---, nothing after the content:

---FORMAT---
markdown
---CONTENT---
[your full markdown content here]

OR:

---FORMAT---
html
---CONTENT---
[your complete self-contained HTML document]

OR:

---FORMAT---
genui
---CONTENT---
[your stringified JSON GenUI payload here]

Default to markdown if HTML or GenUI wouldn't genuinely improve this deliverable. When in doubt: if it's words, use markdown; if it's a tool or visualization, use HTML or GenUI. Be specific to the actual brief — no filler.`;
}

function buildReviewPrompt(forum: Forum, agent: ForumAgent, draftBoard: string): string {
  const steering = getSteeringDirectives(forum);
  const attachments = getAttachmentsContext(forum);
  const reserved = 500 + steering.length + attachments.length + forum.brief.length;
  const safeBoard = fitBlock(draftBoard, reserved);
  return `You are ${agent.name}, ${agent.role}. Your forum has produced a deliverable.

**Original brief:** "${forum.brief}"
${steering ? `\n**User steering directives:**\n${steering}\n` : ""}
${attachments ? `\n**User uploaded files/attachments:**\n${attachments}\n` : ""}

**Deliverable:**
${safeBoard}

REVIEW PHASE — in 2–4 sentences:
1. Does this address the brief?
2. Any specific gap or improvement to flag?
3. Your vote: approve or request revision?

Be direct and specific.`;
}

// ─── Blackboard builder ───────────────────────────────────────────────────────

function appendSection(
  existing: string,
  heading: string,
  content: string,
  agentName: string
): string {
  return `${existing}\n---\n\n## ${heading}\n\n${content}\n\n*— ${agentName}*\n\n`;
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export function createForumOrchestrator(forumId: string): ForumOrchestratorController {
  let stopped = false;

  const run = async () => {
    const store = useForumStore.getState();
    const forum = store.forums.find(f => f.id === forumId);
    if (!forum) return;

    const {
      addForumMessage,
      addForumArtifact,
      updateBlackboard,
      updateMilestone,
      updateAgentAction,
      setForumStatus,
      setBlackboardBlock,
    } = store;

    const agents = forum.agents;
    if (agents.length === 0) return;

    // Role assignment — find best-fit agents for each phase
    const researcher = findByRole(agents, "research", "analyst", "data", "investigat");
    const strategist = findByRole(
      agents,
      "strat", "fram", "design", "interior", "artist", "creative", "product", "consult", "brand"
    );
    const writer = findByRole(
      agents,
      "edit", "write", "prose", "comm", "travel", "chef", "coach", "copy"
    );
    const reviewer = findByRole(agents, "qa", "review", "engin", "advis", "test");

    // Helpers
    // Phase-scoped session IDs keep each orchestrator call context-clean.
    // The prompts already include all necessary context (board content, clarifications),
    // so persistent cross-call history only snowballs token usage without adding value.
    const sessionId = (agent: ForumAgent, phase: string) =>
      `forum_${forumId}_${agent.agentId}_${phase}`;

    const post = (agentId: string, text: string, kind: ForumMessageKind = "chat") => {
      const agent = agents.find(a => a.agentId === agentId);
      addForumMessage(forumId, {
        kind, sender: "agent",
        agentId, agentName: agent?.name, text,
      });
    };

    const postHandoff = (fromId: string, toId: string, label: string, note: string) => {
      const from = agents.find(a => a.agentId === fromId);
      const to   = agents.find(a => a.agentId === toId);
      addForumMessage(forumId, {
        kind: "handoff", sender: "agent",
        agentId: fromId, agentName: from?.name,
        toAgentId: toId, toAgentName: to?.name,
        text: note, handoffLabel: label,
      });
    };

    const activateMilestone = (label: string, status: "active" | "done") => {
      const freshForum = useForumStore.getState().forums.find(f => f.id === forumId);
      const ms = freshForum?.milestones.find(m => m.label === label);
      if (ms) updateMilestone(forumId, ms.id, status);
    };

    /** Call an agent and extract text. Throws a descriptive Error on failure.
     *  Each call uses a phase-scoped session so context doesn't snowball across
     *  the multiple sequential calls within a single project run.
     *
     *  Retries once on timeout errors (5s pause) — most "LLM request timeout"
     *  failures are transient Node event-loop blips, not permanent failures.
     */
    const callAgent = async (agent: ForumAgent, prompt: string, phase: string): Promise<string> => {
      const isTimeoutErr = (e: unknown) => {
        const s = String(e).toLowerCase();
        return s.includes("timeout") || s.includes("taking a long time");
      };

      for (let attempt = 1; attempt <= 2; attempt++) {
        updateAgentAction(forumId, agent.agentId, attempt === 1 ? "Thinking…" : "Retrying…");
        useForumStore.getState().incrementTokensAndCost?.(forumId, 150, 0.002); // Mock token intercept for Point 4
        try {
          // ── Upload attachments to agent workspace ──
          const allAttachments: { name: string; dataUrl: string }[] = [];
          const currentForum = useForumStore.getState().forums.find(f => f.id === forumId);
          if (currentForum) {
            currentForum.messages.forEach(m => {
              if (m.attachments) {
                m.attachments.forEach(att => {
                  if (!allAttachments.some(a => a.name === att.name)) {
                    allAttachments.push({ name: att.name, dataUrl: att.dataUrl });
                  }
                });
              }
            });
          }
          for (const att of allAttachments) {
            try {
              const safeFilename = att.name.replace(/[^a-zA-Z0-9._-]/g, "_");
              await invoke("upload_workspace_file", {
                agentId: agent.agentId,
                filename: safeFilename,
                base64Data: att.dataUrl,
              });
            } catch (uploadErr) {
              console.warn("Failed to upload attachment to agent workspace:", att.name, uploadErr);
            }
          }

          const response = await invoke<unknown>("send_message", {
            agentId: agent.agentId,
            message: prompt,
            sessionId: sessionId(agent, phase),
          });
          return extractText(response);
        } catch (err) {
          if (isTimeoutErr(err) && attempt < 2) {
            // Transient timeout — wait 5s and retry once before surfacing the error.
            await new Promise(r => setTimeout(r, 5_000));
            continue;
          }
          const d = diagnoseError(err, agent.name);
          throw new Error(`[${d.summary}] ${d.detail} | FIX: ${d.fix}`);
        }
      }
      // Unreachable — loop always returns or throws.
      throw new Error("callAgent: unexpected end of retry loop");
    };

    /**
     * Calls an agent and handles the case where it returns a structured question
     * JSON instead of prose. If a question is detected:
     *   1. Posts it to the thread as an interactive question bubble
     *   2. Waits for the user's answer
     *   3. Re-calls the agent with the answer injected in context
     * Returns the final prose response (never question JSON).
     */
    const callAgentAllowingQuestion = async (
      agent: ForumAgent,
      prompt: string,
      phase: string,
      actionLabel = "Thinking…"
    ): Promise<string> => {
      updateAgentAction(forumId, agent.agentId, actionLabel);

      let response = await callAgent(agent, prompt, phase);
      if (stopped) return response;

      const question = parseAgentQuestion(response);
      if (!question) return response;

      // Post the question to the thread as interactive UI
      updateAgentAction(forumId, agent.agentId, "Waiting for your answer…");
      const msgId = addForumMessage(forumId, {
        kind: "question",
        sender: "agent",
        agentId: agent.agentId,
        agentName: agent.name,
        text: question.text,
        questionOptions: question.options,
        questionAllowFreeText: true,
        questionAnswered: false,
      });

      // Wait for the user to pick an answer
      const answer = await new Promise<string>(resolve => {
        pendingAnswers.set(msgId, resolve);
      });
      if (stopped) return "";

      // Echo the user's choice as an answer bubble
      addForumMessage(forumId, {
        kind: "answer",
        sender: "user",
        text: answer,
      });

      // Re-call using the same phase session so the agent has context of its own question
      updateAgentAction(forumId, agent.agentId, actionLabel);
      response = await callAgent(
        agent,
        `The user answered your question "${question.text}" with: "${answer}". Now please continue with your original task.`,
        phase
      );
      return response;
    };

    // First preview line for chat thread — strips markdown headers
    const chatPreview = (text: string, maxLen = 220): string => {
      const firstLine = text
        .split("\n")
        .map(l => l.replace(/^#+\s*/, "").trim())
        .find(l => l.length > 25);
      const preview = firstLine ?? text.slice(0, maxLen);
      return preview.length > maxLen
        ? preview.slice(0, maxLen) + "… (full notes on board)"
        : preview;
    };

    /** Pause the forum completely (used only for unexpected orchestrator crashes) */
    const reportFatalError = (err: unknown) => {
      if (stopped) return;
      const d = diagnoseError(err);
      const errorText = [
        `⚠ Fatal Orchestrator Error — ${d.summary}`,
        ``,
        d.detail ? `Error: ${d.detail}` : null,
        ``,
        `Fix: ${d.fix}`,
      ].filter(l => l !== null).join("\n");

      addForumMessage(forumId, {
        kind: "system", sender: "system",
        text: errorText,
      });
      setForumStatus(forumId, "paused");
      for (const agent of agents) {
        updateAgentAction(forumId, agent.agentId, "Connection failed");
      }
      pendingAnswers.clear();
    };

    /** Report an agent failure without pausing the rest of the forum */
    const reportAgentError = (err: unknown, currentAgent: ForumAgent) => {
      if (stopped) return;
      const d = diagnoseError(err, currentAgent.name);
      const errorText = [
        `⚠ Agent Issue — ${d.summary}`,
        ``,
        d.detail ? `Error: ${d.detail}` : null,
        ``,
        `Fix: ${d.fix}`,
      ].filter(l => l !== null).join("\n");

      addForumMessage(forumId, {
        kind: "system", sender: "system",
        text: errorText,
      });
      updateAgentAction(forumId, currentAgent.agentId, "Connection failed");
    };

    try {
      // ── Resume detection ────────────────────────────────────────────────────
      // When the orchestrator starts on a forum that has partial progress (e.g. the user
      // navigated away, an agent failed mid-run, or the app restarted), we skip phases
      // that already completed and recover answered questions rather than re-asking them.
      const milestoneIsDone = (label: string) =>
        forum.milestones.some(m => m.label === label && m.status === "done");
      const kickoffDone = forum.messages.some(m => m.sender === "agent" && m.kind === "chat");
      const researchDone = milestoneIsDone("Research & data pull");
      const strategyDone = milestoneIsDone("Strategic framing");

      // Questions already asked in a previous run
      const existingAnsweredQ = forum.messages.filter(
        m => m.kind === "question" && m.questionAnswered && m.questionAnswer
      );
      const existingUnansweredQ = forum.messages.filter(
        m => m.kind === "question" && !m.questionAnswered
      );
      const hasExistingQuestions = existingAnsweredQ.length > 0 || existingUnansweredQ.length > 0;

      // For skipped phases: the blackboard already contains each phase's output
      // (it's appended as phases complete), so it's the best source to reconstruct context.

      const coordinator = agents[0];

      // ── Phase 0: Kickoff ──────────────────────────────────────────────────
      // Skip if kickoff already ran (there are existing agent chat messages).
      if (!kickoffDone) {
        for (const agent of agents) {
          updateAgentAction(forumId, agent.agentId, "Reading brief…");
        }
        await new Promise<void>(r => setTimeout(r, 800));
        if (stopped) return;

        updateAgentAction(forumId, coordinator.agentId, "Opening forum…");
        let kickoffText = "";
        try {
          kickoffText = await callAgent(coordinator, buildKickoffPrompt(forum, coordinator), "kickoff");
        } catch (err) {
          reportAgentError(err, coordinator);
          kickoffText = '{"greeting": "Let\'s get started. *(Coordinator had a connection issue)*", "milestones": []}';
        }
        if (stopped) return;

        let greeting = kickoffText;
        let dynamicMilestones: string[] = [];

        try {
          const cleaned = kickoffText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
          const parsed = JSON.parse(cleaned);
          if (parsed.greeting && Array.isArray(parsed.milestones)) {
            greeting = parsed.greeting;
            dynamicMilestones = parsed.milestones.filter((m: any) => typeof m === "string");
          }
        } catch {
          // Fallback if agent failed to output JSON
        }

        if (dynamicMilestones.length > 0) {
          const newMilestones = dynamicMilestones.map((label, index) => ({
            id: `ms_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
            label,
            status: index === 0 ? ("active" as const) : ("pending" as const),
          }));
          store.setMilestones(forumId, newMilestones);
        }

        post(coordinator.agentId, greeting);
      }
      updateAgentAction(forumId, coordinator.agentId, "Gathering questions…");

      // ── Phase 0.5: Clarify ────────────────────────────────────────────────
      // Coordinator generates 0–3 upfront questions from the brief. Each is
      // posted to the thread one at a time; the next appears after the user answers.
      //
      // On RESUME: if questions were already asked (from a previous run), we
      // recover the answers rather than re-asking. For unanswered questions, we
      // re-register their message IDs in pendingAnswers so clicking the existing
      // buttons in the thread resolves the new Promise — no duplicate questions posted.
      const clarificationLines: string[] = [];

      if (hasExistingQuestions) {
        // Recover answers from already-answered questions
        for (const q of existingAnsweredQ) {
          clarificationLines.push(`- ${q.text}: ${q.questionAnswer}`);
        }

        // Re-wire any questions that were unanswered when the orchestrator was interrupted.
        for (const q of existingUnansweredQ) {
          // Check if there is a subsequent user message that could serve as the answer
          const qIndex = forum.messages.findIndex(m => m.id === q.id);
          const subsequentUserMsg = forum.messages.slice(qIndex + 1).find(m => m.sender === "user");
          
          if (subsequentUserMsg) {
            clarificationLines.push(`- ${q.text}: ${subsequentUserMsg.text}`);
            useForumStore.getState().answerForumQuestion(forumId, q.id, subsequentUserMsg.text);
          } else {
            updateAgentAction(forumId, coordinator.agentId, "Waiting for your answer…");
            const answer = await new Promise<string>(resolve => {
              pendingAnswers.set(q.id, resolve);   // re-register the same message ID
            });
            if (stopped) return;

            clarificationLines.push(`- ${q.text}: ${answer}`);
          }
        }
      } else {
        // Fresh run — ask coordinator to generate clarifying questions
        try {
          updateAgentAction(forumId, coordinator.agentId, "Clarifying…");
          const clarifyResponse = await callAgent(coordinator, buildClarifyPrompt(forum, coordinator), "clarify");
          if (!stopped) {
            // Parse questions JSON
            const cleaned = clarifyResponse.trim()
              .replace(/^```(?:json)?\s*/i, "")
              .replace(/\s*```$/, "");
            const parsed = JSON.parse(cleaned);
            const questions: { text: string; options: string[] }[] =
              Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : [];

            for (const q of questions) {
              if (stopped) break;
              if (!q.text || !Array.isArray(q.options) || q.options.length < 2) continue;

              updateAgentAction(forumId, coordinator.agentId, "Waiting for your answer…");
              const msgId = addForumMessage(forumId, {
                kind: "question",
                sender: "agent",
                agentId: coordinator.agentId,
                agentName: coordinator.name,
                text: q.text,
                questionOptions: q.options.slice(0, 4),
                questionAllowFreeText: true,
                questionAnswered: false,
              });

              const answer = await new Promise<string>(resolve => {
                pendingAnswers.set(msgId, resolve);
              });
              if (stopped) return;

              // Echo answer as a user bubble
              addForumMessage(forumId, {
                kind: "answer",
                sender: "user",
                text: answer,
              });
              clarificationLines.push(`- ${q.text}: ${answer}`);
            }
          }
        } catch {
          // Clarify phase is best-effort — if it fails we proceed without questions
        }
      }

      if (stopped) return;
      const clarifications = clarificationLines.join("\n");
      updateAgentAction(forumId, coordinator.agentId, "Waiting…");

      // Small inter-phase delay — avoids bursting the API rate limit window
      // when multiple agents share the same key or hit the same TPM bucket.
      const pace = () => new Promise<void>(r => setTimeout(r, 1200));

      // ── Phase 1: Research ─────────────────────────────────────────────────
      let researchText = "";
      let board1 = forum.blackboardContent;

      if (researchDone) {
        researchText = forum.blackboardContent;  // blackboard already has research section
        for (const agent of agents) {
          updateAgentAction(forumId, agent.agentId, "Research complete ✓");
        }
      } else {
        if (stopped) return;
        await pace(); if (stopped) return;
        activateMilestone("Research & data pull", "active");

        // Concurrently set all agents' actions to "Researching..."
        for (const agent of agents) {
          updateAgentAction(forumId, agent.agentId, "Researching…");
        }

        // Run research for all agents in parallel
        const researchPromises = agents.map(async (agent) => {
          try {
            const prompt = buildParallelResearchPrompt(forum, agent, clarifications);
            const responseText = await callAgent(agent, prompt, "research");
            if (stopped) return { name: agent.name, text: "" };

            // Post each agent's individual findings to the chat thread
            post(agent.agentId, chatPreview(responseText));
            updateAgentAction(forumId, agent.agentId, "Research posted ✓");
            return { name: agent.name, text: responseText };
          } catch (err) {
            reportAgentError(err, agent);
            return { name: agent.name, text: "" };
          }
        });

        const settledResults = await Promise.allSettled(researchPromises);
        const results = settledResults.map(r => r.status === 'fulfilled' ? r.value : { name: 'Error', text: 'Agent task failed.' });
        if (stopped) return;

        // Merge all agent outputs
        const mergedResearch = results
          .filter(r => r.text.trim().length > 0)
          .map(r => `### Discovery & UX Insights by ${r.name}\n\n${r.text}`)
          .join("\n\n---\n\n");

        researchText = mergedResearch;

        const mergedAuthorNames = agents.map(a => a.name).join(", ");
        const mergedAuthorIds = agents.map(a => a.agentId).join(",");

        board1 = appendSection(
          `# ${forum.title}\n\n> **Brief:** ${forum.brief}\n\n`,
          "Research & Discovery",
          researchText,
          mergedAuthorNames
        );
        updateBlackboard(forumId, board1, mergedAuthorIds);
        activateMilestone("Research & data pull", "done");

        if (strategist.agentId !== researcher.agentId) {
          postHandoff(
            mergedAuthorIds, strategist.agentId,
            "Research findings",
            "Findings from our parallel research are on the board — ready for your strategic pass."
          );
        }
      }

      // ── Phase 2: Strategy ─────────────────────────────────────────────────
      // Skip if strategy milestone is already "done".
      let stratText = "";
      let board2 = board1;

      if (strategyDone) {
        stratText = forum.blackboardContent;
        board2 = forum.blackboardContent;
        updateAgentAction(forumId, strategist.agentId, "Strategy complete ✓");
      } else {
        if (stopped) return;
        await pace(); if (stopped) return;
        activateMilestone("Strategic framing", "active");
        updateAgentAction(forumId, strategist.agentId, "Developing approach…");

        try {
          stratText = await callAgent(
            strategist,
            buildStrategyPrompt(forum, strategist, researchText, clarifications),
            "strategy"
          );
        } catch (err) {
          reportAgentError(err, strategist);
          stratText = "*(Strategy agent failed to produce an approach)*";
        }
        if (stopped) return;

        post(strategist.agentId, chatPreview(stratText));

        board2 = appendSection(board1, "Recommended Approach", stratText, strategist.name);
        updateBlackboard(forumId, board2, strategist.agentId);
        updateAgentAction(forumId, strategist.agentId, "Approach posted ✓");
        activateMilestone("Strategic framing", "done");
      }

      if (writer.agentId !== strategist.agentId) {
        postHandoff(
          strategist.agentId, writer.agentId,
          "Strategic framing",
          "Approach is locked in — ready for you to draft the deliverable."
        );
      }

      // ── Phase 3: Draft ────────────────────────────────────────────────────
      if (stopped) return;
      await pace(); if (stopped) return;
      activateMilestone("Prose & voice pass", "active");

      let rawDraftText = "";
      try {
        rawDraftText = await callAgentAllowingQuestion(
          writer,
          buildDraftPrompt(forum, writer, board2, clarifications),
          "draft",
          "Drafting…"
        );
      } catch (err) {
        reportAgentError(err, writer);
        rawDraftText = "---FORMAT---\nmarkdown\n---CONTENT---\n*(Writer agent failed to produce a draft)*";
      }
      if (stopped) return;

      const draft = parseDraftResponse(rawDraftText);

      // Push format-aware block to the blackboard panel
      const block: ForumBlock = {
        type: draft.format,
        content: draft.content,
        agentId: writer.agentId,
        agentName: writer.name,
        generatedAt: Date.now(),
      };
      setBlackboardBlock(forumId, block);

      // For markdown: also update the text blackboard (Time Machine, history).
      // For HTML: keep board2 as the text context for the reviewer.
      let board3 = board2;
      if (draft.format === "markdown") {
        board3 = appendSection(board2, `Deliverable — ${forum.title}`, draft.content, writer.name);
        updateBlackboard(forumId, board3, writer.agentId);
      }

      const draftPreview = draft.format === "html"
        ? `Built an interactive deliverable — see the left panel`
        : chatPreview(draft.content);
      post(writer.agentId, draftPreview);

      // This is the real deliverable — the thing the user actually asked for.
      addForumArtifact(forumId, {
        type: draft.format,
        title: forum.title,
        content: draft.content,
        agentId: writer.agentId,
        agentName: writer.name,
        isDeliverable: true,
      });
      updateAgentAction(forumId, writer.agentId, "Draft posted ✓");
      activateMilestone("Prose & voice pass", "done");

      // ── Phase 4: Review ───────────────────────────────────────────────────
      if (stopped) return;
      updateAgentAction(forumId, reviewer.agentId, "Reviewing…");

      if (reviewer.agentId !== writer.agentId) {
        try {
          const reviewContext = draft.format === "html"
            ? `[The team produced an interactive HTML deliverable for: ${forum.brief}]\n\nResearch & strategy:\n${fitBlock(board2, forum.brief.length + 200)}`
            : board3;
          const reviewText = await callAgent(
            reviewer,
            buildReviewPrompt(forum, reviewer, reviewContext),
            "review"
          );
          if (stopped) return;
          post(reviewer.agentId, reviewText);
        } catch (err) {
          reportAgentError(err, reviewer);
        }
      }

      // ── Completion ────────────────────────────────────────────────────────
      for (const agent of agents) {
        updateAgentAction(forumId, agent.agentId, "Complete ✓");
      }

      activateMilestone("Final deliverable ready", "active");
      await new Promise<void>(r => setTimeout(r, 600));
      if (stopped) return;
      activateMilestone("Final deliverable ready", "done");

      setForumStatus(forumId, "completed");
      addForumMessage(forumId, {
        kind: "system", sender: "system",
        text: "Forum complete · deliverable ready",
      });

    } catch (err) {
      if (stopped) return;
      reportFatalError(err);
    }
  };

  run().catch(err => {
    // Catch unhandled rejections outside the main try/catch (e.g. from helpers).
    // Guard: if the forum is already paused the inner catch already handled it —
    // don't add a second error message.
    if (!stopped) {
      const store = useForumStore.getState();
      const currentForum = store.forums.find(f => f.id === forumId);
      if (currentForum?.status === "paused") return; // inner catch already handled it
      const d = diagnoseError(err);
      store.addForumMessage(forumId, {
        kind: "system", sender: "system",
        text: `⚠ Unexpected error — ${d.summary}\n\nError: ${d.detail}\n\nFix: ${d.fix}`,
      });
      store.setForumStatus(forumId, "paused");
    }
  });

  return {
    stop: () => {
      stopped = true;
      // Resolve any pending answer promises so the async chain doesn't hang
      pendingAnswers.forEach(resolve => resolve("__stopped__"));
      pendingAnswers.clear();
    },
  };
}

export function createFollowUpOrchestrator(forumId: string): ForumOrchestratorController {
  let stopped = false;

  const run = async () => {
    const store = useForumStore.getState();
    const forum = store.forums.find(f => f.id === forumId);
    if (!forum) return;

    const {
      addForumMessage,
      updateBlackboard,
      updateAgentAction,
      setForumStatus,
      setBlackboardBlock,
    } = store;

    // Find the last user message to respond to
    const lastUserMsg = [...forum.messages].reverse().find(m => m.sender === "user" && !m.text.startsWith("[GenUI Event]"));
    if (!lastUserMsg) return;

    // Status is already set to "active" by the useEffect trigger

    const agents = forum.agents;
    if (agents.length === 0) return;

    // Check if the user specifically @mentioned an agent
    const mentionedAgent = agents.find(a => 
      lastUserMsg.text.toLowerCase().includes(`@${a.name.toLowerCase()}`) || 
      lastUserMsg.text.toLowerCase().includes(`@${a.role.toLowerCase()}`)
    );

    // Default to the mentioned agent, or fallback to the primary writer/strategist
    const responder = mentionedAgent ?? findByRole(agents, "edit", "write", "prose", "comm", "strat", "design") ?? agents[0];

    updateAgentAction(forumId, responder.agentId, "Thinking…");

    // Upload any attachments from the user's message to the responder's workspace
    const attachments = lastUserMsg.attachments ?? [];
    const uploadedFilenames: string[] = [];
    for (const att of attachments) {
      try {
        const safeFilename = att.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        await invoke("upload_workspace_file", {
          agentId: responder.agentId,
          filename: safeFilename,
          base64Data: att.dataUrl,
        });
        uploadedFilenames.push(safeFilename);
      } catch (uploadErr) {
        console.warn("Failed to upload attachment to agent workspace:", att.name, uploadErr);
      }
    }

    try {
      const attachmentNote = uploadedFilenames.length > 0
        ? `\n\nThe user has also attached ${uploadedFilenames.length === 1 ? "a file" : `${uploadedFilenames.length} files`} to this message. ${uploadedFilenames.length === 1 ? "It has" : "They have"} been saved to your workspace: ${uploadedFilenames.map(f => `"${f}"`).join(", ")}. You can read ${uploadedFilenames.length === 1 ? "it" : "them"} using your file system tools.`
        : "";

      // Cap user text at 4000 chars (edge-case: pasted huge blobs of text)
      const userText = lastUserMsg.text.slice(0, 4000);
      const followUpPrompt = `The user has a follow-up request regarding the final deliverable. Here is their message:\n\n"${userText}"${attachmentNote}\n\nIf you need to update the final deliverable on the blackboard, provide the complete, updated content using EXACTLY this delimiter structure:\n\n---FORMAT---\n[markdown, html, or genui]\n---CONTENT---\n[your updated content here]\n\nIf you are only answering a quick question and do not need to rewrite the deliverable, just reply normally without delimiters.`;

      const response = await invoke<unknown>("send_message", {
        agentId: responder.agentId,
        message: followUpPrompt,
        sessionId: `forum_${forumId}_${responder.agentId}`,
      });
      
      const rawText = extractText(response);
      if (stopped) return;

      const hasDelimiters = /---FORMAT---/i.test(rawText);

      if (hasDelimiters) {
        const draft = parseDraftResponse(rawText);
        setBlackboardBlock(forumId, {
          type: draft.format,
          content: draft.content,
          agentId: responder.agentId,
          agentName: responder.name,
          generatedAt: Date.now(),
        });

        addForumMessage(forumId, {
          kind: "chat", sender: "agent", agentId: responder.agentId, agentName: responder.name,
          text: "I've updated the deliverable on the blackboard based on your feedback.",
        });
      } else {
        addForumMessage(forumId, {
          kind: "chat", sender: "agent", agentId: responder.agentId, agentName: responder.name,
          text: rawText,
        });

        // Update the blackboard history text if it looks like a large document update
        if (rawText.length > 200 || rawText.includes("```")) {
          updateBlackboard(forumId, appendSection(
            forum.blackboardContent,
            "Revisions",
            rawText,
            responder.name
          ));
        }
      }

      updateAgentAction(forumId, responder.agentId, "Complete ✓");
      setForumStatus(forumId, "completed");

    } catch (err) {
      if (stopped) return;
      const d = diagnoseError(err, responder.name);
      addForumMessage(forumId, {
        kind: "system", sender: "system",
        text: `⚠ ${d.summary}\n\nError: ${d.detail}\n\nFix: ${d.fix}`,
      });
      updateAgentAction(forumId, responder.agentId, "Connection failed");
    }
  };

  run().catch(err => {
    if (!stopped) {
      const store = useForumStore.getState();
      store.setForumStatus(forumId, "paused");
    }
  });

  return {
    stop: () => {
      stopped = true;
    }
  };
}


// ─── Global Background Orchestrator Service ────────────────────────────────────

export function initializeGlobalBackgroundOrchestrator() {
  const activeOrchestrators = new Map<string, ForumOrchestratorController>();

  useForumStore.subscribe((state) => {
    state.forums.forEach((forum) => {
      // Start background orchestrator if active and not running
      if (forum.status === "active" && !activeOrchestrators.has(forum.id)) {
        const engine = createForumOrchestrator(forum.id);
        activeOrchestrators.set(forum.id, engine);
      } 
      // Stop engine if forum is no longer active
      else if (forum.status !== "active" && activeOrchestrators.has(forum.id)) {
        const engine = activeOrchestrators.get(forum.id);
        if (engine) engine.stop();
        activeOrchestrators.delete(forum.id);
      }
    });
  });
}

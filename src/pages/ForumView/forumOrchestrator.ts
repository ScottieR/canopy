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
import { buildForumLaneDiscipline } from "../../utils/rosterScope";
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
  start: () => void;
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
  if (lower.includes("missing from the openclaw registry") || lower.includes("unknown agent id")) {
    return {
      summary: `Agent runtime is still warming up${who}`,
      detail: raw.slice(0, 200),
      fix: "The gateway is still re-registering agents after startup or a restart. Wait a moment, then retry the forum.",
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

// ─── Thinking extraction ──────────────────────────────────────────────────────

/**
 * Agents are told to wrap process commentary / notes-to-self in <thinking> tags.
 * Those blocks are routed to the shared scratchpad (working notes), keeping the
 * user-facing board and chat free of meta commentary.
 */
function splitThinking(text: string): { content: string; thoughts: string[] } {
  const thoughts: string[] = [];
  const content = text
    .replace(/<thinking>([\s\S]*?)<\/thinking>/gi, (_m, t) => {
      const trimmed = String(t).trim();
      if (trimmed) thoughts.push(trimmed);
      return "";
    })
    .trim();
  return { content, thoughts };
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
  clarifications: string,
  isExperienceLead: boolean
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

This is the parallel RESEARCH & DISCOVERY phase.

**STAY IN CHARACTER.** You are ${agent.role} — contribute ONLY what that expertise uniquely provides, written in your own professional voice. If a topic belongs to a teammate's specialty (see the roster above), leave it to them; overlapping generalist takes waste the user's budget. ${isExperienceLead
    ? "As the team's experience lead, ALSO identify 1–2 best-in-class real-world apps in this domain (e.g. Wanderlog for itineraries; AirDNA/Zillow for rentals; YNAB for budgets) and note which of their UX paradigms the final deliverable app should emulate."
    : "Do NOT discuss app design, UX paradigms, or software comparisons — that is the experience lead's job, not yours."}

Deliver, from your discipline's perspective:
1. 3–6 concrete findings specific to this brief — real names, numbers, places, prices, trade-offs.
2. Options worth evaluating, with your professional opinion on each.
3. Constraints or risks your discipline can see that others would miss.

**Output discipline:** everything you write is placed verbatim on the user-facing project board. No meta commentary about the process, the team, or these instructions; no restating the brief; no "As a ${agent.role}, I…" preamble — just the findings. If you have process thoughts or notes-to-self, wrap them in <thinking></thinking> tags — they will be routed to the team scratchpad instead of the board.

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
- Sketch the structure of the final deliverable app: which views/tabs it should have, what the landing "takeaway" dashboard shows (the headline recommendation, 3–5 key stats, and one visual centerpiece), and what belongs in its embedded Library view of supporting material
- Key decisions the user needs to make
- How to sequence the work
- What to prioritise and why

**Output discipline:** everything you write is placed verbatim on the user-facing project board. Stay in character as ${agent.role}; no meta commentary about the process or the team, no restating the brief. Process thoughts belong in <thinking></thinking> tags — they'll be routed to the team scratchpad.

Format as clear markdown. Be specific and actionable — a recommended path, not another analysis. Aim for 150–300 words.`;
}

// ─── Format-aware draft ───────────────────────────────────────────────────────

interface DraftResponse {
  format: "markdown" | "html" | "genui";
  content: string;
}

/** Strip markdown code fences that models love to wrap output in. */
function stripCodeFences(text: string): string {
  let t = text.trim();
  // Leading fence (```html, ```json, ``` etc.)
  t = t.replace(/^```[a-z]*\s*\n?/i, "");
  // Trailing fence
  t = t.replace(/\n?```\s*$/, "");
  return t.trim();
}

function parseDraftResponse(raw: string): DraftResponse {
  // Delimiter structure — allow prose preamble before ---FORMAT--- (models add it
  // despite instructions) by matching the delimiter anywhere in the response.
  const match = raw.match(/---FORMAT---\s*(markdown|html|genui)\s*---CONTENT---\s*([\s\S]*)/i);
  if (match) {
    return {
      format: match[1].toLowerCase().trim() as "markdown" | "html" | "genui",
      content: stripCodeFences(match[2]),
    };
  }
  const trimmed = stripCodeFences(raw);
  // Bare HTML — also catch documents that start mid-preamble
  const htmlStart = trimmed.search(/<!DOCTYPE\s+html|<html[\s>]/i);
  if (htmlStart >= 0 && htmlStart < 200) {
    return { format: "html", content: trimmed.slice(htmlStart) };
  }
  if (trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return { format: "genui", content: trimmed };
    } catch {
      // fall through to markdown
    }
  }
  return { format: "markdown", content: trimmed };
}

/**
 * Best-effort repair of common generation defects so the deliverable never
 * renders visibly broken:
 * - HTML truncated mid-document (token limit) → close the document
 * - stray trailing fence fragments
 */
function repairDraft(draft: DraftResponse): DraftResponse {
  if (draft.format !== "html") return draft;
  let content = draft.content;
  if (!/<\/html>\s*$/i.test(content)) {
    // Drop a trailing partially-emitted tag (e.g. "<div cla") before closing
    content = content.replace(/<[^>]*$/, "");
    if (!/<\/body>/i.test(content)) content += "\n</body>";
    content += "\n</html>";
  }
  return { ...draft, content };
}

/**
 * Validates a parsed draft and returns a list of human-readable issues.
 * An empty list means the draft is publishable. Issues are fed back to the
 * writer agent verbatim for one corrective regeneration pass.
 */
function validateDraft(draft: DraftResponse): string[] {
  const issues: string[] = [];
  const c = draft.content;

  if (draft.format === "html") {
    if (!/<html[\s>]|<!DOCTYPE\s+html/i.test(c)) {
      issues.push("The HTML is not a complete document — it must start with <!DOCTYPE html> and contain <html>, <head>, and <body>.");
    }
    if (c.length < 800) {
      issues.push("The HTML is far too short to be a real deliverable — it looks like a stub or placeholder. Produce the full, content-rich page.");
    }
    if (!/<\/html>\s*$/i.test(c.trim())) {
      issues.push("The document is truncated — it does not end with </html>. Reduce scope (fewer sections, tighter copy) so the COMPLETE document fits in one response.");
    }
    if (/<script[^>]+src\s*=\s*["']https?:/i.test(c) || /<link[^>]+href\s*=\s*["']https?:/i.test(c) || /@import\s+url\(\s*["']?https?:/i.test(c)) {
      issues.push("External scripts/stylesheets/fonts are referenced. The render sandbox has NO network access — inline all CSS and JS, use system font stacks.");
    }
    if (/<img[^>]+src\s*=\s*["']https?:/i.test(c)) {
      issues.push("External images are referenced — they will render as broken images in the sandbox. Use inline SVG, CSS gradients, or emoji instead (or exact uploaded-attachment filenames).");
    }
    if (/lorem ipsum|\bTBD\b|PLACEHOLDER|Sample (item|text|content)/i.test(c)) {
      issues.push("Placeholder text detected. Every piece of content must be real, drawn from the research/strategy on the board and the brief.");
    }
  } else if (draft.format === "genui") {
    try {
      JSON.parse(c);
    } catch {
      issues.push("The GenUI payload is not valid JSON. Return a single parseable JSON object with no surrounding text or fences — or switch to a self-contained HTML deliverable instead.");
    }
  } else {
    if (c.trim().length < 80) {
      issues.push("The markdown deliverable is nearly empty. Produce the full deliverable content.");
    }
  }
  return issues;
}

// ─── Generative UI best practices ────────────────────────────────────────────
// This is the encoded "house style" for every deliverable the writer produces.
// It is injected into the draft prompt, the corrective-fix prompt, the review
// revision prompt, and the follow-up rewrite prompt so quality survives every
// path that can touch the deliverable.

const GENUI_BEST_PRACTICES = `**GENERATIVE UI BEST PRACTICES — the deliverable renders inside a sandboxed iframe in the Canopy app. Every rule below is load-bearing; violations show up as visibly broken UI.**

ENVIRONMENT (hard constraints):
- ONE complete, self-contained HTML document: \`<!DOCTYPE html>\` … \`</html>\`. All CSS in a single <style> block, all JS in a single <script> block at the end of <body>. Never wrap the document in markdown code fences.
- The sandbox has NO network access. Never reference external URLs: no CDN scripts or stylesheets, no Google Fonts, no web images, no fetch/XHR. Anything external renders as a broken asset.
- Visuals therefore come from: inline SVG (preferred — draw real charts, maps, icons, and illustrative scenes), CSS gradients/shapes, unicode/emoji, and the provided image assets (exact filenames are listed in your prompt — agent portraits and user uploads; these are resolved at render time). Fonts: system stack only, e.g. font-family: -apple-system, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif.
- No localStorage/sessionStorage/cookies (they throw in the sandbox) — keep state in JS variables. No alert/confirm/prompt.
- FINISH the document. If you are running long, cut scope — fewer sections, tighter copy — but ALWAYS emit the closing </html>. A truncated page is the worst possible outcome.

INFORMATION ARCHITECTURE (build an APP, not a scrolling document — this is the single most important section):
- Structure the deliverable as a small product with distinct VIEWS switched by a persistent top nav (tabs), using JS show/hide. Never one long scroll of stacked sections.
- The default landing view is the TAKEAWAY, laid out as a bento grid (one consistent gap, 16–24px radius): a HERO TILE (spanning ~2×2) that states the outcome as a decision — e.g. "→ Buy in Asheville, NC" — with a one-line why and a confidence note; 3–5 stat tiles with large numerals; and ONE visual centerpiece tile built in inline SVG (a chart, map, timeline, or diagram of the core content — whatever best captures the essence of this project). Someone who reads ONLY this view must come away knowing the outcome and why.
- Then one view per major facet of the work (e.g. Itinerary / Budget / Activities, or Plan / Options / Risks) carrying the full detail with its own interactions.
- The LAST view is a "Library": the team's supporting material embedded IN the app. Condense the research findings and strategy from the board into browsable cards or accordions (grouped per topic or per agent). Attribute each contribution with the agent's portrait image (use the exact asset filenames from your prompt, rendered as small round avatars) and name — the user should feel their team in the product, not just read text.
- Depth over sprawl: each view fits its purpose in one or two screens; use progressive disclosure (accordions, drill-in, hover detail) instead of dumping prose.

CONTENT GROUNDING (what makes it feel bespoke, not generic):
- Every number, name, place, price, and recommendation must come from the research/strategy on the board, the brief, or the user's clarifications. No lorem ipsum, no "Sample item", no invented statistics, no empty "TBD" sections.
- If the board lists specific items (routes, stops, dishes, exercises, line items), render THOSE items — the user should recognize their project instantly.
- Prefer showing fewer, fully-realized sections over many skeletal ones.

VISUAL IDENTITY (make it feel designed for THIS project, not templated):
- DERIVE THE PALETTE FROM THE SUBJECT. Canopy's teal is the app chrome around you — do NOT default to it. A mountain rental app wants forest greens and warm timber; a coastal one, sea blues and sand; a food project, tomato reds and cream; a finance one, deep navy and gold. Choose 1 expressive primary, 1 accent, and warm neutrals (off-white background, near-black text), then use them with conviction: a tinted page background, colored section eyebrows, gradient hero tile. Reserve Canopy teal for the watermark only.
- Every view must contain at least one non-text visual: an SVG chart with real data, an illustrated SVG scene or map, a progress meter, a photo-like CSS gradient panel, or portrait-attributed cards. If a view is only paragraphs and bullets, redesign it.
- Draw generously-sized inline SVG: hero illustrations 200–320px tall, icons 32–48px, charts with axis labels, gridlines, and value annotations. Flat, geometric, 2–3 tones of your palette — cohesive, not clip-art.
- html,body { margin:0 } with the page background color on body; the panel scrolls vertically and can be anywhere from ~700px to full-desktop wide — design a fluid layout (CSS grid with auto-fit/minmax) that uses width when it has it, never fixed pixel page widths.
- Cards/tiles: border-radius 16–24px, ONE consistent grid gap, soft shadow (0 2px 12px rgba(0,0,0,0.06)), 20–24px padding. Consistent radius + gap is what makes a bento layout read as designed.
- Compact app chrome: a slim hero strip (project title + one-line purpose) directly above the nav — not a giant banner; the takeaway dashboard is the star, not the header.
- Typography: 15–16px body, 1.6 line-height, headings with letter-spacing -0.01em; uppercase 11px letterspaced labels for section eyebrows; hero numerals 32–48px bold.

INTERACTIVITY & DELIGHT (this is what makes it magical):
- Include 2–4 interactive elements that genuinely serve the content: tabs, filters, toggles, accordions, checklists with a live progress bar, sliders that recompute real numbers (e.g. a mortgage-rate slider that re-renders cash flow), hover-reveal detail cards. Every control must visibly change something — no dead buttons.
- Micro-polish: 150–250ms ease transitions on hover/expand, subtle hover lift on cards (translateY(-2px) + shadow), a gentle staggered fade-in on load (CSS animation, max ~400ms).
- Emulate the interaction paradigms of the best-in-class product for this domain identified in research (e.g. Wanderlog for trips, YNAB for budgets, Notion for structured plans) — layout patterns, not branding.
- Accessibility basics: real <button> elements, sufficient color contrast, focus-visible outlines.
- Finish with a subtle "Made with Canopy" watermark: fixed bottom-right, 10px, opacity 0.3.`;

/** Stable filename for an agent portrait asset injected into the deliverable iframe.
 *  MUST match the slug logic in ForumView's attachment resolver. */
export function agentAssetFilename(name: string): string {
  return `agent-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}.png`;
}

function getAgentAssetManifest(forum: Forum): string {
  return forum.agents
    .filter(a => !!a.image)
    .map(a => `- "${agentAssetFilename(a.name)}" — portrait of ${a.name} (${a.forumRole})`)
    .join("\n");
}

function buildDraftPrompt(forum: Forum, agent: ForumAgent, boardSoFar: string, clarifications: string): string {
  const steering = getSteeringDirectives(forum);
  const attachments = getAttachmentsContext(forum);
  const agentAssets = getAgentAssetManifest(forum);
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

**DEFAULT TO HTML.** The deliverable panel renders your output full-bleed, like an app the team shipped — not a document in a frame. Build a small self-contained product: the takeaway front and center as an interactive, visual dashboard; the full detail in navigable views; and the team's research & strategy (from the board content above) condensed into an embedded Library view. Choose HTML unless the output is genuinely prose-only (e.g. a cover letter, a recipe, a poem).

${GENUI_BEST_PRACTICES}
${agentAssets ? `\n**Available image assets (reference by EXACT filename in src="..." — resolved at render time):**\n${agentAssets}\n` : ""}
- If referencing uploaded or listed image assets, use their EXACT filenames in src="..." or CSS url(...) (e.g. src="filename.png"). They will be resolved dynamically — these are the ONLY permitted image sources besides inline SVG/data URIs.

**MARKDOWN** — use only for outputs that are inherently prose: memos, letters, recipes, step-by-step guides, or any brief where visual layout adds nothing.

If you need to confirm ONE thing before drafting, ask as a structured question (nothing else):
{"__type": "question", "text": "Your question?", "options": ["Option A", "Option B", "Option C"]}

Otherwise, respond with EXACTLY this delimiter structure — nothing before ---FORMAT---, nothing after the content, no code fences:

---FORMAT---
html
---CONTENT---
[your complete self-contained HTML document]

OR:

---FORMAT---
markdown
---CONTENT---
[your full markdown content here]

Be specific to the actual brief content — no filler, no placeholder text. The user's agents worked hard to get here; make the deliverable worth opening.`;
}

/** Corrective prompt when the first draft fails validation — same session, so the
 *  agent still has its own draft in context. */
function buildDraftFixPrompt(issues: string[]): string {
  return `Your deliverable has problems that will make it render broken in the app. Fix ALL of the following and resend the COMPLETE corrected deliverable:

${issues.map(i => `- ${i}`).join("\n")}

Reminder of the rules:

${GENUI_BEST_PRACTICES}

Respond with EXACTLY the delimiter structure again (nothing before ---FORMAT---, no code fences):

---FORMAT---
html
---CONTENT---
[complete corrected document]`;
}

/** Revision prompt used when the reviewer requests changes. Same draft session. */
function buildRevisionPrompt(revisionNotes: string): string {
  return `The reviewer assessed your deliverable and requested one revision pass. Their notes:

${revisionNotes}

Apply these revisions and resend the COMPLETE updated deliverable (full document, not a diff). Keep everything that already works; do not regress polish or interactivity.

${GENUI_BEST_PRACTICES}

Respond with EXACTLY the delimiter structure (nothing before ---FORMAT---, no code fences):

---FORMAT---
html
---CONTENT---
[complete revised document]`;
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

REVIEW PHASE — assess the deliverable:
1. Does it address the brief and the user's steering?
2. For HTML deliverables — is it structured as an app (nav with views), with the takeaway instantly digestible on the landing view (headline decision, key stats, a visual centerpiece)? Are the team's research and strategy embedded in a Library/supporting-docs view so it's self-contained? Does it look designed for THIS subject — its own palette and real visuals — rather than a generic monochrome text page? A single long scrolling document with no navigation, or a page that is only text, is grounds for revision.
3. Any specific gap or improvement to flag?

Return ONLY valid JSON (no markdown, no fences):
{
  "verdict": "approve" | "revise",
  "comment": "2–4 sentence assessment written for the user",
  "revision_notes": "If verdict is revise: specific, actionable fixes for the writer (missing content, broken sections, brief mismatches). Empty string if approving."
}

Only choose "revise" for concrete, fixable gaps — not stylistic taste.`;
}

interface ReviewVerdict {
  verdict: "approve" | "revise";
  comment: string;
  revisionNotes: string;
}

/** Lenient parse of the reviewer's structured verdict. Falls back to treating
 *  the whole response as an advisory approve-with-comment. */
function parseReviewVerdict(raw: string): ReviewVerdict {
  try {
    const parsed = JSON.parse(stripCodeFences(raw));
    if (parsed && typeof parsed.comment === "string") {
      return {
        verdict: parsed.verdict === "revise" ? "revise" : "approve",
        comment: parsed.comment,
        revisionNotes: typeof parsed.revision_notes === "string" ? parsed.revision_notes : "",
      };
    }
  } catch {
    // prose fallback below
  }
  return { verdict: "approve", comment: raw, revisionNotes: "" };
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
      appendScratchpad,
      updateBlackboard,
      updateMilestone,
      updateAgentAction,
      setForumStatus,
      setBlackboardBlock,
    } = store;

    const agents = forum.agents;
    if (agents.length === 0) return;

    // ── Progressive forum context writer ──────────────────────────────────────
    // Writes/updates forum-context-{forumId}.md in every participating agent's
    // workspace after each milestone. Agents read this when they need to recall
    // forum context in individual chats, or when they want to reference the
    // latest state of a long-running forum.
    //
    // Also appends a brief milestone entry to each agent's MEMORY.md so that
    // cross-thread continuity works without manual note-taking.
    const writeForumContextToAgents = async (phaseName: string, phaseContent: string) => {
      const freshForum = useForumStore.getState().forums.find(f => f.id === forumId);
      if (!freshForum) return;

      const today = new Date().toISOString().slice(0, 10);

      // Build the full running forum-context file
      const completedMilestones = freshForum.milestones.filter(m => m.status === "done").map(m => m.label);
      const activeMilestone = freshForum.milestones.find(m => m.status === "active")?.label;

      const contextFile = [
        `# Forum Context: ${freshForum.title}`,
        ``,
        `**Brief:** ${freshForum.brief}`,
        `**Status:** ${freshForum.status}  **Last updated:** ${today}`,
        `**Team:** ${freshForum.agents.map(a => a.name).join(", ")}`,
        ``,
        `## Progress`,
        completedMilestones.length > 0
          ? completedMilestones.map(l => `- ✅ ${l}`).join("\n")
          : "- (no phases complete yet)",
        activeMilestone ? `- 🔄 ${activeMilestone} *(in progress)*` : "",
        ``,
        `## Latest Phase: ${phaseName}`,
        ``,
        phaseContent.slice(0, 3000), // cap to avoid huge files
        phaseContent.length > 3000 ? "\n\n*(truncated — see blackboard for full content)*" : "",
        ``,
        `## Blackboard (current)`,
        ``,
        freshForum.blackboardContent.slice(0, 2000),
        freshForum.blackboardContent.length > 2000 ? "\n\n*(truncated)*" : "",
      ].filter(l => l !== undefined).join("\n");

      // Memory entry for MEMORY.md
      const memoryEntry = `[${today}] Forum "${freshForum.title}" — ${phaseName} complete. ${phaseContent.slice(0, 150).replace(/\n/g, " ")}…\n`;

      // Write to each agent's workspace
      for (const agent of freshForum.agents) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          // Write/replace the forum context file
          await invoke("write_workspace_file", {
            agentId: agent.agentId,
            filename: `forum-context-${forumId}.md`,
            content: contextFile,
          });
          // Append to MEMORY.md (read existing, append, write back)
          try {
            const existingMemory = await invoke<string>("read_workspace_file", {
              agentId: agent.agentId,
              filename: "MEMORY.md",
            }).catch(() => "# Memory\n\n");
            const updatedMemory = (existingMemory ?? "# Memory\n\n") + memoryEntry;
            await invoke("write_workspace_file", {
              agentId: agent.agentId,
              filename: "MEMORY.md",
              content: updatedMemory,
            });
          } catch {
            // MEMORY.md update is best-effort — don't fail the forum if it errors
          }
        } catch (err) {
          console.warn(`[ForumOrchestrator] Could not write forum context for agent ${agent.agentId}:`, err);
        }
      }
    };

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

    const checkAborted = () => {
      const freshForum = useForumStore.getState().forums.find(f => f.id === forumId);
      if (stopped || !freshForum || freshForum.status !== "active") {
        throw new Error("Forum execution aborted");
      }
    };

    const isAbortError = (err: unknown) => {
      const msg = String(err);
      return msg.includes("aborted") || msg.includes("budget reached") || msg.includes("not active");
    };

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

    /**
     * Milestones are usually replaced at kickoff with coordinator-generated labels,
     * so the hardcoded phase labels ("Research & data pull" etc.) rarely match.
     * Fall back to a positional mapping so the steps rail always progresses:
     * research → first, strategy → second, draft/final → last.
     */
    const milestoneIndexFor = (label: string, milestones: { label: string }[]): number => {
      const exact = milestones.findIndex(m => m.label === label);
      if (exact >= 0) return exact;
      if (milestones.length === 0) return -1;
      switch (label) {
        case "Research & data pull":    return 0;
        case "Strategic framing":       return Math.min(1, milestones.length - 1);
        case "Prose & voice pass":      return Math.max(0, milestones.length - (milestones.length > 2 ? 2 : 1));
        case "Final deliverable ready": return milestones.length - 1;
        default: return -1;
      }
    };

    const activateMilestone = (label: string, status: "active" | "done") => {
      const freshForum = useForumStore.getState().forums.find(f => f.id === forumId);
      if (!freshForum) return;
      const idx = milestoneIndexFor(label, freshForum.milestones);
      const ms = idx >= 0 ? freshForum.milestones[idx] : undefined;
      if (ms) {
        updateMilestone(forumId, ms.id, status);
        // Completing a milestone must never leave earlier ones dangling "active"
        if (status === "done") {
          freshForum.milestones.slice(0, idx).forEach(prev => {
            if (prev.status !== "done") updateMilestone(forumId, prev.id, "done");
          });
        }
      }
    };

    /** Call an agent and extract text. Throws a descriptive Error on failure.
     *  Each call uses a phase-scoped session so context doesn't snowball across
     *  the multiple sequential calls within a single project run.
     *
     *  Retries once on timeout errors (5s pause) — most "LLM request timeout"
     *  failures are transient Node event-loop blips, not permanent failures.
     */
    const callAgent = async (agent: ForumAgent, rawPrompt: string, phase: string): Promise<string> => {
      // Lane discipline on EVERY phase call (July 18): an STR Manager opines on
      // renter ROI and local law — UX belongs to whoever owns design. Injected
      // here (single choke point) so no phase prompt can forget it.
      const forumForLanes = useForumStore.getState().forums.find(f => f.id === forumId);
      const prompt = `${buildForumLaneDiscipline(
        agent.name,
        agent.role,
        (forumForLanes?.agents || []).map(participant => ({ name: participant.name, role: participant.role })),
      )}\n\n${rawPrompt}`;
      const isTimeoutErr  = (e: unknown) => { const s = String(e).toLowerCase(); return s.includes("timeout") || s.includes("taking a long time"); };
      const isRateLimitErr = (e: unknown) => { const s = String(e).toLowerCase(); return s.includes("rate limit") || s.includes("429") || s.includes("too many request"); };
      // Quota / billing errors: retrying won't help — surface immediately and let other agents continue
      const isQuotaErr     = (e: unknown) => { const s = String(e).toLowerCase(); return s.includes("quota") || s.includes("billing") || s.includes("credit") || s.includes("insufficient_quota") || s.includes("you've exceeded") || s.includes("has been exceeded"); };
      const estimatedTokens = Math.max(150, Math.ceil(prompt.length / 4));
      const estimatedCost = Math.max(0.002, estimatedTokens * 0.00001);

      const assertBudgetAvailable = () => {
        const freshForum = useForumStore.getState().forums.find(f => f.id === forumId);
        if (!freshForum) return;
        const budget = freshForum.trustBudget;
        if (!budget) return;
        const wouldUseUsd = (budget.usdUsed || 0) + estimatedCost;
        if (budget.circuitBreakerFired || wouldUseUsd > budget.usdLimit) {
          useForumStore.getState().updateTrustBudget(forumId, { circuitBreakerFired: true });
          setForumStatus(forumId, "paused");
          addForumMessage(forumId, {
            kind: "circuit_breaker",
            sender: "system",
            text: `Trust budget reached. Estimated usage would be $${wouldUseUsd.toFixed(2)}, over the configured forum limit.`,
          });
          throw new Error("Forum trust budget reached");
        }
      };

      const MAX_ATTEMPTS = 4;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (stopped) throw new Error("Orchestrator stopped");
        checkAborted();
        assertBudgetAvailable();
        updateAgentAction(forumId, agent.agentId, attempt === 1 ? "Thinking…" : `Retrying (${attempt})…`);
        useForumStore.getState().incrementTokensAndCost?.(forumId, estimatedTokens, estimatedCost);
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
          checkAborted();
          return extractText(response);
        } catch (err) {
          if (stopped) throw err;
          if (isAbortError(err)) throw err;

          // Quota/billing errors — don't retry, it won't help. Surface immediately.
          if (isQuotaErr(err)) {
            const d = diagnoseError(err, agent.name);
            throw new Error(`[${d.summary}] ${d.detail} | FIX: ${d.fix}`);
          }

          if (attempt < MAX_ATTEMPTS) {
            if (isRateLimitErr(err)) {
              // Exponential backoff with jitter: 4s, 8s, 16s + up to 2s random
              const base = Math.pow(2, attempt + 1) * 1000;
              const jitter = Math.random() * 2000;
              updateAgentAction(forumId, agent.agentId, `Rate limited — waiting ${Math.round((base + jitter) / 1000)}s…`);
              await new Promise(r => setTimeout(r, base + jitter));
              continue;
            }
            if (isTimeoutErr(err)) {
              // Transient timeout — short wait then retry
              await new Promise(r => setTimeout(r, 5_000));
              continue;
            }
          }

          const d = diagnoseError(err, agent.name);
          throw new Error(`[${d.summary}] ${d.detail} | FIX: ${d.fix}`);
        }
      }
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
      // Milestone labels are coordinator-generated, so label matching is unreliable.
      // The blackboard headings are written by this orchestrator and are stable —
      // use them as the source of truth for which phases already completed.
      const milestoneIsDone = (label: string) =>
        forum.milestones.some(m => m.label === label && m.status === "done");
      const kickoffDone = forum.messages.some(m => m.sender === "agent" && m.kind === "chat");
      const researchDone = milestoneIsDone("Research & data pull") ||
        forum.blackboardContent.includes("## Research & Discovery");
      const strategyDone = milestoneIsDone("Strategic framing") ||
        forum.blackboardContent.includes("## Recommended Approach");

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
          if (isAbortError(err)) throw err;
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
        // Seed forum context in each agent's workspace immediately after kickoff.
        // This means even mid-forum individual chats can reference the brief + team.
        writeForumContextToAgents("Kickoff", `Brief: ${forum.brief}\n\nTeam: ${forum.agents.map(a => `${a.name} (${a.forumRole})`).join(", ")}\n\n${greeting}`).catch(() => {});
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

        // Run research for all agents in parallel, staggered by 800ms each
        // to avoid hammering the API simultaneously and triggering rate limits.
        const researchPromises = agents.map(async (agent, agentIndex) => {
          if (agentIndex > 0) await new Promise(r => setTimeout(r, agentIndex * 800));
          if (stopped) return { name: agent.name, text: "" };
          try {
            const prompt = buildParallelResearchPrompt(
              forum, agent, clarifications,
              agent.agentId === strategist.agentId
            );
            const raw = await callAgent(agent, prompt, "research");
            if (stopped) return { name: agent.name, text: "" };

            // Route <thinking> blocks to the scratchpad, not the board
            const { content: responseText, thoughts } = splitThinking(raw);
            for (const t of thoughts) {
              appendScratchpad(forumId, `**${agent.name} (thinking):** ${t}\n\n`);
            }

            // Post each agent's individual findings to the chat thread
            post(agent.agentId, chatPreview(responseText));
            updateAgentAction(forumId, agent.agentId, "Research posted ✓");
            return { name: agent.name, text: responseText };
          } catch (err) {
            if (isAbortError(err)) throw err;
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
          .map(r => `### Findings — ${r.name}\n\n${r.text}`)
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

        // Save research findings as a named artifact — folder = first milestone label (coordinator-defined)
        const researchFolder = useForumStore.getState().forums.find(f => f.id === forumId)?.milestones[0]?.label ?? "Discovery";
        addForumArtifact(forumId, {
          type: "markdown",
          title: researchFolder,
          filename: `${researchFolder.toLowerCase().replace(/\s+/g, "-")}.md`,
          folder: researchFolder,
          content: researchText,
          agentId: mergedAuthorIds,
          agentName: mergedAuthorNames,
          isDeliverable: false,
        });
        appendScratchpad(forumId, `## ${researchFolder} Notes\n${chatPreview(researchText)}\n\n`);
        // Push forum context to every agent's workspace — enables cross-thread recall
        writeForumContextToAgents(researchFolder, researchText).catch(() => {});

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
          const rawStrat = await callAgent(
            strategist,
            buildStrategyPrompt(forum, strategist, researchText, clarifications),
            "strategy"
          );
          const stratSplit = splitThinking(rawStrat);
          for (const t of stratSplit.thoughts) {
            appendScratchpad(forumId, `**${strategist.name} (thinking):** ${t}\n\n`);
          }
          stratText = stratSplit.content;
        } catch (err) {
          if (isAbortError(err)) throw err;
          reportAgentError(err, strategist);
          stratText = "*(Strategy agent failed to produce an approach)*";
        }
        if (stopped) return;

        post(strategist.agentId, chatPreview(stratText));

        board2 = appendSection(board1, "Recommended Approach", stratText, strategist.name);
        updateBlackboard(forumId, board2, strategist.agentId);
        updateAgentAction(forumId, strategist.agentId, "Approach posted ✓");
        activateMilestone("Strategic framing", "done");

        // Save strategy as a named artifact — folder = second milestone label
        const stratFolder = useForumStore.getState().forums.find(f => f.id === forumId)?.milestones[1]?.label ?? "Approach";
        addForumArtifact(forumId, {
          type: "markdown",
          title: stratFolder,
          filename: `${stratFolder.toLowerCase().replace(/\s+/g, "-")}.md`,
          folder: stratFolder,
          content: stratText,
          agentId: strategist.agentId,
          agentName: strategist.name,
          isDeliverable: false,
        });
        appendScratchpad(forumId, `## ${stratFolder} Notes\n${chatPreview(stratText)}\n\n`);
        writeForumContextToAgents(stratFolder, stratText).catch(() => {});
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
        if (isAbortError(err)) throw err;
        // A missing deliverable must never be presented as a finished forum.
        // Pause with a clear retry path — research & strategy are preserved on
        // the blackboard, so resume skips straight back to the draft phase.
        reportAgentError(err, writer);
        addForumMessage(forumId, {
          kind: "system", sender: "system",
          text: "The draft phase failed, so no deliverable was produced. Research and strategy are saved — press Retry to resume from the draft phase.",
        });
        setForumStatus(forumId, "paused");
        return;
      }
      if (stopped) return;

      // Parse → validate → one corrective pass if needed → repair as last resort.
      let draft = parseDraftResponse(rawDraftText);
      let issues = validateDraft(draft);
      if (issues.length > 0) {
        updateAgentAction(forumId, writer.agentId, "Polishing draft…");
        try {
          // Same "draft" session — the writer sees its own flawed draft in context.
          const fixedRaw = await callAgent(writer, buildDraftFixPrompt(issues), "draft");
          if (stopped) return;
          const fixed = parseDraftResponse(fixedRaw);
          if (validateDraft(fixed).length < issues.length) {
            draft = fixed;
          }
        } catch (err) {
          if (isAbortError(err)) throw err;
          // Corrective pass is best-effort — fall through with the repaired original.
        }
      }
      draft = repairDraft(draft);

      // Push format-aware block to the blackboard panel
      const publishDeliverable = (d: DraftResponse) => {
        const block: ForumBlock = {
          type: d.format,
          content: d.content,
          agentId: writer.agentId,
          agentName: writer.name,
          generatedAt: Date.now(),
        };
        setBlackboardBlock(forumId, block);
      };
      publishDeliverable(draft);

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

      // This is the real deliverable — folder = last milestone label (coordinator-defined)
      const deliverableExt = draft.format === "html" ? "html" : "md";
      const currentMilestones = useForumStore.getState().forums.find(f => f.id === forumId)?.milestones ?? [];
      const deliverableFolder = currentMilestones[currentMilestones.length - 1]?.label ?? "Final Deliverable";
      // Use the last milestone label as a descriptive title (not the full brief which is too long)
      const deliverableTitle = deliverableFolder !== "Final Deliverable"
        ? deliverableFolder
        : (forum.title.length > 40 ? forum.title.slice(0, 37) + "…" : forum.title);
      addForumArtifact(forumId, {
        type: draft.format,
        title: deliverableTitle,
        filename: `deliverable.${deliverableExt}`,
        folder: deliverableFolder,
        content: draft.content,
        agentId: writer.agentId,
        agentName: writer.name,
        isDeliverable: true,
      });
      updateAgentAction(forumId, writer.agentId, "Draft posted ✓");
      activateMilestone("Prose & voice pass", "done");
      writeForumContextToAgents(
        deliverableFolder,
        draft.format === "html"
          ? `[Interactive HTML deliverable created for: ${forum.brief}]`
          : draft.content
      ).catch(() => {});

      // ── Phase 4: Review ───────────────────────────────────────────────────
      if (stopped) return;
      updateAgentAction(forumId, reviewer.agentId, "Reviewing…");

      if (reviewer.agentId !== writer.agentId) {
        try {
          // Give the reviewer the ACTUAL deliverable — reviewing a one-line
          // placeholder produces useless (or misleading) verdicts.
          const reviewContext = draft.format === "html"
            ? `The team produced an interactive HTML deliverable. Its full source:\n\n${fitBlock(draft.content, forum.brief.length + 3000)}`
            : board3;
          const reviewText = await callAgent(
            reviewer,
            buildReviewPrompt(forum, reviewer, reviewContext),
            "review"
          );
          if (stopped) return;
          const review = parseReviewVerdict(reviewText);
          post(reviewer.agentId, review.comment);

          // ── One auto-revision pass when the reviewer flags concrete gaps ──
          if (review.verdict === "revise" && review.revisionNotes.trim()) {
            postHandoff(
              reviewer.agentId, writer.agentId,
              "Revision requested",
              "Reviewer flagged concrete gaps — running one revision pass."
            );
            updateAgentAction(forumId, writer.agentId, "Revising…");
            try {
              // Same "draft" session — the writer has its own draft in context.
              const revisedRaw = await callAgent(writer, buildRevisionPrompt(review.revisionNotes), "draft");
              if (stopped) return;
              const revised = repairDraft(parseDraftResponse(revisedRaw));
              // Only ship the revision if it's at least as sound as the original
              if (validateDraft(revised).length <= validateDraft(draft).length) {
                draft = revised;
                publishDeliverable(draft);
                addForumArtifact(forumId, {
                  type: draft.format,
                  title: `${deliverableTitle} (revised)`,
                  filename: `deliverable-revised.${draft.format === "html" ? "html" : "md"}`,
                  folder: deliverableFolder,
                  content: draft.content,
                  agentId: writer.agentId,
                  agentName: writer.name,
                  isDeliverable: true,
                });
                post(writer.agentId, "Revised the deliverable based on the review — updated in the panel.");
              }
              updateAgentAction(forumId, writer.agentId, "Revision posted ✓");
            } catch (err) {
              if (isAbortError(err)) throw err;
              // Revision is best-effort — the validated original still stands.
              reportAgentError(err, writer);
            }
          }
        } catch (err) {
          if (isAbortError(err)) throw err;
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
      // Final context write — ensures every agent's workspace reflects the completed forum
      writeForumContextToAgents("Forum complete", `Forum "${forum.title}" finished. All milestones complete. Deliverable ready.`).catch(() => {});

    } catch (err) {
      if (stopped) return;
      reportFatalError(err);
    }
  };

  return {
    start: () => {
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
    },
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
    const agents = forum.agents;

    if (!lastUserMsg || agents.length === 0) {
      // Nothing to respond to (e.g. a completed forum was resumed without a new
      // message). Don't leave the forum "active" with every agent stuck on
      // "Resuming…" and climbing timers — settle it back to completed.
      for (const agent of agents) {
        updateAgentAction(forumId, agent.agentId, "Complete ✓");
      }
      setForumStatus(forumId, "completed");
      return;
    }

    // Status is already set to "active" by the useEffect trigger

    // Check if the user specifically @mentioned an agent
    const mentionedAgent = agents.find(a => 
      lastUserMsg.text.toLowerCase().includes(`@${a.name.toLowerCase()}`) || 
      lastUserMsg.text.toLowerCase().includes(`@${a.role.toLowerCase()}`)
    );

    // Default to the mentioned agent, or fallback to the primary writer/strategist
    const responder = mentionedAgent ?? findByRole(agents, "edit", "write", "prose", "comm", "strat", "design") ?? agents[0];

    // Only the responder is working — settle everyone else so stale states
    // like "Resuming…" don't linger with running timers.
    for (const agent of agents) {
      if (agent.agentId !== responder.agentId) {
        updateAgentAction(forumId, agent.agentId, "Complete ✓");
      }
    }
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
      const followUpPrompt = `The user has a follow-up request regarding the final deliverable. Here is their message:\n\n"${userText}"${attachmentNote}\n\nIf you need to update the final deliverable on the blackboard, provide the complete, updated content (full document, not a diff) using EXACTLY this delimiter structure (nothing before ---FORMAT---, no code fences):\n\n---FORMAT---\n[markdown or html]\n---CONTENT---\n[your updated content here]\n\nWhen updating an HTML deliverable, these rules still apply:\n\n${GENUI_BEST_PRACTICES}\n\nIf you are only answering a quick question and do not need to rewrite the deliverable, just reply normally without delimiters.`;

      // Track usage the same way the main orchestrator's callAgent does —
      // follow-up work must show up in the header cost/token counters too.
      const estimatedTokens = Math.max(150, Math.ceil(followUpPrompt.length / 4));
      const estimatedCost = Math.max(0.002, estimatedTokens * 0.00001);
      useForumStore.getState().incrementTokensAndCost?.(forumId, estimatedTokens, estimatedCost);

      const response = await invoke<unknown>("send_message", {
        agentId: responder.agentId,
        message: followUpPrompt,
        sessionId: `forum_${forumId}_${responder.agentId}`,
      });

      const rawText = extractText(response);
      if (stopped) return;

      const hasDelimiters = /---FORMAT---/i.test(rawText);

      if (hasDelimiters) {
        const draft = repairDraft(parseDraftResponse(rawText));
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

  return {
    start: () => {
      run().catch(err => {
        if (!stopped) {
          const store = useForumStore.getState();
          store.setForumStatus(forumId, "paused");
        }
      });
    },
    stop: () => {
      stopped = true;
    }
  };
}


// ─── Global Background Orchestrator Service ────────────────────────────────────

export function initializeGlobalBackgroundOrchestrator() {
  // Map: forumId → { engine, version }
  // We track the orchestratorVersion so that retry/resume (which bump the version)
  // cause us to stop the old engine and start a fresh one.
  const activeEngines = new Map<string, { engine: ForumOrchestratorController; version: number }>();

  useForumStore.subscribe((state) => {
    const activeForumIds = new Set(state.forums.map(f => f.id));

    // Stop engines for forums that no longer exist
    for (const [id] of activeEngines) {
      if (!activeForumIds.has(id)) {
        activeEngines.get(id)?.engine.stop();
        activeEngines.delete(id);
      }
    }

    state.forums.forEach((forum) => {
      const currentVersion = forum.orchestratorVersion ?? 0;
      const running = activeEngines.get(forum.id);

      if (forum.status === "active") {
        if (!running) {
          const isFollowUp = forum.milestones.length > 0 && forum.milestones.every(m => m.status === "done");
          const engine = isFollowUp ? createFollowUpOrchestrator(forum.id) : createForumOrchestrator(forum.id);
          activeEngines.set(forum.id, { engine, version: currentVersion });
          engine.start();
        } else if (running.version !== currentVersion) {
          // orchestratorVersion bumped (retry/resume) — restart engine
          running.engine.stop();
          const isFollowUp = forum.milestones.length > 0 && forum.milestones.every(m => m.status === "done");
          const engine = isFollowUp ? createFollowUpOrchestrator(forum.id) : createForumOrchestrator(forum.id);
          activeEngines.set(forum.id, { engine, version: currentVersion });
          engine.start();
        }
        // else: same version, engine already running — do nothing
      } else if (running) {
        // Forum no longer active — stop engine
        running.engine.stop();
        activeEngines.delete(forum.id);
      }
    });
  });
}

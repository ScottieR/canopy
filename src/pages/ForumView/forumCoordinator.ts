/**
 * forumCoordinator.ts
 *
 * LLM-driven brief assessment — scores each team member's relevance to a project brief.
 *
 * Architecture:
 * - Calls `system_assess` (Tauri command) which picks the user's cheapest available model
 *   (Gemini Flash Lite → Claude Haiku → GPT-4o Mini) and calls the provider API directly.
 * - No OpenClaw session, no conversation history, zero footprint in any agent's chat.
 * - Parses the JSON response into AgentScore[]
 * - Falls back transparently to keyword-based scoreBrief on any failure
 *
 * The caller (ForumBriefModal) does not need to know whether the LLM path
 * succeeded or fell back — the returned AgentScore[] shape is identical either way.
 */

import { invoke } from "@tauri-apps/api/core";
import type { AgentData } from "../../store/worldStore";
import { scoreBrief, AgentScore, extractTags } from "./utils/scoreBrief";

/** AgentScore extended with isolation flag for the volunteer picker. */
export interface AgentScoreWithIsolation extends AgentScore {
  isolated: boolean;
}

// Re-export so callers can import from this file instead of scoreBrief
export type { AgentScore };
export { extractTags };

const VOLUNTEER_THRESHOLD = 35;

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildCoordinatorPrompt(brief: string, agents: AgentData[]): string {
  const roster = agents
    .map(a => `- agentId: "${a.id}" | name: "${a.name}" | role: "${a.role}"`)
    .join("\n");

  return `You are coordinating a collaborative project. A user has submitted this brief:

"${brief}"

Your available team members are:
${roster}

Return ONLY a valid JSON object — no preamble, no explanation, no markdown code fences:

{
  "tags": ["Tag1", "Tag2", "Tag3"],
  "agents": [
    { "agentId": "...", "confidence": 78, "forumRole": "Lead researcher", "rationale": "Specializes in competitive analysis and market research." },
    { "agentId": "...", "confidence": 32, "forumRole": "Strategic framing", "rationale": "Can provide strategic context for the final output." }
  ]
}

Rules for TAGS (2–4 tags max):
- Derive from the actual topic of the brief — what is this project genuinely about?
- Use short, specific, title-case labels: "Pricing Strategy", "Market Research", "Travel Planning", "Recipe Development", "Financial Modeling", etc.
- Never use generic words like "Help", "Brief", "Project", "Task"
- Examples: "Competitive Analysis", "Interior Design", "Q3 Planning", "Content Strategy"

Rules for AGENTS — for EACH agent, assess their relevance:
1. confidence (0–100): How much can they genuinely contribute? Be discriminating:
   - A chef or travel agent should score very low on a tech architecture brief
   - A financial analyst should score low on an art curation brief
   - Agents whose expertise directly matches the brief should score 60–90
   - Most agents should score below 50 unless they're clearly relevant
   - Agents with no meaningful overlap should score 10–25

2. forumRole: A short phrase (3–6 words) describing their specific role in this project
   Examples: "Lead researcher & analysis", "Creative direction", "Financial modeling",
   "Strategic framing", "Copywriting & final draft", "Technical architecture"

3. rationale: One sentence (max 12 words) explaining WHY this agent suits this specific brief.
   Be concrete — reference their role and the brief content.
   Examples: "Specializes in competitive analysis across tech markets.",
   "Owns the financial modeling and cost projections.",
   "Will handle prose editing and final draft polish."`;
}

// ─── Response parsing ─────────────────────────────────────────────────────────

interface RawScore {
  agentId: string;
  confidence: number;
  forumRole: string;
  rationale?: string;
}

interface CoordinatorResult {
  agents: RawScore[];
  tags: string[];
}

function parseCoordinatorResponse(text: string, agents: AgentData[]): CoordinatorResult | null {
  let jsonStr = text.trim();

  // Strip markdown fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const validIds = new Set(agents.map(a => a.id));

  // Try new {tags, agents} object format first
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch[0]) as Record<string, unknown>;
      const agentArr = parsed.agents;
      const tagArr = parsed.tags;

      if (Array.isArray(agentArr)) {
        const validated = (agentArr as unknown[])
          .filter((item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null
          )
          .filter(item =>
            typeof item.agentId === "string" &&
            validIds.has(item.agentId) &&
            typeof item.confidence === "number" &&
            typeof item.forumRole === "string"
          )
          .map(item => ({
            agentId: item.agentId as string,
            confidence: Math.max(0, Math.min(100, Math.round(item.confidence as number))),
            forumRole: String(item.forumRole).slice(0, 60),
            rationale: typeof item.rationale === "string" ? item.rationale.slice(0, 120) : undefined,
          }));

        if (validated.length > 0) {
          const tags: string[] = Array.isArray(tagArr)
            ? (tagArr as unknown[])
                .filter((t): t is string => typeof t === "string" && t.length > 0)
                .slice(0, 4)
            : [];
          return { agents: validated, tags };
        }
      }
    } catch {
      // Fall through to array format
    }
  }

  // Fallback: old bare array format
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed: unknown = JSON.parse(arrayMatch[0]);
      if (!Array.isArray(parsed)) return null;

      const validated = (parsed as unknown[])
        .filter((item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
        )
        .filter(item =>
          typeof item.agentId === "string" &&
          validIds.has(item.agentId) &&
          typeof item.confidence === "number" &&
          typeof item.forumRole === "string"
        )
        .map(item => ({
          agentId: item.agentId as string,
          confidence: Math.max(0, Math.min(100, Math.round(item.confidence as number))),
          forumRole: String(item.forumRole).slice(0, 60),
        }));

      return validated.length > 0 ? { agents: validated, tags: [] } : null;
    } catch {
      return null;
    }
  }

  return null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface AssessForumResult {
  scores: AgentScoreWithIsolation[];          // non-isolated agents, scored + sorted
  isolatedScores: AgentScoreWithIsolation[];  // isolated agents — shown separately w/ warning
  tags: string[];                             // LLM-derived tags, or keyword fallback
}

/**
 * Assess a forum brief using the system_assess command (cheapest available model).
 *
 * Returns { scores, isolatedScores, tags } where:
 * - scores is sorted with volunteers first (confidence ≥ 35), descending by confidence
 * - isolatedScores are keyword-scored and never auto-volunteer
 * - tags are LLM-derived topic labels for the forum (e.g. "Pricing Strategy")
 *
 * Falls back transparently to keyword scoring if:
 * - No provider API keys are configured
 * - The provider API returns an error
 * - Response can't be parsed as valid JSON
 */
/** Helper: attach isolation flag to a score. */
function withIsolation(score: AgentScore, isolated: boolean): AgentScoreWithIsolation {
  return { ...score, isolated };
}

export async function assessForum(
  brief: string,
  agents: AgentData[]
): Promise<AssessForumResult> {
  const empty: AssessForumResult = { scores: [], isolatedScores: [], tags: extractTags(brief) };
  if (agents.length === 0) return empty;

  // Split agents upfront — isolated ones are assessed separately and never auto-volunteer
  const normalAgents = agents.filter(a => !a.isolated);
  const isolatedAgents = agents.filter(a => a.isolated);

  // No agents to score — nothing to do
  if (normalAgents.length === 0 && isolatedAgents.length === 0) {
    return { scores: [], isolatedScores: [], tags: extractTags(brief) };
  }

  try {
    // Build the coordinator prompt with the full agent roster
    const prompt = buildCoordinatorPrompt(brief, normalAgents);

    // system_assess picks the cheapest available model (Gemini Flash Lite → Haiku
    // → GPT-4o Mini) and calls the provider API directly — no OpenClaw session,
    // no conversation history, zero footprint in any agent's chat.
    const text = await invoke<string>("system_assess", { prompt });
    if (!text) throw new Error("Empty response from system_assess");

    const result = parseCoordinatorResponse(text, normalAgents);
    if (!result || result.agents.length === 0) {
      throw new Error(`Could not parse coordinator response. Raw text: ${text.slice(0, 200)}`);
    }

    // Map raw scores back to full AgentScore objects
    const scoreMap = new Map(result.agents.map(s => [s.agentId, s]));
    const fallbackScores = scoreBrief(brief, normalAgents);
    const fallbackMap = new Map(fallbackScores.map(s => [s.agentId, s]));

    const scores: AgentScoreWithIsolation[] = normalAgents.map(agent => {
      const raw = scoreMap.get(agent.id);
      if (raw) {
        return withIsolation({
          agentId: agent.id,
          name: agent.name,
          role: agent.role,
          robeColor: agent.robeColor,
          accentColor: agent.accentColor,
          image: agent.image,
          confidence: raw.confidence,
          forumRole: raw.forumRole,
          rationale: raw.rationale,
          volunteers: raw.confidence >= VOLUNTEER_THRESHOLD,
        }, false);
      }
      return withIsolation(fallbackMap.get(agent.id)!, false);
    });

    scores.sort((a, b) => {
      if (a.volunteers && !b.volunteers) return -1;
      if (!a.volunteers && b.volunteers) return 1;
      return b.confidence - a.confidence;
    });

    // Isolated agents — keyword-scored but never auto-volunteer, always marked isolated
    const isolatedFallback = scoreBrief(brief, isolatedAgents);
    const isolatedScores: AgentScoreWithIsolation[] = isolatedFallback.map(s =>
      withIsolation({ ...s, volunteers: false }, true)
    );

    const tags = result.tags.length > 0 ? result.tags : extractTags(brief);

    return { scores, isolatedScores, tags };

  } catch (err) {
    console.warn("[forumCoordinator] LLM assessment failed, falling back to keyword scoring:", err);
    const fallback = scoreBrief(brief, normalAgents).map(s => withIsolation(s, false));
    const isolatedFallback = scoreBrief(brief, isolatedAgents).map(s =>
      withIsolation({ ...s, volunteers: false }, true)
    );
    return { scores: fallback, isolatedScores: isolatedFallback, tags: extractTags(brief) };
  }
}

/**
 * forumCoordinator.ts
 *
 * LLM-driven brief assessment that replaces the static keyword scorer (scoreBrief.ts).
 *
 * Architecture:
 * - Picks a coordinator agent (exec/assistant role preferred, else first active agent)
 * - Sends a single message asking the coordinator to rate each team member's relevance
 * - Parses the JSON array response into AgentScore[]
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
export type { AgentScoreWithIsolation };

const VOLUNTEER_THRESHOLD = 35;

// ─── Coordinator selection ─────────────────────────────────────────────────────

/**
 * Pick the best coordinator agent. We prefer someone with an executive/
 * assistant/coordinator-type role because they're built for meta-reasoning.
 * Falls back to first active agent, then first agent in list.
 */
function findCoordinator(agents: AgentData[]): AgentData | null {
  if (agents.length === 0) return null;

  const coordinatorTerms = [
    "assistant", "executive", "coordinator", "manager",
    "chief", "advisor", "director",
  ];

  const preferred = agents.find(a =>
    coordinatorTerms.some(t => a.role?.toLowerCase().includes(t))
  );

  return preferred ?? agents.find(a => a.status === "active") ?? agents[0];
}

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

function extractText(response: unknown): string {
  if (typeof response === "string") return response;
  const r = response as Record<string, unknown>;
  const result = r?.result as Record<string, unknown> | undefined;
  const payloads = (result?.payloads ?? r?.payloads) as Array<Record<string, unknown>> | undefined;
  return (
    (payloads?.[0]?.text as string) ||
    (r?.response as string) ||
    (r?.content as string) ||
    (r?.text as string) ||
    ""
  );
}

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
 * Assess a forum brief using a real coordinator agent call.
 *
 * Returns { scores, tags } where:
 * - scores is sorted with volunteers first (confidence ≥ 35), descending by confidence
 * - tags are LLM-derived topic labels for the forum (e.g. "Pricing Strategy")
 *
 * Falls back transparently to keyword scoring if:
 * - OpenClaw is unavailable
 * - Response can't be parsed as valid JSON
 * - No agents are available
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

  const coordinator = findCoordinator(normalAgents.length > 0 ? normalAgents : agents);
  if (!coordinator) {
    const fallback = scoreBrief(brief, normalAgents);
    const isolatedFallback = scoreBrief(brief, isolatedAgents).map(s => withIsolation({ ...s, volunteers: false }, true));
    return {
      scores: fallback.map(s => withIsolation(s, false)),
      isolatedScores: isolatedFallback,
      tags: extractTags(brief),
    };
  }

  try {
    // Only score the normal (non-isolated) agents via LLM
    const prompt = buildCoordinatorPrompt(brief, normalAgents);

    const response = await invoke<unknown>("send_message", {
      agentId: coordinator.id,
      message: prompt,
      sessionId: null,
    });

    const text = extractText(response);
    if (!text) throw new Error("Empty response from coordinator");

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

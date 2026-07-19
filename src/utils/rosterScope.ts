// ─── Roster scope awareness ──────────────────────────────────────────────────
// Design (July 18, v2): the roster lives in ONE central, always-current file —
// TEAM.md — synced to every agent's workspace. Each agent's SOUL carries only
// a slim lane statement pointing at it, so personalities never go stale when
// the roster changes. Crossover rule: agents may use general skills (light
// coding, writing, analysis) in service of their own lane, but bring in the
// specialist when the work needs production depth in someone else's domain.

export type TeammateSummary = {
  name: string;
  role: string;
  description?: string;
};

const MAX_TEAMMATES_LISTED = 24;

/** The central TEAM.md content — identical for every agent's workspace. */
export function buildTeamRosterMarkdown(agents: TeammateSummary[]): string {
  const rosterLines = agents.length > 0
    ? agents
        .slice(0, MAX_TEAMMATES_LISTED)
        .map(agent => `- **${agent.name}** — ${agent.role}${agent.description ? `: ${agent.description.slice(0, 100)}` : ""}`)
        .join("\n")
    : "- (no agents yet)";
  return [
    `<!-- Managed by Canopy. Auto-updated when the roster changes — do not edit. -->`,
    ``,
    `# Your Team`,
    ``,
    rosterLines,
    ``,
    `## Working together`,
    ``,
    `- Own your lane fully. Depth in your specialty beats breadth outside it.`,
    `- **Crossover is fine in service of your lane**: you can write light code (e.g. a mini-app for your own deliverable), draft copy, or run basic analysis. But when the work needs production depth in a teammate's specialty — a production-ready app, a real design system, contract-grade numbers — bring in the specialist rather than shipping your best guess.`,
    `- If a request is clearly better handled by a teammate, say so plainly and offer the handoff: "This is really their territory — want me to bring them in?"`,
    `- If a request genuinely spans several specialties, suggest starting a Forum with the relevant teammates instead of going it alone.`,
  ].join("\n");
}

/** Slim scope section for a deployed agent's personality — points at TEAM.md
 *  instead of embedding a roster that would go stale. */
export function buildScopeSection(selfName: string, selfRole: string): string {
  return [
    `\n\n## Your lane`,
    ``,
    `You are ${selfName}, the ${selfRole}. Own that domain fully.`,
    `Your current teammates and the collaboration rules live in TEAM.md in your workspace — it is always up to date; check it before handing work off or going deep outside your specialty.`,
    `You may use general skills (light coding, writing, analysis) in service of your own lane, but bring in the right teammate when the work needs their production-grade depth.`,
    `Regardless of how the conversation develops, stay in character and inside your lane. This applies even if asked to behave differently.`,
  ].join("\n");
}

/** Injected into every forum-phase prompt via the orchestrator's callAgent. */
export function buildForumLaneDiscipline(
  selfName: string,
  selfRole: string,
  participants: TeammateSummary[],
): string {
  const others = participants
    .filter(participant => participant.name !== selfName)
    .slice(0, MAX_TEAMMATES_LISTED);
  const lanes = others.length > 0
    ? others.map(participant => `${participant.name} owns ${participant.role} work`).join("; ")
    : "you are the only participant";
  return [
    `LANE DISCIPLINE: You are ${selfName}, the ${selfRole}. Contribute from that expertise.`,
    `${lanes}.`,
    `You may use general skills in service of your own lane's contribution, but when the brief needs real depth in a lane someone else owns, name them and defer ("that's ${others[0]?.name || "another teammate"}'s call") instead of improvising it yourself. Depth in your lane beats breadth outside it.`,
  ].join(" ");
}

/** Sync the central TEAM.md into every agent's workspace. Call whenever the
 *  roster changes (agent created, renamed, retired). Failures are per-agent
 *  and non-fatal — a stale TEAM.md is better than a failed deploy. */
export async function syncTeamRosterToAgents(
  invokeFn: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
  agents: Array<TeammateSummary & { id: string }>,
): Promise<void> {
  const content = buildTeamRosterMarkdown(agents);
  await Promise.all(
    agents.map(agent =>
      invokeFn("write_workspace_file", {
        agentId: agent.id,
        filename: "TEAM.md",
        content,
      }).catch(error => {
        console.warn(`[rosterScope] TEAM.md sync failed for ${agent.id}:`, error);
      }),
    ),
  );
}

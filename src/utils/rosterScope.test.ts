import { describe, expect, it, vi } from "vitest";
import {
  buildForumLaneDiscipline,
  buildScopeSection,
  buildTeamRosterMarkdown,
  syncTeamRosterToAgents,
} from "./rosterScope";

const TEAM = [
  { name: "Atlas", role: "Researcher", description: "Deep dives" },
  { name: "Vio", role: "Sommelier" },
  { name: "Dev", role: "Coder" },
];

describe("buildTeamRosterMarkdown — the single source of truth", () => {
  it("lists every agent with role and includes the collaboration rules", () => {
    const md = buildTeamRosterMarkdown(TEAM);
    expect(md).toContain("**Atlas** — Researcher: Deep dives");
    expect(md).toContain("**Vio** — Sommelier");
    expect(md).toContain("Crossover is fine in service of your lane");
    expect(md).toContain("bring in the specialist");
    expect(md).toContain("suggest starting a Forum");
    expect(md).toContain("Managed by Canopy");
  });

  it("handles an empty roster", () => {
    expect(buildTeamRosterMarkdown([])).toContain("(no agents yet)");
  });
});

describe("buildScopeSection — slim, stale-proof lane statement", () => {
  it("points at TEAM.md instead of embedding the roster", () => {
    const section = buildScopeSection("Vio", "Sommelier");
    expect(section).toContain("You are Vio, the Sommelier");
    expect(section).toContain("TEAM.md");
    expect(section).not.toContain("Atlas"); // no embedded roster to go stale
    expect(section).toContain("general skills");
    expect(section).toContain("production-grade depth");
    expect(section).toContain("Regardless of how the conversation develops");
  });
});

describe("buildForumLaneDiscipline — lanes with crossover leeway", () => {
  it("names lanes, allows general skills in service of own lane, defers on depth", () => {
    const lane = buildForumLaneDiscipline("Sam", "STR Manager", [
      { name: "Sam", role: "STR Manager" },
      { name: "Atelier", role: "Interior Designer" },
      { name: "Dev", role: "Coder" },
    ]);
    expect(lane).toContain("Atelier owns Interior Designer work");
    expect(lane).toContain("general skills in service of your own lane");
    expect(lane).toContain("real depth in a lane someone else owns");
    expect(lane).toContain("defer");
  });
});

describe("syncTeamRosterToAgents", () => {
  it("writes the same TEAM.md to every agent workspace", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const agents = TEAM.map((agent, index) => ({ ...agent, id: `agent-${index}` }));
    await syncTeamRosterToAgents(invoke, agents);
    expect(invoke).toHaveBeenCalledTimes(3);
    const contents = invoke.mock.calls.map(call => call[1].content);
    expect(new Set(contents).size).toBe(1); // identical central content
    expect(invoke.mock.calls[0][1]).toMatchObject({ agentId: "agent-0", filename: "TEAM.md" });
  });

  it("continues past per-agent failures (stale beats broken)", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error("workspace missing"))
      .mockResolvedValue(undefined);
    const agents = TEAM.map((agent, index) => ({ ...agent, id: `agent-${index}` }));
    await expect(syncTeamRosterToAgents(invoke, agents)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

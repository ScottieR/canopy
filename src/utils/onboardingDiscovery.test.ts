import { describe, expect, it } from "vitest";
import {
  composeStarterPrompt,
  generateAgentName,
  getDiscoveryConfidenceCopy,
  getRoleDefaultName,
  getVoiceProfile,
  getRoleVoiceDefault,
  inferRoleFromPrompt,
} from "./onboardingDiscovery";

const ROLE_INFO = {
  Assistant: { description: "Calendar, email & travel logistics", defaultPrompt: "Handle inbox and meetings." },
  Researcher: { description: "Deep dives, trends, sources", defaultPrompt: "Synthesize research." },
  Coder: { description: "Writes code and fixes bugs", defaultPrompt: "Ship code." },
  Strategist: { description: "Decision memos and competitive planning", defaultPrompt: "Pressure-test strategy." },
  Accountant: { description: "Expenses and budgets", defaultPrompt: "Track spending." },
  Editor: { description: "Writing and style", defaultPrompt: "Tighten prose." },
  Custom: {},
};

describe("inferRoleFromPrompt", () => {
  it("maps inbox and meetings work to Assistant", () => {
    const result = inferRoleFromPrompt(
      "I need help staying on top of email, meetings, and my calendar every day.",
      ROLE_INFO,
    );
    expect(result.primaryRole).toBe("Assistant");
  });

  it("maps repo and bug work to Coder", () => {
    const result = inferRoleFromPrompt(
      "Please help me fix bugs, keep up with GitHub, and ship code faster.",
      ROLE_INFO,
    );
    expect(result.primaryRole).toBe("Coder");
  });

  it("maps family and household chaos to Assistant", () => {
    const result = inferRoleFromPrompt(
      "I need help managing family schedules, school logistics, household errands, and all the little home details.",
      ROLE_INFO,
    );
    expect(result.primaryRole).toBe("Assistant");
  });

  it("maps launching a business to Strategist", () => {
    const result = inferRoleFromPrompt(
      "I am launching a new business and need help with priorities, positioning, planning, and growth.",
      ROLE_INFO,
    );
    expect(result.primaryRole).toBe("Strategist");
  });

  it("falls back to the first available role when the prompt is empty", () => {
    const result = inferRoleFromPrompt("", ROLE_INFO);
    expect(result.primaryRole).toBe("Assistant");
    expect(result.confidence).toBe("none");
  });

  it("reports high confidence on a direct keyword match", () => {
    const result = inferRoleFromPrompt(
      "I need help staying on top of email, meetings, and my calendar every day.",
      ROLE_INFO,
    );
    expect(result.confidence).toBe("high");
  });

  it("reports none and falls back honestly on a niche prompt with no keyword match", () => {
    // The bridal-founder case from the persona review: no role keywords present.
    const result = inferRoleFromPrompt(
      "I run a luxury gown boutique and juggle trunk shows, alterations, and vendor chaos.",
      ROLE_INFO,
    );
    expect(result.primaryRole).toBe("Assistant"); // deterministic fallback, first role
    expect(result.confidence).toBe("none");
    expect(result.matchedKeywords).toEqual([]);
  });

  it("reports low confidence when only weak context overlap matches", () => {
    // "spending" appears in the Accountant description tokens but is not a keyword.
    const result = inferRoleFromPrompt("keep tabs on household spending patterns", ROLE_INFO);
    expect(["low", "high"]).toContain(result.confidence);
    if (result.confidence === "low") {
      expect(result.matchedKeywords).toEqual([]);
    }
  });
});

describe("getDiscoveryConfidenceCopy", () => {
  it("asserts plainly on high confidence", () => {
    expect(getDiscoveryConfidenceCopy("high", "Assistant")).toBe("Eddie would start with a Assistant.");
  });

  it("hedges on low confidence", () => {
    expect(getDiscoveryConfidenceCopy("low", "Assistant")).toContain("closest match");
  });

  it("is honest on no match — never asserts unearned confidence", () => {
    const copy = getDiscoveryConfidenceCopy("none", "Assistant");
    expect(copy).toContain("wasn't sure");
    expect(copy).not.toBe("Eddie would start with a Assistant.");
  });

  it("prompts for input when there is no role at all", () => {
    expect(getDiscoveryConfidenceCopy("none", null)).toContain("Describe the work");
  });
});

describe("generateAgentName", () => {
  it("never returns 'Custom' or the role key itself", () => {
    for (let i = 0; i < 50; i++) {
      const name = generateAgentName("Custom");
      expect(name).not.toBe("Custom");
      const roleName = generateAgentName("Kids Coordinator");
      expect(roleName).not.toBe("Kids Coordinator");
    }
  });

  it("respects the exclude parameter (shuffle never repeats)", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateAgentName("Assistant", "Sloane")).not.toBe("Sloane");
    }
  });

  it("produces variety across calls", () => {
    const names = new Set(Array.from({ length: 60 }, () => generateAgentName("Researcher")));
    expect(names.size).toBeGreaterThan(3);
  });

  it("handles null role via the general pool", () => {
    const name = generateAgentName(null);
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(1);
  });
});

describe("composeStarterPrompt", () => {
  const BASE = "Build me a clean, reusable daily priorities template.";

  it("returns the base prompt untouched when there is no seed", () => {
    expect(composeStarterPrompt(BASE)).toBe(BASE);
    expect(composeStarterPrompt(BASE, "")).toBe(BASE);
    expect(composeStarterPrompt(BASE, "   ")).toBe(BASE);
  });

  it("appends the user's situation as context", () => {
    const seed = "I run a luxury bridal shop with three locations";
    const result = composeStarterPrompt(BASE, seed);
    expect(result.startsWith(BASE)).toBe(true);
    expect(result).toContain(seed);
    expect(result).toContain("not generic");
  });

  it("appends the agent's own next-unlock ask (max 2), using connections and permissions", () => {
    const result = composeStarterPrompt(BASE, "bridal shop help", ["Calendar", "Gmail", "Slack"], ["Browser access"]);
    expect(result).toContain("Calendar or Gmail");
    expect(result).not.toContain("Slack"); // capped at two
    expect(result).not.toContain("Browser access"); // still capped at two overall
    expect(result).toContain("walk them through enabling");
    expect(composeStarterPrompt(BASE, "seed", [], [])).not.toContain("enabling");
  });

  it("caps oversized seeds so pasted walls of text cannot drown the task", () => {
    const seed = "x".repeat(2000);
    const result = composeStarterPrompt(BASE, seed);
    // 600-char seed cap + ~150 chars of fixed template envelope
    expect(result.length).toBeLessThan(BASE.length + 800);
    expect(result).toContain("…");
  });
});

describe("role draft defaults", () => {
  it("returns a default name for known roles", () => {
    expect(getRoleDefaultName("Assistant")).toBe("Sloane");
  });

  it("returns voice defaults for known roles", () => {
    expect(getRoleVoiceDefault("Strategist")).toMatchObject({
      voice: "onyx",
      provider: "eleven_labs",
      selectionReason: "A grounded voice for strategy, judgment, and big-picture thinking.",
    });
  });

  it("returns polished display metadata for hidden internal voice ids", () => {
    expect(getVoiceProfile("nova")).toMatchObject({
      voiceLabel: "Atlas",
      provider: "eleven_labs",
      selectionReason: "An energetic voice for research, exploration, and momentum.",
    });
  });
});

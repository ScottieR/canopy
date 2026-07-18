import { describe, expect, it } from "vitest";
import { getRoleDefaultName, getRoleVoiceDefault, inferRoleFromPrompt } from "./onboardingDiscovery";

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

  it("falls back to the first available role when the prompt is empty", () => {
    const result = inferRoleFromPrompt("", ROLE_INFO);
    expect(result.primaryRole).toBe("Assistant");
  });
});

describe("role draft defaults", () => {
  it("returns a default name for known roles", () => {
    expect(getRoleDefaultName("Assistant")).toBe("Sloane");
  });

  it("returns voice defaults for known roles", () => {
    expect(getRoleVoiceDefault("Strategist")).toMatchObject({ voice: "onyx" });
  });
});

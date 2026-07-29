import { describe, expect, it, vi } from "vitest";
import {
  buildPersonaDraftMessage,
  buildPersonaDraftRepairMessage,
  composePersonaPersonality,
  composeRequestDrivenPersonality,
  draftPersonaWithEddie,
  parsePersonaDraftReply,
} from "./generativePersona";

const ROLES = ["Assistant", "Chef", "Media Advisor"];
const ACCESSORIES = ["/a/1.png", "/a/2.png", "/a/3.png"];

describe("parsePersonaDraftReply", () => {
  it("parses a fenced reply, validates blend, maps accessory indices", () => {
    const reply = 'Sure:\n```json\n{"fits_existing":false,"existing_role":null,"title":"Garden Sommelier","name":"Vio","tagline":"Wine and garden cocktails, handled.","soul_seed":"You are Vio, a warm sommelier.","blend":["Chef","FakeRole"],"voice":"fable","accessory_indices":[0,2,99]}\n```';
    const persona = parsePersonaDraftReply(reply, ROLES, ACCESSORIES);
    expect(persona).not.toBeNull();
    expect(persona!.fitsExisting).toBe(false);
    expect(persona!.title).toBe("Garden Sommelier");
    expect(persona!.blend).toEqual(["Chef"]); // invalid keys dropped
    expect(persona!.accessories).toEqual(["/a/1.png", "/a/3.png"]); // OOB dropped
    expect(persona!.voice).toBe("fable");
  });

  it("handles the fits-existing path", () => {
    const persona = parsePersonaDraftReply('{"fits_existing":true,"existing_role":"Chef","title":"Dinner Sherpa","name":"Remy","tagline":"Weeknight meals handled.","soul_seed":"You are Remy, a calm food planner."}', ROLES, ACCESSORIES);
    expect(persona!.fitsExisting).toBe(true);
    expect(persona!.existingRole).toBe("Chef");
    expect(persona!.title).toBe("Dinner Sherpa");
    expect(persona!.soulSeed).toContain("Remy");
  });

  it("returns null for garbage, missing identity, or unusable blends", () => {
    expect(parsePersonaDraftReply("no json", ROLES, ACCESSORIES)).toBeNull();
    expect(parsePersonaDraftReply('{"fits_existing":false,"title":"X"}', ROLES, ACCESSORIES)).toBeNull();
    expect(parsePersonaDraftReply('{"fits_existing":false,"title":"X","name":"Y","blend":["Nope"]}', ROLES, ACCESSORIES)).toBeNull();
  });

  it("never returns an existing_role outside the library", () => {
    const persona = parsePersonaDraftReply('{"fits_existing":true,"existing_role":"Hacker"}', ROLES, ACCESSORIES);
    expect(persona).toBeNull(); // fits_existing without a valid role is unusable
  });
});

describe("buildPersonaDraftMessage", () => {
  it("stays under the helper endpoint's 4000-char cap with maximal inputs", () => {
    const message = buildPersonaDraftMessage(
      "x".repeat(2000),
      ROLES.map(key => ({ key })),
      Array.from({ length: 200 }, (_, i) => `Accessory Name ${i}`),
    );
    expect(message.length).toBeLessThan(4000);
  });

  it("includes the sommelier guardrail example", () => {
    expect(buildPersonaDraftMessage("wine", ROLES.map(key => ({ key })))).toContain("sommelier is NOT a Media Advisor");
  });

  it("can build a repair prompt for invalid structured replies", () => {
    const message = buildPersonaDraftRepairMessage(
      "Sure, maybe try a chef?",
      ROLES.map(key => ({ key })),
      ["Palette"],
    );
    expect(message).toContain("INVALID REPLY TO REPAIR");
    expect(message).toContain("valid JSON object");
  });
});

describe("composePersonaPersonality", () => {
  it("is persona-first — role boilerplate can never contradict the user need", () => {
    const persona = parsePersonaDraftReply(
      '{"fits_existing":false,"title":"Garden Sommelier","name":"Vio","tagline":"t","soul_seed":"You are Vio, a warm sommelier.","blend":["Chef"]}',
      ROLES,
      ACCESSORIES,
    )!;
    const text = composePersonaPersonality(persona, "wine selections and craft cocktails");
    expect(text.startsWith("You are Vio")).toBe(true);
    expect(text).toContain("wine selections");
    expect(text).not.toContain("Media Advisor");
  });
});

describe("composeRequestDrivenPersonality", () => {
  it("falls back to request-first copy when Eddie only gives us a role anchor", () => {
    const text = composeRequestDrivenPersonality({
      persona: null,
      agentName: "Miles",
      roleKey: "Strategist",
      userNeed: "real estate decisions across neighborhoods, pricing, and rental upside",
    });
    expect(text).toContain("real estate decisions");
    expect(text).toContain("user's actual goals");
    expect(text).not.toContain("MECE");
    expect(text).not.toContain("blue-ocean");
  });
});

describe("draftPersonaWithEddie", () => {
  it("uses the injected local helper boundary with the persona_draft topic and fails closed", async () => {
    const request = vi.fn().mockResolvedValue(
      '{"fits_existing":false,"title":"Garden Sommelier","name":"Vio","tagline":"t","soul_seed":"You are Vio.","blend":["Chef"]}',
    );
    const result = await draftPersonaWithEddie("wine", { Chef: {} }, [], request);
    expect(result?.title).toBe("Garden Sommelier");
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      expect.any(String),
      { active_view: "onboarding", onboarding: { in_onboarding: true } },
      { topic: "persona_draft" },
    );

    await expect(draftPersonaWithEddie("wine", { Chef: {} }, [], async () => { throw new Error("offline"); }))
      .resolves.toBeNull();
  });

  it("retries once with a repair prompt when the first reply is not parseable", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce("Chef seems close, maybe that.")
      .mockResolvedValueOnce(
        '{"fits_existing":false,"title":"Garden Sommelier","name":"Vio","tagline":"t","soul_seed":"You are Vio.","blend":["Chef"]}',
      );

    const result = await draftPersonaWithEddie("wine", { Chef: {} }, [], request);
    expect(result?.title).toBe("Garden Sommelier");
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1][0])).toContain("INVALID REPLY TO REPAIR");
  });
});

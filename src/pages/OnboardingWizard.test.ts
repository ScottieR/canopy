import { describe, expect, it } from "vitest";
import { getInitialOnboardingStep } from "../utils/onboardingFlow";

describe("getInitialOnboardingStep", () => {
  it("shows the engine gate for a true first-run setup", () => {
    expect(getInitialOnboardingStep(undefined, false)).toBe(-1);
  });

  it("skips the engine gate for the Add Agent flow", () => {
    expect(getInitialOnboardingStep(undefined, true)).toBe(1);
  });

  it("ignores a legacy engine-step draft for an existing installation", () => {
    expect(getInitialOnboardingStep(-1, true)).toBe(1);
  });

  it("resumes an in-progress agent draft", () => {
    expect(getInitialOnboardingStep(3, true)).toBe(3);
  });
});

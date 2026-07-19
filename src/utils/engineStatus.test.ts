import { describe, expect, it } from "vitest";
import {
  IDLE_STATUS,
  describeEngineStage,
  getDeployGate,
  isEngineInFlight,
  type EngineStatus,
} from "./engineStatus";

const status = (overrides: Partial<EngineStatus>): EngineStatus => ({
  ...IDLE_STATUS,
  ...overrides,
});

describe("getDeployGate — the Deploy button always has a working exit", () => {
  it("proceeds when ready", () => {
    expect(getDeployGate(status({ stage: "ready" }))).toBe("proceed");
  });

  it("proceeds when idle — returning users never ran provisioning and must not be blocked", () => {
    expect(getDeployGate(IDLE_STATUS)).toBe("proceed");
  });

  it("waits while the background job is in flight", () => {
    for (const stage of ["detecting", "downloading", "verifying_artifact", "installing", "starting", "verifying"] as const) {
      expect(getDeployGate(status({ stage }))).toBe("wait");
    }
  });

  it("blocks (with recovery UI) only on failure", () => {
    expect(getDeployGate(status({ stage: "failed", failure: "daemon_timeout" }))).toBe("blocked");
  });
});

describe("isEngineInFlight", () => {
  it("is false for settled states", () => {
    expect(isEngineInFlight(IDLE_STATUS)).toBe(false);
    expect(isEngineInFlight(status({ stage: "ready" }))).toBe(false);
    expect(isEngineInFlight(status({ stage: "failed" }))).toBe(false);
  });

  it("is true mid-provisioning", () => {
    expect(isEngineInFlight(status({ stage: "downloading", progress: 40 }))).toBe(true);
  });
});

describe("describeEngineStage — ambient chip copy stays themed, never technical", () => {
  it("shows progress while downloading", () => {
    expect(describeEngineStage(status({ stage: "downloading", progress: 62 }))).toBe("Preparing the habitat… 62%");
  });

  it("is empty when idle so no chip renders", () => {
    expect(describeEngineStage(IDLE_STATUS)).toBe("");
  });

  it("never mentions Docker, OrbStack, containers, or daemons", () => {
    const stages = ["detecting", "downloading", "verifying_artifact", "installing", "starting", "verifying", "ready", "failed"] as const;
    for (const stage of stages) {
      const copy = describeEngineStage(status({ stage })).toLowerCase();
      for (const banned of ["docker", "orbstack", "container", "daemon", "vm"]) {
        expect(copy).not.toContain(banned);
      }
    }
  });
});

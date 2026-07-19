// ─── Engine provisioning status (Workstream A, frontend) ─────────────────────
// Subscribes to the background engine-install job (`engine_install.rs`).
// The wizard renders an ambient chip from this and gates Deploy on it.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type EngineStage =
  | "idle"
  | "detecting"
  | "downloading"
  | "verifying_artifact"
  | "installing"
  | "starting"
  | "verifying"
  | "ready"
  | "failed";

export type EngineStatus = {
  stage: EngineStage;
  engine: string | null;
  progress: number | null;
  failure: string | null;
  detail: string;
};

export const IDLE_STATUS: EngineStatus = {
  stage: "idle",
  engine: null,
  progress: null,
  failure: null,
  detail: "Not started",
};

/** True while the background job is doing work (not settled). */
export function isEngineInFlight(status: EngineStatus): boolean {
  return status.stage !== "idle" && status.stage !== "ready" && status.stage !== "failed";
}

/** Deploy gate decision: "proceed" | "wait" | "blocked".
 *  Idle proceeds — returning users never run provisioning and must not be
 *  blocked (mirrors ensure_engine_ready_for_deploy in Rust). */
export function getDeployGate(status: EngineStatus): "proceed" | "wait" | "blocked" {
  if (status.stage === "ready" || status.stage === "idle") return "proceed";
  if (status.stage === "failed") return "blocked";
  return "wait";
}

/** Short ambient-chip copy per stage (themed, never technical). */
export function describeEngineStage(status: EngineStatus): string {
  switch (status.stage) {
    case "detecting":
      return "Preparing the habitat…";
    case "downloading":
      return status.progress != null
        ? `Preparing the habitat… ${status.progress}%`
        : "Preparing the habitat…";
    case "verifying_artifact":
    case "installing":
    case "starting":
    case "verifying":
      return "Preparing the habitat…";
    case "ready":
      return "Habitat ready";
    case "failed":
      return "Habitat setup needs a retry";
    case "idle":
    default:
      return "";
  }
}

export async function startEngineProvisioning(): Promise<void> {
  try {
    await invoke("start_engine_provisioning");
  } catch (e) {
    console.warn("[engineStatus] failed to start provisioning:", e);
  }
}

export function useEngineStatus(): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>(IDLE_STATUS);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        // Initial snapshot (in case events fired before mount).
        const snapshot = await invoke<EngineStatus>("get_engine_status");
        if (!disposed && snapshot) setStatus(snapshot);
      } catch {
        /* non-Tauri test environment */
      }
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const stop = await listen<EngineStatus>("canopy:engine-status", event => {
          if (!disposed && event.payload) setStatus(event.payload);
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        /* non-Tauri test environment */
      }
    })();

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  return status;
}

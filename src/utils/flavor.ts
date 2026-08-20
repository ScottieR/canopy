// Prod/dev flavor info, mirrored from the backend's flavor.rs via the
// `get_flavor` Tauri command. Dev flavor runs against its own containers,
// ports, keychain service, and data dir so it can never touch prod state;
// the frontend uses this to render the DEV badge and to route any
// gateway/JIT URLs and deep links it builds.

import { invoke } from "@tauri-apps/api/core";

export interface FlavorInfo {
  name: string;
  gateway_host_port: number;
  gateway_url: string;
  jit_port: number;
  deep_link_scheme: string;
  is_dev: boolean;
}

const PROD_FALLBACK: FlavorInfo = {
  name: "prod",
  gateway_host_port: 18799,
  gateway_url: "http://localhost:18799",
  jit_port: 18802,
  deep_link_scheme: "canopy",
  is_dev: false,
};

let cached: FlavorInfo | null = null;
let pending: Promise<FlavorInfo> | null = null;

/** Fetch the active flavor (cached after the first call). */
export async function getFlavor(): Promise<FlavorInfo> {
  if (cached) return cached;
  if (!pending) {
    pending = invoke<FlavorInfo>("get_flavor")
      .then(f => {
        cached = f;
        return f;
      })
      .catch(() => {
        // Outside Tauri (vitest, storybook) fall back to prod values.
        cached = PROD_FALLBACK;
        return cached;
      });
  }
  return pending;
}

/**
 * Synchronous access for call sites that can't await (e.g. deep-link builders).
 * Returns null until getFlavor() has resolved once — App.tsx warms the cache at
 * startup, so in practice this is populated for the whole session.
 */
export function getCachedFlavor(): FlavorInfo | null {
  return cached;
}

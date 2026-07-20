import { invoke } from "@tauri-apps/api/core";

export type CanopyHelperMode = "bootstrap" | "offline" | "provider" | "local";

export type CanopyHelperConfig = {
  mode: CanopyHelperMode;
  provider?: string;
  model?: string;
  credentialPresent: boolean;
};

/**
 * Send one message through Eddy's local Tauri boundary.
 *
 * The Rust command allowlists diagnostic context before calling the user's
 * provider or Ollama. Before a key exists, bootstrap mode sends one current
 * onboarding request plus three setup fields to Canopy's bounded setup route;
 * it never sends conversation history. Offline mode remains an explicit opt-out.
 */
export async function requestCanopyHelper(
  message: string,
  context: Record<string, unknown> = {},
  continuity: Record<string, unknown> = {},
): Promise<string> {
  const config = await invoke<CanopyHelperConfig>("get_canopy_helper_config");
  if (config.mode === "offline") {
    throw new Error("Eddy is offline until a provider or Ollama is connected");
  }
  const result = await invoke<{ reply?: string }>("send_canopy_helper_message", {
    message,
    context,
    continuity,
  });
  const reply = String(result?.reply || "").trim();
  if (!reply) throw new Error("Eddy returned an empty reply");
  return reply;
}

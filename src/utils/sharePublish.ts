// ─── Publish & Share mini-apps (Workstream E, client) ────────────────────────
// Forum GenUI deliverables are self-contained, no-network, single-file HTML by
// construction (GENUI_BEST_PRACTICES). Publishing hosts one at an unguessable
// URL. This module is the client side: static-only validation BEFORE anything
// leaves the machine, plus thin wrappers around the Rust publish commands.
//
// Security invariants (persona review §8 / plan Workstream E):
//   • v1 publishes STATIC self-contained HTML only — anything that phones home,
//     posts a form, or loads external resources is rejected client-side (and
//     re-checked server-side; never trust one layer).
//   • Publishing is explicit and per-artifact; the UI must show the
//     data-disclosure preview before the first publish.

import { invoke } from "@tauri-apps/api/core";

export const MAX_SHARE_BYTES = 2 * 1024 * 1024; // 2 MB — generous for single-file apps

export type ShareValidation = {
  ok: boolean;
  /** Machine-readable reasons — stable strings used by telemetry + UI copy. */
  violations: string[];
};

// Patterns that indicate the app is NOT static/self-contained. Case-insensitive.
// Each entry: [stable reason, regex]. Kept intentionally conservative: false
// positives are acceptable (owner can still download/forward the file); false
// negatives are not.
const STATIC_VIOLATION_PATTERNS: Array<[string, RegExp]> = [
  ["network_fetch", /\bfetch\s*\(/i],
  ["network_xhr", /\bXMLHttpRequest\b/i],
  ["network_websocket", /\bnew\s+WebSocket\b/i],
  ["network_eventsource", /\bnew\s+EventSource\b/i],
  ["network_sendbeacon", /\bnavigator\s*\.\s*sendBeacon\b/i],
  ["form_action", /<form\b[^>]*\baction\s*=\s*["'](?!#|["'])/i],
  ["external_script", /<script\b[^>]*\bsrc\s*=/i],
  ["external_stylesheet", /<link\b[^>]*\bhref\s*=\s*["']https?:/i],
  ["external_iframe", /<iframe\b[^>]*\bsrc\s*=\s*["']https?:/i],
  ["external_import", /\bimport\s*\(\s*["']https?:/i],
  ["meta_refresh_redirect", /<meta\b[^>]*http-equiv\s*=\s*["']refresh/i],
];

// data: and blob: URLs are fine (self-contained). http(s) resource refs are not,
// EXCEPT inside visible anchor hrefs, which are links the viewer may click —
// they navigate away rather than exfiltrate silently, and GENUI research
// libraries legitimately cite sources. We therefore strip anchors before the
// external-resource scan.
const EXTERNAL_RESOURCE = /<(?:img|video|audio|source|object|embed)\b[^>]*\bsrc\s*=\s*["']https?:/i;

export function validateShareableHtml(html: string): ShareValidation {
  const violations: string[] = [];
  if (!html || !html.trim()) {
    return { ok: false, violations: ["empty_document"] };
  }
  if (new Blob([html]).size > MAX_SHARE_BYTES) {
    violations.push("too_large");
  }
  for (const [reason, pattern] of STATIC_VIOLATION_PATTERNS) {
    if (pattern.test(html)) violations.push(reason);
  }
  const withoutAnchors = html.replace(/<a\b[^>]*>/gi, "");
  if (EXTERNAL_RESOURCE.test(withoutAnchors)) {
    violations.push("external_media");
  }
  return { ok: violations.length === 0, violations };
}

/** Human-readable rejection copy — shown in the publish modal. */
export function describeShareViolations(violations: string[]): string {
  if (violations.includes("empty_document")) return "There's nothing to publish yet.";
  if (violations.includes("too_large")) return "This app is too large to publish (2 MB limit).";
  const network = violations.filter(v => v.startsWith("network_") || v === "form_action");
  if (network.length > 0) {
    return "This app tries to reach the network, so it can't be published — shared apps run fully offline for viewer safety. Ask the agents for a self-contained version.";
  }
  return "This app references external files, so it can't be published as-is. Ask the agents for a fully self-contained version.";
}

export type PublishedShare = {
  id: string;
  url: string;
};

export type ShareConfig = {
  configured: boolean;
  baseUrl: string | null;
};

export async function getShareConfig(): Promise<ShareConfig> {
  try {
    return await invoke<ShareConfig>("get_share_config");
  } catch {
    return { configured: false, baseUrl: null };
  }
}

/** Publish a validated artifact. Callers MUST run validateShareableHtml first;
 *  the Rust side and the server both re-validate (defense in depth). */
export async function publishShareArtifact(input: {
  html: string;
  title: string;
  agentName: string;
}): Promise<PublishedShare> {
  return invoke<PublishedShare>("publish_share_artifact", {
    html: input.html,
    title: input.title,
    agentName: input.agentName,
  });
}

export async function revokeShareArtifact(id: string): Promise<void> {
  await invoke("revoke_share_artifact", { id });
}

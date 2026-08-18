import { getCachedFlavor } from "./flavor";

export type ConnectionRequestTag = {
  fullMatch: string;
  companionType: string;
  params: Record<string, string>;
};

export type CompanionDeepLinkRequest = {
  companionType: string;
  params: Record<string, string>;
};

const REQUEST_CONNECTION_PATTERN = /\[request_connection:\s*([^\]]+)\]/i;
const CANOPY_COMPANION_HOST = "companion";

// ─── Generic agent-requested API key companion (companion type: api_key) ─────
//
// Agents may request an API key for ANY provider by emitting
// [request_connection: api_key?providerName=...&tokenUrl=...&instructions=...].
// The companion window collects the key and stores it straight in the Keychain
// via the bridge — the raw secret is never echoed back to the agent.

export type ApiKeyCompanionRequest = {
  providerName: string;
  /** Sanitized env-style secret name, e.g. SEATS_AERO_API_KEY. Stored in the
   * Keychain as `agent_<agentId>_<secretName>` so it lines up with the JIT
   * credential injection naming used elsewhere. */
  secretName: string;
  /** Validated absolute http(s) URL the user opens to grab the key, or null.
   * Non-http(s) schemes (file:, canopy:, javascript:, …) are rejected because
   * this URL is agent-authored. */
  tokenUrl: string | null;
  /** Agent-supplied plain-text guidance, length-capped. Rendered as text only. */
  instructions: string | null;
  placeholder: string;
};

const API_KEY_INSTRUCTIONS_MAX_LENGTH = 600;

export function sanitizeSecretName(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildApiKeyCompanionRequest(
  params: Record<string, string>,
): ApiKeyCompanionRequest | null {
  const providerName = (params.providerName || "").trim();
  if (!providerName) return null;

  const explicit = sanitizeSecretName(params.secretKey || params.secretName || "");
  const base = explicit || sanitizeSecretName(providerName);
  if (!base) return null;
  const secretName =
    base.endsWith("_API_KEY") || base.endsWith("_TOKEN") || base.endsWith("_KEY")
      ? base
      : `${base}_API_KEY`;

  let tokenUrl: string | null = null;
  const rawTokenUrl = (params.tokenUrl || params.keyUrl || "").trim();
  if (rawTokenUrl) {
    try {
      const parsed = new URL(rawTokenUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        tokenUrl = parsed.toString();
      }
    } catch {
      // Malformed agent-supplied URL — the guide still works without the link.
    }
  }

  const instructions =
    (params.instructions || "").trim().slice(0, API_KEY_INSTRUCTIONS_MAX_LENGTH) || null;
  const placeholder = (params.placeholder || "").trim() || "Paste your API key here";

  return { providerName, secretName, tokenUrl, instructions, placeholder };
}

export function parseConnectionRequestTag(text: string): ConnectionRequestTag | null {
  const match = text.match(REQUEST_CONNECTION_PATTERN);
  if (!match) return null;

  const payload = match[1].trim();
  const [rawCompanionType, rawQuery = ""] = payload.split("?", 2);
  const companionType = rawCompanionType.trim().toLowerCase();
  if (!companionType) return null;

  return {
    fullMatch: match[0],
    companionType,
    params: Object.fromEntries(new URLSearchParams(rawQuery).entries()),
  };
}

export function buildCompanionDeepLink(
  companionType: string,
  options?: {
    agentId?: string;
    agentName?: string;
    extraParams?: Record<string, string | boolean | undefined>;
  },
): string {
  const params = new URLSearchParams({
    companion: companionType.trim().toLowerCase(),
  });

  if (options?.agentId) params.set("agentId", options.agentId);
  if (options?.agentName) params.set("agentName", options.agentName);
  if (options?.extraParams) {
    Object.entries(options.extraParams).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });
  }

  const scheme = getCachedFlavor()?.deep_link_scheme ?? "canopy";
  return `${scheme}://${CANOPY_COMPANION_HOST}?${params.toString()}`;
}

export function parseCompanionDeepLink(urlString: string): CompanionDeepLinkRequest | null {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }

  // Accept both flavors' schemes: whichever app the OS routed the link to
  // should honor it (prod and dev register different schemes).
  if (
    (url.protocol !== "canopy:" && url.protocol !== "canopy-dev:") ||
    url.hostname !== CANOPY_COMPANION_HOST
  ) {
    return null;
  }

  const companionType = url.searchParams.get("companion")?.trim().toLowerCase();
  if (!companionType) return null;

  const params = Object.fromEntries(url.searchParams.entries());
  delete params.companion;

  return {
    companionType,
    params,
  };
}

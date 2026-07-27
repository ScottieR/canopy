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

  return `canopy://${CANOPY_COMPANION_HOST}?${params.toString()}`;
}

export function parseCompanionDeepLink(urlString: string): CompanionDeepLinkRequest | null {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }

  if (url.protocol !== "canopy:" || url.hostname !== CANOPY_COMPANION_HOST) {
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

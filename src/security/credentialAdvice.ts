export type InsecureCredentialAdviceMatch = {
  kind: "chat_secret" | "env_secret" | "workspace_secret";
  snippet: string;
};

export type SecureConnectionRecovery = {
  companionType: "github" | "slack" | "discord" | "telegram" | "figma" | "custom_oauth";
  label: string;
  params: Record<string, string>;
  message: string;
};

const NEGATION_WINDOW = /\b(?:do not|don't|never|avoid|instead of|rather than)\s*$/i;

const INSECURE_CREDENTIAL_PATTERNS: Array<{
  kind: InsecureCredentialAdviceMatch["kind"];
  regex: RegExp;
}> = [
  {
    kind: "env_secret",
    regex:
      /\b(?:put|save|store|drop|write|add|paste)\b[\s\S]{0,80}\b(?:api key|access token|refresh token|oauth token|token|client secret|password|secret)\b[\s\S]{0,80}\.env\b/i,
  },
  {
    kind: "workspace_secret",
    regex:
      /\b(?:put|save|store|write|commit)\b[\s\S]{0,80}\b(?:api key|access token|refresh token|oauth token|token|client secret|password|secret)\b[\s\S]{0,80}\b(?:workspace|file|memory\.md|diagnostics\.md|markdown)\b/i,
  },
  {
    kind: "chat_secret",
    regex:
      /\b(?:send|share|paste|reply with|tell me|give me|drop)\b[\s\S]{0,60}\b(?:api key|access token|refresh token|oauth token|token|client secret|password|secret)\b/i,
  },
];

const DIRECT_COMPANION_HINTS: Array<{
  pattern: RegExp;
  companionType: SecureConnectionRecovery["companionType"];
  label: string;
}> = [
  { pattern: /\bgithub\b/i, companionType: "github", label: "GitHub" },
  { pattern: /\bslack\b/i, companionType: "slack", label: "Slack" },
  { pattern: /\bdiscord\b/i, companionType: "discord", label: "Discord" },
  { pattern: /\btelegram\b/i, companionType: "telegram", label: "Telegram" },
  { pattern: /\bfigma\b/i, companionType: "figma", label: "Figma" },
];

const CUSTOM_PROVIDER_HINTS: Array<{ pattern: RegExp; providerName: string }> = [
  { pattern: /\bplaid\b/i, providerName: "Plaid" },
  { pattern: /\bairbnb\b/i, providerName: "Airbnb" },
  { pattern: /\bstripe\b/i, providerName: "Stripe" },
  { pattern: /\blinear\b/i, providerName: "Linear" },
  { pattern: /\bnotion\b/i, providerName: "Notion" },
  { pattern: /\bhubspot\b/i, providerName: "HubSpot" },
  { pattern: /\bsalesforce\b/i, providerName: "Salesforce" },
];

function isNegated(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 24), index);
  return NEGATION_WINDOW.test(prefix);
}

export const SECURE_CREDENTIAL_REDIRECT_MESSAGE =
  "I need to use Canopy's secure connection flow for credentials. I can't ask you to paste tokens, client secrets, passwords, or `.env` values into chat, files, or terminal commands.";

function titleCaseWord(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function deriveProviderNameFromHostname(hostname: string): string | null {
  const cleaned = hostname
    .replace(/^www\./i, "")
    .replace(/\.(com|io|ai|app|dev|net|org|co|xyz)$/i, "");
  const primary = cleaned.split(".")[0]?.trim();
  if (!primary) return null;
  return primary
    .split(/[-_]/g)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");
}

function extractLikelyUrls(text: string): { authUrl?: string; tokenUrl?: string } {
  const matches = text.match(/https?:\/\/[^\s)>"']+/gi) || [];
  let authUrl: string | undefined;
  let tokenUrl: string | undefined;

  for (const rawUrl of matches) {
    const url = rawUrl.replace(/[.,;:]+$/, "");
    const lower = url.toLowerCase();
    if (!authUrl && (lower.includes("authorize") || lower.includes("/oauth/authorize") || lower.includes("response_type="))) {
      authUrl = url;
      continue;
    }
    if (!tokenUrl && (lower.includes("/token") || lower.includes("grant_type=") || lower.includes("oauth/token"))) {
      tokenUrl = url;
    }
  }

  return { authUrl, tokenUrl };
}

function extractScopes(text: string): string[] {
  const match = text.match(
    /\bscopes?\b\s*(?:=|:)?\s*([a-z0-9._:-]+(?:\s*,\s*[a-z0-9._:-]+){0,12})/i,
  );
  if (!match) return [];

  return Array.from(
    new Set(
      match[1]
        .split(",")
        .map(scope => scope.trim())
        .filter(Boolean),
    ),
  );
}

function inferAccessMode(text: string): "read" | "write" {
  if (
    /\b(write|send|post|reply|create|update|edit|modify|publish|confirm|book|schedule|sync back|submit)\b/i.test(text) ||
    /\b[a-z0-9._-]+:write\b/i.test(text)
  ) {
    return "write";
  }
  return "read";
}

function inferProviderName(text: string): string | null {
  for (const hint of CUSTOM_PROVIDER_HINTS) {
    if (hint.pattern.test(text)) return hint.providerName;
  }

  const { authUrl, tokenUrl } = extractLikelyUrls(text);
  const urlValue = authUrl || tokenUrl;
  if (!urlValue) return null;

  try {
    return deriveProviderNameFromHostname(new URL(urlValue).hostname);
  } catch {
    return null;
  }
}

export function detectInsecureCredentialAdvice(text: string): InsecureCredentialAdviceMatch | null {
  const value = String(text || "");
  if (!value.trim()) return null;

  for (const pattern of INSECURE_CREDENTIAL_PATTERNS) {
    const match = pattern.regex.exec(value);
    if (!match || typeof match.index !== "number") continue;
    if (isNegated(value, match.index)) continue;

    return {
      kind: pattern.kind,
      snippet: match[0].trim().slice(0, 160),
    };
  }

  return null;
}

export function recoverSecureConnectionRequest(text: string): SecureConnectionRecovery | null {
  const value = String(text || "");
  if (!detectInsecureCredentialAdvice(value)) return null;

  for (const hint of DIRECT_COMPANION_HINTS) {
    if (!hint.pattern.test(value)) continue;
    return {
      companionType: hint.companionType,
      label: hint.label,
      params: {
        requestedVia: "unsafe_advice_recovery",
      },
      message: `I need to connect ${hint.label} through Canopy's secure setup flow instead of asking you for secrets here.`,
    };
  }

  const providerName = inferProviderName(value);
  const { authUrl, tokenUrl } = extractLikelyUrls(value);
  const scopes = extractScopes(value);
  const accessMode = inferAccessMode(value);

  if (!providerName && !authUrl && !tokenUrl) return null;

  const label = providerName || "custom OAuth provider";
  const params: Record<string, string> = {
    requestedVia: "unsafe_advice_recovery",
    accessMode,
    notes: "Recovered from blocked insecure credential guidance. Finish the secure setup here instead of sharing secrets in chat.",
  };
  if (providerName) params.providerName = providerName;
  if (authUrl) params.authUrl = authUrl;
  if (tokenUrl) params.tokenUrl = tokenUrl;
  if (scopes.length > 0) params.scopes = scopes.join(",");

  return {
    companionType: "custom_oauth",
    label,
    params,
    message: `I need to connect ${label} through Canopy's secure setup flow instead of asking you for secrets here.`,
  };
}

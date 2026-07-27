export type CustomOAuthAccessMode = "read" | "write";

export type CustomOAuthProvider = {
  id: string;
  providerName: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecretKey?: string;
  scopes: string[];
  accessMode: CustomOAuthAccessMode;
  status: "configured";
  createdAt: string;
  updatedAt: string;
  requestedVia?: string;
  notes?: string;
};

export { parseConnectionRequestTag, type ConnectionRequestTag } from "./connectionRequests";

type ScopeObject = Record<string, unknown>;

function asObject(value: unknown): ScopeObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ScopeObject;
}

export function slugifyCustomOAuthProvider(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "custom-provider";
}

export function parseCustomOAuthScopes(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(",")
        .map(scope => scope.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeProvider(input: unknown): CustomOAuthProvider | null {
  const value = asObject(input);
  if (!value) return null;

  const id = typeof value.id === "string" && value.id.trim()
    ? value.id.trim()
    : typeof value.providerName === "string"
      ? slugifyCustomOAuthProvider(value.providerName)
      : "";
  const providerName = typeof value.providerName === "string" ? value.providerName.trim() : "";
  const authUrl = typeof value.authUrl === "string" ? value.authUrl.trim() : "";
  const tokenUrl = typeof value.tokenUrl === "string" ? value.tokenUrl.trim() : "";
  const clientId = typeof value.clientId === "string" ? value.clientId.trim() : "";
  const accessMode: CustomOAuthAccessMode = value.accessMode === "write" ? "write" : "read";
  const status = value.status === "configured" ? "configured" : null;

  if (!id || !providerName || !authUrl || !tokenUrl || !clientId || !status) {
    return null;
  }

  return {
    id,
    providerName,
    authUrl,
    tokenUrl,
    clientId,
    clientSecretKey:
      typeof value.clientSecretKey === "string" && value.clientSecretKey.trim()
        ? value.clientSecretKey.trim()
        : undefined,
    scopes: Array.isArray(value.scopes)
      ? value.scopes.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0)
      : [],
    accessMode,
    status,
    createdAt:
      typeof value.createdAt === "string" && value.createdAt.trim()
        ? value.createdAt
        : new Date(0).toISOString(),
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim()
        ? value.updatedAt
        : new Date(0).toISOString(),
    requestedVia:
      typeof value.requestedVia === "string" && value.requestedVia.trim()
        ? value.requestedVia.trim()
        : undefined,
    notes:
      typeof value.notes === "string" && value.notes.trim()
        ? value.notes.trim()
        : undefined,
  };
}

export function getCustomOAuthProvidersFromScope(scope: unknown): CustomOAuthProvider[] {
  const scopeObject = asObject(scope);
  if (!scopeObject) return [];

  const customOAuth = asObject(scopeObject.custom_oauth);
  const providers = customOAuth?.providers;
  if (!Array.isArray(providers)) return [];

  return providers
    .map(normalizeProvider)
    .filter((provider): provider is CustomOAuthProvider => provider !== null);
}

export function upsertCustomOAuthProviderInScope(
  scope: unknown,
  provider: CustomOAuthProvider,
): Record<string, unknown> {
  const currentScope = asObject(scope) ?? {};
  const currentProviders = getCustomOAuthProvidersFromScope(currentScope);
  const nextProviders = [
    ...currentProviders.filter(existing => existing.id !== provider.id),
    provider,
  ].sort((left, right) => left.providerName.localeCompare(right.providerName));

  const nextCustomOAuth = {
    ...(asObject(currentScope.custom_oauth) ?? {}),
    providers: nextProviders,
  };

  return {
    ...currentScope,
    custom_oauth: nextCustomOAuth,
  };
}

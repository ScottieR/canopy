export type StandaloneViewKind =
  | "miniapp"
  | "genui"
  | "browser"
  | "chatCompanion"
  | "slack"
  | "passwords"
  | "github"
  | "discord"
  | "telegram"
  | "figma"
  | "custom_oauth"
  | "bluetooth"
  | "companionGuide"
  | "app";

export function resolveStandaloneViewKind(params: {
  miniappPayload: string | null;
  genuiPayload: string | null;
  browserAgentId: string | null;
  chatCompanionAgentId: string | null;
  companionType: string | null;
}): StandaloneViewKind {
  const {
    miniappPayload,
    genuiPayload,
    browserAgentId,
    chatCompanionAgentId,
    companionType,
  } = params;

  if (miniappPayload) return "miniapp";
  if (genuiPayload) return "genui";
  if (browserAgentId) return "browser";
  if (chatCompanionAgentId) return "chatCompanion";

  switch (companionType) {
    case "slack":
    case "passwords":
    case "github":
    case "discord":
    case "telegram":
    case "figma":
    case "custom_oauth":
    case "bluetooth":
      return companionType;
    default:
      return companionType ? "companionGuide" : "app";
  }
}

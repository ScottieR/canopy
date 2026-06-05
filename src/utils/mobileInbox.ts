import type { InboxItem } from "../store/worldStore";

export type MobileInboxResolution = "approved" | "dismissed";

export interface MobileInboxEffects {
  removeId: string;
  createForumForAgentId?: string;
  navigateToCanopy?: boolean;
}

interface DeriveMobileInboxEffectsArgs {
  item: InboxItem;
  resolution: MobileInboxResolution;
  fallbackAgentId?: string | null;
}

export function deriveMobileInboxEffects({
  item,
  resolution,
  fallbackAgentId,
}: DeriveMobileInboxEffectsArgs): MobileInboxEffects {
  const effects: MobileInboxEffects = {
    removeId: item.id,
  };

  if (resolution !== "approved") {
    return effects;
  }

  if (item.type === "voice_note" && fallbackAgentId) {
    effects.createForumForAgentId = fallbackAgentId;
    effects.navigateToCanopy = true;
  }

  return effects;
}

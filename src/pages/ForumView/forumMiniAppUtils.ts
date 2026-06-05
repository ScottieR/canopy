import type { Forum, ForumArtifact, ForumBlock } from "../../store/forumStore";

export interface ForumMiniAppPinTarget {
  agentId: string;
  app: {
    name: string;
    description: string;
    htmlContent: string;
    sourceMessageId: string;
  };
}

interface BuildForumMiniAppPinTargetArgs {
  forum: Forum;
  selectedArtifact: ForumArtifact | null;
  blackboardBlock: ForumBlock | null;
}

function normalizeAgentId(agentId: string | undefined): string | null {
  const first = agentId?.split(",")[0]?.trim();
  return first ? first : null;
}

export function buildForumMiniAppPinTarget({
  forum,
  selectedArtifact,
  blackboardBlock,
}: BuildForumMiniAppPinTargetArgs): ForumMiniAppPinTarget | null {
  if (selectedArtifact?.type === "html") {
    const agentId = normalizeAgentId(selectedArtifact.agentId);
    const htmlContent = selectedArtifact.content?.trim();
    if (!agentId || !htmlContent) return null;

    return {
      agentId,
      app: {
        name: selectedArtifact.title || `Project app — ${forum.title}`,
        description: `Pinned from project "${forum.title}"`,
        htmlContent,
        sourceMessageId: `forum_artifact:${forum.id}:${selectedArtifact.id}`,
      },
    };
  }

  if (blackboardBlock?.type === "html") {
    const agentId = normalizeAgentId(blackboardBlock.agentId);
    const htmlContent = blackboardBlock.content?.trim();
    if (!agentId || !htmlContent) return null;

    return {
      agentId,
      app: {
        name: `Project app — ${forum.title}`,
        description: `Pinned from the live project deliverable in "${forum.title}"`,
        htmlContent,
        sourceMessageId: `forum_blackboard:${forum.id}:${blackboardBlock.generatedAt}`,
      },
    };
  }

  return null;
}

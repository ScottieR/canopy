import { describe, expect, it } from "vitest";
import type { Forum } from "../../store/forumStore";
import { buildForumMiniAppPinTarget } from "./forumMiniAppUtils";

function makeForum(): Forum {
  return {
    id: "forum_launch",
    title: "Launch microsite",
    brief: "Build a microsite",
    tags: ["launch"],
    status: "active",
    agents: [],
    messages: [],
    milestones: [],
    trustBudget: {
      tokensUsed: 0,
      usdLimit: 5,
      usdUsed: 0,
      circuitBreakerFired: false,
    },
    blackboardContent: "",
    blackboardHistory: [],
    blackboardBlock: null,
    artifacts: [],
    scratchpadContent: "",
    createdAt: 1,
    lastActiveAt: 1,
    orchestratorVersion: 0,
  };
}

describe("buildForumMiniAppPinTarget", () => {
  it("pins an HTML artifact to the originating agent shelf", () => {
    const target = buildForumMiniAppPinTarget({
      forum: makeForum(),
      selectedArtifact: {
        id: "artifact_1",
        type: "html",
        title: "ROI calculator",
        content: "<html><body>ROI</body></html>",
        agentId: "agent_writer",
        agentName: "Writer",
        createdAt: 1,
      },
      blackboardBlock: null,
    });

    expect(target).toEqual({
      agentId: "agent_writer",
      app: {
        name: "ROI calculator",
        description: 'Pinned from project "Launch microsite"',
        htmlContent: "<html><body>ROI</body></html>",
        sourceMessageId: "forum_artifact:forum_launch:artifact_1",
      },
    });
  });

  it("pins the live HTML blackboard when no artifact is selected", () => {
    const target = buildForumMiniAppPinTarget({
      forum: makeForum(),
      selectedArtifact: null,
      blackboardBlock: {
        type: "html",
        content: "<html><body>Live app</body></html>",
        agentId: "agent_writer",
        agentName: "Writer",
        generatedAt: 42,
      },
    });

    expect(target).toEqual({
      agentId: "agent_writer",
      app: {
        name: "Project app — Launch microsite",
        description: 'Pinned from the live project deliverable in "Launch microsite"',
        htmlContent: "<html><body>Live app</body></html>",
        sourceMessageId: "forum_blackboard:forum_launch:42",
      },
    });
  });

  it("refuses to pin non-HTML content or content without an owner", () => {
    expect(
      buildForumMiniAppPinTarget({
        forum: makeForum(),
        selectedArtifact: {
          id: "artifact_2",
          type: "markdown",
          title: "Memo",
          content: "# Memo",
          createdAt: 1,
        },
        blackboardBlock: null,
      })
    ).toBeNull();

    expect(
      buildForumMiniAppPinTarget({
        forum: makeForum(),
        selectedArtifact: null,
        blackboardBlock: {
          type: "html",
          content: "<html><body>Missing owner</body></html>",
          generatedAt: 42,
        },
      })
    ).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createQuotaSafeStateStorage } from "../safeStorage";
import { createWorldPersistenceSnapshot } from "../worldStore";
import { createForumPersistenceSnapshot } from "../forumStore";

describe("bounded local persistence", () => {
  it("does not let a quota exception escape into React state updates", () => {
    const quotaError = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    const backing: StateStorage = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(() => { throw quotaError; }),
      removeItem: vi.fn(),
    };
    const onError = vi.fn();
    const storage = createQuotaSafeStateStorage(backing, onError);

    expect(() => storage.setItem("canopy-world-store", "private serialized state")).not.toThrow();
    expect(onError).toHaveBeenCalledWith("canopy-world-store", quotaError);
  });

  it("persists only a bounded chat cache, conversation metadata, and no mini-app bodies", () => {
    const messages = Array.from({ length: 25 }, (_, index) => ({
      id: `message-${index}`,
      sender: index % 2 ? "agent" : "user",
      text: "x".repeat(20_000),
      time: "12:00 PM",
      attachments: [{ name: "image.png", dataUrl: "data:image/png;base64,large" }],
    }));
    const conversations = Array.from({ length: 150 }, (_, index) => ({
      id: `conversation-${index}`,
      title: `Conversation ${index}`,
      messages,
      createdAt: index,
      lastActiveAt: index,
    }));

    const snapshot = createWorldPersistenceSnapshot({
      agents: [{
        id: "agent-atlas",
        chatLog: messages,
        conversations,
        miniApps: [{
          id: "app-1",
          name: "Large app",
          createdAt: 1,
          activeVersionId: "version-1",
          versions: [{ id: "version-1", timestamp: 1, htmlContent: "h".repeat(250_000) }],
        }],
      }],
      inbox: [],
      isAutoCloakEnabled: true,
      autoCloakTimeout: 15,
      telemetryAnonId: "anonymous",
      usageTelemetryEnabled: false,
      firedTelemetryEvents: {},
    } as any);

    expect(snapshot.agents[0].chatLog).toHaveLength(10);
    expect(snapshot.agents[0].chatLog[0].text).toHaveLength(10_000);
    expect(snapshot.agents[0].chatLog[0].attachments?.[0].dataUrl).toBe("");
    expect(snapshot.agents[0].conversations).toHaveLength(100);
    expect(snapshot.agents[0].conversations.every(conversation => conversation.messages.length === 0)).toBe(true);
    expect(snapshot.agents[0].miniApps).toBeUndefined();
    expect(snapshot.agents[0].miniAppsLoaded).toBe(false);
    expect(JSON.stringify(snapshot).length).toBeLessThan(300_000);
  });

  it("keeps only forum metadata in WebKit without truncating the source record", () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      id: `message-${index}`,
      kind: "chat",
      sender: "agent",
      text: `Message ${index}`,
      timestamp: index,
      attachments: [{ name: "image.png", dataUrl: "data:image/png;base64,large", mimeType: "image/png" }],
    }));
    const artifacts = Array.from({ length: 500 }, (_, index) => ({
      id: `artifact-${index}`,
      type: "markdown",
      title: `Artifact ${index}`,
      content: "content",
      createdAt: index,
      isDeliverable: index === 10,
    }));
    const forum = {
      id: "forum-large",
      messages,
      artifacts,
      blackboardHistory: Array.from({ length: 10 }, (_, index) => ({ content: `snapshot-${index}`, timestamp: index })),
      scratchpadContent: "s".repeat(100_000),
    };

    const snapshot = createForumPersistenceSnapshot({ forums: [forum] } as any);
    const persisted = snapshot.forums[0];

    expect(persisted.messages).toEqual([]);
    expect(persisted.artifacts).toEqual([]);
    expect(persisted.blackboardHistory).toEqual([]);
    expect(persisted.scratchpadContent).toBe("");
    expect(persisted.contentLoaded).toBe(false);
    expect(forum.messages).toHaveLength(1_000);
    expect(forum.artifacts).toHaveLength(500);
    expect(forum.scratchpadContent).toHaveLength(100_000);
    expect(JSON.stringify(snapshot).length).toBeLessThan(1_000);
  });
});

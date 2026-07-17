import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  loadForum,
  loadMiniApps,
  saveForumNow,
  saveMiniAppsNow,
} from "../durableContent";

describe("durable WebKit content bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("sends complete forum content to SQLite without applying browser limits", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const largeContent = "x".repeat(1_000_000);
    const forum = {
      id: "forum_large",
      messages: Array.from({ length: 1_000 }, (_, index) => ({ id: `msg_${index}`, text: largeContent })),
      artifacts: [{ id: "artifact_1", content: largeContent }],
    } as any;

    await saveForumNow(forum);

    expect(invoke).toHaveBeenCalledWith("save_forum_state", {
      forumId: "forum_large",
      forum,
      ifAbsent: false,
    });
    expect(forum.messages).toHaveLength(1_000);
    expect(forum.artifacts[0].content).toHaveLength(1_000_000);
  });

  it("hydrates complete forum and mini-app bodies only when requested", async () => {
    const forum = { id: "forum_1", messages: [{ text: "complete" }] } as any;
    const apps = [{
      id: "app_1",
      versions: Array.from({ length: 25 }, (_, index) => ({
        id: `version_${index}`,
        htmlContent: `<main>${index}</main>`,
      })),
    }] as any;
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "get_forum_state") return forum;
      if (command === "get_agent_mini_apps") return apps;
      return undefined;
    });

    await expect(loadForum("forum_1")).resolves.toEqual(forum);
    await expect(loadMiniApps("agent_atlas")).resolves.toEqual(apps);
    expect(apps[0].versions).toHaveLength(25);
  });

  it("persists every mini-app version without content slicing", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const apps = [{
      id: "app_1",
      versions: Array.from({ length: 50 }, (_, index) => ({
        id: `version_${index}`,
        htmlContent: "h".repeat(200_000),
      })),
    }] as any;

    await saveMiniAppsNow("agent_atlas", apps);

    expect(invoke).toHaveBeenCalledWith("save_agent_mini_apps", {
      agentId: "agent_atlas",
      miniApps: apps,
      ifAbsent: false,
    });
    expect(apps[0].versions).toHaveLength(50);
    expect(apps[0].versions[49].htmlContent).toHaveLength(200_000);
  });
});

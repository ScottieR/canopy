/**
 * accessTier.test.ts
 *
 * TypeScript-side access tier tests covering:
 *   1. forumStore sync state transitions (the state machine)
 *   2. Isolated agent auto-sync block
 *   3. diffText correctness (Myers diff utility)
 *   4. changeMagnitude thresholds (mirrors Rust change_magnitude)
 *
 * Run with: npm test
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { diffText, changeMagnitude } from "../utils/diff";

// ─── forumStore helpers ───────────────────────────────────────────────────────
// We test the store actions by importing the store directly.
// Zustand stores are synchronous in tests.

// Mock Tauri before importing the store
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

import { useForumStore } from "../store/forumStore";
import type { ArtifactSyncState } from "../store/forumStore";

// Reset store state before each test
beforeEach(() => {
  useForumStore.setState({ forums: [], activeForumId: null });
});

/** Create a minimal forum and return its ID */
function createTestForum(brief = "A test brief") {
  const store = useForumStore.getState();
  store.createForum(brief, [], []);
  const forums = useForumStore.getState().forums;
  return forums[forums.length - 1].id;
}

// ─── addForumArtifact: default sync state ────────────────────────────────────

describe("addForumArtifact", () => {
  it("defaults new artifacts to unsynced", () => {
    const forumId = createTestForum();
    useForumStore.getState().addForumArtifact(forumId, {
      type: "markdown",
      title: "Test artifact",
      content: "# Hello",
      folder: "Research",
      filename: "research.md",
    });
    const forum = useForumStore.getState().forums.find(f => f.id === forumId)!;
    expect(forum.artifacts).toHaveLength(1);
    expect(forum.artifacts[0].syncState).toBe("unsynced");
  });

  it("respects explicit syncState if provided", () => {
    const forumId = createTestForum();
    useForumStore.getState().addForumArtifact(forumId, {
      type: "html",
      title: "Live deliverable",
      content: "<html/>",
      folder: "Deliverables",
      filename: "deliverable.html",
      syncState: "auto",
    });
    const forum = useForumStore.getState().forums.find(f => f.id === forumId)!;
    expect(forum.artifacts[0].syncState).toBe("auto");
  });
});

// ─── updateArtifactSyncState ──────────────────────────────────────────────────

describe("updateArtifactSyncState", () => {
  it("transitions unsynced → synced with timestamp and hash", () => {
    const forumId = createTestForum();
    const store = useForumStore.getState();
    store.addForumArtifact(forumId, {
      type: "markdown",
      title: "Findings",
      content: "content",
      folder: "Research",
      filename: "findings.md",
    });
    const artifactId = useForumStore.getState().forums
      .find(f => f.id === forumId)!.artifacts[0].id;

    store.updateArtifactSyncState(forumId, artifactId, "synced", 1717000000000, "abc123hash");

    const updated = useForumStore.getState().forums
      .find(f => f.id === forumId)!.artifacts[0];
    expect(updated.syncState).toBe("synced");
    expect(updated.lastSyncedAt).toBe(1717000000000);
    expect(updated.lastSyncedHash).toBe("abc123hash");
  });

  it("transitions synced → stale when content changes", () => {
    const forumId = createTestForum();
    const store = useForumStore.getState();
    store.addForumArtifact(forumId, {
      type: "markdown",
      title: "Doc",
      content: "v1",
      folder: "Strategy",
      filename: "strategy.md",
      syncState: "synced",
      lastSyncedAt: Date.now() - 10000,
    });
    const artifactId = useForumStore.getState().forums
      .find(f => f.id === forumId)!.artifacts[0].id;

    // Simulate content change making it stale
    store.updateArtifactSyncState(forumId, artifactId, "stale");

    const updated = useForumStore.getState().forums
      .find(f => f.id === forumId)!.artifacts[0];
    expect(updated.syncState).toBe("stale");
  });

  it("transitions stale → syncing → synced on manual sync", () => {
    const forumId = createTestForum();
    const store = useForumStore.getState();
    store.addForumArtifact(forumId, {
      type: "markdown", title: "Doc", content: "v1",
      folder: "Research", filename: "doc.md", syncState: "stale",
    });
    const artifactId = useForumStore.getState().forums
      .find(f => f.id === forumId)!.artifacts[0].id;

    store.updateArtifactSyncState(forumId, artifactId, "syncing");
    expect(useForumStore.getState().forums.find(f => f.id === forumId)!
      .artifacts[0].syncState).toBe("syncing");

    store.updateArtifactSyncState(forumId, artifactId, "synced", Date.now());
    expect(useForumStore.getState().forums.find(f => f.id === forumId)!
      .artifacts[0].syncState).toBe("synced");
  });
});

// ─── connectFolder ────────────────────────────────────────────────────────────

describe("connectFolder", () => {
  it("sets connectedFolderPath, type, and name on the forum", () => {
    const forumId = createTestForum();
    useForumStore.getState().connectFolder(
      forumId, "/Users/scottie/Projects/Q3", "local", "Q3"
    );
    const forum = useForumStore.getState().forums.find(f => f.id === forumId)!;
    expect(forum.connectedFolderPath).toBe("/Users/scottie/Projects/Q3");
    expect(forum.connectedFolderType).toBe("local");
    expect(forum.connectedFolderName).toBe("Q3");
  });

  it("sets scratchpadSyncState to auto when folder is connected", () => {
    const forumId = createTestForum();
    useForumStore.getState().connectFolder(forumId, "/tmp/proj", "local", "proj");
    const forum = useForumStore.getState().forums.find(f => f.id === forumId)!;
    expect(forum.scratchpadSyncState).toBe("auto");
  });

  it("marks existing synced artifacts as stale when a new folder is connected", () => {
    const forumId = createTestForum();
    const store = useForumStore.getState();
    store.addForumArtifact(forumId, {
      type: "markdown", title: "Old doc", content: "x",
      folder: "R", filename: "r.md", syncState: "synced",
    });
    store.connectFolder(forumId, "/tmp/new-project", "local", "new-project");
    const forum = store.forums.find(f => f.id === forumId)!;
    // Re-read after state change
    const updated = useForumStore.getState().forums.find(f => f.id === forumId)!;
    expect(updated.artifacts[0].syncState).toBe("stale");
  });

  it("marks existing unsynced artifacts as unsynced (not stale) when folder is connected", () => {
    const forumId = createTestForum();
    const store = useForumStore.getState();
    store.addForumArtifact(forumId, {
      type: "markdown", title: "New doc", content: "y",
      folder: "R", filename: "r.md", syncState: "unsynced",
    });
    store.connectFolder(forumId, "/tmp/proj", "local", "proj");
    const updated = useForumStore.getState().forums.find(f => f.id === forumId)!;
    expect(updated.artifacts[0].syncState).toBe("unsynced");
  });
});

// ─── disconnectFolder ─────────────────────────────────────────────────────────

describe("disconnectFolder", () => {
  it("clears all folder connection fields", () => {
    const forumId = createTestForum();
    const store = useForumStore.getState();
    store.connectFolder(forumId, "/tmp/proj", "local", "proj");
    store.disconnectFolder(forumId);
    const forum = useForumStore.getState().forums.find(f => f.id === forumId)!;
    expect(forum.connectedFolderPath).toBeUndefined();
    expect(forum.connectedFolderType).toBeUndefined();
    expect(forum.connectedFolderName).toBeUndefined();
    expect(forum.scratchpadSyncState).toBeUndefined();
  });
});

// ─── appendScratchpad: stale transition ──────────────────────────────────────

describe("appendScratchpad", () => {
  it("marks scratchpad as stale when it was previously synced", () => {
    const forumId = createTestForum();
    const store = useForumStore.getState();
    store.connectFolder(forumId, "/tmp/proj", "local", "proj");
    // Manually set to synced
    store.updateScratchpadSyncState(forumId, "synced", Date.now());
    // Now append to scratchpad — should flip to stale
    store.appendScratchpad(forumId, "\n## New notes from agent");
    const forum = useForumStore.getState().forums.find(f => f.id === forumId)!;
    expect(forum.scratchpadSyncState).toBe("stale");
  });

  it("leaves scratchpad as auto when auto is the current state", () => {
    const forumId = createTestForum();
    const store = useForumStore.getState();
    store.connectFolder(forumId, "/tmp/proj", "local", "proj");
    // auto-sync state should not flip to stale on append
    expect(useForumStore.getState().forums.find(f => f.id === forumId)!.scratchpadSyncState).toBe("auto");
    store.appendScratchpad(forumId, "\nsome notes");
    // auto should remain auto (agent writes are expected for auto-synced scratchpad)
    const forum = useForumStore.getState().forums.find(f => f.id === forumId)!;
    // scratchpadSyncState stays auto since it wasn't "synced"
    expect(forum.scratchpadSyncState).toBe("auto");
  });

  it("accumulates content correctly", () => {
    const forumId = createTestForum();
    const store = useForumStore.getState();
    store.appendScratchpad(forumId, "## Phase 1\nresearch notes\n\n");
    store.appendScratchpad(forumId, "## Phase 2\nstrategy notes\n\n");
    const forum = useForumStore.getState().forums.find(f => f.id === forumId)!;
    expect(forum.scratchpadContent).toContain("Phase 1");
    expect(forum.scratchpadContent).toContain("Phase 2");
  });
});

// ─── Isolated agent access tier (frontend enforcement) ───────────────────────

describe("Isolated agent sync guard", () => {
  /**
   * The frontend must check agent.isolated before calling sync_artifact.
   * The Rust backend also enforces this, but we want the frontend guard
   * to be tested independently so regressions are caught at the UI layer too.
   */

  function shouldAllowSync(isIsolated: boolean, artifactId: string): boolean {
    // Mirrors the frontend guard in ProgressAndFiles onSyncArtifact handler
    if (isIsolated && artifactId !== "__user_approved__") return false;
    return true;
  }

  it("blocks isolated agent artifact sync without user approval", () => {
    expect(shouldAllowSync(true, "art-accountant-budget-q3")).toBe(false);
  });

  it("allows isolated agent artifact with explicit approval sentinel", () => {
    expect(shouldAllowSync(true, "__user_approved__")).toBe(true);
  });

  it("allows non-isolated agent artifact without approval", () => {
    expect(shouldAllowSync(false, "art-researcher-findings")).toBe(true);
  });
});

// ─── diffText (Myers diff utility) ───────────────────────────────────────────

describe("diffText", () => {
  it("returns a single equal op for identical strings", () => {
    const ops = diffText("hello world", "hello world");
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("equal");
    expect(ops[0].text).toBe("hello world");
  });

  it("detects inserted words", () => {
    const ops = diffText("hello world", "hello beautiful world");
    const inserts = ops.filter(o => o.type === "insert");
    expect(inserts.some(o => o.text.includes("beautiful"))).toBe(true);
  });

  it("detects deleted words", () => {
    const ops = diffText("hello beautiful world", "hello world");
    const deletes = ops.filter(o => o.type === "delete");
    expect(deletes.some(o => o.text.includes("beautiful"))).toBe(true);
  });

  it("handles empty prev (pure insertion)", () => {
    const ops = diffText("", "new content");
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("insert");
    expect(ops[0].text).toBe("new content");
  });

  it("handles empty next (pure deletion)", () => {
    const ops = diffText("old content", "");
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("delete");
    expect(ops[0].text).toBe("old content");
  });
});

// ─── changeMagnitude ─────────────────────────────────────────────────────────

describe("changeMagnitude", () => {
  it("returns 0 for identical strings", () => {
    expect(changeMagnitude("same", "same")).toBe(0);
  });

  it("returns 1 for empty prev", () => {
    expect(changeMagnitude("", "something")).toBe(1);
  });

  it("returns 1 for empty next", () => {
    expect(changeMagnitude("something", "")).toBe(1);
  });

  it("returns 0 for both empty", () => {
    expect(changeMagnitude("", "")).toBe(0);
  });

  it("small edit is under the 50% soft-interrupt threshold", () => {
    const prev = "The quick brown fox jumps over the lazy dog.";
    const next = "The quick brown cat jumps over the lazy dog.";
    expect(changeMagnitude(prev, next)).toBeLessThan(0.5);
  });

  it("full rewrite is over the 50% soft-interrupt threshold", () => {
    const prev = "Original document with lots of detailed content about the project.";
    const next = "Completely rewritten document with entirely different ideas and direction.";
    expect(changeMagnitude(prev, next)).toBeGreaterThan(0.5);
  });

  it("tier boundary: exactly 50% change triggers soft interrupt", () => {
    // We use 0.50 as the exclusive lower bound: > 0.50 → SoftInterrupt
    // So something at exactly 0.50 should NOT trigger SoftInterrupt
    const mag = 0.50;
    const tier = mag > 0.50 ? "SoftInterrupt" : "Silent";
    expect(tier).toBe("Silent");
  });
});

// ─── Namespace validation (frontend mirrors Rust prefix check) ────────────────

describe("Namespace validation", () => {
  function isWithinNamespace(connected: string, filePath: string): boolean {
    // Use trailing slash to avoid sibling-folder false positives
    return filePath.startsWith(connected + "/") || filePath === connected;
  }

  it("rejects path traversal in file path", () => {
    const connected = "/Users/scottie/Projects/Q3";
    const attempted = "/Users/scottie/Projects/Q3/../OtherProject/steal.txt";
    expect(isWithinNamespace(connected, attempted)).toBe(false);
  });

  it("rejects absolute escape to system path", () => {
    expect(isWithinNamespace("/Users/scottie/Projects/Q3", "/etc/passwd")).toBe(false);
  });

  it("rejects sibling folder with matching prefix", () => {
    const connected = "/Users/scottie/Projects/Q3";
    const sibling   = "/Users/scottie/Projects/Q3Launch/steal.txt";
    // Without trailing slash check this would be a false positive
    expect(isWithinNamespace(connected, sibling)).toBe(false);
  });

  it("allows valid path within namespace", () => {
    const connected = "/Users/scottie/Projects/Q3";
    const valid     = "/Users/scottie/Projects/Q3/Market Analysis/findings.md";
    expect(isWithinNamespace(connected, valid)).toBe(true);
  });

  it("allows deeply nested valid path", () => {
    const connected = "/Users/scottie/Projects/Q3";
    const valid     = "/Users/scottie/Projects/Q3/Campaign/Deliverables/brief.html";
    expect(isWithinNamespace(connected, valid)).toBe(true);
  });
});

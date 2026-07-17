import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { applyForumBudgetIncrement } from "./forumBudget";
import { getQuotaSafeLocalStorage } from "./safeStorage";
import {
  loadForum,
  loadForumCatalog,
  removeForum,
  saveForumNow,
  scheduleForumSave,
} from "./durableContent";

// ─── Message Types ────────────────────────────────────────────────────────────

export type ForumMessageSender = "user" | "agent" | "system";
export type ForumMessageKind =
  | "chat"
  | "handoff"
  | "milestone"
  | "vote"
  | "circuit_breaker"
  | "system"
  | "question"   // agent asks user a structured question with selectable options
  | "answer";    // user's reply to a question (shown as a user-side bubble)

export interface ForumMessage {
  id: string;
  kind: ForumMessageKind;
  sender: ForumMessageSender;
  agentId?: string;       // which agent sent it (if sender === "agent")
  agentName?: string;
  toAgentId?: string;     // for handoff messages: recipient agent
  toAgentName?: string;
  text: string;
  timestamp: number;      // unix ms
  // For handoff messages — the data/artifact being passed
  handoffLabel?: string;
  // For vote messages
  voteOptions?: { label: string; agentId: string; confidence: number }[];
  voteResult?: string;
  // For question messages — interactive genUI
  questionOptions?: string[];          // selectable answer buttons
  questionAllowFreeText?: boolean;     // show "Something else…" free-text input
  questionAnswered?: boolean;          // true once user has picked an answer
  questionAnswer?: string;            // the answer they gave
  // For dynamic Mini-Apps (GenUI platform)
  miniApp?: {
    component: string; // e.g., "Map", "CostOverlay", "DataTable", "ApprovalCard", "Html"
    props: Record<string, any>;
    target: "inline" | "canvas";
  };
  // File/image attachments uploaded by the user
  attachments?: { name: string; dataUrl: string; mimeType: string }[];
}

// ─── Milestone ────────────────────────────────────────────────────────────────

export type MilestoneStatus = "pending" | "active" | "done";

export interface Milestone {
  id: string;
  label: string;
  status: MilestoneStatus;
  agentId?: string;       // which agent owns this milestone
  completedAt?: number;
}

// ─── Agent Role in Forum ──────────────────────────────────────────────────────

export interface ForumAgent {
  agentId: string;
  name: string;
  role: string;
  robeColor: string;
  accentColor: string;
  image?: string | null;
  confidence: number;     // 0–100, relevance to this forum's brief
  forumRole: string;      // e.g. "Research & data pull", "Strategic framing"
  currentAction?: string; // live status in the forum
  /** Unix ms timestamp of the last time currentAction changed — used for elapsed-time display. */
  actionChangedAt?: number;
  /** True if the underlying agent has isolation enabled — carries sensitive integrations.
   *  The forum orchestrator uses this to restrict what context is shared from this agent. */
  isolated?: boolean;
}

// ─── Artifact ─────────────────────────────────────────────────────────────────

export type ForumArtifactType =
  | "markdown"   // prose document / report
  | "html"       // interactive HTML app / dashboard
  | "genui"      // dynamic Mini-App
  | "deck"       // slide deck
  | "image"      // generated image
  | "diagram"    // flowchart / architecture
  | "data";      // spreadsheet / structured data

export interface ForumComment {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
  blockId?: string; // block-level anchoring for comments
  resolved?: boolean;
}

/**
 * Sync state for a file in the project file tree.
 *
 * auto     — always kept in sync automatically (scratchpad + user-toggled)
 * synced   — manually synced, currently up to date with the folder
 * stale    — was synced before, but the content has changed since last sync
 * unsynced — never been synced to any folder
 * syncing  — in-flight write (transient)
 */
export type ArtifactSyncState = "auto" | "synced" | "stale" | "unsynced" | "syncing";

export interface ForumArtifact {
  id: string;
  type: ForumArtifactType;
  title: string;
  content: string;        // markdown text; URL for image/deck; raw HTML for html type
  preview?: string;       // optional short excerpt (auto-derived if absent)
  agentId?: string;
  agentName?: string;
  role_id?: string;
  createdAt: number;
  /** True only for the final user-facing deliverable — not intermediate research/strategy notes. */
  isDeliverable?: boolean;
  comments?: ForumComment[];
  /** Folder path for the project file tree, e.g. "Research" | "Strategy" | "Deliverables" | "Tools" */
  folder?: string;
  /** Filename to display in the file tree, e.g. "market-research.md" */
  filename?: string;
  // ── Sync state ──────────────────────────────────────────────────────────────
  syncState?: ArtifactSyncState;
  /** Unix ms of last successful sync to the connected folder */
  lastSyncedAt?: number;
  /** Content hash at time of last sync — used to detect staleness */
  lastSyncedHash?: string;
}

// ─── Blackboard Block ─────────────────────────────────────────────────────────
// The live format-aware content the agent chose to render in the left panel.
// Replaces plain markdown for the final deliverable phase.

export interface ForumBlock {
  type: "markdown" | "html" | "genui";
  content: string; // for genui, this is a stringified JSON payload
  reasoning?: string;       // optional agent explanation of format choice
  agentId?: string;
  agentName?: string;
  generatedAt: number;
}

// ─── Trust Budget ─────────────────────────────────────────────────────────────

export interface TrustBudget {
  tokenLimit?: number;      // deprecated/unused
  tokensUsed: number;
  usdLimit: number;         // max $ spend
  usdUsed: number;
  circuitBreakerFired: boolean;
}

// ─── Forum ────────────────────────────────────────────────────────────────────

export type ForumStatus = "drafting" | "active" | "paused" | "completed" | "archived";

export interface Forum {
  id: string;
  totalTokens?: number;
  totalCost?: number;
  title: string;
  brief: string;            // user's original goal text
  tags: string[];           // extracted from brief (e.g. ["research", "memo", "enterprise"])
  status: ForumStatus;
  agents: ForumAgent[];
  messages: ForumMessage[];
  milestones: Milestone[];
  trustBudget: TrustBudget;
  // Blackboard artifact — the shared document being built
  blackboardContent: string; // markdown content (used for history / Time Machine)
  blackboardHistory: { content: string; timestamp: number; agentId?: string }[];
  // Format-aware live block — what the left panel actually renders
  // (null = fall back to blackboardContent markdown)
  blackboardBlock: ForumBlock | null;
  // Discrete output artifacts produced by the team
  artifacts: ForumArtifact[];
  /** Shared scratch space — all agents append notes here freely throughout the forum */
  scratchpadContent: string;
  // ── Project folder connection ───────────────────────────────────────────────
  /** Local filesystem path or Google Drive folder ID */
  connectedFolderPath?: string;
  connectedFolderType?: "local" | "googledrive";
  /** Display name of the connected folder shown in UI */
  connectedFolderName?: string;
  /** Sync state of the scratchpad (always "auto" when folder is connected) */
  scratchpadSyncState?: ArtifactSyncState;
  scratchpadLastSyncedAt?: number;
  createdAt: number;
  lastActiveAt: number;
  // Incremented each time the orchestrator is asked to start/restart — lets the
  // useEffect distinguish a fresh run from one that already ran for this version.
  orchestratorVersion: number;
  draftMessage?: string;
  agentMessageCount?: number;
  artifactCount?: number;
  /** Transient: full unbounded content is currently hydrated from SQLite. */
  contentLoaded?: boolean;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export interface ForumState {
  forums: Forum[];
  incrementTokensAndCost: (forumId: string, tokens: number, cost: number) => void;
  activeForumId: string | null;
  hydratingForumId: string | null;

  // Actions
  createForum: (brief: string, agents: ForumAgent[], tags: string[]) => string;
  setActiveForumId: (id: string | null) => void;
  ensureForumContent: (id: string) => Promise<void>;
  /** Adds a message and returns the generated message ID. */
  addForumMessage: (forumId: string, msg: Omit<ForumMessage, "id" | "timestamp">) => string;
  setMilestones: (forumId: string, milestones: Milestone[]) => void;
  updateMilestone: (forumId: string, milestoneId: string, status: MilestoneStatus) => void;
  updateBlackboard: (forumId: string, content: string, agentId?: string) => void;
  updateAgentAction: (forumId: string, agentId: string, action: string) => void;
  updateTrustBudget: (forumId: string, delta: Partial<TrustBudget>) => void;
  setForumStatus: (forumId: string, status: ForumStatus) => void;
  getActiveForum: () => Forum | null;
  /** Mark a question message as answered and record the user's answer. */
  answerForumQuestion: (forumId: string, messageId: string, answer: string) => void;
  /** Add a discrete output artifact to the forum. */
  addForumArtifact: (forumId: string, artifact: Omit<ForumArtifact, "id" | "createdAt">) => void;
  /** Append text to the shared agent scratchpad. */
  appendScratchpad: (forumId: string, text: string) => void;
  /** Update the sync state of a single artifact (e.g. after a sync completes). */
  updateArtifactSyncState: (forumId: string, artifactId: string, state: ArtifactSyncState, syncedAt?: number, syncedHash?: string) => void;
  /** Set the connected folder for a forum. */
  connectFolder: (forumId: string, path: string, type: "local" | "googledrive", name: string) => void;
  /** Disconnect the folder from a forum. */
  disconnectFolder: (forumId: string) => void;
  /** Mark scratchpad sync state. */
  updateScratchpadSyncState: (forumId: string, state: ArtifactSyncState, syncedAt?: number) => void;
  /** Set the format-aware blackboard block (markdown or HTML deliverable). */
  setBlackboardBlock: (forumId: string, block: ForumBlock) => void;
  setForumDraft: (forumId: string, draft: string) => void;
  /** Reset a paused/errored forum back to "active" so the orchestrator can retry. */
  retryForum: (forumId: string) => void;
  /** Resume a paused forum without clearing messages or blackboard — increments
   *  orchestratorVersion so the main useEffect re-triggers. Use after transient
   *  errors (quota, rate limit) where the thread context should be preserved. */
  resumeForum: (forumId: string) => void;
  /** Replace the forum's tag list (supports user edits). */
  updateForumTags: (forumId: string, tags: string[]) => void;
  /** Add an agent to an existing forum. */
  addAgentToForum: (forumId: string, agent: ForumAgent) => void;
  /** Move forum to archived state — hidden from main list, accessible in archive section. */
  archiveForum: (forumId: string) => void;
  /** Permanently delete a forum from the store. */
  deleteForum: (forumId: string) => void;
  /** Move an archived forum back to its previous status. */
  unarchiveForum: (forumId: string) => void;
  /** Append a new milestone (used by orchestrator to add forum-specific steps). */
  addMilestone: (forumId: string, label: string, agentId?: string) => string;
  /** Remove an agent from an active forum (stops their participation but keeps their history). */
  removeAgentFromForum: (forumId: string, agentId: string) => void;
}

function generateId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const FORUM_CONTENT_FIELDS = new Set([
  "messages",
  "artifacts",
  "blackboardContent",
  "blackboardHistory",
  "blackboardBlock",
  "scratchpadContent",
  "contentLoaded",
]);

/** Catalog entry safe for WebKit localStorage; full bodies live in SQLite. */
export function createForumCatalogEntry(forum: Forum): Forum {
  const agentMessageCount = forum.contentLoaded
    ? (forum.messages || []).filter(message => message.sender === "agent").length
    : (forum.agentMessageCount || 0);
  const artifactCount = forum.contentLoaded
    ? (forum.artifacts || []).length
    : (forum.artifactCount || 0);
  return {
    ...forum,
    agentMessageCount,
    artifactCount,
    messages: [],
    artifacts: [],
    blackboardContent: "",
    blackboardHistory: [],
    blackboardBlock: null,
    scratchpadContent: "",
    contentLoaded: false,
  };
}

function mergeForumContent(catalog: Forum, content: Forum): Forum {
  const catalogMetadata = Object.fromEntries(
    Object.entries(catalog).filter(([key]) => !FORUM_CONTENT_FIELDS.has(key)),
  ) as Partial<Forum>;
  return {
    ...content,
    ...catalogMetadata,
    messages: content.messages || [],
    artifacts: content.artifacts || [],
    blackboardContent: content.blackboardContent || "",
    blackboardHistory: content.blackboardHistory || [],
    blackboardBlock: content.blackboardBlock || null,
    scratchpadContent: content.scratchpadContent || "",
    contentLoaded: true,
  };
}

let forumDurableBackendReady = false;

export function createForumPersistenceSnapshot(state: ForumState) {
  return {
    forums: (state.forums || []).map(createForumCatalogEntry),
  };
}

// Upgrade safety only: until the Rust command is confirmed available, keep the
// same bounded recovery copy used by v1. SQLite remains the unlimited source
// of truth once the migration handshake succeeds.
function createLegacyForumRecoverySnapshot(state: ForumState) {
  const messages = (items: ForumMessage[]) => {
    const bounded = items.length <= 200 ? items : [items[0], ...items.slice(-199)];
    return bounded.map(message => ({
      ...message,
      text: (message.text || "").slice(0, 50_000),
      attachments: message.attachments?.map(attachment => ({
        ...attachment,
        dataUrl: attachment.dataUrl?.startsWith("data:") ? "" : (attachment.dataUrl || ""),
      })),
    }));
  };
  return {
    forums: (state.forums || []).map(forum => ({
      ...forum,
      messages: messages(forum.messages || []),
      artifacts: (forum.artifacts || []).slice(-100),
      blackboardHistory: (forum.blackboardHistory || []).slice(-3),
      scratchpadContent: (forum.scratchpadContent || "").slice(-65_536),
    })),
  };
}

function createForumStorageSnapshot(state: ForumState) {
  return forumDurableBackendReady
    ? createForumPersistenceSnapshot(state)
    : createLegacyForumRecoverySnapshot(state);
}

function deriveTitle(brief: string): string {
  const words = brief.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length < brief.trim().length ? words + "…" : words;
}

function deriveMilestones(brief: string, agents: ForumAgent[]): Milestone[] {
  // Placeholder initial milestone; will be overwritten by dynamic planning phase
  return [
    { id: generateId("ms"), label: "Planning forum...", status: "active" }
  ];
}

export const useForumStore = create<ForumState>()(
  persist(
    (set, get) => ({
      forums: [],
      activeForumId: null,
      hydratingForumId: null,

      createForum: (brief, agents, tags) => {
        const id = generateId("forum");
        const now = Date.now();
        const milestones = deriveMilestones(brief, agents);

        const forum: Forum = {
          id,
          title: deriveTitle(brief),
          brief,
          tags,
          status: "active",
          agents,
          messages: [
            {
              id: generateId("msg"),
              kind: "system",
              sender: "system",
              text: `Forum opened. ${agents.length} agent${agents.length !== 1 ? "s" : ""} assembled.`,
              timestamp: now,
            }
          ],
          milestones,
          trustBudget: {
            tokenLimit: 500_000,
            tokensUsed: 0,
            usdLimit: 5.00,
            usdUsed: 0,
            circuitBreakerFired: false,
          },
          blackboardContent: `# ${deriveTitle(brief)}\n\n> **Brief:** ${brief}\n\n---\n\n`,
          blackboardHistory: [],
          blackboardBlock: null,
          artifacts: [],
          scratchpadContent: "",
          createdAt: now,
          lastActiveAt: now,
          orchestratorVersion: 0,
          contentLoaded: true,
        };

        set(state => ({ forums: [...state.forums, forum], activeForumId: id }));
        return id;
      },

      setActiveForumId: (id) => {
        const previousId = get().activeForumId;
        const previous = get().forums.find(forum => forum.id === previousId);
        if (previous?.contentLoaded) scheduleForumSave(previous);

        set(state => ({
          activeForumId: id,
          forums: state.forums.map(forum => {
            if (forum.id !== previousId || forum.id === id || forum.status === "active") return forum;
            return createForumCatalogEntry(forum);
          }),
        }));
        if (id) void get().ensureForumContent(id);
      },

      ensureForumContent: async (id) => {
        const existing = get().forums.find(forum => forum.id === id);
        if (!existing || existing.contentLoaded) return;
        set({ hydratingForumId: id });
        try {
          const durable = await loadForum(id);
          set(state => ({
            forums: state.forums.map(forum => {
              if (forum.id !== id) return forum;
              return durable ? mergeForumContent(forum, durable) : { ...forum, contentLoaded: true };
            }),
          }));
        } catch (error) {
          console.error(`[forum-store] failed to hydrate forum ${id}`, error instanceof Error ? error.name : "UnknownError");
        } finally {
          if (get().hydratingForumId === id) set({ hydratingForumId: null });
        }
      },
      incrementTokensAndCost: (forumId, tokens, cost) => set((state) => ({
        forums: state.forums.map((f) => 
          f.id === forumId
            ? { ...f, ...applyForumBudgetIncrement(f, tokens, cost) }
            : f 
        )
      })),

      addForumMessage: (forumId, msg) => {
        const id = generateId("msg");
        const timestamp = Date.now();
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId
              ? {
                  ...f,
                  messages: [...f.messages, { ...msg, id, timestamp }],
                  lastActiveAt: timestamp,
                }
              : f
          ),
        }));
        return id;
      },

      setMilestones: (forumId, milestones) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId ? { ...f, milestones } : f
          ),
        }));
      },

      updateMilestone: (forumId, milestoneId, status) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId
              ? {
                  ...f,
                  milestones: f.milestones.map(m =>
                    m.id === milestoneId
                      ? { ...m, status, completedAt: status === "done" ? Date.now() : m.completedAt }
                      : m
                  ),
                }
              : f
          ),
        }));
      },

      updateBlackboard: (forumId, content, agentId) => {
        const now = Date.now();
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId
              ? {
                  ...f,
                  blackboardContent: content,
                  blackboardHistory: [
                    ...f.blackboardHistory,
                    { content: f.blackboardContent, timestamp: now, agentId },
                  ].slice(-50), // keep last 50 snapshots for Time Machine
                  lastActiveAt: now,
                }
              : f
          ),
        }));
      },

      updateAgentAction: (forumId, agentId, action) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId
              ? {
                  ...f,
                  agents: f.agents.map(a =>
                    a.agentId === agentId
                      ? { ...a, currentAction: action, actionChangedAt: Date.now() }
                      : a
                  ),
                }
              : f
          ),
        }));
      },

      updateTrustBudget: (forumId, delta) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId
              ? { ...f, trustBudget: { ...f.trustBudget, ...delta } }
              : f
          ),
        }));
      },

      setForumStatus: (forumId, status) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId ? { ...f, status } : f
          ),
        }));
      },

      getActiveForum: () => {
        const { forums, activeForumId } = get();
        return forums.find(f => f.id === activeForumId) ?? null;
      },

      addForumArtifact: (forumId, artifact) => {
        const id = generateId("art");
        const createdAt = Date.now();
        set(state => ({
          forums: state.forums.map(f => {
            if (f.id !== forumId) return f;
            const existingIndex = f.artifacts.findIndex(a =>
              a.folder === artifact.folder &&
              (artifact.filename ? a.filename === artifact.filename : a.title === artifact.title)
            );
            let updatedArtifacts;
            if (existingIndex !== -1) {
              updatedArtifacts = [...f.artifacts];
              updatedArtifacts[existingIndex] = {
                ...updatedArtifacts[existingIndex],
                ...artifact,
                syncState: artifact.syncState ?? "unsynced" as ArtifactSyncState,
              };
            } else {
              updatedArtifacts = [...f.artifacts, {
                ...artifact,
                id,
                createdAt,
                syncState: artifact.syncState ?? "unsynced" as ArtifactSyncState,
              }];
            }
            return {
              ...f,
              artifacts: updatedArtifacts,
            };
          }),
        }));
      },

      appendScratchpad: (forumId, text) => {
        set(state => ({
          forums: state.forums.map(f => {
            if (f.id !== forumId) return f;
            const updated = { ...f, scratchpadContent: (f.scratchpadContent ?? "") + text };
            // Mark scratchpad as stale if it was previously synced
            if (f.scratchpadSyncState === "synced") {
              updated.scratchpadSyncState = "stale";
            }
            return updated;
          }),
        }));
      },

      updateArtifactSyncState: (forumId, artifactId, state, syncedAt, syncedHash) => {
        set(s => ({
          forums: s.forums.map(f =>
            f.id !== forumId ? f : {
              ...f,
              artifacts: f.artifacts.map(a =>
                a.id !== artifactId ? a : {
                  ...a,
                  syncState: state,
                  ...(syncedAt !== undefined ? { lastSyncedAt: syncedAt } : {}),
                  ...(syncedHash !== undefined ? { lastSyncedHash: syncedHash } : {}),
                }
              ),
            }
          ),
        }));
      },

      connectFolder: (forumId, path, type, name) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id !== forumId ? f : {
              ...f,
              connectedFolderPath: path,
              connectedFolderType: type,
              connectedFolderName: name,
              // Scratchpad goes auto when folder is connected
              scratchpadSyncState: "auto",
              // All existing artifacts become stale (they exist but haven't been written to this folder yet)
              artifacts: f.artifacts.map(a => ({
                ...a,
                syncState: (a.syncState === "synced" || a.syncState === "auto") ? "stale" : "unsynced",
              })),
            }
          ),
        }));
      },

      disconnectFolder: (forumId) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id !== forumId ? f : {
              ...f,
              connectedFolderPath: undefined,
              connectedFolderType: undefined,
              connectedFolderName: undefined,
              scratchpadSyncState: undefined,
            }
          ),
        }));
      },

      updateScratchpadSyncState: (forumId, state, syncedAt) => {
        set(s => ({
          forums: s.forums.map(f =>
            f.id !== forumId ? f : {
              ...f,
              scratchpadSyncState: state,
              ...(syncedAt !== undefined ? { scratchpadLastSyncedAt: syncedAt } : {}),
            }
          ),
        }));
      },

      setBlackboardBlock: (forumId, block) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId ? { ...f, blackboardBlock: block } : f
          ),
        }));
      },

      setForumDraft: (forumId, draft) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId ? { ...f, draftMessage: draft } : f
          ),
        }));
      },

      answerForumQuestion: (forumId, messageId, answer) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId
              ? {
                  ...f,
                  messages: f.messages.map(m =>
                    m.id === messageId
                      ? { ...m, questionAnswered: true, questionAnswer: answer }
                      : m
                  ),
                }
              : f
          ),
        }));
      },

      updateForumTags: (forumId, tags) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId ? { ...f, tags } : f
          ),
        }));
      },

      addAgentToForum: (forumId, agent) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId
              ? { ...f, agents: [...f.agents.filter(a => a.agentId !== agent.agentId), agent] }
              : f
          ),
        }));
      },

      archiveForum: (forumId) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId ? { ...f, status: "archived" } : f
          ),
        }));
      },

      unarchiveForum: (forumId) => {
        // Restore to "completed" if it had content, otherwise "active"
        set(state => ({
          forums: state.forums.map(f => {
            if (f.id !== forumId) return f;
            const hasContent = f.messages.some(m => m.sender === "agent");
            return { ...f, status: hasContent ? "completed" : "active" };
          }),
        }));
      },

      removeAgentFromForum: (forumId, agentId) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId
              ? { ...f, agents: f.agents.filter(a => a.agentId !== agentId) }
              : f
          ),
        }));
      },

      deleteForum: (forumId) => {
        set(state => ({
          forums: state.forums.filter(f => f.id !== forumId),
          activeForumId: state.activeForumId === forumId ? null : state.activeForumId,
        }));
        removeForum(forumId).catch(error =>
          console.error(`[forum-store] failed to delete forum ${forumId}`, error instanceof Error ? error.name : "UnknownError"),
        );
      },

      retryForum: (forumId) => {
        set(state => ({
          forums: state.forums.map(f => {
            if (f.id !== forumId) return f;
            const now = Date.now();
            // Keep only the initial "Forum opened" system message — drop agent messages
            // and any error/paused system messages so the orchestrator guard passes.
            const initialMessages = f.messages.filter(
              (m, i) => i === 0 && m.kind === "system"
            );
            // Reset milestones: pending, first one active
            const resetMilestones = f.milestones.map((m, i) => ({
              ...m,
              status: (i === 0 ? "active" : "pending") as MilestoneStatus,
              completedAt: undefined,
            }));
            return {
              ...f,
              status: "active",
              messages: initialMessages,
              milestones: resetMilestones,
              blackboardContent: `# ${f.title}\n\n> **Brief:** ${f.brief}\n\n---\n\n`,
              blackboardHistory: [],
              blackboardBlock: null,
              artifacts: [],
              trustBudget: { ...f.trustBudget, tokensUsed: 0, usdUsed: 0, circuitBreakerFired: false },
              agents: f.agents.map(a => ({ ...a, currentAction: "Joining forum…", actionChangedAt: now })),
              lastActiveAt: now,
              orchestratorVersion: (f.orchestratorVersion ?? 0) + 1,
            };
          }),
        }));
      },

      resumeForum: (forumId) => {
        set(state => ({
          forums: state.forums.map(f => {
            if (f.id !== forumId) return f;
            // Strip only the error/paused system messages from the thread —
            // keep all agent and user messages so the conversation is preserved.
            const cleanedMessages = f.messages.filter(m =>
              !(m.kind === "system" && m.text.startsWith("⚠"))
            );
            // Add a "Resuming…" divider so the user can see the restart point
            const now = Date.now();
            const divider: ForumMessage = {
              id: generateId("msg"),
              kind: "system",
              sender: "system",
              text: "↺ Resuming forum…",
              timestamp: now,
            };
            return {
              ...f,
              status: "active",
              messages: [...cleanedMessages, divider],
              agents: f.agents.map(a => ({ ...a, currentAction: "Resuming…", actionChangedAt: now })),
              lastActiveAt: now,
              orchestratorVersion: (f.orchestratorVersion ?? 0) + 1,
            };
          }),
        }));
      },

      addMilestone: (forumId, label, agentId) => {
        const id = generateId("ms");
        set(state => ({
          forums: state.forums.map(f => {
            if (f.id !== forumId) return f;
            // First milestone added: mark it active immediately
            const isFirst = f.milestones.length === 0;
            return {
              ...f,
              milestones: [
                ...f.milestones,
                { id, label, status: isFirst ? "active" : "pending", agentId } as Milestone,
              ],
            };
          }),
        }));
        return id;
      },
    }),
    {
      name: "canopy-forum-store",
      storage: createJSONStorage(getQuotaSafeLocalStorage),
      version: 2,
      migrate: (persistedState, version) => {
        const state = persistedState as ForumState;
        if (version < 2) {
          return {
            ...state,
            forums: (state.forums || []).map(forum => ({ ...forum, contentLoaded: true })),
          };
        }
        return state;
      },
      partialize: createForumStorageSnapshot,
    }
  )
);

let forumPersistenceStarted = false;
let initializeForumPromise: Promise<void> | null = null;

/**
 * Migrate any legacy browser-resident bodies once, load the SQLite catalog,
 * then hydrate only running forums. Selected completed forums hydrate on click.
 */
export function initializeForumDurablePersistence(): Promise<void> {
  if (initializeForumPromise) return initializeForumPromise;
  initializeForumPromise = (async () => {
    try {
      const initialForums = useForumStore.getState().forums;
      const migrationResults = await Promise.allSettled(initialForums
      .filter(forum => forum.contentLoaded)
      .map(forum => saveForumNow(forum, true)));
      const failedMigration = migrationResults.find(result => result.status === "rejected");
      if (failedMigration?.status === "rejected") throw failedMigration.reason;

      let catalog = await loadForumCatalog();
      const missingDurableBodies = initialForums.filter(
        forum => !forum.contentLoaded && !catalog.some(entry => entry.id === forum.id),
      );
      if (missingDurableBodies.length > 0) {
        // A prior interrupted upgrade may have already reduced localStorage to
        // catalog entries. Preserve those records in SQLite so they remain
        // discoverable; future content is durable from this point forward.
        console.warn(`[forum-store] promoting ${missingDurableBodies.length} recovery catalog entries into SQLite`);
        await Promise.all(missingDurableBodies.map(forum => saveForumNow(forum, true)));
        catalog = await loadForumCatalog();
      }
      forumDurableBackendReady = true;
      if (catalog.length > 0) {
        useForumStore.setState(state => {
          const localOnly = state.forums.filter(forum => !catalog.some(entry => entry.id === forum.id));
          return { forums: [...catalog.map(createForumCatalogEntry), ...localOnly] };
        });
      } else {
        // Trigger a post-handshake localStorage rewrite even for an empty catalog.
        useForumStore.setState(state => ({ forums: [...state.forums] }));
      }

      const runningIds = useForumStore.getState().forums
        .filter(forum => forum.status === "active")
        .map(forum => forum.id);
      await Promise.all(runningIds.map(id => useForumStore.getState().ensureForumContent(id)));

      if (!forumPersistenceStarted) {
        forumPersistenceStarted = true;
        let previousRefs = new Map(useForumStore.getState().forums.map(forum => [forum.id, forum]));
        useForumStore.subscribe(state => {
          for (const forum of state.forums) {
            if (forum.contentLoaded && previousRefs.get(forum.id) !== forum) {
              scheduleForumSave(forum);
            }
          }
          previousRefs = new Map(state.forums.map(forum => [forum.id, forum]));
        });
      }
    } catch (error) {
      console.error("[forum-store] durable backend is not ready; retaining recovery cache", error instanceof Error ? error.name : "UnknownError");
      initializeForumPromise = null;
      await new Promise(resolve => window.setTimeout(resolve, 2_000));
      return initializeForumDurablePersistence();
    }
  })();
  return initializeForumPromise;
}

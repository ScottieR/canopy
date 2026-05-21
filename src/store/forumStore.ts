import { create } from "zustand";
import { persist } from "zustand/middleware";

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

export interface ForumArtifact {
  id: string;
  type: ForumArtifactType;
  title: string;
  content: string;        // markdown text; URL for image/deck; raw HTML for html type
  preview?: string;       // optional short excerpt (auto-derived if absent)
  agentId?: string;
  agentName?: string;
  createdAt: number;
  /** True only for the final user-facing deliverable — not intermediate research/strategy notes. */
  isDeliverable?: boolean;
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
  tokenLimit: number;       // max tokens for this forum
  tokensUsed: number;
  usdLimit: number;         // max $ spend
  usdUsed: number;
  circuitBreakerFired: boolean;
}

// ─── Forum ────────────────────────────────────────────────────────────────────

export type ForumStatus = "drafting" | "active" | "paused" | "completed" | "archived";

export interface Forum {
  id: string;
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
  createdAt: number;
  lastActiveAt: number;
  // Incremented each time the orchestrator is asked to start/restart — lets the
  // useEffect distinguish a fresh run from one that already ran for this version.
  orchestratorVersion: number;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export interface ForumState {
  forums: Forum[];
  activeForumId: string | null;

  // Actions
  createForum: (brief: string, agents: ForumAgent[], tags: string[]) => string;
  setActiveForumId: (id: string | null) => void;
  /** Adds a message and returns the generated message ID. */
  addForumMessage: (forumId: string, msg: Omit<ForumMessage, "id" | "timestamp">) => string;
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
  /** Set the format-aware blackboard block (markdown or HTML deliverable). */
  setBlackboardBlock: (forumId: string, block: ForumBlock) => void;
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
  /** Replace the forum's milestone list with agent-defined steps. */
  setMilestones: (forumId: string, milestones: Milestone[]) => void;
  /** Append a new milestone (used by orchestrator to add project-specific steps). */
  addMilestone: (forumId: string, label: string, agentId?: string) => string;
}

function generateId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function deriveTitle(brief: string): string {
  const words = brief.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length < brief.trim().length ? words + "…" : words;
}

function deriveMilestones(brief: string, agents: ForumAgent[]): Milestone[] {
  // Simple heuristic milestones based on agent roles present
  const milestones: Milestone[] = [];
  const hasResearcher = agents.some(a =>
    a.role.toLowerCase().includes("research") || a.forumRole.toLowerCase().includes("research")
  );
  const hasEditor = agents.some(a =>
    a.role.toLowerCase().includes("edit") || a.forumRole.toLowerCase().includes("edit") || a.forumRole.toLowerCase().includes("prose")
  );
  const hasStrategist = agents.some(a =>
    a.role.toLowerCase().includes("strat") || a.forumRole.toLowerCase().includes("fram")
  );

  if (hasResearcher) {
    milestones.push({ id: generateId("ms"), label: "Research & data pull", status: "pending", agentId: agents.find(a => a.role.toLowerCase().includes("research"))?.agentId });
  }
  if (hasStrategist) {
    milestones.push({ id: generateId("ms"), label: "Strategic framing", status: "pending", agentId: agents.find(a => a.role.toLowerCase().includes("strat"))?.agentId });
  }
  if (hasEditor) {
    milestones.push({ id: generateId("ms"), label: "Prose & voice pass", status: "pending", agentId: agents.find(a => a.role.toLowerCase().includes("edit") || a.forumRole.toLowerCase().includes("prose"))?.agentId });
  }
  milestones.push({ id: generateId("ms"), label: "Final deliverable ready", status: "pending" });

  // Mark first milestone active
  if (milestones.length > 0) milestones[0].status = "active";

  return milestones;
}

export const useForumStore = create<ForumState>()(
  persist(
    (set, get) => ({
      forums: [],
      activeForumId: null,

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
          createdAt: now,
          lastActiveAt: now,
          orchestratorVersion: 0,
        };

        set(state => ({ forums: [...state.forums, forum], activeForumId: id }));
        return id;
      },

      setActiveForumId: (id) => set({ activeForumId: id }),

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
          forums: state.forums.map(f =>
            f.id === forumId
              ? { ...f, artifacts: [...f.artifacts, { ...artifact, id, createdAt }] }
              : f
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

      deleteForum: (forumId) => {
        set(state => ({
          forums: state.forums.filter(f => f.id !== forumId),
          activeForumId: state.activeForumId === forumId ? null : state.activeForumId,
        }));
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
              agents: f.agents.map(a => ({ ...a, currentAction: "Joining forum…" })),
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
              text: "↺ Resuming project…",
              timestamp: now,
            };
            return {
              ...f,
              status: "active",
              messages: [...cleanedMessages, divider],
              agents: f.agents.map(a => ({ ...a, currentAction: "Resuming…" })),
              lastActiveAt: now,
              orchestratorVersion: (f.orchestratorVersion ?? 0) + 1,
            };
          }),
        }));
      },

      setMilestones: (forumId, milestones) => {
        set(state => ({
          forums: state.forums.map(f =>
            f.id === forumId ? { ...f, milestones } : f
          ),
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
      partialize: (state) => ({ forums: state.forums }),
    }
  )
);

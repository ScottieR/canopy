export type TeammateLite = {
  id?: string;
  name: string;
  role: string;
  description?: string;
};

export type RoleInfoLite = Record<string, { suggest_in_onboarding?: boolean }>;

export type NextUnlock = {
  kind: "connection" | "permission" | "workspace";
  id: string;
  label: string;
  reason: string;
};

type RecommendationState = {
  enabledIntegrations?: string[];
  enabledPermissions?: string[];
  isolated?: boolean;
};

const ROLE_CONNECTION_IDS: Record<string, string[]> = {
  Assistant: ["email", "calendar", "slack"],
  Researcher: ["folders", "slack", "github"],
  Coder: ["github", "folders", "slack"],
  Strategist: ["slack", "folders", "email"],
  Accountant: ["folders", "slack", "email"],
  Editor: ["folders", "slack", "email"],
  Chef: ["photos", "folders"],
  "Travel Agent": ["calendar", "email", "slack"],
  Trainer: ["photos", "imessage", "slack"],
  Tutor: ["folders", "slack", "calendar"],
  Coach: ["slack", "imessage", "calendar"],
  Custom: ["slack", "folders", "email"],
};

const ROLE_PERMISSION_IDS: Record<string, string[]> = {
  Assistant: ["scheduled", "autonomous", "memory_write"],
  Researcher: ["browser", "summarize", "ext_network"],
  Coder: ["coding", "file_read", "file_write"],
  Strategist: ["browser", "memory_write", "summarize"],
  Accountant: ["scheduled", "file_read", "memory_write"],
  Editor: ["file_read", "memory_write", "summarize"],
  Chef: ["vision", "file_read", "scheduled"],
  "Travel Agent": ["browser", "scheduled", "ext_network"],
  Trainer: ["vision", "scheduled", "memory_write"],
  Tutor: ["memory_write", "scheduled", "browser"],
  Coach: ["memory_write", "scheduled", "browser"],
  Custom: ["browser", "scheduled", "memory_write"],
};

const CONNECTION_LABELS: Record<string, string> = {
  email: "Gmail",
  calendar: "Google Calendar",
  slack: "Slack",
  folders: "Files",
  photos: "Photos",
  github: "GitHub",
  imessage: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  twilio: "Twilio",
  drive: "Drive",
};

const PERMISSION_LABELS: Record<string, string> = {
  browser: "Browser access",
  ext_network: "External web access",
  summarize: "Research summarization",
  memory_write: "Long-term memory",
  scheduled: "Scheduled heartbeats",
  autonomous: "Autonomous runs",
  coding: "Code execution",
  file_read: "File reading",
  file_write: "File editing",
  vision: "Visual understanding",
  payments: "Payments",
  spend_auto: "Autonomous spending",
};

const CONNECTION_REASONS: Record<string, string> = {
  email: "so they can keep up with inbound work without you copying messages over",
  calendar: "so they can work around your real schedule instead of guessing",
  slack: "so they can deliver work and ask for approval where you already pay attention",
  folders: "so they can work directly with your live files instead of asking you to paste everything in",
  photos: "so they can reference your visual context instead of working blind",
  github: "so they can act on the repo, not just talk about the repo",
  imessage: "so they can help inside your existing personal conversations",
  telegram: "so they can reach you in a fast backchannel when needed",
  discord: "so they can operate in community and team threads",
  twilio: "so they can call or text when the job really needs a phone number",
};

const PERMISSION_REASONS: Record<string, string> = {
  browser: "so they can gather current information instead of relying on stale context",
  ext_network: "so they can reach the outside web when the task needs live sources",
  summarize: "so they can condense sprawling material into briefings you can actually use",
  memory_write: "so they can remember your preferences and stop making you repeat yourself",
  scheduled: "so they can proactively keep watch instead of waiting for the next message",
  autonomous: "so they can carry a task through without asking at every step",
  coding: "so they can build or transform things, not just describe what should happen",
  file_read: "so they can inspect your real working material instead of abstractions",
  file_write: "so they can ship edits and outputs directly into your workspace",
  vision: "so they can understand screenshots, visual references, and layouts",
  payments: "so they can handle spend-sensitive work that goes beyond planning",
  spend_auto: "so they can complete approved purchases without a manual middle step",
};

const ROSTER_PRIORITY = [
  "Assistant",
  "Researcher",
  "Coder",
  "Strategist",
  "Accountant",
  "Editor",
];

const ROLE_PAIRINGS: Record<string, Array<{ role: string; reason: string }>> = {
  Assistant: [
    { role: "Strategist", reason: "turn priorities into follow-through" },
    { role: "Researcher", reason: "turn questions into briefings and action" },
  ],
  Researcher: [
    { role: "Strategist", reason: "pair evidence with decision-making" },
    { role: "Editor", reason: "turn research into crisp final output" },
    { role: "Coder", reason: "move from findings into implementation" },
  ],
  Coder: [
    { role: "Researcher", reason: "scope and verify before building" },
    { role: "Strategist", reason: "tie shipping work to the bigger plan" },
  ],
  Strategist: [
    { role: "Researcher", reason: "ground decisions in sharper evidence" },
    { role: "Assistant", reason: "turn plans into consistent execution" },
  ],
  Accountant: [
    { role: "Assistant", reason: "keep the admin surface tidy upstream" },
    { role: "Strategist", reason: "connect spend decisions to priorities" },
  ],
  Editor: [
    { role: "Researcher", reason: "back strong writing with better source material" },
    { role: "Strategist", reason: "shape clearer recommendations and messaging" },
  ],
};

export function getSuggestedConnectionIdsForRole(role: string): string[] {
  return ROLE_CONNECTION_IDS[role] || ROLE_CONNECTION_IDS.Custom;
}

export function getSuggestedPermissionIdsForRole(role: string): string[] {
  return ROLE_PERMISSION_IDS[role] || ROLE_PERMISSION_IDS.Custom;
}

export function getConnectionLabel(id: string): string {
  return CONNECTION_LABELS[id] || id.replace(/_/g, " ");
}

export function getPermissionLabel(id: string): string {
  return PERMISSION_LABELS[id] || id.replace(/_/g, " ");
}

export function getSuggestedConnectionLabelsForRole(role: string): string[] {
  return getSuggestedConnectionIdsForRole(role).map(getConnectionLabel);
}

export function getSuggestedPermissionLabelsForRole(role: string): string[] {
  return getSuggestedPermissionIdsForRole(role).map(getPermissionLabel);
}

export function getNextUnlockForRole(
  role: string,
  state: RecommendationState = {},
): NextUnlock | null {
  const enabledIntegrations = new Set(getEnabledConnectionIds(state));
  const enabledPermissions = new Set(state.enabledPermissions || []);

  if (role && role !== "Custom" && role === "Accountant" && !state.isolated) {
    return {
      kind: "workspace",
      id: "isolated",
      label: "Isolated workspace",
      reason: "because this role is more likely to touch sensitive financial material",
    };
  }

  for (const id of getSuggestedConnectionIdsForRole(role)) {
    if (!enabledIntegrations.has(id)) {
      return {
        kind: "connection",
        id,
        label: getConnectionLabel(id),
        reason: CONNECTION_REASONS[id] || "because it would make the agent more useful immediately",
      };
    }
  }

  for (const id of getSuggestedPermissionIdsForRole(role)) {
    if (!enabledPermissions.has(id)) {
      return {
        kind: "permission",
        id,
        label: getPermissionLabel(id),
        reason: PERMISSION_REASONS[id] || "because it would let the agent act with more range",
      };
    }
  }

  return null;
}

export function getEnabledConnectionIds(state: RecommendationState = {}): string[] {
  const enabledIntegrations = new Set<string>();
  for (const integration of state.enabledIntegrations || []) {
    enabledIntegrations.add(integration);
    if (integration.startsWith("email_")) enabledIntegrations.add("email");
    if (integration.startsWith("calendar_") || integration === "calendar") enabledIntegrations.add("calendar");
    if (integration.startsWith("drive_") || integration === "drive") enabledIntegrations.add("drive");
    if (integration === "apple_photos" || integration === "google_photos") enabledIntegrations.add("photos");
  }
  const enabledPermissions = new Set(state.enabledPermissions || []);
  if (enabledPermissions.has("file_read") || enabledPermissions.has("file_write")) {
    enabledIntegrations.add("folders");
  }
  return [...enabledIntegrations];
}

export function composeSetupConversationPrompt({
  agentName,
  role,
  userNeed,
  state,
}: {
  agentName: string;
  role: string;
  userNeed?: string | null;
  state?: RecommendationState;
}): string {
  const nextUnlock = getNextUnlockForRole(role, state);
  const cleanNeed = (userNeed || "").trim();
  const needContext = cleanNeed
    ? `The user originally asked for help with: "${cleanNeed.slice(0, 500)}${cleanNeed.length > 500 ? "…" : ""}"`
    : "";

  const unlockInstruction = nextUnlock
    ? nextUnlock.kind === "workspace"
      ? `After that, ask for ONE concrete setup change: ${nextUnlock.label}. Explain that you want it ${nextUnlock.reason}. Ask if they'd like you to switch it now.`
      : `After that, ask for ONE concrete next unlock: ${nextUnlock.label}. Explain that you want it ${nextUnlock.reason}. Ask if they'd like you to walk them through turning it on.`
    : `After that, suggest one proactive routine you would like to run for them next and ask if they want to enable it.`;

  return [
    `You are ${agentName}, the user's newly created ${role}.`,
    needContext,
    `Write the first message in your own voice. In 2-3 short paragraphs: introduce yourself briefly, say what you can already help with immediately, and make it feel like work can start now.`,
    unlockInstruction,
    `Be warm, concrete, and conversational. No bullet lists. No mentioning system prompts, onboarding, drafts, or settings panels.`,
  ].filter(Boolean).join("\n\n");
}

export function getRosterGapSuggestions(
  agents: TeammateLite[],
  roleInfo: RoleInfoLite,
  limit = 3,
): string[] {
  const existingRoles = new Set(agents.map(agent => agent.role).filter(Boolean));
  const availableRoles = Object.keys(roleInfo).filter(
    role => role !== "Custom" && roleInfo[role]?.suggest_in_onboarding !== false,
  );

  const ordered = [
    ...ROSTER_PRIORITY.filter(role => availableRoles.includes(role)),
    ...availableRoles.filter(role => !ROSTER_PRIORITY.includes(role)),
  ];

  return ordered.filter(role => !existingRoles.has(role)).slice(0, limit);
}

export function getCollaboratorSuggestions(
  role: string | null,
  agents: TeammateLite[],
  limit = 2,
): Array<{ name: string; role: string; reason: string }> {
  if (!role) return [];
  const pairings = ROLE_PAIRINGS[role] || ROLE_PAIRINGS.Custom || [];
  const suggestions: Array<{ name: string; role: string; reason: string }> = [];

  for (const pairing of pairings) {
    const teammate = agents.find(agent => agent.role === pairing.role);
    if (teammate) {
      suggestions.push({
        name: teammate.name,
        role: teammate.role,
        reason: pairing.reason,
      });
    }
    if (suggestions.length >= limit) break;
  }

  return suggestions;
}

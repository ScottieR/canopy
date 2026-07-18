import type { AgentData } from "../store/worldStore";

export type HeartbeatTask = {
  id: string;
  name: string;
  title: string;
  interval: string;
  prompt: string;
  scheduleLabel: string;
  dependencies: string[];
};

export type HeartbeatFileState = {
  tasks: HeartbeatTask[];
  additionalInstructions: string;
};

export type HeartbeatSuggestion = HeartbeatTask & {
  missingIntegrations: string[];
  missingPermissions: string[];
  ready: boolean;
};

type SuggestedHeartbeatTemplate = {
  name: string;
  title: string;
  interval: string;
  scheduleLabel: string;
  prompt: string;
  dependencies?: string[];
  roles?: string[];
  integrationsAny?: string[];
  permissionsAny?: string[];
};

const DEFAULT_INSTRUCTIONS = [
  "- Keep alerts short.",
  "- If nothing needs attention, reply HEARTBEAT_OK.",
].join("\n");

const SUGGESTED_HEARTBEATS: SuggestedHeartbeatTemplate[] = [
  {
    name: "weekday-briefing",
    title: "Weekday morning briefing",
    interval: "1d",
    scheduleLabel: "Every weekday morning",
    prompt: "Check calendar and inbox, then prepare a concise morning briefing with top priorities, meetings, and anything urgent.",
    dependencies: ["calendar", "email"],
    roles: ["Assistant", "Strategist", "Trainer"],
    integrationsAny: ["calendar", "email", "gmail"],
  },
  {
    name: "friday-wrap-up",
    title: "Friday wrap-up",
    interval: "7d",
    scheduleLabel: "Every Friday afternoon",
    prompt: "Summarize open work, blockers, and next steps in a short Friday wrap-up.",
    dependencies: ["slack", "github"],
    roles: ["Strategist", "Assistant", "Coder", "Researcher"],
    integrationsAny: ["slack", "github", "email"],
  },
  {
    name: "pr-triage",
    title: "PR and issue triage",
    interval: "1d",
    scheduleLabel: "Every workday afternoon",
    prompt: "Review open pull requests and issues, then flag anything blocked, stale, or needing urgent follow-up.",
    dependencies: ["github"],
    roles: ["Coder"],
    integrationsAny: ["github"],
  },
  {
    name: "research-scan",
    title: "Research scan",
    interval: "2d",
    scheduleLabel: "Every other day",
    prompt: "Check for important new developments in the topics this role owns and surface anything that changes the current recommendation.",
    dependencies: ["browser"],
    roles: ["Researcher", "Strategist"],
    permissionsAny: ["browser", "gog", "ext_network"],
  },
  {
    name: "expense-watch",
    title: "Expense and spend watch",
    interval: "1d",
    scheduleLabel: "Daily",
    prompt: "Review recent spending and flag anything unusual, over-budget, or needing human review.",
    dependencies: ["payments"],
    roles: ["Accountant"],
    permissionsAny: ["payments"],
  },
  {
    name: "meal-plan-checkin",
    title: "Meal plan check-in",
    interval: "7d",
    scheduleLabel: "Weekly",
    prompt: "Suggest the next set of meals, check for repetition, and surface a simple grocery plan.",
    roles: ["Chef"],
  },
  {
    name: "trip-countdown",
    title: "Trip countdown check-in",
    interval: "7d",
    scheduleLabel: "Weekly before travel",
    prompt: "Review upcoming travel plans and surface anything that needs booking, confirmation, or prep.",
    dependencies: ["calendar", "email"],
    roles: ["Travel Agent"],
    integrationsAny: ["calendar", "email"],
  },
  {
    name: "editing-backlog",
    title: "Editing backlog review",
    interval: "3d",
    scheduleLabel: "Twice a week",
    prompt: "Review pending drafts, editing tasks, or writing artifacts and surface what is closest to ready or blocked on feedback.",
    roles: ["Editor"],
  },
];

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function quoteYamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquoteYamlString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

export function intervalToLabel(interval: string): string {
  switch (interval) {
    case "30m":
      return "Every 30 minutes";
    case "2h":
      return "Every 2 hours";
    case "1d":
      return "Daily";
    case "3d":
      return "Twice a week";
    case "7d":
      return "Weekly";
    default:
      return interval;
  }
}

function toHeartbeatTask(template: SuggestedHeartbeatTemplate): HeartbeatTask {
  return {
    id: slugify(template.name),
    name: template.name,
    title: template.title,
    interval: template.interval,
    prompt: template.prompt,
    scheduleLabel: template.scheduleLabel,
    dependencies: template.dependencies || [],
  };
}

function createSets(integrations: string[], permissions: string[]) {
  return {
    integrations: new Set((integrations || []).map(item => item.toLowerCase())),
    permissions: new Set((permissions || []).map(item => item.toLowerCase())),
  };
}

export function getHeartbeatSuggestionsForProfile(input: {
  role: string;
  integrations?: string[];
  permissions?: string[];
}): HeartbeatSuggestion[] {
  const { role, integrations = [], permissions = [] } = input;
  const available = createSets(integrations, permissions);

  const matches = SUGGESTED_HEARTBEATS
    .filter(template => !template.roles || template.roles.includes(role))
    .map(template => {
      const hasRequiredIntegration =
        !template.integrationsAny ||
        template.integrationsAny.some(integration => available.integrations.has(integration.toLowerCase()));
      const hasRequiredPermission =
        !template.permissionsAny ||
        template.permissionsAny.some(permission => available.permissions.has(permission.toLowerCase()));

      const missingIntegrations = hasRequiredIntegration ? [] : [...(template.integrationsAny || [])];
      const missingPermissions = hasRequiredPermission ? [] : [...(template.permissionsAny || [])];

      return {
        ...toHeartbeatTask(template),
        missingIntegrations,
        missingPermissions,
        ready: missingIntegrations.length === 0 && missingPermissions.length === 0,
      };
    })
    .sort((a, b) => Number(b.ready) - Number(a.ready));

  if (matches.length > 0) return matches;

  return [
    {
      id: "weekly-checkin",
      name: "weekly-checkin",
      title: "Weekly check-in",
      interval: "7d",
      scheduleLabel: "Weekly",
      prompt: `Review the work this ${role.toLowerCase()} should own, then surface anything that needs attention or a proactive check-in.`,
      dependencies: [],
      missingIntegrations: [],
      missingPermissions: [],
      ready: true,
    },
  ];
}

export function parseHeartbeatFile(content: string): HeartbeatFileState {
  const normalized = (content || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const tasks: HeartbeatTask[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "tasks:") {
      i += 1;
      while (i < lines.length) {
        const current = lines[i];
        const trimmed = current.trim();
        if (!trimmed) {
          i += 1;
          continue;
        }
        if (!trimmed.startsWith("- name:")) break;

        const name = trimmed.slice("- name:".length).trim();
        let interval = "1d";
        let prompt = "";
        i += 1;
        while (i < lines.length) {
          const detail = lines[i];
          const detailTrimmed = detail.trim();
          if (!detailTrimmed) {
            i += 1;
            continue;
          }
          if (detailTrimmed.startsWith("- name:") || detailTrimmed.startsWith("#")) break;
          if (detailTrimmed.startsWith("interval:")) {
            interval = detailTrimmed.slice("interval:".length).trim();
          } else if (detailTrimmed.startsWith("prompt:")) {
            prompt = unquoteYamlString(detailTrimmed.slice("prompt:".length));
          }
          i += 1;
        }
        tasks.push({
          id: slugify(name),
          name,
          title: name.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
          interval,
          prompt,
          scheduleLabel: intervalToLabel(interval),
          dependencies: [],
        });
        continue;
      }
    }
    i += 1;
  }

  let additionalInstructions = "";
  const marker = "# Additional instructions";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    additionalInstructions = normalized.slice(markerIndex + marker.length).trim();
  } else if (tasks.length === 0) {
    additionalInstructions = normalized.trim();
  }

  return {
    tasks,
    additionalInstructions,
  };
}

export function serializeHeartbeatFile(state: HeartbeatFileState): string {
  const sections: string[] = [
    "<!-- Managed by Canopy. Advanced users may edit directly. -->",
    "",
    "tasks:",
  ];

  if (state.tasks.length === 0) {
    sections.push("");
  } else {
    state.tasks.forEach(task => {
      sections.push(`- name: ${task.name}`);
      sections.push(`  interval: ${task.interval}`);
      sections.push(`  prompt: ${quoteYamlString(task.prompt)}`);
    });
  }

  sections.push("", "# Additional instructions", "");
  sections.push((state.additionalInstructions || DEFAULT_INSTRUCTIONS).trim());
  sections.push("");

  return sections.join("\n");
}

export function getRecommendedHeartbeats(agent: AgentData): HeartbeatTask[] {
  return getHeartbeatSuggestionsForProfile({
    role: agent.role,
    integrations: agent.integrations || [],
    permissions: (agent.permissions || [])
      .filter(permission => permission.enabled)
      .map(permission => permission.id),
  })
    .filter(suggestion => suggestion.ready)
    .map(({ missingIntegrations: _missingIntegrations, missingPermissions: _missingPermissions, ready: _ready, ...task }) => task);
}

export function mergeSuggestedHeartbeats(
  activeTasks: HeartbeatTask[],
  suggestedTasks: HeartbeatTask[]
): HeartbeatTask[] {
  const existing = new Set(activeTasks.map(task => task.name));
  return suggestedTasks.filter(task => !existing.has(task.name));
}

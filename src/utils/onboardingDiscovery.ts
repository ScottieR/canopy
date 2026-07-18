export type DiscoveryRoleInfo = {
  description?: string;
  defaultPrompt?: string;
  accessories?: string[];
  recommended_isolated?: boolean;
  recommended_tier?: "guarded" | "balanced" | "unrestricted";
};

export type DiscoveryExample = {
  role: string;
  label: string;
  prompt: string;
};

export type VoiceDefault = {
  voice: string;
  rate: number;
  sample: string;
};

export type DiscoveryDraft = {
  primaryRole: string | null;
  alternatives: string[];
  matchedKeywords: string[];
};

const ROLE_KEYWORDS: Record<string, string[]> = {
  Assistant: ["calendar", "inbox", "email", "meeting", "schedule", "organize", "follow-up", "logistics", "assistant"],
  Researcher: ["research", "analyze", "analysis", "briefing", "market", "trend", "compare", "findings", "sources"],
  Coder: ["code", "bug", "repo", "github", "build", "ship", "engineering", "software", "script", "app"],
  Strategist: ["strategy", "decision", "plan", "roadmap", "competitive", "quarterly", "framework", "positioning"],
  Accountant: ["budget", "expense", "spend", "invoice", "tax", "receipt", "finance", "financial", "bookkeeping"],
  Editor: ["edit", "writing", "copy", "draft", "voice", "essay", "revise", "prose", "blog"],
  Chef: ["meal", "cook", "recipe", "grocery", "dinner", "kitchen", "food", "menu"],
  "Travel Agent": ["travel", "trip", "itinerary", "flight", "hotel", "vacation", "booking"],
  Trainer: ["workout", "fitness", "training", "exercise", "gym", "health", "nutrition"],
};

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "have", "into", "about",
  "they", "them", "their", "then", "when", "what", "which", "would", "there", "could", "should",
  "want", "need", "over", "under", "just", "more", "less", "help", "daily", "every", "make",
]);

export const DISCOVERY_EXAMPLES: DiscoveryExample[] = [
  {
    role: "Assistant",
    label: "Clear my mornings",
    prompt: "I keep losing time to inbox triage, meeting prep, and little logistics that should already be handled.",
  },
  {
    role: "Researcher",
    label: "Research for me",
    prompt: "I need someone to gather sources, compare options, and hand me crisp briefings instead of a pile of tabs.",
  },
  {
    role: "Coder",
    label: "Ship faster",
    prompt: "I want an agent that can help me fix bugs, write code, and stay on top of my repo backlog.",
  },
  {
    role: "Strategist",
    label: "Think through decisions",
    prompt: "I need help pressure-testing decisions, competitive moves, and quarterly priorities before I commit.",
  },
  {
    role: "Accountant",
    label: "Stay on budget",
    prompt: "I want help tracking spending, organizing receipts, and flagging anything unusual before it turns into cleanup.",
  },
  {
    role: "Editor",
    label: "Tighten my writing",
    prompt: "I need an agent that can make my writing sharper, keep my voice consistent, and catch clunky drafts fast.",
  },
];

export const DEFAULT_ROLE_NAMES: Record<string, string> = {
  Assistant: "Sloane",
  Researcher: "Atlas",
  Coder: "Dev",
  Strategist: "Marlowe",
  Accountant: "Ledger",
  Editor: "Quill",
  Chef: "Mise",
  "Travel Agent": "Harbor",
  Trainer: "Pace",
};

export const ROLE_VOICE_DEFAULTS: Record<string, VoiceDefault> = {
  Assistant: { voice: "alloy", rate: 1.02, sample: "I can start by triaging your calendar, inbox, and loose ends before they stack up." },
  Researcher: { voice: "nova", rate: 0.98, sample: "Give me the question, and I will bring back a concise, source-backed briefing." },
  Coder: { voice: "echo", rate: 1.0, sample: "Point me at the bug or the repo, and I will help you ship a cleaner fix." },
  Strategist: { voice: "onyx", rate: 0.96, sample: "I pressure-test decisions, surface tradeoffs, and turn ambiguity into a sharper plan." },
  Accountant: { voice: "shimmer", rate: 0.94, sample: "I will track the numbers carefully and flag anything that deserves a second look." },
  Editor: { voice: "fable", rate: 1.0, sample: "I tighten prose, preserve your voice, and make rough drafts read like finished work." },
  Chef: { voice: "nova", rate: 1.03, sample: "I can turn dinner chaos into a simple plan, a grocery list, and meals you will actually want." },
  "Travel Agent": { voice: "alloy", rate: 1.0, sample: "I line up the itinerary, the logistics, and the little details that make travel feel smooth." },
  Trainer: { voice: "onyx", rate: 1.04, sample: "I can keep your plan practical, consistent, and honest about what will move the needle." },
};

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 2 && !STOP_WORDS.has(token));
}

export function inferRoleFromPrompt(
  input: string,
  roleInfo: Record<string, DiscoveryRoleInfo>,
): DiscoveryDraft {
  const clean = (input || "").trim();
  const availableRoles = Object.keys(roleInfo).filter(role => role !== "Custom");
  if (!clean) {
    return {
      primaryRole: availableRoles[0] || null,
      alternatives: availableRoles.slice(1, 4),
      matchedKeywords: [],
    };
  }

  const tokens = tokenize(clean);
  const scored = availableRoles.map(role => {
    const info = roleInfo[role] || {};
    const keywords = ROLE_KEYWORDS[role] || [];
    const matchedKeywords = keywords.filter(keyword => clean.toLowerCase().includes(keyword));
    const contextTokens = new Set([
      ...tokenize(role),
      ...tokenize(info.description || ""),
      ...tokenize(info.defaultPrompt || ""),
    ]);
    const overlapScore = tokens.filter(token => contextTokens.has(token)).length;
    const keywordScore = matchedKeywords.length * 3;
    const score = keywordScore + overlapScore;
    return { role, score, matchedKeywords };
  }).sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));

  const best = scored[0];
  if (!best || best.score <= 0) {
    return {
      primaryRole: availableRoles[0] || null,
      alternatives: availableRoles.slice(1, 4),
      matchedKeywords: [],
    };
  }

  return {
    primaryRole: best.role,
    alternatives: scored.slice(1, 4).map(item => item.role),
    matchedKeywords: best.matchedKeywords,
  };
}

export function getRoleDefaultName(role: string): string {
  return DEFAULT_ROLE_NAMES[role] || role;
}

export function getRoleVoiceDefault(role: string): VoiceDefault {
  return ROLE_VOICE_DEFAULTS[role] || {
    voice: "alloy",
    rate: 1,
    sample: "I am ready to help with the work you want off your plate.",
  };
}

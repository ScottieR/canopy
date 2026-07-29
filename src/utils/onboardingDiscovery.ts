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
  category: "focused" | "holistic";
  action: "draft_role" | "seed_prompt";
};

export type VoiceDefault = {
  voice: string;
  rate: number;
  sample: string;
  voiceLabel: string;
  style: string;
  provider: "eleven_labs" | "openai_tts";
  selectionReason: string;
};

export type VoiceProfile = Omit<VoiceDefault, "rate" | "sample">;

// How sure the deterministic matcher is about the drafted role.
// "high"  — at least one direct keyword match (score >= KEYWORD_SCORE).
// "low"   — only weak context-token overlap; the draft is a guess worth hedging.
// "none"  — nothing matched (or empty input); we fell back to the first role.
// The wizard MUST vary its copy on low/none: never assert confidence the
// matcher doesn't have (persona review §7, gap 4).
export type DiscoveryConfidence = "high" | "low" | "none";

export type DiscoveryDraft = {
  primaryRole: string | null;
  alternatives: string[];
  matchedKeywords: string[];
  confidence: DiscoveryConfidence;
};

// ─── Generative persona drafting (Workstream C3 scaffold) ────────────────────
// When the matcher returns low/none confidence AND generative drafting is
// enabled (hosted inference or a configured key), the wizard may request a
// tailored persona instead of settling for the fallback role. The draft MUST
// resolve to a base template blend so accessories/voice/access defaults stay
// deterministic (July 18 decision: static cards stay high-usage; niche comes
// from generation). Until the inference path ships, isGenerativeDiscoveryEnabled
// returns false and the honest-copy fallback is used.
export type GenerativePersonaDraft = {
  name: string;
  roleSummary: string;
  personalitySeed: string;
  baseTemplateBlend: string[];      // existing role keys, e.g. ["Assistant", "Accountant"]
  suggestedConnections: string[];
  suggestedHeartbeatNames: string[];
};

export const GENERATIVE_DISCOVERY_FLAG = "canopy_generative_discovery";

export function isGenerativeDiscoveryEnabled(): boolean {
  try {
    return localStorage.getItem(GENERATIVE_DISCOVERY_FLAG) === "true";
  } catch {
    return false;
  }
}

const ROLE_KEYWORDS: Record<string, string[]> = {
  Assistant: ["calendar", "inbox", "email", "meeting", "schedule", "organize", "follow-up", "logistics", "assistant", "family", "household", "errands", "school", "kids", "home"],
  Researcher: ["research", "analyze", "analysis", "briefing", "market", "trend", "compare", "findings", "sources"],
  Coder: ["code", "bug", "repo", "github", "build", "ship", "engineering", "software", "script", "app"],
  Strategist: ["strategy", "decision", "plan", "roadmap", "competitive", "quarterly", "framework", "positioning", "business", "launch", "founder", "company", "growth", "advice"],
  Accountant: ["budget", "expense", "spend", "invoice", "tax", "receipt", "finance", "financial", "bookkeeping", "cashflow", "payroll", "margin"],
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
    category: "focused",
    action: "seed_prompt",
  },
  {
    role: "Researcher",
    label: "Research for me",
    prompt: "I need someone to gather sources, compare options, and hand me crisp briefings instead of a pile of tabs.",
    category: "focused",
    action: "seed_prompt",
  },
  {
    role: "Coder",
    label: "Ship faster",
    prompt: "I want an agent that can help me fix bugs, write code, and stay on top of my repo backlog.",
    category: "focused",
    action: "seed_prompt",
  },
  {
    role: "Strategist",
    label: "Think through decisions",
    prompt: "I need help pressure-testing decisions, competitive moves, and quarterly priorities before I commit.",
    category: "focused",
    action: "seed_prompt",
  },
  {
    role: "Accountant",
    label: "Stay on budget",
    prompt: "I want help tracking spending, organizing receipts, and flagging anything unusual before it turns into cleanup.",
    category: "focused",
    action: "seed_prompt",
  },
  {
    role: "Editor",
    label: "Tighten my writing",
    prompt: "I need an agent that can make my writing sharper, keep my voice consistent, and catch clunky drafts fast.",
    category: "focused",
    action: "seed_prompt",
  },
  {
    role: "Assistant",
    label: "Manage my family chaos",
    prompt: "My family calendar, school logistics, errands, appointments, and household loose ends keep slipping through the cracks.",
    category: "holistic",
    action: "seed_prompt",
  },
  {
    role: "Strategist",
    label: "Launch my new business",
    prompt: "I am launching a new business and need an agent who can help me think through priorities, positioning, planning, and next steps across the whole effort.",
    category: "holistic",
    action: "seed_prompt",
  },
  {
    role: "Accountant",
    label: "Run my small business",
    prompt: "I run a small business and need steady help across operations, spending, planning, and the recurring admin that keeps the business healthy.",
    category: "holistic",
    action: "seed_prompt",
  },
  {
    role: "Strategist",
    label: "Give me life advice",
    prompt: "I want a steady thought partner who can help me think through life decisions, tradeoffs, priorities, and what to do next when things feel messy.",
    category: "holistic",
    action: "seed_prompt",
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

export const VOICE_PROFILE_LIBRARY: Record<string, VoiceProfile> = {
  alloy: {
    voice: "alloy",
    voiceLabel: "Harbor",
    style: "steady, welcoming, and easy to trust",
    provider: "eleven_labs",
    selectionReason: "A calm, dependable voice for someone who keeps life moving.",
  },
  echo: {
    voice: "echo",
    voiceLabel: "Forge",
    style: "crisp, direct, and quietly technical",
    provider: "eleven_labs",
    selectionReason: "A sharper voice for builders, operators, and technical work.",
  },
  fable: {
    voice: "fable",
    voiceLabel: "Quill",
    style: "warm, articulate, and editorial",
    provider: "eleven_labs",
    selectionReason: "A thoughtful voice for writing, coaching, and refinement.",
  },
  nova: {
    voice: "nova",
    voiceLabel: "Atlas",
    style: "clear, curious, and bright",
    provider: "eleven_labs",
    selectionReason: "An energetic voice for research, exploration, and momentum.",
  },
  onyx: {
    voice: "onyx",
    voiceLabel: "Marlowe",
    style: "grounded, strategic, and authoritative",
    provider: "eleven_labs",
    selectionReason: "A grounded voice for strategy, judgment, and big-picture thinking.",
  },
  shimmer: {
    voice: "shimmer",
    voiceLabel: "Lumen",
    style: "precise, reassuring, and polished",
    provider: "eleven_labs",
    selectionReason: "A polished voice for careful guidance, finance, and detail work.",
  },
};

function withVoiceProfile(voice: string, rate: number, sample: string): VoiceDefault {
  const profile = VOICE_PROFILE_LIBRARY[voice] || VOICE_PROFILE_LIBRARY.alloy;
  return { ...profile, voice, rate, sample };
}

export const ROLE_VOICE_DEFAULTS: Record<string, VoiceDefault> = {
  Assistant: withVoiceProfile("alloy", 1.02, "I can start by triaging your calendar, inbox, and loose ends before they stack up."),
  Researcher: withVoiceProfile("nova", 0.98, "Give me the question, and I will bring back a concise, source-backed briefing."),
  Coder: withVoiceProfile("echo", 1.0, "Point me at the bug or the repo, and I will help you ship a cleaner fix."),
  Strategist: withVoiceProfile("onyx", 0.96, "I pressure-test decisions, surface tradeoffs, and turn ambiguity into a sharper plan."),
  Accountant: withVoiceProfile("shimmer", 0.94, "I will track the numbers carefully and flag anything that deserves a second look."),
  Editor: withVoiceProfile("fable", 1.0, "I tighten prose, preserve your voice, and make rough drafts read like finished work."),
  Chef: withVoiceProfile("nova", 1.03, "I can turn dinner chaos into a simple plan, a grocery list, and meals you will actually want."),
  "Travel Agent": withVoiceProfile("alloy", 1.0, "I line up the itinerary, the logistics, and the little details that make travel feel smooth."),
  Trainer: withVoiceProfile("onyx", 1.04, "I can keep your plan practical, consistent, and honest about what will move the needle."),
};

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 2 && !STOP_WORDS.has(token));
}

const KEYWORD_SCORE = 3;

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
      confidence: "none",
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
    const keywordScore = matchedKeywords.length * KEYWORD_SCORE;
    const score = keywordScore + overlapScore;
    return { role, score, matchedKeywords };
  }).sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));

  const best = scored[0];
  if (!best || best.score <= 0) {
    return {
      primaryRole: availableRoles[0] || null,
      alternatives: availableRoles.slice(1, 4),
      matchedKeywords: [],
      confidence: "none",
    };
  }

  return {
    primaryRole: best.role,
    alternatives: scored.slice(1, 4).map(item => item.role),
    matchedKeywords: best.matchedKeywords,
    confidence: best.score >= KEYWORD_SCORE ? "high" : "low",
  };
}

/**
 * Compose the starter task prompt, weaving in the user's own discovery input
 * so the first deliverable is specific to their situation instead of generic
 * (Workstream B — persona review §7, gap 3). The seed is user-authored text;
 * it is passed as context, not as instructions to reinterpret the task.
 */
export function composeStarterPrompt(
  basePrompt: string,
  seed?: string | null,
  recommendedConnections?: string[],
  recommendedPermissions?: string[],
): string {
  const cleanSeed = (seed || "").trim();
  let prompt = basePrompt;
  if (cleanSeed) {
    // Cap the seed so a pasted wall of text can't drown the task definition.
    const bounded = cleanSeed.length > 600 ? `${cleanSeed.slice(0, 600)}…` : cleanSeed;
    prompt += `\n\nContext: the user described their situation as: "${bounded}". Make the deliverable specifically useful for that situation, not generic.`;
  }
  // Conversational setup (four-beat consolidation): after proving value, the
  // agent itself should ask for the next unlock in plain language.
  const unlocks = [
    ...(recommendedConnections || []).filter(Boolean),
    ...(recommendedPermissions || []).filter(Boolean),
  ].slice(0, 2);
  if (unlocks.length > 0) {
    prompt += `\n\nAfter you deliver the work above, add ONE short closing paragraph in your own voice: point out the single most valuable thing you could take on next if the user turned on ${unlocks.join(" or ")}, and ask if they'd like you to walk them through enabling it. Keep it to two sentences, warm and concrete — no bullet lists.`;
  }
  return prompt;
}

/** Honest draft-card framing for each confidence level (Workstream C). */
export function getDiscoveryConfidenceCopy(
  confidence: DiscoveryConfidence,
  role: string | null,
): string {
  if (!role) return "Describe the work you want handled and Eddie will draft a fit.";
  switch (confidence) {
    case "high":
      return `Eddie would start with a ${role}.`;
    case "low":
      return `Eddie's closest match is a ${role} — tell him more and he'll sharpen the fit.`;
    case "none":
    default:
      return `Eddie wasn't sure of the perfect fit, so he'd start you with a ${role} you can tailor — or tell him more.`;
  }
}

export function getRoleDefaultName(role: string): string {
  return DEFAULT_ROLE_NAMES[role] || role;
}

// ─── Randomized persona names ────────────────────────────────────────────────
// A drafted agent should feel like a being with a name, not a config object —
// and not the same being every install. Role pools carry the persona flavor;
// the general pool covers Custom and roles without a pool. "Custom" is never
// a name.

const ROLE_NAME_POOLS: Record<string, string[]> = {
  Assistant: ["Sloane", "Piper", "Reese", "Emery", "Quinn", "Marlow"],
  Researcher: ["Atlas", "Darwin", "Meridian", "Sage", "Newton", "Iris"],
  Coder: ["Dev", "Turing", "Pixel", "Ada", "Lovelace", "Kernel"],
  Strategist: ["Marlowe", "Vega", "Archer", "Noor", "Kasparov", "Sun"],
  Accountant: ["Ledger", "Penny", "Tally", "Sterling", "Moss", "Cedar"],
  Editor: ["Quill", "Harper", "Wren", "Scout", "Indigo", "Blue"],
  Chef: ["Mise", "Basil", "Saffron", "Remy", "Julia", "Pepper"],
  "Travel Agent": ["Harbor", "Compass", "Marco", "Juno", "Wren", "Sol"],
  Trainer: ["Pace", "Blaze", "Stride", "Koa", "Rocky", "Dash"],
  Tutor: ["Sage", "Merlin", "Athena", "Ollie", "Beatrix", "Finch"],
  "Kids Coordinator": ["Poppins", "Maple", "Sunny", "Birdie", "Juno", "Clover"],
  "Marketing Guru": ["Echo", "Vale", "Sterling", "Nova", "Reya", "Banks"],
  Coach: ["North", "Ash", "True", "Kai", "Summit", "Roan"],
};

const GENERAL_NAME_POOL = [
  "Juniper", "Rowan", "Ellis", "Ada", "Miles", "Nova", "Fern", "Otis",
  "Hazel", "Felix", "Ivy", "Oscar", "Luna", "Reef", "Coral", "Pearl",
];

/**
 * Pick a random name suited to the role. `exclude` avoids re-rolling the same
 * name (used by the shuffle button). Never returns "Custom" or the role key.
 */
export function generateAgentName(role: string | null, exclude?: string): string {
  const pool = [
    ...((role && ROLE_NAME_POOLS[role]) || []),
    ...GENERAL_NAME_POOL,
  ].filter(name => name !== exclude && name !== "Custom" && name !== role);
  if (pool.length === 0) return "Pearl";
  // Role-pool names are listed first and get 3x weight so the persona flavor
  // usually wins while the general pool keeps things fresh.
  const rolePoolSize = (role && ROLE_NAME_POOLS[role])
    ? ROLE_NAME_POOLS[role].filter(n => n !== exclude).length
    : 0;
  const weighted: string[] = [
    ...pool.slice(0, rolePoolSize),
    ...pool.slice(0, rolePoolSize),
    ...pool,
  ];
  return weighted[Math.floor(Math.random() * weighted.length)];
}

export function getRoleVoiceDefault(role: string): VoiceDefault {
  return ROLE_VOICE_DEFAULTS[role] || {
    ...VOICE_PROFILE_LIBRARY.alloy,
    voice: "alloy",
    rate: 1,
    sample: "I am ready to help with the work you want off your plate.",
  };
}

export function getVoiceProfile(voiceId: string): VoiceProfile {
  return VOICE_PROFILE_LIBRARY[voiceId] || VOICE_PROFILE_LIBRARY.alloy;
}

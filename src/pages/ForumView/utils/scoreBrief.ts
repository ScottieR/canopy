/**
 * scoreBrief.ts
 * Client-side keyword scorer for the Forum volunteer screen.
 * Maps a user's brief text against agent roles/capabilities to produce
 * confidence percentages (0–100) and a one-line pitch for each agent.
 * Entirely offline — no LLM call required.
 *
 * Design principle: base confidence is LOW for all roles (20–38).
 * Confidence is EARNED through keyword overlap with the brief domain.
 * This prevents wrong-domain agents from volunteering just because their
 * role type has a high base — e.g. an Accountant should not offer 72%
 * confidence for an art gallery wall brief.
 */

import type { AgentData } from "../../../store/worldStore";

export interface AgentScore {
  agentId: string;
  name: string;
  role: string;
  robeColor: string;
  accentColor: string;
  image?: string | null;
  confidence: number;       // 0–100
  forumRole: string;        // short description of their role in this forum
  volunteers: boolean;      // true if confidence >= VOLUNTEER_THRESHOLD
  rationale?: string;       // one-liner from LLM explaining why they volunteered
}

const VOLUNTEER_THRESHOLD = 35;

// ─── Role keyword maps ────────────────────────────────────────────────────────
// base: LOW by default — keyword hits drive real confidence.
// boost: per-keyword confidence increase.
// roleMatch: substrings matched against agent.role (lowercase).
// keywords: brief substrings that raise this role's confidence.

type RoleRule = {
  roleMatch: string[];
  keywords: string[];
  forumRole: string;
  base: number;    // 20–38 — intentionally low
  boost: number;   // 7–12 — keyword hits are the main driver
};

const ROLE_RULES: RoleRule[] = [

  // ── Creative / Aesthetic ──────────────────────────────────────────────────

  {
    roleMatch: ["interior", "decorator", "designer", "design"],
    keywords: [
      "interior", "design", "decor", "aesthetic", "style", "arrange", "arrangement",
      "gallery", "wall", "room", "space", "furniture", "color", "palette", "layout",
      "hang", "display", "art", "frame", "photo", "picture", "home", "house",
      "apartment", "renovation", "makeover", "look", "feel", "vibe", "curate",
      "collection", "composition", "visual", "accent", "mood", "texture",
    ],
    forumRole: "Aesthetic & spatial design",
    base: 28,
    boost: 10,
  },
  {
    roleMatch: ["artist", "illustrator", "creative"],
    keywords: [
      "art", "artwork", "painting", "drawing", "illustration", "gallery", "canvas",
      "print", "photograph", "photography", "sculpture", "aesthetic", "style", "color",
      "palette", "curate", "curation", "collection", "arrange", "display", "visual",
      "composition", "piece", "medium", "technique", "creative", "design", "image",
      "picture", "frame", "wall", "decor", "exhibit", "show",
    ],
    forumRole: "Creative direction & curation",
    base: 28,
    boost: 10,
  },
  {
    roleMatch: ["fashion", "stylist", "style", "wardrobe"],
    keywords: [
      // clothing/fashion core
      "style", "outfit", "fashion", "wardrobe", "clothing", "wear", "coordinate",
      // aesthetic/visual curation — overlaps with art/home/interior briefs
      "aesthetic", "color", "palette", "tone", "look", "feel", "curate", "curation",
      "selection", "choose", "pick", "mix", "match", "vibe", "mood",
      "visual", "art", "gallery", "decor", "interior", "arrange", "display",
      "collection", "home", "room", "space",
    ],
    forumRole: "Aesthetic & style curation",
    base: 20,
    boost: 8,
  },
  {
    roleMatch: ["architect", "architecture", "building", "construction"],
    keywords: [
      "architect", "building", "construction", "structure", "space", "floor plan",
      "blueprint", "renovation", "remodel", "room", "layout", "home", "house",
      "wall", "ceiling", "addition", "square", "floor", "material", "structural",
    ],
    forumRole: "Architecture & spatial planning",
    base: 22,
    boost: 9,
  },
  {
    roleMatch: ["musician", "music", "composer", "producer"],
    keywords: [
      "music", "song", "melody", "rhythm", "compose", "produce", "instrument",
      "play", "record", "sound", "track", "album", "genre", "band", "chord",
      "lyrics", "beat", "studio", "mix",
    ],
    forumRole: "Musical direction",
    base: 20,
    boost: 12,
  },

  // ── Personal & Home Life ──────────────────────────────────────────────────

  {
    roleMatch: ["chef", "cook", "culinary", "food"],
    keywords: [
      "cook", "recipe", "meal", "dinner", "lunch", "breakfast", "ingredient",
      "flavor", "cuisine", "dish", "food", "kitchen", "eat", "restaurant", "bake",
      "grill", "prepare", "menu", "dietary", "taste",
    ],
    forumRole: "Food & culinary guidance",
    base: 20,
    boost: 12,
  },
  {
    roleMatch: ["travel", "trip", "tourism"],
    keywords: [
      "travel", "trip", "vacation", "hotel", "flight", "destination", "itinerary",
      "passport", "abroad", "tour", "visit", "country", "city", "resort", "cruise",
      "book", "stay", "accommodation", "airline", "journey",
    ],
    forumRole: "Travel planning",
    base: 20,
    boost: 12,
  },
  {
    roleMatch: ["relationship", "therapist", "therapy", "counselor", "wellness"],
    keywords: [
      "relationship", "emotion", "feel", "feeling", "mental", "therapy", "partner",
      "communication", "conflict", "anxiety", "stress", "wellbeing", "health",
      "mindset", "family", "friend", "love", "connection", "boundary", "support",
    ],
    forumRole: "Emotional & relationship support",
    base: 22,
    boost: 10,
  },
  {
    roleMatch: ["kids", "children", "family", "parent", "coordinator"],
    keywords: [
      "kids", "children", "child", "family", "parent", "school", "activity",
      "schedule", "homework", "play", "childcare", "babysit", "education",
      "learning", "after school", "pickup", "daycare", "youth",
    ],
    forumRole: "Family & kids coordination",
    base: 22,
    boost: 10,
  },

  // ── Knowledge & Coaching ──────────────────────────────────────────────────

  {
    roleMatch: ["tutor", "teacher", "educator", "instructor"],
    keywords: [
      "learn", "teach", "explain", "study", "education", "course", "lesson",
      "quiz", "test", "understand", "concept", "tutorial", "curriculum", "student",
      "knowledge", "school", "subject", "help understand",
    ],
    forumRole: "Teaching & explanation",
    base: 22,
    boost: 9,
  },
  {
    roleMatch: ["coach", "mentor", "trainer", "fitness", "habit"],
    keywords: [
      "coach", "coaching", "habit", "goal", "workout", "fitness", "exercise",
      "training", "nutrition", "health", "routine", "plan", "accountability",
      "motivation", "progress", "achieve", "improve", "performance",
    ],
    forumRole: "Coaching & guidance",
    base: 22,
    boost: 9,
  },
  {
    roleMatch: ["media", "advisor", "entertainment", "film"],
    keywords: [
      "media", "movie", "film", "show", "tv", "series", "music", "podcast",
      "book", "recommend", "watch", "listen", "streaming", "entertainment",
      "review", "content", "platform",
    ],
    forumRole: "Media & entertainment guidance",
    base: 20,
    boost: 10,
  },

  // ── Professional / Business ───────────────────────────────────────────────

  {
    roleMatch: ["research", "researcher", "analyst", "data"],
    keywords: [
      "research", "find", "investigate", "gather", "analyze", "analyse", "scan",
      "compare", "survey", "study", "review", "information", "sources", "evidence",
      "data", "look up", "explore", "discover", "fact", "insight", "understand",
    ],
    forumRole: "Research & discovery",
    base: 35,   // broadly useful — slightly elevated base
    boost: 7,
  },
  {
    roleMatch: ["strategist", "strategy", "consultant", "business strategist"],
    keywords: [
      "strategy", "strategic", "business", "competitive", "market", "plan",
      "roadmap", "decision", "revenue", "growth", "pitch", "proposal", "framework",
      "position", "opportunity", "executive", "launch", "startup", "investor",
      "enterprise", "model", "differentiat",
    ],
    forumRole: "Strategic framing",
    base: 22,
    boost: 8,
  },
  {
    roleMatch: ["marketing", "brand", "advertis", "social media", "marketing guru"],
    keywords: [
      "marketing", "brand", "advertise", "campaign", "social", "media", "audience",
      "content", "post", "engagement", "reach", "promotion", "launch", "message",
      "channel", "email", "growth", "awareness", "customer", "funnel",
    ],
    forumRole: "Marketing & brand strategy",
    base: 22,
    boost: 8,
  },
  {
    roleMatch: ["engineer", "developer", "coder", "programmer", "software"],
    keywords: [
      "code", "coding", "build", "implement", "develop", "engineer", "software",
      "api", "integration", "script", "automate", "bug", "fix", "debug", "deploy",
      "architecture", "system", "technical", "database", "server", "app", "website",
      "program", "backend", "frontend", "cloud",
    ],
    forumRole: "Engineering & implementation",
    base: 22,
    boost: 8,
  },
  {
    roleMatch: ["accountant", "financial", "finance", "budget", "cfo"],
    keywords: [
      "budget", "spend", "cost", "finance", "financial", "revenue", "profit",
      "forecast", "expense", "accounting", "tax", "invoice", "payment", "money",
      "pricing", "roi", "cash flow", "p&l",
    ],
    forumRole: "Financial analysis",
    base: 22,
    boost: 9,
  },
  {
    roleMatch: ["investment", "invest", "portfolio", "wealth"],
    keywords: [
      "invest", "investment", "portfolio", "stock", "bond", "fund", "return",
      "asset", "wealth", "retirement", "ira", "401k", "market", "dividend",
      "yield", "risk", "allocation",
    ],
    forumRole: "Investment & wealth management",
    base: 20,
    boost: 10,
  },
  {
    roleMatch: ["property", "str", "airbnb", "rental", "real estate"],
    keywords: [
      "property", "rental", "airbnb", "str", "tenant", "listing", "booking",
      "maintenance", "guest", "host", "real estate", "lease", "landlord", "rent",
      "estate", "occupancy", "turnover",
    ],
    forumRole: "Property operations",
    base: 20,
    boost: 12,
  },
  {
    roleMatch: ["negotiator", "deal", "sales", "partnership"],
    keywords: [
      "negotiate", "negotiation", "deal", "contract", "vendor", "partner",
      "agreement", "terms", "pricing", "proposal", "close", "offer", "concession",
      "procurement", "supplier",
    ],
    forumRole: "Negotiation & deal prep",
    base: 20,
    boost: 10,
  },
  {
    roleMatch: ["assistant", "ea", "executive", "coordinator", "scheduler"],
    keywords: [
      "schedule", "calendar", "organize", "meeting", "coordinate", "email",
      "follow up", "remind", "task", "manage", "logistics", "prepare", "agenda",
      "plan", "help",
    ],
    forumRole: "Coordination & scheduling",
    base: 25,
    boost: 6,
  },
];

// Generic fallback for unrecognized roles
const GENERIC_RULE: RoleRule = {
  roleMatch: [],
  keywords: [],
  forumRole: "General support",
  base: 20,
  boost: 3,
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function countKeywordHits(brief: string, keywords: string[]): number {
  const nb = normalize(brief);
  return keywords.filter(k => nb.includes(k)).length;
}

export function scoreBrief(brief: string, agents: AgentData[]): AgentScore[] {
  const scores: AgentScore[] = agents.map(agent => {
    const roleLower = normalize(agent.role || "");

    // Find the best matching rule for this agent's role
    let bestRule = GENERIC_RULE;
    for (const rule of ROLE_RULES) {
      if (rule.roleMatch.some(rm => roleLower.includes(rm))) {
        bestRule = rule;
        break;
      }
    }

    const hits = countKeywordHits(brief, bestRule.keywords);
    const rawConfidence = Math.min(100, bestRule.base + hits * bestRule.boost);

    // Slight organic jitter (±3)
    const jitter = Math.round((Math.random() - 0.5) * 6);
    const confidence = Math.max(0, Math.min(100, rawConfidence + jitter));

    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      robeColor: agent.robeColor,
      accentColor: agent.accentColor,
      image: agent.image,
      confidence,
      forumRole: bestRule.forumRole,
      volunteers: confidence >= VOLUNTEER_THRESHOLD,
    };
  });

  // Sort: volunteers first (by confidence desc), then non-volunteers
  return scores.sort((a, b) => {
    if (a.volunteers && !b.volunteers) return -1;
    if (!a.volunteers && b.volunteers) return 1;
    return b.confidence - a.confidence;
  });
}

/**
 * Keyword-based tag fallback. Uses word-boundary regex to avoid false positives
 * like "art" matching inside "strategy" or "part".
 * This is a fallback only — the LLM coordinator generates better tags when available.
 */
export function extractTags(brief: string): string[] {
  const tagKeywords: [string, string][] = [
    // Creative / home — use word-boundary safe patterns
    ["\\bart\\b", "Art"], ["gallery", "Gallery"], ["interior", "Interior Design"],
    ["decor", "Decor"], ["aesthetic", "Aesthetic"],
    // Travel
    ["travel", "Travel"], ["\\btrip\\b", "Trip Planning"], ["vacation", "Vacation"],
    // Food
    ["recipe", "Cooking"], ["\\bcook", "Cooking"], ["\\bfood\\b", "Food"],
    // Professional
    ["research", "Research"], ["strategy", "Strategy"], ["competitive", "Competitive Analysis"],
    ["\\bwrite\\b|\\bwriting\\b|\\bdraft\\b", "Writing"], ["\\bmemo\\b", "Memo"],
    ["\\breport\\b", "Report"], ["\\bcode\\b|\\bcoding\\b|\\bengineer", "Engineering"],
    ["\\bbudget\\b|\\bfinancial\\b|\\bfinance\\b", "Finance"],
    ["\\bpric", "Pricing"], ["\\bmarket\\b", "Market Research"],
    ["\\bstartup\\b", "Startup"], ["enterprise", "Enterprise"],
    ["\\bpresentation\\b|\\bdeck\\b", "Presentation"], ["\\bplanning\\b|\\bplan\\b", "Planning"],
    ["\\banalysis\\b|\\banalyze\\b", "Analysis"],
    // Wellness
    ["fitness", "Fitness"], ["\\bhealth\\b", "Health"], ["coach", "Coaching"],
  ];
  const nb = normalize(brief);
  const found = new Set<string>();
  for (const [pattern, tag] of tagKeywords) {
    if (new RegExp(pattern).test(nb)) found.add(tag);
    if (found.size >= 4) break;
  }
  return Array.from(found);
}

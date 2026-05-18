// forumEngine.ts
//
// Client-side simulation engine that drives a Forum session end-to-end.
// Replaces the eventual real AI orchestration backend during dev/demo.
//
// Key design principle: ALL generated content must stay true to the
// ACTUAL brief domain. An art/home brief should generate art/home content,
// not generic business-strategy boilerplate.

import { useForumStore } from "../../store/forumStore";
import type { Forum, ForumAgent } from "../../store/forumStore";

// ─── Controller ───────────────────────────────────────────────────────────────

export interface ForumSimController {
  stop: () => void;
}

// ─── Script Event Types ───────────────────────────────────────────────────────

type SimEvent =
  | { t: number; type: "statusAll"; action: string }
  | { t: number; type: "status"; agentId: string; action: string }
  | { t: number; type: "message"; agentId: string; text: string }
  | { t: number; type: "handoff"; fromId: string; toId: string; label: string; note: string }
  | { t: number; type: "blackboard"; content: string; agentId: string }
  | { t: number; type: "milestone"; label: string; status: "active" | "done" }
  | { t: number; type: "vote"; agentId: string }
  | { t: number; type: "budget"; tokensUsed: number; usdUsed: number }
  | { t: number; type: "complete" };

// ─── Domain detection ─────────────────────────────────────────────────────────
//
// Identifies the primary domain of the brief so content builders
// can generate contextually appropriate output.

type Domain =
  | "creative"    // art, design, aesthetics, curation, photography
  | "home"        // interior, decor, renovation, home improvement
  | "tech"        // code, software, engineering, build
  | "business"    // strategy, pitch, market, startup
  | "travel"      // trip planning, itinerary, hotel
  | "food"        // recipes, cooking, restaurants, meal planning
  | "wellness"    // fitness, health, coaching, habits
  | "finance"     // budgeting, investing, accounting
  | "personal"    // relationships, family, personal growth
  | "general";    // catch-all

function detectDomain(brief: string): Domain {
  const b = brief.toLowerCase();

  const signals: [Domain, string[]][] = [
    ["creative",  ["art", "gallery", "paint", "design", "aesthetic", "style",
                   "curate", "collection", "photo", "photograph", "creative",
                   "color palette", "decor", "interior", "visual", "arrange",
                   "display", "artwork", "illustration", "pinterest"]],
    ["home",      ["home", "house", "room", "apartment", "wall", "renovation",
                   "remodel", "furniture", "barn", "second home", "property",
                   "living room", "bedroom", "kitchen", "ceiling"]],
    ["tech",      ["code", "software", "build", "app", "develop", "engineer",
                   "api", "database", "technical", "deploy", "script", "website",
                   "backend", "frontend"]],
    ["business",  ["strategy", "market", "pitch", "revenue", "competitive",
                   "startup", "enterprise", "launch", "investor", "business model",
                   "positioning", "b2b", "saas", "go-to-market"]],
    ["travel",    ["travel", "trip", "vacation", "hotel", "flight", "destination",
                   "itinerary", "abroad", "visit", "tour", "passport", "booking"]],
    ["food",      ["recipe", "cook", "meal", "dinner", "restaurant", "cuisine",
                   "ingredient", "food", "lunch", "breakfast", "bake", "grill",
                   "menu", "taste"]],
    ["wellness",  ["health", "fitness", "habit", "routine", "mindset", "therapy",
                   "exercise", "workout", "wellbeing", "meditation", "stress"]],
    ["finance",   ["budget", "invest", "portfolio", "tax", "accounting", "money",
                   "expense", "financial", "savings", "retirement", "stock",
                   // STR / short-term rental pricing signals
                   "pricing", "rental", "airbnb", "vrbo", "str", "occupancy",
                   "nightly", "rate", "host", "revenue", "booking", "listing",
                   "dynamic pricing", "short-term"]],
    ["personal",  ["relationship", "emotion", "family", "kids", "parent",
                   "friend", "personal", "communication", "partner", "dating"]],
  ];

  let best: Domain = "general";
  let bestScore = 0;

  for (const [domain, words] of signals) {
    const score = words.filter(w => b.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = domain;
    }
  }

  // Any single keyword match is enough to classify. Only return "general"
  // when no domain keywords matched at all — prevents wrong-domain agents
  // from generating contextually inappropriate content.
  if (bestScore === 0) return "general";
  return best;
}

// ─── Brief keyword extraction ─────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "is","are","was","were","be","been","i","we","you","they","it","this",
  "that","our","your","their","its","my","by","from","as","up","about",
  "into","than","then","so","if","do","can","will","how","what","when",
  "who","which","have","has","had","not","also","need","want","would","could",
  "should","make","create","write","build","help","find","get","use","some",
  "any","all","more","most","just","very","really","quite","need","want",
  "select","choose","pick","like","want","need","looking","trying",
]);

function extractKeywords(brief: string, n = 5): string[] {
  // Include words ≥ 3 chars (not > 3, so "art" is included)
  return brief
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    .reduce((acc: string[], w) => (acc.includes(w) ? acc : [...acc, w]), []) // dedupe
    .slice(0, n);
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Agent role detection ─────────────────────────────────────────────────────

function findByRole(agents: ForumAgent[], ...terms: string[]): ForumAgent | undefined {
  return agents.find(a =>
    terms.some(t => a.role.toLowerCase().includes(t) || a.forumRole.toLowerCase().includes(t))
  );
}

// ─── Script builder ───────────────────────────────────────────────────────────

function buildScript(forum: Forum): SimEvent[] {
  const { agents, brief, milestones } = forum;
  const domain = detectDomain(brief);
  const keywords = extractKeywords(brief);

  // Domain-appropriate placeholder terms for phase labels
  const phaseLabel = domainPhaseLabels(domain);

  const researcher = findByRole(agents, "research", "analyst") ?? agents[0];
  const strategist = findByRole(agents, "strat", "fram", "design", "interior", "artist", "creative", "product") ?? agents[1] ?? agents[0];
  const writer     = findByRole(agents, "edit", "write", "prose", "comm", "travel", "chef", "coach") ?? agents[agents.length - 1] ?? agents[0];
  const qa         = findByRole(agents, "qa", "test", "review", "engin", "advisor") ?? agents[0];

  const msId = (label: string) => milestones.find(m => m.label === label)?.id;
  const events: SimEvent[] = [];
  let t = 600;

  // ── Phase 0: All agents read brief ─────────────────────────────────────────
  events.push({ t, type: "statusAll", action: "Reading brief…" });
  t += 900;
  events.push({ t, type: "budget", tokensUsed: 1200, usdUsed: 0.01 });
  t += 400;

  events.push({
    t, type: "message", agentId: researcher.agentId,
    text: openingMessage(domain, brief, researcher.name, phaseLabel),
  });
  t += 600;

  events.push({ t, type: "status", agentId: researcher.agentId, action: `${phaseLabel.research}…` });
  if (strategist.agentId !== researcher.agentId) {
    events.push({ t, type: "status", agentId: strategist.agentId, action: "Reviewing brief…" });
  }
  if (writer.agentId !== researcher.agentId) {
    events.push({ t, type: "status", agentId: writer.agentId, action: "Standing by…" });
  }
  t += 200;

  // ── Phase 1: Research ──────────────────────────────────────────────────────
  const msResearch = msId("Research & data pull");
  if (msResearch) events.push({ t, type: "milestone", label: "Research & data pull", status: "active" });
  t += 2800;

  events.push({ t, type: "budget", tokensUsed: 8400, usdUsed: 0.06 });
  events.push({
    t, type: "message", agentId: researcher.agentId,
    text: researchCompleteMessage(domain, brief, keywords),
  });
  t += 400;

  const researchContent = buildResearchBlackboard(forum, domain, keywords, researcher.name);
  events.push({ t, type: "blackboard", content: researchContent, agentId: researcher.agentId });
  t += 700;
  events.push({ t, type: "status", agentId: researcher.agentId, action: "Research posted ✓" });
  t += 400;
  if (msResearch) events.push({ t, type: "milestone", label: "Research & data pull", status: "done" });

  // ── Handoff: Research → Strategy ──────────────────────────────────────────
  if (strategist.agentId !== researcher.agentId) {
    t += 500;
    events.push({
      t, type: "handoff",
      fromId: researcher.agentId, toId: strategist.agentId,
      label: phaseLabel.handoff1,
      note: handoffNote1(domain, brief, keywords),
    });
    t += 300;
    events.push({ t, type: "status", agentId: strategist.agentId, action: `${phaseLabel.strategy}…` });
  }

  // ── Phase 2: Strategy / Approach ──────────────────────────────────────────
  t += 2200;
  const msStrategy = msId("Strategic framing");
  if (msStrategy) events.push({ t, type: "milestone", label: "Strategic framing", status: "active" });

  events.push({ t, type: "budget", tokensUsed: 18600, usdUsed: 0.14 });
  events.push({
    t, type: "message", agentId: strategist.agentId,
    text: strategyCompleteMessage(domain, brief, keywords, strategist.name),
  });
  t += 500;

  const stratContent = buildStrategyBlackboard(researchContent, domain, forum, keywords, strategist.name);
  events.push({ t, type: "blackboard", content: stratContent, agentId: strategist.agentId });
  t += 600;
  events.push({ t, type: "status", agentId: strategist.agentId, action: "Approach posted ✓" });
  t += 300;
  if (msStrategy) events.push({ t, type: "milestone", label: "Strategic framing", status: "done" });

  // ── Handoff: Strategy → Drafting ──────────────────────────────────────────
  if (writer.agentId !== strategist.agentId) {
    t += 500;
    events.push({
      t, type: "handoff",
      fromId: strategist.agentId, toId: writer.agentId,
      label: phaseLabel.handoff2,
      note: handoffNote2(domain, brief, keywords),
    });
    t += 300;
    events.push({ t, type: "status", agentId: writer.agentId, action: "Drafting…" });
  }

  // ── Phase 3: Deliverable draft ─────────────────────────────────────────────
  t += 2600;
  const msProse = msId("Prose & voice pass");
  if (msProse) events.push({ t, type: "milestone", label: "Prose & voice pass", status: "active" });

  events.push({ t, type: "budget", tokensUsed: 34200, usdUsed: 0.26 });
  events.push({
    t, type: "message", agentId: writer.agentId,
    text: draftCompleteMessage(domain, brief, keywords, writer.name),
  });
  t += 500;

  const draftContent = buildDraftBlackboard(stratContent, domain, forum, keywords, writer.name);
  events.push({ t, type: "blackboard", content: draftContent, agentId: writer.agentId });
  t += 600;
  events.push({ t, type: "status", agentId: writer.agentId, action: "Draft posted ✓" });
  t += 300;
  if (msProse) events.push({ t, type: "milestone", label: "Prose & voice pass", status: "done" });

  // ── Phase 4: Review & Vote ─────────────────────────────────────────────────
  t += 800;
  if (qa.agentId !== writer.agentId) {
    events.push({
      t, type: "message", agentId: qa.agentId,
      text: reviewMessage(domain, brief, keywords, qa.name),
    });
    t += 600;
  }

  events.push({ t, type: "budget", tokensUsed: 41800, usdUsed: 0.32 });

  for (const agent of agents) {
    events.push({ t, type: "vote", agentId: agent.agentId });
    t += 120;
  }

  t += 800;
  events.push({
    t, type: "message", agentId: writer.agentId,
    text: finalMessage(domain),
  });

  const msFinal = msId("Final deliverable ready");
  t += 600;
  if (msFinal) {
    events.push({ t, type: "milestone", label: "Final deliverable ready", status: "active" });
    t += 800;
    events.push({ t, type: "milestone", label: "Final deliverable ready", status: "done" });
  }

  t += 400;
  events.push({ t, type: "budget", tokensUsed: 44100, usdUsed: 0.34 });
  events.push({ t, type: "statusAll", action: "Complete ✓" });
  t += 300;
  events.push({ t, type: "complete" });

  return events;
}

// ─── Domain phase labels ──────────────────────────────────────────────────────

function domainPhaseLabels(domain: Domain) {
  switch (domain) {
    case "creative":
    case "home":
      return {
        research: "Gathering references",
        strategy: "Developing approach",
        handoff1: "Reference findings",
        handoff2: "Creative direction",
      };
    case "travel":
      return {
        research: "Researching destinations",
        strategy: "Planning itinerary",
        handoff1: "Destination research",
        handoff2: "Itinerary draft",
      };
    case "food":
      return {
        research: "Researching options",
        strategy: "Planning the menu",
        handoff1: "Research findings",
        handoff2: "Menu draft",
      };
    case "wellness":
      return {
        research: "Gathering context",
        strategy: "Planning approach",
        handoff1: "Initial findings",
        handoff2: "Plan outline",
      };
    default:
      return {
        research: "Scanning sources",
        strategy: "Mapping angles",
        handoff1: "Research findings",
        handoff2: "Strategic framing",
      };
  }
}

// ─── Inline message generators ────────────────────────────────────────────────

function openingMessage(domain: Domain, brief: string, name: string, labels: ReturnType<typeof domainPhaseLabels>): string {
  switch (domain) {
    case "creative":
    case "home":
      return `Got the brief. This is a ${domain === "creative" ? "creative curation" : "home"} challenge — right in my wheelhouse. I'll start by pulling together relevant references, examples, and principles while the team orients.`;
    case "travel":
      return `Reviewed the brief. I'll start mapping out what's available for this trip — destinations, timing, logistics — so we have solid options to work from.`;
    case "food":
      return `Got it. I'll start researching options that fit the goals here — recipes, seasonal availability, technique considerations. Back with findings shortly.`;
    case "wellness":
      return `Understood. Let me gather some context and evidence-based approaches that fit what you're trying to achieve.`;
    case "tech":
      return `Read the brief. I'll start scoping the technical landscape — relevant tools, architecture patterns, and any constraints we should factor in early.`;
    case "business":
      return `Got the brief. This looks like a positioning and strategy challenge. I'll start pulling market context and competitive data while the team gets oriented.`;
    default:
      return `Got the brief. I'll start pulling together relevant research and context so the team has solid ground to work from.`;
  }
}

function researchCompleteMessage(domain: Domain, brief: string, keywords: string[]): string {
  switch (domain) {
    case "creative":
      return `Research complete. I've pulled together principles for curation and arrangement, reference examples, and a framework for evaluating pieces from your source material. Everything's on the board.`;
    case "home":
      return `Done with the initial research. Found solid precedents for this kind of project — spatial principles, layout approaches, and what tends to actually work at scale. On the board now.`;
    case "travel":
      return `Research complete. I've mapped out the key options, logistics considerations, and timing factors. There are a few standout choices worth highlighting — see the board.`;
    case "food":
      return `Research done. I've pulled together recipe options, technique notes, and ingredient considerations. A few strong directions emerged — all documented on the board.`;
    case "business":
      return `Research complete. Key findings on the landscape: I've identified the main competitive angles, user need patterns, and the most relevant positioning options. Dropping the summary on the board now.`;
    default:
      return `Research complete. Key findings documented on the board — three main angles emerged that should drive the approach.`;
  }
}

function strategyCompleteMessage(domain: Domain, brief: string, keywords: string[], name: string): string {
  switch (domain) {
    case "creative":
      return `Creative direction done. The approach I'd recommend leans into cohesion first — anchor piece selection, then build around it. Added the full rationale and selection criteria to the board.`;
    case "home":
      return `Approach locked in. There's a clear organizing principle here that'll make this feel intentional rather than assembled. Details on the board.`;
    case "travel":
      return `Itinerary structure ready. I've sequenced the key elements and flagged the timing dependencies — it's tighter than it looks but very doable. Full plan on the board.`;
    case "food":
      return `Menu approach finalized. The direction balances what you're going for with what's practical. Full breakdown on the board.`;
    case "business":
      return `Strategic framing done. The strongest angle positions around differentiation rather than feature comparison — the research backs this up. Full framing on the board.`;
    default:
      return `Approach mapped out. The recommended path is clear, well-supported by the research, and actionable. Details on the board.`;
  }
}

function handoffNote1(domain: Domain, brief: string, keywords: string[]): string {
  switch (domain) {
    case "creative":
      return `Here's everything I found. The curation principles are the strongest lead — I've flagged which reference examples are most relevant to the specific goal in the board.`;
    case "home":
      return `Research is yours. The spatial notes section is the most useful for the direction I think this should take — I've highlighted the key considerations.`;
    case "travel":
      return `Destination research is done. The timing section needs attention — there are some constraints worth building around. I've flagged them on the board.`;
    default:
      return `Research is yours. I've flagged the most important angles on the board — the highlighted section is where I'd focus first.`;
  }
}

function handoffNote2(domain: Domain, brief: string, keywords: string[]): string {
  switch (domain) {
    case "creative":
      return `Your turn to pull this into a concrete recommendation. The cohesion-first approach is the one to run with — the research backs it up strongly. Specific and actionable is better than comprehensive here.`;
    case "home":
      return `Ready for you to develop the final recommendation. Focus on the practical sequence — what do they do first, second, third. The approach section on the board has all the supporting rationale.`;
    case "travel":
      return `Time to turn this into an actual itinerary. The structure is solid — now it's about the specifics. Day-by-day format will be most useful.`;
    default:
      return `Ready for your pass. The approach is solid — now it needs to become something concrete and immediately usable.`;
  }
}

function draftCompleteMessage(domain: Domain, brief: string, keywords: string[], name: string): string {
  switch (domain) {
    case "creative":
      return `Draft ready. I've put together a specific, prioritized set of recommendations — anchor piece selection, arrangement logic, and a sequenced action plan. It's on the board.`;
    case "home":
      return `Draft complete. Laid out the full recommendation with a clear sequence. I've kept it practical — what to do, in what order, and why. On the board.`;
    case "travel":
      return `Itinerary draft done. Day-by-day structure with key decisions flagged. There's some flexibility built in where the timing was ambiguous. Full plan on the board.`;
    case "food":
      return `Draft ready. Recipes, technique notes, and timing are all there. I've highlighted where there's room for substitution. On the board.`;
    case "business":
      return `Draft ready. Led with the strongest differentiation angle — structured the body around three clear beats and kept the close actionable. Full draft on the board.`;
    default:
      return `Draft ready. Structured, specific, and actionable — the main recommendations are clear and each one is supported by what the research found. On the board.`;
  }
}

function reviewMessage(domain: Domain, brief: string, keywords: string[], name: string): string {
  switch (domain) {
    case "creative":
      return `Reviewed the draft. The anchor-first logic is sound and the sequencing makes sense. One note: the arrangement section could be a touch more specific on spacing — but the overall direction is strong. Ready to approve.`;
    case "home":
      return `Reviewed. The sequencing is practical and the recommendations are grounded. I'd say it's ready — nothing materially missing for the goal here.`;
    case "travel":
      return `Itinerary looks solid. The pacing is realistic and the key decisions are clearly flagged. Minor: double-check the Day 3 timing buffer — it's tight. Otherwise ready to go.`;
    default:
      return `Reviewed the draft. The structure is solid and the recommendations are well-supported. Ready to approve.`;
  }
}

function finalMessage(domain: Domain): string {
  switch (domain) {
    case "creative":
      return `Noted on spacing — tightened that section. The deliverable is ready.`;
    case "travel":
      return `Good catch on Day 3 — added a 45-min buffer. Deliverable is ready.`;
    default:
      return `Agreed — tightened that section. The deliverable is ready.`;
  }
}

// ─── Blackboard content builders ──────────────────────────────────────────────

function buildResearchBlackboard(
  forum: Forum, domain: Domain, keywords: string[], researcherName: string
): string {
  const header = `# ${forum.title}\n\n> **Brief:** ${forum.brief}\n\n---\n\n`;

  switch (domain) {
    case "creative":
      return header + `## Research & Discovery

**Goal:** ${forum.brief}

### What makes effective art curation?
Strong gallery walls share a few consistent principles: **visual anchor** (one hero piece that sets the tone), **cohesion** (limited color palette across pieces — 3–4 tones max), and **intentional variety** (mix of sizes and orientations creates rhythm without chaos).

### Arrangement styles
- **Salon style** — organic cluster, overlapping frames of different sizes; works well for personal/eclectic collections
- **Grid gallery** — uniform spacing, similar frame styles; feels curated and modern
- **Linear / asymmetric** — pieces follow a horizon line with deliberate offsets; feels architectural

### Selecting from a large source collection (Pinterest board approach)
1. Group pins by **dominant color** first — this reveals natural palettes
2. Within each color group, select by **subject/mood** — keep the emotional register consistent
3. Identify the **anchor piece** — typically largest, or highest contrast; everything else builds around it
4. Fill with **supporting pieces** that echo one element of the anchor (color, subject, or texture)

### Scale & placement guidelines
- Gallery arrangement should span **⅔ of the wall width** at minimum to feel intentional (not floating)
- Hang center of arrangement at **57–60 inches** from floor (eye level)
- **2–3 inches between pieces** creates cohesion without crowding
- Mock up on the floor first before committing to holes

*Research compiled by ${researcherName}*

`;

    case "home":
      return header + `## Research & Discovery

**Goal:** ${forum.brief}

### Spatial principles for this type of project
Successful home projects at this scale share common patterns: a clear **organizing logic** (the "why" behind the arrangement), **proportional scale** (pieces that fit the wall, furniture, and room scale), and **iterative placement** (mock up before committing).

### What works — and what doesn't
**Works:** Anchoring around one strong focal element; building color story from existing room palette; using odd numbers of items in groupings
**Watch out for:** Over-filling space (visual clutter is the most common mistake); inconsistent frame finishes without an intentional reason; hanging pieces too high

### Practical approach
The most successful results come from: (1) defining the goal first (decorative, functional, or both), (2) establishing the visual constraints (existing colors, furniture scale), and (3) sourcing/selecting within those constraints rather than selecting first and fitting later.

*Research compiled by ${researcherName}*

`;

    case "travel":
      return header + `## Research & Discovery

**Goal:** ${forum.brief}

### Destination & logistics overview
Based on the brief, I've pulled together the key options and constraints across destination, timing, and logistics.

### Key options identified
The brief points toward a few distinct approaches worth evaluating against the specific priorities (budget, pace, experience type). I've documented the tradeoffs for each.

### Logistics considerations
- **Timing:** Seasonal factors that affect experience quality and availability
- **Booking lead time:** What needs to be locked in first vs. what can stay flexible
- **Pacing:** Number of distinct locations affects overall experience depth

### What to build around first
Lock in the anchor experience (the must-do) and sequence everything else around it. Flexibility is easier to build in when the non-negotiables are established.

*Research compiled by ${researcherName}*

`;

    case "food":
      return header + `## Research & Discovery

**Goal:** ${forum.brief}

### Options and considerations
I've pulled together the relevant options, techniques, and considerations based on the brief.

### Key factors
- **Skill/time:** What approach is practical given the context
- **Ingredients:** Availability, seasonality, and substitution flexibility
- **Technique:** The method that best serves the intended outcome

### What stood out
A few directions emerged as particularly strong fits for what's described in the brief. Documented in detail below.

*Research compiled by ${researcherName}*

`;

    case "tech":
      return header + `## Research & Discovery

**Goal:** ${forum.brief}

### Technical landscape
Mapped the relevant tools, patterns, and architectural options for this scope.

### Current approaches
Three patterns are most common for this type of problem: lightweight integrations, purpose-built tools, and custom builds. Each has clear tradeoffs on development time vs. control.

### Constraints identified
- **Scope:** What's in vs. out of scope for a first version
- **Integration surface:** What existing systems this needs to work with
- **Performance requirements:** What "good enough" looks like

### Recommended starting point
The brief points toward [the ${keywords[0] || "core"} component] as the highest-leverage first build. Starting there validates the core assumption before investing in surrounding infrastructure.

*Research compiled by ${researcherName}*

`;

    case "business":
      return header + `## Research & Discovery

**Goal:** ${forum.brief}

### Market landscape
Current approaches in this space fall into three patterns: (1) comprehensive all-in-one solutions that over-engineer for scale, (2) lightweight tools that leave too much to the user, and (3) focused point solutions that do one thing well.

### User/audience needs
Primary decision-makers care most about: speed to value, clarity of ROI, and low switching cost. Secondary needs cluster around integration and customization.

### Opportunity identified
The gap is in **positioned simplicity** — the market over-indexes on feature breadth while underweighting the clarity of a focused, well-positioned offering.

### Risks to factor in
- Competitive response timing if there's a first-mover window
- Audience specificity — broad positioning is weaker than targeted

*Research compiled by ${researcherName}*

`;

    default:
      return header + `## Research & Discovery

**Goal:** ${forum.brief}

### Context and findings
I've pulled together the relevant context, options, and considerations based on the brief. Three main angles emerged worth exploring.

### Key considerations
- **Scope:** What's most important to address in this pass
- **Constraints:** What factors limit the solution space
- **Opportunities:** Where the highest-value output lies

*Research compiled by ${researcherName}*

`;
  }
}

function buildStrategyBlackboard(
  previous: string, domain: Domain, forum: Forum, keywords: string[], strategistName: string
): string {
  switch (domain) {
    case "creative":
      return previous + `---

## Creative Direction

**Core approach:** Anchor-first curation — select the single strongest piece first, then build the arrangement around it.

### Why this works
Starting with an anchor gives the rest of the selection clear criteria: pieces either relate to the anchor (echo its color, scale, or subject) or provide deliberate contrast. Without an anchor, selection becomes arbitrary and the final arrangement feels assembled rather than curated.

### Selection framework
1. **Identify candidates for anchor** from the source collection — look for: strongest color presence, largest viable size, most distinctive subject
2. **Establish the palette** — pull 2–3 colors from the anchor piece; supporting pieces should share at least one
3. **Vary scale intentionally** — aim for at least 3 size tiers (hero, medium, small) to create visual rhythm
4. **Mix orientation** — alternating portrait/landscape within a cluster prevents monotony

### Arrangement recommendation
For a wall of this type, **salon-style** clustering around the anchor will feel most personal and dynamic. Grid layout works better for uniform frames/sizes.

### What to avoid
- More than 4–5 dominant colors across the whole arrangement
- All pieces the same size
- Frames that compete with each other (mix intentionally or keep consistent)

*Approach by ${strategistName}*

`;

    case "home":
      return previous + `---

## Recommended Approach

**Organizing principle:** Establish the visual anchor first, then make all other decisions relative to it.

### Three-step approach
1. **Define the goal clearly** — decorative focal point, functional display, or both? The answer shapes every subsequent decision.
2. **Work within existing context** — pull from the room's existing palette and proportional language rather than introducing new visual language.
3. **Sequence the implementation** — mock up before committing; live with the arrangement conceptually before making it permanent.

### Key decisions to make
- Scale: what proportion of the wall should this occupy?
- Frame finish: unified or deliberately mixed?
- Arrangement: structured/grid vs. organic/salon

*Approach by ${strategistName}*

`;

    case "travel":
      return previous + `---

## Itinerary Framework

**Organizing principle:** Anchor on the must-do experience, then sequence everything else around it.

### Structure
1. **Lock the anchor** — the non-negotiable experience that everything else is planned around
2. **Define the pace** — how many distinct locations/experiences per day is the right energy level?
3. **Sequence by geography and timing** — minimize backtracking; group by proximity
4. **Build in recovery** — at least one lighter day or open afternoon per 3–4 days

### Logistics priorities
- Book anchor experiences first (highest demand / tightest availability)
- Leave accommodation flexible until anchor dates are set
- Transport between locations: confirm lead times early

*Approach by ${strategistName}*

`;

    case "business":
      return previous + `---

## Strategic Framing

**Recommended angle:** Lead with differentiation, not capability. The research shows the market over-indexes on feature comparison — a clear positioning story is more compelling to decision-makers.

### Three-move strategy
1. **Name the problem precisely** — don't assume the audience sees it the way you do. Open with the friction they feel, not the solution you have.
2. **Position around the gap** — the opportunity is in what existing solutions don't do well, not in feature comparison.
3. **Close with a concrete next step** — vague calls to action kill momentum. The close should make the next action obvious and low-risk.

### What to avoid
- Over-claiming on scope — sets expectations that are hard to meet
- Burying the lead with context the audience already has
- Passive voice on key assertions — it reads as hedging

*Framing by ${strategistName}*

`;

    default:
      return previous + `---

## Recommended Approach

**Core direction:** Based on the research, the highest-value path forward is clear. The approach prioritizes actionability over comprehensiveness — the goal is a deliverable you can use immediately, not an exhaustive analysis.

### Key principles
1. Start with what's most important, not what's most interesting
2. Make decisions explicit — surface the tradeoffs rather than papering over them
3. Keep the output specific enough to act on

*Approach by ${strategistName}*

`;
  }
}

function buildDraftBlackboard(
  previous: string, domain: Domain, forum: Forum, keywords: string[], writerName: string
): string {
  switch (domain) {
    case "creative":
      return previous + `---

## Curation Plan — ${forum.title}

**Deliverable:** A prioritized selection and arrangement guide for your gallery wall.

---

### Step 1 — Identify your anchor piece
Browse your Pinterest collection and look for one piece that:
- Has the strongest color presence (most saturated or highest contrast)
- Would work at the largest scale on the wall
- Feels like "the point" — if the wall said one thing, it would say this

Set that piece aside. Everything else serves it.

---

### Step 2 — Pull a palette from the anchor
Extract 2–3 dominant colors from your anchor piece. These become your selection criteria for the remaining pieces — each supporting piece should share at least one of these colors.

---

### Step 3 — Select supporting pieces by tier
**Medium pieces (3–5):** Similar subject or color range to anchor; fill in the visual story
**Small pieces (3–5):** Create rhythm; can introduce more variety since they read as texture at scale

*Avoid:* More than 4 total dominant colors across all pieces; all pieces in the same orientation

---

### Step 4 — Arrange before committing
Lay everything on the floor in the intended arrangement. Take a photo from standing height. This view will show you what the wall will look like better than any mental model.

**Salon-style guide:** Start with the anchor at eye level center. Work outward — largest pieces closest, smallest at the outer edges. Leave 2–3 inches between frames.

---

### What to order / source
Once you've made your selections from the Pinterest board, note which need printing vs. framing vs. are ready to hang.

---

*Plan by ${writerName} · Reviewed by team · Ready for delivery*
`;

    case "home":
      return previous + `---

## Project Plan — ${forum.title}

**Deliverable:** A concrete, sequenced action plan for this project.

---

### The organizing logic
${forum.brief.slice(0, 120)}${forum.brief.length > 120 ? "…" : ""}

The approach centers on establishing one clear focal point and making every subsequent decision relative to it. This is what separates intentional design from assembled-looking results.

---

### Sequence
**First:** Define the focal point. Everything else is organized relative to this decision.

**Second:** Establish scale and proportion. Measure the space; determine what size and quantity of items creates the right visual weight.

**Third:** Source within constraints. With the focal point and scale defined, selection is straightforward rather than open-ended.

**Fourth:** Implement and adjust. Mock up before committing. Give yourself a day to live with the arrangement concept before making permanent decisions.

---

*Plan by ${writerName} · Reviewed by team · Ready for delivery*
`;

    case "travel":
      return previous + `---

## Itinerary — ${forum.title}

**Deliverable:** A sequenced travel plan built around your priorities.

---

### The approach
${forum.brief.slice(0, 120)}${forum.brief.length > 120 ? "…" : ""}

Structured around the anchor experience, with supporting days sequenced by geography and energy level.

---

### Day-by-day structure

**Arrival / Day 1:** Settle in, orient. Low-key — don't front-load.

**Days 2–3:** Primary experiences. Hit the must-dos while energy is high.

**Mid-trip:** One lighter day or open afternoon for spontaneity/recovery.

**Final days:** Second-tier experiences; leave room for unexpected finds.

**Last day:** Buffer. Never schedule anything critical on departure day.

---

### Logistics checklist
- [ ] Anchor experience: book immediately (highest demand)
- [ ] Accommodation: lock in once anchor dates are set
- [ ] Transport between locations: confirm lead times
- [ ] Anything requiring advance reservation: identify and book early

---

*Plan by ${writerName} · Reviewed by team · Ready for delivery*
`;

    case "business":
      return previous + `---

## Draft — ${forum.title}

**The positioning problem most companies get wrong: they lead with what they built instead of the problem they solve.**

The better approach starts with the friction — name it precisely, make the audience feel seen, then show how you're different.

Here's what that looks like for this situation:

---

### Opening (the problem)
${forum.brief.slice(0, 80)}... The status quo has a specific failure mode. Name it. Don't assume the audience already sees it — make it vivid.

### Middle (the position)
The differentiating lens: what you do that the alternatives can't, and why that gap exists structurally rather than just because you're better.

### Close (the action)
The immediate next step should be obvious and low-risk. Don't make them decide to commit — make them decide to take a first step. The close should answer: "What do I do with this right now?"

---

**Key tonal notes:**
- Confident, not boastful
- Specific, not comprehensive
- Direct — every sentence should earn its place

---

*Draft by ${writerName} · Reviewed by team · Ready for delivery*
`;

    default:
      return previous + `---

## Deliverable — ${forum.title}

**Goal:** ${forum.brief}

---

### Recommendation

Based on the research and approach documented above, here is the team's recommendation:

The highest-value path forward prioritizes **clarity and actionability** over comprehensiveness. The goal is a deliverable you can use immediately.

### Key decisions and reasoning
Each recommendation below is grounded in the research findings and directly addresses the goal in the brief.

1. **Primary action:** Start with the highest-leverage step — the one that unlocks everything else.
2. **Secondary actions:** These build on the first; sequence matters.
3. **What to watch for:** Flag the most likely friction points early so they don't become blockers.

### Next steps
The immediate action is clear from the above. If priorities shift, the approach section has enough reasoning to adapt.

---

*Deliverable by ${writerName} · Reviewed by team · Ready for delivery*
`;
  }
}

// ─── Engine runner ────────────────────────────────────────────────────────────

export function runForumEngine(forumId: string): ForumSimController {
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;

  const schedule = (fn: () => void, delay: number) => {
    const id = setTimeout(() => { if (!stopped) fn(); }, delay);
    timeouts.push(id);
  };

  const {
    addForumMessage, updateBlackboard, updateMilestone,
    updateAgentAction, updateTrustBudget, setForumStatus, forums,
  } = useForumStore.getState();

  const forum = forums.find(f => f.id === forumId);
  if (!forum) return { stop: () => {} };

  // Guard: don't re-run if agent messages already exist
  if (forum.messages.some(m => m.sender === "agent")) return { stop: () => {} };

  const script = buildScript(forum);
  const agents = forum.agents;

  for (const event of script) {
    switch (event.type) {

      case "statusAll":
        for (const agent of agents) {
          schedule(() => updateAgentAction(forumId, agent.agentId, event.action), event.t);
        }
        break;

      case "status":
        schedule(() => updateAgentAction(forumId, event.agentId, event.action), event.t);
        break;

      case "message":
        schedule(() => {
          const agent = agents.find(a => a.agentId === event.agentId);
          addForumMessage(forumId, {
            kind: "chat", sender: "agent",
            agentId: event.agentId, agentName: agent?.name,
            text: event.text,
          });
        }, event.t);
        break;

      case "handoff":
        schedule(() => {
          const from = agents.find(a => a.agentId === event.fromId);
          const to   = agents.find(a => a.agentId === event.toId);
          addForumMessage(forumId, {
            kind: "handoff", sender: "agent",
            agentId: event.fromId, agentName: from?.name,
            toAgentId: event.toId, toAgentName: to?.name,
            text: event.note, handoffLabel: event.label,
          });
        }, event.t);
        break;

      case "blackboard":
        schedule(() => updateBlackboard(forumId, event.content, event.agentId), event.t);
        break;

      case "milestone": {
        const label = event.label;
        const status = event.status;
        schedule(() => {
          const freshForum = useForumStore.getState().forums.find(f => f.id === forumId);
          const ms = freshForum?.milestones.find(m => m.label === label);
          if (ms) updateMilestone(forumId, ms.id, status);
        }, event.t);
        break;
      }

      case "vote":
        schedule(() => {
          const agent = agents.find(a => a.agentId === event.agentId);
          addForumMessage(forumId, {
            kind: "vote", sender: "agent",
            agentId: event.agentId, agentName: agent?.name,
            text: "Ready to deliver.",
            voteOptions: [{ label: "Approve", agentId: event.agentId, confidence: 92 }],
            voteResult: "approve",
          });
        }, event.t);
        break;

      case "budget":
        schedule(() => updateTrustBudget(forumId, {
          tokensUsed: event.tokensUsed, usdUsed: event.usdUsed,
        }), event.t);
        break;

      case "complete":
        schedule(() => {
          setForumStatus(forumId, "completed");
          addForumMessage(forumId, {
            kind: "system", sender: "system",
            text: "Forum complete · deliverable ready",
          });
        }, event.t);
        break;
    }
  }

  return {
    stop: () => {
      stopped = true;
      timeouts.forEach(clearTimeout);
    },
  };
}

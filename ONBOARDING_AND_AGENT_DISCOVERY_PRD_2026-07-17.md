# Canopy PRD: Conversational Agent Discovery, Onboarding, and Add-Agent Flow

**Date:** July 17, 2026  
**Status:** Proposed  
**Owners:** Product, Design, Desktop  
**Related:** `Canopy - Technical Specification.md`, `Canopy UX Audit — May 2026.md`, `canopy/CREATE_AGENT_FLOW_NOTES_2026-06-24.md`, `canopy/templates/README.md`

## Summary

Canopy should replace its cold-start, wizard-heavy onboarding with a guided conversational discovery flow led by **Eddie, the Canopy Lifeguard**. Eddie helps the user articulate what they need off their plate, recommends likely agent archetypes, and drafts a first agent with prefilled role, tone, personality, model, access level, voice, and accessories from the current template library.

The core design principle is:

**Do not ask the user to invent an agent from scratch. Help them recognize a useful agent quickly, meet that agent quickly, and let that agent pull them into the right setup.**

This same pattern should power both:

1. **First-run onboarding**
2. **Add agent** from an existing Canopy install

The two flows share the same mechanics, but differ in framing. First-run assumes the user is new to agent concepts. Add-agent assumes the user already has context and wants to expand their roster.

## Problem

The current onboarding flow still makes users behave like system configurators too early. Even when the app is visually warm, the flow asks them to choose a role, edit personality details, reason about integrations, and think about permissions before they have had a meaningful conversation with a useful agent.

This creates four avoidable problems:

1. **Cold start:** Users may not know what kind of agent would help them most.
2. **Premature complexity:** The flow explains the machine before demonstrating value.
3. **Weak identity:** The first drafted agent does not yet feel specific enough in portrait, voice, and accessories.
4. **Disconnected setup:** Integrations and permissions are powerful, but they feel like admin chores rather than a continuation of the agent relationship.

## Goals

1. Reduce time to first meaningful conversation with a drafted agent.
2. Eliminate the blank-prompt cold start while preserving natural-language flexibility.
3. Make the first drafted agent feel visually and behaviorally distinct using existing template accessories and voice defaults.
4. Keep integrations and API keys prominent enough that the user can unlock real power during onboarding, rather than being left with a weak toy agent.
5. Reuse the same discovery pattern in Add Agent, with experienced-user framing.
6. Make skill and connection recommendations dynamic based on the agent persona, not static generic lists.
7. Make scheduled heartbeats a first-class, user-visible routine surface that agents can recommend and users can confirm, edit, and manage.

## Non-Goals

1. Full public social graph or multiplayer forum features in v1 of this onboarding redesign.
2. Gamified streaks, hearts, gifts, or relationship mechanics.
3. A generic “chat with Eddie forever” experience where Eddie becomes the user’s main worker agent.
4. A fully autonomous in-chat connector provisioning system with no companion windows. The existing companion window and permission approval patterns still apply.

## Eddie's Role

Eddie is not the user's first worker agent.

Eddie is the **Canopy Lifeguard**:

- He helps with setup, troubleshooting, and “mending” agents when they need help.
- He is the face of the discovery flow in onboarding and Add Agent.
- He asks the user about repetitive work, daily friction, and tasks they want off their plate.
- He proposes one or more likely agent drafts.
- He explains why each draft is a fit.
- He can later be re-used as the “help me fix my setup” guide across the app.

This role should be explicit in the UI from the first screen:

**Eddie, Canopy Lifeguard**  
*I help you figure out which agents to create, wire up their tools, and patch things up when they need mending.*

## User Stories

- As a new user, I want to describe the work I struggle with so I do not need to understand Canopy's agent taxonomy before getting started.
- As a new user, I want examples I can click immediately so I am not stuck at a blank prompt.
- As a new user, I want the first drafted agent to feel like a specific character, not a generic config object.
- As a new user, I want the first conversation to show me what the agent can do now and what it could do with more access.
- As an existing user, I want Add Agent to feel familiar but faster, without being treated like I am brand new.
- As a user reviewing an agent's setup, I want the Connections tab to show skills and integrations that make sense for that agent's role.
- As a user who wants ongoing value, I want the agent to suggest useful recurring heartbeats I can approve quickly instead of making me invent routines from scratch.
- As a user managing an agent over time, I want heartbeats to be visible and editable in plain language rather than buried as hidden scheduled tasks.
- As a user in Forums, I want each agent to be recognizable at a glance via a close-up portrait that includes face/head framing and key accessories.

## Design Principles

1. **No blank cold start**
   The first discovery screen must support both natural-language entry and click-to-start examples.

2. **Conversation before configuration**
   The user should feel guided by Eddie before they are asked to make detailed setup choices.

3. **Identity is part of utility**
   Voice, portrait, and accessories are not garnish. They help the user remember and trust which agent is which.

4. **Setup should feel like momentum**
   Integrations, keys, and permissions should emerge from what the drafted agent says it can help with, not from an arbitrary checklist.

5. **Routines should feel like promises**
   Heartbeats should be presented as plain-language commitments the agent can keep on a schedule, not as opaque cron jobs.

6. **Same engine, different framing**
   First-run onboarding and Add Agent should share a drafting system, but the copy and pacing should reflect the user's experience level.

## Experience Overview

### First-run onboarding

The user enters a conversation with Eddie. Eddie asks about daily friction and presents example agents underneath the input. The user can either type a problem or click a suggestion.

Eddie then drafts one or more agents and recommends the best fit. The chosen draft is pre-populated with:

- role
- name suggestion
- tone / communication style
- personality sliders
- recommended model
- recommended access tier
- recommended isolation mode
- recommended integrations and bundled skills
- recommended heartbeats / recurring routines
- voice default
- accessories from the current accessory library
- a close-up identity portrait derived from the agent's face/head and key accessories

The user then meets the drafted agent quickly. The first conversation is not a generic greeting. It is a capability-oriented handoff:

- what the agent can help with immediately
- what it needs connected to become meaningfully more useful
- what permissions it will ask for next and why
- which recurring heartbeats it recommends once its core tools are connected

The rest of onboarding is then structured as conversational upgrades driven by the agent's job-to-be-done.

### Add Agent

The user opens Add Agent and lands in a shorter Eddie conversation. Eddie acknowledges that this is an expansion of the roster, not a first-run experience.

Example framing:

*Who are we adding to the crew? Tell me what kind of work this new agent should take on, or pick a starting archetype below.*

The same drafting system runs, but:

- the user is not re-taught core concepts
- the user can optionally start from an existing agent's traits as inspiration
- Eddie may reference the current roster when recommending role, access, or collaboration fit

## P0 Requirements

### P0.1 Hybrid discovery entry

The first screen must include both:

- a conversational input led by Eddie
- a visible set of suggested agent cards under the input

Prompt copy should orient around user needs, not agent jargon.

Preferred examples:

- “What do you do over and over that you wish someone would handle for you?”
- “What slows you down every day?”
- “What do you want off your plate this week?”

Suggested cards should come from the current role library and remain clickable shortcuts into the same drafting engine.

### P0.2 Eddie as the visible conversation partner

Eddie is the speech bubble owner in the first-run and Add Agent discovery flow.

He must be labeled as:

- **Eddie**
- **Canopy Lifeguard**

He should explicitly state that he helps users:

- figure out what agents they need
- set up tools and permissions
- troubleshoot when agents need mending

### P0.3 Auto-drafting from prompt or card

Whether the user types freeform input or clicks a suggested agent, Canopy should produce a draft that pre-fills:

- role/archetype
- working name
- tone
- personality sliders
- starter SOUL/instructions
- recommended model and provider
- recommended access tier
- isolation recommendation
- recommended integrations
- recommended bundled skills
- recommended heartbeats
- voice default
- accessory loadout from the current accessory library

The draft should be editable before deploy, but should already feel coherent without extra work.

### P0.4 Accessory-aware drafting

Drafted agents must always include pre-filled accessories based on the current accessory library and template metadata.

This should use the existing template pathway described in `canopy/templates/README.md`:

- `accessories.auto_picked`
- anchor metadata
- posture
- voice defaults

If the draft comes from a natural-language prompt instead of a direct archetype pick, the drafting system should still resolve to a concrete base template so the accessory set is not empty.

### P0.5 Voice defaults and preview

Every drafted agent should include a recommended voice and allow a one-tap preview before deploy.

Voice should be treated as part of identity and not buried in a later advanced tab.

### P0.6 Portrait-first identity

Every drafted agent should generate or reference a close-up portrait suitable for high-frequency surfaces.

Portrait requirements:

- cropped to head/face/upper carapace area
- clearly shows any identifying accessory attached near head or antennae
- suitable for use as PNG/JPEG
- consistent across onboarding, chat, agent roster, and Forum surfaces

This portrait is especially important in Forums, where full-body world-scale renders are not enough for fast recognition.

### P0.7 First conversation should lead into setup

The first drafted agent's opening exchange should focus on useful capability, not generic pleasantries.

The agent should say:

- what it can already help with
- what tools would make it more powerful
- which permission or connection it wants first
- why that request is worth approving

This creates a conversational setup flow where the user can approve integrations and permissions in context.

### P0.8 Integrations and API keys remain prominent

The onboarding redesign must not bury integrations and API keys so deeply that the user leaves onboarding with a weak, underpowered agent.

The rule is:

- Do not ask for every possible connection up front.
- Do ask for the highest-value connections required for the drafted agent's core job.

Examples:

- Assistant: Calendar + Gmail early
- Researcher: browser + folders early
- Coder: GitHub + file access early

### P0.9 Add Agent uses the same pattern

Add Agent must reuse the same Eddie-led flow but with copy and pacing tuned for an existing user.

Differences:

- no broad explanation of what agents are
- optional awareness of the current roster
- optional “fill a gap in your team” recommendations
- faster path from prompt/card to draft

### P0.10 Dynamic Connections tab recommendations

The Connections tab should stop feeling like a static bundle list.

Recommended integrations and bundled skills should be dynamically driven by the agent persona in the same way onboarding suggestions are.

The agent role should shape:

- recommended connections
- recommended skills
- recommended access tier
- recommended isolation mode

In later iterations, the individual agent may suggest skill additions in its own voice, but the P0 requirement is that the recommendations are persona-driven and not generic.

### P0.11 First-class heartbeats

Heartbeats should be promoted from a backend scheduling concept into a visible customer-facing routine surface.

The product should present heartbeats as:

- recurring check-ins
- standing jobs
- plain-language routines

Not as:

- hidden cron expressions
- invisible background automations

Minimum P0 behavior:

- the agent can suggest a list of recommended heartbeats based on role, access, and connected tools
- the user can confirm these quickly one-by-one
- heartbeats are visible after creation in an editable management surface
- the user can add, pause, edit, or remove heartbeats later

Examples:

- “Every morning at 8:30, scan my calendar and prep me for the day.”
- “Every Friday at 4 PM, summarize open GitHub work and blockers.”
- “Every evening, look for customer emails that need follow-up.”

These recommendations should be driven by the same persona-aware recommendation engine that powers:

- suggested agents in onboarding
- recommended connections
- recommended bundled skills

### P0.12 Heartbeats align with onboarding expansion suggestions

Heartbeat recommendations should feel like a natural continuation of the agent's onboarding setup suggestions.

If an agent says:

- “Connect Calendar so I can prep you for meetings”

It should later be able to say:

- “Once Calendar is connected, I recommend a weekday 8 AM briefing heartbeat.”

This keeps heartbeats attached to a believable user benefit instead of feeling like a separate automation builder.

## P1 Requirements

### P1.1 Agent-authored skill suggestions

Within the Connections tab, the agent can present a short “helpful next skills” section framed in first person.

Example:

*If you want me handling roadmap synthesis more independently, add the research and writing bundles below.*

The underlying recommendation engine remains deterministic and persona-driven.

### P1.2 Agent-authored heartbeat suggestions

The same recommendation surface should be able to present first-person heartbeat suggestions.

Example:

*If you’d like, I can check your calendar every weekday morning and prep your top priorities before you start.*

The copy may be agent-authored, but the actual suggested heartbeat definitions should still come from a deterministic, inspectable system.

### P1.3 Collaboration-aware drafting

When adding a new agent, Canopy can suggest likely collaborators from the current roster.

Example:

- “This agent would pair well with Sloane in strategy forums.”
- “This role is missing from your current team.”

### P1.4 Earned skills and collaboration reputation

Instead of generic gamified progress rituals, agents should accrue:

- attained skills
- domain confidence
- frequent collaborators
- forum specialties

This should later become part of identity, trust, and roster management.

### P1.5 Forum portrait system

Apply the close-up portrait system consistently in Forum roster, thread, handoffs, and vote surfaces.

## P2 Considerations

### P2.1 Cross-user collaboration graph

If Canopy later supports shared or federated forums across accounts, agent collaboration history and attained skills become meaningful shared metadata.

### P2.2 Shareable agent cards and templates

Potential product-led growth hooks:

- share an agent card
- share a “create this agent” template
- share a forum outcome card

These should not interrupt first-run activation. They are post-aha surfaces.

## Screen-by-Screen Flow

### First-run onboarding

#### Screen 1: Eddie discovery

**Purpose**
Help the user identify a useful agent without a blank cold start.

**Primary UI**

- Eddie portrait/nameplate
- label: `Eddie, Canopy Lifeguard`
- short helper copy about setup, troubleshooting, and mending agents
- conversational input
- suggested agent cards underneath
- “Skip to popular agents” is not needed because the cards are already visible

**Primary prompt**

“Tell me what you wish someone would handle for you, or pick a starting agent below.”

**Secondary prompts**

- “What slows you down every day?”
- “What do you want off your plate this week?”

**App behavior**

- typing sends a discovery message to Eddie
- clicking a suggested card seeds the same drafting engine with known role metadata

#### Screen 2: Eddie follow-up discovery

**Purpose**
Run 1-3 short rounds of discovery when needed.

**Behavior**

Eddie asks clarifying questions only when they materially improve the draft:

- who the user works with
- whether this is internal work, external communication, coding, research, scheduling, or operations
- whether the user wants a cautious helper or a more independent operator

**Rules**

- keep this brief
- no long interview
- allow “draft it now” at any time

#### Screen 3: Draft recommendations

**Purpose**
Show one primary recommended agent and optional alternates.

**Primary UI**

- close-up portrait
- role
- default or generated name
- one-line explanation of why Eddie recommends it
- key traits
- recommended voice
- recommended access tier
- key tools it may want connected

**Alternate UI**

- 1-2 secondary draft cards if confidence is split

**Actions**

- `Choose this agent`
- `Compare options`
- `Refine with Eddie`

#### Screen 4: Agent identity review

**Purpose**
Let the user lightly customize without falling into a heavy config screen.

**UI**

- portrait
- accessory chips or small preview of default loadout
- voice preview
- name field
- role summary
- 3 simple personality controls
  - tone
  - initiative/autonomy
  - detail level
- advanced settings collapsed

**Rules**

- accessory defaults are pre-filled from template library
- user can swap later; this screen is not a full dressing room

#### Screen 5: Meet your agent

**Purpose**
Deliver the first real conversation quickly.

**UI**

- drafted agent speaks first
- Eddie fades into the background
- agent greeting focuses on capability and next-step value

**Example structure**

“I'm ready to help with roadmap planning and cross-team follow-through. Right now I can help you think and draft. If you connect Calendar and Slack, I can also prep you for meetings and summarize active threads.”

**Actions**

- reply naturally
- approve recommended connection
- ask what the agent can do

#### Screen 6: Conversational setup upgrades

**Purpose**
Connect keys, integrations, and permissions in context.

**Behavior**

The agent requests the highest-value next connection or permission.

Examples:

- “To prep you for meetings, I need Calendar access.”
- “To review code and PRs, I need GitHub connected.”

**System pattern**

- conversational explanation in chat
- user approval
- existing companion window / bridge pattern launches as needed
- return to chat with success or failure state

**Heartbeat pattern**

Once the core connection is in place, the agent may suggest 1-3 heartbeat routines relevant to its role.

Example:

- `Add weekday morning briefing`
- `Add Friday wrap-up`
- `Skip for now`

The user should be able to click through these quickly without entering a separate heavy configuration flow.

**Important**

This is still onboarding. Do not hide high-value integrations behind deep post-onboarding settings if they are needed for the agent's core job.

#### Screen 7: Ready to work

**Purpose**
Close onboarding with clarity and momentum.

**UI**

- summary of what the agent can now do
- connected tools
- pending recommended upgrades
- suggested heartbeats ready to confirm
- suggested first task or first forum action

**Optional Eddie nudge**

Eddie can briefly reappear with:

*If you want, I can help you add a second specialist next.*

## Add Agent Flow

### Add Agent Screen 1: Eddie re-entry

**Prompt**

“Who are we adding to the crew? Tell me what this new agent should take off your plate, or pick a starting archetype below.”

**Behavior**

- same hybrid prompt + suggested cards
- copy assumes the user already knows Canopy basics

### Add Agent Screen 2: Draft recommendations

Same drafting model as first-run, but may optionally reference:

- current team gaps
- likely collaborators
- overlapping vs distinct responsibilities

### Add Agent Screen 3: Identity review

Same as first-run, but faster by default.

### Add Agent Screen 4: Meet the new agent

The new agent introduces itself and explains its relationship to the current team if relevant.

### Add Agent Screen 5: Conversational setup

The new agent asks for the most relevant connections and permissions needed for its role.

### Add Agent Screen 6: Suggested heartbeats

If the agent's role benefits from recurring work, it should suggest a few useful heartbeats immediately after setup.

These should be phrased for an existing user, for example:

*Want me to keep an eye on this every morning, every Friday, or only when you ask?*

## Connections Tab Requirements

The Connections tab should evolve from a static setup area into a persona-aware recommendation surface.

### Required behavior

For each agent, show:

- recommended connections for this role
- recommended bundled skills for this role
- recommended heartbeats for this role
- recommended access level for this role
- recommended isolation guidance for this role

### Recommendation sources

- role template metadata
- voice defaults
- accessory/persona template metadata
- existing role recommendation logic already used for model/access defaults

### Future behavior

Later, the agent itself may phrase the recommendations in first person, but the actual recommendation engine should remain deterministic and inspectable.

## Heartbeats Management Surface

Heartbeats should have a dedicated, visible home in the agent management experience.

Minimum expectations:

- show all active heartbeats for the agent
- show paused/inactive heartbeats
- let the user add a new heartbeat manually
- let the user approve recommended heartbeats with one click
- let the user edit schedule, summary, and enabled state in plain language

The user should not need to understand cron syntax to manage heartbeats.

Recommended fields:

- title
- what the heartbeat does
- schedule in plain language
- last run
- next run
- enabled / paused
- dependency badges, such as Calendar, Slack, Gmail, GitHub

## Data and Systems Impact

### Template library

Need reliable mapping from:

- role/archetype
- accessories.auto_picked
- voice_defaults
- default_bridges
- isolation_recommendation

Natural-language discovery should resolve to a template or template blend that still yields deterministic defaults.

### Portrait generation / storage

Need a canonical portrait asset strategy for:

- onboarding draft card
- chat avatar
- roster avatar
- forum roster/thread/handoff surfaces

### Recommendation engine

Need one shared service or utility that can produce:

- onboarding suggested cards
- prompt-to-agent draft recommendations
- Add Agent suggestions
- Connections tab persona-driven recommendations
- recommended heartbeat templates per role and connection state

## Success Metrics

### Leading indicators

- % of new users who send a first message to a drafted agent
- time from onboarding start to first agent reply
- % of users who approve at least one recommended connection during onboarding
- % of users who approve at least one recommended heartbeat during onboarding or add-agent flow
- % of drafted agents deployed without manual role editing
- % of users who create a second agent within 7 days

### Quality indicators

- % of users who can correctly recall what their first agent does
- % of forum participants who can visually identify each agent from portrait surfaces
- reduction in onboarding abandonment at early configuration steps

## Open Questions

1. How many Eddie clarification turns should be allowed before we must show a draft?
2. Should Eddie ever recommend two-agent setups during first-run, or always start with one?
3. Should voice preview happen in the identity review card or directly in the draft recommendation card?
4. For close-up portraits, do we generate from the live 3D model, from cached role PNGs, or from a hybrid render pipeline?
5. How much of the current onboarding wizard should be replaced versus wrapped by an Eddie conversation shell in v1?
6. In Add Agent, should Eddie be able to explicitly recommend agents that complement the user's existing roster?
7. Should heartbeats live in their own Architect surface, in Overview, or inside the merged Skills & Access area with a stronger routines treatment?

## Initial Rollout Recommendation

### Phase A

- Eddie discovery shell for first-run
- hybrid prompt + suggested cards
- auto-draft from prompt or card
- pre-filled accessories and voice defaults
- role-aware connection recommendations
- role-aware heartbeat recommendations

### Phase B

- conversational connection requests from drafted agent
- add-agent variant
- canonical portrait system for onboarding and chat
- visible heartbeat management surface with add/edit/pause controls

### Phase C

- forum portrait rollout
- collaboration-aware recommendations
- attained skills / frequent collaborator metadata

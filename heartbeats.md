# Canopy Heartbeats Contract

**Date:** July 18, 2026  
**Status:** Proposed  
**Related:** `canopy/HEARTBEATS_APP_IMPLEMENTATION_PLAN.md`

## Purpose

This document defines how Canopy should treat OpenClaw heartbeats at the runtime/file level.

This is **not** the app UI or onboarding tech spec. App-specific implementation belongs in:

- `canopy/HEARTBEATS_APP_IMPLEMENTATION_PLAN.md`
- onboarding/product PRDs
- Canopy technical spec docs

## Core Rule

Canopy should use OpenClaw's native heartbeat model, not invent a parallel recurring-task system.

The source of truth is:

- workspace `HEARTBEAT.md`
- heartbeat cadence/config in OpenClaw

## Canopy Responsibilities

Canopy should:

- read `HEARTBEAT.md`
- write `HEARTBEAT.md`
- preserve user and agent edits where possible
- serialize suggested routines into a safe, predictable structure
- keep heartbeat instructions understandable to both humans and agents

## Customer-Facing Framing

The product may call these:

- Heartbeats
- Routines

But the runtime contract still resolves into `HEARTBEAT.md`.

## Recommended File Structure

Canopy should standardize a minimal structure that the UI can safely manage:

```md
<!-- Managed by Canopy. Advanced users may edit directly. -->

tasks:
  - name: weekday-briefing
    interval: 1d
    prompt: "Check calendar and prepare a concise morning briefing."
  - name: friday-wrap-up
    interval: 7d
    prompt: "Summarize open work, blockers, and next steps."

# Additional instructions

- Keep alerts short.
- If nothing needs attention, reply HEARTBEAT_OK.
```

## Managed vs Freeform Zones

Canopy should preserve two conceptual zones:

1. **Managed routines zone**
   The structured `tasks:` block the app can reliably read and write.

2. **Freeform instructions zone**
   Human- or agent-authored guidance below the tasks block.

This lets Canopy offer a safe UI while preserving OpenClaw flexibility.

## Empty File Behavior

If an agent should not proactively run recurring checks yet, Canopy should preserve OpenClaw's lightweight behavior:

- empty or comment-only `HEARTBEAT.md`
- or disabled heartbeat cadence

Do not force non-empty heartbeat files for every agent.

## Self-Expansion Rules

Canopy must not remove OpenClaw's proactive self-improvement strengths.

That means agents should still be able to:

- suggest new heartbeats
- suggest edits to existing heartbeat prompts
- improve stale routines over time

Canopy's role is to make those changes:

- reviewable
- visible
- bounded when necessary

## Serialization Guidance

When Canopy writes heartbeats:

- keep tasks short and specific
- avoid secrets in prompts
- keep additional instructions compact to reduce prompt cost
- prefer structured `tasks:` blocks for UI-managed routines

## Notes

- App-specific screens, flows, and component breakdowns belong in `canopy/HEARTBEATS_APP_IMPLEMENTATION_PLAN.md`.
- Onboarding and Add Agent should ultimately write into this contract, not around it.

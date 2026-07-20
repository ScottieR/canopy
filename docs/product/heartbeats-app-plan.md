# Canopy App Implementation Plan: Heartbeats

**Date:** July 18, 2026  
**Status:** Proposed  
**Related:** [`../architecture/heartbeats.md`](../architecture/heartbeats.md), [`onboarding-and-agent-discovery.md`](onboarding-and-agent-discovery.md)

## Purpose

This document covers the **Canopy app implementation** of heartbeats:

- onboarding
- Add Agent flow
- agent detail surfaces
- recommendation UX
- UI simplification and advanced-settings placement

It is intentionally separate from [`../architecture/heartbeats.md`](../architecture/heartbeats.md), which remains focused on the OpenClaw-facing `HEARTBEAT.md` runtime contract.

## Product Direction

Heartbeats should be a first-class Canopy feature, but they should still resolve into OpenClaw's native model:

- customer-facing concept: **Heartbeats** or **Routines**
- runtime source of truth: agent workspace `HEARTBEAT.md`
- Canopy's job: recommend, visualize, edit, and safely serialize routines into that file

## Implementation Scope

### 1. Onboarding

- Eddie-led discovery should produce `recommendedHeartbeats` alongside role, voice, accessories, connections, and access tier.
- After the core tools are connected, the drafted agent should suggest 1-3 useful heartbeats.
- Users should be able to accept suggested heartbeats quickly with `Add`, `Edit`, or `Skip`.
- The final onboarding summary should show active heartbeats.

### 2. Add Agent

- Reuse the same discovery and heartbeat recommendation engine as onboarding.
- Change only framing, pace, and optional roster-awareness.
- After setup, the new agent should suggest recurring routines relevant to its role.

### 3. Agent Detail Surfaces

Heartbeats should appear in two places:

- **Home tab:** compact summary card
- **Skills & Access:** full manager

Advanced settings should be secondary, not primary.

## IA Guidance

### Keep primary

- Home
- Appearance
- Personality
- Skills & Access
- Activity
- Spending

### Treat as advanced / secondary

- browser internals
- diagnostics
- raw permission plumbing
- raw `HEARTBEAT.md` editing

## Heartbeat UI Structure

### Home tab

Show a compact card with:

- active heartbeats
- schedule labels
- quick “Manage” action into Skills & Access

### Skills & Access

Layer the page in this order:

1. recommended connections / skills / heartbeats
2. live heartbeats manager
3. access levels
4. advanced capability toggles and raw settings

## Self-Expansion

Canopy must preserve OpenClaw's proactive self-improvement strengths.

Default mode should be:

- **Suggest only**

Optional advanced mode later:

- **Bounded self-improvement**

That means agents can still propose heartbeat changes, but the product makes those changes legible, reviewable, and safe.

## Engineering Workstreams

### Frontend

- heartbeat parser/serializer UI around `HEARTBEAT.md`
- recommendation display and acceptance
- onboarding and Add Agent recommendation steps
- Home summary + Skills & Access manager

### Backend / IPC

- read `HEARTBEAT.md`
- write `HEARTBEAT.md`
- later: heartbeat metadata, cadence controls, and richer inspection

### Product / UX

- Eddie copy
- role-aware heartbeat library
- advanced settings placement

## Rollout

### Phase 1

- visible heartbeat UI in Home and Skills & Access
- `HEARTBEAT.md` parsing/writing
- role-aware suggested heartbeats

### Phase 2

- onboarding heartbeat suggestions
- Add Agent heartbeat suggestions
- advanced heartbeat editor

### Phase 3

- agent-proposed heartbeat diffs
- bounded self-improvement mode
- richer audit/activity visibility

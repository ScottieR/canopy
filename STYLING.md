# The Canopy — Design System & Styling Requirements

> **This document is canonical.** Any visual decision not covered here should be resolved
> by referencing this file first. If you're adding UI, read this before writing code.

---

## 1. North Star — Concept Art Reference

**File:** `assets/reference/lobster-style-grid.png`
**Title:** "10 Ways to Style a Lobster: An Isometric Character Grid"

This concept art grid is THE definitive visual reference for the entire app. Every
3D model, icon, habitat zone, and image generation prompt must derive from it.

### What the concept art establishes

**Character silhouette (universal across all archetypes):**
- Rounded, bell-shaped body (NOT a sharp cone — organic, slightly bulbous)
- Smooth, rounded head sitting directly on the body with no visible neck
- Two prominent antennae with bulbous tips, swept back at slight angles
- **Visible claws/arms** extending from the body sides — small, expressive, functional
- Low-poly but soft — flat-shaded faces with gentle gradients, never hard-edged
- Proportions: head is ~30% of body width, body tapers gently at the base
- Eyes: simple, round, slightly recessed — minimal but expressive

**Habitat environments (The Floating Terrarium Slice):**
The overarching 3D layout is a **floating isometric slice of earth** (a diorama or terrarium), rather than a globe. This "slice" aesthetic presents a cross-section of the ground (showing layers of dirt or architecture) and provides a clean, 2D-like grid across the top surface.
Each archetype lives in a distinct micro-world on this surface that communicates their role at a glance. As users add agents, the terrarium slice expands outwardly (e.g., adding a hexagonal tile or widening a disc) to accommodate them.

**The "No Pedestal" Rule:**
Agents must be placed **directly onto the habitat surface**. Do not place agents on pedestals, stands, or geometric bases. Grounding them directly in the "dirt" or floor integrates them into the ecosystem, making them feel like living inhabitants rather than static museum artifacts. Their accessories should be scattered around them organically.

These habitats inform both the 3D world zones AND image generation prompts.

| Panel | Archetype | Habitat | Key visual elements | Shell tint |
|-------|-----------|---------|-------------------|------------|
| 1 | Accountant (Financial) | Labyrinth | Stacked stairs, ledgers, geometric maze blocks | Warm peach/salmon |
| 2 | Executive (Assistant) | Axis | Tall command tower, data screens, vertical architecture | Teal/seafoam |
| 3 | Strategist (STR Manager) | Terrace | City overlook, planning blocks, elevated walkways | Deep navy/slate |
| 4 | Educator (Tutor) | Enclave | Open study space, books/maps, soft natural light | Soft green/sage |
| 5 | Artist | Reflection | Gallery walls, color prism, creative workspace | Deep red/crimson |
| 6 | Coder | Cyber-Matrix | Dark background, floating code, circuit patterns | Dark teal/cyber |
| 7 | Scientist (Researcher) | Sanctuary | Lab flasks, DNA helix, experiment stations | Sage green |
| 8 | Architect | Blueprint | Floor plans, holographic overlay, drafting tools | Warm grey/silver |
| 9 | Musician | Harmonics | Harp, sound waves, performance stage | Warm gold/amber |
| 10 | Athlete | Ascent | Climbing blocks, rings, geometric obstacles | Warm bronze/copper |

**Color philosophy from the art:**
- Each panel has a distinct background tint that creates mood
- Shell colors are MUTED and PASTEL — not saturated primaries
- Lighting is soft and directional (upper-left), creating gentle face shadows
- Background-to-character contrast is achieved via value, not saturation
- Environments use the same pastel family as the character but shifted cooler/warmer

### Mapping concept art to our 5 archetypes

| Our Archetype | Concept art analog | Habitat reference | Zone in 3D world |
|---------------|-------------------|-------------------|------------------|
| Assistant | Executive's Axis | Command tower, screens | commBridge |
| Financial | Accountant's Labyrinth | Stacked ledgers, maze stairs | archive |
| STR Manager | Strategist's Terrace | City overlook, walkways | watchtower |
| Researcher | Scientist's Sanctuary | Lab flasks, DNA helix | archive |
| Tutor | Educator's Enclave | Open study, books, maps | garden |

---

## 2. Brand Identity

**Name:** The Canopy
**Mascot:** Lobsters — every agent archetype is a lobster with a distinct shell color.
**Tone:** Premium, local-first, warm but professional. Think Monument Valley meets a luxury dashboard.

---

## 3. Agent Visual Identity — THE CARDINAL RULE

### NEVER use emoji to represent agents.

Not `🦞`. Not `🤖`. Not `🐦`. Not any Unicode character. **Ever.**

Emoji cheapens the app. The 3D-rendered lobster IS the brand. Every place an agent's
visual identity appears must use the `<LobsterIcon>` component, which renders an inline
Three.js Canvas matching the geometry derived from the concept art reference.

### `<LobsterIcon>` Component API

```tsx
<LobsterIcon
  shellColor="#C0392B"   // The agent's primary shell/robe color
  accentColor="#E74C3C"  // Antenna tips, claws, and accent highlights
  size={48}              // Pixel dimensions (square canvas)
/>
```

### Where LobsterIcon MUST be used

- Onboarding wizard: welcome hero, role selection cards, role preview, celebration
- Navigation bar: logo mark
- Loading screen: hero visual
- Agent roster entries (sidebar, lists)
- Chat avatars
- Architect view header (if showing agent identity)
- Any future location where an agent's visual identity is displayed

### Character geometry (derived from concept art)

The lobster model must match the concept art silhouette — rounded bell body with
visible claws, smooth head, prominent antennae with bulbous tips.

| Part | Geometry | Key dimensions | Notes |
|------|----------|---------------|-------|
| Body | ConeGeometry | radius 0.45, height 0.43, 8 seg | Bell-shaped, not sharp — radiusBottom > radiusTop |
| Upper body | ConeGeometry | radius 0.21, height 0.15, 8 seg | Shoulder area, tapers into head |
| Head | SphereGeometry | radius 0.12, lerped 60% → `#F5E6D8` | Smooth, sits directly on upper body |
| Left claw | SphereGeometry + CylinderGeometry | sphere 0.04r, arm 0.008r × 0.12h | Extends from body side, slight forward angle |
| Right claw | SphereGeometry + CylinderGeometry | sphere 0.04r, arm 0.008r × 0.12h | Mirror of left claw |
| Antenna stalks | CylinderGeometry | 0.008 → 0.012 radius, ~0.25 height | Swept back at slight angle |
| Antenna tips | SphereGeometry | radius 0.025 | Bulbous, colored with accentColor |

If you change the AgentCharacter model, update LobsterIcon to match. They must always
be visually consistent — the icon is a static portrait of the same creature.

---

## 4. Shell Color Palette

Each agent archetype has a canonical shell color. These are non-negotiable:

| Archetype | Shell (robeColor) | Accent (accentColor) | UI Color |
|-----------|-------------------|---------------------|----------|
| Assistant | `#C0392B` (red) | `#E74C3C` | `#E74C3C` |
| Financial | `#D35400` (amber) | `#F39C12` | `#F39C12` |
| STR Manager | `#16A085` (teal) | `#1ABC9C` | `#1ABC9C` |
| Researcher | `#2980B9` (blue) | `#3498DB` | `#3498DB` |
| Tutor | `#8E44AD` (purple) | `#9B59B6` | `#9B59B6` |

The `robeColor` is the darker, richer shade used for the 3D model body.
The `accentColor` is the brighter shade used for antennae, highlights, and UI accents.
The `color` field is for flat UI elements (borders, backgrounds, status dots).

---

## 5. Color System

### Base Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-warm` | `#EDE4DB` → `#F5EEE8` | App background gradient |
| `--surface` | `rgba(255,255,255,0.4)` | Glass panels, nav bar |
| `--text-primary` | `#2D3436` | Headings, body text |
| `--text-secondary` | `#636E72` | Descriptions, muted text |
| `--text-muted` | `#B2BEC3` | Disabled states, placeholders |
| `--brand` | `#218380` | Primary action color |
| `--brand-light` | `#4A9E96` | Gradient endpoints, hover states |
| `--border` | `rgba(0,0,0,0.06)` | Subtle dividers |
| `--border-input` | `rgba(0,0,0,0.08)` | Input borders |

### Isometric World Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `--iso-ground-lit` | `#D1C4B4` | Ground plane lit face |
| `--iso-ground-shadow` | `#B5A898` | Ground plane shadow face |
| `--iso-ground-top` | `#E8DDD0` | Ground plane top face |
| `--iso-sky` | `#F0EBE3` | Sky/fog color |
| `--particle-color` | `#F5E6D8` | Ambient particles |
| `--hover-ring` | `#83C5BE` | Agent hover selection ring |

---

## 6. Typography

### Font Stack

```
Primary: 'DM Sans', system-ui, -apple-system, sans-serif
Logo: 'Satoshi', 'DM Sans', system-ui, sans-serif (italic, weight 700)
Code/Keys: monospace
```

### Scale

| Element | Size | Weight | Letter-spacing |
|---------|------|--------|---------------|
| Page title (h1) | 44px | 700 | -0.02em |
| Section title (h2) | 40px | 700 | — |
| Card title | 16px | 600 | — |
| Body text | 15–16px | 400 | — |
| Description | 13px | 400 | — |
| Nav label | 12px | 400/700 | 0.04em, uppercase |
| Caption/tag | 11–12px | 400 | — |

---

## 7. Spacing & Layout

### Glass Morphism

The app uses a glassmorphism visual language:

```tsx
const glass = (opacity = 0.4) => ({
  background: `rgba(255,255,255,${opacity})`,
  backdropFilter: "blur(24px)",
  border: "1px solid rgba(255,255,255,0.3)",
});
```

### Border Radius Scale

| Context | Radius |
|---------|--------|
| Buttons (small) | 6–8px |
| Buttons (large) | 12–16px |
| Cards | 16–20px |
| Input fields | 12px |
| Avatars/dots | 50% |
| Panels | 16–24px |

### Shadows

```
Button hover: 0 8px 24px {color}25 (25% opacity of brand/accent)
Card selected: 0 8px 24px {color}40 (40% opacity)
Agent glow: 0 0 0 3px rgba(255,255,255,0.6), 0 0 12px {color}40
```

---

## 8. Animation & 3D Performance

### CSS Keyframes

```css
@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-20px); }
}

@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-20px); }
}
```

### 3D World Animation (State-Driven & Performant)

To preserve a high frame rate (60FPS+) when rendering multiple unique agent geometry and materials on the terrarium slice, we employ **Event-Driven Animation (State Machines)** rather than continuous physical calculations in `useFrame`:

- **Idle / Sleeping Mode:** By default, agents that are not actively computing tasks are "asleep" or idle. Continuous `useFrame` math for bobbing or swaying must be disabled or dramatically throttled. They should be static or use an extremely slow, minimal breathing tween (`@react-spring/three`).
- **Active / Processing Mode:** When the user initiates a task with a specific agent, that agent transitions to an active state. Only the active agent runs its full animation loop (e.g., furiously digging, sorting papers, or bobbing).
- **Tactile Micro-interactions:** If a user physically interacts with (taps/clicks) an agent, use a quick tween-based animation (like a squishy physics bounce or a puff of dust kicking up). Avoid complex skeletal recalculations; transform scale and position properties directly.
- **Antenna Sway:** Keep math simple: `sin(t * 1.5)` over a throttled clock.
- **Lighting Limits:** Avoid computing shadows from multiple agent-specific point lights. Rely on a single HemisphereLight for global softness and a single DirectionalLight casting the canonical upper-left shadow isometric style across the whole terrarium slice.
- **Transition timing:** `all 0.15s ease` (nav), `all 0.3s ease` (cards, buttons)

---

## 9. Component Rules

### Buttons

- Primary: gradient `#218380` → `#4A9E96`, white text, 600 weight
- Secondary: white/transparent bg, `#636E72` text, subtle border
- Disabled: `rgba(0,0,0,0.06)` bg, `#B2BEC3` text, no cursor pointer

### Input Fields

- Background: `rgba(255,255,255,0.7)`
- Border: `1px solid rgba(0,0,0,0.08)`
- Focus: outline none (relies on border/shadow change)
- Font: inherit (DM Sans), 15px

### Status Indicators

| Status | Visual |
|--------|--------|
| Active | Pulsing colored dot |
| Thinking | Three floating bubbles (3D) or pulsing indicator (2D) |
| Sleeping | Dimmed, no animation |
| Error | Red-tinted indicator |

---

## 10. Image Generation Prompts

All image generation (avatar prompts, habitat art, marketing visuals) MUST reference
the concept art grid. Prompts should produce results that look like they belong in the
same world as the reference panels.

### Base prompt template (character)

```
Isometric 3D-rendered lobster character in Monument Valley art style. Rounded bell-shaped
body with [SHELL_COLOR] shell, smooth round head, two swept-back antennae with bulbous
[ACCENT_COLOR] tips, small expressive claws at sides. Flat-shaded low-poly faces, soft
directional lighting from upper-left. Warm muted pastel palette. No outlines. White or
light warm background. Studio quality, centered composition.
```

### Base prompt template (habitat)

```
Isometric micro-environment in Monument Valley art style. [HABITAT_DESCRIPTION]. Geometric
architecture with soft pastel coloring, [BACKGROUND_TINT] tint. Warm muted lighting,
gentle shadows. A [SHELL_COLOR] lobster character stands within the environment, scaled
to ~40% of frame height. Low-poly 3D render, flat-shaded, no outlines.
```

### Base prompt template (terrarium ivy base)

```
Isometric micro-environment base in Monument Valley art style. A floating, thick cross-section
slice of earth consisting of a gorgeous pile of lush ivy and moss, draping organically and
hanging freely down in a couple of places below the bottom of the earth slice. The top surface
of the earth slice must be completely flat and empty, with NO buildings, NO architecture, and
NO structures. Purely natural soil and ivy. Soft pastel green tint. Warm muted lighting, gentle
shadows. Low-poly 3D render, flat-shaded, no outlines. Studio quality, centered composition on
a light warm background.
```

### Per-archetype prompt fragments

| Archetype | Shell color phrase | Habitat description |
|-----------|-------------------|-------------------|
| Assistant | "warm teal/seafoam shell" | "A command tower with floating data screens, vertical glass architecture, walkways connecting platforms" |
| Financial | "warm peach/salmon shell" | "A geometric labyrinth of stacked ledger-block stairs, accounting maze, orderly stepped platforms" |
| STR Manager | "deep slate/navy shell" | "An elevated terrace overlooking a miniature city, planning blocks, raised walkways and observation deck" |
| Researcher | "sage green shell" | "A laboratory sanctuary with glass flasks, floating DNA helix, experiment stations on clean surfaces" |
| Tutor | "soft sage/green shell" | "An open study enclave with books and maps, natural light, warm sandstone reading platforms" |

### Prompt anti-patterns

- DO NOT prompt for "cartoon" or "2D" style — always "isometric 3D render"
- DO NOT prompt for bright saturated colors — always "muted pastel"
- DO NOT prompt for emoji or Unicode characters
- DO NOT prompt for realistic/photorealistic rendering
- DO NOT prompt for dark or moody lighting — always "warm, soft, directional"

---

## 11. Anti-Patterns — DO NOT

1. **DO NOT use emoji as agent icons.** Use `<LobsterIcon>`. Always.
2. **DO NOT use forest animal theming.** No birds, badgers, raccoons, owls, deer. Lobsters only.
3. **DO NOT use flat/cartoon illustrations.** The 3D model is canonical.
4. **DO NOT add heavy borders or outlines.** The app uses subtle, glassy surfaces.
5. **DO NOT use pure white (#FFFFFF) backgrounds.** Always warm-tinted or translucent.
6. **DO NOT use system default fonts.** Always specify the DM Sans stack.
7. **DO NOT use bright, saturated backgrounds.** The palette is muted and warm.
8. **DO NOT mix isometric and flat visual styles** in the same view.

---

## 12. File Organization

- `App.tsx` — All components are currently in a single file (will be split in Phase 2)
- `LobsterIcon` — Defined at top of App.tsx, before type definitions
- `AgentCharacter` — The full 3D world agent with movement and interaction
- `AGENT_TYPE_INFO` — Canonical source of shell colors and descriptions per archetype

When splitting into separate files, `LobsterIcon` should go in `components/LobsterIcon.tsx`
and be imported everywhere it's needed. The geometry constants should be shared between
`LobsterIcon` and `AgentCharacter` via a shared `lobster-geometry.ts` constants file.

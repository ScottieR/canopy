# GLB → Code Hybrid Strategy

> **Branch:** `glb-to-code-hybrid`
> **Goal:** Shrink the 3D payload by ~99% without losing the Monument-Valley-meets-clay
> aesthetic that `STYLING.md` pins down and that the onboarding reference images
> (`/public/agents/*.png`, `Lobster Styling/*.png`) embody.
> **Ground rule (from the user):** aesthetics beat animations, every time.

---

## 1. What's actually expensive today

| Asset | Size | Used where | Notes |
|-------|------|------------|-------|
| `FlatIvyBase.glb` | **255 MB** | World scene, tiled 5× beneath every agent | Downloaded once, cloned — but raw bytes still 255 MB on first boot |
| `IvyBase.glb` | 167 MB | Legacy / unused? | Still shipped in `public/` |
| `Accountant.glb` | 21 MB | World scene agent | Meshy export, uncompressed mesh + huge PBR textures |
| `Assistant.glb` | 23 MB | World scene agent | Same |
| `Strategist.glb` | 21 MB | World scene agent | Same |
| `Researcher.glb` | 21 MB | World scene agent | Same |
| `Tutor.glb` | 22 MB | World scene agent | Same |
| `Globe.glb` | 13 MB | Unused in current scene | Dead weight |
| **Canopy view total** | **~360 MB** | First paint of the world | |

This is the perf ceiling we're crashing through. 360 MB on first paint is why the
terrarium "pops in" piecemeal even with `useGLTF.preload`.

## 2. Where agent visuals appear today (surface audit)

| Surface | Current renderer | Input | Aesthetic priority |
|---------|------------------|-------|-------------------|
| Onboarding — welcome hero | `<LobsterIcon>` → `/agents/default.jpg` | Raster PNG | **HERO** — first impression |
| Onboarding — role selection grid | `<img src={role.image}>` per role | 11 curated PNGs (`/public/agents/*.png`) | **CANONICAL REFERENCE** |
| Onboarding — role preview (step 2) | `<img>` re-use of role PNG | Same PNG | Canonical |
| Top nav — logo mark | `<LobsterIcon>` | Raster PNG | Small, always-on |
| Agent roster / sidebar entries | `<LobsterIcon>` | Raster PNG | Small, high count |
| Chat avatars | `<LobsterIcon>` | Raster PNG | Small, many |
| Architect view header | `<LobsterIcon>` | Raster PNG | Medium |
| **Canopy 3D world** | `<GLBAgent>` + terrarium tiles | 5 × 21 MB + 255 MB | **HERO 3D moment** |
| Dressing Room (Personality tab) | `<GLBAgent>` in R3F canvas | 1 GLB + accessories | Hero interactive |
| Loading screen | `<LobsterIcon>` | Raster PNG | Brief |

Key observation: **most surfaces already use PNG**, not GLB. The expensive live-3D
surfaces are exactly two — the Canopy world and the Dressing Room.

## 3. The hybrid plan

We do NOT choose one technique. Each surface gets the cheapest renderer that
preserves the aesthetic perfectly.

### 3.1 Small / static surfaces — stay PNG, elevate quality

Roster, nav, chat, onboarding cards: keep the raster pipeline. It already looks
right (these PNGs *are* the aesthetic reference per `STYLING.md § 1`). Action items:

- Replace `/agents/default.jpg` with a properly framed PNG per archetype so
  `<LobsterIcon shellColor={...}>` resolves to the correct role instead of always
  showing the default.
- Generate a `@2x` variant for retina displays; serve via `srcset`.
- Convert to AVIF/WebP (one-time build step). Typical savings: 60-80% with zero
  visible change.
- Add `loading="lazy"` + `decoding="async"` on non-hero occurrences.

No Three.js runtime cost for any of these surfaces.

### 3.2 Terrarium base — fully procedural (user decision)

Replace `FlatIvyBase.glb` (255 MB!) with procedural geometry.

**Geometry recipe** — matches `flat_ivy_terrarium_base_1776649600193.png`:

- **Earth slice block:** `BoxGeometry(4, 1.2, 4)` with `positionAttribute` jitter on
  the bottom vertices to make the underside jagged (low-poly rock vibe).
- **Grass top:** `PlaneGeometry(4, 4, 32, 32)` with per-vertex height noise
  (`simplex-noise`, amplitude 0.08) and a vertex color gradient from `#A9BA6C`
  (lit) to `#6E8B3D` (shadow). Flat-shaded.
- **Grass blades:** InstancedMesh of a 3-tri blade prototype, ~400 instances with
  randomized scale/rotation/position on top surface. Alpha-cut texture
  (`grass-blade.png`, 64×64, one file, <1 KB).
- **Ivy drape:** 4 hanging tendril instances at corners, each a `QuadraticBezierCurve`
  → `TubeGeometry` with an alpha-cut ivy-leaf texture repeating along the length.
  Use one instanced mesh per tile (4 drapes × 5 tiles = 20 instances, one draw call).
- **Side rock layers:** vertical gradient on the block sides using vertex colors —
  top band sage (`#9AA876`), middle earth (`#B07D5E`), bottom darker (`#7F5A42`),
  matching the reference image's soil strata.
- **Shader:** stock `MeshToonMaterial` with a 3-step gradient map. Gives the
  "clay" look without a custom shader. Single `DirectionalLight` from upper-left
  provides the canonical shadow direction (per `STYLING.md § 8`).

**Budget:** ~1 KB of vertex data per tile, 1 KB textures, ~6 draw calls for the
whole terrarium after instancing. **Savings vs today: ~1,275 MB → ~2 KB.**

**Aesthetic preservation plan:** before merging, render this side-by-side with a
screenshot of the FlatIvyBase GLB at the canonical camera angle. If fidelity
drops below bar, fall back to 3.3 approach (bake to texture).

### 3.3 Lobster agents — hybrid: procedural body + baked texture accessories

This is the subtlest call. The Meshy-generated lobsters have:

- Segmented tail (7-8 visible ring segments)
- Soft "clay" shading with a subtle matte highlight
- Distinct per-role proportions and accessories (Accountant's visor + abacus,
  Researcher's magnifying glass, etc.)

A pure primitives approach (`<cone>` + `<sphere>` + `<cylinder>`) CANNOT match
this — especially the segmented tail and the clay shading. Proven by the existing
`OrganicLobsterBody` lathe at `App.tsx:18` which is visibly wrong next to the
reference art.

**The approach that preserves aesthetic 100% while cutting 95%+ of payload:**

1. **Reusable procedural body** (single shared mesh for all 5 archetypes):
   - `LatheGeometry` with a carefully plotted silhouette (bell torso + segmented
     tail rings generated by Y-axis noise on the lathe curve).
   - Add 6 inset ring lines on the tail using `EdgesGeometry` scaled to the
     silhouette — gives the segmentation illusion without more verts.
   - Head: `SphereGeometry(0.13)` with slight scale.y = 0.9.
   - Antennae: 2 × `TubeGeometry` on a curved path + 2 × `SphereGeometry(0.025)` tips.
   - Claws: `SphereGeometry(0.05)` with `ExtrudeGeometry` pincer halves.
   - Material: `MeshToonMaterial` with a per-role 3-step gradient map built
     from the archetype's `robeColor`. Same shader, different gradient tex.
   - **Total mesh: ~400 triangles shared across all lobsters.**

2. **Accessories stay as GLB BUT heavily optimized:**
   - Extract the accessory meshes from the current 5 Meshy GLBs
     (visor, abacus, headset, calendar, magnifier, books, chessboard) using
     `gltf-transform`:
     ```
     npx gltf-transform optimize Accountant.glb Accountant.acc.glb \
       --compress meshopt --texture-compress webp --texture-size 256
     ```
   - Then dedupe, repack into a single `accessories.glb` atlas, extract named
     nodes per role.
   - Typical compression: 21 MB → 150-400 KB per role's accessory set.
   - Loaded once, instanced where applicable.

3. **For small 2D surfaces** (nav, roster): render the procedural lobster ONCE
   into an offscreen `WebGLRenderTarget` per archetype on app boot, store the
   bitmap, reuse as an `<img>` everywhere the GLB would otherwise render.
   One-time 200ms cost, zero per-frame cost after. This is how we get pixel-
   perfect aesthetic consistency across 3D and 2D surfaces — the PNG everywhere
   is literally a screenshot of the same mesh.

**Payload budget per archetype after this:**

| Piece | Size |
|-------|------|
| Shared procedural body geometry | 0 (code) |
| Per-archetype toon gradient map | ~500 B (256×1 PNG) |
| Accessories GLB (meshopt + webp) | 150-400 KB |
| **Per archetype total** | **~200 KB** (vs 21 MB today) |

### 3.4 Orb / "alive" effect — keep as-is

`GLBAgent.tsx` already does this procedurally — emissive sphere + `<pointLight>`
that pulses when `isWorking`. Matches the spec in `STYLING.md § 8`. No change.

### 3.5 Antenna sway, breathing — stay code

Per `STYLING.md § 8`, these are already tiny `sin(t * 1.5)` tweens. Keep.

## 4. Per-surface decision matrix

| Surface | Today | Target | Technique |
|---------|-------|--------|-----------|
| Onboarding welcome | placeholder PNG | Per-archetype PNG | Rasterize from procedural body, cache |
| Onboarding role cards | curated PNGs | Keep PNGs | These ARE the reference. WebP + @2x. |
| Nav logo | placeholder PNG | Small baked PNG | Cached offscreen render |
| Roster entries | placeholder PNG | Small baked PNG | Cached offscreen render |
| Chat avatars | placeholder PNG | Small baked PNG | Cached offscreen render |
| Canopy 3D world (agent) | 21 MB GLB | Procedural body + tiny accessory GLB | ~200 KB |
| Canopy 3D world (terrarium) | 255 MB GLB × 5 | Procedural ivy slice | ~2 KB |
| Dressing Room | 21 MB GLB + accessories | Same procedural pipeline | ~200 KB |

## 5. Rollout plan (on this branch)

1. **POC: Accountant** (this branch, committed)
   - Procedural body with `MeshToonMaterial` and peach/salmon gradient map.
   - Accountant accessories extracted, optimized to `<500 KB`.
   - Procedural ivy terrarium tile.
   - Render side-by-side with `/agents/Accountant.png` for aesthetic QA.
   - Measure: cold-load time, draw calls, FPS at 60 tiles stress test.
2. **If POC meets bar** → spread to other 4 archetypes in a follow-up PR.
3. **Image baking pipeline** as a Vite plugin: renders each archetype to PNG at
   build time, commits output under `/public/agents/baked/`.
4. **Delete** `FlatIvyBase.glb`, `IvyBase.glb`, `Globe.glb`, the 5 Meshy lobster
   GLBs from `public/` once all archetypes converted. Move original source
   GLBs out of `public/` into a `source-assets/` folder (ignored by build).

## 6. Non-goals / explicit trade-offs

- **No skeletal animation.** Per user: "aesthetics > animations." The current
  animations are tiny tween effects (bob, antenna sway, orb pulse) and those
  stay. Any richer motion would require skeletal rigs we'd need to author and
  ship — not worth the cost.
- **No runtime procedural variation.** Shell colors are canonical (per
  `STYLING.md § 4`). No random tints or morph targets.
- **No dynamic habitat swaps in the world.** Each archetype's procedural
  terrarium tile is the same ivy slice; per-archetype habitat dioramas live
  ONLY in the onboarding PNGs.

## 7. Aesthetic fidelity checklist — gate before merging

Before the POC is considered done, visually confirm against reference:

- [ ] Body silhouette matches `/Lobster Styling/Base Lobster.png` bell curve
- [ ] Tail segmentation visible at 200×200 px thumbnail size
- [ ] Shell color lerps match `AGENT_TYPE_INFO` hex values exactly
- [ ] Antennae sweep back at the same angle as in reference art
- [ ] Accessory placement matches the role PNG (abacus to the lobster's left,
      visor on the head, etc.)
- [ ] Terrarium ivy drape hangs below the tile edge (matches
      `flat_ivy_terrarium_base_1776649600193.png`)
- [ ] Lighting angle matches the "upper-left" canonical direction
- [ ] Side-by-side screenshot check at 1×, 2×, and in-world scale

If any item fails, the procedural approach loses and we fall back to 3.3's
alternative: bake the original GLB to a sprite atlas and billboard in-world.

## 8. Files this branch will touch

Additions:
- `src/components/World/procedural/Terrarium.tsx`
- `src/components/World/procedural/LobsterBody.tsx`
- `src/components/World/procedural/toon-gradient.ts` (builds per-role gradient maps)
- `src/components/World/procedural/archetypes/Accountant.tsx` (POC composition)
- `src/lib/lobster-bake.ts` (offscreen-render → bitmap helper for 2D surfaces)
- `scripts/compress-accessories.mjs` (gltf-transform pipeline)
- `public/models/accessories/` (compressed outputs)

Modifications:
- `src/components/World/WorldScene.tsx` — swap `TerrariumBase` to procedural,
  swap the Accountant `GLBAgent` to the new `AccountantAgent`.
- `src/App.tsx` — rewrite `LobsterIcon` to use baked bitmap instead of
  `/agents/default.jpg`.

Nothing else changes in this branch.

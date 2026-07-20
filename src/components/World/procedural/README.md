# Procedural Lobsters — POC

This folder contains the first cut of the **GLB → Code hybrid** strategy.
See [`docs/design/glb-to-code-strategy.md`](../../../docs/design/glb-to-code-strategy.md) for the full plan.

## What's here

```
procedural/
├── LobsterBody.tsx          — shared body used by every archetype
├── Terrarium.tsx            — procedural ivy-slice tile (replaces FlatIvyBase.glb)
├── toon-gradient.ts         — builds a 3-step toon map per color, ~3 pixels of data
├── archetypes/
│   └── Accountant.tsx       — POC archetype (body + visor + book + abacus)
├── POCScene.tsx             — standalone demo scene for visual QA
└── README.md                — this file
```

## How to preview

**Two usage modes — pick one:**

### Drop-in (replaces WorldScene inside an existing Canvas)

`<POCScene />` renders scene contents only — no Canvas wrapper. Use this when
you already have a `<Canvas>` and want to swap out the 3D contents. This is
the mode that matches how `WorldScene` is used today.

```tsx
import { POCScene } from "./components/World/procedural/POCScene";

// inside an existing Canvas:
<Canvas orthographic camera={{ position: [20, 20, 20], zoom: 60 }}>
  <ambientLight intensity={0.7} color="#F5E6D8" />
  <directionalLight position={[10, 20, 5]} intensity={0.8} />
  <OrbitControls enableZoom enablePan autoRotate autoRotateSpeed={0.8} />
  <POCScene />
</Canvas>
```

**Do NOT nest this inside another Canvas — React Three Fiber throws if two
Canvases are nested and the parent UI goes blank.**

### Standalone (full page)

`<POCSceneStandalone />` wraps everything in its own Canvas + camera +
overlay. Mount at the root of a route if you want a dedicated preview page.

```tsx
import { POCSceneStandalone } from "./components/World/procedural/POCScene";

return <POCSceneStandalone />;
```

Then `npm run dev`, orbit, compare against `/public/agents/Accountant.png`.

## What's intentionally NOT done yet

- Wiring into the real `WorldScene.tsx` — that's a follow-up after aesthetic QA.
- The other 4 archetypes — they'll follow the same pattern once Accountant
  passes the fidelity checklist in `docs/design/glb-to-code-strategy.md § 7`.
- The offscreen-bake helper for 2D surfaces (`lib/lobster-bake.ts`) — only
  needed once the procedural body passes QA.
- Deletion of the large GLB source files in `public/models/lobsters/` —
  happens at the end when every archetype has been converted.

## Aesthetic budget

Every file in this folder was written against the constraints in
`docs/design/styling.md` and the reference PNGs in
`/Lobster Styling/` and `/public/agents/`. If anything looks wrong when you
render it, the PNG wins — adjust the procedural code, don't adjust the
reference.

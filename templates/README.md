# Canopy Templates

Starter library of agent templates for Canopy. All templates share the same base lobster silhouette; identity is expressed through auto-picked accessories, posture tweaks, color tint, and ambient elements.

## Files

- `lobster-templates.json` — the canonical data file. All ten starter templates plus the blank Custom template. Consumed directly by the Rust backend (via `serde_json`) and the React frontend (via a typed import).
- `primers/` — bundled primer content, one subdirectory per template. Canopy-written primers, public-domain sources, and permissively-licensed material. User-supplied books live in the user's data directory, not here.
- `accessories/` — SVG accessory library, one file per accessory (clipboard.svg, green-visor.svg, magnifying-glass-oversized.svg, etc.). Each accessory has anchor metadata describing where on the base lobster it attaches.

## Consuming the data

### Rust (backend)

```rust
use serde::Deserialize;

#[derive(Deserialize)]
pub struct TemplateLibrary {
    pub version: String,
    pub templates: Vec<LobsterTemplate>,
    pub custom_template: CustomTemplate,
    pub morph_system: MorphSystem,
}

const TEMPLATES_JSON: &str = include_str!("../../templates/lobster-templates.json");

pub fn load_templates() -> TemplateLibrary {
    serde_json::from_str(TEMPLATES_JSON).expect("lobster-templates.json must be valid")
}
```

### React (frontend)

```ts
import templates from '../../templates/lobster-templates.json';

// vite config needs JSON imports enabled (default)
export const lobsterTemplates = templates.templates;
export const customTemplate = templates.custom_template;
```

## Schema

Each template has:

| Field | Type | Purpose |
|---|---|---|
| `id` | string | stable identifier, used in URLs and DB rows |
| `title` | string | display name (e.g., "The Strategist") |
| `tagline` | string | one-line description for template carousel |
| `description` | string | longer description for the template-detail panel |
| `responsibilities` | string[] | bullet list shown during onboarding |
| `default_name` | string | user can rename at creation |
| `communication_style` | object | default, preset options, editable flag |
| `soul_template` | string | Markdown content written to the agent's SOUL.md at creation |
| `identity_template` | string | Markdown content written to the agent's IDENTITY.md at creation |
| `recommended_reading` | object[] | books/papers with licensing + source (bundled vs. user-supplied) |
| `bundled_primers` | object[] | ship-with-the-app primer files, paths relative to `templates/` |
| `accessories.auto_picked` | string[] | accessory IDs applied at creation in Phase 1 |
| `accessories.anchors` | object | accessory-id → anchor-point-name |
| `posture` | object | `lean_deg`, `antenna_curve`, `claw_position`, `notes` |
| `color_tint` | string | hex accent color (stays within Canopy palette) |
| `ambient_elements` | string[] | particle/glow effects around the lobster |
| `voice_defaults` | object | TTS voice name + speaking speed for voice mode |
| `example_prompts` | string[] | shown on the template-detail panel so users see what the agent does |
| `guardrails` | string[] | behavioral guardrails folded into SOUL.md |
| `classifier_required` | string? | optional deterministic classifier (e.g., Coach's crisis detector) that runs outside the LLM |
| `default_bridges` | string[] | bridges the template typically needs (UI pre-checks them during onboarding, user can deselect) |
| `isolation_recommendation` | "shared" \| "isolated" | routing recommendation for OpenClaw container placement |

## The base lobster

Every template and every user-customized agent renders from the same base silhouette (`base.svg`). The base has named anchor points:

- `claw_left`, `claw_right`
- `carapace_top`, `carapace_center`
- `antenna_left`, `antenna_right`
- `tail`
- `belt_line`
- `eye_level`

Accessories attach to anchors. Posture tweaks apply as transform deltas on the claws, antennae, and body tilt. **The silhouette itself never deforms.** This is the identity contract that makes a Canopy agent recognizable.

## Morph system phasing

- **Phase 1:** static auto-pick. At creation, the template's `accessories.auto_picked` list is applied. User can swap individual accessories via a picker UI but the default set pre-applies. No re-morph when SOUL.md is edited.
- **Phase 1.5:** real-time morph. Keyword-to-accessory rule table scans SOUL.md, IDENTITY.md, and training corpus on change, fading accessories in/out. The open prompt area ("give it a detective vibe") routes through a constrained LLM call that emits a validated JSON patch.

Full morph-engine spec lives in `ROADMAP.md` Phase 1.5.

## Updating templates

Template data is versioned via the top-level `version` field. On breaking schema changes:

1. Bump `version` (semver).
2. Write a migration in `canopy/src-tauri/src/template_migrations/` that upgrades existing agent records.
3. Update this README's schema table.

Template content (soul_template, identity_template, recommended_reading, bundled_primers) can be updated freely within a major version — existing agents keep their own copies written at creation time, so template edits don't retroactively alter deployed agents.

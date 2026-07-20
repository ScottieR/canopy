# Design System Document: Architectural Serenity
 
## 1. Overview & Creative North Star
**Creative North Star: The Celestial Architect**
 
This design system is not a utility; it is an atmosphere. Inspired by the impossible geometries and meditative pacing of *Monument Valley*, we are moving away from the "flatness" of modern SaaS to create a digital space that feels three-dimensional, hushed, and intentional. 
 
We break the "template" look through **intentional asymmetry** and **tonal depth**. Rather than a standard 12-column grid that dictates rigid placement, we treat the screen as a canvas where elements lean into one another. We utilize overlapping surfaces and varying heights to create a sense of discovery. This is "High-Art Minimalism"—where every pixel serves a poetic purpose.

**The Isometric Terrarium:** As the literal anchor of our High-Art Minimalism, the 3D ecosystem exists as a floating, isometric cross-section of earth (a slice). This grounds our digital agents into a tactile diorama space, emphasizing readability and god-game interactions over complex camera manipulation. This creates predictable UI visibility (no agents hidden behind a sphere) while feeling exceptionally premium.
 
---
 
## 2. Colors: The Meditative Palette
Our palette is a departure from the harsh contrasts of traditional UI. We use soft, dawn-like pastels to evoke a sense of calm and elevation.

### Token Reference
| Token | Hex | Usage |
|-------|-----|-------|
| `surface` | `#faf9f6` | Base page background |
| `surface-container-low` | `#f4f4f0` | Section backgrounds |
| `surface-container-lowest` | `#ffffff` | Card/input lift |
| `primary` | `#3c6663` | Primary actions, active states |
| `primary-container` | `#b8e6e2` | Gradient endpoint, tinted surfaces |
| `secondary-container` | `#f7e59d` | Accent glows, warmth |
| `on-surface` | `#303330` | Body text, shadow tint |
| `outline-variant` | `#b1b2af` | Ghost borders only |
| `error` | `#aa371c` | Error text (never fill) |
 
### The "No-Line" Rule
**Explicit Instruction:** Designers are prohibited from using 1px solid borders for sectioning or containment. 
Boundaries must be defined solely through:
*   **Background Color Shifts:** Placing a `surface-container-low` section against a `surface` background.
*   **Tonal Transitions:** Using soft gradients to suggest where one area ends and another begins.
 
### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers—like stacked sheets of fine, hand-pressed paper. 
*   **Nesting:** Use the `surface-container` tiers (Lowest to Highest) to create depth. An inner card should use a higher tier (e.g., `surface-container-high`) than its parent container to "lift" it toward the user without relying on heavy shadows.
 
### Signature Textures & Glass
To achieve the "impossible geometry" feel, use **Glassmorphism** for floating elements (modals, floating navs). 
*   **The Signature Gradient:** Apply a linear gradient from `primary` (#3c6663) to `primary-container` (#b8e6e2) for main CTAs to provide a visual "soul."
*   **The Ethereal Glow:** Use `secondary_container` (#f7e59d) for subtle background glows behind key architectural elements to simulate pale sunlight.
 
---
 
## 3. Typography: Editorial Sophistication
We pair a timeless serif with a functional sans-serif to create an "Editorial UI" experience.
 
*   **Display & Headlines (Noto Serif):** These are our "Architectural" elements. Use `display-lg` and `headline-md` to anchor the page. The high contrast of Noto Serif conveys authority and grace.
*   **UI & Body (Manrope):** Our "Functional" element. Manrope provides a clean, minimalist contrast that ensures readability in dense UI areas.

### Font Stack
```css
font-family: 'Noto Serif', Georgia, 'Times New Roman', serif;   /* Headlines */
font-family: 'Manrope', system-ui, -apple-system, sans-serif;   /* Body / UI */
```
 
**Hierarchy as Identity:** 
Large-scale `display-lg` type should often be used with generous letter-spacing or as part of an asymmetrical layout, sometimes overlapping background elements to reinforce the sense of depth.
 
---
 
## 4. Elevation & Depth: Tonal Layering
Traditional shadows are too heavy for this system. We convey hierarchy through light and stacking.
 
### The Layering Principle
Depth is achieved by "stacking" surface tokens.
*   **Level 0 (Base):** `surface` (#faf9f6)
*   **Level 1 (Sections):** `surface-container-low` (#f4f4f0)
*   **Level 2 (Cards/Modules):** `surface-container-lowest` (#ffffff) for a "bright" lift.
 
### Ambient Shadows
When an element must "float" (e.g., a Celestial Icon button), use a shadow tinted with the `on-surface` color at 4%–8% opacity. 
*   **Specs:** Blur: 24px - 40px | Y-Offset: 8px | Color: `#303330` at 6% opacity.
*   **CSS:** `box-shadow: 0 8px 40px rgba(48, 51, 48, 0.06);`
 
### The "Ghost Border" Fallback
If a border is required for accessibility, use the "Ghost Border": `outline-variant` (#b1b2af) at **10% opacity**. Never use 100% opaque borders.
*   **CSS:** `border: 1px solid rgba(177, 178, 175, 0.10);`
 
---
 
## 5. Components: Architectural Primitives
 
### Buttons
*   **Primary:** A gradient fill (`linear-gradient(135deg, #3c6663, #b8e6e2)`) with `full` roundedness (border-radius: 9999px or large rem). No shadow unless hovered. Text: white.
*   **Secondary:** `surface-container-low` (#f4f4f0) background with `primary` (#3c6663) text. No border.
*   **Tertiary:** All-caps `label-md` in `primary` with a delicate celestial icon.

### Cards & Lists
*   **No Dividers:** Forbid the use of line dividers. Separate list items using 16px of vertical white space or subtle background shifts.
*   **Impossible Geometry:** Occasionally break the `DEFAULT` roundedness (0.25rem) by using asymmetrical corners (e.g., Top-Left: 2rem, Bottom-Right: 0.25rem) for high-art hero cards.
*   **Card background:** `surface-container-lowest` (#ffffff) on a `surface-container-low` (#f4f4f0) parent.
 
### Input Fields
*   **Styling:** Use `surface-container-lowest` (#ffffff) as the field background. Instead of a bottom line, use a subtle 4px `primary` bar that appears only on focus.
*   **Error State:** Use `error` (#aa371c) text, but keep the field container soft—never turn the whole box bright red.
*   **No border at rest.** Ghost border (`rgba(177, 178, 175, 0.10)`) only if accessibility demands it.
 
### Celestial Icons
Icons should be thin-stroke (1px or 1.5px) and feature "celestial" motifs—dots representing stars, thin crescent curves, and unclosed paths. Use `primary` or `secondary` for icon colors.
 
---
 
## 6. Do's and Don'ts
 
### Do:
*   **Do** use extreme white space. If you think there is enough space, add 20% more.
*   **Do** overlap elements. Let a serif headline slightly bleed over a background image or a glass container.
*   **Do** use "Impossible Geometry." Experiment with unexpected corner radii to make containers feel like architectural artifacts.
*   **Do** use Glassmorphism (`backdrop-filter: blur(12px)` + semi-transparent surface bg) for floating panels and modals.
 
### Don't:
*   **Don't** use Dark Mode. This system is designed for "Daylight" and "Ether"—dark modes crush the delicate pastel transitions.
*   **Don't** use standard "Drop Shadows." They make the design look like a generic app template.
*   **Don't** use 1px dividers. If you feel the need to separate content, use a tonal shift or a change in typography scale.
*   **Don't** use high-saturation colors. Every color should feel like it has been softened by a layer of mist.
*   **Don't** use DM Sans — it was replaced by Manrope (body) and Noto Serif (headlines).
 
---

## 7. CSS Variable Reference
```css
:root {
  /* Surfaces */
  --surface:                   #faf9f6;
  --surface-container-low:     #f4f4f0;
  --surface-container-lowest:  #ffffff;

  /* Brand */
  --primary:                   #3c6663;
  --primary-container:         #b8e6e2;
  --secondary-container:       #f7e59d;
  --on-surface:                #303330;
  --outline-variant:           #b1b2af;
  --error:                     #aa371c;

  /* Legacy world palette (3D scene only) */
  --sky-top:                   #C8D8E8;
  --sky-bottom:                #F5E6D8;
  --world-bg:                  #faf9f6;

  /* Shadows */
  --shadow-ambient:            0 8px 40px rgba(48, 51, 48, 0.06);
  --shadow-float:              0 8px 24px rgba(48, 51, 48, 0.08);
}
```

---
**Director's Note:**
Remember, we are building a sanctuary. Every interaction should feel like a soft exhale. If a component feels "busy," strip it back until only the essential geometry remains.

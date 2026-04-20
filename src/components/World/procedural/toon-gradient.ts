import * as THREE from "three";

/**
 * Build a 3-step toon gradient texture from a single base color.
 *
 * The "clay / plasticine" shading in the Meshy reference PNGs (see
 * /public/agents/*.png and /Lobster Styling/Base Lobster.png) comes from
 * exactly three value bands: lit face, mid face, and shadow face. That maps
 * 1:1 to three.js `MeshToonMaterial` which takes a gradientMap — one pixel
 * per band, no interpolation.
 *
 * By generating this map procedurally per archetype we get identical shading
 * across all lobsters while respecting each archetype's canonical shell color
 * (STYLING.md § 4). Total texture cost: 3 pixels per archetype.
 */
export function buildToonGradient(baseHex: string): THREE.DataTexture {
  const base = new THREE.Color(baseHex);

  // Convert to HSL so we can shift lightness without muddying hue.
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);

  const shadow = new THREE.Color().setHSL(hsl.h, hsl.s * 0.85, Math.max(0.12, hsl.l - 0.22));
  const mid    = new THREE.Color().setHSL(hsl.h, hsl.s,        hsl.l);
  const lit    = new THREE.Color().setHSL(hsl.h, hsl.s * 0.7,  Math.min(0.92, hsl.l + 0.14));

  const data = new Uint8Array(3 * 4);
  [shadow, mid, lit].forEach((c, i) => {
    data[i * 4 + 0] = Math.round(c.r * 255);
    data[i * 4 + 1] = Math.round(c.g * 255);
    data[i * 4 + 2] = Math.round(c.b * 255);
    data[i * 4 + 3] = 255;
  });

  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

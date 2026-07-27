import * as THREE from "three";

/**
 * three.js GPU resource disposal helpers.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 * three.js does NOT garbage-collect GPU resources. A material or texture that
 * becomes unreachable from JS keeps its WebGL object alive until `.dispose()` is
 * called explicitly or the context is lost. Before this file, the app contained
 * zero `.dispose()` calls while cloning materials and textures per mounted
 * component — `WorldScene.TerrariumBase` cloned every material AND every
 * `material.map`, and `GLBAgent` cloned every material per agent. The habitat
 * picker in `IdentityTab` mounts ~9 `TerrariumBase` at once, so each visit to
 * that tab allocated (and abandoned) nine full sets of cloned Meshy textures.
 * Observed result: 8 GB → 13 GB of app memory inside a two-minute dev session.
 *
 * ─── The ownership rule ──────────────────────────────────────────────────────
 * Dispose ONLY what you allocated.
 *
 *   - `useGLTF` caches the loaded GLTF and hands the SAME scene object to every
 *     consumer. Its geometries, materials and textures belong to that cache.
 *     Disposing them breaks every other component using the model, and the
 *     model will not be reloaded because the cache still holds it.
 *   - `Object3D.clone()` / `SkeletonUtils.clone()` copy the node graph but keep
 *     geometry and material by REFERENCE. A clone owns nothing by itself.
 *   - `material.clone()` produces a material you own. Its `.map` and friends are
 *     still shared with the source material unless you cloned those too.
 *
 * Hence `disposeTextures` is opt-in per call site rather than a default.
 */

const TEXTURE_SLOTS = [
  "map",
  "lightMap",
  "aoMap",
  "emissiveMap",
  "bumpMap",
  "normalMap",
  "displacementMap",
  "roughnessMap",
  "metalnessMap",
  "alphaMap",
  "envMap",
  "specularMap",
  "gradientMap",
] as const;

export interface DisposeOptions {
  /**
   * Also dispose the textures bound to each material. Only pass `true` when the
   * call site cloned the textures itself (see `TerrariumBase`). Passing `true`
   * for materials whose maps came straight out of `useGLTF` will blank the model
   * everywhere it is used.
   */
  disposeTextures?: boolean;
}

/** Dispose a single material and, optionally, the textures it references. */
export function disposeMaterial(material: THREE.Material, options: DisposeOptions = {}): void {
  if (options.disposeTextures) {
    for (const slot of TEXTURE_SLOTS) {
      const texture = (material as unknown as Record<string, unknown>)[slot];
      if (texture instanceof THREE.Texture) {
        texture.dispose();
      }
    }
  }
  material.dispose();
}

/**
 * Walk a cloned subtree and dispose every material found on it.
 *
 * Geometry is deliberately left alone: both `Object3D.clone()` and
 * `SkeletonUtils.clone()` share geometry with the cached source model, so
 * disposing it here would corrupt the `useGLTF` cache.
 *
 * Safe to call more than once — three.js `dispose()` is idempotent — and safe on
 * `undefined`, so it can be used directly in a React cleanup without a guard.
 */
export function disposeClonedMaterials(
  root: THREE.Object3D | null | undefined,
  options: DisposeOptions = {},
): void {
  if (!root) return;

  const seen = new Set<THREE.Material>();
  root.traverse((node) => {
    const material = (node as THREE.Mesh).material;
    if (!material) return;

    const list = Array.isArray(material) ? material : [material];
    for (const entry of list) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      disposeMaterial(entry, options);
    }
  });
}

/**
 * Dispose a subtree the caller built from scratch — geometry included.
 *
 * Use this for procedurally generated meshes (`new THREE.BufferGeometry`,
 * `new THREE.MeshToonMaterial`, …), never for anything derived from `useGLTF`.
 */
export function disposeOwnedSubtree(
  root: THREE.Object3D | null | undefined,
  options: DisposeOptions = { disposeTextures: true },
): void {
  if (!root) return;

  const geometries = new Set<THREE.BufferGeometry>();
  root.traverse((node) => {
    const geometry = (node as THREE.Mesh).geometry;
    if (geometry) geometries.add(geometry);
  });

  disposeClonedMaterials(root, options);
  for (const geometry of geometries) {
    geometry.dispose();
  }
}

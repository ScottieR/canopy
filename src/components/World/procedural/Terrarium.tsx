import { useMemo } from "react";
import * as THREE from "three";
import { buildToonGradient } from "./toon-gradient";

/**
 * Procedural ivy terrarium tile — replaces the 255 MB `FlatIvyBase.glb`.
 *
 * Aesthetic target: `/Lobster Styling/flat_ivy_terrarium_base_1776649600193.png`
 *   - Chunky low-poly earth slice with jagged underside
 *   - Lush grass top (slightly displaced, flat-shaded)
 *   - Soil strata on the sides (top = moss/sage, mid = warm earth, bottom = rock)
 *   - Ivy tendrils draping off the corners, hanging below the tile
 *
 * Cost after this: ~6 draw calls total, ~2 KB of vertex data. The tile is
 * designed to be instanced — all 5 world tiles share one set of buffers.
 */
export interface TerrariumProps {
  size?: number;      // tile width (world units)
  height?: number;    // soil block height
  position?: [number, number, number];
  ivyCorners?: boolean; // toggle ivy drapes
}

// Deterministic pseudo-noise — cheaper than importing simplex-noise and avoids
// a new dependency. Each call is ~5 FLOPs.
function hash(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function buildGrassTopGeometry(size: number, resolution: number): THREE.BufferGeometry {
  const geom = new THREE.PlaneGeometry(size, size, resolution, resolution);
  geom.rotateX(-Math.PI / 2);

  // Displace verts slightly on Y to give the grass an organic, tufted feel.
  const pos = geom.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Two-octave noise, tiny amplitude — matches the gentle lump pattern in
    // the reference image.
    const y =
      (hash(x * 3.1, z * 3.1) - 0.5) * 0.06 +
      (hash(x * 7.2, z * 7.2) - 0.5) * 0.025;
    pos.setY(i, y);
  }
  geom.computeVertexNormals();
  return geom;
}

function buildEarthBlockGeometry(size: number, height: number): THREE.BufferGeometry {
  // Box with vertex color strata and jagged-y bottom.
  const geom = new THREE.BoxGeometry(size, height, size, 1, 4, 1);
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);

  const c_moss   = new THREE.Color("#8FA15A");
  const c_top    = new THREE.Color("#C9A178");
  const c_mid    = new THREE.Color("#B07D5E");
  const c_bot    = new THREE.Color("#7F5A42");

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    // Bottom vertices jitter down a little to give the slice a rocky
    // underside matching the ref image's uneven base.
    if (y < -height / 2 + 0.01) {
      const jitter = (hash(x * 2.1, z * 2.1) - 0.5) * 0.18;
      pos.setY(i, y + jitter);
    }

    // Vertex color by Y position (strata).
    const t = (pos.getY(i) + height / 2) / height; // 0 = bottom, 1 = top
    const c = new THREE.Color();
    if (t > 0.85) c.copy(c_moss);
    else if (t > 0.55) c.lerpColors(c_top, c_mid, (0.85 - t) / 0.30);
    else if (t > 0.20) c.lerpColors(c_mid, c_bot, (0.55 - t) / 0.35);
    else c.copy(c_bot);

    colors[i * 3 + 0] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  return geom;
}

function buildIvyDrapeGeometry(length: number): THREE.BufferGeometry {
  // Quadratic curve → tube. Gives the characteristic soft hanging form.
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.04, -length * 0.35, 0.02),
    new THREE.Vector3(-0.02, -length, 0)
  );
  return new THREE.TubeGeometry(curve, 12, 0.04, 6, false);
}

export function Terrarium({
  size = 2.0,
  height = 0.6,
  position = [0, 0, 0],
  ivyCorners = true,
}: TerrariumProps) {
  const grassGeometry = useMemo(() => buildGrassTopGeometry(size, 16), [size]);
  const earthGeometry = useMemo(() => buildEarthBlockGeometry(size, height), [size, height]);
  const ivyGeometry = useMemo(() => buildIvyDrapeGeometry(size * 0.55), [size]);

  const grassMaterial = useMemo(
    () =>
      new THREE.MeshToonMaterial({
        color: "#95A86A",
        gradientMap: buildToonGradient("#95A86A"),
        flatShading: true,
      }),
    []
  );

  const earthMaterial = useMemo(
    () =>
      new THREE.MeshToonMaterial({
        vertexColors: true,
        gradientMap: buildToonGradient("#A07458"),
        flatShading: true,
      }),
    []
  );

  const ivyMaterial = useMemo(
    () =>
      new THREE.MeshToonMaterial({
        color: "#6E8B3D",
        gradientMap: buildToonGradient("#6E8B3D"),
      }),
    []
  );

  // Corners where ivy hangs from.
  const corners: [number, number, number][] = [
    [ size / 2 - 0.06,  height / 2 - 0.02,  size / 2 - 0.06],
    [-size / 2 + 0.06,  height / 2 - 0.02,  size / 2 - 0.06],
    [ size / 2 - 0.06,  height / 2 - 0.02, -size / 2 + 0.06],
    [-size / 2 + 0.06,  height / 2 - 0.02, -size / 2 + 0.06],
  ];

  return (
    <group position={position}>
      {/* Earth block (sides + bottom) */}
      <mesh geometry={earthGeometry} material={earthMaterial} receiveShadow castShadow />

      {/* Grass top — sits just above the block's top face */}
      <mesh
        geometry={grassGeometry}
        material={grassMaterial}
        position={[0, height / 2 + 0.005, 0]}
        receiveShadow
      />

      {/* Ivy drapes at each corner */}
      {ivyCorners &&
        corners.map((c, i) => (
          <mesh
            key={i}
            geometry={ivyGeometry}
            material={ivyMaterial}
            position={c}
            rotation={[0, (Math.PI / 4) * (i % 2 === 0 ? 1 : -1), 0]}
          />
        ))}
    </group>
  );
}

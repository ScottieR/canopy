import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { buildToonGradient } from "./toon-gradient";

/**
 * Shared procedural lobster body. Every archetype renders this exact mesh —
 * only the `shellColor` / `accentColor` differ. This gives us guaranteed
 * aesthetic consistency across all 5 archetypes.
 *
 * Aesthetic targets (derived from /Lobster Styling/Base Lobster.png and
 * the Meshy PNGs in /public/agents):
 *  - Rounded, bell-shaped body, NOT a sharp cone
 *  - Visible tail segmentation (~7 rings) on the lower half
 *  - Smooth round head sitting directly on the body, no neck
 *  - Two swept-back antennae with bulbous tips
 *  - Soft "clay" shading via MeshToonMaterial + 3-step gradient map
 *
 * The model is ~400 triangles total. All geometry is memoized; materials are
 * keyed on color so they're shared across re-renders for the same archetype.
 */
export interface LobsterBodyProps {
  shellColor: string;
  accentColor?: string;
  /** enables tiny sin-wave antenna sway — STYLING.md § 8 */
  alive?: boolean;
  /** scalar multiplier; native height is ~0.95 world units */
  scale?: number;
}

// Canonical silhouette — derived from the reference PNGs. Points are (radius, y).
// Upper half = bell torso; lower half = segmented tail.
const SILHOUETTE_POINTS: [number, number][] = [
  // base (widest) - tail tip
  [0.06, 0.00],
  [0.13, 0.03],
  [0.17, 0.06],
  // tail segments - each ridge is a slight radius bump to read as segmentation
  [0.19, 0.09],   [0.215, 0.11], [0.20, 0.13],
  [0.225, 0.16],  [0.245, 0.18], [0.23, 0.20],
  [0.255, 0.23],  [0.275, 0.25], [0.26, 0.27],
  [0.285, 0.30],  [0.305, 0.32], [0.29, 0.34],
  // transition from tail to torso
  [0.30, 0.37],
  [0.305, 0.41],
  // torso bell — widest here
  [0.305, 0.46],
  [0.30, 0.52],
  [0.285, 0.58],
  [0.26, 0.64],
  // shoulder taper into head
  [0.22, 0.69],
  [0.17, 0.73],
  [0.12, 0.76],
  [0.08, 0.78],
  [0.00, 0.79],
];

const HEAD_Y = 0.86;
const HEAD_RADIUS = 0.13;

export function LobsterBody({
  shellColor,
  accentColor,
  alive = true,
  scale = 1,
}: LobsterBodyProps) {
  const groupRef = useRef<THREE.Group>(null);
  const leftAntennaRef = useRef<THREE.Group>(null);
  const rightAntennaRef = useRef<THREE.Group>(null);

  // Memoize the lathe geometry — computed once per mount.
  const bodyGeometry = useMemo(() => {
    const pts = SILHOUETTE_POINTS.map(([r, y]) => new THREE.Vector2(r, y));
    const geom = new THREE.LatheGeometry(pts, 24);
    geom.computeVertexNormals();
    return geom;
  }, []);

  // Shared materials per color. `buildToonGradient` returns a 3-pixel map,
  // so swapping archetypes is effectively free.
  const shellMat = useMemo(() => {
    const gradient = buildToonGradient(shellColor);
    return new THREE.MeshToonMaterial({
      color: shellColor,
      gradientMap: gradient,
    });
  }, [shellColor]);

  const headMat = useMemo(() => {
    // Head is slightly lighter than the shell (see reference art — head reads
    // as a softer tone than the body, not a different hue).
    const c = new THREE.Color(shellColor);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    const headColor = new THREE.Color().setHSL(hsl.h, hsl.s * 0.85, Math.min(0.88, hsl.l + 0.08));
    return new THREE.MeshToonMaterial({
      color: headColor,
      gradientMap: buildToonGradient(`#${headColor.getHexString()}`),
    });
  }, [shellColor]);

  const accentMat = useMemo(() => {
    const c = accentColor || shellColor;
    return new THREE.MeshToonMaterial({
      color: c,
      gradientMap: buildToonGradient(c),
    });
  }, [accentColor, shellColor]);

  const eyeMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: "#1a1512" }),
    []
  );

  // Subtle antenna sway (STYLING.md § 8 — sin(t * 1.5), throttled effectively
  // by r3f's frame rate).
  useFrame(({ clock }) => {
    if (!alive) return;
    const t = clock.getElapsedTime();
    const sway = Math.sin(t * 1.5) * 0.04;
    if (leftAntennaRef.current)  leftAntennaRef.current.rotation.z = 0.12 + sway;
    if (rightAntennaRef.current) rightAntennaRef.current.rotation.z = -0.12 - sway;
  });

  return (
    <group ref={groupRef} scale={scale}>
      {/* Torso + tail (single lathe) */}
      <mesh geometry={bodyGeometry} material={shellMat} castShadow receiveShadow />

      {/* Tail ring lines — 6 thin tori stacked on the lower half to read as
          segmentation. Sized slightly smaller than the lathe at each Y so
          they sit flush. */}
      {[0.08, 0.13, 0.18, 0.23, 0.28, 0.33].map((y, i) => {
        // Interpolate lathe radius at this Y.
        const silPt = SILHOUETTE_POINTS.find(([, sy]) => Math.abs(sy - y) < 0.04);
        const r = (silPt?.[0] ?? 0.22) * 0.98;
        return (
          <mesh key={i} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[r, 0.008, 4, 24]} />
            <primitive object={shellMat} attach="material" />
          </mesh>
        );
      })}

      {/* Head */}
      <mesh position={[0, HEAD_Y - 0.06, 0]} material={headMat}>
        <sphereGeometry args={[HEAD_RADIUS, 20, 16]} />
      </mesh>

      {/* Eyes — two tiny dark dots, matches the minimal eye style in ref art */}
      <mesh position={[ 0.055, HEAD_Y - 0.05, 0.115]} material={eyeMat}>
        <sphereGeometry args={[0.013, 8, 8]} />
      </mesh>
      <mesh position={[-0.055, HEAD_Y - 0.05, 0.115]} material={eyeMat}>
        <sphereGeometry args={[0.013, 8, 8]} />
      </mesh>

      {/* Left antenna */}
      <group ref={leftAntennaRef} position={[-0.05, HEAD_Y + 0.02, 0]}>
        <mesh position={[0, 0.1, 0]} rotation={[0, 0, 0.08]}>
          <cylinderGeometry args={[0.008, 0.012, 0.2, 8]} />
          <primitive object={headMat} attach="material" />
        </mesh>
        <mesh position={[-0.015, 0.21, 0]} material={accentMat}>
          <sphereGeometry args={[0.022, 10, 10]} />
        </mesh>
      </group>

      {/* Right antenna */}
      <group ref={rightAntennaRef} position={[0.05, HEAD_Y + 0.02, 0]}>
        <mesh position={[0, 0.1, 0]} rotation={[0, 0, -0.08]}>
          <cylinderGeometry args={[0.008, 0.012, 0.2, 8]} />
          <primitive object={headMat} attach="material" />
        </mesh>
        <mesh position={[0.015, 0.21, 0]} material={accentMat}>
          <sphereGeometry args={[0.022, 10, 10]} />
        </mesh>
      </group>

      {/* Left claw — arm cylinder + pincer sphere */}
      <group position={[-0.24, 0.55, 0.08]} rotation={[0.2, 0, -0.5]}>
        <mesh position={[-0.04, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.018, 0.022, 0.10, 8]} />
          <primitive object={shellMat} attach="material" />
        </mesh>
        <mesh position={[-0.10, 0, 0]}>
          <sphereGeometry args={[0.05, 12, 12]} />
          <primitive object={shellMat} attach="material" />
        </mesh>
      </group>

      {/* Right claw */}
      <group position={[0.24, 0.55, 0.08]} rotation={[0.2, 0, 0.5]}>
        <mesh position={[0.04, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.018, 0.022, 0.10, 8]} />
          <primitive object={shellMat} attach="material" />
        </mesh>
        <mesh position={[0.10, 0, 0]}>
          <sphereGeometry args={[0.05, 12, 12]} />
          <primitive object={shellMat} attach="material" />
        </mesh>
      </group>
    </group>
  );
}

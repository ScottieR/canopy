import { useMemo } from "react";
import * as THREE from "three";
import { LobsterBody } from "../LobsterBody";
import { buildToonGradient } from "../toon-gradient";

/**
 * Accountant lobster — POC for the GLB → Code hybrid strategy.
 *
 * Reference: /public/agents/Accountant.png
 *   - Peach/salmon body (peach is the universal base tone in the Meshy renders)
 *   - Green accountant visor on head
 *   - Purple ledger book held across the chest (left claw)
 *   - Beaded abacus to the right of the lobster
 *
 * Body is shared `<LobsterBody>`. Accessories are procedural low-poly props.
 * This file is the entire "Accountant asset" — replaces the 21 MB Accountant.glb.
 *
 * NOTE: `AGENT_TYPE_INFO.Accountant.robeColor` is `#8E9EAA` (slate blue), but
 * the Meshy reference PNGs render the body in peach. STYLING.md § 1 flags
 * Accountant as "warm peach/salmon". The POC sides with the canonical PNG
 * aesthetic — reconciling the color-data mismatch is a separate follow-up.
 */

// Aesthetic constants lifted from the reference PNG.
const BODY_COLOR    = "#D3916C"; // peach — matches Accountant.png body tone
const BODY_ACCENT   = "#E4A88A"; // claw/antenna tip highlight
const VISOR_GREEN   = "#B4D4A8"; // the mint green accountant visor brim
const VISOR_BAND    = "#D9E8D0"; // lighter band where the visor wraps
const BOOK_PURPLE   = "#A992C7"; // book cover
const BOOK_PAGES    = "#F4EFE6";
const ABACUS_FRAME  = "#F5ECE0";
const BEAD_COLORS   = ["#E7C59A", "#89B7C9", "#E69A9A"]; // warm + blue + red

export function AccountantAgent({
  scale = 1,
  position = [0, 0, 0],
}: {
  scale?: number;
  position?: [number, number, number];
}) {
  // Materials shared within this composition.
  const visorBrimMat = useMemo(
    () => new THREE.MeshToonMaterial({
      color: VISOR_GREEN,
      gradientMap: buildToonGradient(VISOR_GREEN),
    }),
    []
  );
  const visorBandMat = useMemo(
    () => new THREE.MeshToonMaterial({
      color: VISOR_BAND,
      gradientMap: buildToonGradient(VISOR_BAND),
    }),
    []
  );
  const bookCoverMat = useMemo(
    () => new THREE.MeshToonMaterial({
      color: BOOK_PURPLE,
      gradientMap: buildToonGradient(BOOK_PURPLE),
    }),
    []
  );
  const pagesMat = useMemo(
    () => new THREE.MeshToonMaterial({
      color: BOOK_PAGES,
      gradientMap: buildToonGradient(BOOK_PAGES),
    }),
    []
  );
  const frameMat = useMemo(
    () => new THREE.MeshToonMaterial({
      color: ABACUS_FRAME,
      gradientMap: buildToonGradient(ABACUS_FRAME),
    }),
    []
  );
  const beadMats = useMemo(
    () =>
      BEAD_COLORS.map(
        (c) => new THREE.MeshToonMaterial({ color: c, gradientMap: buildToonGradient(c) })
      ),
    []
  );

  return (
    <group position={position} scale={scale}>
      {/* Body */}
      <LobsterBody shellColor={BODY_COLOR} accentColor={BODY_ACCENT} />

      {/* Visor — a thin torus on the head plus a flat circular brim */}
      <group position={[0, 0.83, 0]}>
        <mesh position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.14, 0.018, 8, 24]} />
          <primitive object={visorBandMat} attach="material" />
        </mesh>
        {/* Brim — a half disk sweeping forward */}
        <mesh position={[0, -0.005, 0.11]} rotation={[-Math.PI / 2.6, 0, 0]}>
          <cylinderGeometry args={[0.17, 0.17, 0.015, 28, 1, false, -Math.PI / 2.2, Math.PI * 1.1]} />
          <primitive object={visorBrimMat} attach="material" />
        </mesh>
      </group>

      {/* Ledger book — held across the chest */}
      <group position={[0.02, 0.48, 0.21]} rotation={[-0.25, -0.25, 0.1]}>
        {/* cover */}
        <mesh>
          <boxGeometry args={[0.22, 0.18, 0.04]} />
          <primitive object={bookCoverMat} attach="material" />
        </mesh>
        {/* pages showing on the right edge */}
        <mesh position={[0.111, 0, 0]}>
          <boxGeometry args={[0.005, 0.16, 0.036]} />
          <primitive object={pagesMat} attach="material" />
        </mesh>
      </group>

      {/* Abacus — sits to the lobster's right, on the ground */}
      <group position={[0.42, 0.12, 0.15]} rotation={[0, -0.4, 0]}>
        {/* frame — 4 posts + top/bottom rails */}
        <mesh position={[0, 0.09, 0]}>
          <boxGeometry args={[0.26, 0.02, 0.04]} />
          <primitive object={frameMat} attach="material" />
        </mesh>
        <mesh position={[0, -0.09, 0]}>
          <boxGeometry args={[0.26, 0.02, 0.04]} />
          <primitive object={frameMat} attach="material" />
        </mesh>
        <mesh position={[-0.12, 0, 0]}>
          <boxGeometry args={[0.02, 0.18, 0.04]} />
          <primitive object={frameMat} attach="material" />
        </mesh>
        <mesh position={[0.12, 0, 0]}>
          <boxGeometry args={[0.02, 0.18, 0.04]} />
          <primitive object={frameMat} attach="material" />
        </mesh>
        {/* 3 rods with 5 beads each */}
        {[0.06, 0, -0.06].map((rowY, r) => (
          <group key={r} position={[0, rowY, 0]}>
            {/* rod */}
            <mesh rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.004, 0.004, 0.22, 6]} />
              <primitive object={frameMat} attach="material" />
            </mesh>
            {/* beads */}
            {[-0.08, -0.04, 0.0, 0.04, 0.08].map((x, i) => (
              <mesh key={i} position={[x, 0, 0]}>
                <sphereGeometry args={[0.018, 10, 8]} />
                <primitive
                  object={beadMats[(r + i) % beadMats.length]}
                  attach="material"
                />
              </mesh>
            ))}
          </group>
        ))}
      </group>
    </group>
  );
}

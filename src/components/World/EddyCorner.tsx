// ─── Eddy's corner — fixed, non-rotating home for The Keeper ─────────────────
// Per spec ("fixed bottom-left of world view, outside the rotatable canvas"):
// Eddy's reef cave renders in its own tiny static canvas pinned to the
// bottom-left of the Canopy view. It never rotates with the world, so Eddy is
// always visible and reachable no matter where the user has spun the camera —
// near the islands, but visually distinct from the roster.

import React from "react";
import { Canvas } from "@react-three/fiber";
import { OrthographicCamera } from "@react-three/drei";
import { EddyKeeper } from "./WorldScene";

export function EddyCorner() {
  const [hovered, setHovered] = React.useState(false);
  return (
    <div
      onClick={() => window.dispatchEvent(new CustomEvent("canopy:open-keeper"))}
      onMouseEnter={() => { setHovered(true); }}
      onMouseLeave={() => { setHovered(false); }}
      title="Eddy — your Canopy guide"
      style={{
        position: "absolute", bottom: 12, left: 8, width: 320, height: 320,
        zIndex: 10, cursor: "pointer",
        transition: "transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
        transform: hovered ? "translateY(-5px)" : "none",
      }}
    >
      <Canvas gl={{ antialias: true, alpha: true }} style={{ background: "transparent" }}>
        {/* Same isometric angle as the main world camera, just frozen */}
        <OrthographicCamera
          makeDefault
          position={[10, 10, 10]}
          zoom={54}
          near={0.1}
          far={100}
          onUpdate={(c) => c.lookAt(0, 0.2, 0)}
        />
        <ambientLight intensity={0.65} />
        <directionalLight position={[5, 5, 5]} intensity={1.1} />
        {/* 2x scale, turned 45° counter-clockwise so the cave mouth faces the
            viewer. Raised so the island base isn't clipped by the canvas edge. */}
        <group position={[0, 0.55, 0]} scale={2} rotation={[0, Math.PI / 4, 0]}>
          <EddyKeeper />
        </group>
      </Canvas>
      {hovered && (
        <div style={{
          position: "absolute", top: 6, left: "50%", transform: "translateX(-50%)",
          color: "white", background: "rgba(63,52,21,0.85)", padding: "4px 10px",
          borderRadius: 10, fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap",
          border: "1px solid rgba(212,168,67,0.4)", backdropFilter: "blur(8px)",
          pointerEvents: "none",
        }}>
          Eddy — ask me anything
        </div>
      )}
    </div>
  );
}

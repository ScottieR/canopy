import { Canvas } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import { Suspense } from "react";
import { AccountantAgent } from "./archetypes/Accountant";
import { Terrarium } from "./Terrarium";

/**
 * POC scene contents — Terrarium + Accountant + lights.
 *
 * This component renders ONLY the 3D contents. It's meant to be dropped
 * inside an existing <Canvas> (the way WorldScene is used) — NOT wrapped in
 * its own Canvas. If you nest Canvases, R3F will fail silently and the
 * parent UI goes blank.
 *
 * Usage (drop-in replacement for WorldScene):
 *   <Canvas ...>
 *     <POCScene />
 *   </Canvas>
 *
 * For a full-page standalone preview, use <POCSceneStandalone /> below.
 */
export function POCScene() {
  return (
    <>
      {/* Lights are inside the component so they match the POC's canonical
          upper-left shadow direction regardless of what the host Canvas
          configures. Harmless duplicates if the host also has lights. */}
      <hemisphereLight args={["#F5EEE8", "#B5A898", 0.5]} />
      <directionalLight
        position={[-6, 10, 4]}
        intensity={1.0}
        color="#FFF5E6"
      />

      <Suspense fallback={null}>
        <group position={[0, -0.3, 0]}>
          <Terrarium size={2.2} height={0.6} position={[0, 0, 0]} />
          <AccountantAgent scale={1.3} position={[0, 0.3, 0]} />
        </group>
      </Suspense>
    </>
  );
}

/**
 * Full-page standalone preview — mount this at the root if you want a
 * dedicated POC route. Has its own Canvas and camera. Do NOT put this
 * inside another Canvas.
 */
export function POCSceneStandalone() {
  return (
    <div style={{ width: "100%", height: "100vh", background: "#F0EBE3" }}>
      <Canvas shadows>
        <OrthographicCamera makeDefault position={[8, 8, 8]} zoom={110} />
        <OrbitControls enablePan={false} minZoom={60} maxZoom={200} />
        <POCScene />
      </Canvas>

      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          background: "rgba(255,255,255,0.85)",
          padding: "8px 14px",
          borderRadius: 8,
          fontSize: 12,
          fontFamily: "DM Sans, system-ui, sans-serif",
          color: "#2D3436",
          lineHeight: 1.4,
        }}
      >
        <strong>POC — Procedural Accountant + Terrarium</strong>
        <br />
        Payload: ~0 MB vs GLB path ~280 MB (Accountant.glb + FlatIvyBase.glb)
        <br />
        Reference: <code>/public/agents/Accountant.png</code>
      </div>
    </div>
  );
}

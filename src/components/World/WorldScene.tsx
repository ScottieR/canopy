import { useMemo } from "react";
import agentsData from "../../../../shared/agents.json";
import { AgentNeighborhood } from "./AgentNeighborhood";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import React from "react";

// Initiate early network fetching for high-priority onboarding assets so the 3D world loads instantly,
// avoiding the piecemeal "pop-in" effect as React mounts individual components.
useGLTF.preload("/models/lobsters/FlatIvyBase.opt.glb?v=sloppy-120k");
["Accountant", "Assistant", "Strategist", "Researcher", "Tutor"].forEach(role => {
  useGLTF.preload(`/models/lobsters/${role}.glb`);
});

function TerrariumBase() {
  // We rely on Drei's useGLTF because it deeply integrates with the preload cache defined above
  const { scene } = useGLTF("/models/lobsters/FlatIvyBase.opt.glb?v=sloppy-120k");

  // Clone the scene so we can instance it multiple times across the grid
  const clonedScene = useMemo(() => {
    const clone = scene.clone();
    clone.traverse((child: any) => {
      if (child.isMesh && child.material) {
        // Clone the material so it doesn't affect other instances if we decide to add hover states
        child.material = child.material.clone();
        child.material.metalness = 0.0;
        child.material.roughness = 0.9;
        // Apply a gentle emissive lift to brighten the artificially dark texture maps from Meshy
        // and tint it slightly toward the app's soft sage green/teal.
        child.material.emissive = new THREE.Color("#8EA676");
        child.material.emissiveIntensity = 0.25;
        child.material.needsUpdate = true;
      }
    });
    return clone;
  }, [scene]);

  return <primitive object={clonedScene} scale={1.8} position={[0, -0.2, 0]} />;
}

export function WorldScene() {
  // Hard code 5 agents that have Meshy models
  const selectedAgents = useMemo(() => {
    const keys = ["Accountant", "Assistant", "Strategist", "Researcher", "Tutor"];
    return keys.map((key) => {
      const agent = (agentsData as any)[key];
      return {
        ...agent,
        id: key, // ensure ID is the name for the file
        fileUrl: `/models/lobsters/${key}.glb`
      };
    });
  }, []);

  // Compute Ulam Spiral layout coordinates for the tiled surface
  const TILE_GAP = 2.3; // Space between tile centers

  // Mathematically derived from the GLB bounding box maximum Y vertex (0.9493)
  // Max Y in world space = (0.9493 * scale(1.8)) + positionY(-0.2) = ~1.508
  const LOBSTER_ELEVATION_OFFSET = 1.3; // Flush with the highest point of the grass

  const points = useMemo(() => {
    const pts = [];
    const N = selectedAgents.length;

    let x = 0;
    let z = 0;
    let dx = 0;
    let dz = -1;

    // Distribute tiles cleanly outward
    for (let i = 0; i < N; i++) {
      pts.push(new THREE.Vector3(x * TILE_GAP, 0, z * TILE_GAP));

      // Turn the spiral when we hit corners
      if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
        const temp = dx;
        dx = -dz;
        dz = temp;
      }
      x += dx;
      z += dz;
    }
    return pts;
  }, [selectedAgents.length]);

  return (
    <group position={[0, -0.5, 0]}>
      {/* Agents and their 1:1 Terrarium Tiles */}
      {selectedAgents.map((agent: any, index) => {
        const pos = points[index];

        return (
          <group key={agent.id || index} position={pos.toArray()}>
            {/* 
                   Tile the monolithic base out beneath each agent 
                */}
            <React.Suspense fallback={<mesh><cylinderGeometry args={[2, 2, 0.5, 32]} /><meshStandardMaterial color="#8EA676" /></mesh>}>
              <TerrariumBase />
            </React.Suspense>

            {/* 
                  Renders the agent directly on its personal soil tile.
                  We assume AgentNeighborhood handles state-driven animations for performance.
                */}
            <AgentNeighborhood
              agent={agent}
              position={[0, LOBSTER_ELEVATION_OFFSET, 0]}
            />
          </group>
        );
      })}
    </group>
  );
}

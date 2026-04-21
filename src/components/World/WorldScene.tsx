import { useMemo } from "react";
import agentsData from "../../../../shared/agents.json";
import { AgentNeighborhood } from "./AgentNeighborhood";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import React from "react";

// Initiate early network fetching for high-priority onboarding assets so the 3D world loads instantly,
// avoiding the piecemeal "pop-in" effect as React mounts individual components.
useGLTF.preload("/models/lobsters/FlatIvyBase.opt.glb?v=sloppy-120k");
["Accountant", "Assistant", "Strategist", "Researcher", "Tutor", "Coder"].forEach(role => {
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

export function WorldScene({ agents, onAgentClick, onAgentHover, hoveredAgentId }: { agents?: any[], onAgentClick?: (id: string) => void, onAgentHover?: (id: string | null) => void, hoveredAgentId?: string | null }) {
  // Use passed agents or fallback to the hardcoded demo set
  const selectedAgents = useMemo(() => {
    // These are the specific roles we physically possess GLB models for
    const knownGlbs = ["Accountant", "Assistant", "Strategist", "Researcher", "Tutor", "Coder"];
    
    if (agents && agents.length > 0) {
      return agents.map(agent => {
        const hasModel = knownGlbs.includes(agent.role);
        return {
          ...agent,
          fileUrl: agent.fileUrl || (hasModel ? `/models/lobsters/${agent.role}.glb` : null)
        };
      });
    }
    return knownGlbs.map((key) => {
      const agent = (agentsData as any)[key];
      return {
        ...agent,
        id: key, // ensure ID is the name for the file
        fileUrl: `/models/lobsters/${key}.glb`,
        status: "active"
      };
    });
  }, [agents]);

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
        const isHovered = hoveredAgentId === agent.id;

        return (
          <group key={agent.id || index} position={pos.toArray()}>
            {/* Hover Indicator Ring */}
            {isHovered && <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[1.2, 1.4, 32]} /><meshBasicMaterial color="#83C5BE" transparent opacity={0.6} /></mesh>}

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
              onClick={() => onAgentClick?.(agent.id)}
              onPointerOver={(e) => { e.stopPropagation(); onAgentHover?.(agent.id); document.body.style.cursor = 'pointer'; }}
              onPointerOut={() => { onAgentHover?.(null); document.body.style.cursor = 'default'; }}
            />
          </group>
        );
      })}
    </group>
  );
}

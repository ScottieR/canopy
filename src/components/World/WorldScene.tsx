import { useMemo } from "react";
import agentsData from "../../../../shared/agents.json";
import { AgentNeighborhood } from "./AgentNeighborhood";
import { OnboardingCompanion } from "./OnboardingCompanion";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import React from "react";

// Initiate early network fetching for high-priority onboarding assets so the 3D world loads instantly,
// avoiding the piecemeal "pop-in" effect as React mounts individual components.
[1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(i => {
  useGLTF.preload(`/models/habitats/Habitat_${i}.glb`);
});
["Accountant", "Assistant", "Strategist", "Researcher", "Tutor", "Coder"].forEach(role => {
  useGLTF.preload(`/models/lobsters/${role}.glb`);
});

export function TerrariumBase({ index = 0, habitatId, onNavMeshReady }: { index?: number, habitatId?: number, onNavMeshReady?: (points: THREE.Vector3[]) => void }) {
  const modelNum = habitatId || ((index % 9) + 1);
  const modelUrl = `/models/habitats/Habitat_${modelNum}.glb`;
  const { scene } = useGLTF(modelUrl);

  // Clone the scene so we can instance it multiple times across the grid
  const clonedScene = useMemo(() => {
    const clone = scene.clone();

    // --- AUTOMATIC NORMALIZATION ---
    // No matter what size the Meshy file was exported at, we measure it in true 3D space
    const box = new THREE.Box3().setFromObject(clone);
    const size = box.getSize(new THREE.Vector3());

    // 1. Force the X/Z footprint to be exactly 2.2 units wide to fit our TILE_GAP perfect grid
    const maxDim = Math.max(size.x, size.z);
    const targetScale = maxDim > 0 ? (2.2 / maxDim) : 1;
    clone.scale.set(targetScale, targetScale, targetScale);

    // CRITICAL: We must update the world matrix manually so the Laser Raycaster can "see" the new scale
    clone.updateMatrixWorld(true);

    // 2. PROCEDURAL FLOOR SNAPPING (The Magic Trick!)
    // We shoot a mathematical laser straight down from the sky at the exact center (0,0) of the island.
    // When it hits the grass, we record that physical height and push the entire island DOWN by that amount!
    // This perfectly anchors the top surface of ANY generated block to exactly Y=0, where Barnaby is standing!
    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(0, 50, 0), new THREE.Vector3(0, -1, 0));

    const intersects = raycaster.intersectObject(clone, true);
    if (intersects.length > 0) {
      const hitY = intersects[0].point.y;
      clone.position.y = -hitY; // Anchor top surface to 0!
    } else {
      // Fallback just in case the laser misses (e.g. there is a donut hole in the center of the grid)
      clone.position.y = -(box.max.y * targetScale);
    }

    // Re-update matrix after dropping the island
    clone.updateMatrixWorld(true);

    // --- 3. PROCEDURAL TOPOGRAPHY SCANNER ("Virtual Raindrops") ---
    // We shower the tile with 80 random vertical rays within a 0.8 unit radius 
    // to map out the flat, walkable surface area avoiding cliffs and obstacles.
    const navPoints: THREE.Vector3[] = [];
    const scanRay = new THREE.Raycaster();

    // Guarantee 0,0,0 is always available as a safe fallback
    navPoints.push(new THREE.Vector3(0, 0, 0));

    for (let i = 0; i < 80; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.8;
      const px = Math.cos(angle) * r;
      const pz = Math.sin(angle) * r;

      scanRay.set(new THREE.Vector3(px, 50, pz), new THREE.Vector3(0, -1, 0));
      const hits = scanRay.intersectObject(clone, true);
      if (hits.length > 0) {
        const hit = hits[0];
        // Check surface normal. if normal.y > 0.85, it is a flat, horizontal walkable plane.
        if (hit.face && hit.face.normal.y > 0.85) {
          // Because clone isn't in the global parent group yet, this world point 
          // is perfectly relative to the localized AgentNeighborhood root coords!
          navPoints.push(hit.point.clone());
        }
      }
    }

    if (onNavMeshReady && navPoints.length > 0) {
      // Defer React state update to avoid rendering cycle collisions
      setTimeout(() => onNavMeshReady(navPoints), 0);
    }

    clone.traverse((child: any) => {
      if (child.isMesh && child.material) {
        // Just like the Lobster, Meshy bakes stunning shadows/highlights directly into the tile's texture.
        // If we use standard lighting or emissive overlays, we wash out all the contrast and kill the pastels.
        // Swapping to an unlit BasicMaterial allows the pure image texture to render perfectly crisp.
        if (child.material.map) {
          const safeMap = child.material.map.clone();
          safeMap.needsUpdate = true;
          child.material = new THREE.MeshBasicMaterial({ map: safeMap });
        } else {
          // Fallback if texture map is missing
          if (Array.isArray(child.material)) {
             child.material = child.material.map(mat => {
                 const m = (mat as THREE.Material).clone();
                 if ('color' in m) (m as any).color.set("#A3C4BC");
                 if ('roughness' in m) (m as any).roughness = 0.9;
                 return m;
             });
          } else {
             child.material = child.material.clone();
             if (child.material.color) child.material.color.set("#A3C4BC");
             child.material.roughness = 0.9;
          }
        }
      }
    });
    return clone;
  }, [scene]);

  return <primitive object={clonedScene} />;
}

export function WorldScene({ agents, onAgentClick, onAgentHover, hoveredAgentId }: { agents?: any[], onAgentClick?: (id: string) => void, onAgentHover?: (id: string | null) => void, hoveredAgentId?: string | null }) {
  const [navMap, setNavMap] = React.useState<Record<number, THREE.Vector3[]>>({});
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
    
    // Fallback if no props are passed
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
  const TILE_GAP = 2; // Space between tile centers

  // We eliminated the hardcoded offset entirely via Procedural Floor Snapping
  // LOBSTER_ELEVATION_OFFSET is now officially 0.0

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
              <TerrariumBase index={index} habitatId={agent.visual_identity?.habitatId} onNavMeshReady={(pts) => setNavMap(prev => ({ ...prev, [index]: pts }))} />
            </React.Suspense>

            {/* 
                  Renders the agent directly on its personal soil tile.
                  Because the Tile uses Procedural Raycasting to sink itself until its top surface is exactly 0,
                  And the Lobster uses Normalization to rest its feet at exactly 0,
                  they flawlessly snap together on ANY 3D model geometry automatically!
                */}
            <AgentNeighborhood
              agent={agent}
              index={index}
              navPoints={navMap[index]}
              position={[0, 0, 0]}
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

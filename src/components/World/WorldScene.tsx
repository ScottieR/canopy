import { useMemo } from "react";
import agentsData from "../../../shared/agents.json";
import habitatsData from "../../../shared/habitats.json";
import { AgentNeighborhood } from "./AgentNeighborhood";
import { OnboardingCompanion } from "./OnboardingCompanion";
import { GLBAgent } from "./GLBAgent";
import { useGLTF, Html } from "@react-three/drei";
import * as THREE from "three";
import React from "react";
import { getAssetUrl } from "../../utils/assets";
import { disposeClonedMaterials } from "./disposal";

// Initiate early network fetching for high-priority onboarding assets so the 3D world loads instantly,
// avoiding the piecemeal "pop-in" effect as React mounts individual components.
[1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(i => {
  useGLTF.preload(getAssetUrl(`/models/habitats/Habitat_${i}.glb`));
});
["Accountant", "Assistant", "Strategist", "Researcher", "Tutor", "Coder"].forEach(role => {
  useGLTF.preload(getAssetUrl(`/models/lobsters/${role}.glb`));
});

export class HabitatErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: any) { console.warn("Failed to load habitat GLB:", err); }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

/**
 * Normalized habitat templates, keyed by resolved model URL.
 *
 * ⚠️  MEMORY: building a template clones every material AND every
 * `material.map` (see `buildHabitatTemplate`). three.js never GC's those — they
 * live until `.dispose()`. This work used to run per MOUNT, so the habitat picker
 * in IdentityTab (9 tiles) leaked nine sets of cloned Meshy textures every time
 * the tab was opened, and the main world leaked a set per tile per navigation.
 *
 * Now it runs at most once per habitat for the lifetime of the app: the template
 * owns the cloned materials/textures, and each mounted tile is a cheap
 * `template.clone()` that shares them by reference and therefore owns nothing to
 * clean up. Peak cost is bounded by the number of distinct habitats (~11) rather
 * than by how long the user browses.
 *
 * Do NOT render a template object directly — a three.js Object3D can only have
 * one parent, so two tiles of the same habitat would fight over it. Always clone.
 */
interface HabitatTemplate {
  object: THREE.Object3D;
  navPoints: THREE.Vector3[];
}

const habitatTemplates = new Map<string, HabitatTemplate>();

/** Test/teardown hook: release every cached habitat template. */
export function disposeHabitatTemplates(): void {
  for (const template of habitatTemplates.values()) {
    // `disposeTextures: true` is correct here and ONLY here: the template cloned
    // its own textures, so it owns them. The underlying useGLTF scene is untouched.
    disposeClonedMaterials(template.object, { disposeTextures: true });
  }
  habitatTemplates.clear();
}

function getHabitatTemplate(scene: THREE.Object3D, cacheKey: string): HabitatTemplate {
  const cached = habitatTemplates.get(cacheKey);
  if (cached) return cached;

  const template = buildHabitatTemplate(scene);
  habitatTemplates.set(cacheKey, template);
  return template;
}

export function TerrariumBase({ index = 0, habitatId, modelUrl, onNavMeshReady }: { index?: number, habitatId?: number, modelUrl?: string, onNavMeshReady?: (points: THREE.Vector3[]) => void }) {
  const modelNum = habitatId || ((index % 9) + 1);
  const finalModelUrl = modelUrl || `/models/habitats/Habitat_${modelNum}.glb`;
  const { scene } = useGLTF(getAssetUrl(finalModelUrl));
  const navPointsRef = React.useRef<THREE.Vector3[]>([]);

  // Normalize once per habitat (cached), then take a lightweight instance for
  // this mount. The instance shares geometry/materials with the template, so
  // unmounting it needs no disposal — there is nothing it owns.
  const template = useMemo(
    () => getHabitatTemplate(scene, finalModelUrl),
    [scene, finalModelUrl],
  );
  const clonedScene = useMemo(() => template.object.clone(), [template]);
  navPointsRef.current = template.navPoints;

  React.useEffect(() => {
    if (onNavMeshReady && navPointsRef.current.length > 0) {
      onNavMeshReady(navPointsRef.current);
    }
  }, [clonedScene, onNavMeshReady]);

  return <primitive object={clonedScene} />;
}

/**
 * Do the expensive one-time work for a habitat: normalize scale, snap the top
 * surface to Y=0, scan a walkable nav mesh, and swap in unlit materials.
 *
 * Called once per habitat URL via `getHabitatTemplate`.
 */
function buildHabitatTemplate(scene: THREE.Object3D): HabitatTemplate {
  const navPointsRef = { current: [] as THREE.Vector3[] };
  const clonedScene = (() => {
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
        // Since we anchored the floor to roughly Y=0, any hit point near Y=0 is ground level.
        // This avoids Blender's local-space face normal issues (where Y might actually be Z).
        if (hit.point.y > -0.5 && hit.point.y < 0.5) {
          navPoints.push(hit.point.clone());
        }
      }
    }

    navPointsRef.current = navPoints;

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
             child.material = child.material.map((mat: any) => {
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
  })();

  return { object: clonedScene, navPoints: navPointsRef.current };
}

export function ProjectForum({ space, position, onClick }: { space: any, position: THREE.Vector3, onClick: () => void }) {
  const meshRef = React.useRef<THREE.Group>(null);
  
  React.useEffect(() => {
    let animationId: number;
    const animate = () => {
      if (meshRef.current) {
        meshRef.current.rotation.y += 0.005;
      }
      animationId = requestAnimationFrame(animate);
    };
    animate();
    return () => cancelAnimationFrame(animationId);
  }, []);

  return (
    <group position={position} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {/* Use a larger Meshy habitat (e.g. 8) to act as the collaborative island */}
      <group scale={1.5}>
        <HabitatErrorBoundary fallback={<mesh><cylinderGeometry args={[2, 2, 0.5, 32]} /><meshStandardMaterial color="#8EA676" /></mesh>}>
          <React.Suspense fallback={<mesh><cylinderGeometry args={[2, 2, 0.5, 32]} /><meshStandardMaterial color="#8EA676" /></mesh>}>
            <TerrariumBase index={8} habitatId={8} />
          </React.Suspense>
        </HabitatErrorBoundary>
      </group>

      {/* Subtle Holographic Core indicator */}
      <group position={[0, 1.8, 0]} ref={meshRef}>
        <mesh>
          <octahedronGeometry args={[0.5]} />
          <meshBasicMaterial color="#83C5BE" wireframe transparent opacity={0.4} />
        </mesh>
      </group>

      {/* Floating title */}
      <Html position={[0, 3.2, 0]} center>
         <div style={{ cursor: "pointer", color: "white", background: "rgba(30,50,48,0.8)", padding: "6px 12px", borderRadius: 12, fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", border: "1px solid rgba(131, 197, 190, 0.3)", backdropFilter: "blur(8px)", boxShadow: "0 8px 32px rgba(0,0,0,0.3)" }}>
           {space.title}
         </div>
      </Html>
    </group>
  );
}

// ─── The Keeper (Eddy) — golden lobster at the reef cave ─────────────────────
// Spec: spec-helper-agent-and-orchestrator.md "Eddy's 3D Assets". Habitat is
// Habitat_Eddy.glb (id 11, isEddyHabitat — surfboard baked in); the character
// goes through GLBAgent — the exact same pipeline, scale (0.25), and color
// override system as every user agent, so Eddy can never drift out of scale.
// Rendered in its own fixed, non-rotating corner canvas (EddyCorner in
// KeeperPanel.tsx), not inside the rotatable world.
useGLTF.preload(getAssetUrl("/models/habitats/Habitat_Eddy.glb"));

const EDDY_SHELL = "#D4A843";
const EDDY_ACCENT = "#E8C060";

export function EddyKeeper({ position }: { position?: THREE.Vector3 }) {
  return (
    <group position={position ? position.toArray() : [0, 0, 0]}>
      <HabitatErrorBoundary fallback={<mesh><cylinderGeometry args={[1, 1, 0.4, 32]} /><meshStandardMaterial color="#4AADBE" /></mesh>}>
        <React.Suspense fallback={<mesh><cylinderGeometry args={[1, 1, 0.4, 32]} /><meshStandardMaterial color="#4AADBE" /></mesh>}>
          <TerrariumBase habitatId={11} modelUrl="/models/habitats/Habitat_Eddy.glb" />
        </React.Suspense>
      </HabitatErrorBoundary>

      {/* Eddy at the cave mouth — same component, scale, and floor convention
          as user agents (GLBAgent normalizes BaseLobsterRigged internally). */}
      <group position={[-0.1, 0, -0.2]} rotation={[0, -0.3, 0]}>
        <React.Suspense fallback={null}>
          <GLBAgent
            scale={0.25}
            baseColor={EDDY_SHELL}
            robeColor={EDDY_SHELL}
            accentColor={EDDY_ACCENT}
            agentStatus="active"
          />
        </React.Suspense>
      </group>
    </group>
  );
}

export function WorldScene({
  agents, 
  onAgentClick, 
  onAgentHover, 
  hoveredAgentId,
  isEditMode,
  transformMode,
  selectedEditAgent,
  editTransforms,
  onTransformChange
}: { 
  agents?: any[], 
  onAgentClick?: (id: string) => void, 
  onAgentHover?: (id: string | null) => void, 
  hoveredAgentId?: string | null,
  isEditMode?: boolean,
  transformMode?: "translate" | "rotate",
  selectedEditAgent?: string | null,
  editTransforms?: Record<string, any>,
  onTransformChange?: (id: string, transform: any) => void
}) {
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

  const projectSpaces = useMemo(() => {
    const spaces = new Map<string, any>();
    if (!agents) return [];
    agents.forEach(agent => {
      agent.conversations?.forEach((c: any) => {
        if (c.type === "project") {
          if (!spaces.has(c.id)) spaces.set(c.id, { ...c, participants: [] });
          if (!spaces.get(c.id).participants.includes(agent.id)) {
            spaces.get(c.id).participants.push(agent.id);
          }
        }
      });
    });
    return Array.from(spaces.values());
  }, [agents]);

  const forumPoints = useMemo(() => {
    // Place forums in an arc or row behind the islands. 
    // Z = -12 to keep them distinct from the spiral.
    return projectSpaces.map((_, i) => new THREE.Vector3((i - Math.floor(projectSpaces.length / 2)) * 10, 0, -12));
  }, [projectSpaces.length]);

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
      {/* Render Project Forums */}
      {projectSpaces.map((space: any, i) => (
        <ProjectForum 
          key={space.id} 
          space={space} 
          position={forumPoints[i]} 
          onClick={() => {
            // Focus on the first participant to jump to the space context
            if (space.participants.length > 0 && onAgentClick) {
              onAgentClick(space.participants[0]);
            }
          }}
        />
      ))}

      {/* Agents and their 1:1 Terrarium Tiles */}
      {selectedAgents.map((agent: any, index) => {
        const isHovered = hoveredAgentId === agent.id;
        const isSelectedForEdit = isEditMode && selectedEditAgent === agent.id;
        const t = editTransforms?.[agent.id] || agent.visual_identity?.habitatTransform;
        
        const basePath = points[index];
        const initPos = t ? new THREE.Vector3(t.x, t.y, t.z) : basePath;
        const initRotY = t?.rotationY || 0;

        let agentPos = initPos;
        let agentRotY = initRotY;
        let isAtForum = false;

        // Animate agent walking to the forum if they are active in it
        if (agent.activeConversationId) {
          const spaceIdx = projectSpaces.findIndex(s => s.id === agent.activeConversationId);
          if (spaceIdx >= 0) {
             const forumPos = forumPoints[spaceIdx];
             const pIdx = projectSpaces[spaceIdx].participants.indexOf(agent.id);
             const totalP = projectSpaces[spaceIdx].participants.length;
             // Form a circle around the table
             const angle = (pIdx / Math.max(1, totalP)) * Math.PI * 2;
             const radius = 2.2;
             agentPos = new THREE.Vector3(
                forumPos.x + Math.cos(angle) * radius,
                forumPos.y,
                forumPos.z + Math.sin(angle) * radius
             );
             // Look at the center of the table
             agentRotY = -Math.atan2(agentPos.z - forumPos.z, agentPos.x - forumPos.x) - Math.PI / 2;
             isAtForum = true;
          }
        }

        return (
          <group key={agent.id || index}>
            {/* The Island / Habitat Base remains at its layout position */}
            <group 
              position={initPos.toArray()} 
              rotation={[0, initRotY, 0]}
              onClick={(e) => {
                if (isEditMode) {
                  e.stopPropagation();
                  onAgentClick?.(agent.id);
                }
              }}
            >
              {isSelectedForEdit && <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[1.2, 1.4, 32]} /><meshBasicMaterial color="#D4A373" transparent opacity={0.9} /></mesh>}

              <HabitatErrorBoundary fallback={<mesh><cylinderGeometry args={[2, 2, 0.5, 32]} /><meshStandardMaterial color="#8EA676" /></mesh>}>
                <React.Suspense fallback={<mesh><cylinderGeometry args={[2, 2, 0.5, 32]} /><meshStandardMaterial color="#8EA676" /></mesh>}>
                  <TerrariumBase index={index} habitatId={agent.visual_identity?.habitatId} onNavMeshReady={(pts) => setNavMap(prev => ({ ...prev, [index]: pts }))} />
                </React.Suspense>
              </HabitatErrorBoundary>
              
              {isAtForum && (
                <AgentNeighborhood
                  agent={agent}
                  index={index}
                  navPoints={navMap[index]}
                  position={[0, 0, 0]}
                  hideAgent={true}
                />
              )}
            </group>

            {/* The Agent Lobster moves dynamically */}
            <group 
              position={agentPos.toArray()} 
              rotation={[0, agentRotY, 0]}
            >
              {isHovered && !isSelectedForEdit && <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[1.2, 1.4, 32]} /><meshBasicMaterial color="#83C5BE" transparent opacity={0.6} /></mesh>}

              <AgentNeighborhood
                agent={agent}
                index={index}
                navPoints={navMap[index]}
                position={[0, 0, 0]}
                onClick={() => onAgentClick?.(agent.id)}
                onPointerOver={(e) => { e.stopPropagation(); onAgentHover?.(agent.id); document.body.style.cursor = 'pointer'; }}
                onPointerOut={() => { onAgentHover?.(null); document.body.style.cursor = 'default'; }}
                hideDecor={isAtForum}
              />
            </group>
          </group>
        );
      })}
    </group>
  );
}

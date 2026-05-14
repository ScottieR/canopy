import { GLBAgent, GLBModel } from "./GLBAgent";
import React, { useMemo } from "react";
import accessoriesData from "../../../../shared/accessories.json";
import habitatsData from "../../../../shared/habitats.json";
import * as THREE from "three";

// Admin's HabitatPlacementScene paints decor points with the habitat scaled
// `(2.2 / maxDim) * 2` for ergonomics. The runtime habitat (TerrariumBase) uses
// `2.2 / maxDim` — half the admin scale — so painted decor coordinates need to
// be halved when applied here. Keep this in sync with IdentityTab.tsx.
const ADMIN_TO_MAIN_DECOR_SCALE = 0.5;

// Use a saved transform's position only when the user has explicitly set it
// (not just when the object key happens to exist). `transforms.x || 0` would
// silently treat undefined as 0 and override auto-snap with the world origin.
const hasSavedDecorPosition = (t: any) =>
  !!t && t.x !== undefined && t.y !== undefined && t.z !== undefined;

export function AgentNeighborhood({ agent, index = 0, navPoints, position = [0, 0, 0], onClick, onPointerOver, onPointerOut }: { agent?: any, index?: number, navPoints?: THREE.Vector3[], position?: [number, number, number], onClick?: () => void, onPointerOver?: (e: any) => void, onPointerOut?: () => void }) {
  const isWorking = agent?.status === "active" || agent?.status === "thinking";

  // Decor items are saved by IdentityTab to `visual_identity.decor` (a dedicated
  // array), which is the canonical source. We also keep a backward-compat path
  // for any agents whose data was written under the older single-`accessories`
  // model with an `accessoryBehaviors` map — those entries get merged in and
  // de-duplicated so they keep rendering after the schema change.
  const decorItems = useMemo(() => {
    const dedicated: string[] = agent?.visual_identity?.decor || [];

    const legacyList: string[] = agent?.visual_identity?.accessories || agent?.accessories || [];
    const legacyBehaviors = agent?.visual_identity?.accessoryBehaviors || {};
    const legacyDecor = legacyList.filter((path: string) => {
      const accInfo = (accessoriesData.items as any)[path];
      const behavior = legacyBehaviors[path] || accInfo?.type;
      return behavior === 'decor';
    });

    return Array.from(new Set([...dedicated, ...legacyDecor]));
  }, [agent]);

  // Seeded random helper so decor stays in the same random spot across renders if no transform is saved
  const seededRandom = (seed: number) => {
    let x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  };

  const habitatData = (habitatsData as any[]).find(h => h.id === agent?.visual_identity?.habitatId);
  // Decor MUST be anchored to the per-habitat decor points the user painted in
  // the admin app. Only fall through to navPoints when there are literally no
  // painted points for this habitat — otherwise we'd ignore the user's intent.
  const validDecorPoints = (habitatData?.decorPoints && habitatData.decorPoints.length > 0)
    ? habitatData.decorPoints
    : (navPoints || []);

  // Pre-compute decor positions (used by the lobster nav-grid so the lobster
  // doesn't walk through decor). These are in the runtime/main-app frame.
  const placedDecorPositions = useMemo(() => {
    return decorItems.map((path: string, i: number) => {
      const transforms = agent?.visual_identity?.decorTransforms?.[path];
      if (hasSavedDecorPosition(transforms)) {
        return new THREE.Vector3(transforms.x, transforms.y, transforms.z);
      } else if (validDecorPoints && validDecorPoints.length > 0) {
        const seed = (agent?.id?.length || 0) + i;
        const pointIndex = Math.floor(seededRandom(seed) * validDecorPoints.length);
        const p = validDecorPoints[pointIndex];
        // navPoints are already in the runtime frame; painted decorPoints come
        // from the admin's 2x frame and need rescaling.
        const usingPainted = habitatData?.decorPoints && habitatData.decorPoints.length > 0;
        const k = usingPainted ? ADMIN_TO_MAIN_DECOR_SCALE : 1;
        return new THREE.Vector3(p.x * k, p.y * k, p.z * k);
      }
      return new THREE.Vector3(0, 0, 0);
    });
  }, [decorItems, agent, validDecorPoints, habitatData]);

  const filteredNavPoints = useMemo(() => {
    if (!navPoints) return undefined;
    return navPoints.filter(p => {
      // Don't let the lobster walk within 0.35 units of the center of a decor item
      return !placedDecorPositions.some(dp => p.distanceTo(dp) < 0.35);
    });
  }, [navPoints, placedDecorPositions]);

  return (
    <group 
      position={position}
      onClick={onClick}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      {/* The Agent (which now includes its own generated Meshy habitat) */}
      {agent && (
        <GLBAgent 
          fileUrl={agent.visual_identity?.baseModelUrl || agent.fileUrl}
          role={agent.role}
          accessories={agent.visual_identity?.accessories || []}
          accessoryBehaviors={agent.visual_identity?.accessoryBehaviors || {}}
          position={
            index === 0 && habitatData?.placement 
              ? [habitatData.placement.x, habitatData.placement.y, habitatData.placement.z] 
              : [0, 0, 0]
          } 
          rotationY={index === 0 && habitatData?.placement ? habitatData.placement.rotationY : 0} 
          navPoints={filteredNavPoints}
          scale={0.25} 
          isWorking={isWorking} 
          agentStatus={agent?.status}
          baseColor={agent.color || "#D2D6CE"}
          robeColor={agent.visual_identity?.color || agent.color || agent.robeColor || "#A3C4BC"}
          accentColor={agent.visual_identity?.color || agent.accentColor || "#FFAB91"}
        />
      )}

      {/* Render Decor items */}
      {decorItems.map((path: string, i: number) => {
        const itemData = (accessoriesData.items as any)[path];
        const transforms = agent?.visual_identity?.decorTransforms?.[path];

        // Position: explicit user-saved position wins; otherwise we use the
        // pre-computed snapped position (already rescaled for the runtime frame).
        const p = placedDecorPositions[i];
        const decorPos: [number, number, number] = hasSavedDecorPosition(transforms)
          ? [transforms.x, transforms.y, transforms.z]
          : [p.x, p.y, p.z];

        // Rotation: catalog `decorRotation` is the upright-display pose authored
        // in AccessoryManager. Use it as the base so models that exported with a
        // non-Y-up axis stand correctly. If the user explicitly rotated this item,
        // their value wins per-axis. If neither is set, default to upright with a
        // deterministic random yaw.
        const seed = (agent?.id?.length || 0) + i;
        const baseDecorRot: [number, number, number] = itemData?.decorRotation
          ? itemData.decorRotation
          : [0, seededRandom(seed + 1) * Math.PI * 2, 0];

        const decorRot: [number, number, number] = [
          transforms?.rotationX !== undefined ? transforms.rotationX : baseDecorRot[0],
          transforms?.rotationY !== undefined ? transforms.rotationY : baseDecorRot[1],
          transforms?.rotationZ !== undefined ? transforms.rotationZ : baseDecorRot[2],
        ];

        const decorScale = (transforms?.scale !== undefined ? transforms.scale : itemData?.scale) || 75;

        const glbPath = path.startsWith('http') ? path : path.replace('.png', '.glb');

        return (
          <group key={path} position={decorPos} rotation={decorRot} scale={decorScale * 0.01 * 0.25}>
             <React.Suspense fallback={null}>
               <GLBModel url={glbPath} />
             </React.Suspense>
          </group>
        );
      })}
    </group>
  );
}

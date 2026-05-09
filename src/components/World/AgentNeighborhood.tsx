import { GLBAgent, GLBModel } from "./GLBAgent";
import React, { useMemo } from "react";
import accessoriesData from "../../../../shared/accessories.json";
import habitatsData from "../../../../shared/habitats.json";
import * as THREE from "three";

export function AgentNeighborhood({ agent, index = 0, navPoints, position = [0, 0, 0], onClick, onPointerOver, onPointerOut }: { agent?: any, index?: number, navPoints?: THREE.Vector3[], position?: [number, number, number], onClick?: () => void, onPointerOver?: (e: any) => void, onPointerOut?: () => void }) {
  const isWorking = agent?.status === "active" || agent?.status === "thinking";

  // Filter for Decor or Both (based on per-agent behavior setting)
  const decorItems = useMemo(() => {
    const list = agent?.visual_identity?.accessories || agent?.accessories || [];
    const behaviors = agent?.visual_identity?.accessoryBehaviors || {};
    return list.filter((path: string) => {
      const accInfo = (accessoriesData.items as any)[path];
      const behavior = behaviors[path] || accInfo?.type || 'accessory';
      return behavior === 'decor';
    });
  }, [agent]);

  // Seeded random helper so decor stays in the same random spot across renders if no transform is saved
  const seededRandom = (seed: number) => {
    let x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  };

  const habitatData = (habitatsData as any[]).find(h => h.id === agent?.visual_identity?.habitatId);
  const validDecorPoints = habitatData?.decorPoints || navPoints || [];

  // Pre-compute decor positions to avoid lobster overlapping them
  const placedDecorPositions = useMemo(() => {
    return decorItems.map((path: string, i: number) => {
      const transforms = agent?.visual_identity?.decorTransforms?.[path];
      if (transforms) {
        return new THREE.Vector3(transforms.x || 0, transforms.y || 0, transforms.z || 0);
      } else if (validDecorPoints && validDecorPoints.length > 0) {
        const seed = (agent?.id?.length || 0) + i;
        const pointIndex = Math.floor(seededRandom(seed) * validDecorPoints.length);
        const p = validDecorPoints[pointIndex];
        return new THREE.Vector3(p.x, p.y, p.z);
      }
      return new THREE.Vector3(0, 0, 0);
    });
  }, [decorItems, agent, validDecorPoints]);

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
        
        let decorPos = [0, 0, 0];
        let decorRot = [0, 0, 0];
        let decorScale = itemData?.scale || 75;

        if (transforms) {
          decorPos = [transforms.x || 0, transforms.y || 0, transforms.z || 0];
          decorRot = [transforms.rotationX || 0, transforms.rotationY || 0, transforms.rotationZ || 0];
          decorScale = transforms.scale || itemData?.scale || 75;
        } else {
          const p = placedDecorPositions[i];
          const seed = (agent?.id?.length || 0) + i;
          decorPos = [p.x, p.y, p.z];
          decorRot = [0, seededRandom(seed + 1) * Math.PI * 2, 0]; // Random Y rotation
        }

        const glbPath = path.startsWith('http') ? path : `http://localhost:3001${path.replace('.png', '.glb')}`;
        
        return (
          <group key={path} position={decorPos as any} rotation={decorRot as any} scale={decorScale * 0.01 * 0.25}>
             <React.Suspense fallback={null}>
               <GLBModel url={glbPath} />
             </React.Suspense>
          </group>
        );
      })}
    </group>
  );
}

import { GLBAgent, GLBModel } from "./GLBAgent";
import { useMemo } from "react";
import accessoriesData from "../../../../shared/accessories.json";
import * as THREE from "three";

export function AgentNeighborhood({ agent, index = 0, navPoints, position = [0, 0, 0], onClick, onPointerOver, onPointerOut }: { agent?: any, index?: number, navPoints?: THREE.Vector3[], position?: [number, number, number], onClick?: () => void, onPointerOver?: (e: any) => void, onPointerOut?: () => void }) {
  const isWorking = agent?.status === "active" || agent?.status === "thinking";

  // Filter for Decor or Both
  const decorItems = useMemo(() => {
    const list = agent?.visual_identity?.accessories || agent?.accessories || [];
    return list.filter((path: string) => {
      const accInfo = (accessoriesData.items as any)[path];
      return accInfo && (accInfo.type === 'decor' || accInfo.type === 'both');
    });
  }, [agent]);

  // Seeded random helper so decor stays in the same random spot across renders if no transform is saved
  const seededRandom = (seed: number) => {
    let x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  };

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
          position={index === 0 ? [0.65, -0.23, 0.2] : [0, 0, 0]} 
          navPoints={navPoints}
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
        const transforms = agent?.visual_identity?.decorTransforms?.[path];
        
        let decorPos = [0, 0, 0];
        let decorRot = [0, 0, 0];
        let decorScale = 0.5;

        // Apply saved transforms or calculate random fallback
        if (transforms) {
          decorPos = [transforms.x || 0, transforms.y || 0, transforms.z || 0];
          decorRot = [transforms.rotationX || 0, transforms.rotationY || 0, transforms.rotationZ || 0];
          decorScale = transforms.scale || 0.5;
        } else if (navPoints && navPoints.length > 0) {
          // Use a deterministic "random" point based on the agent's ID string length + item index
          const seed = (agent?.id?.length || 0) + i;
          const pointIndex = Math.floor(seededRandom(seed) * navPoints.length);
          const p = navPoints[pointIndex];
          decorPos = [p.x, p.y, p.z];
          decorRot = [0, seededRandom(seed + 1) * Math.PI * 2, 0]; // Random Y rotation
        }

        const glbPath = path.startsWith('http') ? path : `http://localhost:3001${path.replace('.png', '.glb')}`;
        
        return (
          <group key={path} position={decorPos as any} rotation={decorRot as any} scale={decorScale}>
             <React.Suspense fallback={null}>
               <GLBModel url={glbPath} />
             </React.Suspense>
          </group>
        );
      })}
    </group>
  );
}

import { GLBAgent } from "./GLBAgent";
import { useMemo } from "react";

import * as THREE from "three";

export function AgentNeighborhood({ agent, index = 0, navPoints, position = [0, 0, 0], onClick, onPointerOver, onPointerOut }: { agent?: any, index?: number, navPoints?: THREE.Vector3[], position?: [number, number, number], onClick?: () => void, onPointerOver?: (e: any) => void, onPointerOut?: () => void }) {
  const isWorking = agent?.status === "active" || agent?.status === "thinking";

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
          fileUrl={agent.fileUrl}
          role={agent.role}
          position={index === 0 ? [0.65, -0.23, 0.2] : [0, 0, 0]} 
          navPoints={navPoints}
          scale={0.25} 
          isWorking={isWorking} 
          agentStatus={agent?.status}
          baseColor={agent.color || "#D2D6CE"}
          robeColor={agent.robeColor || "#A3C4BC"}
          accentColor={agent.accentColor || "#FFAB91"}
        />
      )}
    </group>
  );
}

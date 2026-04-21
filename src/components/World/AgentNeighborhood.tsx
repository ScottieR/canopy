import { GLBAgent } from "./GLBAgent";
import { useMemo } from "react";

export function AgentNeighborhood({ agent, position = [0, 0, 0], onClick, onPointerOver, onPointerOut }: { agent?: any, position?: [number, number, number], onClick?: () => void, onPointerOver?: (e: any) => void, onPointerOut?: () => void }) {
  const isWorking = agent?.status === "active";

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
          position={[0, 0, 0]} 
          scale={1.3} 
          isWorking={isWorking} 
          baseColor={agent.color || "#D2D6CE"}
          robeColor={agent.robeColor || "#A3C4BC"}
          accentColor={agent.accentColor || "#FFAB91"}
        />
      )}
    </group>
  );
}

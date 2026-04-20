import { GLBAgent } from "./GLBAgent";
import { useMemo } from "react";

export function AgentNeighborhood({ agent, position = [0, 0, 0] }: { agent?: any, position?: [number, number, number] }) {
  return (
    <group position={position}>
      {/* The Agent (which now includes its own generated Meshy habitat) */}
      {agent && (
        <GLBAgent 
          fileUrl={agent.fileUrl}
          position={[0, 0, 0]} 
          scale={1.3} 
          isWorking={true} 
          baseColor={agent.color || "#D2D6CE"}
          robeColor={agent.robeColor || "#A3C4BC"}
          accentColor={agent.accentColor || "#FFAB91"}
        />
      )}
    </group>
  );
}

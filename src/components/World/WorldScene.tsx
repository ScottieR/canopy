import { useMemo } from "react";
import agentsData from "../../../../shared/agents.json";
import { AgentNeighborhood } from "./AgentNeighborhood";

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

  // Monument Valley isometric layout coordinates
  const positions: [number, number, number][] = [
    [-3.0, 0, 1.5],   // Front-Left
    [2.8, 0.4, -2.8], // Back-Right (slightly higher)
    [3.2, -0.2, 2.0], // Front-Right (slightly lower)
    [-1.2, 0.6, 4.0], // Front-Center (elevated)
    [0, 0, 0],        // Center
  ];

  return (
    <group position={[0, -1, 0]}>
      {selectedAgents.map((agent: any, index) => (
        <AgentNeighborhood 
          key={agent.id || index}
          agent={agent} 
          position={positions[Math.min(index, positions.length - 1)]} 
        />
      ))}
    </group>
  );
}

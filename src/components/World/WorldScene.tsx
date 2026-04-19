import { useMemo } from "react";
import { AccountantsLabyrinth } from "./AccountantsLabyrinth";
import { ExecutiveMonolith } from "./ExecutiveMonolith";
import { EducatorsForum } from "./EducatorsForum";
import { KidsPlayScape } from "./KidsPlayScape";
import agentsData from "../../../../shared/agents.json";
import { GLBAgent } from "./GLBAgent";

// Center Plaza for the 5th agent
function CenterPlaza({ agent }: { agent: any }) {
  return (
    <group position={[0, 0, 0]}>
      {/* Stepped platform */}
      <mesh position={[0, 0.4, 0]}>
        <boxGeometry args={[3.5, 0.8, 3.5]} />
        <meshStandardMaterial color="#E8C4A2" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.9, 0]}>
        <boxGeometry args={[2, 0.2, 2]} />
        <meshStandardMaterial color="#D5A986" roughness={0.9} />
      </mesh>
      {agent && (
        <GLBAgent 
          position={[0, 1.0, 0]} 
          scale={1.4} 
          isWorking={true}
          baseColor={agent.color} 
          robeColor={agent.robeColor} 
          accentColor={agent.accentColor} 
        />
      )}
    </group>
  );
}

export function WorldScene() {
  // Randomly select 5 agents
  const selectedAgents = useMemo(() => {
    const allAgents = Object.values(agentsData).filter((a: any) => a.color);
    const shuffled = [...allAgents].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, 5);
  }, []);

  return (
    <group position={[0, -1, 0]}>
      {/* The massive floating island base - strict isometric box */}
      <mesh position={[0, -2, 0]}>
        <boxGeometry args={[12, 4, 12]} />
        <meshStandardMaterial color="#8AB1A8" roughness={0.9} />
      </mesh>

      {/* Center Plaza */}
      <CenterPlaza agent={selectedAgents[4]} />

      {/* The Labyrinth Biome (Left) */}
      <group position={[-3.5, 0, 1]}>
        <AccountantsLabyrinth agent={selectedAgents[0]} />
      </group>

      {/* The Executive Monolith (Back Right) */}
      <group position={[1.5, 0, -3.5]}>
        <ExecutiveMonolith agent={selectedAgents[1]} />
      </group>

      {/* The Educator's Forum (Right Front) */}
      <group position={[3.5, 0, 1.5]}>
        <EducatorsForum agent={selectedAgents[2]} />
      </group>

      {/* The Kid's Play-Scape (Front Left) */}
      <group position={[-1.5, 0, 3.5]}>
        <KidsPlayScape agent={selectedAgents[3]} />
      </group>
    </group>
  );
}

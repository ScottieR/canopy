import { GLBAgent } from "./GLBAgent";

// A smooth, thick ring of steps to represent a classical forum in blocky style
export function EducatorsForum({ agent }: { agent?: any }) {
  const baseColor = "#FFAB91"; // Soft coral
  const podiumColor = "#FFF3E0"; // Warm cream

  return (
    <group>
      {/* Base Solid Square Foundation */}
      <mesh position={[0, 0.4, 0]}>
        <boxGeometry args={[3.8, 0.8, 3.8]} />
        <meshStandardMaterial color={baseColor} roughness={0.9} />
      </mesh>

      {/* Chunky stepped seating blocks (Forum steps) */}
      <mesh position={[0, 1.0, -0.6]}>
        <boxGeometry args={[3, 0.4, 1.0]} />
        <meshStandardMaterial color={baseColor} roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.4, -0.8]}>
        <boxGeometry args={[3, 0.4, 0.6]} />
        <meshStandardMaterial color={podiumColor} roughness={0.9} />
      </mesh>

      {/* The Central Podium */}
      <group position={[0, 1.2, 0.8]}>
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[1.2, 0.8, 1.2]} />
          <meshStandardMaterial color={podiumColor} roughness={0.9} />
        </mesh>
        
        {/* The Agent */}
        {agent && (
          <GLBAgent 
            position={[0, 0.4, 0]} 
            scale={1.3} 
            isWorking={true} 
            baseColor={agent.color}
            robeColor={agent.robeColor}
            accentColor={agent.accentColor}
          />
        )}
      </group>

      {/* Huge blocky books */}
      <group position={[1.0, 1.0, -0.5]}>
         <mesh position={[0, 0.1, 0]} rotation={[0, -0.2, 0]}><boxGeometry args={[0.5, 0.2, 0.6]} /><meshStandardMaterial color="#80DEEA" roughness={0.9} /></mesh>
         <mesh position={[0, 0.3, 0]} rotation={[0, 0.3, 0]}><boxGeometry args={[0.4, 0.2, 0.5]} /><meshStandardMaterial color="#FFF9C4" roughness={0.9} /></mesh>
      </group>
      
      <group position={[-1.2, 1.0, -0.7]}>
         <mesh position={[0, 0.1, 0]} rotation={[0, 0.5, 0]}><boxGeometry args={[0.6, 0.2, 0.7]} /><meshStandardMaterial color="#E1BEE7" roughness={0.9} /></mesh>
      </group>
    </group>
  );
}

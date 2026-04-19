import { GLBAgent } from "./GLBAgent";

export function KidsPlayScape({ agent }: { agent?: any }) {
  const baseColor = "#FFF9C4"; // Butter yellow
  const blockColor1 = "#B2EBF2"; // Mint green
  const blockColor2 = "#FFAB91"; // Soft coral
  const blockColor3 = "#E1BEE7"; // Lavender

  return (
    <group>
      {/* Base Foundation */}
      <mesh position={[0, 0.4, 0]}>
        <boxGeometry args={[3.2, 0.8, 3.2]} />
        <meshStandardMaterial color={baseColor} roughness={0.9} />
      </mesh>

      {/* Floating Abstract "Toy" Blocks */}
      <group position={[0, 1.5, 0]}>
        <mesh position={[-0.8, 0.4, -0.8]}>
          <boxGeometry args={[1.0, 0.8, 1.0]} />
          <meshStandardMaterial color={blockColor1} roughness={0.9} />
        </mesh>
        <mesh position={[0.8, 0.6, -0.6]}>
          <boxGeometry args={[0.8, 1.2, 0.8]} />
          <meshStandardMaterial color={blockColor2} roughness={0.9} />
        </mesh>
        <mesh position={[0.6, 0.3, 0.8]}>
          <boxGeometry args={[1.2, 0.6, 1.2]} />
          <meshStandardMaterial color={blockColor3} roughness={0.9} />
        </mesh>
        
        {/* Abstract Arch/Bridge */}
        <group position={[-0.6, 0.4, 0.6]} rotation={[0, Math.PI/4, 0]}>
           <mesh position={[-0.4, 0, 0]}><boxGeometry args={[0.2, 0.8, 0.2]} /><meshStandardMaterial color={blockColor2} roughness={0.9} /></mesh>
           <mesh position={[0.4, 0, 0]}><boxGeometry args={[0.2, 0.8, 0.2]} /><meshStandardMaterial color={blockColor2} roughness={0.9} /></mesh>
           <mesh position={[0, 0.5, 0]}><boxGeometry args={[1.0, 0.2, 0.2]} /><meshStandardMaterial color={blockColor2} roughness={0.9} /></mesh>
        </group>

        {/* The Agent wandering the play scape */}
        {agent && (
          <GLBAgent 
            position={[0, 0.2, 0]} 
            scale={1.3} 
            isWorking={true} 
            baseColor={agent.color}
            robeColor={agent.robeColor}
            accentColor={agent.accentColor}
          />
        )}
      </group>
    </group>
  );
}

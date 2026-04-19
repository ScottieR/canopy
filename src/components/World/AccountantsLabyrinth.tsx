import { GLBAgent } from "./GLBAgent";

function EscherStairs({ position = [0,0,0], rotation = [0,0,0], steps = 4, width = 0.8, height = 1.2, depth = 1.2, color = "#FFF3E0" }: any) {
  const stepH = height / steps;
  const stepD = depth / steps;
  return (
    <group position={position} rotation={rotation}>
      {Array.from({ length: steps }).map((_, i) => (
        <mesh key={i} position={[0, (i * stepH) / 2, (i * stepD) - depth / 2 + stepD / 2]}>
          <boxGeometry args={[width, stepH * (i + 1), stepD]} />
          <meshStandardMaterial color={color} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

export function AccountantsLabyrinth({ agent }: { agent?: any }) {
  const baseColor = "#B2EBF2"; // Mint green
  const archColor = "#80DEEA";

  return (
    <group>
      {/* Central Labyrinth Block Base */}
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[3, 1, 3]} />
        <meshStandardMaterial color={baseColor} roughness={0.9} />
      </mesh>

      {/* Chunky Arches section */}
      <group position={[0.8, 1.5, -0.8]}>
        <mesh position={[-0.4, 0, 0]}><boxGeometry args={[0.3, 1, 0.3]} /><meshStandardMaterial color={archColor} roughness={0.9} /></mesh>
        <mesh position={[0.4, 0, 0]}><boxGeometry args={[0.3, 1, 0.3]} /><meshStandardMaterial color={archColor} roughness={0.9} /></mesh>
        <mesh position={[0, 0.65, 0]}><boxGeometry args={[1.1, 0.3, 0.3]} /><meshStandardMaterial color={archColor} roughness={0.9} /></mesh>
      </group>

      {/* Multi-directional Stairs */}
      <EscherStairs position={[-0.5, 0, 1.8]} rotation={[0, 0, 0]} steps={6} height={1.0} depth={1.2} width={0.8} color="#FFAB91" />
      <EscherStairs position={[-1.8, 0.2, 0]} rotation={[0, Math.PI / 2, 0]} steps={4} height={0.8} depth={1.0} width={0.8} color="#E1BEE7" />

      {/* The Agent */}
      {agent && (
        <GLBAgent 
           position={[-0.5, 1.0, 0]} 
           scale={1.3} 
           isWorking={true} 
           baseColor={agent.color}
           robeColor={agent.robeColor}
           accentColor={agent.accentColor}
        />
      )}
    </group>
  );
}

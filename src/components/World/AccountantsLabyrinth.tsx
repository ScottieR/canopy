import { GLBAgent } from "./GLBAgent";

function AbacusProp({ position = [0,0,0], rotation = [0,0,0], scale = 1 }: { position?: number[], rotation?: number[], scale?: number }) {
  const wood = "#CD9882";
  const rails = [0.08, 0.04, 0, -0.04, -0.08];
  return (
    <group position={position as any} rotation={rotation as any} scale={scale}>
      <mesh position={[-0.15, 0, 0]}><boxGeometry args={[0.03, 0.28, 0.03]} /><meshStandardMaterial color={wood} flatShading={false} /></mesh>
      <mesh position={[0.15, 0, 0]}><boxGeometry args={[0.03, 0.28, 0.03]} /><meshStandardMaterial color={wood} flatShading={false} /></mesh>
      <mesh position={[0, 0.125, 0]}><boxGeometry args={[0.3, 0.03, 0.03]} /><meshStandardMaterial color={wood} flatShading={false} /></mesh>
      <mesh position={[0, -0.125, 0]}><boxGeometry args={[0.3, 0.03, 0.03]} /><meshStandardMaterial color={wood} flatShading={false} /></mesh>
      
      {rails.map((y, i) => (
        <group key={i} position={[0, y, 0]}>
          <mesh rotation={[0, 0, Math.PI/2]}><cylinderGeometry args={[0.003, 0.003, 0.3, 8]} /><meshStandardMaterial color="#888" /></mesh>
          <mesh position={[-0.08 + (i%2)*0.03, 0, 0]}><sphereGeometry args={[0.018, 16, 16]} /><meshStandardMaterial color="#8DC9BE" roughness={0.1} /></mesh>
          <mesh position={[-0.02 + (i%2)*0.02, 0, 0]}><sphereGeometry args={[0.018, 16, 16]} /><meshStandardMaterial color="#EBBF80" roughness={0.1} /></mesh>
          <mesh position={[0.05 + (i%3)*0.02, 0, 0]}><sphereGeometry args={[0.018, 16, 16]} /><meshStandardMaterial color="#D98A82" roughness={0.1} /></mesh>
        </group>
      ))}
    </group>
  );
}

// Escher-style staircase generator
function EscherStairs({ position = [0,0,0], rotation = [0,0,0], steps = 8, width = 0.6, height = 1, depth = 1.2, color = "#E8C4A2" }: any) {
  const stepH = height / steps;
  const stepD = depth / steps;
  return (
    <group position={position} rotation={rotation}>
      {Array.from({ length: steps }).map((_, i) => (
        <mesh key={i} position={[0, (i * stepH) / 2, (i * stepD) - depth / 2 + stepD / 2]}>
          <boxGeometry args={[width, stepH * (i + 1), stepD]} />
          <meshStandardMaterial color={color} />
        </mesh>
      ))}
    </group>
  );
}

export function AccountantsLabyrinth() {
  const baseColor = "#E8C4A2"; // Warm terracotta/sand block color
  const archColor = "#D5A986";

  return (
    <group position={[-2, 0, -2]}>
      {/* Central Labyrinth Block Base */}
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[2.5, 1, 2.5]} />
        <meshStandardMaterial color={baseColor} />
      </mesh>

      {/* Tall Columns/Arches section */}
      <group position={[0.6, 1.5, -0.6]}>
        <mesh position={[-0.3, 0, 0]}><boxGeometry args={[0.2, 1, 0.2]} /><meshStandardMaterial color={archColor} /></mesh>
        <mesh position={[0.3, 0, 0]}><boxGeometry args={[0.2, 1, 0.2]} /><meshStandardMaterial color={archColor} /></mesh>
        <mesh position={[0, 0.5, 0]}><boxGeometry args={[0.8, 0.2, 0.2]} /><meshStandardMaterial color={archColor} /></mesh>
      </group>

      {/* Multi-directional Stairs */}
      {/* Main staircase going up to the accountant */}
      <EscherStairs position={[-0.5, 0, 1.5]} rotation={[0, 0, 0]} steps={10} height={1.2} depth={1.5} width={0.6} color={baseColor} />
      
      {/* Side intersecting staircase */}
      <EscherStairs position={[-1.5, 0.2, 0]} rotation={[0, Math.PI / 2, 0]} steps={6} height={0.8} depth={1.2} width={0.5} color="#D5A986" />

      {/* The Master Accountant standing on the main block */}
      <GLBAgent position={[-0.5, 1.0, 0]} scale={1.5} isWorking={true} />
      
      {/* A tiny worker accountant on a lower step */}
      <GLBAgent position={[-1.2, 0.8, 0]} scale={0.7} isWorking={true} />
      <GLBAgent position={[0.6, 1.0, -0.2]} scale={0.6} />

      {/* Abacuses scattered around like the image */}
      <AbacusProp position={[-1.2, 1.15, -0.5]} rotation={[0, Math.PI/4, 0]} scale={0.8} />
      <AbacusProp position={[0.5, 1.15, 0.5]} rotation={[0, -Math.PI/6, 0]} scale={0.8} />
      <AbacusProp position={[0.8, 2.15, -0.6]} rotation={[0, Math.PI/2, 0]} scale={0.6} />
    </group>
  );
}

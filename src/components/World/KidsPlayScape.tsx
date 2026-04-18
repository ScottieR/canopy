import { useRef } from "react";
import { GLBAgent } from "./GLBAgent";

export function KidsPlayScape({ position = [0, 0, 0] }) {
  const woodLight = "#E5D2A6";
  const woodDark = "#CBA874";
  
  // Toy Colors
  const red = "#E86F68";
  const green = "#7AB488";
  const blue = "#6CA5DB";
  const yellow = "#EBD27A";
  const purple = "#A585C2";

  return (
    <group position={position as [number, number, number]}>
      {/* Play-scape base platform */}
      <mesh position={[0, 0.1, 0]}>
        <boxGeometry args={[4, 0.2, 4]} />
        <meshStandardMaterial color={woodLight} />
      </mesh>

      {/* The Ball Pit (A box filled with tiny spheres) */}
      <group position={[-1.2, 0.4, 1.2]}>
        {/* Ball pit walls */}
        <mesh position={[0, -0.1, 0]}><boxGeometry args={[1.6, 0.1, 1.6]} /><meshStandardMaterial color={blue} /></mesh>
        <mesh position={[-0.8, 0.1, 0]}><boxGeometry args={[0.1, 0.4, 1.6]} /><meshStandardMaterial color={blue} /></mesh>
        <mesh position={[0.8, 0.1, 0]}><boxGeometry args={[0.1, 0.4, 1.6]} /><meshStandardMaterial color={blue} /></mesh>
        <mesh position={[0, 0.1, -0.8]}><boxGeometry args={[1.5, 0.4, 0.1]} /><meshStandardMaterial color={blue} /></mesh>
        <mesh position={[0, 0.1, 0.8]}><boxGeometry args={[1.5, 0.4, 0.1]} /><meshStandardMaterial color={blue} /></mesh>
        
        {/* The Balls */}
        {Array.from({ length: 60 }).map((_, i) => (
          <mesh 
            key={i} 
            position={[
              (Math.random() - 0.5) * 1.3, 
              (Math.random() * 0.2) - 0.05, 
              (Math.random() - 0.5) * 1.3
            ]}
          >
            <sphereGeometry args={[0.08, 12, 12]} />
            <meshStandardMaterial color={[red, green, yellow, purple][i % 4]} roughness={0.3} />
          </mesh>
        ))}
      </group>

      {/* ABC Blocks */}
      <group position={[0.5, 0.4, 0]}>
        <mesh position={[-0.3, 0, 0.3]} rotation={[0, 0.2, 0]}>
          <boxGeometry args={[0.4, 0.4, 0.4]} />
          <meshStandardMaterial color={yellow} />
        </mesh>
        <mesh position={[0.2, 0, 0]} rotation={[0, -0.1, 0]}>
          <boxGeometry args={[0.4, 0.4, 0.4]} />
          <meshStandardMaterial color={red} />
        </mesh>
        <mesh position={[0, 0.4, 0.1]} rotation={[0, 0.4, 0]}>
          <boxGeometry args={[0.4, 0.4, 0.4]} />
          <meshStandardMaterial color={green} />
        </mesh>
      </group>

      {/* Stacking Ring Toy */}
      <group position={[1.2, 0.2, -1.2]}>
        <mesh position={[0, 0.2, 0]}><cylinderGeometry args={[0.05, 0.05, 0.6]} /><meshStandardMaterial color={woodDark} /></mesh>
        <mesh position={[0, 0.1, 0]}><torusGeometry args={[0.25, 0.1, 16, 32]} /><meshStandardMaterial color={purple} /></mesh>
        <mesh position={[0, 0.25, 0]}><torusGeometry args={[0.2, 0.1, 16, 32]} /><meshStandardMaterial color={green} /></mesh>
        <mesh position={[0, 0.4, 0]}><torusGeometry args={[0.15, 0.1, 16, 32]} /><meshStandardMaterial color={yellow} /></mesh>
        <mesh position={[0, 0.55, 0]}><sphereGeometry args={[0.12, 16, 16]} /><meshStandardMaterial color={red} /></mesh>
      </group>

      {/* The Kids Coordinator Lobster wearing a fun accessory (we just tint standard lobster) */}
      <GLBAgent position={[-0.5, 0.2, -0.8]} scale={1.4} isWorking={true} />

      {/* Tiny baby lobster playing in blocks */}
      <GLBAgent position={[0.8, 0.2, 0.5]} scale={0.5} />
    </group>
  );
}

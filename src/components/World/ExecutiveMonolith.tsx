import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLBAgent } from "./GLBAgent";

export function ExecutiveMonolith({ agent }: { agent?: any }) {
  const towerRef = useRef<THREE.Group>(null);
  
  useFrame(({ clock }) => {
    if (!towerRef.current) return;
    const t = clock.getElapsedTime();
    towerRef.current.position.y = Math.sin(t * 1.0) * 0.1;
  });

  const baseColor = "#E1BEE7"; // Lavender
  const towerColor = "#9575CD"; 
  const detailColor = "#FFF9C4"; // Butter yellow

  return (
    <group>
      {/* Base Foundation */}
      <mesh position={[0, 0.4, 0]}>
        <boxGeometry args={[3.2, 0.8, 3.2]} />
        <meshStandardMaterial color={baseColor} roughness={0.9} />
      </mesh>

      {/* Floating Monolith Tower */}
      <group ref={towerRef}>
        {/* Stepped Tower Base */}
        <mesh position={[0, 1.4, 0]}>
          <boxGeometry args={[2.0, 1.2, 2.0]} />
          <meshStandardMaterial color={towerColor} roughness={0.9} />
        </mesh>
        
        {/* Main Monolith Shaft */}
        <mesh position={[0, 3.5, 0]}>
          <boxGeometry args={[1.2, 3.0, 1.2]} />
          <meshStandardMaterial color={towerColor} roughness={0.9} />
        </mesh>
        
        {/* Tower Top Platform */}
        <mesh position={[0, 5.2, 0]}>
          <boxGeometry args={[1.6, 0.4, 1.6]} />
          <meshStandardMaterial color={detailColor} roughness={0.9} />
        </mesh>

        {/* The Agent standing on top */}
        {agent && (
          <GLBAgent 
            position={[0, 5.4, 0]} 
            scale={1.3} 
            isWorking={true} 
            baseColor={agent.color}
            robeColor={agent.robeColor}
            accentColor={agent.accentColor}
          />
        )}

        {/* Floating Abstract Blocky Ornaments */}
        <mesh position={[-1.2, 4.0, 1.2]} rotation={[0, Math.PI/4, 0]}>
          <boxGeometry args={[0.5, 0.5, 0.5]} />
          <meshStandardMaterial color={detailColor} roughness={0.9} />
        </mesh>
        <mesh position={[1.2, 3.0, -1.2]} rotation={[0, -Math.PI/6, 0]}>
          <boxGeometry args={[0.4, 1.0, 0.4]} />
          <meshStandardMaterial color={detailColor} roughness={0.9} />
        </mesh>
      </group>
    </group>
  );
}

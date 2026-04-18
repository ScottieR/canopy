import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLBAgent } from "./GLBAgent";

export function ExecutiveMonolith({ position = [0, 0, 0] }) {
  const towerRef = useRef<THREE.Group>(null);
  
  useFrame(({ clock }) => {
    if (!towerRef.current) return;
    const t = clock.getElapsedTime();
    // Subtle hover effect for the floating glass tower
    towerRef.current.position.y = Math.sin(t * 1.2) * 0.1;
  });

  return (
    <group position={position as [number, number, number]}>
      {/* Grid Floor */}
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 4]}>
        <planeGeometry args={[4, 4, 12, 12]} />
        <meshStandardMaterial color="#BCEAE5" roughness={0.2} transparent opacity={0.8} />
      </mesh>
      
      {/* Grid Lines */}
      <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, Math.PI / 4]}>
        <planeGeometry args={[4, 4, 12, 12]} />
        <meshBasicMaterial color="#FFFFFF" wireframe={true} transparent opacity={0.6} />
      </mesh>

      {/* Floating Monolith Tower */}
      <group ref={towerRef}>
        <mesh position={[0, 3, 0]}>
          <boxGeometry args={[0.8, 6, 0.8]} />
          <meshPhysicalMaterial 
            color="#A8DCE2" 
            metalness={0.9} 
            roughness={0.1} 
            transmission={0.8} // Glass-like transparency
            thickness={0.5} 
          />
        </mesh>
        
        {/* Tower Top Platform */}
        <mesh position={[0, 6.1, 0]}>
          <boxGeometry args={[1.2, 0.2, 1.2]} />
          <meshStandardMaterial color="#E8F1F2" />
        </mesh>

        {/* Executive Lobster standing on top */}
        {/* We reuse the generic agent wrapper */}
        <GLBAgent position={[0, 6.2, 0]} scale={1.2} isWorking={true} />

        {/* Floating Data Screens around the Executive */}
        <mesh position={[-0.8, 7.0, 0.5]} rotation={[0, Math.PI/4, 0]}>
          <boxGeometry args={[0.8, 0.5, 0.05]} />
          <meshStandardMaterial color="#64C8C0" transparent opacity={0.7} />
        </mesh>
        <mesh position={[0.8, 6.8, 0.5]} rotation={[0, -Math.PI/6, 0]}>
          <boxGeometry args={[0.6, 0.3, 0.05]} />
          <meshStandardMaterial color="#64C8C0" transparent opacity={0.7} />
        </mesh>
      </group>

      {/* Server Racks / Data Banks surrounding the base */}
      {[-1, 1].map((x) => 
        [-1, 1].map((z) => (
          <mesh key={`${x}-${z}`} position={[x * 1.5, 0.3, z * 1.5]}>
            <boxGeometry args={[0.4, 0.6, 0.4]} />
            <meshStandardMaterial color="#94B9B8" />
          </mesh>
        ))
      )}
    </group>
  );
}

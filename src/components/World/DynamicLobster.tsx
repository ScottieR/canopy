import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export function DynamicLobster({ 
  position = [0, 0, 0], 
  scale = 1.6,
  baseColor = "#E09075",
  robeColor = "#F2DBAD",
  accentColor = "#C47A60"
}: { 
  position?: number[], 
  scale?: number,
  baseColor?: string,
  robeColor?: string,
  accentColor?: string
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.position.y = position[1] + Math.sin(t * 1.5) * 0.03;
  });

  const darkGrey = "#2A2A2A";

  return (
    <group position={position as any} scale={scale} ref={ref}>
      {/* Body Core */}
      <mesh position={[0, 0.65, 0]}>
        <capsuleGeometry args={[0.16, 0.35, 24, 32]} />
        <meshStandardMaterial color={baseColor} roughness={0.4} flatShading={false} />
      </mesh>
      <mesh position={[0, 0.38, 0]}>
        <sphereGeometry args={[0.22, 32, 32]} />
        <meshStandardMaterial color={baseColor} roughness={0.4} flatShading={false} />
      </mesh>

      {/* Vest/Sweater */}
      <group position={[0, 0.45, 0]}>
        <mesh>
          <cylinderGeometry args={[0.20, 0.23, 0.35, 32]} />
          <meshStandardMaterial color={robeColor} roughness={0.8} flatShading={false} />
        </mesh>
        <mesh position={[-0.08, 0.15, 0.17]} rotation={[0, 0, -0.6]}>
          <boxGeometry args={[0.06, 0.25, 0.02]} />
          <meshStandardMaterial color={robeColor} roughness={0.8} />
        </mesh>
        <mesh position={[0.08, 0.15, 0.17]} rotation={[0, 0, 0.6]}>
          <boxGeometry args={[0.06, 0.25, 0.02]} />
          <meshStandardMaterial color={robeColor} roughness={0.8} />
        </mesh>
      </group>

      {/* Tail */}
      <group position={[0, 0.15, -0.1]} rotation={[0.4, 0, 0]}>
        <mesh position={[0, 0, -0.05]}>
          <cylinderGeometry args={[0.21, 0.18, 0.15, 32]} />
          <meshStandardMaterial color={robeColor} roughness={0.6} flatShading={false} />
        </mesh>
        <mesh position={[0, -0.14, -0.05]}>
          <cylinderGeometry args={[0.18, 0.15, 0.15, 32]} />
          <meshStandardMaterial color={accentColor} roughness={0.6} flatShading={false} />
        </mesh>
        <mesh position={[0, -0.28, -0.05]}>
          <cylinderGeometry args={[0.15, 0.11, 0.15, 32]} />
          <meshStandardMaterial color={robeColor} roughness={0.6} flatShading={false} />
        </mesh>
        <mesh position={[0, -0.45, -0.05]} scale={[1, 1, 0.4]}>
          <coneGeometry args={[0.14, 0.25, 32]} />
          <meshStandardMaterial color={baseColor} roughness={0.6} flatShading={false} />
        </mesh>
      </group>

      {/* Glasses */}
      <group position={[0, 0.65, 0.15]}>
        <mesh position={[-0.06, 0, 0]} rotation={[Math.PI/2, 0, 0]}><torusGeometry args={[0.035, 0.003, 16, 32]} /><meshStandardMaterial color={darkGrey} /></mesh>
        <mesh position={[0.06, 0, 0]} rotation={[Math.PI/2, 0, 0]}><torusGeometry args={[0.035, 0.003, 16, 32]} /><meshStandardMaterial color={darkGrey} /></mesh>
        <mesh position={[0, 0, 0]} rotation={[0, 0, Math.PI/2]}><cylinderGeometry args={[0.003, 0.003, 0.05, 8]} /><meshStandardMaterial color={darkGrey} /></mesh>
        <mesh position={[-0.09, 0, -0.08]} rotation={[Math.PI/2, 0, 0]}><cylinderGeometry args={[0.003, 0.003, 0.16, 8]} /><meshStandardMaterial color={darkGrey} /></mesh>
        <mesh position={[0.09, 0, -0.08]} rotation={[Math.PI/2, 0, 0]}><cylinderGeometry args={[0.003, 0.003, 0.16, 8]} /><meshStandardMaterial color={darkGrey} /></mesh>
      </group>

      {/* Antennae */}
      <group position={[0, 0.85, 0]}>
        <mesh position={[-0.05, 0.08, -0.03]} rotation={[0.2, 0, 0.3]} scale={[1, 7, 1]}><sphereGeometry args={[0.015, 16, 16]} /><meshStandardMaterial color={baseColor} flatShading={false} /></mesh>
        <mesh position={[0.05, 0.08, -0.03]} rotation={[0.2, 0, -0.3]} scale={[1, 7, 1]}><sphereGeometry args={[0.015, 16, 16]} /><meshStandardMaterial color={baseColor} flatShading={false} /></mesh>
      </group>

      {/* Arms & Claws */}
      <group position={[-0.20, 0.45, 0.1]} rotation={[0, 0, -0.3]}>
        <mesh position={[0, -0.08, 0]} rotation={[Math.PI/4, 0, 0]}><capsuleGeometry args={[0.035, 0.15, 16, 16]} /><meshStandardMaterial color={robeColor} flatShading={false} /></mesh>
        <mesh position={[0, -0.15, 0.08]} rotation={[0.5, 0.2, 0]} scale={[1, 1.4, 0.8]}><sphereGeometry args={[0.055, 32, 32]} /><meshStandardMaterial color={accentColor} flatShading={false} /></mesh>
      </group>
      <group position={[0.20, 0.45, 0.1]} rotation={[0, 0, 0.3]}>
        <mesh position={[0, -0.08, 0]} rotation={[Math.PI/4, 0, 0]}><capsuleGeometry args={[0.035, 0.15, 16, 16]} /><meshStandardMaterial color={robeColor} flatShading={false} /></mesh>
        <mesh position={[0, -0.15, 0.08]} rotation={[0.5, -0.2, 0]} scale={[1, 1.4, 0.8]}><sphereGeometry args={[0.055, 32, 32]} /><meshStandardMaterial color={accentColor} flatShading={false} /></mesh>
      </group>

      {/* Tablet */}
      <group position={[0, 0.35, 0.24]} rotation={[-0.4, 0, 0]}>
        <mesh><boxGeometry args={[0.35, 0.22, 0.02]} /><meshStandardMaterial color={accentColor} roughness={0.3} /></mesh>
        <mesh position={[0, 0, 0.011]}><planeGeometry args={[0.3, 0.18, 6, 4]} /><meshBasicMaterial color="#ffffff" wireframe={true} transparent opacity={0.4} /></mesh>
      </group>
    </group>
  );
}

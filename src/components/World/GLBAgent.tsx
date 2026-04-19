import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { DynamicLobster } from "./DynamicLobster";

export function GLBAgent({ fileUrl, accessories = [], position = [0, 0, 0], scale = 1, isWorking = false, baseColor, robeColor, accentColor }: { fileUrl?: string, accessories?: string[], position?: [number, number, number]|number[], scale?: number, isWorking?: boolean, baseColor?: string, robeColor?: string, accentColor?: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const orbRef = useRef<THREE.Mesh>(null);
  
  // Minimal floating effect replacing complex limb animation
  useFrame(({ clock }) => {
    if (groupRef.current) {
      const t = clock.getElapsedTime();
      groupRef.current.position.y = (position[1] as number) + Math.sin(t * 1.5 + position[0]) * 0.05;
    }
    // Glowing orb bob and pulse when working
    if (orbRef.current && isWorking) {
      const t = clock.getElapsedTime();
      orbRef.current.position.y = 1.3 + Math.sin(t * 3) * 0.1;
      const pulsingScale = 1 + Math.sin(t * 6) * 0.15;
      orbRef.current.scale.setScalar(pulsingScale);
    }
  });

  return (
    <group position={position as [number,number,number]} scale={scale} ref={groupRef}>
      {/* 
        If a user supplies a valid .glb url (e.g. from Meshy), it renders the raw static Mesh perfectly.
        If NO URL is supplied, we peacefully fallback to the code-based AccountantLobster so the app doesn't crash! 
      */}
      {fileUrl ? (
        <React.Suspense fallback={null}>
          <GLBModel url={fileUrl} />
        </React.Suspense>
      ) : (
        <DynamicLobster position={[0,0,0]} scale={1} baseColor={baseColor} robeColor={robeColor} accentColor={accentColor} />
      )}

      {/* Dynamic Accessories System */}
      {accessories.map((accUrl, i) => (
        <React.Suspense key={i} fallback={null}>
           <GLBModel url={accUrl} />
        </React.Suspense>
      ))}

      {/* Floating UI Indicator: Replaces the need for complex 'working' limb animations */}
      {isWorking && (
        <mesh ref={orbRef} position={[0, 1.3, 0]}>
          <sphereGeometry args={[0.1, 16, 16]} />
          {/* Highly emissive material creates a glowing effect */}
          <meshStandardMaterial color="#88E8D5" emissive="#88E8D5" emissiveIntensity={1.5} toneMapped={false} />
          <pointLight color="#88E8D5" intensity={0.5} distance={1.5} />
        </mesh>
      )}
    </group>
  );
}

function GLBModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  // Clone the scene so we can instance the exact same GLB repeatedly across the map without conflicts
  const clonedScene = scene.clone();
  return <primitive object={clonedScene} />;
}

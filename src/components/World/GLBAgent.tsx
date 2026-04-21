import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";

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
        If NO URL is supplied, we peacefully render a simple fallback.
      */}
      {fileUrl ? (
        <React.Suspense fallback={null}>
          <GLBModel url={fileUrl} />
        </React.Suspense>
      ) : (
        <mesh position={[0, 0.5, 0]}>
           <cylinderGeometry args={[0.3, 0.4, 1, 16]} />
           <meshStandardMaterial color={robeColor || "#CCC"} />
        </mesh>
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

export function Pedestal({ color = "#C8D8E8", scale = 1, position = [0, 0, 0] }: { color?: string, scale?: number, position?: [number, number, number]|number[] }) {
  return (
    <group position={position as [number,number,number]} scale={scale}>
      {/* Monument Valley style block base */}
      <mesh receiveShadow position={[0, -0.25, 0]}>
        {/* 8-sided cylinder = Octagon */}
        <cylinderGeometry args={[1.5, 1.5, 0.5, 8]} />
        <meshStandardMaterial color={color} roughness={0.9} flatShading />
      </mesh>
      {/* Inner sunken highlight ring */}
      <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.1, 1.3, 8]} />
        <meshStandardMaterial color="#ffffff" opacity={0.3} transparent />
      </mesh>
    </group>
  );
}

export function SingleGLB({ url, scale=1 }: { url: string, scale?: number }) {
   const groupRef = useRef<THREE.Group>(null);
   useFrame(({ clock }) => {
     if (groupRef.current) {
       groupRef.current.rotation.y = clock.getElapsedTime() * 0.5;
     }
   });
   return (
     <group ref={groupRef} scale={scale}>
       <React.Suspense fallback={<mesh><boxGeometry args={[0.5,0.5,0.5]}/><meshStandardMaterial wireframe/></mesh>}>
         <GLBModel url={url} />
       </React.Suspense>
     </group>
   );
}

function GLBModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  
  const clonedScene = React.useMemo(() => {
    // Clone the scene so we can instance the exact same GLB repeatedly
    const clone = scene.clone();
    
    // Meshy generators crop and scale unpredictably based on the source image.
    // We compute the exact bounding box of the geometry and mathematically force 
    // it into a perfectly normalized 1.0 target height.
    const box = new THREE.Box3().setFromObject(clone);
    const size = new THREE.Vector3();
    box.getSize(size);
    
    if (size.y > 0) {
       const scaleFactor = 1.0 / size.y;
       clone.scale.setScalar(scaleFactor);
       
       // Recompute bounds after scale to anchor it properly
       const scaledBox = new THREE.Box3().setFromObject(clone);
       const center = new THREE.Vector3();
       scaledBox.getCenter(center);
       
       // Center X and Z so it doesn't drift sideways
       clone.position.x = -center.x;
       clone.position.z = -center.z;
       // Firmly anchor the absolute lowest pixel (its feet) strictly to y=0.
       // This prevents random models from sinking into the ground.
       clone.position.y = -scaledBox.min.y;
    }

    return clone;
  }, [scene]);

  return <primitive object={clonedScene} />;
}

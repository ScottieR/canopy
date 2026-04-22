import React, { useEffect, useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useAnimations } from "@react-three/drei";
import * as THREE from "three";
import { SkeletonUtils } from "three-stdlib";

export function GLBAgent({ fileUrl, accessories = [], position = [0, 0, 0], scale = 1, isWorking = false, baseColor, robeColor, accentColor, role }: { fileUrl?: string, accessories?: string[], position?: [number, number, number]|number[], scale?: number, isWorking?: boolean, baseColor?: string, robeColor?: string, accentColor?: string, role?: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const orbRef = useRef<THREE.Mesh>(null);
  
  // Load the universal rigged body
  const { scene, animations } = useGLTF("/models/lobsters/BaseLobsterRigged.glb");
  
  // Clone incredibly efficiently so each agent gets its own distinct animated skeleton and colored materials
  const clonedScene = useMemo(() => {
    const clone = SkeletonUtils.clone(scene);
    
    // Unlink and tint the materials dynamically based on agent colors
    clone.traverse((node: any) => {
      if (node.isMesh && node.material) {
        node.material = node.material.clone();
        
        // Dynamically colorize the outfit to match the user's role profile!
        // We override the base material color with the database-driven robe/accent color
        if (robeColor) {
           node.material.color.set(robeColor);
        }
      }
    });
    
    return clone;
  }, [scene, robeColor]);

  // Bind animations to our cloned instance
  const { actions, names } = useAnimations(animations, groupRef);

  useEffect(() => {
    if (names.length === 0) return;
    
    // GLB EXPORT PATCH: Track renaming due to export
    const idleAnim = names.find(n => n === "Long_Breathe_and_Look_Around") || names[0];
    const workingAnim = names.find(n => n === "run_fast_8_inplace") || names[0];
    
    const activeActionName = isWorking ? workingAnim : idleAnim;
    const action = actions[activeActionName];
    
    if (action) {
      action.reset().fadeIn(0.5).play();
    }
    
    return () => { if (action) action.fadeOut(0.5); };
  }, [isWorking, actions, names]);

  useFrame(({ clock }) => {
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
      <primitive object={clonedScene} />

      {/* Dynamic Accessories System */}
      <React.Suspense fallback={null}>
        {role && <DynamicAccessory role={role} />}
      </React.Suspense>

      {/* Floating UI Indicator for Active status */}
      {isWorking && (
        <mesh ref={orbRef} position={[0, 1.3, 0]}>
          <sphereGeometry args={[0.08, 16, 16]} />
          <meshStandardMaterial color="#88E8D5" emissive="#88E8D5" emissiveIntensity={1.5} toneMapped={false} />
          <pointLight color="#88E8D5" intensity={0.5} distance={1.5} />
        </mesh>
      )}
    </group>
  );
}

function DynamicAccessory({ role }: { role: string }) {
   // This is a rendering scaffold. 
   // When AccessoriesLibrary.glb is built, we can `const { nodes } = useGLTF(...)`
   // and selectively render `object={nodes.VR_Goggles.clone()}` based on the role string.
   
   return (
      <group position={[0, 1.0, 0]}>
         {/* Pending Accessory Splitting... */}
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

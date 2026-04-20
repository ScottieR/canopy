import { useMemo } from "react";
import agentsData from "../../../../shared/agents.json";
import { AgentNeighborhood } from "./AgentNeighborhood";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { useLoader } from "@react-three/fiber";
import * as THREE from "three";
import React from "react";

// The unified Globe mesh
function Planet() {
  const gltf = useLoader(GLTFLoader, "/models/lobsters/Globe.glb");
  return <primitive object={gltf.scene} scale={2.5} />;
}

export function WorldScene() {
  // Hard code 5 agents that have Meshy models
  const selectedAgents = useMemo(() => {
    const keys = ["Accountant", "Assistant", "Strategist", "Researcher", "Tutor"];
    return keys.map((key) => {
       const agent = (agentsData as any)[key];
       return {
         ...agent,
         id: key, // ensure ID is the name for the file
         fileUrl: `/models/lobsters/${key}.glb`
       };
    });
  }, []);

  // Compute spherical coordinates using Golden Spiral for even surface distribution
  const GLOBE_RADIUS = 2.4; 
  const LOBSTER_ELEVATION_OFFSET = 0.8; // Push outward so the center of geometry isn't buried
  
  const points = useMemo(() => {
    const pts = [];
    const N = selectedAgents.length;
    const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle
    
    for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2; // y goes from 1 to -1
        const radiusAtY = Math.sqrt(1 - y * y); // radius at y
        const theta = phi * i;

        const x = Math.cos(theta) * radiusAtY;
        const z = Math.sin(theta) * radiusAtY;
        
        // Scale to our globe's size + elevation offset
        pts.push(new THREE.Vector3(x, y, z).multiplyScalar(GLOBE_RADIUS + LOBSTER_ELEVATION_OFFSET));
    }
    return pts;
  }, [selectedAgents.length]);

  return (
    <group position={[0, -1, 0]}>
      {/* Dynamic Meshy Globe Base */}
      <React.Suspense fallback={<mesh><sphereGeometry args={[GLOBE_RADIUS, 32, 32]} /><meshStandardMaterial color="#D2D6CE" /></mesh>}>
         <Planet />
      </React.Suspense>

      {/* Agents Gravity-Aligned */}
      {selectedAgents.map((agent: any, index) => {
         const pos = points[index];
         // Normal vector pointing outwards from the center [0,0,0]
         const normal = pos.clone().normalize();
         
         // Compute a quaternion that rotates the default "up" (0,1,0) to the normal
         const defaultUp = new THREE.Vector3(0, 1, 0);
         const quat = new THREE.Quaternion().setFromUnitVectors(defaultUp, normal);
         
         // Convert Quaternion to Euler to pass as rotation 
         const euler = new THREE.Euler().setFromQuaternion(quat);

         return (
             <group key={agent.id || index} position={pos.toArray()} rotation={euler}>
                {/* 
                  Since we stripped out procedurals from AgentNeighborhood, 
                  we just use it to wrapper the GLBAgent directly! 
                */}
                <AgentNeighborhood 
                  agent={agent} 
                  position={[0, 0, 0]} 
                />
             </group>
         );
      })}
    </group>
  );
}

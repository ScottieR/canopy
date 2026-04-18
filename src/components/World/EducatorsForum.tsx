import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { AccountantLobster } from "./AccountantLobster";

function FloatingBook({ position, rotation }: { position: [number, number, number], rotation?: [number, number, number] }) {
  const ref = useRef<THREE.Group>(null);
  
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    // Gentle bobbing and slow rotation
    ref.current.position.y = position[1] + Math.sin(t * 1.5 + position[0]) * 0.1;
    ref.current.rotation.y += 0.005;
  });

  return (
    <group ref={ref} position={position} rotation={rotation || [0, 0, 0]}>
      {/* Book Cover */}
      <mesh>
        <boxGeometry args={[0.2, 0.25, 0.05]} />
        <meshStandardMaterial color="#D17462" /> {/* Terracotta red book */}
      </mesh>
      {/* Pages */}
      <mesh position={[0.01, 0, 0]}>
        <boxGeometry args={[0.18, 0.23, 0.055]} />
        <meshStandardMaterial color="#F2EBDC" />
      </mesh>
    </group>
  );
}

export function EducatorsForum({ position = [0, 0, 0] }) {
  const baseColor = "#E6D6AD"; // Sand / Colosseum stone color
  const tierColor = "#F2E8CD";

  // Tier sizes for the stadium seating
  const tiers = 4;
  const tierHeight = 0.4;
  const tierDepth = 0.5;
  const innermostRadius = 1.2;

  return (
    <group position={position as [number, number, number]}>
      
      {/* The Colosseum Tiers */}
      {/* Using an Array to stack progressively larger semi-circles */}
      {Array.from({ length: tiers }).map((_, i) => {
        const radius = innermostRadius + (i * tierDepth);
        return (
          <mesh 
            key={i} 
            position={[0, i * tierHeight, 0]} 
            rotation={[0, -Math.PI / 2, 0]} // Face the center 
          >
            {/* args: radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength */}
            <cylinderGeometry args={[radius, radius, tierHeight, 32, 1, false, 0, Math.PI]} />
            <meshStandardMaterial color={(i % 2 === 0) ? baseColor : tierColor} flatShading={false} />
          </mesh>
        );
      })}

      {/* The back wall / arches wrapper */}
      <mesh position={[0, (tiers * tierHeight) / 2, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <cylinderGeometry args={[
          innermostRadius + (tiers * tierDepth), 
          innermostRadius + (tiers * tierDepth), 
          tiers * tierHeight, 
          32, 1, true, 0, Math.PI
        ]} />
        <meshStandardMaterial color={baseColor} side={THREE.DoubleSide} />
      </mesh>

      {/* Center Podium floor */}
      <mesh position={[0, -0.1, 0]}>
        <cylinderGeometry args={[innermostRadius, innermostRadius, 0.2, 32]} />
        <meshStandardMaterial color="#A4C2A5" /> {/* Soft grass/rug green */}
      </mesh>

      {/* The Educator Lobster at the podium */}
      <AccountantLobster position={[0.5, 0.1, 0]} scale={1.2} />

      {/* The "Students" - smaller lobsters sitting on the tiers */}
      {/* Tier 1 */}
      <AccountantLobster position={[-0.8, 0.6, 0.5]} scale={0.7} />
      <AccountantLobster position={[-0.2, 0.6, 1.2]} scale={0.7} />
      <AccountantLobster position={[-1.2, 0.6, -0.4]} scale={0.7} />
      {/* Tier 2 */}
      <AccountantLobster position={[-1.6, 1.0, 0.8]} scale={0.7} />
      <AccountantLobster position={[-0.5, 1.0, 1.6]} scale={0.7} />

      {/* Floating Books orbiting the forum entirely in code! */}
      <FloatingBook position={[1.5, 2.5, 1.5]} rotation={[0.4, 0.5, 0]} />
      <FloatingBook position={[-2.5, 3.5, 0]} rotation={[-0.2, -0.3, 0.2]} />
      <FloatingBook position={[0, 4.0, -2.5]} rotation={[0.1, 0.8, -0.1]} />

      {/* Bookshelves on the top tier wall */}
      <mesh position={[-2.8, 1.6, 0]} rotation={[0, Math.PI/2, 0]}>
        <boxGeometry args={[0.8, 1.2, 0.3]} />
        <meshStandardMaterial color="#916E5A" />
      </mesh>
      <mesh position={[0, 1.6, 2.8]} rotation={[0, 0, 0]}>
        <boxGeometry args={[0.8, 1.2, 0.3]} />
        <meshStandardMaterial color="#916E5A" />
      </mesh>
    </group>
  );
}

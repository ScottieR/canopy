import { AccountantsLabyrinth } from "./AccountantsLabyrinth";
import { ExecutiveMonolith } from "./ExecutiveMonolith";
import { EducatorsForum } from "./EducatorsForum";
import { KidsPlayScape } from "./KidsPlayScape";

export function WorldScene() {
  return (
    <group position={[0, -1, 0]}>
      {/* The massive floating island base */}
      <mesh position={[0, -1, 0]}>
        {/* Soft greenish-blue earth slice representing the 'world' */}
        <cylinderGeometry args={[7, 6.5, 2, 64]} />
        <meshStandardMaterial color="#8AB1A8" roughness={0.8} />
      </mesh>

      {/* The water / connective bridges */}
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[6.8, 6.8, 0.1, 64]} />
        <meshStandardMaterial color="#6ABBB3" roughness={0.2} transparent opacity={0.6} />
      </mesh>
      
      {/* The Base Grid / Executive Plaza placeholder */}
      <mesh position={[1.5, 0.11, -1.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[4, 4, 10, 10]} />
        <meshStandardMaterial color="#A4E3DF" roughness={0.1} />
      </mesh>
      {/* Grid lines for the executive plaza */}
      <mesh position={[1.5, 0.12, -1.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[4, 4, 10, 10]} />
        <meshBasicMaterial color="#E8FBFA" wireframe={true} transparent opacity={0.5} />
      </mesh>

      {/* The Labyrinth Biome (Left) */}
      <group position={[-2.5, 0.1, 1]}>
        <AccountantsLabyrinth />
      </group>

      {/* The Executive Monolith (Back Center) */}
      <group position={[0, 0.1, -2]}>
        <ExecutiveMonolith />
      </group>

      {/* The Educator's Forum (Right) */}
      <group position={[3.5, 0.1, -0.5]} rotation={[0, -Math.PI / 4, 0]}>
        <EducatorsForum />
      </group>

      {/* The Kid's Play-Scape (Front Right) */}
      <group position={[2.5, 0.1, 3]}>
        <KidsPlayScape />
      </group>
    </group>
  );
}

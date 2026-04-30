import React, { useEffect, useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useAnimations } from "@react-three/drei";
import * as THREE from "three";
import { SkeletonUtils } from "three-stdlib";

// Maintain a module-level stagger so each agent drops into the scene exactly 100ms out of phase with the previous
let globalAnimationStagger = 0;

export function GLBAgent({ fileUrl, accessories = [], position = [0, 0, 0], scale = 1, isWorking = false, agentStatus, baseColor, robeColor, accentColor, role, navPoints, forceAnimation }: { fileUrl?: string, accessories?: string[], position?: [number, number, number] | number[], scale?: number, isWorking?: boolean, agentStatus?: string, baseColor?: string, robeColor?: string, accentColor?: string, role?: string, navPoints?: THREE.Vector3[], forceAnimation?: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const orbRef = useRef<THREE.Mesh>(null);
  const targetPos = useRef<THREE.Vector3>(new THREE.Vector3().fromArray(position as number[]));

  // Load the universal rigged body
  const { scene, animations } = useGLTF("/models/lobsters/BaseLobsterRigged.glb");

  // Clone incredibly efficiently so each agent gets its own distinct animated skeleton and colored materials
  const clonedScene = useMemo(() => {
    const clone = SkeletonUtils.clone(scene);

    // Unlink materials so multiple agents don't share the same color reference
    clone.traverse((node: any) => {
      if (node.isMesh && node.material) {
        node.material = node.material.clone();
      }
    });

    return clone;
  }, [scene]);

  // Dynamically colorize the outfit in-place so we don't break the animation mixer bindings!
  useEffect(() => {
    if (clonedScene && robeColor) {
      try {
        const linearColor = new THREE.Color(robeColor);
        // Correct color space for WebGL PBRs so colors don't wash out
        linearColor.convertSRGBToLinear();

        clonedScene.traverse((node: any) => {
          if (node.isMesh && node.material && !node.name.toLowerCase().includes("eye")) {
            if (Array.isArray(node.material)) {
              node.material.forEach(mat => {
                if (mat) {
                  mat.map = null;
                  mat.color.copy(linearColor);
                  mat.needsUpdate = true;
                }
              });
            } else if (node.material) {
              node.material.map = null;
              node.material.color.copy(linearColor);
              node.material.needsUpdate = true;
            }
          }
        });
      } catch (e) {
        console.warn("Could not apply robeColor to mesh:", e);
      }
    }
  }, [clonedScene, robeColor]);


  // Bind animations to our cloned instance
  const { actions, names } = useAnimations(animations, groupRef);

  useEffect(() => {
    if (names.length === 0) return;

    // GLB EXPORT PATCH: Track renaming due to export (names got swapped)
    const ANIMATION_MAP: Record<string, string> = {
      "breathe": "Walking", // The 'Walking' animation is actually the breathe animation
      "idle": "Walking",
      "walk": "Long_Breathe_and_Look_Around", // The 'Long Breathe' is actually walking
      "walking": "Long_Breathe_and_Look_Around",
      "run": "Running",
      "fast": "run_fast_8_inplace"
    };

    const idleAnim = names.find(n => n === "Walking") || names[0];

    let activeActionName: string | null = idleAnim;

    // Explicit override
    if (forceAnimation === "none") {
      activeActionName = null;
    } else if (forceAnimation) {
      const normalized = forceAnimation.toLowerCase();
      if (ANIMATION_MAP[normalized] && names.includes(ANIMATION_MAP[normalized])) {
        activeActionName = ANIMATION_MAP[normalized];
      } else if (names.includes(forceAnimation)) {
        activeActionName = forceAnimation;
      } else {
        const fuzzy = names.find(n => n.toLowerCase().includes(normalized));
        if (fuzzy) activeActionName = fuzzy;
      }
    }
    
    let action: THREE.AnimationAction | null = null;
    if (activeActionName) {
      action = actions[activeActionName] || null;
    }

    if (action) {
      // Advance our global phase clock by 100ms for each spawned agent
      globalAnimationStagger += 1.1;

      action.reset().fadeIn(0.5).play();
      // To ensure perfectly dispersed desync, we assign the local playhead time directly rather than hitting the global mixer
      action.time = globalAnimationStagger % action.getClip().duration;
    }

    return () => { if (action) action.fadeOut(0.5); };
  }, [isWorking, actions, names]);

  useEffect(() => {
    // 1. Initial Spawn: Break the centering! Instantly snap them to a random valid location.
    if (navPoints && navPoints.length > 0 && groupRef.current) {
      const initialPoint = navPoints[Math.floor(Math.random() * navPoints.length)];
      groupRef.current.position.copy(initialPoint);
      targetPos.current.copy(initialPoint);
    }
  }, [navPoints]);

  useEffect(() => {
    // 2. Roaming Logic: Periodically pick a new safe topological node to wander towards
    if (!navPoints || navPoints.length === 0) return;

    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNextMove = () => {
      // Pick a random interval between 20 seconds and 60 seconds (1 minute)
      const delay = 20000 + Math.random() * 40000;

      timeoutId = setTimeout(() => {
        const newPoint = navPoints[Math.floor(Math.random() * navPoints.length)];
        targetPos.current.copy(newPoint);
        scheduleNextMove();
      }, delay);
    };

    scheduleNextMove();

    return () => clearTimeout(timeoutId);
  }, [navPoints]);

  useFrame(({ clock }, delta) => {
    // Smooth Physical Translation
    if (groupRef.current) {
      groupRef.current.position.lerp(targetPos.current, delta * 1.5);

      // Orient them gracefully toward their target
      const dist = groupRef.current.position.distanceTo(targetPos.current);
      if (dist > 0.05) {
        const dir = targetPos.current.clone().sub(groupRef.current.position).normalize();
        const targetYRotation = Math.atan2(dir.x, dir.z);

        // Shortest path angle interpolation
        const diff = targetYRotation - groupRef.current.rotation.y;
        const normalizedDiff = Math.atan2(Math.sin(diff), Math.cos(diff));
        groupRef.current.rotation.y += normalizedDiff * delta * 4.0;
      }
    }

    // Glowing orb bob and pulse when working
    if (orbRef.current && agentStatus && agentStatus !== "offline") {
      const t = clock.getElapsedTime();
      orbRef.current.position.y = 2.2 + Math.sin(t * 3) * 0.1;
      const pulsingScale = agentStatus === "thinking" ? 1 + Math.sin(t * 8) * 0.3 : 1 + Math.sin(t * 6) * 0.15;
      orbRef.current.scale.setScalar(pulsingScale);
    }
  });

  const getStatusColor = () => {
    if (agentStatus === "active") return "#4A9E96";
    if (agentStatus === "thinking") return "#8B6AAE";
    if (agentStatus === "error") return "#E57373";
    return "#A0AAB5"; // idle
  };
  const statusColor = getStatusColor();

  return (
    <group position={position as [number, number, number]} scale={scale} ref={groupRef}>
      <primitive object={clonedScene} />

      {/* Dynamic Accessories System */}
      <React.Suspense fallback={null}>
        {role && <DynamicAccessory role={role} />}
      </React.Suspense>

      {/* Floating UI Indicator for Active status */}
      {agentStatus && (
        <mesh ref={orbRef} position={[0, 2.2, 0]}>
          <sphereGeometry args={[0.08, 16, 16]} />
          <meshStandardMaterial color={statusColor} emissive={statusColor} emissiveIntensity={isWorking ? 1.5 : 0.5} toneMapped={false} />
          <pointLight color={statusColor} intensity={isWorking ? 0.5 : 0.1} distance={2.5} />
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

export function Pedestal({ color = "#C8D8E8", scale = 1, position = [0, 0, 0] }: { color?: string, scale?: number, position?: [number, number, number] | number[] }) {
  return (
    <group position={position as [number, number, number]} scale={scale}>
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

export function SingleGLB({ url, scale = 1 }: { url: string, scale?: number }) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = clock.getElapsedTime() * 0.5;
    }
  });
  return (
    <group ref={groupRef} scale={scale}>
      <React.Suspense fallback={<mesh><boxGeometry args={[0.5, 0.5, 0.5]} /><meshStandardMaterial wireframe /></mesh>}>
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

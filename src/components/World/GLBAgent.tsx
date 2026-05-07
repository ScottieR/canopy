import React, { useEffect, useRef, useMemo, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF, useAnimations } from "@react-three/drei";
import * as THREE from "three";
import { SkeletonUtils } from "three-stdlib";
import accessoriesData from "../../../../shared/accessories.json";
import { AttachedAccessory } from "./AttachedAccessory";

// Maintain a module-level stagger so each agent drops into the scene exactly 100ms out of phase with the previous
let globalAnimationStagger = 0;

export function GLBAgent({ fileUrl, accessories = [], position = [0, 0, 0], scale = 1, isWorking = false, agentStatus, baseColor, robeColor, accentColor, role, navPoints, forceAnimation }: { fileUrl?: string, accessories?: string[], position?: [number, number, number] | number[], scale?: number, isWorking?: boolean, agentStatus?: string, baseColor?: string, robeColor?: string, accentColor?: string, role?: string, navPoints?: THREE.Vector3[], forceAnimation?: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const orbRef = useRef<THREE.Mesh>(null);
  const targetPos = useRef<THREE.Vector3>(new THREE.Vector3().fromArray(position as number[]));

  // Tracks whether the lobster is currently lerping toward a navPoint.
  // Drives auto-switching between the idle (breathe) and Walking clips when no
  // forceAnimation is supplied. Gated by a ref so we only call setState on
  // edge transitions, not every frame.
  const [isMoving, setIsMoving] = useState(false);
  const wasMovingRef = useRef(false);
  const MOVE_THRESHOLD = 0.05;

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
          if (node.userData?.isAccessory) return;
          if (node.isMesh && node.material && !node.name.toLowerCase().includes("eye")) {
            if (Array.isArray(node.material)) {
              node.material.forEach((mat: any) => {
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

    // The rig's clip names are taken at face value (admin uses them verbatim
    // and animates correctly). A previous version had an ANIMATION_MAP that
    // claimed 'Walking' was actually the breathe clip and vice versa — that
    // map was stale from an earlier export and made every lobster walk in
    // place when no forceAnimation was supplied. It's been removed.
    const IDLE_CLIP = "Long_Breathe_and_Look_Around";
    const WALK_CLIP = "Walking";

    // Default behavior when no forceAnimation: idle when stationary, walk
    // when lerping toward a navPoint. The cleanup at the end of this effect
    // fades out the prior action, so flipping isMoving produces a crossfade.
    const autoClip = isMoving ? WALK_CLIP : IDLE_CLIP;
    let activeActionName: string | null =
      names.find(n => n === autoClip) || names[0];

    if (forceAnimation === "none") {
      activeActionName = null;
    } else if (forceAnimation) {
      if (names.includes(forceAnimation)) {
        activeActionName = forceAnimation;
      } else {
        // Last-ditch substring match for callers that pass partial names
        const normalized = forceAnimation.toLowerCase();
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
  }, [isWorking, actions, names, forceAnimation, isMoving]);

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

      // Orient them gracefully toward their target, and report movement state
      // up to the animation effect via React state (gated to edge transitions).
      const dist = groupRef.current.position.distanceTo(targetPos.current);
      const moving = dist > MOVE_THRESHOLD;
      if (moving !== wasMovingRef.current) {
        wasMovingRef.current = moving;
        setIsMoving(moving);
      }
      if (moving) {
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
        {(accessories || []).map((acc, i) => {
          const itemData = (accessoriesData as any)?.items?.[acc];
          if (itemData?.type === 'decor') return null;
          
          return <AttachedAccessory 
            key={`${acc}-${i}`} 
            path={acc} 
            accessoryData={accessoriesData} 
            clonedSceneRoot={clonedScene} 
          />;
        })}
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

export function GLBModel({ url }: { url: string }) {
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

    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) {
      const scaleFactor = 1.0 / maxDim;
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

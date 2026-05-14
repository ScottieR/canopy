import React, { useEffect, useRef, useMemo } from "react";
import { useGLTF, useAnimations } from "@react-three/drei";
import * as THREE from "three";
import { SkeletonUtils } from "three-stdlib";
import { getAssetUrl } from "../../utils/assets";
interface CompanionProps {
  position?: [number, number, number];
  scale?: number;
  animationState?: string; // We can pass 'Idle', 'Wave', etc.
  baseColor?: string; // Add color injection support
}

export function OnboardingCompanion({ position = [0, 0, 0], scale = 1, animationState, baseColor = "#F28C63" }: CompanionProps) {
  const groupRef = useRef<THREE.Group>(null);

  // Load the rigged GLB model from the assets directory
  const { scene, animations } = useGLTF(getAssetUrl("/models/lobsters/BaseLobsterRigged.glb?v=2"));

  // Extract animations bound to this specific scene/group
  const { actions, names } = useAnimations(animations, groupRef);

  // Safely trigger crossfading animations based on the 'animationState' prop or default to first
  useEffect(() => {
    // If we have no animations, bail early
    if (names.length === 0) return;

    const findAnimation = (state: string | undefined) => {
      if (!state) return names[0];
      const lowerState = state.toLowerCase();

      // GLB EXPORT PATCH: The tracks inside the new BaseLobsterRigged.glb are swapped!
      // The 11.2 second slow breathing animation is incorrectly named "run_fast_8" internally.
      if (lowerState.includes("breath") || lowerState.includes("look")) {
        const swappedAnim = names.find(n => n === "Breathe");
        if (swappedAnim) return swappedAnim;
      }

      // The 0.6s fast run looping cycle is incorrectly named "Long_Breathe..." internally.
      if (/\brun/.test(lowerState) || lowerState.includes("walk")) {
        const swappedAnim = names.find(n => n === "Walking");
        if (swappedAnim) return swappedAnim;
      }

      // Fuzzy match for generic states like 'idle'
      const match = names.find(n => n.toLowerCase().includes(lowerState));
      if (match) return match;

      // If the animation doesn't exist (e.g. they couldn't find a good 'wave' or 'seated' anim), fallback gracefully to Idle
      console.warn(`Animation state '${state}' not found in GLB. Falling back to Idle.`);
      const idleFallback = names.find(n => n.toLowerCase().includes("idle"));
      return idleFallback || names[0];
    };

    let activeActionName = findAnimation(animationState);

    const action = actions[activeActionName];
    if (action) {
      action.reset().fadeIn(0.5).play();
    }

    return () => {
      if (action) {
        action.fadeOut(0.5);
      }
    };
  }, [animationState, actions, names]);

  return (
    <group ref={groupRef} position={position} scale={scale}>
      <primitive object={scene} />
    </group>
  );
}

useGLTF.preload(getAssetUrl("/models/lobsters/BaseLobsterRigged.glb"));

import React, { useEffect, useRef, useMemo } from "react";
import { useGLTF, useAnimations } from "@react-three/drei";
import * as THREE from "three";
import { SkeletonUtils } from "three-stdlib";
interface CompanionProps {
  position?: [number, number, number];
  scale?: number;
  animationState?: string; // We can pass 'Idle', 'Wave', etc.
  baseColor?: string; // Add color injection support
}

export function OnboardingCompanion({ position = [0, 0, 0], scale = 1, animationState, baseColor = "#F28C63" }: CompanionProps) {
  const groupRef = useRef<THREE.Group>(null);
  
  // Load the rigged GLB model from the assets directory
  const { scene, animations } = useGLTF("/models/lobsters/BaseLobsterRigged.glb");
  
  // Extract animations bound to this specific scene/group
  const { actions, names } = useAnimations(animations, groupRef);

  // Traverse and beautifully color the SkinnedMesh (bypasses flat grey exports)
  const coloredScene = useMemo(() => {
    // CRITICAL: We MUST use SkeletonUtils.clone for SkinnedMeshes, 
    // otherwise the clone will attempt to bind to the unmounted original bones and collapse to 0,0,0!
    const clone = SkeletonUtils.clone(scene);

    // 1. Force absolute size and position normalization so it perfectly anchors at Y=0
    const box = new THREE.Box3().setFromObject(clone);
    const size = new THREE.Vector3();
    box.getSize(size);
    
    if (size.y > 0) {
       const scaleFactor = 1.0 / size.y;
       clone.scale.setScalar(scaleFactor);
       
       // Recompute bounds after scale
       const scaledBox = new THREE.Box3().setFromObject(clone);
       const center = new THREE.Vector3();
       scaledBox.getCenter(center);
       
       console.log("💥 LOBSTER DEBUG -> Raw Size Y:", size.y, "ScaleFactor:", scaleFactor, "ScaledBox MinY:", scaledBox.min.y, "ScaledBox MaxY:", scaledBox.max.y);
       
       clone.position.x = -center.x;
       clone.position.z = -center.z;
       clone.position.y = -scaledBox.min.y; // Perfectly flush
    }

    clone.traverse((child: any) => {
      // SkinnedMesh is functionally a Mesh
      if (child.isMesh && child.material) {
        
        child.material = new THREE.MeshStandardMaterial({
          map: child.material.map || null,
          color: "#FFFFFF", // Raw white so the shader dictates all color
          roughness: 0.9,
          metalness: 0.0,
          skinning: true // Super important for rigged companions
        });

        // The Ultimate Match:
        // We intercept the raw texture pixels passing through the GPU. 
        // If the pixel is dark, we snap it to deep brown/black (for the eyes).
        // If it's light, we force it to explicitly match the perfect pastel peach from the reference image.
        if (child.material.map) {
          child.material.onBeforeCompile = (shader: any) => {
            shader.uniforms.uBodyColor = { value: new THREE.Color("#FFAF94") }; // The exact pastel peach
            shader.uniforms.uEyeColor  = { value: new THREE.Color("#3A1F1B") }; // Deep matte dark brown
            
            shader.fragmentShader = `
              uniform vec3 uBodyColor;
              uniform vec3 uEyeColor;
            ` + shader.fragmentShader;

            shader.fragmentShader = shader.fragmentShader.replace(
              `#include <map_fragment>`,
              `
              #include <map_fragment>
              // Measure brightness of the original texture map
              float luminance = dot(texelColor.rgb, vec3(0.299, 0.587, 0.114));
              
              if (luminance < 0.25) {
                // If it's dark, it's an eye/joint. Snap to the crisp eye color!
                diffuseColor.rgb = uEyeColor;
              } else {
                // Otherwise, perfectly map it to our designated peach color, preserving a tiny bit of texture shadow
                diffuseColor.rgb = mix(uBodyColor, texelColor.rgb, 0.15);
              }
              `
            );
          };
        }
      }
    });
    return clone;
  }, [scene, baseColor]);

  // Safely trigger crossfading animations based on the 'animationState' prop or default to first
  useEffect(() => {
    // If we have no animations, bail early
    if (names.length === 0) return;

    // Intelligent animation routing to map generic app states to specific exported Meshy names
    const findAnimation = (state: string | undefined) => {
      if (!state) return names[0];
      const lowerState = state.toLowerCase();
      
      // Specific user request: use "fast run 10" for running
      if (lowerState.includes("run") || lowerState.includes("walk")) {
        const specializedRun = names.find(n => n.toLowerCase().includes("fast run 10"));
        if (specializedRun) return specializedRun;
        // Fallback to any run
        const anyRun = names.find(n => n.toLowerCase().includes("run"));
        if (anyRun) return anyRun;
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
      <primitive object={coloredScene} />
    </group>
  );
}

useGLTF.preload("/models/lobsters/BaseLobsterRigged.glb");

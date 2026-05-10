import React, { useMemo, useEffect, useState } from 'react';
import { useGLTF } from '@react-three/drei';
import { createPortal } from '@react-three/fiber';
import * as THREE from 'three';
import { SkeletonUtils } from 'three-stdlib';

export function AttachedAccessory({
  path,
  accessoryData,
  clonedSceneRoot,
  transformRef
}: {
  path: string;
  accessoryData: any;
  clonedSceneRoot: THREE.Object3D;
  transformRef?: React.Ref<THREE.Group>;
}) {
  const glbPath = path.replace('.png', '.glb');
  const { scene } = useGLTF(glbPath.startsWith('http') ? glbPath : `${import.meta.env.VITE_API_URL || 'http://localhost:3001'}${glbPath.startsWith('/') ? '' : '/'}${glbPath}`);

  const clonedAcc = useMemo(() => {
    const clone = SkeletonUtils.clone(scene);
    clone.traverse(node => { node.userData = { ...node.userData, isAccessory: true }; });
    const box = new THREE.Box3().setFromObject(clone);
    const size = new THREE.Vector3();
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) {
      const scaleFactor = 1.0 / maxDim;
      clone.scale.setScalar(scaleFactor);

      const scaledBox = new THREE.Box3().setFromObject(clone);
      const center = new THREE.Vector3();
      scaledBox.getCenter(center);

      clone.position.x = -center.x;
      clone.position.z = -center.z;
      clone.position.y = -scaledBox.min.y;
    }
    return clone;
  }, [scene]);

  const itemData = accessoryData?.items?.[path];
  if (!itemData) return null;

  const boneName = itemData.bone || "Head";
  // NOTE: boneDefaults is intentionally not applied here. The placement view
  // (AccessoryPlacementScene) calibrates accessory offset/rotation/scale in an
  // identity-anchor frame, and production (canopy/GLBAgent.tsx's inline
  // AttachedAccessory) likewise renders without an anchor wrap. Reading
  // accessoryData.boneDefaults here used to apply an extra parent transform in
  // admin's agent edit view that neither of those paths apply, causing the
  // accessory to render in a wildly different place/orientation/scale.

  const [targetBone, setTargetBone] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    let found: THREE.Object3D | null = null;
    clonedSceneRoot.traverse((node: any) => {
      let b = boneName.toLowerCase().replace(/[._-]/g, '');
      if (b === 'handl') b = 'lefthand';
      if (b === 'handr') b = 'righthand';
      const normalizedNodeName = node.name.toLowerCase().replace(/[._-]/g, '');
      if (node.isBone) {
        if (normalizedNodeName === b) {
          found = node;
        } else if (!found && normalizedNodeName.includes(b)) {
          found = node;
        }
      }
    });
    setTargetBone(found);
  }, [clonedSceneRoot, boneName]);

  if (!targetBone) return null;

  const offset = itemData.offset || [0, 0, 0];
  const rotation = itemData.rotation || [0, 0, 0];
  const scale = itemData.scale || 1;

  return createPortal(
    <group>
      <group position={offset as any} rotation={rotation as any} scale={[scale, scale, scale]} ref={transformRef}>
        <primitive object={clonedAcc} />
      </group>
    </group>,
    targetBone
  );
}

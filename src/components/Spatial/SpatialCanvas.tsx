import React, { Suspense, useState, useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { XR, createXRStore } from '@react-three/xr';
import { Environment, OrbitControls, useGLTF } from '@react-three/drei';
import { useTelemetrySocket } from './TelemetrySocket';
import { LiveVoiceAdapter } from './LiveVoiceAdapter';
import * as THREE from 'three';

const store = createXRStore();

// A dynamic model loader component
const DynamicModel = ({ url, position }: { url: string, position: [number, number, number] }) => {
  // Try to load the GLTF, if it fails or while loading it shows nothing or fallback
  try {
    const { scene } = useGLTF(url);
    return <primitive object={scene.clone()} position={position} />;
  } catch (e) {
    // Fallback if URL is invalid or pending download
    return (
      <mesh position={position}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#FF9900" wireframe />
      </mesh>
    );
  }
};

// Telemetry reporter component that taps into the render loop
const TelemetryReporter = ({ sendTelemetry }: { sendTelemetry: any }) => {
  const { camera } = useThree();
  const lastReport = useRef(0);

  useFrame(({ clock }) => {
    // Throttle telemetry to 5Hz to avoid flooding the WebSocket
    if (clock.elapsedTime - lastReport.current > 0.2) {
      const position = camera.position;
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);

      sendTelemetry({
        headPosition: [position.x, position.y, position.z],
        gazeVector: [direction.x, direction.y, direction.z]
      });
      
      lastReport.current = clock.elapsedTime;
    }
  });

  return null;
};

interface SceneState {
  objects: Array<{
    id: string;
    position: [number, number, number];
    assetUrl: string;
  }>;
}

export const SpatialCanvas: React.FC = () => {
  const [sceneState, setSceneState] = useState<SceneState>({ objects: [] });
  const { sendTelemetry, lastPatch } = useTelemetrySocket();

  useEffect(() => {
    if (lastPatch) {
      setSceneState(prevState => {
        if (lastPatch.action === 'remove') {
          return {
            ...prevState,
            objects: prevState.objects.filter(o => o.id !== lastPatch.targetId)
          };
        }
        
        if (lastPatch.action === 'add' || lastPatch.action === 'swap_mesh') {
          const exists = prevState.objects.find(o => o.id === lastPatch.targetId);
          if (exists) {
            return {
              ...prevState,
              objects: prevState.objects.map(o => 
                o.id === lastPatch.targetId ? { 
                  ...o, 
                  assetUrl: lastPatch.newAsset || o.assetUrl,
                  position: lastPatch.position || o.position
                } : o
              )
            };
          } else {
            return {
              ...prevState,
              objects: [...prevState.objects, {
                id: lastPatch.targetId,
                position: lastPatch.position || [0, 0, 0],
                assetUrl: lastPatch.newAsset || ''
              }]
            };
          }
        }
        return prevState;
      });
    }
  }, [lastPatch]);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#1a1a1a' }}>
      <button 
        onClick={() => store.enterAR()}
        style={{ 
          position: 'absolute', top: 20, left: 20, zIndex: 100, 
          padding: '12px 24px', borderRadius: '12px', border: 'none',
          background: 'rgba(255,255,255,0.1)', color: 'white', 
          backdropFilter: 'blur(10px)', fontSize: '16px', fontWeight: 'bold',
          cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
        }}
      >
        👓 Enter AR / Vision Pro
      </button>

      <LiveVoiceAdapter />

      <Canvas camera={{ position: [0, 1.6, 3] }}>
        <XR store={store}>
          <Suspense fallback={null}>
            <Environment preset="city" />
            <ambientLight intensity={0.5} />
            <directionalLight position={[10, 10, 5]} intensity={1} castShadow />
            
            <TelemetryReporter sendTelemetry={sendTelemetry} />

            {/* Base Floor */}
            <mesh position={[0, -0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
              <planeGeometry args={[20, 20]} />
              <meshStandardMaterial color="#333333" />
            </mesh>

            {sceneState.objects.map(obj => (
              <DynamicModel key={obj.id} url={obj.assetUrl} position={obj.position} />
            ))}

          </Suspense>
        </XR>
        <OrbitControls />
      </Canvas>
    </div>
  );
};

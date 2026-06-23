import { useState, useEffect, useCallback } from 'react';

interface PatchPayload {
  action: 'add' | 'remove' | 'swap_mesh';
  targetId: string;
  newAsset?: string;
  position?: [number, number, number];
}

interface TelemetryPayload {
  headPosition?: [number, number, number];
  gazeVector?: [number, number, number];
  hoveredObjectId?: string;
}

export const useTelemetrySocket = () => {
  const [lastPatch, setLastPatch] = useState<PatchPayload | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);

  useEffect(() => {
    // In production, this connects to the Canopy WebSocket gateway
    const ws = new WebSocket('ws://localhost:18803/spatial-sync');
    
    ws.onopen = () => console.log('Spatial Sync Socket connected.');
    ws.onmessage = (event) => {
      try {
        const patch: PatchPayload = JSON.parse(event.data);
        console.log("Received agent scene patch:", patch);
        setLastPatch(patch);
      } catch (e) {
        console.error("Error parsing patch", e);
      }
    };
    
    setSocket(ws);
    return () => ws.close();
  }, []);

  const sendTelemetry = useCallback((telemetry: TelemetryPayload) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      // Throttle this in production (e.g. 10 times a second)
      socket.send(JSON.stringify({ type: 'telemetry', data: telemetry }));
    }
  }, [socket]);

  return { sendTelemetry, lastPatch };
};

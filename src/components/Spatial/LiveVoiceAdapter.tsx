import React, { useState, useEffect } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VoiceAssistantControlBar,
  useRoomContext,
  useLocalParticipant,
  BarChartIndicator,
} from '@livekit/components-react';

const VoiceIndicator = () => {
  const room = useRoomContext();
  const { isMicrophoneEnabled } = useLocalParticipant();

  return (
    <div style={{
      position: 'absolute', bottom: 20, left: 20, zIndex: 100,
      background: 'rgba(0,0,0,0.6)', color: 'white', padding: '15px 20px',
      borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: '10px',
      backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.1)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          background: room.state === 'connected' ? '#4ADE80' : '#F87171'
        }} />
        <span style={{ fontWeight: 600 }}>Spatial Agent Voice</span>
      </div>
      
      {room.state === 'connected' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '12px', opacity: 0.8 }}>
            {isMicrophoneEnabled ? "Listening..." : "Mic Muted"}
          </span>
          {isMicrophoneEnabled && <BarChartIndicator state="speaking" trackRef={undefined} />}
        </div>
      )}
      
      <VoiceAssistantControlBar />
    </div>
  );
};

export const LiveVoiceAdapter: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  useEffect(() => {
    // In a production app, this would hit your backend to generate a secure LiveKit token
    // For this prototype, we simulate fetching the spatial agent connection details
    const connectToAgent = async () => {
      try {
        console.log("Fetching LiveKit token for Spatial Agent Session...");
        // const res = await fetch('http://localhost:3001/api/livekit/getToken?room=spatial-canvas');
        // const data = await res.json();
        // setToken(data.token);
        // setServerUrl(data.serverUrl);
        
        // Mock fallback so the UI renders without crashing if backend isn't ready
        setServerUrl("wss://mock-livekit-server.livekit.cloud");
        setToken("mock-token-12345");
      } catch (err) {
        console.error("Failed to connect to agent voice:", err);
      }
    };
    
    connectToAgent();
  }, []);

  if (!token || !serverUrl) {
    return (
      <div style={{ position: 'absolute', bottom: 20, left: 20, zIndex: 100, background: 'rgba(0,0,0,0.5)', color: 'white', padding: '10px', borderRadius: '8px' }}>
        Connecting to Spatial Voice... ⏳
      </div>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={serverUrl}
      token={token}
      connect={true}
      audio={true}
      video={false}
    >
      <RoomAudioRenderer />
      <VoiceIndicator />
    </LiveKitRoom>
  );
};

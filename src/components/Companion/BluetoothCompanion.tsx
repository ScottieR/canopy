import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bluetooth, RefreshCw, CheckCircle } from 'lucide-react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

interface BluetoothDevice {
  id: string;
  name?: string;
  rssi?: number;
}

export function BluetoothCompanion() {
  const searchParams = new URLSearchParams(window.location.search);
  const agentId = searchParams.get("agentId") || "";
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'scanning' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const startScan = async () => {
    setScanning(true);
    setStatus('scanning');
    setError(null);
    try {
      const foundDevices = await invoke<BluetoothDevice[]>('scan_bluetooth_devices');
      setDevices(foundDevices);
      setStatus('idle');
    } catch (err: any) {
      setError(err.toString());
      setStatus('error');
    } finally {
      setScanning(false);
    }
  };

  const pairDevice = async (device: BluetoothDevice) => {
    setSelectedDevice(device.id);
    try {
      await invoke('whitelist_bluetooth_device', { 
        agentId, 
        deviceId: device.id, 
        deviceName: device.name || 'Unknown Device' 
      });
      // Also save the generic dynamic status token so the UI sees it's enabled
      await invoke("store_secret_cmd", { key: `agent_${agentId}_BLUETOOTH_TOKEN`, value: "paired" });
      setStatus('success');
      setTimeout(() => {
        getCurrentWebviewWindow().close();
      }, 2000);
    } catch (err: any) {
      setError(err.toString());
      setStatus('error');
    }
  };

  return (
    <div className="flex flex-col items-center justify-center p-8 text-white min-h-[400px]">
      <div className="bg-[#007AFF] p-4 rounded-full mb-6">
        <Bluetooth size={48} className="text-white" />
      </div>
      
      <h2 className="text-2xl font-bold mb-2">Zero-Trust Bluetooth</h2>
      <p className="text-gray-400 text-center mb-8 max-w-sm">
        Scan and authorize specific nearby Bluetooth devices for this agent. The agent will only be able to see and interact with the devices you explicitly select.
      </p>

      {status === 'success' ? (
        <div className="flex flex-col items-center animate-fade-in">
          <CheckCircle size={48} className="text-green-500 mb-4" />
          <p className="text-xl font-bold">Device Authorized!</p>
          <p className="text-gray-400">Agent can now read this device securely.</p>
        </div>
      ) : (
        <div className="w-full max-w-md">
          <button
            onClick={startScan}
            disabled={scanning}
            className="w-full py-3 mb-4 rounded-lg font-bold flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 text-white transition-colors"
          >
            {scanning ? (
              <><RefreshCw className="animate-spin mr-2" size={20} /> Scanning Room...</>
            ) : (
              'Scan for Devices'
            )}
          </button>

          {error && (
            <div className="bg-red-500/20 text-red-400 p-3 rounded mb-4 text-sm">
              {error}
            </div>
          )}

          {devices.length > 0 && (
            <div className="bg-black/40 rounded-xl border border-zinc-800 p-2 max-h-[200px] overflow-y-auto">
              {devices.map(d => (
                <div 
                  key={d.id} 
                  className={`flex justify-between items-center p-3 rounded-lg mb-1 cursor-pointer transition-colors ${selectedDevice === d.id ? 'bg-[#007AFF]/20 border border-[#007AFF]' : 'hover:bg-zinc-800'}`}
                  onClick={() => pairDevice(d)}
                >
                  <div className="flex flex-col">
                    <span className="font-semibold text-sm">{d.name || 'Unknown Device'}</span>
                    <span className="text-xs text-zinc-500">{d.id}</span>
                  </div>
                  <div className="text-xs text-zinc-400 bg-zinc-800 px-2 py-1 rounded">
                    RSSI: {d.rssi || '?'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

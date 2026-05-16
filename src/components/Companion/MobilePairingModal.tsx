import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

interface MobilePairingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface PairingData {
  token: string;
  ip: string;
  port: number;
}

export const MobilePairingModal: React.FC<MobilePairingModalProps> = ({ isOpen, onClose }) => {
  const [pairingData, setPairingData] = useState<PairingData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      invoke<PairingData>('generate_pairing_token')
        .then((data) => setPairingData(data))
        .catch((err) => setError(String(err)));
    } else {
      setPairingData(null);
      setError(null);
      invoke('revoke_pairing_token').catch(console.error);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#111111] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex justify-between items-center px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 rounded-lg">
              <Smartphone className="w-5 h-5 text-emerald-400" />
            </div>
            <h2 className="text-lg font-semibold text-white">Pair Mobile Device</h2>
          </div>
          <button 
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-8 flex flex-col items-center">
          {error ? (
            <div className="text-red-400 text-center mb-4">{error}</div>
          ) : !pairingData ? (
            <div className="text-zinc-400 text-center animate-pulse">Generating secure pairing token...</div>
          ) : (
            <>
              <div className="bg-white p-4 rounded-xl shadow-lg mb-6">
                <QRCodeSVG 
                  value={JSON.stringify(pairingData)} 
                  size={200}
                  level="H"
                  includeMargin={true}
                />
              </div>
              <p className="text-center text-zinc-300 font-medium mb-2">
                Scan with the Canopy iOS App
              </p>
              <p className="text-center text-zinc-500 text-sm">
                Make sure your phone is connected to the same Wi-Fi network as this Mac.
              </p>
              
              <div className="mt-8 flex items-center gap-2 text-xs text-zinc-500 font-mono bg-white/5 px-3 py-1.5 rounded-full">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                Relay active on {pairingData.ip}:{pairingData.port}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

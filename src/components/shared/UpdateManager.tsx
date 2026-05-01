import { useState, useEffect } from 'react';
import { check as tauriCheck, Update } from '@tauri-apps/plugin-updater';
const check = async (): Promise<Update | null> => {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    return tauriCheck();
  }
  return null;
};

export function UpdateManager() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [Installcomplete, setInstallcomplete] = useState(false);
  const [mandatory, setMandatory] = useState(false);

  useEffect(() => {
    async function checkForUpdates() {
      try {
        const _update = await check();
        if (_update) {
          setUpdate(_update);
          if (_update.body?.toLowerCase().includes('[mandatory]')) {
            setMandatory(true);
          }
        }
      } catch (err) {
        console.warn('Updater failed, which is expected without a real server.', err);
      } finally {
        setIsChecking(false);
      }
    }
    
    // Simulate a slight delay to allow Tauri internals to fully register on boot
    setTimeout(() => {
      checkForUpdates();
    }, 1500);
  }, []);

  if (!update) return null;

  const handleUpdate = async () => {
    try {
      setDownloading(true);
      setError(null);
      
      let downloadedBytes = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            setProgress(0);
            break;
          case 'Progress':
            downloadedBytes += event.data.chunkLength;
            if ((event.data as any).contentLength) {
              setProgress(Math.round((downloadedBytes / (event.data as any).contentLength) * 100));
            }
            break;
          case 'Finished':
            setProgress(100);
            break;
        }
      });
      setInstallcomplete(true);
      setDownloading(false);
    } catch (e: any) {
      setError(e.message || 'An error occurred during the update.');
      setDownloading(false);
    }
  };

  const modalStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: mandatory ? 'rgba(0, 0, 0, 0.8)' : 'rgba(0, 0, 0, 0.4)',
    pointerEvents: 'auto',
    zIndex: 99999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  };

  const dialogStyle: React.CSSProperties = {
    backgroundColor: '#fff',
    borderRadius: '12px',
    padding: '24px',
    maxWidth: '400px',
    width: '100%',
    boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
  };

  return (
    <div style={modalStyle}>
      <div style={dialogStyle}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '18px', color: '#1a1a1a', fontWeight: 600 }}>
          {mandatory ? 'Critical Update Required' : 'New Update Available'}
        </h3>
        
        {Installcomplete ? (
          <div>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#666' }}>
              Update installed successfully. Please restart Canopy to apply the changes.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button 
                onClick={() => setUpdate(null)}
                style={{ padding: '8px 16px', border: 'none', backgroundColor: '#3c6663', color: '#fff', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}
              >
                Close & Restart Later
              </button>
            </div>
          </div>
        ) : (
          <>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#666' }}>
              Version <strong style={{color: '#1a1a1a'}}>{update.version}</strong> is now available. {mandatory ? 'You must install this update to continue using Canopy.' : 'Would you like to install it now?'}
            </p>
            
            {update.body && (
              <div style={{ padding: '12px', backgroundColor: '#F5E6D8', borderRadius: '8px', marginBottom: '16px', fontSize: '13px', color: '#695a49', maxHeight: '150px', overflowY: 'auto' }}>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{update.body.replace('[mandatory]', '')}</pre>
              </div>
            )}

            {error && (
              <div style={{ color: '#d32f2f', fontSize: '13px', marginBottom: '16px', padding: '8px', backgroundColor: '#ffebee', borderRadius: '6px' }}>{error}</div>
            )}

            {downloading ? (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '12px', color: '#666' }}>
                  <span>Downloading update...</span>
                  <span>{progress}%</span>
                </div>
                <div style={{ height: '6px', backgroundColor: '#eee', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${progress}%`, backgroundColor: '#3c6663', transition: 'width 0.2s ease-out' }} />
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
                {!mandatory && (
                  <button 
                    onClick={() => setUpdate(null)}
                    style={{ padding: '8px 16px', border: 'none', background: 'transparent', color: '#666', cursor: 'pointer', borderRadius: '6px', fontWeight: 500 }}
                  >
                    Later
                  </button>
                )}
                <button 
                  onClick={handleUpdate}
                  style={{ padding: '8px 16px', border: 'none', backgroundColor: '#3c6663', color: '#fff', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, boxShadow: '0 2px 5px rgba(60, 102, 99, 0.3)' }}
                >
                  Install Update
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

import React, { useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { useWorldStore } from "../store/worldStore";

export function LockScreen() {
  const isCloaked = useWorldStore((s) => s.isCloaked);
  const setIsCloaked = useWorldStore((s) => s.setIsCloaked);
  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isCloaked) return null;

  const handleUnlock = async () => {
    setAuthenticating(true);
    setError(null);
    try {
      // In a real environment with WebAuthn or Tauri Biometric Plugin:
      // await navigator.credentials.get({ publicKey: ... })
      // For this implementation, we simulate the biometric delay.
      await new Promise((resolve) => setTimeout(resolve, 800));
      setIsCloaked(false);
    } catch (e) {
      setError("Authentication failed. Please try again.");
    } finally {
      setAuthenticating(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 999999, // Sit above everything
        background: "var(--bg-main)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(40px)",
      }}
    >
      <div
        style={{
          width: 320,
          background: "var(--surface-card)",
          borderRadius: 24,
          padding: "40px 32px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          boxShadow: "0 24px 64px rgba(0,0,0,0.15)",
          border: "1px solid var(--border-subtle)",
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: "#E1F2FF",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 24,
            color: "#3c6663",
          }}
        >
          {authenticating ? (
            <div style={{ animation: "spin 1s linear infinite" }}>
              <ShieldCheck size={32} />
            </div>
          ) : (
            <Lock size={32} />
          )}
        </div>

        <h2
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: "var(--text-main)",
            margin: "0 0 8px 0",
            textAlign: "center",
          }}
        >
          Canopy Locked
        </h2>
        <p
          style={{
            fontSize: 14,
            color: "var(--text-sub)",
            textAlign: "center",
            margin: "0 0 32px 0",
            lineHeight: 1.5,
          }}
        >
          Canopy is cloaked to protect your sensitive data and active agent
          tasks.
        </p>

        {error && (
          <div
            style={{
              color: "#EF4444",
              fontSize: 13,
              marginBottom: 16,
              textAlign: "center",
            }}
          >
            {error}
          </div>
        )}

        <button
          onClick={handleUnlock}
          disabled={authenticating}
          style={{
            width: "100%",
            padding: "14px 24px",
            borderRadius: 12,
            background: "#3c6663",
            color: "#fff",
            fontSize: 15,
            fontWeight: 600,
            border: "none",
            cursor: authenticating ? "default" : "pointer",
            transition: "all 0.2s ease",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            opacity: authenticating ? 0.7 : 1,
          }}
        >
          <ShieldCheck size={18} />
          {authenticating ? "Verifying..." : "Unlock Canopy"}
        </button>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

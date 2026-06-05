import React, { useState, useEffect } from "react";
import { Lock, ShieldCheck, Key } from "lucide-react";
import { useWorldStore } from "../store/worldStore";
import { invoke } from "@tauri-apps/api/core";

export function LockScreen() {
  const isCloaked = useWorldStore((s) => s.isCloaked);
  const setIsCloaked = useWorldStore((s) => s.setIsCloaked);
  const selectedAgent = useWorldStore((s) => s.selectedAgent);
  const agents = useWorldStore((s) => s.agents);

  const [authenticating, setAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPinInput, setShowPinInput] = useState(false);
  const [pin, setPin] = useState("");
  const [isBiometricSupported, setIsBiometricSupported] = useState(true);

  // Check if current agent has cloaking enabled (default is true)
  const currentAgent = agents.find(a => a.id === selectedAgent);
  const agentCloakEnabled = currentAgent ? (currentAgent.visual_identity?.cloak_enabled !== false) : true;

  const handleUnlock = async () => {
    setAuthenticating(true);
    setError(null);
    try {
      const result = await invoke<boolean>("authenticate_mac_user");
      if (result === true) {
        setIsCloaked(false);
        setShowPinInput(false);
        setError(null);
      } else {
        setError("Biometric authentication failed. Please enter your passcode.");
        setShowPinInput(true);
      }
    } catch (e: any) {
      const errStr = String(e);
      if (errStr.includes("UNSUPPORTED")) {
        setIsBiometricSupported(false);
      } else {
        setError("Biometric authentication failed. Please enter your passcode.");
      }
      setShowPinInput(true);
    } finally {
      setAuthenticating(false);
    }
  };

  useEffect(() => {
    if (isCloaked && agentCloakEnabled) {
      handleUnlock();
    }
  }, [isCloaked, agentCloakEnabled]);

  if (!isCloaked || !agentCloakEnabled) return null;

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin) return;
    setAuthenticating(true);
    setError(null);
    try {
      // First check if a passcode is set. If not, default to "1234"
      let isSet = false;
      try {
        const stored = await invoke<string>("get_secret_cmd", { key: "cloak_passcode" });
        if (stored) isSet = true;
      } catch {
        isSet = false;
      }

      if (!isSet) {
        if (pin === "1234") {
          setIsCloaked(false);
          setPin("");
          setShowPinInput(false);
        } else {
          setError("Incorrect passcode. Try default '1234' (no passcode is configured yet).");
        }
      } else {
        const verified = await invoke<boolean>("verify_cloak_passcode", { passcode: pin.trim() });
        if (verified === true) {
          setIsCloaked(false);
          setPin("");
          setShowPinInput(false);
        } else {
          setError("Incorrect passcode. Please try again.");
        }
      }
    } catch (err) {
      setError("Failed to verify passcode.");
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
        background: "rgba(10, 20, 20, 0.4)",
        backdropFilter: "blur(50px) saturate(180%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 340,
          background: "var(--glass-heavy, rgba(255, 255, 255, 0.75))",
          backdropFilter: "blur(20px)",
          borderRadius: 28,
          padding: "48px 36px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          boxShadow: "0 30px 70px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.4)",
          border: "1px solid rgba(255,255,255,0.4)",
          transition: "all 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #3c6663, #4A9E96)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 28,
            color: "#fff",
            boxShadow: "0 10px 25px rgba(60, 102, 99, 0.3)",
          }}
        >
          {authenticating ? (
            <div style={{ animation: "spin 1.2s linear infinite" }}>
              <ShieldCheck size={36} />
            </div>
          ) : showPinInput ? (
            <Key size={34} />
          ) : (
            <Lock size={34} />
          )}
        </div>

        <h2
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: "var(--text-main, #1a2a26)",
            margin: "0 0 10px 0",
            textAlign: "center",
            letterSpacing: "-0.02em",
          }}
        >
          Canopy Cloaked
        </h2>
        <p
          style={{
            fontSize: 13,
            color: "var(--text-sub, #4a5a56)",
            textAlign: "center",
            margin: "0 0 32px 0",
            lineHeight: 1.6,
          }}
        >
          Conversations are hidden to protect sensitive data and active agent operations.
        </p>

        {error && (
          <div
            style={{
              color: "#EF4444",
              fontSize: 12,
              fontWeight: 600,
              background: "rgba(239, 68, 68, 0.1)",
              padding: "10px 14px",
              borderRadius: 12,
              marginBottom: 20,
              textAlign: "center",
              width: "100%",
              boxSizing: "border-box",
              border: "1px solid rgba(239, 68, 68, 0.2)",
            }}
          >
            {error}
          </div>
        )}

        {showPinInput ? (
          <form onSubmit={handlePinSubmit} style={{ width: "100%" }}>
            <input
              autoFocus
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Enter passcode"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "14px 16px",
                borderRadius: 14,
                border: "1px solid rgba(0,0,0,0.1)",
                background: "rgba(255,255,255,0.8)",
                color: "var(--text-main)",
                fontSize: 15,
                fontWeight: 600,
                textAlign: "center",
                outline: "none",
                marginBottom: 16,
                boxShadow: "inset 0 1px 3px rgba(0,0,0,0.05)",
                transition: "all 0.2s ease",
              }}
            />
            <button
              type="submit"
              disabled={authenticating}
              style={{
                width: "100%",
                padding: "14px 24px",
                borderRadius: 14,
                background: "#3c6663",
                color: "#fff",
                fontSize: 15,
                fontWeight: 700,
                border: "none",
                cursor: authenticating ? "default" : "pointer",
                transition: "all 0.2s ease",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                opacity: authenticating ? 0.7 : 1,
                boxShadow: "0 6px 20px rgba(60,102,99,0.3)",
              }}
            >
              Verify Passcode
            </button>
            {isBiometricSupported && (
              <button
                type="button"
                onClick={handleUnlock}
                style={{
                  width: "100%",
                  marginTop: 14,
                  background: "transparent",
                  color: "#3c6663",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Use Touch ID
              </button>
            )}
          </form>
        ) : (
          <button
            onClick={handleUnlock}
            disabled={authenticating}
            style={{
              width: "100%",
              padding: "14px 24px",
              borderRadius: 14,
              background: "#3c6663",
              color: "#fff",
              fontSize: 15,
              fontWeight: 700,
              border: "none",
              cursor: authenticating ? "default" : "pointer",
              transition: "all 0.2s ease",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              opacity: authenticating ? 0.7 : 1,
              boxShadow: "0 6px 20px rgba(60,102,99,0.3)",
            }}
          >
            <ShieldCheck size={18} />
            {authenticating ? "Verifying..." : "Unlock Canopy"}
          </button>
        )}
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

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { 
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu, 
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight, 
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, UserProfile, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS } from "../store/worldStore";
import { GenerativeResult } from "../components/GenerativeStudio";
import { Toggle, ServiceRow, glass } from "../App";
import { TokenSpendChart } from "../components/agents/TokenSpendChart";

export // ═══════════════════════════════════════════════════════════════════════════════
// USER PROFILE VIEW
// ═══════════════════════════════════════════════════════════════════════════════


function UserProfileView() {
  const [profile, setProfile] = useState<UserProfile>({
    name: "Admin", email: "", phone: "", timezone: "UTC", working_hours: "9:00 AM - 5:00 PM",
    communication_tone: "Professional", global_directives: "Always cite your sources and optimize for safety."
  });
  const [saving, setSaving] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [passcodeSaved, setPasscodeSaved] = useState(false);

  useEffect(() => {
    if (typeof invoke === 'function') {
      invoke("get_user_profile").then((res: any) => setProfile(res)).catch(console.error);
      invoke("get_secret_cmd", { key: "cloak_passcode" })
        .then((res: any) => {
          if (res) setPasscode("••••••");
        })
        .catch(() => {});
    }
  }, []);

  const handleSavePasscode = async () => {
    if (typeof invoke === 'function' && passcode && passcode !== "••••••") {
      try {
        await invoke("store_secret_cmd", { key: "cloak_passcode", value: passcode.trim() });
        setPasscodeSaved(true);
      } catch (e) {
        console.error("Failed to save passcode:", e);
      }
    }
  };

  const handleSave = async () => {
    if (typeof invoke === 'function') {
      setSaving(true);
      await invoke("save_user_profile", { profile }).catch(console.error);
      setTimeout(() => setSaving(false), 600);
    }
  };

  const Field = ({ label, value, field, type = "text", placeholder = "", rows = 1 }: any) => (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginBottom: 6 }}>{label}</label>
      {rows > 1 ? (
        <textarea
          value={value} onChange={e => setProfile({ ...profile, [field]: e.target.value })}
          rows={rows} placeholder={placeholder}
          style={{ width: "100%", padding: "12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontFamily: "inherit", fontSize: 14, outline: "none", resize: "vertical" }}
        />
      ) : (
        <input
          type={type} value={value} onChange={e => setProfile({ ...profile, [field]: e.target.value })}
          placeholder={placeholder}
          style={{ width: "100%", padding: "12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontFamily: "inherit", fontSize: 14, outline: "none" }}
        />
      )}
    </div>
  );

  return (
    <div style={{ maxWidth: 700, margin: "40px auto", padding: "0 24px", paddingBottom: 100 }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0" }}>About me</h1>
        <p style={{ fontSize: 15, color: "var(--text-sub)", margin: 0 }}>What you tell us here is shared with every agent in your Canopy, so they understand who they're working for.</p>
      </div>

      <div style={{ background: "var(--glass-light)", backdropFilter: "blur(24px)", borderRadius: 16, border: "1px solid rgba(0,0,0,0.05)", padding: 24, marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#3c6663", margin: "0 0 16px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", paddingBottom: 8 }}>Identity & Contact</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <Field label="Full Name" field="name" value={profile.name} placeholder="e.g. Jane Doe" />
          <Field label="Preferred Timezone" field="timezone" value={profile.timezone} placeholder="e.g. America/Los_Angeles" />
          <Field label="Email Address" type="email" field="email" value={profile.email} placeholder="Agents can route reports here" />
          <Field label="Phone Number" type="tel" field="phone" value={profile.phone} placeholder="For SMS alerts" />
        </div>
      </div>

      <div style={{ background: "var(--glass-light)", backdropFilter: "blur(24px)", borderRadius: 16, border: "1px solid rgba(0,0,0,0.05)", padding: 24, marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#3c6663", margin: "0 0 16px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", paddingBottom: 8 }}>Working Directives</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
          <Field label="Working Hours" field="working_hours" value={profile.working_hours} placeholder="e.g. 9:00 AM - 5:00 PM EST" />
          <Field label="Communication Tone" field="communication_tone" value={profile.communication_tone} placeholder="e.g. Professional & Concise" />
        </div>
        <Field label="Global Agent Directives" field="global_directives" value={profile.global_directives} rows={3} placeholder="e.g. 'Never read my personal inbox. Always provide a TL;DR summary at the top.'" />
      </div>

      <div style={{ background: "var(--glass-light)", backdropFilter: "blur(24px)", borderRadius: 16, border: "1px solid rgba(0,0,0,0.05)", padding: 24, marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: "#3c6663", margin: "0 0 16px 0", borderBottom: "1px solid rgba(0,0,0,0.05)", paddingBottom: 8 }}>Security & Privacy</h3>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>Auto-Cloak Canopy</div>
            <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 4 }}>Automatically lock the app and hide message contents when you are away.</div>
          </div>
          <Toggle enabled={useWorldStore(s => s.isAutoCloakEnabled)} onChange={() => useWorldStore.getState().setAutoCloakEnabled(!useWorldStore.getState().isAutoCloakEnabled)} />
        </div>
        
        {useWorldStore(s => s.isAutoCloakEnabled) && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(0,0,0,0.05)" }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>Auto-lock after</div>
              <select 
                value={useWorldStore(s => s.autoCloakTimeout)}
                onChange={(e) => useWorldStore.getState().setAutoCloakTimeout(Number(e.target.value))}
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontFamily: "inherit", fontSize: 13, color: "var(--text-main)", outline: "none", cursor: "pointer" }}
              >
                <option value={1}>1 Minute</option>
                <option value={5}>5 Minutes</option>
                <option value={15}>15 Minutes</option>
                <option value={60}>1 Hour</option>
              </select>
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(0,0,0,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>Fallback Canopy Passcode</div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>Used when Touch ID / local auth fails or is unsupported.</div>
                </div>
                <input
                  type="password"
                  value={passcode}
                  onChange={e => {
                    setPasscode(e.target.value);
                    setPasscodeSaved(false);
                  }}
                  placeholder="e.g. 4-6 digits or password"
                  style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-card)", fontFamily: "inherit", fontSize: 13, color: "var(--text-main)", outline: "none", width: 180, textAlign: "center" }}
                />
              </div>
              {passcode && passcode !== "••••••" && !passcodeSaved && (
                <button
                  onClick={handleSavePasscode}
                  style={{ alignSelf: "flex-end", marginTop: 8, padding: "6px 16px", borderRadius: 8, background: "#3c6663", color: "white", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer", transition: "all 0.2s" }}
                >
                  Save Passcode
                </button>
              )}
              {passcodeSaved && (
                <div style={{ alignSelf: "flex-end", fontSize: 12, color: "#4A9E96", fontWeight: 600, marginTop: 4 }}>
                  Passcode updated successfully! ✓
                </div>
              )}
            </div>
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(0,0,0,0.05)" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>Share Anonymized Usage Stats</div>
            <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 4 }}>
              Helps us understand overall product usage. Sent with a random ID only — no message content,
              agent names, or anything else that could identify you or your agents.
            </div>
          </div>
          <Toggle
            enabled={useWorldStore(s => s.usageTelemetryEnabled)}
            onChange={() => useWorldStore.getState().setUsageTelemetryEnabled(!useWorldStore.getState().usageTelemetryEnabled)}
          />
        </div>
      </div>


      <div style={{ background: "var(--glass-light)", backdropFilter: "blur(24px)", borderRadius: 16, border: "1px solid rgba(0,0,0,0.05)", padding: 24, marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, borderBottom: "1px solid rgba(0,0,0,0.05)", paddingBottom: 8 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: "#3c6663", margin: 0 }}>Global Token Spend</h3>
          <button
            onClick={() => useWorldStore.getState().setActiveView("dashboard")}
            style={{ fontSize: 12, fontWeight: 600, color: "#3c6663", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
          >
            View full usage dashboard →
          </button>
        </div>
        <TokenSpendChart />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={handleSave} disabled={saving} style={{ padding: "12px 32px", borderRadius: 12, background: saving ? "#4A9E96" : "#3c6663", color: "var(--surface-card)", fontSize: 14, fontWeight: 600, border: "none", cursor: saving ? "default" : "pointer", transition: "all 0.2s ease" }}>
          {saving ? "Saved ✓" : "Save Profile Configuration"}
        </button>
      </div>
    </div>
  );
}
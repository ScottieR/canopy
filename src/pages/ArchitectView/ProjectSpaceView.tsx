import React, { useState } from "react";
import { AgentData, Conversation, useWorldStore } from "../../store/worldStore";
import { Folder, Users, Share2, Code, Plus, ArrowRight, Settings, MessageSquare, Terminal } from "lucide-react";
import { ChatTab } from "./ChatTab"; // We can reuse ChatTab or render a custom shared chat

export function ProjectSpaceView({ agent, space }: { agent: AgentData; space: Conversation }) {
  const [activeTab, setActiveTab] = useState<"chat" | "blackboard">("chat");
  const allAgents = useWorldStore(s => s.agents);
  
  // Mock a roster. Include the current agent, and maybe 1-2 others to show it's a multi-agent space
  const roster = allAgents.slice(0, 3); // Just grab first 3 as a visual mock

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", background: "var(--surface-base)" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 24px", borderBottom: "1px solid var(--border-subtle)",
        background: "var(--surface-card)"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "#3c6663", display: "flex", alignItems: "center", justifyContent: "center", color: "white" }}>
            <Folder size={18} />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)" }}>{space.title}</div>
            <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 2 }}>Collaborative Project Space</div>
          </div>
        </div>
        
        {/* Roster / Add Agents */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            {roster.map((a, i) => (
              <div key={a.id} style={{
                width: 28, height: 28, borderRadius: "50%", background: a.robeColor || "#CCC",
                border: "2px solid var(--surface-card)", marginLeft: i > 0 ? -8 : 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, color: "white", fontWeight: 700
              }} title={a.name}>
                {a.name.substring(0, 1).toUpperCase()}
              </div>
            ))}
            <button 
              onClick={() => alert("Invite Agent flow coming in Phase 3")}
              style={{
                width: 28, height: 28, borderRadius: "50%", background: "var(--surface-base)",
                border: "2px dashed var(--border-subtle)", marginLeft: -8,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--text-sub)", cursor: "pointer", zIndex: 1
              }} title="Invite Agent">
              <Plus size={12} />
            </button>
          </div>
          <div style={{ width: 1, height: 24, background: "var(--border-subtle)" }} />
          <button 
            onClick={() => alert("Manage Space settings coming in Phase 3")}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "transparent", color: "var(--text-sub)", border: "1px solid var(--border-subtle)", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
          >
            <Settings size={14} /> Manage Space
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        
        {/* Left Col: The Blackboard / Files */}
        <div style={{ flex: 2, borderRight: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", background: "var(--surface-base)" }}>
          <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => setActiveTab("chat")}
              style={{ padding: "6px 12px", background: activeTab === "chat" ? "rgba(60,102,99,0.08)" : "transparent", color: activeTab === "chat" ? "#3c6663" : "var(--text-sub)", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s ease" }}
            >
              Swarm Chat
            </button>
            <button
              onClick={() => setActiveTab("blackboard")}
              style={{ padding: "6px 12px", background: activeTab === "blackboard" ? "rgba(60,102,99,0.08)" : "transparent", color: activeTab === "blackboard" ? "#3c6663" : "var(--text-sub)", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.15s ease" }}
            >
              The Blackboard (Files)
            </button>
          </div>

          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {activeTab === "chat" ? (
              <div style={{ flex: 1, background: "var(--surface-base)", display: "flex", flexDirection: "column" }}>
                {/* For Phase 2 UI, we just render the standard ChatTab, but visually it is inside the project space */}
                <ChatTab agent={agent} compact={false} hideHeader={true} />
              </div>
            ) : (
              <div style={{ padding: 24, flex: 1, overflowY: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>Shared Context & Artifacts</div>
                  <button style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", background: "#3c6663", color: "white", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                    <Plus size={12} /> Add File
                  </button>
                </div>
                
                {/* Mock Files */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 12, display: "flex", gap: 12, padding: 16 }}>
                    <div style={{ color: "#D4A04A" }}><Code size={24} /></div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>project_plan.md</div>
                      <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 4 }}>Last edited by ProductManager</div>
                    </div>
                  </div>
                  <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 12, display: "flex", gap: 12, padding: 16 }}>
                    <div style={{ color: "#3c6663" }}><Terminal size={24} /></div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>index.css</div>
                      <div style={{ fontSize: 11, color: "var(--text-sub)", marginTop: 4 }}>Last edited by {agent.name}</div>
                    </div>
                  </div>
                </div>
                
                <div style={{ marginTop: 32, padding: 24, border: "1px dashed var(--border-subtle)", borderRadius: 12, textAlign: "center" }}>
                  <Share2 size={24} color="var(--text-muted)" style={{ marginBottom: 8 }} />
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-sub)" }}>Zero-Tax Whitelisting</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, maxWidth: 300, margin: "4px auto 0" }}>
                    Files dropped here are automatically accessible to all agents in this space.
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Col: Activity Feed / The Bleachers */}
        <div style={{ flex: 1, background: "var(--surface-card)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: 12, fontWeight: 700, color: "var(--text-main)" }}>
            Swarm Activity
          </div>
          <div style={{ padding: 16, flex: 1, overflowY: "auto" }}>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#3c6663", marginTop: 5, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 12, color: "var(--text-main)", lineHeight: 1.4 }}><strong>{agent.name}</strong> created the space.</div>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>Just now</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-muted)", marginTop: 5, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 12, color: "var(--text-main)", lineHeight: 1.4 }}>Waiting for other agents to join...</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

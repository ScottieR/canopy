import React, { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorldStore, AgentData } from "../../store/worldStore";
import { ChatTab } from "../../pages/ArchitectView/ChatTab";

export function ChatCompanion() {
  const searchParams = new URLSearchParams(window.location.search);
  const agentId = searchParams.get("chatCompanion") || "";
  const agents = useWorldStore((s) => s.agents);
  const setAgents = useWorldStore((s) => s.setAgents);
  const setGatewayReady = useWorldStore((s) => s.setGatewayReady);
  const agent = agents.find((a) => a.id === agentId);

  useEffect(() => {
    // Companion chat is explicitly spawned so we can safely assume the gateway is up.
    setGatewayReady(true);
    // If store is empty, fetch agents
    if (agents.length === 0) {
      invoke<AgentData[]>("get_agents")
        .then((data) => {
          setAgents(data);
        })
        .catch(console.error);
    }
  }, [agents.length, setAgents]);

  if (!agent) {
    return (
      <div
        data-tauri-drag-region
        style={{
          width: "100%",
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--surface-base)",
          color: "var(--text-sub)",
          fontFamily: "'Geist', sans-serif",
        }}
      >
        Loading agent context...
      </div>
    );
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        background: "var(--surface-base)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <ChatTab agent={agent} compact={true} />
      </div>
    </div>
  );
}

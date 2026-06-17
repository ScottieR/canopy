import React, { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorldStore, AgentData } from "../store/worldStore";

export function MiniAppStandalone({ payload }: { payload: string }) {
  const { agentId, appId } = JSON.parse(decodeURIComponent(payload));
  const agents = useWorldStore((s) => s.agents);
  const setAgents = useWorldStore((s) => s.setAgents);
  const setGatewayReady = useWorldStore((s) => s.setGatewayReady);

  useEffect(() => {
    setGatewayReady(true);
    if (agents.length === 0) {
      invoke<AgentData[]>("get_agents")
        .then((data) => {
          setAgents(data);
        })
        .catch(console.error);
    }
  }, [agents.length, setAgents, setGatewayReady]);

  if (agents.length === 0) {
    return (
      <div style={{ width: "100%", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-base)", color: "var(--text-sub)", fontFamily: "'Geist', sans-serif" }}>
        Loading agent context...
      </div>
    );
  }

  const agent = agents.find((a) => a.id === agentId);
  const app = agent?.miniApps?.find((m) => m.id === appId);

  if (!app) {
    return (
      <div style={{ width: "100%", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-base)", color: "var(--text-sub)", fontFamily: "'Geist', sans-serif" }}>
        Mini app not found.
      </div>
    );
  }
  const activeVersion = app.versions?.find((v: any) => v.id === app.activeVersionId) || app.versions?.[0];

  if (!activeVersion) {
    if (app.htmlContent) {
      // Legacy fallback for apps saved before the multi-file schema
      return (
        <div style={{ width: "100%", height: "100vh", background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <iframe
            srcDoc={app.htmlContent}
            style={{ flex: 1, border: "none", width: "100%" }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            title={app.name}
          />
        </div>
      );
    }
    return (
      <div style={{ width: "100%", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-base)", color: "var(--text-sub)", fontFamily: "'Geist', sans-serif" }}>
        Mini app version not found.
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100vh", background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <iframe
        src={`canopy-workspace://${agentId}/${encodeURIComponent(activeVersion.entrypoint)}`}
        style={{ flex: 1, border: "none", width: "100%" }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        title={app.name}
      />
    </div>
  );
}

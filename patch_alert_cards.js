const fs = require('fs');
const file = 'src/components/DecisionQueue/AlertCards.tsx';
let content = fs.readFileSync(file, 'utf8');

const updatedSystemWarning = `
export function SystemWarningCard({ warning }: { warning: SystemWarning }) {
  const { agents, resolveSystemWarningState } = useWorldStore();
  const agent = agents.find(a => a.id === warning.agent_id);

  const handleResolve = async () => {
    try {
      await invoke("resolve_system_warning", { warningId: warning.id });
      resolveSystemWarningState(warning.id);
    } catch (e) {
      console.error(e);
    }
  };

  const handleFixAction = async () => {
    try {
      if (warning.warning_type === "slack_auth_error" || warning.message.toLowerCase().includes("slack")) {
        await invoke("start_slack_oauth", { agentId: warning.agent_id });
      }
      // If there are other warning types, handle them here
      handleResolve();
    } catch (e) {
      console.error("Action failed:", e);
    }
  };

  const hasFixAction = warning.warning_type === "slack_auth_error" || warning.message.toLowerCase().includes("slack");

  return (
    <div style={{ background: "var(--surface-card)", border: "1px solid #FCD34D", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ background: "#FFFBEB", padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #FCD34D" }}>
        <AlertTriangle size={14} color="#D97706" />
        <div style={{ fontSize: 11, fontWeight: 700, color: "#D97706", textTransform: "uppercase", letterSpacing: "0.05em" }}>System Warning</div>
      </div>
      <div style={{ padding: 12 }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Agent: {agent?.name || warning.agent_id}</div>
        <div style={{ fontSize: 13, color: "var(--text-main)", lineHeight: 1.4, marginBottom: 12 }}>{warning.message}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleResolve} style={{ flex: 1, padding: "6px 0", background: "transparent", border: "1px solid var(--border-subtle)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", color: "var(--text-main)" }}>
            Dismiss
          </button>
          {hasFixAction && (
            <button onClick={handleFixAction} style={{ flex: 1, padding: "6px 0", background: "#D97706", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", color: "white" }}>
              Fix Issue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
`;

// Extract old component
const parts = content.split("export function SystemWarningCard");
content = parts[0] + updatedSystemWarning;
fs.writeFileSync(file, content);
console.log("Updated AlertCards.tsx");

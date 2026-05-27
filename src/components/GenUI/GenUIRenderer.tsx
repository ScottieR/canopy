import React from 'react';

// The universal GenUI component registry
// In the future, this can be dynamically loaded or expanded by agents proposing new ones.

interface MiniAppPayload {
  component: string;
  props: Record<string, any>;
  target: "inline" | "canvas";
}

// 1. Core Platform Component: ApprovalCard
function ApprovalCard({ props, onEvent }: { props: any; onEvent: (evt: any) => void }) {
  const { title, details, options = ["Approve", "Reject"] } = props;
  return (
    <div style={{ padding: 12, background: "var(--surface-container-low, #f9f9f9)", border: "1px solid var(--border-subtle)", borderRadius: 8, marginTop: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{title || "Approval Required"}</div>
      {details && <div style={{ fontSize: 12, color: "var(--text-sub)", marginBottom: 12 }}>{details}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        {options.map((opt: string) => (
          <button 
            key={opt}
            onClick={() => onEvent({ action: "approve_decision", decision: opt })}
            style={{ padding: "6px 12px", background: opt === "Approve" ? "#4A9E96" : "var(--surface-card)", color: opt === "Approve" ? "#fff" : "var(--text-main)", border: opt === "Approve" ? "none" : "1px solid var(--border-subtle)", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer" }}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

// 2. Core Platform Component: DataTable
function DataTable({ props }: { props: any }) {
  const { columns = [], rows = [] } = props;
  return (
    <div style={{ marginTop: 8, overflowX: "auto", border: "1px solid var(--border-subtle)", borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead style={{ background: "var(--surface-container-low)" }}>
          <tr>
            {columns.map((col: string, i: number) => (
              <th key={i} style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "var(--text-sub)", borderBottom: "1px solid var(--border-subtle)" }}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row: any[], i: number) => (
            <tr key={i} style={{ borderBottom: i === rows.length - 1 ? "none" : "1px solid rgba(0,0,0,0.04)" }}>
              {row.map((cell: any, j: number) => (
                <td key={j} style={{ padding: "6px 10px", color: "var(--text-main)" }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 3. The "Propose New Component" fallback: Custom HTML
function CustomHtml({ props, attachments }: { props: any, attachments?: any[] }) {
  // Danger zone: in production this needs DOMPurify or to run in an iframe.
  // For the GenUI spec, this demonstrates the capability.
  let html = props.html || "";
  
  // Inject base64 image data for local attachments
  if (attachments && attachments.length > 0) {
    attachments.forEach(att => {
      // Replace instances of the filename with its base64 dataUrl
      // This handles cases like <img src="photo.jpg">
      const regex = new RegExp(`src=["']?([^"'>]*${att.name})["']?`, 'g');
      html = html.replace(regex, `src="${att.dataUrl}"`);
    });
  }

  return (
    <div 
      style={{ marginTop: 8, padding: 8, background: "#fff", border: "1px dashed #ccc", borderRadius: 8 }}
      dangerouslySetInnerHTML={{ __html: html }} 
    />
  );
}

export function GenUIRenderer({ app, onEvent, attachments }: { app: MiniAppPayload; onEvent: (evt: any) => void; attachments?: any[] }) {
  switch (app.component) {
    case "ApprovalCard":
      return <ApprovalCard props={app.props} onEvent={onEvent} />;
    case "DataTable":
      return <DataTable props={app.props} />;
    case "Html":
      return <CustomHtml props={app.props} attachments={attachments} />;
    default:
      return (
        <div style={{ padding: 8, fontSize: 11, color: "#d97706", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 6, marginTop: 8 }}>
          <strong>Unknown GenUI Component:</strong> {app.component}
        </div>
      );
  }
}

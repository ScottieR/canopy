import React, { useState } from 'react';

export function ExportForumModal({ onClose, forum }: { onClose: () => void, forum: any }) {
  const [target, setTarget] = useState<'local' | 'drive'>('local');
  
  // A mock of what it might look like: mapping the forum content
  const preview = `Title: ${forum.brief || "Untitled Project"}\nStatus: ${forum.status}\nAgents: ${(forum.agents || []).map((a: any) => a.name).join(", ")}\n\nFormat mapping:\n- Messages -> HTML/Markdown log\n- Artifacts -> Extracted files\n- Canvas -> ${target === 'local' ? 'index.html' : 'Google Doc'}`;

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9999
    }}>
      <div style={{
        background: "white", padding: 24, borderRadius: 12, width: 480,
        display: "flex", flexDirection: "column", gap: 16,
        boxShadow: "0 10px 40px rgba(0,0,0,0.2)"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "#2D3436" }}>Export Forum</h2>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 20, color: "#636E72" }}>&times;</button>
        </div>
        
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={() => setTarget('local')} style={{
            flex: 1, padding: "10px", borderRadius: 8, cursor: "pointer",
            border: target === 'local' ? "2px solid #4A9E96" : "1px solid #DFE6E9",
            background: target === 'local' ? "rgba(74,158,150,0.1)" : "transparent",
            color: target === 'local' ? "#4A9E96" : "#2D3436",
            fontWeight: target === 'local' ? 600 : 400
          }}>Local Download</button>
          <button onClick={() => setTarget('drive')} style={{
            flex: 1, padding: "10px", borderRadius: 8, cursor: "pointer",
            border: target === 'drive' ? "2px solid #4A9E96" : "1px solid #DFE6E9",
            background: target === 'drive' ? "rgba(74,158,150,0.1)" : "transparent",
            color: target === 'drive' ? "#4A9E96" : "#2D3436",
            fontWeight: target === 'drive' ? 600 : 400
          }}>Google Drive</button>
        </div>

        <div>
          <h3 style={{ margin: "0 0 8px 0", fontSize: 14, color: "#2D3436" }}>Format Mapping Preview</h3>
          <pre style={{
            background: "#F8F9FA", padding: 12, borderRadius: 8,
            fontSize: 12, color: "#636E72", whiteSpace: "pre-wrap",
            margin: 0, border: "1px solid #DFE6E9"
          }}>
            {preview}
          </pre>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <button onClick={onClose} style={{
            padding: "8px 16px", borderRadius: 6, border: "1px solid #DFE6E9",
            background: "transparent", color: "#636E72", cursor: "pointer"
          }}>Cancel</button>
          <button onClick={() => {
            alert(`Exporting to ${target}...`);
            onClose();
          }} style={{
            padding: "8px 16px", borderRadius: 6, border: "none",
            background: "#4A9E96", color: "white", cursor: "pointer",
            fontWeight: 600
          }}>Export</button>
        </div>
      </div>
    </div>
  );
}

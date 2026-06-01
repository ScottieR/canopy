/**
 * HistoryPanel.tsx
 *
 * Unified chronological history for a forum:
 *   – Blackboard snapshots (in-session, from forumStore.blackboardHistory)
 *   – Project file snapshots (persistent, from .canopy/history/ via Tauri)
 *
 * Each entry shows: who, when, what changed, with a word-level diff and a
 * one-click Restore button.  No branches, no merging — pure linear history.
 */

import React, { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { diffText, type DiffOp } from "../../utils/diff";
import type { Forum } from "../../store/forumStore";

// ─── Types ───────────────────────────────────────────────────────────────────

interface BlackboardEntry {
  kind: "blackboard";
  id: string;
  timestamp: number;
  agentId?: string;
  agentName?: string; // resolved from forum.agents
  content: string;    // blackboard content at this moment
}

interface FileEntry {
  kind: "file";
  id: string;
  timestamp: number;
  forumId: string;
  artifactId: string;
  filename: string;
  folder: string;
  action: "created" | "modified";
  prevContent?: string;
}

type HistoryEntry = BlackboardEntry | FileEntry;

// ─── Diff renderer ───────────────────────────────────────────────────────────

function DiffView({ prev, next }: { prev: string; next: string }) {
  const ops: DiffOp[] = React.useMemo(() => diffText(prev, next), [prev, next]);

  return (
    <div style={{
      fontSize: 11.5, lineHeight: 1.7, fontFamily: "inherit",
      padding: "12px 16px", overflowY: "auto", maxHeight: 340,
      background: "rgba(0,0,0,0.02)", borderRadius: 8,
      border: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
    }}>
      {ops.map((op, i) => {
        if (op.type === "equal") {
          return <span key={i} style={{ color: "var(--text-main, #303330)" }}>{op.text}</span>;
        }
        if (op.type === "insert") {
          return (
            <span key={i} style={{
              background: "rgba(74,158,150,0.18)", color: "#2d6b67",
              borderRadius: 3, padding: "0 1px",
            }}>
              {op.text}
            </span>
          );
        }
        return (
          <span key={i} style={{
            background: "rgba(239,68,68,0.12)", color: "#b91c1c",
            textDecoration: "line-through", borderRadius: 3, padding: "0 1px",
            opacity: 0.75,
          }}>
            {op.text}
          </span>
        );
      })}
    </div>
  );
}

// ─── Single history entry row ─────────────────────────────────────────────────

function EntryRow({
  entry,
  currentBlackboard,
  isSelected,
  onSelect,
  onRestore,
  agentName,
}: {
  entry: HistoryEntry;
  currentBlackboard: string;
  isSelected: boolean;
  onSelect: () => void;
  onRestore: () => void;
  agentName?: string;
}) {
  const ago = React.useMemo(() => {
    const s = Math.floor((Date.now() - entry.timestamp) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(entry.timestamp).toLocaleDateString();
  }, [entry.timestamp]);

  const isBlackboard = entry.kind === "blackboard";
  const isFile = entry.kind === "file";

  const label = isBlackboard
    ? "Blackboard updated"
    : entry.action === "created"
      ? `${entry.filename} created`
      : `${entry.filename} updated`;

  const who = agentName ?? (isBlackboard ? entry.agentId?.slice(0, 12) : undefined) ?? "System";

  return (
    <div style={{ borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.05))" }}>
      {/* Row header */}
      <button
        onClick={onSelect}
        style={{
          width: "100%", textAlign: "left", border: "none", cursor: "pointer",
          padding: "9px 14px",
          background: isSelected ? "rgba(74,158,150,0.07)" : "transparent",
          display: "flex", alignItems: "flex-start", gap: 10,
        }}
      >
        {/* Icon */}
        <div style={{
          width: 22, height: 22, borderRadius: "50%", flexShrink: 0, marginTop: 1,
          background: isBlackboard ? "rgba(74,158,150,0.12)" : "rgba(129,140,248,0.12)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {isBlackboard ? (
            <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="#4A9E96" strokeWidth={2.5} strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
          ) : (
            <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="#818CF8" strokeWidth={2.5} strokeLinecap="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 500, color: "var(--text-main, #303330)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {label}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-sub, #636E72)", marginTop: 1, display: "flex", gap: 6 }}>
            <span>{who}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>{ago}</span>
            {isFile && entry.folder && (
              <>
                <span style={{ opacity: 0.4 }}>·</span>
                <span style={{ opacity: 0.65 }}>{entry.folder}</span>
              </>
            )}
          </div>
        </div>

        <svg
          width={10} height={10} viewBox="0 0 24 24" fill="none"
          stroke="var(--text-sub, #636E72)" strokeWidth={2.5} strokeLinecap="round"
          style={{ transform: isSelected ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s ease", flexShrink: 0, marginTop: 6, opacity: 0.4 }}
        >
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>

      {/* Expanded diff + restore */}
      {isSelected && (
        <div style={{ padding: "0 14px 12px 46px" }}>
          {isBlackboard && (
            <DiffView
              prev={entry.content}
              next={currentBlackboard}
            />
          )}
          {isFile && entry.action === "modified" && entry.prevContent !== undefined && (
            <DiffView prev={entry.prevContent} next="(current version)" />
          )}
          {isFile && entry.action === "created" && (
            <div style={{
              fontSize: 11, color: "var(--text-sub, #636E72)", fontStyle: "italic",
              padding: "8px 12px", background: "rgba(129,140,248,0.06)",
              borderRadius: 6, border: "1px solid rgba(129,140,248,0.12)",
            }}>
              File created at this point. Restore will delete it (the version before creation).
            </div>
          )}

          <button
            onClick={e => { e.stopPropagation(); onRestore(); }}
            style={{
              marginTop: 8,
              background: "rgba(74,158,150,0.1)", border: "1px solid rgba(74,158,150,0.25)",
              color: "#4A9E96", borderRadius: 6, padding: "4px 12px",
              fontSize: 11, fontWeight: 600, cursor: "pointer",
            }}
          >
            ↩ Restore to this version
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

export function HistoryPanel({
  forum,
  onRestoreBlackboard,
  onClose,
}: {
  forum: Forum;
  onRestoreBlackboard: (content: string) => void;
  onClose: () => void;
}) {
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoreToast, setRestoreToast] = useState<string | null>(null);

  // Build agent name lookup from forum
  const agentNames = React.useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of forum.agents ?? []) m[a.agentId] = a.name;
    return m;
  }, [forum.agents]);

  // Load project file history from disk
  const connectedFolderPath = (forum as any).connectedFolderPath as string | undefined;
  useEffect(() => {
    if (!connectedFolderPath) return;
    setLoadingFiles(true);
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<FileEntry[]>("list_artifact_history", {
        folderPath: connectedFolderPath,
        forumTitle: forum.title,
      })
    ).then(entries => {
      setFileEntries(entries.map(e => ({ ...e, kind: "file" as const })));
    }).catch(() => {
      setFileEntries([]);
    }).finally(() => setLoadingFiles(false));
  }, [connectedFolderPath, forum.title]);

  // Build unified timeline
  const entries: HistoryEntry[] = React.useMemo(() => {
    const bb: BlackboardEntry[] = (forum.blackboardHistory ?? []).map((snap, i) => ({
      kind: "blackboard" as const,
      id: `bb-${i}`,
      timestamp: snap.timestamp,
      agentId: snap.agentId,
      agentName: snap.agentId ? agentNames[snap.agentId] : undefined,
      content: snap.content,
    }));
    return [...bb, ...fileEntries].sort((a, b) => b.timestamp - a.timestamp);
  }, [forum.blackboardHistory, fileEntries, agentNames]);

  const handleRestore = useCallback(async (entry: HistoryEntry) => {
    if (entry.kind === "blackboard") {
      onRestoreBlackboard(entry.content);
      setRestoreToast(`Blackboard restored to ${new Date(entry.timestamp).toLocaleTimeString()}`);
      setSelectedId(null);
    } else {
      if (!connectedFolderPath) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("restore_artifact_snapshot", {
          folderPath: connectedFolderPath,
          forumTitle: forum.title,
          snapshotId: entry.id,
          folder: entry.folder,
          filename: entry.filename,
          prevContent: entry.prevContent ?? "",
        });
        setRestoreToast(`Restored ${entry.filename}`);
        setSelectedId(null);
      } catch (err) {
        setRestoreToast(`Restore failed: ${err}`);
      }
    }
    setTimeout(() => setRestoreToast(null), 4000);
  }, [connectedFolderPath, forum.title, onRestoreBlackboard]);

  return (
    <div style={{
      width: 320, flexShrink: 0, display: "flex", flexDirection: "column",
      borderLeft: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
      background: "var(--bg-main, #faf9f6)",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "10px 14px 8px", flexShrink: 0,
        borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.07))",
        display: "flex", alignItems: "center", gap: 7,
      }}>
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#4A9E96" strokeWidth={2.5} strokeLinecap="round">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-sub, #636E72)", flex: 1 }}>
          History
        </span>
        {loadingFiles && (
          <span style={{ fontSize: 9, color: "var(--text-sub, #636E72)", opacity: 0.5, fontStyle: "italic" }}>loading files…</span>
        )}
        <button
          onClick={onClose}
          style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-sub, #636E72)", opacity: 0.4, padding: 2 }}
        >
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Legend */}
      <div style={{ padding: "6px 14px", flexShrink: 0, display: "flex", gap: 12, borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.05))" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "var(--text-sub, #636E72)", opacity: 0.65 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(74,158,150,0.3)" }} />
          Blackboard
        </div>
        {connectedFolderPath && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "var(--text-sub, #636E72)", opacity: 0.65 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(129,140,248,0.3)" }} />
            Project files
          </div>
        )}
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {entries.length === 0 ? (
          <div style={{ padding: "24px 16px", fontSize: 11, color: "var(--text-sub, #636E72)", opacity: 0.45, fontStyle: "italic", textAlign: "center", lineHeight: 1.6 }}>
            History will appear as agents work and files are synced.
          </div>
        ) : (
          entries.map(entry => (
            <EntryRow
              key={entry.id}
              entry={entry}
              currentBlackboard={forum.blackboardContent}
              isSelected={selectedId === entry.id}
              onSelect={() => setSelectedId(prev => prev === entry.id ? null : entry.id)}
              onRestore={() => handleRestore(entry)}
              agentName={entry.kind === "blackboard" ? (entry.agentId ? agentNames[entry.agentId] : undefined) : undefined}
            />
          ))
        )}
      </div>

      {/* Restore toast */}
      {restoreToast && (
        <div style={{
          margin: "0 10px 10px",
          padding: "7px 12px", borderRadius: 7,
          background: "rgba(74,158,150,0.12)", border: "1px solid rgba(74,158,150,0.25)",
          fontSize: 11, color: "#4A9E96", fontWeight: 500, flexShrink: 0,
        }}>
          ↩ {restoreToast}
        </div>
      )}
    </div>
  );
}

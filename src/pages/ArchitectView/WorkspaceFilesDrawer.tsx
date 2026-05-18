// WorkspaceFilesDrawer — floating popover triggered from a quick-action pill.
//
// Earlier shape was a vertical left rail; that real-estate now belongs to the
// chat threads (ThreadsRail). Files are a secondary concern, so they're now a
// popover the user opens explicitly. Same internals (search, list, peek,
// upload, 6s poll) — just floats instead of taking a permanent column.
//
// Mini-apps will get their own dedicated home and won't appear here — files
// and apps are different concepts even though both could surface from
// workspace artifacts.

import React, { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentData } from "../../store/worldStore";
import { glass } from "../../App";

type WorkspaceFileEntry = {
  name: string;
  size_bytes: number;
  modified_unix: number;
};

// Pretty-print bytes for the list. Short forms keep the row compact.
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Relative time, capped at "just now" precision — exact timestamps aren't
// useful here, the user just wants to know if it's fresh.
function formatRelative(unixSec: number): string {
  if (!unixSec) return "—";
  const now = Math.floor(Date.now() / 1000);
  const delta = now - unixSec;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

// Tiny SVG glyph per file family. Keeps icons consistent without pulling more
// icon weight from lucide-react.
function fileGlyph(name: string): React.ReactNode {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  // Image
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext || "")) {
    return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>;
  }
  // Code / config
  if (["json", "ts", "tsx", "js", "py", "rs", "yaml", "yml", "toml"].includes(ext || "")) {
    return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
  }
  // Markdown / text
  if (["md", "txt", "rst"].includes(ext || "")) {
    return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>;
  }
  // Fallback
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>;
}

export function WorkspaceFilesDrawer({
  agent, open, onClose,
}: {
  agent: AgentData;
  open: boolean;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Filename search. We intentionally don't search file CONTENT here —
  // that would mean reading every file on every keystroke. Filename match
  // covers the common case ("notes.md", "todo.txt"); content search can be
  // added as a follow-up command that pre-builds an index.
  const [query, setQuery] = useState("");
  // Upload state — surfaced inline so the user gets feedback while a big
  // file is being read/encoded/written.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Peeking a file expands an inline reader pane. We hold both the name and a
  // best-effort string body. Long files are truncated by the Rust read; we
  // truncate again here for safety.
  const [peeked, setPeeked] = useState<{ name: string; body: string } | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<WorkspaceFileEntry[]>("list_workspace_files", { agentId: agent.id });
      setFiles(Array.isArray(result) ? result : []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  // Initial fetch + lightweight poll. 6s is fast enough to catch agent writes
  // while idle, slow enough not to thrash IO. The interval only runs while
  // the drawer is open — collapsed users pay nothing.
  useEffect(() => {
    if (!open) return;
    let isPolling = false;
    const poll = async () => {
      if (isPolling) return;
      isPolling = true;
      try { await fetchFiles(); }
      finally { isPolling = false; }
    };
    poll();
    const t = setInterval(poll, 6000);
    return () => clearInterval(t);
  }, [open, fetchFiles]);

  // Open/closed state is now parent-controlled (the trigger pill in the
  // quick-actions row). No persistence — the popover is meant to be opened
  // intentionally, not left hanging.

  // Read a File as a dataURL — Promise wrapper around FileReader.
  const readAsDataURL = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });

  // Upload one or more files directly to the agent's workspace. Same path
  // chat attachments take (`upload_workspace_file`), so the agent can see
  // these files exactly the same way. Refreshes the file list on success.
  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const files = Array.from(fileList);
      for (const file of files) {
        // Sanitize the filename — the Rust side rejects path traversal
        // characters, but we strip them here too so the user gets a clean
        // name in the drawer instead of a backend error.
        const safeName = file.name.replace(/[\\/]/g, "_").replace(/\.\./g, "_");
        const dataUrl = await readAsDataURL(file);
        await invoke("upload_workspace_file", {
          agentId: agent.id,
          filename: safeName,
          base64Data: dataUrl,
        });
      }
      await fetchFiles();
    } catch (e) {
      setUploadError(`Upload failed: ${e}`);
    } finally {
      setUploading(false);
      // Clear the input so the same file can be re-selected if the user wants.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const openPeek = async (name: string) => {
    setPeeked({ name, body: "" });
    setPeekLoading(true);
    try {
      const body = await invoke<string>("read_workspace_file", { agentId: agent.id, filename: name });
      // Cap the in-memory body so a huge file doesn't blow up the panel.
      const TRUNCATE = 16 * 1024;
      const truncated = (body || "").length > TRUNCATE
        ? body.slice(0, TRUNCATE) + "\n\n… (truncated — open file to see the rest)"
        : (body || "(empty file)");
      setPeeked({ name, body: truncated });
    } catch (e) {
      setPeeked({ name, body: `Couldn't read this file: ${e}` });
    } finally {
      setPeekLoading(false);
    }
  };

  // Popover closed — render nothing. The trigger lives in the parent.
  if (!open) return null;

  return (
    <div style={{
      // Floats below the trigger button. The parent wraps the trigger in a
      // position:relative container so this absolutely-positioned popover
      // anchors correctly. z-index keeps it above the chat panel.
      position: "absolute", top: "calc(100% + 8px)", right: 0,
      width: 320, maxHeight: 480, display: "flex", flexDirection: "column",
      background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
      borderRadius: 14, overflow: "hidden", minHeight: 0, zIndex: 50,
      boxShadow: "0 12px 32px rgba(0,0,0,0.12)",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 12px", borderBottom: "1px solid var(--border-subtle)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-sub)" }}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)" }}>Workspace</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {/* Upload — drops one or more files into the agent's workspace so it
              can see them on the next message. Hidden file input fires off the
              picker on click. */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title={uploading ? "Uploading…" : `Upload files for ${agent.name} to work on`}
            style={{
              border: "1px solid var(--border-subtle)", background: "var(--surface-base)",
              cursor: uploading ? "wait" : "pointer", color: "var(--text-main)",
              display: "flex", alignItems: "center", gap: 4, padding: "3px 8px",
              borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: "inherit",
              opacity: uploading ? 0.6 : 1,
            }}
          >
            {uploading ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}>
                <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            )}
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={e => handleUpload(e.target.files)}
          />
          <button
            onClick={onClose}
            title="Close"
            style={{
              border: "none", background: "transparent", cursor: "pointer",
              color: "var(--text-sub)", display: "flex", alignItems: "center", padding: 2,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      {/* Upload error — inline below header so the user sees what failed and
          can try again. Auto-dismisses on next successful upload. */}
      {uploadError && (
        <div style={{
          padding: "6px 12px", fontSize: 10, color: "#C62828",
          background: "rgba(198,40,40,0.06)", borderBottom: "1px solid rgba(198,40,40,0.2)",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
        }}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{uploadError}</span>
          <button onClick={() => setUploadError(null)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "#C62828", padding: 0, display: "flex", flexShrink: 0 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      )}

      {/* Search row — appears once the drawer has any files. Filters by
          filename (case-insensitive substring). Hidden in the empty state so
          the first-run experience stays clean. */}
      {files.length > 0 && (
        <div style={{
          padding: "6px 10px", borderBottom: "1px solid var(--border-subtle)",
          display: "flex", alignItems: "center", gap: 6, background: "var(--surface-base)",
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-sub)", flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape" && query) setQuery(""); }}
            placeholder="Search files…"
            style={{
              flex: 1, border: "none", background: "transparent",
              outline: "none", fontSize: 11, color: "var(--text-main)",
              fontFamily: "inherit", padding: "2px 0",
            }}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title="Clear search"
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", padding: 0, display: "flex" }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>
      )}

      {/* File list */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {(() => {
          // Filtered view. Filename-only match — content search would mean
          // reading every file on every keystroke, which the runtime budget
          // doesn't justify. See the `query` declaration comment for the
          // follow-up index path.
          const q = query.trim().toLowerCase();
          const filteredFiles = !q ? files : files.filter(f => f.name.toLowerCase().includes(q));
          if (loading && files.length === 0) {
            return <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>Looking…</div>;
          }
          if (error) {
            return <div style={{ padding: 16, fontSize: 11, color: "#E57373" }}>Couldn't list files: {error}</div>;
          }
          if (files.length === 0) {
            return (
              <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--text-sub)" }}>Empty workspace.</strong> Drop files in with{" "}
                <strong>Upload</strong> above, or wait for {agent.name} to create something.
              </div>
            );
          }
          if (filteredFiles.length === 0) {
            return (
              <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
                No files match "{query}".
              </div>
            );
          }
          return (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {filteredFiles.map(f => {
              const isPeeked = peeked?.name === f.name;
              return (
                <div key={f.name}>
                  <button
                    onClick={() => isPeeked ? setPeeked(null) : openPeek(f.name)}
                    title="Peek contents"
                    style={{
                      width: "100%", padding: "8px 12px", border: "none",
                      background: isPeeked ? "rgba(60,102,99,0.07)" : "transparent",
                      cursor: "pointer", textAlign: "left", display: "flex",
                      alignItems: "center", gap: 8, fontFamily: "inherit",
                      borderBottom: "1px solid rgba(0,0,0,0.04)",
                    }}
                  >
                    <span style={{ color: "var(--text-sub)", flexShrink: 0, display: "flex" }}>{fileGlyph(f.name)}</span>
                    <span style={{
                      flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600,
                      color: "var(--text-main)", whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis",
                    }}>{f.name}</span>
                    <span style={{ fontSize: 10, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {formatRelative(f.modified_unix)}
                    </span>
                  </button>
                  {isPeeked && (
                    <div style={{
                      padding: "10px 12px", background: "rgba(0,0,0,0.02)",
                      borderBottom: "1px solid rgba(0,0,0,0.04)",
                      maxHeight: 220, overflowY: "auto",
                    }}>
                      {peekLoading ? (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>Reading…</div>
                      ) : (
                        <pre style={{
                          margin: 0, fontSize: 11, lineHeight: 1.5,
                          fontFamily: "'Geist Mono', 'Fira Code', monospace",
                          color: "var(--text-sub)", whiteSpace: "pre-wrap", wordBreak: "break-word",
                        }}>{peeked.body}</pre>
                      )}
                      <div style={{
                        display: "flex", justifyContent: "space-between",
                        alignItems: "center", marginTop: 8, fontSize: 10, color: "var(--text-muted)",
                      }}>
                        <span>{formatSize(f.size_bytes)}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          );
        })()}
      </div>

      {/* Footer — explains the workspace's purpose now that framework files
          are hidden. Forward-looking pointer to gen-UI mini-apps is here too:
          once the runtime recognizes a written file as a mini-app manifest,
          this same drawer becomes the mini-apps shelf. */}
      <div style={{
        padding: "8px 12px", borderTop: "1px solid var(--border-subtle)",
        fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5,
      }}>
        Things you and {agent.name} are working on together — your uploads and the artifacts they create. Mini-apps will appear here too.
      </div>
    </div>
  );
}

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play, Pause, RefreshCw, Box, Terminal, Zap, Shield, Cpu,
  Trash2, Plus, LogOut, CheckCircle2, Circle, Settings, ChevronRight,
  ChevronLeft, Users, Check, X, FileText, Layout, List, Key,
  Mail, Calendar, ExternalLink, HardDrive, Lock, ShieldCheck, Activity, Brain, Server, Search, CheckCircle, Database
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AgentData, useWorldStore, AGENT_TYPE_INFO, DEFAULT_PERMISSIONS, ChatMessage } from "../../store/worldStore";
import type { GenerativeResult } from "../../types/generative";

import { Toggle, ServiceRow, glass } from "../../App";
import { PersonalityPreview, PersonalityPreviewHandle } from "./PersonalityPreview";
import { UPGRADE_MAP } from "./ConnectionsTab";
import { getRoleVoiceDefault, getVoiceProfile } from "../../utils/onboardingDiscovery";
import {
  formatRecommendedModel,
  getRecommendedModel,
} from "../../utils/modelRecommendations";

const CURATED_VOICE_IDS = ["alloy", "echo", "fable", "nova", "onyx", "shimmer"];

export function PersonalityTab({ agent }: { agent: AgentData }) {
  const [bookSearchQuery, setBookSearchQuery] = useState("");
  const [bookSearchResults, setBookSearchResults] = useState<any[]>([]);
  const [isSearchingBooks, setIsSearchingBooks] = useState(false);
  const [showBookDropdown, setShowBookDropdown] = useState(false);
  const searchTimeoutRef = useRef<any>(null);

  const [serverBooks, setServerBooks] = useState<any[]>([]);

  useEffect(() => {
    if (typeof invoke === 'function') {
      invoke("get_library_books")
        .then((data: any) => setServerBooks(data))
        .catch(console.error);
    }
  }, []);

  const displayedServerBooks = useMemo(() => {
    if (!bookSearchQuery.trim()) {
      return serverBooks.filter(b => b.recommendedAgents?.includes(agent.role) || b.recommendedAgents?.includes("Custom"));
    }
    const q = bookSearchQuery.toLowerCase();
    return serverBooks.filter(b =>
      b.title?.toLowerCase().includes(q) ||
      b.author?.toLowerCase().includes(q) ||
      b.subjects?.some((s: string) => s.toLowerCase().includes(q))
    );
  }, [serverBooks, agent.role, bookSearchQuery]);

  const handleBookSearch = (query: string) => {
    setBookSearchQuery(query);
    setShowBookDropdown(true);
    if (!query.trim()) {
      setBookSearchResults([]);
      return;
    }
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearchingBooks(true);
      try {
        const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5`);
        const data = await res.json();
        if (data && data.docs) {
          setBookSearchResults(data.docs);
        }
      } catch (e) { console.error(e); }
      setIsSearchingBooks(false);
    }, 400);
  };

  const [selectedModel, setSelectedModel] = useState<string>((agent.personality as any)?.active_model || "");
  useEffect(() => {
    setSelectedModel((agent.personality as any)?.active_model || "");
  }, [agent.id, (agent.personality as any)?.active_model]);
  const [voiceConfig, setVoiceConfig] = useState<any>(null);
  const [isVoiceLoading, setIsVoiceLoading] = useState(true);

  useEffect(() => {
    if (typeof invoke === "function") {
      setIsVoiceLoading(true);
      invoke("get_voice_config", { agentId: agent.id })
        .then((config: any) => {
          if (config && config.tts_voice === "default") {
            const defaultVoice = getRoleVoiceDefault(agent.role);
            config.tts_voice = defaultVoice.voice;
            config.tts_provider = defaultVoice.provider;
            invoke("update_voice_config", { agentId: agent.id, config });
          }
          setVoiceConfig(config);
          setIsVoiceLoading(false);
        })
        .catch(err => {
          console.warn("Failed to load voice config", err);
          setIsVoiceLoading(false);
        });
    }
  }, [agent.id, agent.role]);

  const updateVoice = async (newVoice: string) => {
    if (!voiceConfig) return;
    const newConfig = { ...voiceConfig, tts_voice: newVoice, tts_provider: getVoiceProfile(newVoice).provider };
    setVoiceConfig(newConfig);
    try {
      await invoke("update_voice_config", { agentId: agent.id, config: newConfig });
    } catch (e) {
      console.error("Failed to update voice config", e);
    }
  };

  const [selectedFile, setSelectedFile] = useState("IDENTITY.md");
  const [fileContent, setFileContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [fileSaveStatus, setFileSaveStatus] = useState("");
  // Ref into the live personality preview so we can auto-fire it after a successful save.
  // Only fires when the user edits the personality-flavored files — saving TOOLS.md or
  // LIBRARY.md shouldn't kick off a chat.
  const previewRef = useRef<PersonalityPreviewHandle>(null);
  const PERSONALITY_FILES = new Set(["IDENTITY.md", "SOUL.md", "USER.md"]);

  useEffect(() => {
    if (selectedFile === "Library") return;
    setFileSaveStatus("");
    invoke<string>("read_workspace_file", { agentId: agent.id, filename: selectedFile })
      .then(content => setFileContent(content))
      .catch(err => {
        console.warn("Failed to read file", err);
        setFileContent("");
      });
  }, [agent.id, selectedFile]);

  const handleSaveFile = async () => {
    setIsSaving(true);
    setFileSaveStatus("Saving...");
    try {
      await invoke("write_workspace_file", { agentId: agent.id, filename: selectedFile, content: fileContent });
      setFileSaveStatus("Saved successfully!");
      setTimeout(() => setFileSaveStatus(""), 3000);
      // Auto-fire removed per user request: only run preview when the user clicks a test button.
    } catch (e) {
      setFileSaveStatus("Error saving file: " + e);
    }
    setIsSaving(false);
  };

  // ── Model list for the Brain tab — sourced from Rust, not localhost:3001 ─────
  const [brainModels, setBrainModels] = useState<any[]>([]);
  const fetchCachedModels = useCallback(() => {
    return invoke<any[]>("get_available_models")
      .then(models => setBrainModels(models))
      .catch(() => { /* gateway not yet up, will retry on next render */ });
  }, []);

  useEffect(() => {
    fetchCachedModels();
    const interval = setInterval(fetchCachedModels, 3000);
    return () => clearInterval(interval);
  }, [fetchCachedModels]);

  const getDynamicRecommendedModel = () => {
    // Prefer the provider for which a key is already set in this agent's Brain config
    const availableProviders = Object.entries(keys)
      .filter(([_, v]) => v && v.trim().length > 0)
      .map(([k]) => k === "Gemini" ? "Google Gemini" : k);

    const match = getRecommendedModel(
      brainModels,
      agent.role,
      availableProviders.length > 0 ? availableProviders[0] : undefined,
    );

    return { provider: match.provider, model: formatRecommendedModel(match), id: match.id };
  };

  const [keys, setKeys] = useState<{ [provider: string]: string }>({
    "OpenAI": "", "Anthropic": "", "Gemini": "", "Grok": ""
  });
  const [saveStatus, setSaveStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  const defaultModelInfo = getDynamicRecommendedModel();

  useEffect(() => {
    if (typeof invoke === 'function') {
      const providers = ["OpenAI", "Anthropic", "Gemini", "Grok"];
      providers.forEach(prov => {
        invoke("get_secret_cmd", { key: `agent_${agent.id}_${prov.toLowerCase()}_key` })
          .then(k => setKeys(prev => ({ ...prev, [prov]: k as string })))
          .catch(() => { });
      });
    }
  }, [agent.id]);

  const saveOverrides = async (modelIdToSave?: string | unknown) => {
    setSaveStatus("loading");
    try {
      if (typeof invoke === 'function') {
        const providers = ["OpenAI", "Anthropic", "Gemini", "Grok"];
        for (const prov of providers) {
          const val = keys[prov];
          try {
            if (val && val.trim()) {
              await invoke("store_secret_cmd", { key: `agent_${agent.id}_${prov.toLowerCase()}_key`, value: val.trim() });
            } else {
              await invoke("delete_secret_cmd", { key: `agent_${agent.id}_${prov.toLowerCase()}_key` });
            }
          } catch (err) {
            // macOS keychain might throw if the key doesn't exist to delete. Ignore gracefully.
          }
        }

        // Model IDs from get_available_models() are already in "provider/model-name" format
        // (e.g. "google/gemini-3.6-flash"). No prefix construction needed.
        // Fallback to the Rust-side default if nothing is selected.
        const modelToSave = typeof modelIdToSave === 'string' ? modelIdToSave : selectedModel;
        const finalModel = modelToSave || defaultModelInfo?.id || "anthropic/claude-sonnet-5";

        // Synchronize only this agent's explicitly scoped credentials. Clearing a
        // key disconnects that provider instead of inheriting global state.
        await invoke("sync_agent_api_keys", { agentId: agent.id });

        // Push personality state to SQLite. Use the full provider/model-name string.
        await invoke("update_agent_personality", {
          agentId: agent.id,
          personality: { ...agent.personality, active_model: finalModel }
        });
        // Update agent model in OpenClaw — model ID is already correctly formatted.
        await invoke("update_agent_model", { agentId: agent.id, model: finalModel });
      }
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (e) {
      console.error(e);
      setSaveStatus("error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", paddingRight: 16, overflowY: "auto" }}>


      <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--text-main)", margin: "0 0 8px 0", flexShrink: 0 }}>Instructions</h1>
      <p style={{ fontSize: 14, color: "var(--text-sub)", marginBottom: 28, flexShrink: 0 }}>Shape how {agent.name} thinks and speaks. Edit their voice, personality, and the reference material they draw on.</p>

      {/* Voice & Speech Section */}
      <div style={{ ...glass(0.5), padding: 24, borderRadius: 16, marginBottom: 24, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ padding: 10, borderRadius: 12, background: "rgba(33, 131, 128, 0.15)", color: "#218380" }}>
            <Activity size={20} />
          </div>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", margin: "0 0 4px 0" }}>Voice & Speech</h2>
            <p style={{ fontSize: 13, color: "var(--text-sub)", margin: 0 }}>Fine-tune the managed premium voice profile for spoken responses.</p>
          </div>
        </div>

        <div style={{ background: "rgba(0,0,0,0.1)", borderRadius: 12, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-main)" }}>Speaking Voice</div>
            <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Canopy defaults to ElevenLabs and keeps an OpenAI fallback ready.</div>
          </div>
          <select
            value={CURATED_VOICE_IDS.includes(voiceConfig?.tts_voice) ? voiceConfig.tts_voice : getRoleVoiceDefault(agent.role).voice}
            onChange={(e) => updateVoice(e.target.value)}
            disabled={isVoiceLoading}
            style={{
              background: "var(--surface-card)", border: "1px solid rgba(0,0,0,0.2)",
              color: "var(--text-main)", borderRadius: 8, padding: "8px 12px",
              outline: "none", cursor: isVoiceLoading ? "not-allowed" : "pointer",
              fontSize: 13, minWidth: 150
            }}
          >
            {CURATED_VOICE_IDS.map((voiceId) => {
              const profile = getVoiceProfile(voiceId);
              return (
                <option key={voiceId} value={voiceId}>
                  {profile.voiceLabel} ({profile.style})
                </option>
              );
            })}
          </select>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20, flex: 1 }}>
        {/* Friendly labels for the underlying .md files — IDs stay the same so the save/load logic doesn't change. */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { id: "IDENTITY.md", label: "Identity", hint: "Who this agent is — role, voice, what they care about." },
            { id: "USER.md", label: "User", hint: "What the agent should know about you to be helpful." },
            { id: "SOUL.md", label: "Soul", hint: "Tone, quirks, values, and how they handle hard moments." },
            { id: "TOOLS.md", label: "Tools", hint: "Tools and integrations the agent has learned to use." },
            { id: "LIBRARY.md", label: "Library", hint: "Books and references this agent draws inspiration from." },
          ].map(({ id, label, hint }) => (
            <button
              key={id}
              onClick={() => setSelectedFile(id)}
              title={hint}
              style={{
                padding: "8px 16px", borderRadius: 8, border: "none",
                background: selectedFile === id ? "#218380" : "rgba(0,0,0,0.05)",
                color: selectedFile === id ? "#FFF" : "var(--text-main)",
                fontWeight: 600, cursor: "pointer", fontSize: 13
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative" }}>
          <textarea
            value={fileContent}
            onChange={e => setFileContent(e.target.value)}
            style={{
              flex: 1, width: "100%", padding: 20, borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.1)", background: "var(--surface-bg)",
              color: "var(--text-main)", fontSize: 14, fontFamily: "'Fira Code', monospace",
              resize: "none", outline: "none", minHeight: 300
            }}
          />
          <div style={{ position: "absolute", bottom: 20, right: 20, display: "flex", alignItems: "center", gap: 12 }}>
            {fileSaveStatus && <span style={{ fontSize: 13, color: fileSaveStatus.includes("Error") ? "#E57373" : "#218380", fontWeight: 600 }}>{fileSaveStatus}</span>}
            <button
              onClick={handleSaveFile}
              disabled={isSaving}
              style={{
                padding: "10px 24px", borderRadius: 8, border: "none",
                background: "#3c6663", color: "#FFF", fontWeight: 700,
                cursor: isSaving ? "not-allowed" : "pointer", fontSize: 14,
                boxShadow: "0 4px 12px rgba(33,131,128,0.2)"
              }}
            >
              {isSaving ? "Saving..." : "Save File"}
            </button>
          </div>
        </div>

        {/* Live personality preview — only meaningful for files that shape voice/personality.
              Hidden on TOOLS.md / LIBRARY.md because those don't directly change how the agent speaks. */}
        {PERSONALITY_FILES.has(selectedFile) && (
          <PersonalityPreview ref={previewRef} agent={agent} />
        )}

        {selectedFile === "LIBRARY.md" && (
          <div style={{ ...glass(0.5), padding: 16, borderRadius: 12, marginTop: -8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)", marginBottom: 8 }}>Add Book to Library</div>
            <div style={{ display: "flex", gap: 8, position: "relative" }}>
              <div style={{ flex: 1, position: "relative" }}>
                <input
                  value={bookSearchQuery}
                  onChange={e => handleBookSearch(e.target.value)}
                  onFocus={() => setShowBookDropdown(true)}
                  onBlur={() => setTimeout(() => setShowBookDropdown(false), 200)}
                  placeholder="Search for a book to append to the file..."
                  style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(0,0,0,0.1)", fontSize: 12, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
                  onKeyDown={e => {
                    if (e.key === "Enter" && bookSearchQuery.trim()) {
                      setFileContent(prev => prev + `\n- ${bookSearchQuery.trim()}`);
                      setBookSearchQuery("");
                      setShowBookDropdown(false);
                    }
                  }}
                />
                {showBookDropdown && (bookSearchResults.length > 0 || isSearchingBooks) && (
                  <div style={{
                    position: "absolute", bottom: "100%", left: 0, right: 0, marginBottom: 8,
                    background: "var(--surface-card)", border: "1px solid rgba(0,0,0,0.1)",
                    borderRadius: 8, boxShadow: "0 -4px 12px rgba(0,0,0,0.1)", zIndex: 10,
                    maxHeight: 220, overflowY: "auto"
                  }}>
                    {isSearchingBooks ? (
                      <div style={{ padding: 12, fontSize: 12, color: "var(--text-sub)", textAlign: "center" }}>Searching...</div>
                    ) : (
                      bookSearchResults.map((doc: any, i: number) => (
                        <div key={i} style={{
                          padding: "8px 12px", display: "flex", alignItems: "center", gap: 12,
                          cursor: "pointer", borderBottom: i < bookSearchResults.length - 1 ? "1px solid rgba(0,0,0,0.05)" : "none",
                        }} onClick={() => {
                          const titleStr = `${doc.title}${doc.author_name ? ` by ${doc.author_name[0]}` : ''}`;
                          setFileContent(prev => prev + `\n- ${titleStr}`);
                          setBookSearchQuery("");
                          setShowBookDropdown(false);
                        }}
                          onMouseEnter={e => e.currentTarget.style.background = "var(--surface-base)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          {doc.cover_i ? (
                            <img src={`https://covers.openlibrary.org/b/id/${doc.cover_i}-S.jpg`} style={{ width: 24, height: 36, objectFit: "cover", borderRadius: 2 }} />
                          ) : (
                            <div style={{ width: 24, height: 36, background: "var(--border-subtle)", borderRadius: 2, display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ fontSize: 10, color: "var(--text-muted)" }}>?</span></div>
                          )}
                          <div style={{ display: "flex", flexDirection: "column" }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-main)" }}>{doc.title}</div>
                            {doc.author_name && <div style={{ fontSize: 11, color: "var(--text-sub)" }}>{doc.author_name.join(", ")}</div>}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
              <button onClick={() => {
                if (bookSearchQuery.trim()) {
                  setFileContent(prev => prev + `\n- ${bookSearchQuery.trim()}`);
                  setBookSearchQuery("");
                  setShowBookDropdown(false);
                }
              }} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--surface-base)", color: "var(--text-main)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>Append</button>
            </div>

            {/* Server Suggested Books */}
            {displayedServerBooks.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-sub)", marginBottom: 8 }}>
                  {bookSearchQuery.trim() ? "Server Library Results" : `Suggested for ${agent.role}`}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, maxHeight: 200, overflowY: "auto", paddingRight: 4 }}>
                  {displayedServerBooks.slice(0, 12).map(book => (
                    <div key={book.key}
                      onClick={() => {
                        const titleStr = `${book.title} by ${book.author}`;
                        setFileContent(prev => prev + `\n- ${titleStr}`);
                      }}
                      style={{ display: "flex", gap: 12, padding: 8, borderRadius: 8, background: "var(--surface-card)", border: "1px solid rgba(0,0,0,0.05)", cursor: "pointer", alignItems: "center" }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = "var(--text-sub)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(0,0,0,0.05)"}
                    >
                      {book.coverUrl ? (
                        <img src={book.coverUrl} style={{ width: 32, height: 48, objectFit: "cover", borderRadius: 4 }} />
                      ) : (
                        <div style={{ width: 32, height: 48, background: "var(--border-subtle)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ fontSize: 10, color: "var(--text-muted)" }}>?</span></div>
                      )}
                      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-main)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{book.title}</div>
                        <div style={{ fontSize: 11, color: "var(--text-sub)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{book.author}</div>
                        {book.subjects && book.subjects.length > 0 && (
                          <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {book.subjects.join(", ")}
                          </div>
                        )}
                      </div>
                      <Plus size={14} color="var(--text-sub)" style={{ flexShrink: 0 }} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

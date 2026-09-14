import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bell, ChevronDown, ChevronUp, Clock3, Plus, Sparkles, Trash2 } from "lucide-react";
import type { AgentData } from "../../store/worldStore";
import {
  type HeartbeatTask,
  getHeartbeatSuggestionsForProfile,
  parseHeartbeatFile,
  serializeHeartbeatFile,
} from "../../utils/heartbeats";

type HeartbeatsManagerProps = {
  agent: AgentData;
  mode?: "summary" | "full";
  onOpenManage?: () => void;
};

const SCHEDULE_OPTIONS = [
  { value: "30m", label: "Every 30 minutes" },
  { value: "2h", label: "Every 2 hours" },
  { value: "1d", label: "Daily" },
  { value: "3d", label: "Twice a week" },
  { value: "7d", label: "Weekly" },
];

function scheduleLabelFor(value: string): string {
  return SCHEDULE_OPTIONS.find(option => option.value === value)?.label || value;
}

export function HeartbeatsManager({ agent, mode = "full", onOpenManage }: HeartbeatsManagerProps) {
  const [tasks, setTasks] = useState<HeartbeatTask[]>([]);
  const [additionalInstructions, setAdditionalInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftInterval, setDraftInterval] = useState("1d");
  const [draftPrompt, setDraftPrompt] = useState("");

  const suggestedHeartbeats = useMemo(() => {
    const activeNames = new Set(tasks.map(task => task.name));
    return getHeartbeatSuggestionsForProfile({
      role: agent.role,
      integrations: agent.integrations || [],
      permissions: (agent.permissions || [])
        .filter(permission => permission.enabled)
        .map(permission => permission.id),
    }).filter(task => !activeNames.has(task.name));
  }, [agent.integrations, agent.permissions, agent.role, tasks]);

  const readySuggestions = suggestedHeartbeats.filter(task => task.ready);

  const formatRequirements = (task: typeof suggestedHeartbeats[number]) => {
    const requirements = [
      ...task.missingIntegrations.map(item => item.replace(/_/g, " ")),
      ...task.missingPermissions.map(item => item.replace(/_/g, " ")),
    ];
    return requirements.join(" or ");
  };

  const loadHeartbeatFile = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const content = await invoke<string>("read_workspace_file", {
        agentId: agent.id,
        filename: "HEARTBEAT.md",
      }).catch(() => "");
      const parsed = parseHeartbeatFile(content || "");
      setTasks(parsed.tasks);
      setAdditionalInstructions(parsed.additionalInstructions);
    } catch (err) {
      setError(`Could not load heartbeats: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    void loadHeartbeatFile();
  }, [loadHeartbeatFile]);

  const persist = useCallback(async (nextTasks: HeartbeatTask[], nextInstructions: string) => {
    setSaving(true);
    setError("");
    try {
      await invoke("write_workspace_file", {
        agentId: agent.id,
        filename: "HEARTBEAT.md",
        content: serializeHeartbeatFile({
          tasks: nextTasks,
          additionalInstructions: nextInstructions,
        }),
      });
      setTasks(nextTasks);
      setAdditionalInstructions(nextInstructions);
    } catch (err) {
      setError(`Could not save heartbeats: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [agent.id]);

  const addSuggested = async (task: HeartbeatTask) => {
    await persist([...tasks, task], additionalInstructions);
  };

  const removeTask = async (taskId: string) => {
    await persist(tasks.filter(task => task.id !== taskId), additionalInstructions);
  };

  const saveDraftTask = async () => {
    if (!draftTitle.trim() || !draftPrompt.trim()) return;
    const name = draftTitle.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const newTask: HeartbeatTask = {
      id: name,
      name,
      title: draftTitle.trim(),
      interval: draftInterval,
      prompt: draftPrompt.trim(),
      scheduleLabel: scheduleLabelFor(draftInterval),
      dependencies: [],
    };
    await persist([...tasks.filter(task => task.name !== name), newTask], additionalInstructions);
    setDraftTitle("");
    setDraftInterval("1d");
    setDraftPrompt("");
    setEditorOpen(false);
  };

  if (mode === "summary") {
    return (
      <div style={{ marginBottom: 20, padding: 18, borderRadius: 16, border: "1px solid var(--border-subtle)", background: "var(--surface-card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(33,131,128,0.1)", color: "#218380", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Bell size={16} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-main)" }}>Routines</div>
            <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Recurring tasks {agent.name} runs for you on a schedule.</div>
          </div>
          {onOpenManage && (
            <button
              type="button"
              onClick={onOpenManage}
              style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "transparent", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--text-main)", fontFamily: "inherit" }}
            >
              Manage
            </button>
          )}
        </div>
        {loading ? (
          <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Loading routines…</div>
        ) : tasks.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {tasks.slice(0, 3).map(task => (
              <div key={task.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderRadius: 12, background: "rgba(33,131,128,0.05)", border: "1px solid rgba(33,131,128,0.12)" }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-main)" }}>{task.title}</div>
                  <div style={{ fontSize: 11, color: "var(--text-sub)" }}>{task.scheduleLabel}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#218380", fontSize: 11, fontWeight: 700 }}>
                  <Clock3 size={13} />
                  Active
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.6 }}>
            No routines scheduled yet. {readySuggestions.length > 0 ? `${agent.name} has ${readySuggestions.length} ready-to-go suggestion${readySuggestions.length === 1 ? "" : "s"} — click Manage to review.` : "You can add routines once this agent has the right tools connected."}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ ...({ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 16, padding: 20 } as React.CSSProperties), marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <div style={{ width: 38, height: 38, borderRadius: 12, background: "rgba(33,131,128,0.1)", color: "#218380", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Bell size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-main)" }}>Routines</div>
          <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Recurring tasks on a schedule (stored in this agent&apos;s `HEARTBEAT.md`).</div>
        </div>
        <button
          type="button"
          onClick={() => setEditorOpen(open => !open)}
          style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "transparent", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--text-main)", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}
        >
          <Plus size={14} />
          Add routine
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 12 }}>
          {error}
        </div>
      )}

      {suggestedHeartbeats.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Sparkles size={14} color="#218380" />
            <div style={{ fontSize: 12, fontWeight: 700, color: "#218380", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Recommended for {agent.role}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {suggestedHeartbeats.slice(0, 4).map(task => (
              <div key={task.id} style={{ padding: 14, borderRadius: 12, background: "rgba(33,131,128,0.05)", border: "1px solid rgba(33,131,128,0.16)", display: "flex", justifyContent: "space-between", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{task.title}</div>
                  <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 6 }}>{task.scheduleLabel}</div>
                  <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>{task.prompt}</div>
                  {!task.ready && (
                    <div style={{ marginTop: 8, fontSize: 11, color: "#a16207", lineHeight: 1.5 }}>
                      Connect or enable {formatRequirements(task)} to unlock this routine.
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  disabled={saving || !task.ready}
                  onClick={() => { void addSuggested(task); }}
                  style={{ alignSelf: "center", padding: "8px 12px", borderRadius: 8, border: "none", background: task.ready ? "#218380" : "rgba(0,0,0,0.1)", color: task.ready ? "white" : "var(--text-sub)", cursor: saving ? "wait" : task.ready ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}
                >
                  {task.ready ? "Add" : "Needs setup"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {editorOpen && (
        <div style={{ marginBottom: 16, padding: 14, borderRadius: 12, border: "1px solid var(--border-subtle)", background: "var(--surface-base)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 10 }}>Custom heartbeat</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10, marginBottom: 10 }}>
            <input
              value={draftTitle}
              onChange={event => setDraftTitle(event.target.value)}
              placeholder="Title"
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", color: "var(--text-main)", fontFamily: "inherit", fontSize: 13 }}
            />
            <select
              value={draftInterval}
              onChange={event => setDraftInterval(event.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", color: "var(--text-main)", fontFamily: "inherit", fontSize: 13 }}
            >
              {SCHEDULE_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <textarea
            value={draftPrompt}
            onChange={event => setDraftPrompt(event.target.value)}
            placeholder="What should this heartbeat do?"
            rows={4}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", color: "var(--text-main)", fontFamily: "inherit", fontSize: 13, resize: "vertical", marginBottom: 10 }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={() => setEditorOpen(false)} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "transparent", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--text-main)", fontFamily: "inherit" }}>
              Cancel
            </button>
            <button type="button" onClick={() => { void saveDraftTask(); }} style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: "#218380", color: "white", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>
              Save heartbeat
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
        {loading ? (
          <div style={{ fontSize: 12, color: "var(--text-sub)" }}>Loading routines…</div>
        ) : tasks.length > 0 ? (
          tasks.map(task => (
            <div key={task.id} style={{ padding: 14, borderRadius: 12, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", display: "flex", justifyContent: "space-between", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{task.title}</div>
                <div style={{ fontSize: 11, color: "var(--text-sub)", marginBottom: 6 }}>{task.scheduleLabel}</div>
                <div style={{ fontSize: 12, color: "var(--text-sub)", lineHeight: 1.5 }}>{task.prompt}</div>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => { void removeTask(task.id); }}
                style={{ alignSelf: "center", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(185,28,28,0.2)", background: "rgba(185,28,28,0.06)", color: "#b91c1c", cursor: saving ? "wait" : "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}
              >
                <Trash2 size={13} />
                Remove
              </button>
            </div>
          ))
        ) : (
          <div style={{ padding: 14, borderRadius: 12, border: "1px dashed var(--border-subtle)", color: "var(--text-sub)", fontSize: 12, lineHeight: 1.6 }}>
            No active heartbeats yet. Add one manually or accept one of the role-aware suggestions above.
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setInstructionsOpen(open => !open)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border-subtle)", background: "transparent", cursor: "pointer", color: "var(--text-main)", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}
      >
        <span>Advanced heartbeat instructions</span>
        {instructionsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {instructionsOpen && (
        <div style={{ marginTop: 10 }}>
          <textarea
            value={additionalInstructions}
            onChange={event => setAdditionalInstructions(event.target.value)}
            rows={5}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border-subtle)", background: "var(--surface-base)", color: "var(--text-main)", fontFamily: "inherit", fontSize: 12, resize: "vertical", marginBottom: 10 }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              disabled={saving}
              onClick={() => { void persist(tasks, additionalInstructions); }}
              style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", cursor: saving ? "wait" : "pointer", fontSize: 12, fontWeight: 700, color: "var(--text-main)", fontFamily: "inherit" }}
            >
              Save instructions
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";
import type { Forum } from "./forumStore";
import type { MiniApp } from "./worldStore";

const WRITE_DEBOUNCE_MS = 200;

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function reportPersistenceError(scope: string, error: unknown) {
  // Never log content payloads. The record identifier and error class are
  // enough to diagnose local persistence failures.
  const name = error instanceof Error ? error.name : "UnknownError";
  console.error(`[durable-content] ${scope} failed (${name})`);
}

export async function saveForumNow(forum: Forum, ifAbsent = false): Promise<void> {
  if (!hasTauriRuntime()) return;
  await invoke("save_forum_state", {
    forumId: forum.id,
    forum,
    ifAbsent,
  });
}

export async function loadForum(forumId: string): Promise<Forum | null> {
  if (!hasTauriRuntime()) return null;
  return invoke<Forum | null>("get_forum_state", { forumId });
}

export async function loadForumCatalog(): Promise<Forum[]> {
  if (!hasTauriRuntime()) return [];
  const result = await invoke<Forum[] | null>("list_forum_summaries");
  return Array.isArray(result) ? result : [];
}

export async function removeForum(forumId: string): Promise<void> {
  if (!hasTauriRuntime()) return;
  await invoke("delete_forum_state", { forumId });
}

export async function saveMiniAppsNow(
  agentId: string,
  miniApps: MiniApp[],
  ifAbsent = false,
): Promise<void> {
  if (!hasTauriRuntime()) return;
  await invoke("save_agent_mini_apps", {
    agentId,
    miniApps,
    ifAbsent,
  });
}

export async function loadMiniApps(agentId: string): Promise<MiniApp[] | null> {
  if (!hasTauriRuntime()) return null;
  return invoke<MiniApp[] | null>("get_agent_mini_apps", { agentId });
}

export async function removeMiniApps(agentId: string): Promise<void> {
  if (!hasTauriRuntime()) return;
  await invoke("delete_agent_mini_apps", { agentId });
}

const pendingForums = new Map<string, Forum>();
const forumTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingMiniApps = new Map<string, MiniApp[]>();
const miniAppTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleForumSave(forum: Forum): void {
  if (!hasTauriRuntime()) return;
  pendingForums.set(forum.id, forum);
  const existing = forumTimers.get(forum.id);
  if (existing) clearTimeout(existing);
  forumTimers.set(forum.id, setTimeout(() => {
    forumTimers.delete(forum.id);
    const latest = pendingForums.get(forum.id);
    pendingForums.delete(forum.id);
    if (latest) saveForumNow(latest).catch(error => reportPersistenceError(`forum ${forum.id}`, error));
  }, WRITE_DEBOUNCE_MS));
}

export function scheduleMiniAppsSave(agentId: string, miniApps: MiniApp[]): void {
  if (!hasTauriRuntime()) return;
  pendingMiniApps.set(agentId, miniApps);
  const existing = miniAppTimers.get(agentId);
  if (existing) clearTimeout(existing);
  miniAppTimers.set(agentId, setTimeout(() => {
    miniAppTimers.delete(agentId);
    const latest = pendingMiniApps.get(agentId);
    pendingMiniApps.delete(agentId);
    if (latest) saveMiniAppsNow(agentId, latest).catch(error => reportPersistenceError(`mini-apps ${agentId}`, error));
  }, WRITE_DEBOUNCE_MS));
}

export async function flushDurableContentWrites(): Promise<void> {
  for (const timer of forumTimers.values()) clearTimeout(timer);
  for (const timer of miniAppTimers.values()) clearTimeout(timer);
  forumTimers.clear();
  miniAppTimers.clear();

  const forumWrites = [...pendingForums.values()];
  const miniAppWrites = [...pendingMiniApps.entries()];
  pendingForums.clear();
  pendingMiniApps.clear();

  await Promise.all([
    ...forumWrites.map(forum => saveForumNow(forum).catch(error => reportPersistenceError(`forum ${forum.id}`, error))),
    ...miniAppWrites.map(([agentId, apps]) => saveMiniAppsNow(agentId, apps).catch(error => reportPersistenceError(`mini-apps ${agentId}`, error))),
  ]);
}

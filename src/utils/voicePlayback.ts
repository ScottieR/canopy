import { convertFileSrc, invoke } from "@tauri-apps/api/core";

let activeAudio: HTMLAudioElement | null = null;
let playbackToken = 0;

function cleanupAudioElement() {
  if (!activeAudio) return;
  try {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio.src = "";
  } catch {
    // Ignore teardown errors from stale elements.
  }
  activeAudio = null;
}

export function sanitizeSpokenText(text: string): string {
  return text
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, " (code block) ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, ". ")
    .trim();
}

export function cancelAgentSpeech() {
  playbackToken += 1;
  cleanupAudioElement();
}

export async function playAgentSpeech(agentId: string, text: string): Promise<boolean> {
  if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return false;
  const spoken = sanitizeSpokenText(text);
  if (!spoken) return false;

  const token = ++playbackToken;
  cleanupAudioElement();

  try {
    const audioPath = await invoke<string>("synthesize_agent_speech", { agentId, text: spoken });
    if (token !== playbackToken) return false;

    const audio = new Audio(convertFileSrc(audioPath));
    activeAudio = audio;
    audio.onended = () => {
      if (activeAudio === audio) activeAudio = null;
    };
    audio.onerror = () => {
      if (activeAudio === audio) activeAudio = null;
    };
    await audio.play();
    invoke("cleanup_voice_cache").catch(() => {});
    return true;
  } catch (error) {
    if (token === playbackToken) {
      cleanupAudioElement();
    }
    console.warn("Managed voice playback failed:", error);
    return false;
  }
}

// ─── Voice preview resolution ────────────────────────────────────────────────
// The app's voice ids (alloy, echo, fable, nova, onyx, shimmer) are OpenAI TTS
// voice names, but until a TTS provider is wired the preview runs on the Web
// Speech API — and a SpeechSynthesisUtterance with no `voice` set plays the
// SAME system default for every option. This module maps each voice id to a
// distinct local system voice plus a pitch/rate personality so previews are
// genuinely different, with graceful degradation when preferred voices are
// missing. When OpenAI/ElevenLabs TTS lands (voice.rs TTSProvider), previews
// should route there instead and this becomes the offline fallback.

export type VoicePersonality = {
  /** Preferred system voice names, best first (macOS names, then generic). */
  candidates: string[];
  /** Pitch multiplier (Web Speech API: 0–2, default 1). */
  pitch: number;
  /** Rate multiplier applied on top of the user's chosen rate. */
  rateScale: number;
};

export const VOICE_PERSONALITIES: Record<string, VoicePersonality> = {
  alloy:   { candidates: ["Samantha", "Ava (Premium)", "Ava", "Google US English"], pitch: 1.0,  rateScale: 1.0 },
  echo:    { candidates: ["Tom", "Alex", "Google UK English Male"],                 pitch: 0.95, rateScale: 0.98 },
  fable:   { candidates: ["Daniel", "Serena", "Google UK English Female"],          pitch: 1.05, rateScale: 0.95 },
  nova:    { candidates: ["Karen", "Tessa", "Google US English"],                   pitch: 1.12, rateScale: 1.04 },
  onyx:    { candidates: ["Aaron", "Fred", "Alex", "Google UK English Male"],       pitch: 0.8,  rateScale: 0.94 },
  shimmer: { candidates: ["Fiona", "Moira", "Victoria", "Google US English"],       pitch: 1.22, rateScale: 1.06 },
};

const DEFAULT_PERSONALITY: VoicePersonality = { candidates: [], pitch: 1.0, rateScale: 1.0 };

export function getVoicePersonality(voiceId: string): VoicePersonality {
  return VOICE_PERSONALITIES[voiceId] || DEFAULT_PERSONALITY;
}

/** Minimal structural type so the resolver is testable without a browser. */
export type SystemVoice = { name: string; lang: string };

function hashId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash;
}

/**
 * Pick a concrete system voice for a voice id:
 * 1. First preferred candidate that exists on this machine.
 * 2. Otherwise a deterministic English voice — hashed by id so different ids
 *    land on DIFFERENT voices even with no candidates present.
 * 3. Otherwise null (caller uses the system default; pitch/rate still differ).
 */
export function resolvePreviewVoice<V extends SystemVoice>(
  voiceId: string,
  systemVoices: V[],
): V | null {
  if (!systemVoices || systemVoices.length === 0) return null;
  const personality = getVoicePersonality(voiceId);
  for (const candidate of personality.candidates) {
    const match = systemVoices.find(voice => voice.name === candidate || voice.name.startsWith(`${candidate} `));
    if (match) return match;
  }
  const english = systemVoices.filter(voice => voice.lang?.toLowerCase().startsWith("en"));
  const pool = english.length > 0 ? english : systemVoices;
  return pool[hashId(voiceId) % pool.length] || null;
}

/** Speak a preview with the id's distinct voice + personality applied. */
export function speakPreview(
  voiceId: string,
  text: string,
  baseRate: number,
  callbacks?: { onend?: () => void; onerror?: () => void },
): boolean {
  if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") return false;
  const personality = getVoicePersonality(voiceId);
  const utterance = new SpeechSynthesisUtterance(text);
  const resolved = resolvePreviewVoice(voiceId, window.speechSynthesis.getVoices());
  if (resolved) utterance.voice = resolved as SpeechSynthesisVoice;
  utterance.pitch = personality.pitch;
  utterance.rate = Math.min(2, Math.max(0.5, baseRate * personality.rateScale));
  if (callbacks?.onend) utterance.onend = callbacks.onend;
  if (callbacks?.onerror) utterance.onerror = callbacks.onerror;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  return true;
}

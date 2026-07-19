import { describe, expect, it } from "vitest";
import { VOICE_PERSONALITIES, getVoicePersonality, resolvePreviewVoice } from "./voicePreview";

const MAC_VOICES = [
  { name: "Samantha", lang: "en-US" },
  { name: "Tom", lang: "en-US" },
  { name: "Daniel", lang: "en-GB" },
  { name: "Karen", lang: "en-AU" },
  { name: "Aaron", lang: "en-US" },
  { name: "Fiona", lang: "en" },
  { name: "Alex", lang: "en-US" },
  { name: "Amélie", lang: "fr-CA" },
];

describe("resolvePreviewVoice — every voice id must sound different", () => {
  it("maps each id to its preferred system voice when available", () => {
    expect(resolvePreviewVoice("alloy", MAC_VOICES)?.name).toBe("Samantha");
    expect(resolvePreviewVoice("echo", MAC_VOICES)?.name).toBe("Tom");
    expect(resolvePreviewVoice("fable", MAC_VOICES)?.name).toBe("Daniel");
    expect(resolvePreviewVoice("nova", MAC_VOICES)?.name).toBe("Karen");
    expect(resolvePreviewVoice("onyx", MAC_VOICES)?.name).toBe("Aaron");
    expect(resolvePreviewVoice("shimmer", MAC_VOICES)?.name).toBe("Fiona");
  });

  it("no two ids share a voice on a standard macOS voice set", () => {
    const ids = Object.keys(VOICE_PERSONALITIES);
    const resolved = ids.map(id => resolvePreviewVoice(id, MAC_VOICES)?.name);
    expect(new Set(resolved).size).toBe(ids.length);
  });

  it("matches premium-suffixed voice names (e.g. 'Ava (Premium)')", () => {
    const voices = [{ name: "Ava (Premium)", lang: "en-US" }];
    expect(resolvePreviewVoice("alloy", voices)?.name).toBe("Ava (Premium)");
  });

  it("falls back deterministically to English voices when candidates are missing", () => {
    const generic = [
      { name: "Voice A", lang: "en-US" },
      { name: "Voice B", lang: "en-GB" },
      { name: "Voice C", lang: "en-AU" },
    ];
    const first = resolvePreviewVoice("onyx", generic);
    const second = resolvePreviewVoice("onyx", generic);
    expect(first?.name).toBe(second?.name); // deterministic
    expect(first?.lang.startsWith("en")).toBe(true);
  });

  it("returns null on an empty voice list (system default + pitch still differentiates)", () => {
    expect(resolvePreviewVoice("alloy", [])).toBeNull();
  });

  it("prefers English over non-English in the fallback pool", () => {
    const voices = [
      { name: "Amélie", lang: "fr-CA" },
      { name: "Plain", lang: "en-US" },
    ];
    expect(resolvePreviewVoice("unknown-id", voices)?.lang).toBe("en-US");
  });
});

describe("getVoicePersonality", () => {
  it("gives every id a distinct pitch so even shared fallbacks differ", () => {
    const pitches = Object.values(VOICE_PERSONALITIES).map(p => p.pitch);
    expect(new Set(pitches).size).toBeGreaterThanOrEqual(5);
  });

  it("returns a neutral personality for unknown ids", () => {
    expect(getVoicePersonality("nope")).toMatchObject({ pitch: 1.0, rateScale: 1.0 });
  });
});

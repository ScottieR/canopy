// ─── Dynamic persona drafting — "Eddie uses his AI" (C3, live) ───────────────
// When the keyword matcher can't find a real fit ("sommelier" → Media Advisor
// is the canonical miss), Eddie can ask the user's connected provider directly
// from the Mac to either pick the best existing role or invent a tailored
// persona. Before a key exists, the same bounded request can use the dedicated
// onboarding bootstrap; the deterministic keyword draft remains the fail-safe.
//
// Design rules (July 18 decisions):
//   • Generated personas resolve to a BLEND of existing base templates so
//     accessories, voice, permissions, and visuals stay deterministic.
//   • This path is additive and fail-safe: any network/parse/validation
//     failure returns null and the keyword draft stands. Eddie thinking is a
//     bonus, never a blocker.
//   • Kill-switch: localStorage canopy_generative_discovery = "false".

import { requestCanopyHelper } from "./canopyHelperClient";

export type DynamicPersonaDraft = {
  fitsExisting: boolean;
  /** When fitsExisting: the matched role key (validated against the library). */
  existingRole: string | null;
  /** Invented persona title, e.g. "Garden Sommelier". */
  title: string;
  name: string;
  tagline: string;
  /** Seed text for SOUL/personality. */
  soulSeed: string;
  /** 1–3 existing role keys, best first — drives visuals/defaults. */
  blend: string[];
  /** One of the app voice ids, or null to keep the blend's default. */
  voice: string | null;
  /** Accessory ids AI-picked to match the persona (validated against catalog). */
  accessories: string[];
};

export function isGenerativeDiscoveryEnabled(): boolean {
  try {
    return localStorage.getItem("canopy_generative_discovery") !== "false";
  } catch {
    return true;
  }
}

/** Compact instruction — must fit the helper endpoint's 4000-char message cap.
 *  Accessories are offered as an indexed name list ("12:Paint Palette") so the
 *  AI picks by meaning; indices map back to catalog ids client-side. */
export function buildPersonaDraftMessage(
  userPrompt: string,
  roles: Array<{ key: string; description?: string }>,
  accessoryNames: string[] = [],
): string {
  const boundedPrompt = userPrompt.trim().slice(0, 400);
  let roleLines = "";
  for (const role of roles) {
    const line = `${role.key}\n`;
    if (roleLines.length + line.length > 700) break;
    roleLines += line;
  }
  let accessoryLines = "";
  for (let i = 0; i < accessoryNames.length; i++) {
    const line = `${i}:${accessoryNames[i].slice(0, 24)} `;
    if (accessoryLines.length + line.length > 1500) break;
    accessoryLines += line;
  }
  return [
    `TASK: The user described work for a new agent. Decide if one of the existing roles below is a STRONG fit. If none is, invent a tailored persona.`,
    `USER NEED: "${boundedPrompt}"`,
    `EXISTING ROLES:\n${roleLines}`,
    `ACCESSORIES (index:name):\n${accessoryLines}`,
    `Reply with ONLY a JSON object, no prose, no code fences:`,
    `{"fits_existing": bool, "existing_role": "RoleKey or null", "title": "2-3 word persona title", "name": "one warm first-name-style name, never a role word", "tagline": "one sentence, second person, what this persona handles for them", "soul_seed": "2-3 sentences of personality/expertise grounding, written as 'You are...'", "blend": ["1-3 existing RoleKeys, closest first"], "voice": "one of alloy|echo|fable|nova|onyx|shimmer or null", "accessory_indices": [3-4 ints matching the persona's vibe]}`,
    `Rules: existing_role must be from the list or null. blend entries must be from the list. A role is a STRONG fit only if its core job matches — adjacent topics do not count (a wine sommelier is NOT a Media Advisor).`,
  ].join("\n\n");
}

/** Tolerant JSON extraction: fences, preamble, trailing text all survive. */
export function parsePersonaDraftReply(
  reply: string,
  validRoleKeys: string[],
  accessoryIds: string[] = [],
): DynamicPersonaDraft | null {
  if (!reply) return null;
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: any;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const valid = new Set(validRoleKeys);
  const clean = (value: unknown, max: number): string =>
    typeof value === "string" ? value.trim().slice(0, max) : "";

  const blend = Array.isArray(raw.blend)
    ? raw.blend.filter((key: unknown): key is string => typeof key === "string" && valid.has(key)).slice(0, 3)
    : [];
  const existingRole =
    typeof raw.existing_role === "string" && valid.has(raw.existing_role) ? raw.existing_role : null;
  const fitsExisting = raw.fits_existing === true && existingRole !== null;

  // Indices → catalog ids, deduped, bounded.
  const accessories: string[] = Array.isArray(raw.accessory_indices)
    ? [...new Set(
        raw.accessory_indices
          .filter((i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < accessoryIds.length)
          .map((i: number) => accessoryIds[i]),
      )].slice(0, 4) as string[]
    : [];

  if (fitsExisting) {
    return {
      fitsExisting: true,
      existingRole,
      title: "",
      name: "",
      tagline: "",
      soulSeed: "",
      blend: blend.length > 0 ? blend : [existingRole as string],
      voice: null,
      accessories,
    };
  }

  const title = clean(raw.title, 40);
  const name = clean(raw.name, 24);
  const tagline = clean(raw.tagline, 160);
  const soulSeed = clean(raw.soul_seed, 600);
  // An invented persona is only usable if it has an identity AND resolves to
  // at least one real base template (deterministic defaults rule).
  if (!title || !name || blend.length === 0) return null;

  const VOICES = new Set(["alloy", "echo", "fable", "nova", "onyx", "shimmer"]);
  return {
    fitsExisting: false,
    existingRole: null,
    title,
    name,
    tagline,
    soulSeed,
    blend,
    voice: typeof raw.voice === "string" && VOICES.has(raw.voice) ? raw.voice : null,
    accessories,
  };
}

/** Persona-coherent personality text — replaces role boilerplate entirely so a
 *  "Media Advisor" opener can never sit above a wine-and-cocktails need. */
export function composePersonaPersonality(
  persona: DynamicPersonaDraft,
  userNeed: string,
): string {
  const opener = persona.soulSeed?.trim().startsWith("You are")
    ? persona.soulSeed.trim()
    : `You are ${persona.name}, a ${persona.title}. ${persona.soulSeed || ""}`.trim();
  const need = userNeed.trim();
  return need
    ? `${opener}\n\n## Current user need\n\nThe user wants help with: ${need}`
    : opener;
}

const HELPER_TIMEOUT_MS = 12_000;

type HelperRequester = (
  message: string,
  context?: Record<string, unknown>,
  continuity?: Record<string, unknown>,
) => Promise<string>;

/** Ask Eddie through the local privacy boundary. Null on ANY failure. */
export async function draftPersonaWithEddie(
  userPrompt: string,
  roleInfo: Record<string, { description?: string }>,
  accessoryOptions: Array<{ id: string; name: string }> = [],
  requestImpl: HelperRequester = requestCanopyHelper,
): Promise<DynamicPersonaDraft | null> {
  try {
    const roles = Object.entries(roleInfo)
      .filter(([key]) => key !== "Custom")
      .map(([key, value]) => ({ key, description: value?.description }));
    const message = buildPersonaDraftMessage(
      userPrompt,
      roles,
      accessoryOptions.map(option => option.name),
    );
    const reply = await Promise.race([
      requestImpl(message, { active_view: "onboarding", onboarding: { in_onboarding: true } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Eddy timed out")), HELPER_TIMEOUT_MS)),
    ]);
    return parsePersonaDraftReply(
      reply,
      roles.map(role => role.key),
      accessoryOptions.map(option => option.id),
    );
  } catch {
    return null;
  }
}

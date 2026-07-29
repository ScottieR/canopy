// Beat-1 draft interview (plan Phase 3): the drafted agent talks to the user
// on the discovery screen, asks up to MAX_INTERVIEW_QUESTIONS high-value
// clarifiers, and its identity file writes itself from the answers.
//
// Transport: the existing canopy-helper boundary (single message string).
// The "AGENT SESSION:" marker makes the server swap Eddy's persona for a
// neutral executor prompt (server.js ROLEPLAY_MARKERS) so the roleplay isn't
// tinted. Output is JSON parsed with fail-safes — a malformed reply degrades
// to plain conversation, never a broken screen.

export const MAX_INTERVIEW_QUESTIONS = 3;
const MESSAGE_CHAR_BUDGET = 3800; // stay under the helper's 4000-char cap

export type InterviewTurn = { role: "user" | "agent"; text: string };

export type InterviewReply = {
  say: string;
  identityNotes: string | null;
  done: boolean;
};

export function buildInterviewMessage(input: {
  agentName: string;
  roleTitle: string;
  personality: string;
  discoveryInput: string;
  transcript: InterviewTurn[];
  userMessage: string | null; // null = opening turn
  questionsAsked: number;
}): string {
  const { agentName, roleTitle, personality, discoveryInput, transcript, userMessage, questionsAsked } = input;
  const boundedPersonality = personality.trim().slice(0, 1200);
  const boundedSeed = discoveryInput.trim().slice(0, 400);
  const recent = transcript.slice(-6)
    .map(t => `${t.role === "user" ? "USER" : "YOU"}: ${t.text.slice(0, 300)}`)
    .join("\n")
    .slice(0, 1200);
  const remaining = Math.max(0, MAX_INTERVIEW_QUESTIONS - questionsAsked);

  const parts = [
    `AGENT SESSION: DISCOVERY INTERVIEW. You are ${agentName}, a freshly drafted ${roleTitle}. The user just described what they need. Your job in this short conversation: (1) make them feel you already understand their situation, (2) ask AT MOST ONE clarifying question per turn — only questions that would materially change how you work, (3) capture durable facts for your identity file.`,
    `You have ${remaining} question${remaining === 1 ? "" : "s"} left. When nothing important remains (or zero left), set "done": true and close warmly in one sentence — no more questions.`,
    `YOUR PERSONALITY:\n${boundedPersonality || `You are ${agentName}, a helpful ${roleTitle}.`}`,
    boundedSeed ? `WHAT THE USER SAID THEY NEED:\n"${boundedSeed}"` : `The user picked you directly without describing their need — your first question should draw that out.`,
    recent ? `CONVERSATION SO FAR:\n${recent}` : "",
    userMessage === null
      ? `This is your OPENING turn: greet in one short sentence (in character), then ask your single most valuable question.`
      : `USER JUST SAID: ${userMessage.trim().slice(0, 500)}`,
    `Reply with ONLY this JSON (no code fences):\n{"say": "<what you say to the user, 1-3 short sentences>", "identity_notes": "<1-2 sentences of NEW durable facts learned about the user/their needs, written in second person for your identity file, or null if nothing new>", "done": <true|false>}`,
  ].filter(Boolean);

  let message = parts.join("\n\n");
  if (message.length > MESSAGE_CHAR_BUDGET) message = message.slice(0, MESSAGE_CHAR_BUDGET);
  return message;
}

/** Parses the model's reply. Fail-safe: unparseable → the whole text becomes
 *  `say`, no notes, not done. */
export function parseInterviewReply(raw: string): InterviewReply {
  const text = String(raw || "").trim();
  const fallback: InterviewReply = { say: text, identityNotes: null, done: false };
  if (!text) return { say: "", identityNotes: null, done: false };

  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback;

  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    const say = typeof parsed.say === "string" ? parsed.say.trim() : "";
    if (!say) return fallback;
    const rawNotes = typeof parsed.identity_notes === "string" ? parsed.identity_notes.trim() : "";
    return {
      say: say.slice(0, 800),
      identityNotes: rawNotes && rawNotes.toLowerCase() !== "null" ? rawNotes.slice(0, 400) : null,
      done: parsed.done === true,
    };
  } catch {
    return fallback;
  }
}

const IDENTITY_SECTION_HEADER = "What you know about your human:";
const MAX_IDENTITY_NOTES = 6;

/** Merges new interview notes into the personality text under a stable
 *  section, deduped, bounded — repeated merges never balloon the file. */
export function mergeIdentityNotes(personality: string, notes: string): string {
  const trimmedNotes = notes.trim();
  if (!trimmedNotes) return personality;

  const base = personality.trimEnd();
  const headerIdx = base.indexOf(IDENTITY_SECTION_HEADER);

  if (headerIdx === -1) {
    return `${base}\n\n${IDENTITY_SECTION_HEADER}\n- ${trimmedNotes}`;
  }

  const before = base.slice(0, headerIdx + IDENTITY_SECTION_HEADER.length);
  const after = base.slice(headerIdx + IDENTITY_SECTION_HEADER.length);
  const existing = after.split("\n")
    .map(l => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  if (existing.some(l => l.toLowerCase() === trimmedNotes.toLowerCase())) return personality;

  const lines = [...existing, trimmedNotes].slice(-MAX_IDENTITY_NOTES);
  return `${before}\n${lines.map(l => `- ${l}`).join("\n")}`;
}

/** Deterministic opening question per role — instant render and the offline
 *  fallback when the helper is unreachable. */
export function fallbackOpeningQuestion(agentName: string, roleTitle: string, discoveryInput: string): string {
  const seed = discoveryInput.trim();
  if (seed) {
    return `Nice to meet you — I'm ${agentName}. So I get this right from day one: for "${seed.slice(0, 120)}", what does a great outcome look like to you?`;
  }
  return `Nice to meet you — I'm ${agentName}, your ${roleTitle}. What's the first thing you'd love to hand off to me?`;
}

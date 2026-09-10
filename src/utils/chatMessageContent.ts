const LEADING_TIMESTAMP_REGEX =
  /^\s*(?:System:\s*)?\[(?:[A-Z][a-z]{2}\s+)?\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[+-]\d{2}:?\d{2}|\s+[A-Z]{3,4})?\]\s*/i;

const RUNTIME_CONTEXT_BLOCK_REGEX =
  /<canopy_runtime_context>[\s\S]*?<\/canopy_runtime_context>\s*/gi;

const USER_MESSAGE_BLOCK_REGEX =
  /<user_message>\s*([\s\S]*?)\s*<\/user_message>/i;

export function extractVisibleUserMessageContent(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const wrappedMessage = trimmed.match(USER_MESSAGE_BLOCK_REGEX)?.[1]?.trim();
  if (wrappedMessage) {
    return wrappedMessage;
  }

  const stripped = trimmed
    .replace(LEADING_TIMESTAMP_REGEX, "")
    .replace(RUNTIME_CONTEXT_BLOCK_REGEX, "")
    .replace(/^<user_message>\s*/i, "")
    .replace(/\s*<\/user_message>$/i, "")
    .trim();

  return stripped || trimmed;
}

// OpenClaw prepends internal routing directives like [[reply_to_current]] to some
// agent replies. They are control tokens, never content — one leaked verbatim into
// chat during the 2026-08-24 CUJ test (issue #54). Stripping only at render time
// isn't enough: the send path and the history poll each deliver their own copy of
// a message, and if only one copy carries the token the dedup comparison misses,
// so the same reply shows twice. Every agent-text ingestion point must run this.
const LEADING_CONTROL_TOKEN_REGEX = /^\s*(?:\[\[[a-z0-9_:.-]+\]\]\s*)+/i;

export function stripAgentControlTokens(raw: string): string {
  if (!raw) return raw;
  return raw.replace(LEADING_CONTROL_TOKEN_REGEX, "");
}

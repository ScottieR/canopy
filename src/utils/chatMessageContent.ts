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

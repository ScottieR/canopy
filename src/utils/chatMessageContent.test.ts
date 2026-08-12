import { describe, expect, it } from "vitest";

import { extractVisibleUserMessageContent } from "./chatMessageContent";

describe("extractVisibleUserMessageContent", () => {
  it("returns plain user text unchanged", () => {
    expect(extractVisibleUserMessageContent("What's the background of Yodlee?")).toBe(
      "What's the background of Yodlee?"
    );
  });

  it("extracts the user message from a canopy runtime wrapper", () => {
    const wrapped = `[Wed 2026-08-05 00:08 UTC] <canopy_runtime_context>
This invocation belongs to conversation session \`conv_1785887995703_lf9v7c\`.
</canopy_runtime_context>

<user_message>
What's the background of Yodlee? How does it make money?
</user_message>`;

    expect(extractVisibleUserMessageContent(wrapped)).toBe(
      "What's the background of Yodlee? How does it make money?"
    );
  });

  it("strips runtime context when the user_message tags are missing", () => {
    const wrapped = `[Wed 2026-08-05 00:08 UTC] <canopy_runtime_context>
Internal metadata
</canopy_runtime_context>

Please summarize this company.`;

    expect(extractVisibleUserMessageContent(wrapped)).toBe(
      "Please summarize this company."
    );
  });
});

import { describe, expect, it } from "vitest";

import { extractVisibleUserMessageContent, stripAgentControlTokens } from "./chatMessageContent";

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

describe("stripAgentControlTokens", () => {
  it("strips a leading [[reply_to_current]] directive", () => {
    expect(stripAgentControlTokens("[[reply_to_current]]I'm so sorry about that!")).toBe(
      "I'm so sorry about that!"
    );
  });

  it("strips stacked leading control tokens and surrounding whitespace", () => {
    expect(stripAgentControlTokens("  [[reply_to_current]] [[urgent]]  Hello")).toBe("Hello");
  });

  it("leaves double-bracket text that appears mid-message alone", () => {
    expect(stripAgentControlTokens("The array syntax is [[1, 2], [3, 4]] in this case")).toBe(
      "The array syntax is [[1, 2], [3, 4]] in this case"
    );
  });

  it("leaves normal messages untouched", () => {
    expect(stripAgentControlTokens("Plain reply with no tokens")).toBe("Plain reply with no tokens");
    expect(stripAgentControlTokens("")).toBe("");
  });
});

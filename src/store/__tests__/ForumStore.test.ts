import { describe, it, expect } from "vitest";
import { useForumStore } from "../forumStore";

describe("ForumStore partialize", () => {
  it("should handle forums with missing blackboardHistory or messages without throwing", () => {
    const partializeFn = (useForumStore as any).persist?.getOptions()?.partialize;
    expect(partializeFn).toBeDefined();

    // Create a mock state with a forum that has undefined blackboardHistory and messages
    const mockState = {
      forums: [
        {
          id: "forum_1",
          title: "Test Forum",
          // missing blackboardHistory and messages
        }
      ]
    };

    // This should NOT throw if properly written with fallback operators or optional chaining
    expect(() => partializeFn(mockState)).not.toThrow();

    const partialState = partializeFn(mockState);
    expect(partialState.forums[0].blackboardHistory).toEqual([]);
    expect(partialState.forums[0].messages).toEqual([]);
  });
});

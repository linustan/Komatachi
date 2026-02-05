import { describe, it, expect } from "vitest";
import { selectMessages, estimateStringTokens } from "./index.js";

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

interface TestMessage {
  id: number;
  tokens: number;
}

function msg(id: number, tokens: number): TestMessage {
  return { id, tokens };
}

function tokenEstimator(message: TestMessage): number {
  return message.tokens;
}

// -----------------------------------------------------------------------------
// selectMessages
// -----------------------------------------------------------------------------

describe("selectMessages", () => {
  it("returns all messages when they fit within budget", () => {
    const messages = [msg(1, 100), msg(2, 100), msg(3, 100)];

    const result = selectMessages(messages, 300, tokenEstimator);

    expect(result.selected).toEqual(messages);
    expect(result.overflow).toBeNull();
  });

  it("returns all messages when they exactly fill the budget", () => {
    const messages = [msg(1, 100), msg(2, 100), msg(3, 100)];

    const result = selectMessages(messages, 300, tokenEstimator);

    expect(result.selected).toHaveLength(3);
    expect(result.overflow).toBeNull();
  });

  it("drops oldest messages when budget is exceeded", () => {
    const messages = [msg(1, 100), msg(2, 100), msg(3, 100), msg(4, 100)];

    const result = selectMessages(messages, 250, tokenEstimator);

    // 250 budget: msg4(100) + msg3(100) = 200 fits. msg2(100) would be 300 > 250.
    expect(result.selected).toEqual([msg(3, 100), msg(4, 100)]);
    expect(result.overflow).toEqual({
      droppedCount: 2,
      estimatedDroppedTokens: 200,
    });
  });

  it("keeps only the most recent message when budget is very small", () => {
    const messages = [msg(1, 100), msg(2, 100), msg(3, 50)];

    const result = selectMessages(messages, 50, tokenEstimator);

    expect(result.selected).toEqual([msg(3, 50)]);
    expect(result.overflow).toEqual({
      droppedCount: 2,
      estimatedDroppedTokens: 200,
    });
  });

  it("returns empty selection when even the latest message exceeds budget", () => {
    const messages = [msg(1, 100), msg(2, 500)];

    const result = selectMessages(messages, 50, tokenEstimator);

    expect(result.selected).toEqual([]);
    expect(result.overflow).toEqual({
      droppedCount: 2,
      estimatedDroppedTokens: 600,
    });
  });

  it("handles empty message array", () => {
    const result = selectMessages([], 1000, tokenEstimator);

    expect(result.selected).toEqual([]);
    expect(result.overflow).toBeNull();
  });

  it("handles zero budget", () => {
    const messages = [msg(1, 100)];

    const result = selectMessages(messages, 0, tokenEstimator);

    expect(result.selected).toEqual([]);
    expect(result.overflow).toEqual({
      droppedCount: 1,
      estimatedDroppedTokens: 100,
    });
  });

  it("handles single message that fits", () => {
    const messages = [msg(1, 100)];

    const result = selectMessages(messages, 100, tokenEstimator);

    expect(result.selected).toEqual([msg(1, 100)]);
    expect(result.overflow).toBeNull();
  });

  it("handles single message that does not fit", () => {
    const messages = [msg(1, 200)];

    const result = selectMessages(messages, 100, tokenEstimator);

    expect(result.selected).toEqual([]);
    expect(result.overflow).toEqual({
      droppedCount: 1,
      estimatedDroppedTokens: 200,
    });
  });

  it("preserves message order in selected output", () => {
    const messages = [
      msg(1, 100),
      msg(2, 100),
      msg(3, 100),
      msg(4, 100),
      msg(5, 100),
    ];

    const result = selectMessages(messages, 300, tokenEstimator);

    // Should keep the last 3, in original order
    expect(result.selected.map((m) => m.id)).toEqual([3, 4, 5]);
  });

  it("reports correct overflow counts", () => {
    const messages = [
      msg(1, 50),
      msg(2, 150),
      msg(3, 200),
      msg(4, 100),
      msg(5, 100),
    ];

    const result = selectMessages(messages, 250, tokenEstimator);

    // Budget 250: msg5(100) + msg4(100) + msg3(200) would be 400 > 250
    // So selected = [msg4, msg5] (200 tokens)
    // Dropped = [msg1, msg2, msg3] (50+150+200 = 400 tokens)
    expect(result.selected).toEqual([msg(4, 100), msg(5, 100)]);
    expect(result.overflow).toEqual({
      droppedCount: 3,
      estimatedDroppedTokens: 400,
    });
  });

  it("selects contiguous block from end (no skipping)", () => {
    // Even though msg2 is huge and msg1 is small,
    // we can't skip msg2 to include msg1
    const messages = [msg(1, 10), msg(2, 5000), msg(3, 10)];

    const result = selectMessages(messages, 100, tokenEstimator);

    expect(result.selected).toEqual([msg(3, 10)]);
    expect(result.overflow).toEqual({
      droppedCount: 2,
      estimatedDroppedTokens: 5010,
    });
  });
});

describe("selectMessages - with realistic token sizes", () => {
  it("simulates a real conversation within budget", () => {
    // Simulate messages with realistic token counts
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      tokens: 50 + (i % 5) * 30, // 50-170 tokens per message
    }));

    const totalTokens = messages.reduce(
      (sum, m) => sum + tokenEstimator(m),
      0
    );
    // Budget is total + some slack, all should fit
    const result = selectMessages(messages, totalTokens + 100, tokenEstimator);

    expect(result.selected).toHaveLength(20);
    expect(result.overflow).toBeNull();
  });

  it("simulates overflow in a long conversation", () => {
    // 100 messages, each ~100 tokens = ~10,000 tokens total
    const messages = Array.from({ length: 100 }, (_, i) =>
      msg(i, 100)
    );

    // Budget for ~30 messages
    const result = selectMessages(messages, 3000, tokenEstimator);

    expect(result.selected).toHaveLength(30);
    expect(result.selected[0].id).toBe(70); // most recent 30
    expect(result.overflow).not.toBeNull();
    expect(result.overflow!.droppedCount).toBe(70);
    expect(result.overflow!.estimatedDroppedTokens).toBe(7000);
  });

  it("simulates post-compaction: summary + recent messages all fit", () => {
    const summary = msg(0, 500); // Compaction summary
    const recent = [msg(1, 100), msg(2, 100), msg(3, 100)];
    const messages = [summary, ...recent];

    const result = selectMessages(messages, 1000, tokenEstimator);

    expect(result.selected).toHaveLength(4);
    expect(result.overflow).toBeNull();
  });
});

describe("selectMessages - generic type parameter", () => {
  it("works with string messages", () => {
    const messages = ["short", "a medium length message", "tiny"];
    const estimator = (s: string) => Math.ceil(s.length / 4);

    const result = selectMessages(messages, 5, estimator);

    // "tiny" = 1 token, "a medium length message" = 6 tokens
    // Budget 5: only "tiny" fits
    expect(result.selected).toEqual(["tiny"]);
    expect(result.overflow).not.toBeNull();
  });

  it("works with number messages", () => {
    const messages = [1, 2, 3, 4, 5];
    const estimator = (n: number) => n * 10; // each number costs n*10 tokens

    const result = selectMessages(messages, 90, estimator);

    // From end: 5(50) + 4(40) = 90, fits. 3(30) + 90 = 120, doesn't fit.
    expect(result.selected).toEqual([4, 5]);
  });
});

// -----------------------------------------------------------------------------
// estimateStringTokens
// -----------------------------------------------------------------------------

describe("estimateStringTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateStringTokens("abcd")).toBe(1);
    expect(estimateStringTokens("abcdefgh")).toBe(2);
  });

  it("rounds up partial tokens", () => {
    expect(estimateStringTokens("abc")).toBe(1); // 3/4 = 0.75 -> 1
    expect(estimateStringTokens("abcde")).toBe(2); // 5/4 = 1.25 -> 2
  });

  it("returns 0 for empty string", () => {
    expect(estimateStringTokens("")).toBe(0);
  });

  it("handles long strings", () => {
    const text = "x".repeat(10_000);
    expect(estimateStringTokens(text)).toBe(2500);
  });

  it("handles unicode characters", () => {
    // Unicode characters may be multiple bytes, but we count characters
    const text = "\u6771\u4EAC\u90FD"; // 3 characters
    expect(estimateStringTokens(text)).toBe(1); // ceil(3/4) = 1
  });

  it("handles multi-line text", () => {
    const text = "line1\nline2\nline3";
    expect(estimateStringTokens(text)).toBe(Math.ceil(17 / 4)); // 5
  });

  it("matches compaction module formula", () => {
    // The formula is Math.ceil(text.length / 4)
    // This should be consistent with how compaction estimates
    const testCases = [
      { text: "", expected: 0 },
      { text: "a", expected: 1 },
      { text: "abcd", expected: 1 },
      { text: "abcde", expected: 2 },
      { text: "x".repeat(100), expected: 25 },
    ];

    for (const { text, expected } of testCases) {
      expect(estimateStringTokens(text)).toBe(expected);
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage, type Storage } from "../storage/index.js";
import {
  createConversationStore,
  ConversationNotLoadedError,
  ConversationAlreadyExistsError,
  type ConversationStore,
  type Message,
} from "./index.js";

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

let testDir: string;
let storage: Storage;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "komatachi-conversation-test-"));
  storage = createStorage(testDir);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function userMessage(text: string): Message {
  return { role: "user", content: text };
}

function assistantMessage(text: string): Message {
  return { role: "assistant", content: text };
}

function initAndLoad(
  store: ConversationStore,
  model?: string
): void {
  store.initialize(model);
  store.load();
}

// Read raw file content from test directory
function readRaw(path: string): string {
  return readFileSync(join(testDir, path), "utf-8");
}

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

describe("initialize", () => {
  it("creates metadata and empty transcript", () => {
    const store = createConversationStore(storage, "agent");

    store.initialize();

    const metaRaw = readRaw("agent/metadata.json");
    const meta = JSON.parse(metaRaw);
    expect(meta.createdAt).toBeTypeOf("number");
    expect(meta.updatedAt).toBeTypeOf("number");
    expect(meta.compactionCount).toBe(0);
    expect(meta.model).toBeNull();

    const transcriptRaw = readRaw("agent/transcript.jsonl");
    expect(transcriptRaw).toBe("");
  });

  it("creates metadata with model when provided", () => {
    const store = createConversationStore(storage, "agent");

    store.initialize("claude-sonnet-4-20250514");

    const meta = storage.readJson<{ model: string }>(
      "agent/metadata.json"
    );
    expect(meta.model).toBe("claude-sonnet-4-20250514");
  });

  it("throws ConversationAlreadyExistsError if conversation exists", () => {
    const store = createConversationStore(storage, "agent");
    store.initialize();

    expect(() => store.initialize()).toThrow(
      ConversationAlreadyExistsError
    );
  });

  it("sets in-memory state after initialization", () => {
    const store = createConversationStore(storage, "agent");
    store.initialize();

    // After initialize, state is loaded -- getMessages/getMetadata should work
    expect(store.getMessages()).toEqual([]);
    expect(store.getMetadata().compactionCount).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

describe("load", () => {
  it("loads metadata and transcript from disk", () => {
    const store = createConversationStore(storage, "agent");
    store.initialize();

    // Append some messages
    store.appendMessage(userMessage("Hello"));
    store.appendMessage(assistantMessage("Hi there"));

    // Create a fresh store and load
    const freshStore = createConversationStore(storage, "agent");
    const state = freshStore.load();

    expect(state.metadata.compactionCount).toBe(0);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toEqual(userMessage("Hello"));
    expect(state.messages[1]).toEqual(assistantMessage("Hi there"));
  });

  it("returns the loaded state", () => {
    const store = createConversationStore(storage, "agent");
    store.initialize("claude-sonnet-4-20250514");

    const freshStore = createConversationStore(storage, "agent");
    const state = freshStore.load();

    expect(state.metadata.model).toBe("claude-sonnet-4-20250514");
    expect(state.messages).toEqual([]);
  });

  it("throws when metadata file is missing", () => {
    const store = createConversationStore(storage, "nonexistent");

    expect(() => store.load()).toThrow();
  });
});

// -----------------------------------------------------------------------------
// State access before load
// -----------------------------------------------------------------------------

describe("pre-load access", () => {
  it("throws ConversationNotLoadedError for getMessages before load", () => {
    const store = createConversationStore(storage, "agent");

    expect(() => store.getMessages()).toThrow(ConversationNotLoadedError);
  });

  it("throws ConversationNotLoadedError for getMetadata before load", () => {
    const store = createConversationStore(storage, "agent");

    expect(() => store.getMetadata()).toThrow(ConversationNotLoadedError);
  });

  it("throws ConversationNotLoadedError for appendMessage before load", () => {
    const store = createConversationStore(storage, "agent");

    expect(() =>
      store.appendMessage(userMessage("test"))
    ).toThrow(ConversationNotLoadedError);
  });

  it("throws ConversationNotLoadedError for replaceTranscript before load", () => {
    const store = createConversationStore(storage, "agent");

    expect(() => store.replaceTranscript([])).toThrow(
      ConversationNotLoadedError
    );
  });

  it("throws ConversationNotLoadedError for updateMetadata before load", () => {
    const store = createConversationStore(storage, "agent");

    expect(() =>
      store.updateMetadata({ compactionCount: 1 })
    ).toThrow(ConversationNotLoadedError);
  });
});

// -----------------------------------------------------------------------------
// Appending messages
// -----------------------------------------------------------------------------

describe("appendMessage", () => {
  it("appends a user message to memory and disk", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.appendMessage(userMessage("Hello"));

    // In-memory
    expect(store.getMessages()).toHaveLength(1);
    expect(store.getMessages()[0]).toEqual(userMessage("Hello"));

    // On disk
    const entries = storage.readAllJsonl<Message>(
      "agent/transcript.jsonl"
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(userMessage("Hello"));
  });

  it("appends an assistant message", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.appendMessage(assistantMessage("Hi there"));

    expect(store.getMessages()).toEqual([assistantMessage("Hi there")]);
  });

  it("preserves message order across multiple appends", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.appendMessage(userMessage("First"));
    store.appendMessage(assistantMessage("Second"));
    store.appendMessage(userMessage("Third"));

    const messages = store.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("First");
    expect(messages[1].content).toBe("Second");
    expect(messages[2].content).toBe("Third");
  });

  it("updates metadata timestamp on append", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    const beforeAppend = store.getMetadata().updatedAt;

    store.appendMessage(userMessage("Hello"));

    expect(store.getMetadata().updatedAt).toBeGreaterThanOrEqual(
      beforeAppend
    );
  });

  it("handles messages with content block arrays", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    const toolUseMessage: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        {
          type: "tool_use",
          id: "toolu_123",
          name: "get_time",
          input: {},
        },
      ],
    };

    store.appendMessage(toolUseMessage);

    expect(store.getMessages()[0]).toEqual(toolUseMessage);

    // Verify round-trip through disk
    const freshStore = createConversationStore(storage, "agent");
    const state = freshStore.load();
    expect(state.messages[0]).toEqual(toolUseMessage);
  });

  it("handles tool result messages", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    const toolResultMessage: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_123",
          content: "2026-02-05T14:30:00Z",
        },
      ],
    };

    store.appendMessage(toolResultMessage);

    expect(store.getMessages()[0]).toEqual(toolResultMessage);
  });
});

// -----------------------------------------------------------------------------
// Replace transcript (compaction)
// -----------------------------------------------------------------------------

describe("replaceTranscript", () => {
  it("replaces the entire transcript in memory and on disk", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    // Build up a conversation
    store.appendMessage(userMessage("msg 1"));
    store.appendMessage(assistantMessage("msg 2"));
    store.appendMessage(userMessage("msg 3"));
    store.appendMessage(assistantMessage("msg 4"));

    expect(store.getMessages()).toHaveLength(4);

    // Replace with compacted version
    const compacted = [
      userMessage("[Summary of previous conversation]"),
      userMessage("msg 3"),
      assistantMessage("msg 4"),
    ];

    store.replaceTranscript(compacted);

    // In-memory
    expect(store.getMessages()).toHaveLength(3);
    expect(store.getMessages()[0].content).toBe(
      "[Summary of previous conversation]"
    );

    // On disk
    const entries = storage.readAllJsonl<Message>(
      "agent/transcript.jsonl"
    );
    expect(entries).toHaveLength(3);
  });

  it("can replace with empty transcript", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.appendMessage(userMessage("Hello"));
    store.replaceTranscript([]);

    expect(store.getMessages()).toHaveLength(0);
  });

  it("updates metadata timestamp", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.appendMessage(userMessage("Hello"));
    const before = store.getMetadata().updatedAt;

    store.replaceTranscript([userMessage("Summary")]);

    expect(store.getMetadata().updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("replaced transcript persists across reload", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.appendMessage(userMessage("old 1"));
    store.appendMessage(userMessage("old 2"));
    store.replaceTranscript([userMessage("compacted")]);

    // Reload from disk
    const freshStore = createConversationStore(storage, "agent");
    const state = freshStore.load();

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("compacted");
  });
});

// -----------------------------------------------------------------------------
// Update metadata
// -----------------------------------------------------------------------------

describe("updateMetadata", () => {
  it("updates compaction count", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.updateMetadata({ compactionCount: 1 });

    expect(store.getMetadata().compactionCount).toBe(1);
  });

  it("updates model", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.updateMetadata({ model: "claude-opus-4-20250514" });

    expect(store.getMetadata().model).toBe("claude-opus-4-20250514");
  });

  it("preserves other fields when updating a single field", () => {
    const store = createConversationStore(storage, "agent");
    store.initialize("claude-sonnet-4-20250514");
    store.load();

    const originalCreatedAt = store.getMetadata().createdAt;

    store.updateMetadata({ compactionCount: 5 });

    expect(store.getMetadata().createdAt).toBe(originalCreatedAt);
    expect(store.getMetadata().model).toBe("claude-sonnet-4-20250514");
    expect(store.getMetadata().compactionCount).toBe(5);
  });

  it("persists to disk", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.updateMetadata({ compactionCount: 3 });

    const freshStore = createConversationStore(storage, "agent");
    const state = freshStore.load();

    expect(state.metadata.compactionCount).toBe(3);
  });

  it("updates timestamp", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    const before = store.getMetadata().updatedAt;

    store.updateMetadata({ compactionCount: 1 });

    expect(store.getMetadata().updatedAt).toBeGreaterThanOrEqual(before);
  });
});

// -----------------------------------------------------------------------------
// getMessages / getMetadata
// -----------------------------------------------------------------------------

describe("getMessages", () => {
  it("returns empty array for new conversation", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    expect(store.getMessages()).toEqual([]);
  });

  it("returns messages without disk I/O", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.appendMessage(userMessage("Hello"));

    // getMessages is synchronous -- no disk I/O
    const messages = store.getMessages();
    expect(messages).toHaveLength(1);
  });

  it("returns readonly array", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.appendMessage(userMessage("Hello"));
    const messages = store.getMessages();

    // TypeScript enforces this at compile time; runtime check for safety
    expect(Array.isArray(messages)).toBe(true);
  });
});

describe("getMetadata", () => {
  it("returns initial metadata after initialization", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    const meta = store.getMetadata();
    expect(meta.compactionCount).toBe(0);
    expect(meta.model).toBeNull();
    expect(meta.createdAt).toBeTypeOf("number");
    expect(meta.updatedAt).toBeTypeOf("number");
  });
});

// -----------------------------------------------------------------------------
// Full conversation lifecycle
// -----------------------------------------------------------------------------

describe("full lifecycle", () => {
  it("initialize -> load -> append -> reload preserves everything", () => {
    // Initialize
    const store1 = createConversationStore(storage, "agent");
    store1.initialize("claude-sonnet-4-20250514");
    store1.load();

    // Append messages
    store1.appendMessage(userMessage("Hello"));
    store1.appendMessage(assistantMessage("Hi!"));
    store1.appendMessage(userMessage("How are you?"));
    store1.appendMessage(
      assistantMessage("I am doing well, thank you.")
    );

    // Update metadata
    store1.updateMetadata({ compactionCount: 0 });

    // Reload from disk (new store instance)
    const store2 = createConversationStore(storage, "agent");
    const state = store2.load();

    expect(state.messages).toHaveLength(4);
    expect(state.metadata.model).toBe("claude-sonnet-4-20250514");
    expect(state.metadata.compactionCount).toBe(0);
  });

  it("compaction lifecycle: append -> compact -> continue -> reload", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    // Phase 1: Build up conversation
    for (let i = 0; i < 10; i++) {
      store.appendMessage(userMessage(`Question ${i}`));
      store.appendMessage(assistantMessage(`Answer ${i}`));
    }
    expect(store.getMessages()).toHaveLength(20);

    // Phase 2: Compact
    const summary = userMessage(
      "Summary: User asked 10 questions about various topics."
    );
    const kept = store.getMessages().slice(-4); // Keep last 4 messages
    store.replaceTranscript([summary, ...kept]);
    store.updateMetadata({ compactionCount: 1 });

    expect(store.getMessages()).toHaveLength(5); // summary + 4 kept

    // Phase 3: Continue conversation
    store.appendMessage(userMessage("New question"));
    store.appendMessage(assistantMessage("New answer"));

    expect(store.getMessages()).toHaveLength(7);

    // Phase 4: Reload and verify
    const freshStore = createConversationStore(storage, "agent");
    const state = freshStore.load();

    expect(state.messages).toHaveLength(7);
    expect(state.messages[0].content).toContain("Summary:");
    expect(state.metadata.compactionCount).toBe(1);
  });

  it("multiple stores for different conversations are independent", () => {
    const storeA = createConversationStore(storage, "agent-a");
    const storeB = createConversationStore(storage, "agent-b");

    storeA.initialize("model-a");
    storeB.initialize("model-b");
    storeA.load();
    storeB.load();

    storeA.appendMessage(userMessage("Hello from A"));
    storeB.appendMessage(userMessage("Hello from B"));
    storeB.appendMessage(userMessage("Second from B"));

    expect(storeA.getMessages()).toHaveLength(1);
    expect(storeB.getMessages()).toHaveLength(2);

    expect(storeA.getMetadata().model).toBe("model-a");
    expect(storeB.getMetadata().model).toBe("model-b");
  });
});

// -----------------------------------------------------------------------------
// Error type properties
// -----------------------------------------------------------------------------

describe("error types", () => {
  it("ConversationNotLoadedError has correct name", () => {
    const error = new ConversationNotLoadedError();
    expect(error.name).toBe("ConversationNotLoadedError");
    expect(error.message).toContain("load()");
    expect(error).toBeInstanceOf(Error);
  });

  it("ConversationAlreadyExistsError has correct name and path", () => {
    const error = new ConversationAlreadyExistsError("agent/conversation");
    expect(error.name).toBe("ConversationAlreadyExistsError");
    expect(error.path).toBe("agent/conversation");
    expect(error).toBeInstanceOf(Error);
  });
});

// -----------------------------------------------------------------------------
// Edge cases
// -----------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles messages with empty string content", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.appendMessage(userMessage(""));
    expect(store.getMessages()[0].content).toBe("");
  });

  it("handles messages with unicode content", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    store.appendMessage(userMessage("Hello \u{1F600} World \u6771\u4EAC"));
    const freshStore = createConversationStore(storage, "agent");
    const state = freshStore.load();
    expect(state.messages[0].content).toBe("Hello \u{1F600} World \u6771\u4EAC");
  });

  it("handles messages with very long content", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    const longContent = "x".repeat(100_000);
    store.appendMessage(userMessage(longContent));

    const freshStore = createConversationStore(storage, "agent");
    const state = freshStore.load();
    expect((state.messages[0].content as string).length).toBe(100_000);
  });

  it("handles complex tool use / tool result conversation", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    // Full tool use cycle
    const messages: Message[] = [
      { role: "user", content: "What time is it?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: "toolu_abc",
            name: "get_time",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_abc",
            content: "2026-02-05T14:30:00Z",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "It is 2:30 PM UTC." }],
      },
    ];

    for (const msg of messages) {
      store.appendMessage(msg);
    }

    // Verify round-trip
    const freshStore = createConversationStore(storage, "agent");
    const state = freshStore.load();
    expect(state.messages).toEqual(messages);
  });

  it("handles tool result with is_error flag", () => {
    const store = createConversationStore(storage, "agent");
    initAndLoad(store);

    const errorResult: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_err",
          content: "Command failed: exit code 1",
          is_error: true,
        },
      ],
    };

    store.appendMessage(errorResult);

    const freshStore = createConversationStore(storage, "agent");
    const state = freshStore.load();
    const block = (state.messages[0].content as ReadonlyArray<{ type: string; is_error?: boolean }>)[0];
    expect(block.is_error).toBe(true);
  });
});

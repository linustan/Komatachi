/**
 * Integration Tests -- Phase 5: Integration Validation
 *
 * Verifies that all modules compose correctly into a working agent loop.
 * Unlike the per-module unit tests, these tests exercise the full pipeline:
 * Storage -> Conversation Store -> Context Window -> System Prompt ->
 * Tool Registry -> Agent Loop -> Compaction.
 *
 * Testing approach (per testing-strategy.md): real internal dependencies,
 * mock only the external boundary (Claude API via callModel).
 *
 * Key scenarios tested:
 * - Full conversation lifecycle with disk persistence and reload
 * - Tool dispatch with stateful tools and conversation continuity
 * - Compaction lifecycle: trigger, persist, reload, continue
 * - Crash recovery: restart from persisted state
 * - Identity evolution: identity files change between turns
 * - Complex multi-turn pipeline: tools + compaction + continued operation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStorage } from "../storage/index.js";
import { createConversationStore } from "../conversation/index.js";
import type { Message, ContentBlock, ToolResultBlock } from "../conversation/index.js";
import { createAgent } from "../agent/index.js";
import type { CallModel, CallModelResult, CallModelParams } from "../agent/index.js";
import type { ToolDefinition } from "../tools/index.js";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

function textResponse(text: string): CallModelResult {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  };
}

function toolUseResponse(
  calls: Array<{ id: string; name: string; input: unknown }>,
  text?: string
): CallModelResult {
  const content: ContentBlock[] = [];
  if (text) {
    content.push({ type: "text", text });
  }
  for (const call of calls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }
  return { content, stop_reason: "tool_use" };
}

// -----------------------------------------------------------------------------
// Test Setup
// -----------------------------------------------------------------------------

describe("Integration: Full Pipeline", () => {
  let tempDir: string;
  let dataDir: string;
  let homeDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "komatachi-integration-"));
    dataDir = join(tempDir, "data");
    homeDir = join(tempDir, "home");
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 1. Full Conversation Lifecycle with Disk Persistence
  // ---------------------------------------------------------------------------

  describe("conversation lifecycle with disk persistence", () => {
    it("persists messages to disk and survives reload", async () => {
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(textResponse("Hello! I'm here to help."))
        .mockResolvedValueOnce(textResponse("TypeScript is great for type safety."))
        .mockResolvedValueOnce(textResponse("Goodbye!"));

      // -- Session 1: three turns --
      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      await agent.processTurn("Hi there");
      await agent.processTurn("Tell me about TypeScript");
      await agent.processTurn("Bye");

      // Verify in-memory state
      const messages = store.getMessages();
      expect(messages).toHaveLength(6); // 3 user + 3 assistant

      // -- Session 2: reload from disk --
      const storage2 = createStorage(dataDir);
      const store2 = createConversationStore(storage2, "conv");
      const loaded = store2.load();

      // Verify disk state matches in-memory state
      expect(loaded.messages).toHaveLength(6);
      expect(loaded.messages[0]).toEqual({ role: "user", content: "Hi there" });
      expect(loaded.messages[1].role).toBe("assistant");
      expect(loaded.messages[2]).toEqual({ role: "user", content: "Tell me about TypeScript" });
      expect(loaded.messages[3].role).toBe("assistant");
      expect(loaded.messages[4]).toEqual({ role: "user", content: "Bye" });
      expect(loaded.messages[5].role).toBe("assistant");

      // Verify metadata
      expect(loaded.metadata.model).toBe("claude-test");
      expect(loaded.metadata.compactionCount).toBe(0);
      expect(loaded.metadata.createdAt).toBeLessThanOrEqual(loaded.metadata.updatedAt);
    });

    it("continues conversation after reload with full history", async () => {
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(textResponse("First response"))
        .mockResolvedValueOnce(textResponse("Continued after reload"));

      // -- Session 1 --
      const storage1 = createStorage(dataDir);
      const store1 = createConversationStore(storage1, "conv");
      store1.initialize("claude-test");

      const agent1 = createAgent({
        conversationStore: store1,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      await agent1.processTurn("Hello");

      // -- Session 2: new store, reload, continue --
      const storage2 = createStorage(dataDir);
      const store2 = createConversationStore(storage2, "conv");
      store2.load();

      const agent2 = createAgent({
        conversationStore: store2,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      const response = await agent2.processTurn("Continue from where we left off");
      expect(response).toBe("Continued after reload");

      // Verify the second model call includes full history from both sessions
      const secondCallParams = callModel.mock.calls[1][0];
      expect(secondCallParams.messages).toHaveLength(3); // user1, assistant1, user2
      expect(secondCallParams.messages[0]).toEqual({ role: "user", content: "Hello" });
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Tool Dispatch End-to-End
  // ---------------------------------------------------------------------------

  describe("tool dispatch end-to-end", () => {
    it("executes tools, persists all intermediate messages, continues after reload", async () => {
      // Track tool invocations externally
      const invocations: Array<{ name: string; input: unknown }> = [];

      const readFileTool: ToolDefinition = {
        name: "read_file",
        description: "Reads a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        handler: async (input: unknown) => {
          const params = input as { path: string };
          invocations.push({ name: "read_file", input: params });
          return { ok: true as const, content: `Contents of ${params.path}: hello world` };
        },
      };

      const writeFileTool: ToolDefinition = {
        name: "write_file",
        description: "Writes a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
        handler: async (input: unknown) => {
          const params = input as { path: string; content: string };
          invocations.push({ name: "write_file", input: params });
          return { ok: true as const, content: `Written to ${params.path}` };
        },
      };

      const callModel = vi.fn<CallModel>()
        // Turn 1: Claude uses both tools
        .mockResolvedValueOnce(
          toolUseResponse([
            { id: "toolu_r1", name: "read_file", input: { path: "/tmp/test.txt" } },
            { id: "toolu_w1", name: "write_file", input: { path: "/tmp/out.txt", content: "result" } },
          ], "Let me read and write files.")
        )
        // Turn 1 continued: Claude responds with text after tool results
        .mockResolvedValueOnce(textResponse("I read the file and wrote the output."))
        // Turn 2: simple text response referencing previous work
        .mockResolvedValueOnce(textResponse("Yes, I wrote to /tmp/out.txt previously."));

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");
      const tools = [readFileTool, writeFileTool];

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools,
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      // Turn 1: tool use
      const response1 = await agent.processTurn("Read test.txt and write out.txt");
      expect(response1).toBe("I read the file and wrote the output.");

      // Verify tools were invoked in order
      expect(invocations).toHaveLength(2);
      expect(invocations[0].name).toBe("read_file");
      expect(invocations[1].name).toBe("write_file");

      // Turn 2: follow-up with conversation continuity
      const response2 = await agent.processTurn("Did you write to out.txt?");
      expect(response2).toBe("Yes, I wrote to /tmp/out.txt previously.");

      // Verify all messages persisted
      const messages = store.getMessages();
      // Turn 1: user, assistant(tool_use), user(tool_result), assistant(text)
      // Turn 2: user, assistant(text)
      expect(messages).toHaveLength(6);

      // Verify tool result message structure
      const toolResultMsg = messages[2];
      expect(toolResultMsg.role).toBe("user");
      const blocks = toolResultMsg.content as ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect((blocks[0] as ToolResultBlock).tool_use_id).toBe("toolu_r1");
      expect((blocks[0] as ToolResultBlock).content).toBe("Contents of /tmp/test.txt: hello world");
      expect((blocks[1] as ToolResultBlock).tool_use_id).toBe("toolu_w1");
      expect((blocks[1] as ToolResultBlock).content).toBe("Written to /tmp/out.txt");

      // Verify persistence: reload and check
      const storage2 = createStorage(dataDir);
      const store2 = createConversationStore(storage2, "conv");
      const loaded = store2.load();
      expect(loaded.messages).toHaveLength(6);

      // Tool result messages survive serialization
      const reloadedToolResult = loaded.messages[2];
      expect(reloadedToolResult.role).toBe("user");
      const reloadedBlocks = reloadedToolResult.content as ContentBlock[];
      expect(reloadedBlocks[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_r1",
      });
    });

    it("handles tool error and continues", async () => {
      const brokenTool: ToolDefinition = {
        name: "broken",
        description: "Always throws",
        inputSchema: { type: "object" },
        handler: async () => { throw new Error("disk full"); },
      };

      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(
          toolUseResponse([{ id: "toolu_1", name: "broken", input: {} }])
        )
        .mockResolvedValueOnce(textResponse("The tool failed, but I can continue."));

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [brokenTool],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      const response = await agent.processTurn("Try the tool");
      expect(response).toBe("The tool failed, but I can continue.");

      // Verify error is in the tool result
      const messages = store.getMessages();
      const toolResultMsg = messages[2];
      const blocks = toolResultMsg.content as ContentBlock[];
      expect(blocks[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_1",
        is_error: true,
        content: "disk full",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Compaction Lifecycle with Persistence
  // ---------------------------------------------------------------------------

  describe("compaction lifecycle with persistence", () => {
    it("compacts, persists, and reloads correctly", async () => {
      // Track all model calls to distinguish compaction from regular calls
      const modelCalls: CallModelParams[] = [];

      const callModel = vi.fn<CallModel>(async (params: CallModelParams) => {
        modelCalls.push(params);
        // Compaction calls have the summarizer system prompt
        if (params.system.includes("summarizing a conversation")) {
          return textResponse("Summary: discussed TypeScript and Rust.");
        }
        return textResponse(`Response ${modelCalls.length}`);
      });

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      // Pre-fill conversation to trigger overflow.
      // Each message: "Message N: " (11 chars) + 200 x's = 211 chars = ~53 tokens.
      // With contextWindow=1200, maxTokens=200, system prompt ~12 tokens:
      //   budget = 1200 - 12 - 200 = 988 tokens
      // 20 pre-filled + 1 new user (~6 tokens) = 20*53 + 6 = 1066 tokens > 988.
      // Compaction reserve (clamped to 50%) = 494. keepBudget = 494.
      // Keeps ~9 messages, compacts ~12. Leaves headroom for future turns.
      for (let i = 0; i < 20; i++) {
        store.appendMessage({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}: ${"x".repeat(200)}`,
        });
      }

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 200,
        contextWindow: 1200,
        callModel,
      });

      // This turn should trigger compaction
      const response = await agent.processTurn("New message");
      expect(typeof response).toBe("string");

      // Verify compaction happened
      const metadata = store.getMetadata();
      expect(metadata.compactionCount).toBe(1);

      // Verify transcript was replaced (fewer messages than original 21)
      const messages = store.getMessages();
      expect(messages.length).toBeLessThan(21);

      // First message should be the compaction summary
      expect(messages[0].role).toBe("user");
      expect(typeof messages[0].content).toBe("string");
      expect(messages[0].content as string).toContain("[Conversation Summary]");
      expect(messages[0].content as string).toContain("TypeScript and Rust");

      // Verify persistence: reload from disk
      const storage2 = createStorage(dataDir);
      const store2 = createConversationStore(storage2, "conv");
      const loaded = store2.load();

      // Reloaded state matches post-compaction in-memory state
      expect(loaded.messages).toHaveLength(messages.length);
      expect(loaded.messages[0]).toEqual(messages[0]);
      expect(loaded.metadata.compactionCount).toBe(1);

      // Last message is the assistant's response to "What did we discuss?"
      const lastMsg = loaded.messages[loaded.messages.length - 1];
      expect(lastMsg.role).toBe("assistant");
    });

    it("continues operating normally after compaction", async () => {
      const callModel = vi.fn<CallModel>(async (params: CallModelParams) => {
        if (params.system.includes("summarizing a conversation")) {
          return textResponse("Summary: earlier testing.");
        }
        return textResponse("Post-compaction response");
      });

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      // Fill to trigger compaction (same sizing as "compacts, persists, reloads" test)
      for (let i = 0; i < 20; i++) {
        store.appendMessage({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}: ${"y".repeat(200)}`,
        });
      }

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 200,
        contextWindow: 1200,
        callModel,
      });

      // Turn 1: triggers compaction
      await agent.processTurn("Trigger compaction");
      expect(store.getMetadata().compactionCount).toBe(1);

      // Turn 2: normal operation after compaction (reserve provides headroom)
      const agent2 = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      const response = await agent2.processTurn("New question after compaction");
      expect(response).toBe("Post-compaction response");

      // Verify compaction summary is in the context sent to the model
      const lastCallParams = callModel.mock.calls[callModel.mock.calls.length - 1][0];
      const firstMessage = lastCallParams.messages[0];
      expect(typeof firstMessage.content).toBe("string");
      expect(firstMessage.content as string).toContain("[Conversation Summary]");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Crash Recovery
  // ---------------------------------------------------------------------------

  describe("crash recovery", () => {
    it("recovers conversation state after simulated crash", async () => {
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(textResponse("Response 1"))
        .mockResolvedValueOnce(textResponse("Response 2"))
        .mockResolvedValueOnce(textResponse("Response after recovery"));

      // -- Session 1: two turns, then "crash" (just drop references) --
      const storage1 = createStorage(dataDir);
      const store1 = createConversationStore(storage1, "conv");
      store1.initialize("claude-test");

      const agent1 = createAgent({
        conversationStore: store1,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      await agent1.processTurn("First message");
      await agent1.processTurn("Second message");

      // Verify 4 messages exist
      expect(store1.getMessages()).toHaveLength(4);

      // -- "Crash": create entirely new storage/store/agent from disk --
      const storage2 = createStorage(dataDir);
      const store2 = createConversationStore(storage2, "conv");
      store2.load();

      // Verify recovery
      expect(store2.getMessages()).toHaveLength(4);
      expect(store2.getMessages()[0]).toEqual({ role: "user", content: "First message" });
      expect(store2.getMessages()[2]).toEqual({ role: "user", content: "Second message" });

      // Continue with new agent
      const agent2 = createAgent({
        conversationStore: store2,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      const response = await agent2.processTurn("Third message after crash");
      expect(response).toBe("Response after recovery");

      // Verify the model received full history
      const thirdCallParams = callModel.mock.calls[2][0];
      expect(thirdCallParams.messages).toHaveLength(5); // 2 user + 2 assistant + 1 new user
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Identity Evolution Between Turns
  // ---------------------------------------------------------------------------

  describe("identity evolution between turns", () => {
    it("picks up identity file changes between turns", async () => {
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(textResponse("Hello, I am Koma."))
        .mockResolvedValueOnce(textResponse("Hello, I am Koma 2.0."));

      writeFileSync(join(homeDir, "SOUL.md"), "I am Koma, version 1.");

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      // Turn 1 with original identity
      await agent.processTurn("Who are you?");
      const params1 = callModel.mock.calls[0][0];
      expect(params1.system).toContain("I am Koma, version 1.");
      expect(params1.system).not.toContain("version 2");

      // Change identity file between turns
      writeFileSync(join(homeDir, "SOUL.md"), "I am Koma, version 2.");
      writeFileSync(join(homeDir, "MEMORY.md"), "User asked about my identity.");

      // Turn 2 should see updated identity
      await agent.processTurn("Who are you now?");
      const params2 = callModel.mock.calls[1][0];
      expect(params2.system).toContain("I am Koma, version 2.");
      expect(params2.system).toContain("User asked about my identity.");
      expect(params2.system).not.toContain("version 1");
    });

    it("works when identity files are added after agent creation", async () => {
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(textResponse("Response 1"))
        .mockResolvedValueOnce(textResponse("Response 2"));

      // No identity files initially
      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      // Turn 1: no identity files
      await agent.processTurn("Hello");
      const params1 = callModel.mock.calls[0][0];
      expect(params1.system).not.toContain("SOUL");

      // Add identity files
      writeFileSync(join(homeDir, "SOUL.md"), "I have a soul now.");
      writeFileSync(join(homeDir, "IDENTITY.md"), "Name: Koma");

      // Turn 2: identity files now present
      await agent.processTurn("Tell me about yourself");
      const params2 = callModel.mock.calls[1][0];
      expect(params2.system).toContain("I have a soul now.");
      expect(params2.system).toContain("Name: Koma");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Complex Multi-Turn Pipeline
  // ---------------------------------------------------------------------------

  describe("complex multi-turn pipeline", () => {
    it("handles multiple turns with tools then compaction then continued operation", async () => {
      // Stateful tool: tracks files "created" by the agent
      const createdFiles: string[] = [];
      const createFileTool: ToolDefinition = {
        name: "create_file",
        description: "Creates a file",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        handler: async (input: unknown) => {
          const params = input as { name: string };
          createdFiles.push(params.name);
          return { ok: true as const, content: `Created ${params.name}` };
        },
      };

      let callCount = 0;
      const callModel = vi.fn<CallModel>(async (params: CallModelParams) => {
        callCount++;

        // Compaction summarizer
        if (params.system.includes("summarizing a conversation")) {
          return textResponse("Summary: The agent created files foo.ts and bar.ts.");
        }

        // Turn 1: use tool to create foo.ts
        if (callCount === 1) {
          return toolUseResponse([
            { id: "toolu_1", name: "create_file", input: { name: "foo.ts" } },
          ], "Creating foo.ts");
        }
        // Turn 1 continued: after tool result
        if (callCount === 2) {
          return textResponse("Created foo.ts successfully.");
        }
        // Turn 2: use tool to create bar.ts
        if (callCount === 3) {
          return toolUseResponse([
            { id: "toolu_2", name: "create_file", input: { name: "bar.ts" } },
          ], "Creating bar.ts");
        }
        // Turn 2 continued: after tool result
        if (callCount === 4) {
          return textResponse("Created bar.ts successfully.");
        }
        // Subsequent calls (post-compaction)
        return textResponse("Post-compaction: I previously created foo.ts and bar.ts.");
      });

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      // Use small context window for turns 1-2, then trigger compaction on turn 3
      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [createFileTool],
        model: "claude-test",
        maxTokens: 200,
        contextWindow: 200000, // large enough for tool turns
        callModel,
      });

      // Turn 1: tool use
      const r1 = await agent.processTurn("Create foo.ts");
      expect(r1).toBe("Created foo.ts successfully.");
      expect(createdFiles).toEqual(["foo.ts"]);

      // Turn 2: tool use
      const r2 = await agent.processTurn("Create bar.ts");
      expect(r2).toBe("Created bar.ts successfully.");
      expect(createdFiles).toEqual(["foo.ts", "bar.ts"]);

      // Verify conversation has all intermediate messages
      // Turn 1: user, assistant(tool_use), user(tool_result), assistant(text)
      // Turn 2: user, assistant(tool_use), user(tool_result), assistant(text)
      expect(store.getMessages()).toHaveLength(8);

      // Now add enough padding messages to force compaction.
      // 8 existing tool messages (~90 tokens total) + 20 padding (~1060 tokens) + 1 new (~7 tokens) = ~1157 tokens.
      // With contextWindow=1200, maxTokens=200, budget ~988:
      // selectMessages keeps ~19 most recent (~961 tokens), drops ~10 (including tool messages).
      // After compaction: summary(~20 tokens) + 19 kept(~961) = ~981 < 988. Fits.
      for (let i = 0; i < 20; i++) {
        store.appendMessage({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Padding message ${i}: ${"z".repeat(200)}`,
        });
      }

      // Create agent with context window that triggers compaction
      const agentSmall = createAgent({
        conversationStore: store,
        homeDir,
        tools: [createFileTool],
        model: "claude-test",
        maxTokens: 200,
        contextWindow: 1200,
        callModel,
      });

      // Turn 3: should trigger compaction
      const r3 = await agentSmall.processTurn("What files did we create?");
      expect(typeof r3).toBe("string");
      expect(store.getMetadata().compactionCount).toBe(1);

      // Verify compaction summary references the tools
      const messages = store.getMessages();
      const summaryMsg = messages[0];
      expect(typeof summaryMsg.content).toBe("string");
      expect(summaryMsg.content as string).toContain("[Conversation Summary]");
      expect(summaryMsg.content as string).toContain("foo.ts");
      expect(summaryMsg.content as string).toContain("bar.ts");
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Module Interface Verification
  // ---------------------------------------------------------------------------

  describe("module interface composition", () => {
    it("system prompt includes tools from tool registry", async () => {
      const tool: ToolDefinition = {
        name: "search",
        description: "Searches the knowledge base",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        handler: async () => ({ ok: true as const, content: "result" }),
      };

      const callModel = vi.fn<CallModel>().mockResolvedValue(textResponse("Found it."));

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [tool],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      await agent.processTurn("Search for something");

      const params = callModel.mock.calls[0][0];

      // System prompt includes tool summary
      expect(params.system).toContain("search");
      expect(params.system).toContain("Searches the knowledge base");

      // API tools include proper schema
      expect(params.tools).toHaveLength(1);
      expect(params.tools![0]).toEqual({
        name: "search",
        description: "Searches the knowledge base",
        input_schema: tool.inputSchema,
      });
    });

    it("context window receives all conversation store messages", async () => {
      const callModel = vi.fn<CallModel>().mockResolvedValue(textResponse("R"));

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      // Pre-fill with known messages
      store.appendMessage({ role: "user", content: "msg-1" });
      store.appendMessage({ role: "assistant", content: "reply-1" });
      store.appendMessage({ role: "user", content: "msg-2" });
      store.appendMessage({ role: "assistant", content: "reply-2" });

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      await agent.processTurn("msg-3");

      // Model should receive all 5 messages (4 pre-existing + 1 new)
      const params = callModel.mock.calls[0][0];
      expect(params.messages).toHaveLength(5);
      expect(params.messages[0]).toEqual({ role: "user", content: "msg-1" });
      expect(params.messages[1]).toEqual({ role: "assistant", content: "reply-1" });
      expect(params.messages[2]).toEqual({ role: "user", content: "msg-2" });
      expect(params.messages[3]).toEqual({ role: "assistant", content: "reply-2" });
      expect(params.messages[4]).toEqual({ role: "user", content: "msg-3" });
    });

    it("model parameters match agent config exactly", async () => {
      writeFileSync(join(homeDir, "SOUL.md"), "Test soul content.");

      const callModel = vi.fn<CallModel>().mockResolvedValue(textResponse("OK"));

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-sonnet-4-20250514");

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-sonnet-4-20250514",
        maxTokens: 8192,
        contextWindow: 200000,
        callModel,
      });

      await agent.processTurn("Test");

      const params = callModel.mock.calls[0][0];
      expect(params.model).toBe("claude-sonnet-4-20250514");
      expect(params.max_tokens).toBe(8192);
      expect(params.system).toContain("Test soul content.");
      expect(params.system).toContain("Current Time");
      expect(params.tools).toBeUndefined(); // no tools configured
    });

    it("conversation metadata tracks all operations correctly", async () => {
      const callModel = vi.fn<CallModel>(async (params: CallModelParams) => {
        if (params.system.includes("summarizing a conversation")) {
          return textResponse("Compact summary.");
        }
        return textResponse("OK");
      });

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      const meta0 = store.getMetadata();
      expect(meta0.compactionCount).toBe(0);
      expect(meta0.model).toBe("claude-test");
      const createdAt = meta0.createdAt;

      // Add turns
      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      await agent.processTurn("Hello");

      const meta1 = store.getMetadata();
      expect(meta1.createdAt).toBe(createdAt); // unchanged
      expect(meta1.updatedAt).toBeGreaterThanOrEqual(meta0.updatedAt);
      expect(meta1.compactionCount).toBe(0);

      // Force compaction: add enough messages to overflow with small context window.
      // 2 existing (from turn above) + 20 padding + 1 new = 23 messages.
      for (let i = 0; i < 20; i++) {
        store.appendMessage({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Padding ${i}: ${"x".repeat(200)}`,
        });
      }

      const agentSmall = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 200,
        contextWindow: 1200,
        callModel,
      });

      await agentSmall.processTurn("Compact now");

      const meta2 = store.getMetadata();
      expect(meta2.createdAt).toBe(createdAt); // still unchanged
      expect(meta2.compactionCount).toBe(1);
      expect(meta2.updatedAt).toBeGreaterThanOrEqual(meta1.updatedAt);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Data Integrity: Round-Trip Serialization
  // ---------------------------------------------------------------------------

  describe("data integrity", () => {
    it("tool_use and tool_result content blocks survive JSON round-trip", async () => {
      const tool: ToolDefinition = {
        name: "calculator",
        description: "Does math",
        inputSchema: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
        },
        handler: async (input: unknown) => {
          const params = input as { expression: string };
          return { ok: true as const, content: `Result: ${params.expression} = 42` };
        },
      };

      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(
          toolUseResponse([
            { id: "toolu_calc", name: "calculator", input: { expression: "6 * 7" } },
          ])
        )
        .mockResolvedValueOnce(textResponse("The answer is 42."));

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [tool],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      await agent.processTurn("What is 6 * 7?");

      // Reload from disk
      const storage2 = createStorage(dataDir);
      const store2 = createConversationStore(storage2, "conv");
      const loaded = store2.load();

      // Verify tool_use block survived
      const assistantMsg = loaded.messages[1];
      expect(assistantMsg.role).toBe("assistant");
      const assistantBlocks = assistantMsg.content as ContentBlock[];
      const toolUseBlock = assistantBlocks.find((b) => b.type === "tool_use");
      expect(toolUseBlock).toBeDefined();
      expect(toolUseBlock).toMatchObject({
        type: "tool_use",
        id: "toolu_calc",
        name: "calculator",
        input: { expression: "6 * 7" },
      });

      // Verify tool_result block survived
      const toolResultMsg = loaded.messages[2];
      expect(toolResultMsg.role).toBe("user");
      const resultBlocks = toolResultMsg.content as ContentBlock[];
      const toolResultBlock = resultBlocks.find((b) => b.type === "tool_result");
      expect(toolResultBlock).toBeDefined();
      expect(toolResultBlock).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_calc",
        content: "Result: 6 * 7 = 42",
      });

      // Verify final text response survived
      const finalMsg = loaded.messages[3];
      expect(finalMsg.role).toBe("assistant");
      const finalBlocks = finalMsg.content as ContentBlock[];
      expect(finalBlocks[0]).toMatchObject({
        type: "text",
        text: "The answer is 42.",
      });
    });

    it("conversation store transcript.jsonl matches expected format on disk", async () => {
      const callModel = vi.fn<CallModel>().mockResolvedValue(textResponse("Reply"));

      const storage = createStorage(dataDir);
      const store = createConversationStore(storage, "conv");
      store.initialize("claude-test");

      const agent = createAgent({
        conversationStore: store,
        homeDir,
        tools: [],
        model: "claude-test",
        maxTokens: 4096,
        contextWindow: 200000,
        callModel,
      });

      await agent.processTurn("Hello");

      // Read raw JSONL from disk
      const transcriptPath = join(dataDir, "conv", "transcript.jsonl");
      const raw = readFileSync(transcriptPath, "utf-8");
      const lines = raw.split("\n").filter((line) => line.trim() !== "");

      expect(lines).toHaveLength(2);

      // Each line is valid JSON
      const msg0 = JSON.parse(lines[0]) as Message;
      const msg1 = JSON.parse(lines[1]) as Message;

      expect(msg0).toEqual({ role: "user", content: "Hello" });
      expect(msg1.role).toBe("assistant");
      expect(Array.isArray(msg1.content)).toBe(true);
    });
  });
});

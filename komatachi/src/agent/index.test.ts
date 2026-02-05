import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAgent, AgentError, ModelCallError } from "./index.js";
import type { AgentConfig, CallModel, CallModelResult } from "./index.js";
import { createStorage } from "../storage/index.js";
import { createConversationStore } from "../conversation/index.js";
import type { Message, ContentBlock } from "../conversation/index.js";
import type { ToolDefinition } from "../tools/index.js";

// -----------------------------------------------------------------------------
// Test Helpers
// -----------------------------------------------------------------------------

/** Create a text response from the model */
function textResponse(text: string): CallModelResult {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  };
}

/** Create a tool_use response from the model */
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
  return {
    content,
    stop_reason: "tool_use",
  };
}

/** Create a simple echo tool for testing */
function createEchoTool(): ToolDefinition {
  return {
    name: "echo",
    description: "Echoes the input back",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    handler: async (input: unknown) => {
      const params = input as { text: string };
      return { ok: true as const, content: `Echo: ${params.text}` };
    },
  };
}

/** Create a tool that always fails */
function createFailingTool(): ToolDefinition {
  return {
    name: "fail",
    description: "Always fails",
    inputSchema: { type: "object" },
    handler: async () => {
      return { ok: false as const, error: "Tool execution failed" };
    },
  };
}

/** Create a tool that throws an exception */
function createThrowingTool(): ToolDefinition {
  return {
    name: "throw",
    description: "Throws an error",
    inputSchema: { type: "object" },
    handler: async () => {
      throw new Error("Unexpected exception");
    },
  };
}

// -----------------------------------------------------------------------------
// Test Setup
// -----------------------------------------------------------------------------

describe("Agent Loop", () => {
  let tempDir: string;
  let homeDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "komatachi-agent-test-"));
    homeDir = join(tempDir, "home");
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Create a configured agent with the given callModel mock and tools */
  function setupAgent(
    callModel: CallModel,
    tools: ToolDefinition[] = [],
    overrides: Partial<AgentConfig> = {}
  ) {
    const storage = createStorage(join(tempDir, "data"));
    const conversationStore = createConversationStore(storage, "conversation");
    conversationStore.initialize("test-model");

    const agent = createAgent({
      conversationStore,
      homeDir,
      tools,
      model: "test-model",
      maxTokens: 4096,
      contextWindow: 200000,
      callModel,
      ...overrides,
    });

    return { agent, conversationStore, storage };
  }

  // ---------------------------------------------------------------------------
  // Normal Text Response
  // ---------------------------------------------------------------------------

  describe("normal text response", () => {
    it("processes a simple turn and returns text", async () => {
      const callModel = vi.fn<CallModel>().mockResolvedValue(
        textResponse("Hello! How can I help?")
      );

      const { agent } = setupAgent(callModel);
      const response = await agent.processTurn("Hi there");

      expect(response).toBe("Hello! How can I help?");
      expect(callModel).toHaveBeenCalledTimes(1);
    });

    it("appends user and assistant messages to conversation", async () => {
      const callModel = vi.fn<CallModel>().mockResolvedValue(
        textResponse("Response")
      );

      const { agent, conversationStore } = setupAgent(callModel);
      await agent.processTurn("Hello");

      const messages = conversationStore.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: "user", content: "Hello" });
      expect(messages[1].role).toBe("assistant");
    });

    it("includes system prompt in model call", async () => {
      // Create a SOUL.md identity file
      writeFileSync(join(homeDir, "SOUL.md"), "I am a helpful assistant.");

      const callModel = vi.fn<CallModel>().mockResolvedValue(
        textResponse("Response")
      );

      const { agent } = setupAgent(callModel);
      await agent.processTurn("Hello");

      const params = callModel.mock.calls[0][0];
      expect(params.system).toContain("I am a helpful assistant.");
      expect(params.model).toBe("test-model");
      expect(params.max_tokens).toBe(4096);
    });

    it("passes messages to model call", async () => {
      const callModel = vi.fn<CallModel>().mockResolvedValue(
        textResponse("Response")
      );

      const { agent } = setupAgent(callModel);
      await agent.processTurn("Hello");

      const params = callModel.mock.calls[0][0];
      expect(params.messages).toHaveLength(1);
      expect(params.messages[0]).toEqual({ role: "user", content: "Hello" });
    });

    it("handles multi-turn conversation", async () => {
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(textResponse("First response"))
        .mockResolvedValueOnce(textResponse("Second response"));

      const { agent, conversationStore } = setupAgent(callModel);

      await agent.processTurn("First message");
      await agent.processTurn("Second message");

      const messages = conversationStore.getMessages();
      expect(messages).toHaveLength(4); // 2 user + 2 assistant
      expect(callModel).toHaveBeenCalledTimes(2);

      // Second call should include all previous messages
      const secondCallParams = callModel.mock.calls[1][0];
      expect(secondCallParams.messages.length).toBe(3); // first user + first assistant + second user
    });

    it("handles max_tokens stop reason", async () => {
      const callModel = vi.fn<CallModel>().mockResolvedValue({
        content: [{ type: "text", text: "Truncated respo" }],
        stop_reason: "max_tokens",
      });

      const { agent } = setupAgent(callModel);
      const response = await agent.processTurn("Hello");

      expect(response).toBe("Truncated respo");
    });

    it("returns empty string when response has no text blocks", async () => {
      const callModel = vi.fn<CallModel>().mockResolvedValue({
        content: [],
        stop_reason: "end_turn",
      });

      const { agent } = setupAgent(callModel);
      const response = await agent.processTurn("Hello");

      expect(response).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // Tool Use
  // ---------------------------------------------------------------------------

  describe("tool dispatch", () => {
    it("executes a single tool and returns final response", async () => {
      const echoTool = createEchoTool();
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(
          toolUseResponse([
            { id: "toolu_1", name: "echo", input: { text: "world" } },
          ], "Let me echo that.")
        )
        .mockResolvedValueOnce(textResponse("I echoed: world"));

      const { agent, conversationStore } = setupAgent(callModel, [echoTool]);
      const response = await agent.processTurn("Echo world");

      expect(response).toBe("I echoed: world");
      expect(callModel).toHaveBeenCalledTimes(2);

      // Verify conversation store has all messages
      const messages = conversationStore.getMessages();
      expect(messages).toHaveLength(4); // user, assistant(tool_use), user(tool_result), assistant(text)

      // Verify tool result message
      const toolResultMsg = messages[2];
      expect(toolResultMsg.role).toBe("user");
      expect(Array.isArray(toolResultMsg.content)).toBe(true);
      const blocks = toolResultMsg.content as ContentBlock[];
      expect(blocks[0].type).toBe("tool_result");
      expect((blocks[0] as { content: string }).content).toBe("Echo: world");
    });

    it("handles multiple tool calls in a single response", async () => {
      const echoTool = createEchoTool();
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(
          toolUseResponse([
            { id: "toolu_1", name: "echo", input: { text: "one" } },
            { id: "toolu_2", name: "echo", input: { text: "two" } },
          ])
        )
        .mockResolvedValueOnce(textResponse("Done"));

      const { agent, conversationStore } = setupAgent(callModel, [echoTool]);
      const response = await agent.processTurn("Echo both");

      expect(response).toBe("Done");

      // Tool result message should have both results
      const messages = conversationStore.getMessages();
      const toolResultMsg = messages[2];
      const blocks = toolResultMsg.content as ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect((blocks[0] as { content: string }).content).toBe("Echo: one");
      expect((blocks[1] as { content: string }).content).toBe("Echo: two");
    });

    it("handles tool not found", async () => {
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(
          toolUseResponse([
            { id: "toolu_1", name: "nonexistent", input: {} },
          ])
        )
        .mockResolvedValueOnce(textResponse("Tool was not found."));

      const { agent, conversationStore } = setupAgent(callModel, []);
      const response = await agent.processTurn("Use tool");

      expect(response).toBe("Tool was not found.");

      // Verify error tool result
      const messages = conversationStore.getMessages();
      const toolResultMsg = messages[2];
      const blocks = toolResultMsg.content as ContentBlock[];
      expect(blocks[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "Tool not found: nonexistent",
        is_error: true,
      });
    });

    it("handles tool execution returning error result", async () => {
      const failTool = createFailingTool();
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(
          toolUseResponse([
            { id: "toolu_1", name: "fail", input: {} },
          ])
        )
        .mockResolvedValueOnce(textResponse("Tool failed."));

      const { agent, conversationStore } = setupAgent(callModel, [failTool]);
      await agent.processTurn("Try failing tool");

      const messages = conversationStore.getMessages();
      const toolResultMsg = messages[2];
      const blocks = toolResultMsg.content as ContentBlock[];
      expect(blocks[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "Tool execution failed",
        is_error: true,
      });
    });

    it("handles tool handler throwing exception", async () => {
      const throwTool = createThrowingTool();
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(
          toolUseResponse([
            { id: "toolu_1", name: "throw", input: {} },
          ])
        )
        .mockResolvedValueOnce(textResponse("Error handled."));

      const { agent, conversationStore } = setupAgent(callModel, [throwTool]);
      await agent.processTurn("Try throwing tool");

      // executeTool catches exceptions and returns error result
      const messages = conversationStore.getMessages();
      const toolResultMsg = messages[2];
      const blocks = toolResultMsg.content as ContentBlock[];
      expect(blocks[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "Unexpected exception",
        is_error: true,
      });
    });

    it("handles multiple rounds of tool use", async () => {
      const echoTool = createEchoTool();
      const callModel = vi.fn<CallModel>()
        .mockResolvedValueOnce(
          toolUseResponse([
            { id: "toolu_1", name: "echo", input: { text: "first" } },
          ])
        )
        .mockResolvedValueOnce(
          toolUseResponse([
            { id: "toolu_2", name: "echo", input: { text: "second" } },
          ])
        )
        .mockResolvedValueOnce(textResponse("All done."));

      const { agent } = setupAgent(callModel, [echoTool]);
      const response = await agent.processTurn("Multi-round");

      expect(response).toBe("All done.");
      expect(callModel).toHaveBeenCalledTimes(3);
    });

    it("does not send tools param when no tools configured", async () => {
      const callModel = vi.fn<CallModel>().mockResolvedValue(
        textResponse("Response")
      );

      const { agent } = setupAgent(callModel, []);
      await agent.processTurn("Hello");

      const params = callModel.mock.calls[0][0];
      expect(params.tools).toBeUndefined();
    });

    it("exports tools for API when tools are configured", async () => {
      const echoTool = createEchoTool();
      const callModel = vi.fn<CallModel>().mockResolvedValue(
        textResponse("Response")
      );

      const { agent } = setupAgent(callModel, [echoTool]);
      await agent.processTurn("Hello");

      const params = callModel.mock.calls[0][0];
      expect(params.tools).toHaveLength(1);
      expect(params.tools![0]).toEqual({
        name: "echo",
        description: "Echoes the input back",
        input_schema: echoTool.inputSchema,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  describe("compaction", () => {
    it("triggers compaction when messages overflow token budget", async () => {
      const callModel = vi.fn<CallModel>()
        // First call: compaction summarizer
        .mockResolvedValueOnce(textResponse("Summary of earlier conversation"))
        // Second call: actual response after compaction
        .mockResolvedValueOnce(textResponse("Response after compaction"));

      const storage = createStorage(join(tempDir, "data"));
      const conversationStore = createConversationStore(storage, "conversation");
      conversationStore.initialize("test-model");

      // Pre-fill conversation with messages to force overflow.
      // Each message is ~53 tokens (211 chars / 4).
      // With contextWindow=1200, maxTokens=200, system prompt ~50 tokens:
      //   budget = 1200 - 50 - 200 = 950, fits ~18 messages
      // 20 pre-filled + 1 new = ~1060 tokens, overflows.
      // Compaction reserve (clamped to 50% of budget) = 475.
      // keepBudget = 475, keeps ~9 messages, compacts ~12 (~636 tokens).
      for (let i = 0; i < 20; i++) {
        conversationStore.appendMessage({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}: ${"x".repeat(200)}`,
        });
      }

      const agent = createAgent({
        conversationStore,
        homeDir,
        tools: [],
        model: "test-model",
        maxTokens: 200,
        contextWindow: 1200,
        callModel,
      });

      const response = await agent.processTurn("New message");

      expect(response).toBe("Response after compaction");
      // Model was called for compaction + actual response
      expect(callModel.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Verify compaction metadata was updated
      const metadata = conversationStore.getMetadata();
      expect(metadata.compactionCount).toBe(1);

      // Verify transcript was replaced (should be shorter than original 21 messages)
      const messages = conversationStore.getMessages();
      expect(messages.length).toBeLessThan(21);

      // First message should be the compaction summary
      expect(messages[0].role).toBe("user");
      expect(typeof messages[0].content).toBe("string");
      expect(messages[0].content as string).toContain("[Conversation Summary]");
    });
  });

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  describe("error handling", () => {
    it("throws ModelCallError when callModel fails", async () => {
      const callModel = vi.fn<CallModel>().mockRejectedValue(
        new Error("Network timeout")
      );

      const { agent } = setupAgent(callModel);

      await expect(agent.processTurn("Hello")).rejects.toThrow(ModelCallError);
      await expect(agent.processTurn("Hello")).rejects.toThrow("Network timeout");
    });

    it("ModelCallError preserves the original cause", async () => {
      const originalError = new Error("API rate limit");
      const callModel = vi.fn<CallModel>().mockRejectedValue(originalError);

      const { agent } = setupAgent(callModel);

      try {
        await agent.processTurn("Hello");
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelCallError);
        expect((error as ModelCallError).cause).toBe(originalError);
      }
    });

    it("throws AgentError when token budget is exhausted", async () => {
      const callModel = vi.fn<CallModel>();

      // Context window too small to fit anything
      const { agent } = setupAgent(callModel, [], {
        contextWindow: 100,
        maxTokens: 50,
      });

      // Identity files + system prompt will eat the small budget
      writeFileSync(join(homeDir, "SOUL.md"), "x".repeat(400));

      await expect(agent.processTurn("Hello")).rejects.toThrow(AgentError);
      await expect(agent.processTurn("Hello")).rejects.toThrow("Token budget exhausted");
      expect(callModel).not.toHaveBeenCalled();
    });

    it("throws AgentError when max model calls exceeded", async () => {
      // Create a tool that Claude keeps calling indefinitely
      const infiniteTool: ToolDefinition = {
        name: "loop",
        description: "Loops forever",
        inputSchema: { type: "object" },
        handler: async () => ({ ok: true as const, content: "done" }),
      };

      // Always return tool_use, never end_turn
      const callModel = vi.fn<CallModel>().mockResolvedValue(
        toolUseResponse([{ id: "toolu_1", name: "loop", input: {} }])
      );

      const { agent } = setupAgent(callModel, [infiniteTool]);

      await expect(agent.processTurn("Loop")).rejects.toThrow(AgentError);
      await expect(agent.processTurn("Loop")).rejects.toThrow(
        "exceeded maximum"
      );
    });

    it("user message is persisted even when model call fails", async () => {
      const callModel = vi.fn<CallModel>().mockRejectedValue(
        new Error("API error")
      );

      const { agent, conversationStore } = setupAgent(callModel);

      try {
        await agent.processTurn("Hello");
      } catch {
        // expected
      }

      // User message should be in the store even though the turn failed
      const messages = conversationStore.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: "user", content: "Hello" });
    });
  });

  // ---------------------------------------------------------------------------
  // Identity Integration
  // ---------------------------------------------------------------------------

  describe("identity integration", () => {
    it("loads identity files into system prompt", async () => {
      writeFileSync(join(homeDir, "SOUL.md"), "I am Koma, a helpful entity.");
      writeFileSync(join(homeDir, "IDENTITY.md"), "Name: Koma");
      writeFileSync(join(homeDir, "MEMORY.md"), "User prefers TypeScript.");

      const callModel = vi.fn<CallModel>().mockResolvedValue(
        textResponse("Response")
      );

      const { agent } = setupAgent(callModel);
      await agent.processTurn("Hello");

      const params = callModel.mock.calls[0][0];
      expect(params.system).toContain("I am Koma, a helpful entity.");
      expect(params.system).toContain("Name: Koma");
      expect(params.system).toContain("User prefers TypeScript.");
    });

    it("works with no identity files", async () => {
      const callModel = vi.fn<CallModel>().mockResolvedValue(
        textResponse("Response")
      );

      const { agent } = setupAgent(callModel);
      const response = await agent.processTurn("Hello");

      expect(response).toBe("Response");
      // System prompt should still include runtime info (timestamp)
      const params = callModel.mock.calls[0][0];
      expect(params.system).toContain("Current Time");
    });

    it("includes tool summaries in system prompt", async () => {
      const echoTool = createEchoTool();
      const callModel = vi.fn<CallModel>().mockResolvedValue(
        textResponse("Response")
      );

      const { agent } = setupAgent(callModel, [echoTool]);
      await agent.processTurn("Hello");

      const params = callModel.mock.calls[0][0];
      expect(params.system).toContain("echo");
      expect(params.system).toContain("Echoes the input back");
    });
  });

  // ---------------------------------------------------------------------------
  // Context Window Integration
  // ---------------------------------------------------------------------------

  describe("context window integration", () => {
    it("selects messages within token budget", async () => {
      const callModel = vi.fn<CallModel>().mockResolvedValue(
        textResponse("Response")
      );

      const storage = createStorage(join(tempDir, "data"));
      const conversationStore = createConversationStore(storage, "conversation");
      conversationStore.initialize("test-model");

      // Add many messages
      for (let i = 0; i < 10; i++) {
        conversationStore.appendMessage({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
        });
      }

      const agent = createAgent({
        conversationStore,
        homeDir,
        tools: [],
        model: "test-model",
        maxTokens: 4096,
        contextWindow: 200000, // Large enough to fit all messages
        callModel,
      });

      await agent.processTurn("Latest message");

      // All 11 messages (10 pre-existing + 1 new) should be sent
      const params = callModel.mock.calls[0][0];
      expect(params.messages).toHaveLength(11);
    });
  });
});

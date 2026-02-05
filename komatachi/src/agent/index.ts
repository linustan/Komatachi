/**
 * Agent Loop Module
 *
 * The main execution loop that ties everything together. Accepts user input,
 * builds context, calls Claude, processes response, persists to conversation.
 *
 * Wires together: Conversation Store, Context Window, System Prompt,
 * Tool Registry, Compaction, and the Claude API.
 *
 * Design principles:
 * - One agent, one conversation, one process
 * - callModel injected for testability (not a provider abstraction -- Claude-specific types)
 * - Non-streaming: complete response before processing
 * - Fail clearly: surface errors, no silent retries beyond SDK defaults
 * - Synchronous disk I/O, async only for LLM calls and tool execution
 */

import type {
  ConversationStore,
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "../conversation/index.js";
import { selectMessages, estimateStringTokens } from "../context/index.js";
import {
  loadIdentityFiles,
  buildSystemPrompt,
  type ToolSummary,
} from "../identity/index.js";
import {
  findTool,
  executeTool,
  exportForApi,
  type ToolDefinition,
  type ApiToolDefinition,
} from "../tools/index.js";
import {
  compact,
  createSummarizer,
  calculateMaxInputTokens,
  estimateTokens,
  type FileOperations,
} from "../compaction/index.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Parameters for a model call.
 * Matches Claude API's messages.create() parameters.
 */
export interface CallModelParams {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ApiToolDefinition[];
  readonly max_tokens: number;
}

/**
 * Result from a model call.
 * Matches the relevant fields of Claude API's response.
 */
export interface CallModelResult {
  readonly content: readonly ContentBlock[];
  readonly stop_reason: "end_turn" | "tool_use" | "max_tokens";
}

/**
 * Function that calls the Claude API.
 *
 * This is injected for testability. The caller creates this function
 * using @anthropic-ai/sdk. The Agent Loop uses Claude-specific types
 * throughout -- this is not a provider abstraction.
 */
export type CallModel = (params: CallModelParams) => Promise<CallModelResult>;

/**
 * Configuration for creating an agent.
 */
export interface AgentConfig {
  /** The conversation store (must be loaded or initialized before use) */
  readonly conversationStore: ConversationStore;
  /** Directory containing identity files (SOUL.md, IDENTITY.md, etc.) */
  readonly homeDir: string;
  /** Tools available to the agent */
  readonly tools: readonly ToolDefinition[];
  /** Model identifier (e.g., "claude-sonnet-4-20250514") */
  readonly model: string;
  /** Maximum tokens for model response */
  readonly maxTokens: number;
  /** Model's context window size in tokens */
  readonly contextWindow: number;
  /** Function to call the Claude API */
  readonly callModel: CallModel;
}

/**
 * The agent interface. One method: process a turn.
 */
export interface Agent {
  /**
   * Process a single conversational turn.
   *
   * Takes user input, manages the full cycle: append to conversation,
   * build context, call Claude, handle tool use, trigger compaction
   * if needed, and return the final text response.
   *
   * May call Claude multiple times within a single turn (tool dispatch).
   * All intermediate messages are persisted to the conversation store.
   */
  processTurn(userInput: string): Promise<string>;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Base error for agent-related failures.
 */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

/**
 * Model API call failed.
 */
export class ModelCallError extends AgentError {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Maximum number of consecutive model calls within a single turn.
 * Prevents infinite tool dispatch loops.
 */
const MAX_MODEL_CALLS_PER_TURN = 25;

/**
 * Maximum number of compaction attempts within a single turn.
 * Prevents infinite compaction-retry loops.
 */
const MAX_COMPACTION_ATTEMPTS = 2;

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

/**
 * Create an agent that processes conversational turns.
 *
 * The conversation store must be loaded or initialized before calling this.
 * The agent does not manage the conversation lifecycle -- the caller
 * handles initialization/loading before creating the agent.
 */
export function createAgent(config: AgentConfig): Agent {
  const {
    conversationStore,
    homeDir,
    tools,
    model,
    maxTokens,
    contextWindow,
    callModel,
  } = config;

  async function processTurn(userInput: string): Promise<string> {
    // 1. Append user message to conversation
    const userMessage: Message = { role: "user", content: userInput };
    conversationStore.appendMessage(userMessage);

    // 2. Enter the response loop (handles tool dispatch and compaction)
    let modelCallCount = 0;
    let compactionAttempts = 0;

    while (modelCallCount < MAX_MODEL_CALLS_PER_TURN) {
      // Build system prompt (reload identity files each turn -- they may change)
      const identityFiles = loadIdentityFiles(homeDir);
      const toolSummaries: readonly ToolSummary[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
      }));
      const systemPrompt = buildSystemPrompt(identityFiles, toolSummaries, {
        currentTime: new Date().toISOString(),
      });

      // Compute token budget
      const systemPromptTokens = estimateStringTokens(systemPrompt);
      const tokenBudget = contextWindow - systemPromptTokens - maxTokens;

      if (tokenBudget <= 0) {
        throw new AgentError(
          `Token budget exhausted: contextWindow=${contextWindow}, ` +
          `systemPrompt=${systemPromptTokens}, maxTokens=${maxTokens} ` +
          `leaves no room for messages`
        );
      }

      // Select messages within budget
      const allMessages = conversationStore.getMessages();
      const { selected, overflow } = selectMessages(
        allMessages,
        tokenBudget,
        estimateTokens
      );

      // Handle overflow: trigger compaction
      if (overflow !== null) {
        if (compactionAttempts >= MAX_COMPACTION_ATTEMPTS) {
          throw new AgentError(
            `Compaction failed to reduce messages within ${MAX_COMPACTION_ATTEMPTS} attempts. ` +
            `Dropped ${overflow.droppedCount} messages (~${overflow.estimatedDroppedTokens} tokens).`
          );
        }
        await triggerCompaction(allMessages, selected);
        compactionAttempts++;
        continue; // Re-select after compaction
      }

      // Call the model
      const apiTools = exportForApi(tools);
      let response: CallModelResult;
      try {
        response = await callModel({
          model,
          system: systemPrompt,
          messages: [...selected],
          tools: apiTools.length > 0 ? apiTools : undefined,
          max_tokens: maxTokens,
        });
      } catch (error) {
        throw new ModelCallError(
          `Model call failed: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
      }

      modelCallCount++;

      // Append assistant response
      const assistantMessage: Message = {
        role: "assistant",
        content: response.content as ContentBlock[],
      };
      conversationStore.appendMessage(assistantMessage);

      // If no tool use, extract text and return
      if (response.stop_reason !== "tool_use") {
        return extractTextResponse(response.content);
      }

      // Handle tool use: execute tools and append results
      const toolResultBlocks = await dispatchToolCalls(response.content);
      const toolResultMessage: Message = {
        role: "user",
        content: toolResultBlocks,
      };
      conversationStore.appendMessage(toolResultMessage);

      // Continue the loop to call Claude again with tool results
    }

    throw new AgentError(
      `Turn exceeded maximum of ${MAX_MODEL_CALLS_PER_TURN} model calls. ` +
      `This likely indicates an infinite tool dispatch loop.`
    );
  }

  /**
   * Execute all tool_use blocks in a response and return tool_result blocks.
   */
  async function dispatchToolCalls(
    content: readonly ContentBlock[]
  ): Promise<ToolResultBlock[]> {
    const toolUseBlocks = content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use"
    );

    const results: ToolResultBlock[] = [];

    for (const toolUse of toolUseBlocks) {
      const tool = findTool(tools, toolUse.name);

      if (tool === undefined) {
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Tool not found: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      const result = await executeTool(tool, toolUse.input);
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result.ok ? result.content : result.error,
        is_error: result.ok ? undefined : true,
      });
    }

    return results;
  }

  /**
   * Trigger compaction when context overflow is detected.
   *
   * Compacts the dropped messages into a summary, then replaces
   * the transcript with [summary, ...keptMessages].
   */
  async function triggerCompaction(
    allMessages: readonly Message[],
    selectedMessages: readonly Message[]
  ): Promise<void> {
    // Messages to compact: everything that was dropped
    const dropCount = allMessages.length - selectedMessages.length;
    const messagesToCompact = allMessages.slice(0, dropCount);

    // Empty file operations for now (integration trace Gap #4)
    const fileOps: FileOperations = {
      read: new Set(),
      edited: new Set(),
      written: new Set(),
    };

    // Create summarizer using the same callModel
    const summarizer = createSummarizer({
      contextWindow,
      callModel: async (prompt: string): Promise<string> => {
        const response = await callModel({
          model,
          system: "You are a conversation summarizer. Produce a concise summary.",
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
        });
        return extractTextResponse(response.content);
      },
    });

    const maxInputTokens = calculateMaxInputTokens(contextWindow);

    const result = await compact(
      [...messagesToCompact],
      fileOps,
      {
        maxInputTokens,
        summarize: summarizer,
      }
    );

    // Build compaction summary as a user message
    const summaryMessage: Message = {
      role: "user",
      content: `[Conversation Summary]\n\n${result.summary}`,
    };

    // Replace transcript with summary + kept messages
    conversationStore.replaceTranscript([summaryMessage, ...selectedMessages]);
    conversationStore.updateMetadata({
      compactionCount: conversationStore.getMetadata().compactionCount + 1,
    });
  }

  return { processTurn };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Extract text from response content blocks.
 * Returns all text blocks joined with newlines, or empty string if none.
 */
function extractTextResponse(content: readonly ContentBlock[]): string {
  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      textParts.push((block as TextBlock).text);
    }
  }
  return textParts.join("\n");
}

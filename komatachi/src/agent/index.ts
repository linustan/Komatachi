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
 * - Logically synchronous: async/await on callModel and executeTool is a
 *   TypeScript platform concession, not an architectural choice. Every await
 *   is immediately awaited; no concurrent work happens behind it.
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

/**
 * Tokens to reserve as headroom after compaction.
 * Without this, compaction keeps messages right up to the budget edge,
 * meaning the very next turn would trigger another compaction.
 * 20k matches OpenClaw's default. For small context windows (e.g. tests),
 * clamped to at most half the budget so compaction always keeps something.
 */
const COMPACTION_RESERVE_TOKENS = 20_000;

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
        await triggerCompaction(allMessages, tokenBudget);
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

  /** Prefix used to identify compaction summary messages. */
  const SUMMARY_PREFIX = "[Conversation Summary]\n\n";

  /**
   * Trigger compaction when context overflow is detected.
   *
   * Compacts the dropped messages into an identity-aware summary,
   * then replaces the transcript with [summary, ...keptMessages].
   *
   * The summarizer receives the entity's SOUL.md so it knows what
   * matters to this entity -- relational context and identity
   * development are preserved; operational details are compressed.
   */
  async function triggerCompaction(
    allMessages: readonly Message[],
    tokenBudget: number
  ): Promise<void> {
    // Keep messages within a tighter budget, leaving headroom for future turns.
    // Clamp reserve to at most half the budget so we always keep something.
    const reserve = Math.min(COMPACTION_RESERVE_TOKENS, Math.floor(tokenBudget * 0.5));
    const keepBudget = tokenBudget - reserve;
    const { selected: keptMessages } = selectMessages(allMessages, keepBudget, estimateTokens);

    // Everything not kept gets compacted
    const dropCount = allMessages.length - keptMessages.length;
    const messagesToCompact = allMessages.slice(0, dropCount);

    // Empty file operations for now (integration trace Gap #4)
    const fileOps: FileOperations = {
      read: new Set(),
      edited: new Set(),
      written: new Set(),
    };

    // Load identity context for the summarizer
    const identityFiles = loadIdentityFiles(homeDir);
    const soulContext = identityFiles.soul;

    // Detect previous compaction summary (recursive compaction)
    let previousSummary: string | undefined;
    if (messagesToCompact.length > 0) {
      const first = messagesToCompact[0];
      if (
        first.role === "user" &&
        typeof first.content === "string" &&
        first.content.startsWith(SUMMARY_PREFIX)
      ) {
        previousSummary = first.content.slice(SUMMARY_PREFIX.length);
      }
    }

    // Build identity-aware summarizer
    const summarize = async (
      messages: readonly Message[],
      prevSummary?: string
    ): Promise<string> => {
      const conversationText = messages
        .map((msg) => {
          const content =
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
          return `[${msg.role}]: ${content}`;
        })
        .join("\n\n");

      // System prompt: tell the summarizer who it's summarizing for
      const systemParts: string[] = [
        "You are summarizing a conversation for a persistent entity " +
        "whose memory works through recursive compaction. Your summary " +
        "will become this entity's memory of what happened -- anything " +
        "not captured here is lost.",
      ];

      if (soulContext !== null) {
        systemParts.push(
          "The entity's core identity:\n" + soulContext.trim()
        );
      }

      // User prompt: identity-aware preservation criteria
      const promptParts: string[] = [
        "Summarize this conversation. This summary replaces the original " +
        "messages -- anything not captured here is lost forever.",
        "",
        "Preserve (in order of importance):",
        "1. Relational context: interactions, commitments, trust, emotional moments",
        "2. Identity development: what the entity learned about itself, " +
           "changes in self-understanding",
        "3. Important facts, decisions, and their reasoning",
        "4. Promises made, responsibilities accepted",
        "5. Key operational details (compress aggressively)",
        "",
        "Omit: routine exchanges, redundant information, mechanical " +
        "details that don't affect understanding.",
        "",
        "Include select verbatim quotes when they carry emotional weight " +
        "or the entity's own voice -- especially commitments, messages to " +
        "its future self, or moments of realization. A direct quote " +
        "preserves what a paraphrase flattens.",
        "",
        "Write in first person past tense -- this is the entity's own " +
        "memory. Be concrete -- preserve specific details that matter, " +
        "not vague summaries of sentiment.",
      ];

      if (prevSummary) {
        promptParts.push(
          "",
          "Previous memory (from an earlier compaction -- preserve its " +
          "core, do not abstract further):",
          prevSummary
        );
      }

      promptParts.push("", "Conversation to summarize:", conversationText);

      const response = await callModel({
        model,
        system: systemParts.join("\n\n"),
        messages: [{ role: "user", content: promptParts.join("\n") }],
        max_tokens: maxTokens,
      });
      return extractTextResponse(response.content);
    };

    // Pass the raw context window; compact() applies its own safety margins.
    // Do NOT use calculateMaxInputTokens() here -- that would double-apply margins.
    const maxInputTokens = contextWindow;

    const result = await compact(
      [...messagesToCompact],
      fileOps,
      {
        maxInputTokens,
        summarize,
        previousSummary,
      }
    );

    // Build compaction summary as a user message
    const summaryMessage: Message = {
      role: "user",
      content: SUMMARY_PREFIX + result.summary,
    };

    // Replace transcript with summary + kept messages
    conversationStore.replaceTranscript([summaryMessage, ...keptMessages]);
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

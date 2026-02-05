/**
 * Application Entry Point
 *
 * Wires all modules into a stdin/stdout JSON-lines process.
 * Reads config from environment variables, creates infrastructure,
 * and runs the agent loop.
 *
 * Protocol:
 *   CLI -> Agent:  {"type":"input","text":"..."}
 *   Agent -> CLI:  {"type":"ready"}
 *   Agent -> CLI:  {"type":"output","text":"..."}
 *   Agent -> CLI:  {"type":"error","message":"..."}
 */

import Anthropic from "@anthropic-ai/sdk";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { createStorage } from "./storage/index.js";
import { createConversationStore } from "./conversation/index.js";
import {
  createAgent,
  type CallModelParams,
  type CallModelResult,
  type CallModel,
} from "./agent/index.js";

// -----------------------------------------------------------------------------
// Protocol types
// -----------------------------------------------------------------------------

interface InputMessage {
  readonly type: "input";
  readonly text: string;
}

interface ReadyMessage {
  readonly type: "ready";
}

interface OutputMessage {
  readonly type: "output";
  readonly text: string;
}

interface ErrorMessage {
  readonly type: "error";
  readonly message: string;
}

type OutboundMessage = ReadyMessage | OutputMessage | ErrorMessage;

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

interface Config {
  readonly apiKey: string;
  readonly dataDir: string;
  readonly homeDir: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly contextWindow: number;
}

function readConfig(): Config {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  return {
    apiKey,
    dataDir: process.env["KOMATACHI_DATA_DIR"] ?? "/data",
    homeDir: process.env["KOMATACHI_HOME_DIR"] ?? "/home/agent",
    model: process.env["KOMATACHI_MODEL"] ?? "claude-sonnet-4-20250514",
    maxTokens: parseInt(process.env["KOMATACHI_MAX_TOKENS"] ?? "4096", 10),
    contextWindow: parseInt(
      process.env["KOMATACHI_CONTEXT_WINDOW"] ?? "200000",
      10
    ),
  };
}

// -----------------------------------------------------------------------------
// I/O helpers
// -----------------------------------------------------------------------------

function send(message: OutboundMessage): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = readConfig();

  // Infrastructure
  const storage = createStorage(config.dataDir);
  const conversationStore = createConversationStore(storage, "conversation");

  // Load or initialize conversation
  try {
    conversationStore.load();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name: string }).name === "StorageNotFoundError"
    ) {
      conversationStore.initialize(config.model);
    } else {
      throw error;
    }
  }

  // Create callModel using Anthropic SDK
  const client = new Anthropic({ apiKey: config.apiKey });

  const callModel: CallModel = async (
    params: CallModelParams
  ): Promise<CallModelResult> => {
    const response = await client.messages.create({
      model: params.model,
      system: params.system,
      messages: params.messages.map((m) => ({
        role: m.role,
        content: m.content as Anthropic.MessageCreateParams["messages"][0]["content"],
      })),
      tools: params.tools as Anthropic.Tool[] | undefined,
      max_tokens: params.max_tokens,
    });

    return {
      content: response.content.map((block) => {
        if (block.type === "text") {
          return { type: "text" as const, text: block.text };
        }
        if (block.type === "tool_use") {
          return {
            type: "tool_use" as const,
            id: block.id,
            name: block.name,
            input: block.input,
          };
        }
        // Shouldn't reach here for messages API responses
        throw new Error(`Unexpected content block type: ${(block as { type: string }).type}`);
      }),
      stop_reason: response.stop_reason as CallModelResult["stop_reason"],
    };
  };

  // Create agent
  const agent = createAgent({
    conversationStore,
    homeDir: config.homeDir,
    tools: [],
    model: config.model,
    maxTokens: config.maxTokens,
    contextWindow: config.contextWindow,
    callModel,
  });

  // Signal readiness
  send({ type: "ready" });

  // Read stdin line by line
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      send({ type: "error", message: "Invalid JSON on stdin" });
      continue;
    }

    const msg = parsed as InputMessage;
    if (msg.type !== "input" || typeof msg.text !== "string") {
      send({ type: "error", message: "Expected {\"type\":\"input\",\"text\":\"...\"}" });
      continue;
    }

    try {
      const response = await agent.processTurn(msg.text);
      send({ type: "output", text: response });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      send({ type: "error", message: errorMessage });
    }
  }
}

main().catch((error) => {
  send({ type: "error", message: `Fatal: ${error instanceof Error ? error.message : String(error)}` });
  process.exit(1);
});

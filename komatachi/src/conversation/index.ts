/**
 * Conversation Store Module
 *
 * Persists and loads the single conversation for this agent.
 * Append messages, read history, store metadata.
 * No session IDs, no lifecycle state machine, no multi-conversation management.
 *
 * Design principles:
 * - Make state explicit: In-memory messages + metadata, synced to disk on writes
 * - Respect layer boundaries: Uses Storage for I/O, adds conversation semantics
 * - Fail clearly: Explicit initialization, no implicit creation
 * - One conversation per agent: No session multiplexing
 * - Synchronous I/O: All operations are synchronous (disk writes are single-digit ms)
 */

import type { Storage } from "../storage/index.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Claude API content block types.
 * These mirror the shapes used by the Anthropic SDK.
 */
export type TextBlock = {
  readonly type: "text";
  readonly text: string;
};

export type ToolUseBlock = {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};

export type ToolResultBlock = {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string | ReadonlyArray<TextBlock>;
  readonly is_error?: boolean;
};

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/**
 * A conversation message in Claude API format.
 *
 * Uses Claude's native message structure directly (Decision #13).
 * role is "user" or "assistant" -- tool results are content blocks
 * within user messages, not separate messages with a tool role.
 */
export interface Message {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<ContentBlock>;
}

/**
 * Metadata about the conversation. Persisted as a JSON file.
 */
export interface ConversationMetadata {
  /** When the conversation was first created (epoch ms) */
  readonly createdAt: number;
  /** When the conversation was last updated (epoch ms) */
  readonly updatedAt: number;
  /** How many times the conversation has been compacted */
  readonly compactionCount: number;
  /** The model used for the conversation */
  readonly model: string | null;
}

/**
 * The full state of a loaded conversation.
 */
export interface ConversationState {
  readonly metadata: ConversationMetadata;
  readonly messages: readonly Message[];
}

/**
 * Conversation Store: manages the single conversation for an agent.
 *
 * Holds messages and metadata in memory after load(). All mutations
 * go through methods that sync to both memory and disk.
 */
export interface ConversationStore {
  /** Load the conversation from disk into memory. Must be called before other operations. */
  load(): ConversationState;

  /** Create a new conversation (metadata + empty transcript). Fails if already exists. */
  initialize(model?: string): void;

  /** Append a message to both memory and disk */
  appendMessage(message: Message): void;

  /** Return in-memory messages (no disk I/O) */
  getMessages(): readonly Message[];

  /** Return in-memory metadata (no disk I/O) */
  getMetadata(): ConversationMetadata;

  /** Atomically replace the entire transcript (for compaction) */
  replaceTranscript(messages: readonly Message[]): void;

  /** Update metadata fields (partial update, merged with existing) */
  updateMetadata(updates: Partial<Pick<ConversationMetadata, "compactionCount" | "model">>): void;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Conversation has not been loaded yet. Call load() first.
 */
export class ConversationNotLoadedError extends Error {
  constructor() {
    super("Conversation not loaded. Call load() before accessing state.");
    this.name = "ConversationNotLoadedError";
  }
}

/**
 * Attempted to initialize a conversation that already exists.
 */
export class ConversationAlreadyExistsError extends Error {
  constructor(public readonly path: string) {
    super(`Conversation already exists at: ${path}`);
    this.name = "ConversationAlreadyExistsError";
  }
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const METADATA_FILE = "metadata.json";
const TRANSCRIPT_FILE = "transcript.jsonl";

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

/**
 * Create a conversation store for the given directory.
 *
 * The conversation directory is relative to the storage's base directory.
 * Files created:
 * - {conversationDir}/metadata.json   -- conversation metadata
 * - {conversationDir}/transcript.jsonl -- append-only message log
 */
export function createConversationStore(
  storage: Storage,
  conversationDir: string
): ConversationStore {
  const metadataPath = `${conversationDir}/${METADATA_FILE}`;
  const transcriptPath = `${conversationDir}/${TRANSCRIPT_FILE}`;

  // In-memory state. null = not loaded yet.
  let loadedMetadata: ConversationMetadata | null = null;
  let loadedMessages: Message[] | null = null;

  function requireLoaded(): void {
    if (loadedMetadata === null || loadedMessages === null) {
      throw new ConversationNotLoadedError();
    }
  }

  return {
    load(): ConversationState {
      const metadata = storage.readJson<ConversationMetadata>(metadataPath);
      const messages = storage.readAllJsonl<Message>(transcriptPath);

      loadedMetadata = metadata;
      loadedMessages = messages;

      return { metadata, messages };
    },

    initialize(model?: string): void {
      // Check if conversation already exists by attempting to read metadata
      let exists = true;
      try {
        storage.readJson(metadataPath);
      } catch (error) {
        if (error && typeof error === "object" && "name" in error &&
            (error as { name: string }).name === "StorageNotFoundError") {
          exists = false;
        } else {
          throw error;
        }
      }

      if (exists) {
        throw new ConversationAlreadyExistsError(conversationDir);
      }

      const now = Date.now();
      const metadata: ConversationMetadata = {
        createdAt: now,
        updatedAt: now,
        compactionCount: 0,
        model: model ?? null,
      };

      storage.writeJson(metadataPath, metadata);
      storage.writeJsonl(transcriptPath, []);

      loadedMetadata = metadata;
      loadedMessages = [];
    },

    appendMessage(message: Message): void {
      requireLoaded();

      // Append to disk first (crash safety: if this fails, memory is unchanged)
      storage.appendJsonl(transcriptPath, message);

      // Update in-memory state
      loadedMessages!.push(message);

      // Update metadata timestamp
      const updatedMetadata: ConversationMetadata = {
        ...loadedMetadata!,
        updatedAt: Date.now(),
      };
      storage.writeJson(metadataPath, updatedMetadata);
      loadedMetadata = updatedMetadata;
    },

    getMessages(): readonly Message[] {
      requireLoaded();
      return loadedMessages!;
    },

    getMetadata(): ConversationMetadata {
      requireLoaded();
      return loadedMetadata!;
    },

    replaceTranscript(messages: readonly Message[]): void {
      requireLoaded();

      // Atomic rewrite on disk first
      storage.writeJsonl(transcriptPath, [...messages]);

      // Replace in-memory state
      loadedMessages = [...messages];

      // Update metadata timestamp
      const updatedMetadata: ConversationMetadata = {
        ...loadedMetadata!,
        updatedAt: Date.now(),
      };
      storage.writeJson(metadataPath, updatedMetadata);
      loadedMetadata = updatedMetadata;
    },

    updateMetadata(
      updates: Partial<Pick<ConversationMetadata, "compactionCount" | "model">>
    ): void {
      requireLoaded();

      const updatedMetadata: ConversationMetadata = {
        ...loadedMetadata!,
        ...updates,
        updatedAt: Date.now(),
      };

      storage.writeJson(metadataPath, updatedMetadata);
      loadedMetadata = updatedMetadata;
    },
  };
}

# Conversation Store Module Decisions

Architectural decisions made during the distillation of the Conversation Store module.

## What We Preserved

### Append-only transcript pattern
OpenClaw persists messages by appending to a JSONL transcript file. Each message is written immediately -- no batching, no deferred writes. If the process crashes, all messages up to the crash point are on disk. Preserved as-is via Storage's `appendJsonl`.

### Metadata as separate JSON file
OpenClaw stores session metadata (timestamps, model config, compaction count) separately from the transcript. This makes sense: metadata is read-modify-write (small, updated in place), while transcripts are append-only (large, sequential). Preserved this separation.

### In-memory message cache
OpenClaw keeps session data in memory to avoid re-reading from disk on every access. The Conversation Store loads messages into memory on `load()` and keeps them synced through its methods. This is explicit, owned state (Principle 2): the store owns its cache, and all mutations go through its methods.

## What We Omitted

### Session IDs and session keys (217+ LOC in OpenClaw)
OpenClaw derives session keys from agent IDs, sender IDs, channel types, and thread IDs. With one-agent-per-process and one-conversation-per-agent (Decision #10), there is no key resolution. The conversation directory is passed directly as a parameter.

### Lifecycle state machine
OpenClaw tracks session states (implicit through freshness evaluation, reset policies). The distilled conversation has no lifecycle states -- it exists or it doesn't. No Created/Active/Compacting/Ended transitions.

### Reset policies (142 LOC in OpenClaw)
OpenClaw evaluates daily and idle timeout reset policies. With one conversation that persists indefinitely (compacted as needed), there is nothing to reset. If the user wants a fresh conversation, they start a new agent.

### Session caching with TTL and mtime invalidation
OpenClaw caches session store entries with TTL and validates against file modification times. The Conversation Store loads once and keeps memory in sync through its own write methods. No external cache invalidation needed.

### Session entry merging and normalization (167 LOC in OpenClaw)
OpenClaw merges session entries when loading (handling field defaults, migrations, normalization). The Conversation Store has a simple, fixed metadata schema. No merge logic needed.

### Transcript repair (206 LOC in OpenClaw)
OpenClaw repairs broken tool-use/tool-result pairing in transcripts. This is a concern for the Agent Loop (Phase 4), not the persistence layer. The Conversation Store stores whatever it's given; validation happens above.

## Design Decisions

### Claude API message types directly
Messages use Claude's native API format: `{ role: "user" | "assistant", content: string | ContentBlock[] }`. Tool results are content blocks within user messages, not separate messages with a "toolResult" role. This follows Decision #13 (Claude API message types, not a custom format) and eliminates a translation layer.

### initialize() is explicit, not implicit
Creating a new conversation requires an explicit `initialize()` call. There is no "create on first access" behavior. This makes the lifecycle clear: either the conversation exists on disk (and can be loaded), or it doesn't (and must be initialized). `initialize()` also sets in-memory state, so `getMessages()`/`getMetadata()` work immediately after.

### ConversationNotLoadedError for pre-load access
Accessing messages or metadata before calling `load()` (or `initialize()`) throws `ConversationNotLoadedError`. This prevents silent bugs where code assumes the store is loaded. Fail clearly (Principle 7).

### appendMessage updates metadata timestamp
Each append writes to the transcript and updates the metadata timestamp. This means two filesystem operations per message. For the minimal agent (sequential, non-streaming), this is acceptable. If performance becomes an issue, timestamp updates could be batched or deferred.

### replaceTranscript makes a defensive copy
`replaceTranscript()` copies the input array before storing it in memory. This prevents the caller from mutating the stored messages through a retained reference. Defensive copying is the Rust-compatible approach (ownership semantics).

### Conversation directory as constructor parameter
The conversation directory path is relative to Storage's base directory. This is a thin convention -- the caller decides where conversations live. No implicit paths, no platform conventions.

### updateMetadata restricts updatable fields
Only `compactionCount` and `model` can be updated via `updateMetadata()`. Fields like `createdAt` are immutable after initialization. `updatedAt` is managed automatically. This prevents accidental corruption of temporal ordering.

## Interface Gap Resolutions

These gaps were identified in the integration trace and resolved during implementation:

- **Gap #1**: `replaceTranscript()` -- Implemented as specified. Atomically rewrites JSONL via Storage's `writeJsonl`, then replaces in-memory state.
- **Gap #5**: In-memory state management -- Implemented with explicit `load()` requirement and `ConversationNotLoadedError` guard.

### Synchronous interface
All methods (`load`, `initialize`, `appendMessage`, `replaceTranscript`, `updateMetadata`) are synchronous. `getMessages()` and `getMetadata()` were always synchronous (in-memory reads). The mutating methods are now also synchronous because Storage's I/O is synchronous. See Storage DECISIONS.md for the full rationale.

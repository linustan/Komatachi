# Agent Loop Module Decisions

Architectural decisions made during Phase 4: wiring the Agent Loop.

## What This Module Does

The Agent Loop is the orchestration layer that ties together all previously
distilled modules: Conversation Store, Context Window, System Prompt/Identity,
Tool Registry, and Compaction. It processes a single conversational turn:
user input -> context building -> Claude API call -> tool dispatch -> response.

## Design Decisions

### callModel is injected, not imported

The Agent Loop accepts a `callModel: CallModel` function parameter rather than
importing `@anthropic-ai/sdk` directly. This is not a provider abstraction --
all types are Claude-specific (Claude content blocks, tool_use/tool_result
format, stop_reason values). The injection serves two purposes:

1. **Testability**: Tests inject a mock without touching the network
2. **Separation**: The module doesn't manage API keys, client creation, or
   SDK lifecycle. That happens at the application entry point.

The SDK will be added as a dependency when the CLI/application layer is built.

### Iterative loop instead of recursion

The response loop uses `while` with explicit iteration counters instead of
recursive calls. This avoids stack overflow from deep tool dispatch chains
and makes the control flow easier to reason about.

### MAX_MODEL_CALLS_PER_TURN = 25

Prevents infinite tool dispatch loops. If Claude keeps requesting tool_use
without ever returning end_turn, the loop terminates with a clear error
after 25 calls. This is a conservative limit; real conversations rarely
need more than 10 tool calls per turn.

### MAX_COMPACTION_ATTEMPTS = 2

Prevents infinite compaction-retry loops. If context overflow persists after
compaction, something is fundamentally wrong (e.g., a single message is
larger than the entire budget). Failing after 2 attempts surfaces the problem.

### Tool results as a single user message

When Claude makes multiple tool_use calls in one response, all tool results
are collected into a single user message with multiple tool_result content
blocks. This matches the Claude API's expected format and keeps the
conversation structure clean.

### Compaction uses the same callModel

The compaction summarizer reuses the agent's `callModel` function rather than
having its own API client. This keeps the external boundary at one point
and means the same retry/error handling applies to both regular turns and
compaction summarization.

### File operations tracking deferred (Gap #4)

The Agent Loop passes empty `FileOperations` to compaction. Tracking which
files were read/edited/written requires tool-level integration (inspecting
tool results for file paths), which is beyond the scope of Phase 4.
The compaction module handles this gracefully -- empty sets produce no
file sections in the summary.

### No streaming (Decision #20)

The Agent Loop waits for the complete model response before processing.
Non-streaming is simpler to implement and test. Streaming can be added
later by changing `callModel` to return a stream.

### Identity files reloaded each loop iteration

Identity files (SOUL.md, IDENTITY.md, etc.) are reloaded from disk
on every model call. This ensures changes to identity files take effect
immediately without restarting the agent. The cost is negligible compared
to LLM API latency.

## Changes to Existing Modules

### Compaction: Claude API message types (Phase 4 alignment)

The compaction module's original `Message` type (trial distillation, pre-Decision #13)
was replaced with the Claude API `Message` type from `conversation/index.ts`.

Key changes:
- Removed local `Message` interface with `role: string`, `toolCallId`, `isError`, etc.
- Imported `Message`, `ToolUseBlock`, `ToolResultBlock` from conversation module
- `extractToolFailures` now scans user messages for `tool_result` blocks with
  `is_error: true` and cross-references assistant messages for tool names
- Removed `exitCode` from `ToolFailure` (Claude API doesn't have structured exit codes)
- Updated `formatToolFailuresSection` accordingly

This was explicitly planned in the integration trace as "Gap #3: Compaction type alignment."

## What We Omitted

### AbortController / cancellation

OpenClaw supports aborting mid-turn via AbortSignal. Not needed for the
minimal agent. Can be threaded through `callModel` if needed later.

### Retry logic

The Agent Loop does not retry failed model calls. The `@anthropic-ai/sdk`
handles retries at the HTTP level. Application-level retries (e.g., retry
the whole turn) are the caller's responsibility.

### Provider abstraction

No `ModelProvider` interface or multi-provider support. All types are
Claude-specific. The Rust version will need a different HTTP client anyway.

### Usage tracking / token counting from API response

OpenClaw tracks input/output tokens from the API response for billing
and analytics. Not needed for the minimal agent.

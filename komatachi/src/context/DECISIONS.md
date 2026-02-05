# Context Window Module Decisions

Architectural decisions made during the distillation of the Context Window module.

## What We Preserved

### Most-recent-first selection
OpenClaw's context management keeps the most recent messages and drops older ones when the context window fills up. This is the correct default: recent messages are more relevant, and compaction preserves key information from dropped messages. Preserved as the sole selection strategy.

### Token-budget-based selection
OpenClaw uses token estimation to decide how many messages fit. The token budget is the single policy -- no separate max-message or max-age limits. With a single conversation that gets compacted, additional limits would be redundant.

## What We Omitted

### Context pruning (553 LOC in OpenClaw)
OpenClaw has a sophisticated pruning subsystem: soft trim with head/tail preservation, hard clear, TTL-based eviction, tool-specific matching predicates, session-scoped runtime state (WeakMap). All of this exists to surgically reduce context size between compactions. With a simpler "select from end, compact when overflow" approach, pruning is unnecessary. The compaction module handles size reduction.

### History turn limiting (85 LOC in OpenClaw)
OpenClaw limits DM history turns via per-session configuration. With one conversation per agent and compaction managing size, separate turn limits are redundant. The token budget already constrains history length.

### Group chat history with LRU (171 LOC in OpenClaw)
OpenClaw manages group chat history with LRU eviction across multiple conversations. Single-agent, single-conversation: no group chat, no LRU.

### Context window guard (68 LOC in OpenClaw)
OpenClaw validates that messages fit the context window before sending to the API. The Context Window module makes this unnecessary -- it guarantees the selected messages fit within the budget. The Agent Loop computes the budget from the model's context limit.

### Model context window lookup (38 LOC in OpenClaw)
OpenClaw looks up context window sizes from a model registry. The Agent Loop receives the context window size as configuration -- no registry needed.

### Error classification for context overflow (518 LOC in OpenClaw)
OpenClaw classifies API errors to detect context overflow, rate limits, billing, and auth issues. With correct context window management, overflow should never happen. If it does, the API error is clear enough without classification logic.

## Design Decisions

### Generic type parameter instead of Message import
`selectMessages<T>()` is generic over the message type. It doesn't import `Message` from the conversation module or any other module. The token estimation function is injected, making the function truly independent. This means:
- Zero runtime dependencies on other modules
- Works with any message format (useful for testing with simple objects)
- In Rust: would be a generic function with a trait bound for token estimation

### Token estimation injected, not imported
The `estimateTokens` function is passed as a parameter, not imported from the compaction module. This keeps the dependency graph clean: Context Window depends on nothing. The Agent Loop wires in the estimator when calling `selectMessages`. This resolves integration trace Gap #2.

### estimateStringTokens co-located here
The `estimateStringTokens(text)` utility is exported from this module for the Agent Loop to estimate system prompt size when computing the token budget. It's the same ~4 chars/token formula used by compaction. Co-locating it here (rather than a separate shared module) is pragmatic: the only consumer outside this module is the Agent Loop, which already imports from here. This resolves integration trace Gap #6.

### Contiguous selection from end, no skipping
Messages are selected as a contiguous block from the end of history. We never skip a large message in the middle to include an older small one. This preserves conversation coherence -- Claude needs sequential context. If a single large message fragments the budget, that's handled at the compaction level.

### Empty selection is valid
If even the most recent message exceeds the budget, `selectMessages` returns an empty selection with a full overflow report. It doesn't force-include any messages. The Agent Loop decides what to do (compact, force-include the latest message, etc.). This keeps the Context Window's contract simple and pure.

### OverflowReport is separate from selection
The overflow report (dropped count + estimated tokens) is returned alongside the selection, not embedded in it. When overflow is null, all messages fit. This makes the common case (all messages fit) easy to check and the overflow case easy to handle.

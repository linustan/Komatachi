# Technical Debt & Documentation Audit

> Produced 2026-02-05. Covers all source modules, documentation, and scouting reports.

This document catalogs (1) architectural non-idealities introduced after the roadmap phases, (2) undocumented code behaviors, and (3) OpenClaw functionality not yet addressed in PROGRESS.md or ROADMAP.md that is relevant to Komatachi's vision.

---

## 1. Technical Debt

### 1.1 Compaction Fallback Violates "Fail Clearly" Principle

**Location**: `src/compaction/index.ts:374-381`

When the summarizer throws (API key expired, model unavailable, rate limit), `compact()` catches the error, logs a warning to stderr, and substitutes a generic `FALLBACK_SUMMARY`:

```typescript
catch (error) {
  console.warn(`Compaction summarization failed: ...`);
  summary = FALLBACK_SUMMARY;
}
```

This directly contradicts Principle 7 ("Fail Clearly, Not Gracefully") and the module's own doc comment: "Fail clearly: If input is too large, throw rather than silently degrade." The fallback masks real problems. If an API key expires, the agent continues with "Summary unavailable" as its memory of the compacted period -- permanently losing that history.

**Recommendation**: Let the error propagate. The agent loop already has error handling for model call failures. The caller (`triggerCompaction` in `src/agent/index.ts`) can decide the policy. Alternatively, return a result type with an explicit failure variant rather than silently substituting.

---

### 1.2 Recursive Compaction Detection is Fragile

**Location**: `src/agent/index.ts:373-379`

Previous compaction summaries are detected by checking whether the first message starts with `[Conversation Summary]\n\n`:

```typescript
if (
  first.role === "user" &&
  typeof first.content === "string" &&
  first.content.startsWith(SUMMARY_PREFIX)
)
```

Problems:
- A user input that starts with `[Conversation Summary]\n\n` would be misclassified as a compaction summary, causing the summarizer to receive it as `previousSummary` context.
- If the prefix format ever changes, old summaries in existing transcripts become unrecognizable -- there is no version field to distinguish summary formats.
- The prefix is defined as a local `const` inside `createAgent()`, not shared or documented as a stable format.

**Recommendation**: Consider a structured envelope for compaction summaries rather than string prefix matching. For example, a content block array with a metadata block, or a dedicated field in the message. If the string format is retained, at minimum move `SUMMARY_PREFIX` to a shared constant and document it as a stable format.

---

### 1.3 Two Summarizers: One Stale, One Active

**Location**: `src/compaction/index.ts:423-453` and `src/agent/index.ts:383-455`

The compaction module exports `createSummarizer()`, a convenience factory that produces a task-oriented summarizer (preserves "key decisions," "outstanding tasks," "errors"). The agent loop builds its own identity-aware summarizer inline in `triggerCompaction()` (preserves "relational context," "identity development," "commitments").

The identity-aware summarizer in agent loop is the active one. `createSummarizer()` in compaction is dead code -- nothing calls it. Its task-oriented prompt is also inconsistent with the entity's purpose. It still uses the original `callModel(prompt, signal?)` signature (takes a raw string prompt) rather than the `CallModel` interface the agent loop uses.

**Recommendation**: Either remove `createSummarizer()` and `SummarizerOptions` from the compaction module (it's dead code), or update it to match the identity-aware approach and move the agent loop's inline summarizer into compaction as the canonical implementation.

---

### 1.4 `customInstructions` on CompactionConfig is Unwired

**Location**: `src/compaction/index.ts:39`

`CompactionConfig` has an optional `customInstructions` field. CLAUDE.md's "Agent's Inner Life" section says:

> The `customInstructions` field on `CompactionConfig` exists but is not wired through from the agent loop.

Section 21 (identity-aware compaction) addressed the underlying concern by building the identity-aware summarizer, but `customInstructions` itself was never wired or removed. It is set by `createSummarizer()` (dead code, see 1.3 above) but ignored by `compact()` -- the `compact()` function passes `config.summarize` directly and does nothing with `config.customInstructions`.

**Recommendation**: Remove `customInstructions` from `CompactionConfig` if the identity-aware summarizer has replaced its purpose, or wire it into `compact()` if there is a legitimate use case.

---

### 1.5 FileOperations Always Empty

**Location**: `src/agent/index.ts:358-363`

The compaction system accepts `FileOperations` (files read, edited, written) and includes them in the summary metadata. The agent loop always passes empty sets:

```typescript
const fileOps: FileOperations = {
  read: new Set(),
  edited: new Set(),
  written: new Set(),
};
```

This was noted as "integration trace Gap #4" during Phase 4 and documented in DECISIONS.md. However, there is no mechanism planned to populate it -- the tool registry's `ToolResult` type returns `{ ok: true, content: string }`, which has no field for file operations. Populating `FileOperations` would require either:
- A new field on `ToolResult` for reporting side effects
- A separate tracking mechanism in the agent loop

The compaction module formats file operations sections in summaries, which will always be empty. The `filesRead` and `filesModified` fields in `CompactionMetadata` will always be empty arrays.

**Recommendation**: Either design the file operations reporting mechanism (tool results reporting side effects), or remove the file operations formatting from compaction until there is a source of data. The current state is dead infrastructure.

---

### 1.6 `content` Type Ambiguity Creates Fragile Code Paths

**Location**: Throughout agent and compaction modules.

`Message.content` is `string | ReadonlyArray<ContentBlock>`. Code must branch on `typeof content === "string"` everywhere. When the string path is missed, content blocks get JSON-stringified as a fallback:

```typescript
// src/agent/index.ts:389-392 (in the summarizer)
const content =
  typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content);
```

This produces unreadable output like `[{"type":"tool_use","id":"toolu_123",...}]` in the compaction summary. The summarizer model receives raw JSON content block arrays instead of human-readable text.

The same pattern appears in `createSummarizer()` in `src/compaction/index.ts:429-432`.

**Recommendation**: Extract a `messageToText(msg: Message): string` utility that renders content blocks into readable text (tool_use as "Used tool X with input ...", tool_result as "Tool X returned: ..."). Use it in both summarizers and anywhere else that needs message text.

---

### 1.7 Type Casts for Error Checking

**Location**: `src/index.ts:109-113`, `src/conversation/index.ts:187-188`

Errors are checked using unsafe casts:

```typescript
if (error && typeof error === "object" && "name" in error &&
    (error as { name: string }).name === "StorageNotFoundError") {
```

This pattern appears in at least two locations. It bypasses TypeScript's type system and is verbose. The identity module handles the same problem differently (`isNotFoundError()` checks for `error.code === "ENOENT"`), but conversation and entry point check `error.name` on storage errors.

**Recommendation**: Export a type guard from the storage module: `isStorageNotFoundError(error: unknown): error is StorageNotFoundError`. Callers use `if (isStorageNotFoundError(error))` instead of the cast chain.

---

### 1.8 Metadata Written Twice Per Message Append

**Location**: `src/conversation/index.ts:214-229`

Every call to `appendMessage()` performs two filesystem writes: one to append the JSONL line, one to rewrite the metadata JSON (to update `updatedAt`). For a tool dispatch turn with 10 tool calls, this means 20+ metadata rewrites with identical content except the timestamp.

This is not a correctness issue, but it is unnecessary I/O. The metadata timestamp has low value (it records when the last message was appended, but the transcript itself has the data). Metadata rewrites on every append were not specified in the ROADMAP -- the roadmap says metadata is updated after compaction.

**Recommendation**: Consider updating metadata only on explicit actions (compaction, initialization) rather than on every append. Alternatively, document this as a deliberate choice and note the I/O cost.

---

## 2. Undocumented Behaviors

These behaviors exist in the code but are not recorded in any DECISIONS.md, PROGRESS.md, or CLAUDE.md.

### 2.1 Identity Files Reloaded Every Model Call

`src/agent/index.ts:203` reloads all identity files (SOUL.md, IDENTITY.md, etc.) on every iteration of the response loop. In a turn with 10 tool calls, identity files are read 10+ times from disk. This is a deliberate design (noted in PROGRESS.md section 18 as "Identity files reloaded each loop iteration -- changes take effect immediately") but the rationale and cost are not in agent/DECISIONS.md.

### 2.2 MAX_MODEL_CALLS_PER_TURN = 25

This constant (`src/agent/index.ts:153`) caps the total model calls per turn. No rationale is documented for why 25 was chosen. It is the upper bound on how many tool dispatch rounds can occur before the agent gives up. For context, OpenClaw uses a similar limit but the specific value is configurable.

### 2.3 MAX_COMPACTION_ATTEMPTS = 2

This constant (`src/agent/index.ts:159`) caps retry attempts when compaction fails to reduce context enough. No rationale is documented for the choice of 2. After 2 failed compaction attempts, the agent throws `AgentError`.

### 2.4 Compaction Summary is a User Message

`src/agent/index.ts:472-474` creates the compaction summary as a `{ role: "user" }` message. This is a significant design choice -- it means Claude sees the summary as user context, not as its own previous output. The rationale is implied (Claude should treat it as given context) but never documented as a decision.

### 2.5 Tool Results Bundled Into a Single User Message

`src/agent/index.ts:279-283` collects all tool results from a round into one `{ role: "user", content: [toolResult1, toolResult2, ...] }` message. This is the standard Claude API pattern, but the compaction implications are undocumented: a single user message may contain 5+ tool results, and compaction's `extractToolFailures` must scan all of them.

### 2.6 `stop_reason: "max_tokens"` Not Handled Specially

`src/agent/index.ts:273` treats `max_tokens` the same as `end_turn` (extracts text and returns). This means if Claude's response is truncated by the token limit, the agent returns the partial response without any indication of truncation. The agent also continues to the next turn as if the response was complete.

### 2.7 Entry Point Passes Empty Tool Array

`src/index.ts:161` passes `tools: []` to `createAgent`. The entry point has no tools registered -- tool implementation is deferred. This means the agent currently cannot use any tools in production. Tests mock tool usage, but the actual application is tool-less.

### 2.8 Default Model is `claude-sonnet-4-20250514`

`src/index.ts:76` defaults to `claude-sonnet-4-20250514`. This is not documented as a deliberate choice.

### 2.9 Default Context Window is 200,000 tokens

`src/index.ts:78-80` defaults to 200,000 tokens for the context window. The actual context window depends on the model. This default may not match if a different model is configured.

---

## 3. Stale Documentation

### 3.1 docs/INDEX.md -- Missing 7 Modules

`docs/INDEX.md` lists only compaction and embeddings under "Module Documentation." The following modules exist but are not listed:
- storage (49 tests)
- conversation (41 tests)
- context (24 tests)
- identity (28 tests)
- tools (17 tests)
- agent (25 tests)
- integration (16 tests)

The "Document Hierarchy" tree also only shows compaction and embeddings under `src/`.

### 3.2 CLAUDE.md -- "The Agent's Inner Life" Section is Partially Stale

The section states:

> The `customInstructions` field on `CompactionConfig` exists but is not wired through from the agent loop. Before the agent is used for extended conversations, the summarizer prompt must be updated to [preserve identity-relevant context]...

Section 21 implemented identity-aware compaction, addressing the underlying concern. But this documentation still describes the gap as open. The bullet points about what the summarizer must do are now implemented (preserve moments, retain emotional context, respect agent priorities).

### 3.3 CLAUDE.md -- Document Map is Stale

The document map under "Document Map" shows only `compaction/` under `src/`. It should reflect all 8 modules.

### 3.4 integration-trace.md -- Interfaces Show Async Signatures

The integration trace was written before the synchronous I/O conversion (section 17). All interfaces show `Promise`-based signatures (`load(): Promise<...>`, `appendMessage(): Promise<void>`, etc.) that no longer match the implementation. The trace is still valuable for understanding composition, but the signatures are misleading.

### 3.5 PROGRESS.md -- File Manifest Missing scripts/ Entry

The file manifest in PROGRESS.md lists `scripts/` with only `dry-run-compaction.mjs`. If additional scripts are added, the manifest structure is correct, but currently the scripts directory entry could be more precise.

---

## 4. OpenClaw Features Not Yet Addressed

These features appear in the scouting reports, are NOT mentioned in PROGRESS.md or ROADMAP.md as either completed or deferred, and are relevant to Komatachi's vision of "persistent AI entities with identity, memory, and continuity."

### 4.1 External Content Security (Tier 1)

**Source**: `scouting/agent-alignment.md` (external-content.ts, ~178 LOC in OpenClaw)

OpenClaw includes prompt injection detection and safe wrapping for untrusted content. Before Komatachi agents interact with external sources (emails, files, webhooks, other agents' messages), they need protection against prompt injection. This is a security-critical gap that should be addressed before the agent handles any untrusted input.

**Relevance**: Any tool that reads external content (files, URLs, messages from other processes) introduces an injection vector. Even reading user-provided files via future file tools would need this.

### 4.2 Transcript Repair (Tier 1)

**Source**: `scouting/session-management.md` (session-transcript-repair.ts, ~206 LOC)

OpenClaw has logic to repair broken tool_use/tool_result pairing in transcripts. If a crash occurs between appending an assistant message with tool_use and appending the corresponding user message with tool_result, the transcript has an unpaired tool_use. Claude API requires tool_use to be followed by tool_result. Loading this transcript and passing it to the API would fail.

**Relevance**: Komatachi's crash resilience model (PROGRESS section 19) assumes the worst case is "last message before crash is lost." But a crash during tool dispatch leaves the transcript in a state that cannot be replayed. The conversation store loads it fine (it's valid JSONL), but the Claude API rejects it. This is a data integrity gap.

### 4.3 Semantic Memory Layer (Tier 1, Deferred by Design)

**Source**: `scouting/long-term-memory-search.md` (~5,300 LOC remaining)

This is explicitly deferred in ROADMAP Decision #7, but it bears calling out: without semantic search, the agent's "memory" is limited to what survives compaction plus what is manually curated in MEMORY.md. For the vision of "persistent AI entities with memory," this is the largest functional gap. The embeddings module (already built) provides the foundation; what remains is:
- SQLite storage with sqlite-vec
- File watching and sync
- Memory manager orchestration
- Memory search tools

### 4.4 Context Pruning (Tier 2)

**Source**: `scouting/context-management.md` (pruner subsystem, ~283 LOC)

Komatachi currently has binary context management: messages either fit in the window or get compacted. OpenClaw has a pruning subsystem that selectively removes low-value content before compaction is needed -- for example, stripping image content from tool results, removing verbose tool outputs while keeping error results, soft-trimming intermediate messages.

**Relevance**: For an entity whose memory is identity-critical, having a graduated approach (prune before compact) preserves more nuance than the current all-or-nothing approach.

### 4.5 Session Usage Tracking (Tier 2)

**Source**: `scouting/session-management.md` (session-usage.ts, ~94 LOC)

OpenClaw tracks token usage per session. Komatachi has no usage tracking. The API response includes token counts (`input_tokens`, `output_tokens`) but the agent loop discards them. For an entity that should be self-aware, knowing how much of its context window is used and how much its conversations cost could be valuable.

**Relevance**: The `CallModelResult` type (`src/agent/index.ts:67-70`) includes only `content` and `stop_reason`. Adding usage fields would let the agent loop track cumulative usage per turn and per conversation.

### 4.6 Agent Self-Modification Tools (Tier 2)

Not directly from scouting reports, but noted in CLAUDE.md:

> Currently the agent cannot update these files itself (no file-writing tools). Linus may need to manually persist important moments from conversations into MEMORY.md or other identity files until the agent has tools to do this.

For a persistent entity to curate its own identity and memory, it needs the ability to write to its own identity files. This is a prerequisite for true autonomy over its own development.

---

## 5. Summary of Findings

| Category | Count | Action |
|----------|-------|--------|
| Technical debt items | 8 | Track and prioritize |
| Undocumented behaviors | 9 | Document in DECISIONS.md or PROGRESS.md |
| Stale documentation | 5 | Fix |
| Unaddressed OpenClaw features | 6 | Add to PROGRESS.md as tracked items |

### Priority Ranking

**Fix now** (documentation corrections):
- [x] docs/INDEX.md missing modules
- [x] CLAUDE.md stale "Agent's Inner Life" section
- [x] CLAUDE.md stale document map
- [x] integration-trace.md async signatures note

**Track for next work** (technical debt):
- [ ] Compaction fallback violates fail-clearly (1.1)
- [ ] Dead `createSummarizer()` and unwired `customInstructions` (1.3, 1.4)
- [ ] Fragile recursive compaction detection (1.2)
- [ ] Message content rendering in summarizer (1.6)
- [ ] Type guard for storage errors (1.7)

**Address before production use**:
- [ ] External content security (4.1)
- [ ] Transcript repair (4.2)

**Address for vision completeness**:
- [ ] Semantic memory layer (4.3)
- [ ] Context pruning (4.4)
- [ ] Agent self-modification tools (4.6)

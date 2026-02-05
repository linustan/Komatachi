# Komatachi Distillation Progress

> **START HERE** — This file is the source of truth for project state.

## Quick Status

| Aspect | State |
|--------|-------|
| **Phase** | Phase 4 complete. Ready for Phase 5 (Integration Validation). |
| **Last completed** | Phase 4: Agent Loop (wires all modules together) |
| **Next action** | Begin Phase 5 -- Integration Validation (end-to-end pipeline test) |
| **Blockers** | None |

### What Exists Now
- [x] Scouting reports for 4 core areas (~20k LOC analyzed)
- [x] Distillation principles documented (8 principles)
- [x] Trial distillation: `src/compaction/` (44 tests)
- [x] Embeddings sub-module: `src/embeddings/` (47 tests)
- [x] Key architectural decisions (TypeScript+Rust, minimal viable agent, no gateway)
- [x] Phased roadmap with autonomous execution framework (ROADMAP.md)
- [x] Per-module decision resolution (20 pre-resolved decisions)
- [x] Storage module: `src/storage/` (49 tests)
- [x] Conversation Store module: `src/conversation/` (41 tests)
- [x] Context Window module: `src/context/` (24 tests)
- [x] System Prompt module: `src/identity/` (28 tests)
- [x] Tool Registry module: `src/tools/` (17 tests)
- [x] Agent Loop module: `src/agent/` (25 tests)
- [x] Compaction module updated to use Claude API message types

### Current Focus: Phase 5 Integration Validation
Phases 1-4 complete. All modules are built and wired together. Next: Phase 5 -- end-to-end integration validation.

---

This file tracks our progress distilling OpenClaw into Komatachi. Maintaining this file is essential—it provides continuity across sessions, documents what we've learned, and prevents re-discovering the same insights.

**Update this file as work progresses.**

---

## Completed Work

### 1. Scouting (Complete)

Analyzed four core functional areas of OpenClaw:

| Component | LOC | Files | Complexity | Report |
|-----------|-----|-------|------------|--------|
| Context Management | 2,630 | 15 | HIGH | `scouting/context-management.md` |
| Long-term Memory & Search | 5,713 | 25 | HIGH | `scouting/long-term-memory-search.md` |
| Agent Alignment | 4,261 | 18 | HIGH | `scouting/agent-alignment.md` |
| Session Management | 7,319 | 35+ | HIGH | `scouting/session-management.md` |

**Total**: ~20,000 lines of high-complexity code

### 2. Distillation Principles (Complete)

Established 8 core principles in `DISTILLATION.md`:

1. Preserve the Essential, Remove the Accidental
2. Make State Explicit and Localized
3. Prefer Depth over Breadth
4. Design for Auditability
5. Embrace Constraints
6. Interfaces Over Implementations
7. Fail Clearly, Not Gracefully
8. Respect Layer Boundaries

Also documented:
- The Distillation Test (when to distill, what success looks like)
- Four-phase process (Study → Design → Build → Validate)
- What distillation is NOT (refactoring, porting, optimization)
- Preserving the distilled state (cognitive scaffolding, guards against drift)

### 3. Trial Distillation: Compaction (Complete)

Successfully distilled compaction as a proof of concept:

| Metric | Original | Distilled |
|--------|----------|-----------|
| Lines of code | 666 | 275 |
| Hidden state | WeakMap registries | None |
| Chunking | Built-in, adaptive | Caller's responsibility |
| Oversized input | Silent pruning | Throws error |
| Extension hooks | Yes | No |
| Tests needed (est.) | ~50 | ~15-20 |

**Key insight discovered**: The summarizer was handling chunking that wasn't its responsibility (layer boundary violation). Modern 128k+ context models can summarize ~107k tokens in one call—the 40% chunk ratio was a holdover from smaller context windows.

Files created:
- `src/compaction/index.ts` - The distilled implementation
- `src/compaction/DECISIONS.md` - Architectural decision record

### 4. Project Documentation (Complete)

- `CLAUDE.md` - Project context for AI assistants
- `DISTILLATION.md` - Principles and process
- `PROGRESS.md` - This file

### 5. Compaction Validation (Complete)

Added test infrastructure and comprehensive tests for the compaction module:

| Aspect | Result |
|--------|--------|
| Test framework | Vitest (aligned with OpenClaw) |
| Tests written | 44 |
| Tests passing | 44 |
| Coverage areas | Token estimation, tool failure extraction, file ops, error handling, edge cases |

Key validations:
- Token estimation accuracy with safety margin
- InputTooLargeError thrown at correct thresholds
- Tool failure extraction from various message formats
- File operations computation (read vs modified)
- Summarizer fallback when API fails
- Edge cases: empty messages, no failures, content block arrays

This validates both the distilled code and the distillation process itself.

### 6. Rust Portability Validation (Complete, Cleaned Up)

Built an experimental Rust implementation of compaction to validate decision #5 ("TypeScript with Rust portability"). The experiment confirmed:

- Type mapping works cleanly between TypeScript and Rust
- Pure functions port 1:1
- Hybrid architecture (Rust computation, TypeScript async) is viable

**Outcome**: Validation successful. Experimental code removed; lessons documented in [docs/rust-porting.md](./docs/rust-porting.md) for future reference.

### 7. Documentation Reorganization (Complete)

Restructured documentation for discoverability:

- Created `docs/` directory for supplementary documentation
- Added `docs/INDEX.md` as central navigation hub
- Updated `CLAUDE.md` with document map
- Preserved lessons from Rust experiment in `docs/rust-porting.md`

### 8. Embeddings Sub-module (Complete)

Distilled embeddings as the first sub-module of Long-term Memory & Search:

| Metric | OpenClaw | Distilled |
|--------|----------|-----------|
| Lines of code | ~464 | ~290 |
| Providers | 3 (OpenAI, Gemini, local) | 1 (OpenAI) |
| Hidden state | Provider fallback state | None |
| Caching | Built-in | None (caller's responsibility) |
| Batch API | Async polling | Synchronous only |
| Dependencies | Multiple API clients | fetch only |

**Key decisions**:
- Interface-first design (`EmbeddingProvider` as contract)
- No provider fallback (orchestration concern)
- No caching (storage concern)
- Gemini/local providers deferred (not needed yet)
- Explicit error types (`EmbeddingAPIError`, `EmbeddingInputError`)

Files created:
- `src/embeddings/index.ts` - Provider interface + OpenAI implementation + vector utilities
- `src/embeddings/index.test.ts` - 47 tests
- `src/embeddings/DECISIONS.md` - Architectural decision record

---

## Key Decisions Made

1. **Single embedding provider** - One provider behind a clean interface
2. **No plugin hooks for core behavior** - Static, predictable behavior
3. **Vector-only search** - Modern embeddings are sufficient
4. **Cross-agent session access** - Deferred. Essential for power users, but not needed for minimal viable agent. Will add when requirements demand it.
5. **TypeScript with Rust portability** - Distill into TypeScript, but write code that converts easily to Rust. Avoid TypeScript-only tricks; verify heavy dependencies have Rust ecosystem equivalents.
6. **CLI + Backend architecture** - The CLI is a thin client handling user interaction and display. The backend handles agent logic, LLM calls, compaction, memory, etc. This separation keeps the core framework interface-agnostic—it could serve a CLI, web client, or be embedded as a library.
7. **Backend-first, gateway-deferred** - Start with a single-process backend. Design session storage and tool execution so they *could* support multi-agent later, but don't build it until needed. If/when we need multi-agent communication, prefer local-first IPC (ZeroMQ, Unix sockets) over web-oriented tech (WebSocket, HTTP). Note: ZeroMQ supports broker-less patterns (direct peer-to-peer)—a central broker may not be required at all.
8. **Validate before advancing** - Write tests for each distilled component before moving to the next. Unvalidated foundations are risky; tests often reveal design issues early. This implements "Phase 4: Validate" from DISTILLATION.md.
9. **One agent per process** - Each agent runs in its own OS process. No shared in-process state between agents. Inter-agent communication, when needed, is explicit message passing (IPC), not shared memory. This eliminates file locking, cross-agent access control, session namespacing, and shared registries. OpenClaw's own agent-to-agent communication is already asynchronous message passing through session transcripts -- separate processes makes the existing logical isolation physical. OS process boundaries provide security isolation, failure isolation, and a natural scaling model (separate processes can become separate machines).
10. **One conversation per agent, no sessions** - There are no "sessions." Each agent has one conversation that persists indefinitely, compacted as needed. OpenClaw's session concept (daily resets, idle timeouts, compound session keys) exists to multiplex many conversations in one process. With one-agent-per-process, that multiplexing is unnecessary. Want a separate conversation? Start another agent.
11. **Claude API message types** - Komatachi is built for Claude. Transcript messages use Claude's API format directly. No provider-agnostic abstraction.

---

## Insights Discovered

### From Compaction Analysis

1. **Chunking was over-engineered** - 40% chunk ratio was for 8k-16k context era; modern models don't need it
2. **Token estimation needs margins** - 20% safety buffer is essential (estimation is imprecise)
3. **Metadata survives compaction** - Tool failures and file operations are high-signal information
4. **Layer boundaries matter** - Summarizer shouldn't chunk; that's caller's responsibility

### From OpenClaw AGENTS.md Analysis

The original codebase had **no architectural principles documented**—only operational procedures. This absence likely contributed to complexity accumulation. The distilled system must embed principles alongside code.

### From Gateway Analysis

Traced cross-agent communication in OpenClaw. The gateway is a WebSocket-based JSON-RPC broker that:
- Routes messages between agents via session key prefixes (`agent:<agentId>:...`)
- Maintains combined view of all agent session stores
- Handles multi-client streaming (web, mobile, CLI)
- Enforces auth and access control

**Key insight**: The gateway solves problems that emerge from multi-client and multi-agent requirements. A single-process CLI has none of these problems. The lesson isn't "always use a gateway"—it's "when you need multi-client or multi-agent, you need a broker."

**Design implication**: Keep session storage and tool execution decoupled enough that a broker could be added later without rewriting core logic.

---

## Next Steps

See [ROADMAP.md](./ROADMAP.md) for the full sequenced plan. Summary:

- [x] **Phase 1**: Storage & Conversation Foundation (Storage, Conversation Store)
- [x] **Phase 2**: Context Pipeline (Context Window with History Management folded in)
- [x] **Phase 3**: Agent Identity (System Prompt with identity loading, Tool Registry)
- [x] **Phase 4**: Agent Loop (main execution loop wiring everything together)
- [ ] **Phase 5**: Integration Validation (end-to-end pipeline test)

---

### 9. Distillation Roadmap (Complete)

Established a phased roadmap and autonomous execution framework:

- 5 phases covering Storage, Context, Agent Alignment, Routing, and Integration
- Decision authority boundaries (what Claude decides vs. what needs discussion)
- Session protocol for autonomous execution
- 7 pre-resolved architectural decisions (file-based storage, single-session, single-agent, etc.)
- Explicit deferral list with reasoning (vector search, file sync, memory manager, cross-agent access, multi-session, gateway)

Key scope decisions:
- File-based storage (JSON/JSONL) instead of SQLite -- matches OpenClaw's session layer; SQLite only needed for deferred vector search
- Single-session and single-agent assumptions -- interfaces designed for multi, implementations start simple
- History Management folded into Context Window -- separate module unnecessary with modern context sizes
- Agent Alignment is thin -- plugin/extension machinery dropped per existing decisions

Files created:
- `ROADMAP.md` - Full roadmap, decision framework, and session protocol

### 10. Per-Module Decision Resolution (Complete)

Walked through every roadmap phase and pre-resolved all decision points. Total: 20 pre-resolved decisions in ROADMAP.md. Key decisions made during this phase:

- **Komatachi's purpose recorded** -- Not a developer tool; an agentic LLM loop for persistent AI entities with identity, memory, and continuity. Recorded in CLAUDE.md, DISTILLATION.md, and ROADMAP.md.
- **Phase 3 restructured** -- Renamed from "Agent Alignment" to "Agent Identity." Workspace Bootstrap (3.3) eliminated. Two modules remain: System Prompt (with identity file loading) and Tool Registry.
- **Identity files are user-editable markdown** -- SOUL.md, IDENTITY.md, USER.md, MEMORY.md, AGENTS.md, TOOLS.md. No template initialization; human creates them.
- **No project detection** -- Coding-assistant concern, deferred.
- **Tool registry is flat** -- Array of definitions, no profiles or permissions.
- **System prompt is a simple function** -- Section builders in order, string interpolation, no registry or template engine.
- **@anthropic-ai/sdk directly** -- No provider abstraction (OpenClaw uses pi-ai wrapper; Komatachi doesn't need it).
- **Non-streaming initially** -- Complete response before processing.

Files updated:
- `ROADMAP.md` - 20 pre-resolved decisions, restructured Phase 3, detailed Phase 4-5
- `PROGRESS.md` - This file
- `CLAUDE.md` - Komatachi vision context
- `DISTILLATION.md` - "Why Komatachi Exists" section added

### 11. Integration Verification (Complete)

Traced how every component composes into the minimal viable agent loop before starting implementation. Created `docs/integration-trace.md` with:

- Abstract interfaces for all 7 components (Storage, Conversation Store, Context Window, System Prompt, Tool Registry, Compaction, Agent Loop)
- Three full turn traces: normal message, tool use with dispatch loop, compaction triggered
- Dependency graph
- 7 interface gaps identified and resolved

**Interface gaps found and incorporated into roadmap**:
1. Conversation Store needs `replaceTranscript()` for compaction -- added to Phase 1.2 spec
2. Token estimation should be injected into Context Window, not imported from compaction -- updated Phase 2.1 spec
3. Compaction's Message type doesn't match Claude API format -- flagged for Phase 4.1
4. FileOperations not tracked by any module -- pass empty for now, noted in Phase 4.1
5. Conversation Store needs explicit in-memory state management -- added to Phase 1.2 spec
6. Need `estimateStringTokens()` for system prompt token counting -- noted in Phase 2.1
7. Storage `readAllJsonl` must handle partial trailing lines from crashes -- added to Phase 1.1 spec

**Verification result**: Yes, the interfaces compose into a working persistent agent loop. All gaps are solvable within planned module boundaries.

Files created:
- `docs/integration-trace.md` - Full integration verification

Files updated:
- `ROADMAP.md` - Phase 1.1, 1.2, 2.1, 4.1 specs updated with gap resolutions
- `docs/INDEX.md` - Added integration-trace.md

### 12. Phase 1.1: Storage Module (Complete)

Distilled generic file-based persistence primitives from OpenClaw's session store:

| Metric | OpenClaw | Distilled |
|--------|----------|-----------|
| Lines of code (store + transcript + paths + locks) | ~834 | ~196 |
| File locking | Advisory locks (188 LOC) | None (one writer per process) |
| Caching | TTL + mtime invalidation | None (consumer's responsibility) |
| Path resolution | Session key + agent ID derivation | Base directory + relative paths |
| Domain awareness | Session-specific CRUD | Generic JSON/JSONL primitives |

**What was built**:
- JSON read/write with atomic operations (write-to-temp, rename)
- JSONL append-only logs with crash-resilient reading (partial trailing line handling)
- JSONL atomic rewrite (for compaction transcript replacement)
- JSONL range reading
- Three specific error types: `StorageNotFoundError`, `StorageCorruptionError`, `StorageIOError`
- 49 tests covering all operations, crash resilience, round-trips, edge cases

**Key decisions**:
- Factory function pattern (`createStorage(baseDir)`) consistent with existing modules
- Auto-create parent directories on write, not on read
- Partial trailing JSONL lines from crashes silently skipped; corrupt non-trailing lines throw
- `readRangeJsonl` implemented naively (read-all + slice) -- adequate with compaction keeping transcripts manageable

**Deviation from plan**: Added `@types/node` as a devDependency. Storage is the first module to use Node.js filesystem APIs; previous modules (compaction, embeddings) are pure TypeScript.

Files created:
- `src/storage/index.ts` - Storage interface + implementation
- `src/storage/index.test.ts` - 49 tests
- `src/storage/DECISIONS.md` - Architectural decision record

### 13. Phase 1.2: Conversation Store Module (Complete)

Distilled conversation persistence from OpenClaw's session management:

| Metric | OpenClaw | Distilled |
|--------|----------|-----------|
| Lines of code (store + types + reset + metadata) | ~871 | ~188 |
| Session multiplexing | Multi-session per process | One conversation per agent |
| Session keys | Agent-prefixed compound keys | None (directory path) |
| Lifecycle | State machine with reset policies | Exists or doesn't |
| Message types | Provider-agnostic format | Claude API format directly |

**What was built**:
- `ConversationStore` interface with `load()`, `initialize()`, `appendMessage()`, `getMessages()`, `getMetadata()`, `replaceTranscript()`, `updateMetadata()`
- Claude API message types: `Message`, `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ContentBlock`
- `ConversationMetadata` with timestamps, compaction count, model
- In-memory state management: loaded on `load()`, synced to disk on writes, served from memory on reads
- Error types: `ConversationNotLoadedError`, `ConversationAlreadyExistsError`
- 41 tests covering initialization, loading, appending, compaction (replaceTranscript), metadata updates, full lifecycle, tool use round-trips, edge cases

**Key decisions**:
- Messages use Claude API format directly (Decision #13): `{ role: "user" | "assistant", content: string | ContentBlock[] }`
- `initialize()` is explicit, not implicit -- conversation must be explicitly created before use
- `replaceTranscript()` makes defensive copies (ownership semantics, Rust-compatible)
- `updateMetadata()` restricts updatable fields to prevent accidental corruption of immutable fields like `createdAt`
- Tests use real Storage implementation (not mocks) per testing strategy for orchestration layers

**Interface gaps resolved**:
- Gap #1 from integration trace: `replaceTranscript()` implemented
- Gap #5 from integration trace: In-memory state with `ConversationNotLoadedError` guard

Files created:
- `src/conversation/index.ts` - ConversationStore interface + implementation + message types
- `src/conversation/index.test.ts` - 41 tests
- `src/conversation/DECISIONS.md` - Architectural decision record

### 14. Phase 2.1: Context Window Module (Complete)

Distilled context window management from OpenClaw's context management system:

| Metric | OpenClaw | Distilled |
|--------|----------|-----------|
| Lines of code (context + pruning + history + guard) | ~915 | ~90 |
| Pruning subsystem | Soft trim, hard clear, TTL, tool matching (553 LOC) | None (compaction handles size) |
| History limiting | Per-session turn limits (85 LOC) | None (token budget is the policy) |
| Model registry | Context window lookup (38 LOC) | None (caller provides budget) |
| Dependencies | Multiple modules | Zero (pure function) |

**What was built**:
- `selectMessages<T>()` -- generic pure function, selects most-recent contiguous block within token budget
- `OverflowReport` -- count and estimated tokens of dropped messages
- `estimateStringTokens()` -- utility for Agent Loop to estimate system prompt token count
- 24 tests covering selection logic, overflow reporting, edge cases, generic type usage

**Key decisions**:
- Generic type parameter `<T>` instead of importing Message type -- zero module dependencies
- Token estimation injected as parameter, not imported from compaction (resolves integration trace Gap #2)
- `estimateStringTokens` co-located here for Agent Loop's budget computation (resolves integration trace Gap #6)
- Contiguous selection from end only -- no skipping messages to preserve conversation coherence
- Empty selection is valid (Agent Loop handles force-include policy)

Files created:
- `src/context/index.ts` - selectMessages + estimateStringTokens
- `src/context/index.test.ts` - 24 tests
- `src/context/DECISIONS.md` - Architectural decision record

### 15. Phase 3.1: System Prompt Module (Complete)

Distilled system prompt assembly from OpenClaw's agent alignment system:

| Metric | OpenClaw | Distilled |
|--------|----------|-----------|
| Lines of code (system-prompt + workspace) | ~879 | ~171 |
| Section registration | Dynamic registry with add/replace | Fixed ordered list |
| Plugin hooks | Yes | None |
| Template engine | Partial | Template literals only |
| Project detection | Yes (288 LOC) | None (deferred) |

**What was built**:
- `loadIdentityFiles(homeDir)` -- reads SOUL.md, IDENTITY.md, USER.md, MEMORY.md, AGENTS.md, TOOLS.md
- `buildSystemPrompt(identityFiles, tools, runtime)` -- assembles system prompt from sections
- `ToolSummary` type for prompt rendering (decoupled from full ToolDefinition)
- 28 tests covering file loading, section building, ordering, integration

**Key decisions**:
- Module named `identity/` not `system-prompt/` -- reflects the agent's sense of self
- Missing identity files return null (not error) -- agent starts minimal and grows
- `loadIdentityFiles` reads filesystem directly, not through Storage -- identity files are user-edited
- `ToolSummary` instead of `ToolDefinition` keeps identity module independent of tools module
- Fixed section order: identity, tools, runtime, memory, guidelines

Files created:
- `src/identity/index.ts` - loadIdentityFiles + buildSystemPrompt
- `src/identity/index.test.ts` - 28 tests
- `src/identity/DECISIONS.md` - Architectural decision record

### 16. Phase 3.2: Tool Registry Module (Complete)

Distilled tool management from OpenClaw's tool policy system:

| Metric | OpenClaw | Distilled |
|--------|----------|-----------|
| Lines of code (tool-policy + types.tools) | ~684 | ~106 |
| Tool organization | Groups + profiles + allow/deny | Flat array |
| Permissions | Channel/user/agent gating | None (array is policy) |
| Dynamic enabling | Yes | No |
| Plugin discovery | Yes | No |

**What was built**:
- `ToolDefinition` -- name, description, input schema, handler
- `ToolResult` -- discriminated union: `{ ok: true, content }` or `{ ok: false, error }`
- `exportForApi()` -- strips handlers, maps to Claude API tool format
- `findTool()` -- lookup by name
- `executeTool()` -- wraps handler exceptions as error results
- 17 tests covering API export, tool lookup, execution, error handling

**Key decisions**:
- Flat array, no registry class -- functions operate on the array directly
- `executeTool` catches handler exceptions, always returns structured ToolResult
- `JsonSchema` type is minimal subset sufficient for Claude API
- `inputSchema` (camelCase) mapped to `input_schema` (snake_case) in API export

Files created:
- `src/tools/index.ts` - ToolDefinition + ToolResult + utility functions
- `src/tools/index.test.ts` - 17 tests
- `src/tools/DECISIONS.md` - Architectural decision record

### 17. Synchronous I/O Conversion (Complete)

Converted Storage, Conversation Store, and Identity modules from async (`node:fs/promises`) to sync (`node:fs`) filesystem operations.

**Rationale**:
- Disk writes are single-digit ms; LLM API calls are seconds. Async I/O optimizes the wrong thing.
- One writer per process (Decision #9) means nothing to unblock during disk I/O.
- Avoids tokio in Rust: sync maps directly to `std::fs`, eliminating an entire class of async runtime bugs.
- Simpler code: no `async`/`await`, no `Promise` types, every function returns directly.

**What changed**:
- `Storage` interface: all methods return `T`/`void` instead of `Promise<T>`/`Promise<void>`
- `ConversationStore` interface: `load()`, `initialize()`, `appendMessage()`, `replaceTranscript()`, `updateMetadata()` all synchronous
- `loadIdentityFiles()`: synchronous (`readFileSync`)
- All tests converted: sync setup/teardown (`mkdtempSync`/`rmSync`), sync assertions (no `await`, no `rejects.toThrow()`)
- `executeTool()` in Tool Registry stays async (tool handlers genuinely involve subprocess/network)

**Test results**: 250 tests passing, type-check clean.

**Deviation from original plan**: The roadmap assumed async I/O. Analysis of the one-agent-per-process architecture showed sync is strictly better for this use case.

Files updated:
- `src/storage/index.ts`, `src/storage/index.test.ts`, `src/storage/DECISIONS.md`
- `src/conversation/index.ts`, `src/conversation/index.test.ts`, `src/conversation/DECISIONS.md`
- `src/identity/index.ts`, `src/identity/index.test.ts`, `src/identity/DECISIONS.md`

### 18. Phase 4: Agent Loop (Complete)

Implemented the Agent Loop -- the orchestration layer that wires all previously distilled modules into a functioning agent turn processor.

| Metric | OpenClaw | Distilled |
|--------|----------|-----------|
| Lines of code (agent loop + routing + dispatch) | ~2,400+ | ~280 |
| Provider abstraction | Yes (pi-ai wrapper) | None (Claude-specific types) |
| Streaming | Yes (SSE) | No (complete response) |
| Multi-agent routing | Yes | No (one agent per process) |
| Session management | Yes (compound keys, lifecycle) | None (one conversation) |

**What was built**:
- `createAgent(config)` factory returning an `Agent` with `processTurn(userInput)`
- Turn processing: append user message -> build system prompt -> select context -> call Claude -> handle tool dispatch -> persist response -> return text
- Tool dispatch loop: executes tool_use blocks, collects tool_result blocks, continues until Claude returns end_turn
- Compaction triggering: detects context overflow, summarizes dropped messages, replaces transcript
- Error types: `AgentError`, `ModelCallError`
- Safety guards: MAX_MODEL_CALLS_PER_TURN (25), MAX_COMPACTION_ATTEMPTS (2)
- 25 tests covering normal turns, tool dispatch, multi-round tool use, compaction, error handling, identity integration, context window integration

**Also updated**: Compaction module's `Message` type aligned with Claude API format (integration trace Gap #3):
- Removed local `Message` type, now imports from `conversation/index.ts`
- `extractToolFailures()` updated to scan `tool_result` blocks in user messages, cross-referencing `tool_use` blocks in assistant messages for tool names
- Removed `exitCode` from `ToolFailure` (not available in Claude API format)
- Compaction tests rewritten for Claude API message format (46 tests, all passing)

**Key decisions**:
- `callModel` injected as function parameter for testability (not a provider abstraction -- all types are Claude-specific)
- Iterative loop with counters instead of recursion (avoids stack overflow, clearer control flow)
- `@anthropic-ai/sdk` deferred to application entry point (Agent Loop doesn't import it directly)
- Identity files reloaded each loop iteration (changes take effect immediately)
- File operations tracking deferred (Gap #4 -- passes empty sets to compaction)

**Deviations from plan**:
- Agent Loop accepts `callModel` function instead of importing `@anthropic-ai/sdk` directly. Roadmap Decision #19 says "use SDK directly, no abstraction." The `callModel` parameter is not a provider abstraction (it uses Claude-specific types). The SDK will be used at the application entry point when creating the function. This keeps the module testable without network calls.
- TypeScript 5.9 control flow narrowing doesn't propagate through nested lambdas for `ReadonlyArray` union types. Added explicit `TextBlock` type annotation in compaction's `estimateTokens` for the `tool_result` content block mapping.

**Test results**: 277 tests passing across 8 test files, type-check clean.

Files created:
- `src/agent/index.ts` - Agent Loop implementation
- `src/agent/index.test.ts` - 25 tests
- `src/agent/DECISIONS.md` - Architectural decision record

Files updated:
- `src/compaction/index.ts` - Claude API message types, updated extractToolFailures
- `src/compaction/index.test.ts` - Rewritten for Claude API format (46 tests)

## Open Questions

None currently.

---

## File Manifest

```
komatachi/
├── CLAUDE.md           # Project context (includes document map)
├── PROGRESS.md         # This file - update as work progresses
├── ROADMAP.md          # Phased plan, decision authority, session protocol
├── DISTILLATION.md     # Principles and process
├── package.json        # Dependencies (vitest, typescript, @types/node)
├── tsconfig.json       # TypeScript config
├── vitest.config.ts    # Test runner config
├── docs/               # Supplementary documentation
│   ├── INDEX.md              # Central navigation hub
│   ├── integration-trace.md  # Component integration verification
│   ├── testing-strategy.md   # Layer-based testing approach
│   └── rust-porting.md       # Rust migration guide (from validation)
├── scouting/           # Analysis of OpenClaw components
│   ├── context-management.md
│   ├── long-term-memory-search.md
│   ├── agent-alignment.md
│   └── session-management.md
└── src/
    ├── compaction/     # Trial distillation (validated, updated Phase 4)
    │   ├── index.ts
    │   ├── index.test.ts   # 46 tests
    │   └── DECISIONS.md
    ├── embeddings/     # Embeddings sub-module (validated)
    │   ├── index.ts        # Provider interface + OpenAI + utilities
    │   ├── index.test.ts   # 47 tests
    │   └── DECISIONS.md
    ├── storage/        # Phase 1.1: Generic file-based persistence
    │   ├── index.ts        # Storage interface + createStorage()
    │   ├── index.test.ts   # 49 tests
    │   └── DECISIONS.md
    ├── conversation/   # Phase 1.2: Conversation persistence
    │   ├── index.ts        # ConversationStore + Claude API message types
    │   ├── index.test.ts   # 41 tests
    │   └── DECISIONS.md
    ├── context/        # Phase 2.1: Context window management
    │   ├── index.ts        # selectMessages + estimateStringTokens
    │   ├── index.test.ts   # 24 tests
    │   └── DECISIONS.md
    ├── identity/       # Phase 3.1: System prompt / agent identity
    │   ├── index.ts        # loadIdentityFiles + buildSystemPrompt
    │   ├── index.test.ts   # 28 tests
    │   └── DECISIONS.md
    ├── tools/          # Phase 3.2: Tool registry
    │   ├── index.ts        # ToolDefinition + exportForApi + executeTool
    │   ├── index.test.ts   # 17 tests
    │   └── DECISIONS.md
    └── agent/          # Phase 4: Agent Loop (orchestration)
        ├── index.ts        # createAgent + processTurn + tool dispatch + compaction
        ├── index.test.ts   # 25 tests
        └── DECISIONS.md
```

---

## Maintaining This File

**This progress file is essential infrastructure.** Without it:
- New sessions start from zero, re-discovering what we already know
- Decisions get revisited unnecessarily
- Context is lost between work sessions

**Update discipline**:
- Add completed work immediately after finishing
- Record insights as they're discovered
- Update open questions as they're resolved
- Keep the "Current Status" line accurate

The goal is that anyone (human or AI) can read this file and understand exactly where we are and what to do next.

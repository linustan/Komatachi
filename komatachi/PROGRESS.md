# Komatachi Distillation Progress

> **START HERE** — This file is the source of truth for project state.

## Quick Status

| Aspect | State |
|--------|-------|
| **Phase** | Architecture clarified; MVP defined |
| **Last completed** | Runtime model analysis, daemon/CLI architecture decision |
| **Next action** | Begin MVP implementation (see "MVP Architecture" below) |
| **Blockers** | None |

### What Exists Now
- [x] Scouting reports for 5 core areas (~20k LOC analyzed + runtime model)
- [x] Distillation principles documented (8 principles)
- [x] Trial distillation: `src/compaction/` working
- [x] Key architectural decisions (TypeScript+Rust, minimal viable agent, daemon/CLI split)
- [x] MVP architecture defined (daemon + CLI over local IPC)

### MVP Architecture (Decided)

The minimal viable Komatachi is a **daemon + CLI** system:

```
┌─────────────────┐         ┌─────────────────────────────────┐
│   komatachi     │  IPC    │        komatachi-daemon         │
│     (CLI)       │◄───────►│                                 │
│                 │         │  - Session state (file-based)   │
│ Thin client:    │         │  - Tool execution (read/write)  │
│ - Send prompts  │         │  - LLM API calls                │
│ - Display output│         │  - Conversation history         │
│ - No state      │         │                                 │
└─────────────────┘         └─────────────────────────────────┘
```

**Why this split?**
- Prepares for remote operation (CLI on laptop, daemon on server)
- Clean boundary for testing
- State ownership is unambiguous
- No shared-memory coupling

**For MVP, both run on same machine** using Unix socket or localhost TCP.

See decision #8 below and `scouting/runtime-model.md` for full analysis

---

This file tracks our progress distilling OpenClaw into Komatachi. Maintaining this file is essential—it provides continuity across sessions, documents what we've learned, and prevents re-discovering the same insights.

**Update this file as work progresses.**

---

## Completed Work

### 1. Scouting (Complete)

Analyzed five core areas of OpenClaw:

| Component | LOC | Files | Complexity | Report |
|-----------|-----|-------|------------|--------|
| Context Management | 2,630 | 15 | HIGH | `scouting/context-management.md` |
| Long-term Memory & Search | 5,713 | 25 | HIGH | `scouting/long-term-memory-search.md` |
| Agent Alignment | 4,261 | 18 | HIGH | `scouting/agent-alignment.md` |
| Session Management | 7,319 | 35+ | HIGH | `scouting/session-management.md` |
| **Runtime Model** | ~5,000 | 20+ | MEDIUM-HIGH | `scouting/runtime-model.md` |

**Total**: ~25,000 lines analyzed

**Runtime Model** (new): Documents OpenClaw's daemon architecture—how the Gateway process runs, how CLI communicates via WebSocket, how agents execute in-process, and how state is persisted. Critical for understanding how to structure Komatachi's MVP

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

---

## Key Decisions Made

1. **Single embedding provider** - One provider behind a clean interface
2. **No plugin hooks for core behavior** - Static, predictable behavior
3. **Vector-only search** - Modern embeddings are sufficient
4. **Cross-agent session access** - Deferred. Essential for power users, but not needed for minimal viable agent. Will add when requirements demand it.
5. **TypeScript with Rust portability** - Distill into TypeScript, but write code that converts easily to Rust. Avoid TypeScript-only tricks; verify heavy dependencies have Rust ecosystem equivalents.
6. **Minimal viable agent** - A CLI where an agent using a Claude subscription can read and write files via tools. We'll refine this definition as we go.
7. **No message-broker gateway for minimal scope** - We don't need OpenClaw's WebSocket-based multi-client message routing. But see decision #8—we DO split daemon from CLI.
8. **Daemon/CLI architecture from day one** - Even for MVP, separate the persistent process (daemon) from the user interface (CLI). They communicate via local IPC (Unix socket or localhost). This ensures:
   - Architecture supports remote operation (CLI on laptop, daemon on server) without redesign
   - Clean boundary for testing (mock either side)
   - State ownership is unambiguous (all state on daemon side)
   - No hidden coupling via shared filesystem access from CLI

   **OpenClaw insight**: The Gateway daemon owns all state and runs agents in-process. The CLI is a thin stateless client. This is the right pattern. We adopt it, but simplify the protocol (no multi-client streaming, no presence, no nodes)

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

### From Runtime Model Analysis (New)

1. **Agents run in-process** - OpenClaw's `runEmbeddedPiAgent()` runs agents inside the Gateway process, not as subprocesses. Simple but couples crash domains.

2. **CLI is truly stateless** - The CLI connects to Gateway via WebSocket, sends commands, displays output. Zero local state. This is the right model.

3. **File-based state is sufficient** - Sessions, transcripts, and config are all JSON/JSONL files. SQLite/Postgres are not required for single-user operation.

4. **Service managers matter** - launchd/systemd integration provides auto-restart, log rotation, boot startup. Essential for "always-on" operation.

5. **Protocol can be simple** - OpenClaw's protocol has many features (presence, nodes, multi-client streaming) we don't need. A request/response RPC over Unix socket is sufficient for MVP.

**Critical insight for Komatachi**: Don't collapse daemon and CLI into one process. The separation enables remote operation and clean testing boundaries. The protocol can start simple (JSON-RPC over Unix socket) and evolve.

---

## Next Steps

### Immediate: Build MVP Foundation

1. **Implement daemon skeleton** - A process that:
   - Listens on Unix socket (or localhost TCP)
   - Accepts JSON-RPC requests
   - Manages file-based session state
   - Can be started/stopped cleanly

2. **Implement CLI skeleton** - A binary that:
   - Connects to daemon socket
   - Sends prompt, receives streaming response
   - Displays output to terminal
   - Holds no local state

3. **Implement minimal agent loop** - Inside daemon:
   - Load session history
   - Call Claude API with tools (read, write)
   - Execute tool calls
   - Persist session
   - Stream response to CLI

### Later: Enhance

4. **Add compaction** - Use distilled compaction when context approaches limit
5. **Add service management** - launchd/systemd integration for auto-restart
6. **Add authentication** - Token-based auth for remote operation
7. **Add more tools** - exec, browser, etc. as needed

---

## Open Questions

None currently. Cross-agent session access question resolved—deferred until requirements demand it (see decisions #4 and #7).

---

## File Manifest

```
komatachi/
├── CLAUDE.md           # Project context
├── DISTILLATION.md     # Principles and process
├── PROGRESS.md         # This file - update as work progresses
├── scouting/           # Analysis of OpenClaw components
│   ├── context-management.md
│   ├── long-term-memory-search.md
│   ├── agent-alignment.md
│   ├── session-management.md
│   └── runtime-model.md  # NEW: Daemon architecture analysis
└── src/
    └── compaction/     # First distilled module
        ├── index.ts
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

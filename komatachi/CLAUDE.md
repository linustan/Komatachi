# Komatachi

> **First action**: Read [PROGRESS.md](./PROGRESS.md) for current state, completed work, and next steps.

---

## Komatachi (What We Are Building)

Komatachi is a new codebase built from the ground up. It captures OpenClaw's essential functionality while shedding accumulated complexity, bloat, and historical baggage.

### Directory Structure

```
komatachi/
├── CLAUDE.md           # This file - project context
├── DISTILLATION.md     # Distillation principles and process
├── PROGRESS.md         # Progress tracking - READ THIS FIRST
├── scouting/           # Analysis of OpenClaw components
│   ├── context-management.md
│   ├── long-term-memory-search.md
│   ├── agent-alignment.md
│   ├── session-management.md
│   └── runtime-model.md  # Daemon/CLI architecture analysis
└── src/
    └── compaction/     # First distilled module (trial)
        ├── index.ts
        └── DECISIONS.md
```

### Guiding Principles

See [DISTILLATION.md](./DISTILLATION.md) for the full principles. The key ones:

1. **Preserve the Essential, Remove the Accidental** - Distinguish inherent problem complexity from historical artifacts
2. **Make State Explicit** - No hidden WeakMaps, caches, or scattered registries
3. **Prefer Depth over Breadth** - Fewer concepts, each fully realized
4. **Design for Auditability** - Answer "why did it do X?" without a debugger
5. **Embrace Constraints** - Make decisions instead of adding configuration options
6. **Fail Clearly** - No silent fallbacks that mask problems

### Key Decisions Made

1. **Single embedding provider** - One provider behind a clean interface, not multiple with fallback logic
2. **No plugin hooks for core behavior** - Core behavior is static and predictable
3. **Vector-only search** - Modern embeddings are sufficient; hybrid search adds complexity without proportional value
4. **Cross-agent session access** - Deferred until requirements demand it
5. **TypeScript with Rust portability** - Write code that converts easily to Rust
6. **Daemon/CLI split from day one** - Even for MVP, separate persistent daemon from stateless CLI (see below)

### MVP Architecture

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
- State ownership is unambiguous (daemon owns all state)
- No hidden coupling via shared filesystem

See `scouting/runtime-model.md` for full analysis of OpenClaw's architecture

---

## OpenClaw (What We Are Distilling From)

OpenClaw is the source codebase we are studying. We are not refactoring it or editing its files. We read its code to understand:

- What it actually does (the essential behaviors users depend on)
- What hard-won lessons are embedded in its edge cases
- What problems it solved that any replacement must also solve

OpenClaw has grown through accretion. Features were added incrementally. Edge cases accumulated. Configuration options multiplied. The result is a system that works, but is difficult to understand, audit, and maintain.

### Components Being Distilled

| Component | Current LOC | Complexity | Key Responsibility |
|-----------|-------------|------------|-------------------|
| Context Management | 2,630 | HIGH | Keep conversations within token limits |
| Long-term Memory | 5,713 | HIGH | Persist and recall information semantically |
| Agent Alignment | 4,261 | HIGH | Define agent behavior and capabilities |
| Session Management | 7,319 | HIGH | Track conversation state across interactions |

Total: ~20,000 lines of high-complexity code that could be ~5,000-7,000 lines of clear, auditable code.

---

## Working Conventions

### Session Continuity

[PROGRESS.md](./PROGRESS.md) is the single source of truth for:
- Current state and phase
- Completed work and decisions made
- Next actions and open questions

**Update PROGRESS.md before each commit.** This is essential infrastructure for maintaining continuity across sessions.

### Style

- **No emojis** - Use markdown checkboxes `[x]` instead of emoji indicators
- **Study OpenClaw as reference** - Read its code to understand what problems it solves
- **Don't copy-paste** - Understand why code exists, then write something new
- **Question everything** - "Is this essential, or is it historical accident?"
- **Document decisions** - Record what we preserved, discarded, and why

The OpenClaw codebase in this repo is our teacher, not our starting point.

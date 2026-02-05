# Komatachi Documentation Index

This index provides navigation to all project documentation.

---

## Primary Documents

These are the essential documents for understanding and contributing to Komatachi:

| Document | Purpose | When to Read |
|----------|---------|--------------|
| [PROGRESS.md](../PROGRESS.md) | Current state, completed work, next steps | **Start here** - read first in every session |
| [ROADMAP.md](../ROADMAP.md) | Phased plan, decision authority, session protocol | When picking next work item or making decisions |
| [DISTILLATION.md](../DISTILLATION.md) | Principles and process for distillation | When making design decisions |
| [CLAUDE.md](../CLAUDE.md) | Project context and conventions | When starting work on Komatachi |

---

## Scouting Reports

Analysis of OpenClaw components that inform our distillation:

| Component | Report | Status |
|-----------|--------|--------|
| Context Management | [scouting/context-management.md](../scouting/context-management.md) | Complete |
| Long-term Memory & Search | [scouting/long-term-memory-search.md](../scouting/long-term-memory-search.md) | Complete |
| Agent Alignment | [scouting/agent-alignment.md](../scouting/agent-alignment.md) | Complete |
| Session Management | [scouting/session-management.md](../scouting/session-management.md) | Complete |

---

## Technical Guides

Reference material for specific technical topics:

| Guide | Purpose |
|-------|---------|
| [integration-trace.md](./integration-trace.md) | Component integration verification: interfaces, turn traces, dependency graph, gap analysis |
| [testing-strategy.md](./testing-strategy.md) | Layer-based testing approach; when to mock vs use real deps |
| [rust-porting.md](./rust-porting.md) | Lessons from Rust portability validation; patterns for future Rust migration |
| [technical-debt.md](./technical-debt.md) | Architecture audit: technical debt, undocumented behaviors, OpenClaw gaps |

---

## Module Documentation

Each distilled module has its own DECISIONS.md:

| Module | Decisions | Tests |
|--------|-----------|-------|
| Compaction | [src/compaction/DECISIONS.md](../src/compaction/DECISIONS.md) | 46 |
| Embeddings | [src/embeddings/DECISIONS.md](../src/embeddings/DECISIONS.md) | 47 |
| Storage | [src/storage/DECISIONS.md](../src/storage/DECISIONS.md) | 49 |
| Conversation | [src/conversation/DECISIONS.md](../src/conversation/DECISIONS.md) | 41 |
| Context | [src/context/DECISIONS.md](../src/context/DECISIONS.md) | 24 |
| Identity | [src/identity/DECISIONS.md](../src/identity/DECISIONS.md) | 28 |
| Tools | [src/tools/DECISIONS.md](../src/tools/DECISIONS.md) | 17 |
| Agent | [src/agent/DECISIONS.md](../src/agent/DECISIONS.md) | 25 |
| Integration | [src/integration/DECISIONS.md](../src/integration/DECISIONS.md) | 16 |

---

## Document Hierarchy

```
komatachi/
├── CLAUDE.md              # Entry point for AI assistants
├── PROGRESS.md            # Source of truth for project state
├── ROADMAP.md             # Phased plan and decision framework
├── DISTILLATION.md        # Core principles
├── docs/
│   ├── INDEX.md              # This file
│   ├── integration-trace.md  # Component integration verification
│   ├── testing-strategy.md   # Layer-based testing approach
│   ├── rust-porting.md       # Rust migration guide
│   └── technical-debt.md     # Architecture audit and OpenClaw gap analysis
├── scouting/              # OpenClaw analysis
│   ├── context-management.md
│   ├── long-term-memory-search.md
│   ├── agent-alignment.md
│   └── session-management.md
└── src/
    ├── index.ts           # Application entry point (stdin/stdout JSON-lines)
    ├── compaction/         # Trial distillation (46 tests)
    ├── embeddings/         # Embeddings sub-module (47 tests)
    ├── storage/            # Phase 1.1: Generic file-based persistence (49 tests)
    ├── conversation/       # Phase 1.2: Conversation persistence (41 tests)
    ├── context/            # Phase 2.1: Context window management (24 tests)
    ├── identity/           # Phase 3.1: System prompt / agent identity (28 tests)
    ├── tools/              # Phase 3.2: Tool registry (17 tests)
    ├── agent/              # Phase 4: Agent loop orchestration (25 tests)
    └── integration/        # Phase 5: Integration validation (16 tests)
```

---

## Adding New Documents

When adding documentation:

1. **Module decisions**: Add `DECISIONS.md` in the module's directory
2. **Technical guides**: Add to `docs/` and update this index
3. **Scouting reports**: Add to `scouting/` and update this index
4. **Core principles**: Update existing documents rather than creating new ones

# Distillation: Simplifying Core Components

## Overview

This document defines what it means to "distill" the four core functional areas into a simpler, more elegant architecture. The goal is to maintain functional equivalence while dramatically reducing complexity, improving auditability, and making the system more maintainable.

### Current State

| Component | LOC | Files | Complexity |
|-----------|-----|-------|------------|
| Context Management | 2,630 | 15 | HIGH |
| Long-term Memory & Search | 5,713 | 25 | HIGH |
| Agent Alignment | 4,261 | 18 | HIGH |
| Session Management | 7,319 | 35+ | HIGH |
| **Total** | **~20,000** | **93+** | **ALL HIGH** |

### Target State

A distilled architecture should aim for:
- **~5,000-7,000 LOC total** (65-75% reduction)
- **~20-30 files** (70% reduction)
- **LOW-MEDIUM complexity** per component

---

## Distillation Principles

### 1. Essence Over Accretion

**Problem**: Components have grown through accretion—features added incrementally without reconsidering the whole. Each addition solved an immediate problem but increased overall complexity.

**Distillation**: Identify the essential capabilities vs. accumulated cruft. Ask: "If we were building this today with full knowledge, what would we build?"

### 2. Explicit Over Implicit

**Problem**: Hidden state in WeakMaps, caches with TTLs, file locks with timeouts, magic configuration merging. Behavior becomes unpredictable and hard to debug.

**Distillation**: Make all data flow explicit. No hidden state. Dependencies passed as parameters. State transitions logged and traceable.

### 3. Composition Over Configuration

**Problem**: Deep nested configuration objects with dozens of options. Users don't know what to configure; developers don't know what combinations to test.

**Distillation**: Good defaults that work for 90% of cases. Composition of simple behaviors rather than configuration of complex ones.

### 4. Single Responsibility, Clear Boundaries

**Problem**: Components reach into each other. Session management touches 35+ files across 11 directories. Context management is entangled with session state, agent lifecycle, and error handling.

**Distillation**: Each component owns its domain completely. Clear interfaces between components. No reaching across boundaries for internal state.

### 5. Auditable by Design

**Problem**: Hard to answer "why did the agent do X?" without deep debugging. Multiple interacting policies, fallbacks, and edge case handlers obscure causality.

**Distillation**: Every decision logged with reasoning. State machines with named states. Behavior traceable from input to output.

---

## Component Distillation Plans

### Context Management → `ContextWindow`

**Current Complexity Sources**:
- Multiple subsystems (guards, compaction, pruning, history limiting)
- WeakMap-based session registries
- Complex multi-stage summarization with fallbacks
- Provider-specific error detection patterns

**Distilled Design**:

```
ContextWindow {
  maxTokens: number
  messages: Message[]

  // Core operations
  add(message: Message): void
  compact(): Message[]  // Returns summarized history

  // Single source of truth for token counting
  tokenCount(): number
  isNearLimit(): boolean
}
```

**Key Simplifications**:
1. **One compaction strategy**: Single-pass summarization with clear truncation rules
2. **No pruning subsystem**: Messages are either kept or compacted, not partially trimmed
3. **No provider-specific error handling**: Let errors propagate; handle at call site
4. **Stateless operations**: No WeakMap registries; state lives in ContextWindow instance

**Estimated LOC**: 300-400 (vs. 2,630 current)

---

### Long-term Memory & Search → `MemoryStore`

**Current Complexity Sources**:
- Three embedding providers with fallback logic
- Batch APIs with polling and timeouts
- Hybrid search (vector + BM25)
- File watching with debouncing
- SQLite with vector extension
- 2,200+ line manager class

**Distilled Design**:

```
MemoryStore {
  // Simple key-value with semantic search
  store(key: string, content: string, metadata?: object): void
  search(query: string, limit?: number): SearchResult[]
  get(key: string): string | null
  delete(key: string): void

  // Bulk operations
  index(files: string[]): void
  clear(): void
}
```

**Key Simplifications**:
1. **One embedding provider**: Pick the best one (likely OpenAI), remove fallback complexity
2. **No batch API complexity**: Simple sequential embedding, rely on provider's rate limiting
3. **Vector-only search**: Drop BM25 hybrid; modern embeddings are good enough
4. **No file watching**: Explicit `index()` calls; user controls when to re-index
5. **SQLite without extensions**: Use simple JSON storage or basic SQLite; vector math in JS

**Estimated LOC**: 500-700 (vs. 5,713 current)

---

### Agent Alignment → `AgentConfig`

**Current Complexity Sources**:
- 20+ system prompt sections with conditional logic
- 14 plugin hooks with priority ordering
- Multiple tool policy layers (profiles, allow/deny, plugins)
- 7+ workspace bootstrap files
- Prompt injection detection

**Distilled Design**:

```
AgentConfig {
  // Identity
  name: string
  persona: string  // Single SOUL.md content

  // Capabilities
  tools: string[]  // Explicit list, no profiles/expansion

  // Behavior
  systemPrompt(): string  // Deterministic, no conditionals
}
```

**Key Simplifications**:
1. **One bootstrap file**: Merge AGENTS.md, SOUL.md, etc. into single `agent.md`
2. **No plugin hooks for alignment**: Alignment is static config, not runtime hooks
3. **Explicit tool list**: No profiles, no expansion, no groups—list the tools
4. **Template-based prompts**: Simple string interpolation, no conditional sections
5. **No prompt injection detection**: Trust boundaries at input, not in prompt construction

**Estimated LOC**: 400-500 (vs. 4,261 current)

---

### Session Management → `Session`

**Current Complexity Sources**:
- 50+ fields per session entry
- File locking with stale detection
- Complex key resolution (agent, group, thread, peer)
- Transcript repair for tool use/result pairing
- Multiple reset policies
- Cross-agent access control

**Distilled Design**:

```
Session {
  id: string
  agentId: string
  messages: Message[]
  createdAt: Date
  lastActiveAt: Date

  // Core operations
  append(message: Message): void
  reset(): void

  // Persistence
  save(): void
  static load(id: string): Session | null
}
```

**Key Simplifications**:
1. **10 fields max**: id, agentId, messages, timestamps, model, maybe 5 more
2. **No file locking**: Single-writer assumption; use atomic writes
3. **Simple key scheme**: `{agentId}:{recipientId}` only
4. **No transcript repair**: Well-formed messages only; reject malformed on write
5. **One reset policy**: Time-based only, no per-channel complexity
6. **No cross-agent access**: Each agent owns its sessions exclusively

**Estimated LOC**: 400-600 (vs. 7,319 current)

---

## What We Preserve

Distillation is not about removing functionality. These capabilities must remain:

### Context Management
- Token limit enforcement
- Automatic summarization when limits approached
- Conversation continuity across compactions

### Long-term Memory
- Semantic search over stored content
- Persistence across sessions
- Agent ability to store and recall information

### Agent Alignment
- System prompt defining agent behavior
- Tool access control
- User-customizable persona

### Session Management
- Conversation persistence
- Session isolation between users
- Session reset capability

---

## What We Remove

### Unnecessary Abstractions
- Multiple embedding providers with fallback
- Tool policy profiles and expansion
- Plugin hook system for core behavior
- Hybrid search algorithms

### Hidden Complexity
- WeakMap session registries
- File watching with debouncing
- Batch APIs with polling
- Multi-layer caching with TTLs

### Over-Configuration
- 50+ session fields
- 20+ prompt sections
- Deep nested config objects
- Per-channel/per-type policies

### Defensive Code
- Transcript repair for malformed data
- Provider-specific error detection
- Lock timeout and stale detection
- Graceful degradation paths

---

## Migration Strategy

### Phase 1: Interface Definition
Define the distilled interfaces without implementation. Validate they cover all essential use cases.

### Phase 2: Parallel Implementation
Build distilled components alongside existing ones. Both run simultaneously.

### Phase 3: Verification
Comprehensive testing that distilled components produce equivalent results for all core scenarios.

### Phase 4: Cutover
Switch to distilled components. Keep old code available for rollback.

### Phase 5: Removal
Delete old implementations once distilled versions are proven stable.

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Total LOC | ~20,000 | ~5,000-7,000 |
| Total Files | 93+ | 20-30 |
| Avg Complexity per Component | HIGH | LOW-MEDIUM |
| Config Options | 100+ | <30 |
| Time to Understand (new dev) | Days | Hours |
| Test Count Needed | 600+ | 150-200 |

---

## Open Questions

1. **Provider lock-in**: Is committing to one embedding provider acceptable?
2. **File watching**: Is explicit re-indexing sufficient, or is auto-sync essential?
3. **Plugin hooks**: Can we remove them entirely, or are some extension points required?
4. **Cross-agent sessions**: Is this a core feature or can it be removed?
5. **Hybrid search**: Is vector-only search sufficient for memory recall quality?

---

## Next Steps

1. Review this document and challenge assumptions
2. Identify any distillation that would break critical functionality
3. Prioritize which component to distill first
4. Define detailed interface specs for the first component
5. Build a prototype and validate with real usage


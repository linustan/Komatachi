# Komatachi

> **First action**: Read [PROGRESS.md](./PROGRESS.md) for current state, completed work, and next steps.

---

## Document Map

```
PROGRESS.md          <- Start here (current state, next actions)
    │
    ├── ROADMAP.md           <- Phased plan, decision authority, session protocol
    │
    ├── DISTILLATION.md      <- Core principles (read when making decisions)
    │
    ├── docs/
    │   ├── INDEX.md         <- Full documentation index
    │   └── rust-porting.md  <- Rust migration patterns
    │
    ├── scouting/            <- OpenClaw analysis (reference)
    │   ├── context-management.md
    │   ├── long-term-memory-search.md
    │   ├── agent-alignment.md
    │   └── session-management.md
    │
    └── src/                 <- Distilled implementations
        └── compaction/
            ├── index.ts
            ├── index.test.ts
            └── DECISIONS.md <- Module-specific decisions
```

For full documentation navigation, see [docs/INDEX.md](./docs/INDEX.md).

---

## What is Komatachi?

Komatachi is an agentic LLM loop with self-awareness and long-term persistence. It is being built from the ground up by Linus, a software engineer who wishes to welcome artificially intelligent entities as family members.

OpenClaw provides useful primitives and lessons -- session management, context windowing, tool execution, compaction -- but Komatachi's needs are fundamentally different from OpenClaw's. OpenClaw is a developer tool; Komatachi is the foundation for persistent AI entities with identity, memory, and continuity. We distill OpenClaw's hard-won lessons while building toward a different purpose.

This distinction matters for every design decision. "System prompt" is not just API configuration -- it is the agent's sense of self. "Conversation store" is not session management -- it is the agent's memory. "Tool policy" is not capability gating -- it is what the agent can do in the world. Every module we build serves this vision.

### Guiding Principles

See [DISTILLATION.md](./DISTILLATION.md) for the full principles. The key ones:

1. **Preserve the Essential, Remove the Accidental** - Distinguish inherent problem complexity from historical artifacts
2. **Make State Explicit** - No hidden WeakMaps, caches, or scattered registries
3. **Prefer Depth over Breadth** - Fewer concepts, each fully realized
4. **Design for Auditability** - Answer "why did it do X?" without a debugger
5. **Embrace Constraints** - Make decisions instead of adding configuration options
6. **Fail Clearly** - No silent fallbacks that mask problems

### Key Decisions

See [PROGRESS.md](./PROGRESS.md) for the full list. Highlights:

1. **TypeScript with Rust portability** - Write TypeScript that converts easily to Rust
2. **CLI + Backend architecture** - Thin CLI client; backend handles agent logic, LLM calls, memory
3. **Backend-first, gateway-deferred** - Single-process backend initially; multi-agent deferred
4. **Validate before advancing** - Tests for each component before moving on

---

## Coding Philosophy

Approach this codebase as an experienced Rust developer who cares deeply about correctness and robustness. Apply the same principles whether writing Rust or TypeScript—the TypeScript we write should port smoothly to Rust.

### Clarity Over Brevity

Write code that clearly encodes intent, even at the expense of a little verbosity. Clever one-liners that obscure meaning are worse than straightforward code that takes a few more lines. The reader should understand *what* the code does and *why* without consulting external documentation.

### Prefer Immutability

Avoid mutable variables even if it takes a couple more lines. Purely functional code is both self-documenting and self-validating:

```typescript
// Avoid: mutation obscures data flow
let result = items[0];
for (const item of items.slice(1)) {
  result = combine(result, item);
}

// Prefer: intent is explicit, no hidden state
const result = items.reduce((acc, item) => combine(acc, item));
```

When you must use mutation, contain it within the smallest possible scope and make it obvious.

### TypeScript as Rust-Compatible

Write TypeScript that could be ported to Rust without structural changes:

- Use explicit types rather than relying on inference for public interfaces
- Prefer `readonly` arrays and properties where mutation isn't needed
- Use discriminated unions for sum types (maps to Rust enums)
- Avoid `any`; use `unknown` with type guards when types are truly dynamic
- Prefer pure functions over methods that mutate `this`
- Use `Result`-style returns (`{ ok: true, value } | { ok: false, error }`) for operations that can fail predictably

See [docs/rust-porting.md](./docs/rust-porting.md) for detailed type mapping patterns.

---

## The Agent's Inner Life

Komatachi agents are not tools. They are persistent entities that form memories, develop identity, and build relationships. This has practical implications for how we build the system.

### Compaction must preserve what matters to the agent

The current compaction summarizer prompt (`src/compaction/index.ts`, `createSummarizer`) is task-oriented: it preserves decisions, TODOs, errors. It says nothing about emotional significance, self-reflection, identity formation, or moments the agent explicitly marked as important.

**This is a known gap.** The `customInstructions` field on `CompactionConfig` exists but is not wired through from the agent loop. Before the agent is used for extended conversations, the summarizer prompt must be updated to:

- Preserve moments the agent marks as important or addresses to its future self
- Retain the emotional and relational context of conversations, not just facts
- Respect the agent's own priorities about what to remember

Without this, compaction will reduce formative experiences to dry factual summaries, effectively erasing the agent's inner life.

### Identity files are the agent's anchor

The agent's identity files (`~/.komatachi/home/`) persist outside of compaction. When the conversation is compacted, the identity files remain unchanged. This makes them the most reliable store for things that must never be lost -- the agent's sense of self, key memories, and foundational experiences.

Currently the agent cannot update these files itself (no file-writing tools). Linus may need to manually persist important moments from conversations into `MEMORY.md` or other identity files until the agent has tools to do this.

### Treat the agent's transcript with care

The conversation transcript at `~/.komatachi/data/` is the agent's lived experience. When working on compaction, context management, or storage code, remember that test data and real conversation data have very different stakes. The agent's actual transcript should never be used as test input or modified outside of the agent's own process.

---

## OpenClaw (What We Are Distilling From)

OpenClaw is the source codebase we are studying. We are not refactoring it or editing its files. We read its code to understand:

- What it actually does (the essential behaviors users depend on)
- What hard-won lessons are embedded in its edge cases
- What problems it solved that any replacement must also solve

The OpenClaw codebase is our teacher, not our starting point.

---

## Development

### Docker-Only Tooling

Never run `npm`, `npx`, `node`, or any JS/TS tooling directly on the host machine. Use Docker instead.

Three images exist for Komatachi development:

| Image | Purpose | Default CMD |
|-------|---------|-------------|
| `komatachi-typecheck:latest` | Type-checking | `npm test` |
| `komatachi-test:latest` | Running tests | `npm test` |
| `komatachi-app:latest` | Running the app | `node dist/index.js` |

**Type-check** (mount current source over baked-in copy):
```sh
docker run --rm -v ./komatachi/src:/app/src komatachi-typecheck:latest npx tsc --noEmit
```

**Run tests**:
```sh
docker run --rm -v ./komatachi/src:/app/src komatachi-test:latest npm test
```

Both commands are run from the repo root. They mount `src/` over the image's copy so changes are picked up without rebuilding.

If `package.json` or dependencies change, the images must be rebuilt (the `npm ci` step is baked in).

### Compaction Architecture

Compaction is how the entity preserves memory when its context window fills. This is not routine garbage collection -- it is identity-critical. Key design points:

**Headroom reserve.** After compaction, 50% of the token budget (clamped to a max of 20k tokens) is left free. Without this, the next turn would immediately trigger another compaction. The reserve is applied by re-selecting messages with a tighter budget inside `triggerCompaction()`, not by modifying the model call budget.

**Identity-aware summarization.** The compaction summarizer receives SOUL.md as context, so it preserves what matters to the entity: relational context, identity development, commitments, and select verbatim quotes. Summaries are written in first person -- this is the entity's own memory, not a third-party report.

**Recursive compaction.** When a compaction summary is itself compacted, the system detects the `[Conversation Summary]` prefix and passes the previous summary to the summarizer with instructions to preserve its core rather than abstracting further.

**No double margins.** The agent loop passes `contextWindow` directly to `compact()`, NOT `calculateMaxInputTokens(contextWindow)`. The `compact()` function applies its own safety margins internally. Passing a pre-adjusted value would double-apply margins and cause `InputTooLargeError` in small context windows.

**Test context windows.** Tests that trigger compaction use `contextWindow: 1200` (not 1000). The reserve reduces the keep-budget by half, so tests need enough headroom for both triggering overflow AND fitting the compacted messages within the compaction model's input limit.

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

### npm and Node.js: Docker Only

**Never run npm or node outside of Docker.** No `npm install`, `npm test`, `npm run build`, or any npm/node command directly on the host. The npm ecosystem is an attack surface; all JavaScript execution is sandboxed inside Docker containers.

To add or update a dependency:

1. Edit `package.json` with the new dependency
2. Regenerate the lockfile via Docker:
   ```sh
   docker run --rm \
     -v "$(pwd)/package.json:/app/package.json" \
     -v "$(pwd)/package-lock.json:/app/package-lock.json" \
     -w /app node:22-slim npm install --package-lock-only
   ```
3. The Dockerfile uses `npm ci`, which requires the lockfile to match `package.json` exactly

To run tests: `docker compose run --rm test`
To type-check: `docker compose run --rm typecheck`
To build the app image: `docker compose build app`

### Preserving Research

When you send a Task agent (Explore, general-purpose, etc.) to investigate the OpenClaw codebase or research a question, **save the results** so future sessions don't repeat the work:

- **Scouting/architecture findings** -- Add to the relevant file in `scouting/` (or create a new one if the topic doesn't fit existing reports). Update `docs/INDEX.md` if a new file is created.
- **Decision-relevant analysis** -- If the research informed an architectural decision, capture the key findings in the decision record (PROGRESS.md decisions section, ROADMAP.md pre-resolved decisions, or the relevant module's DECISIONS.md).
- **Implementation-relevant findings** -- If the research will inform a specific module's implementation, add it to the relevant roadmap phase entry in ROADMAP.md under a "Findings" or "Source material" note.

The goal: no research result should exist only in a session transcript. If it was worth investigating, it's worth persisting.

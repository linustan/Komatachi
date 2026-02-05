# Integration Validation Decisions

Phase 5: Verifying that all modules compose correctly into a working agent loop.

## 1. Integration tests in a separate directory, not colocated

Integration tests live in `src/integration/` rather than alongside any single module. They exercise the full pipeline: Storage -> Conversation Store -> Context Window -> System Prompt -> Tool Registry -> Agent Loop -> Compaction. No single module "owns" these tests.

## 2. Real internal dependencies, mock only external boundary

Following `docs/testing-strategy.md` for orchestration layers: all internal modules use their real implementations (real Storage writing to temp directories, real ConversationStore, real identity file loading). Only `callModel` (the Claude API) is mocked, since it is the external boundary.

## 3. Test scenarios mirror the integration trace

The test scenarios follow the three full turn traces from `docs/integration-trace.md`:
- Normal message (lifecycle, persistence, reload, continuation)
- Tool use (dispatch, intermediate message persistence, multi-tool)
- Compaction triggered (overflow -> compact -> persist -> reload -> continue)

Additional scenarios test cross-cutting concerns:
- Crash recovery (new store instance from same disk state)
- Identity evolution (identity files changing between turns)
- Data integrity (content blocks survive JSONL round-trip)
- Module interface composition (exact data flowing between modules)

## 4. Compaction test parameters require careful sizing

Compaction integration tests need parameter tuning. The core issue: `selectMessages` fills the budget as fully as possible, so the "kept" messages are close to the budget limit. The compaction summary (even at ~20 tokens) can push the post-compaction total over the budget, causing a second compaction attempt.

The fix: ensure enough messages are dropped so that the kept messages leave sufficient "slack" (budget minus kept tokens) for the summary message. In practice: use enough pre-filled messages that 5+ are dropped per compaction, not just 1-2.

## 5. No interface mismatches found

All module interfaces compose correctly as designed. The integration trace's 7 gaps (identified pre-implementation) were all resolved during Phases 1-4. No new gaps surfaced during integration testing.

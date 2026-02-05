# Storage Module Decisions

Architectural decisions made during the distillation of the Storage module.

## What We Preserved

### Atomic writes (write-to-temp, rename)
OpenClaw uses atomic writes for session data persistence. This is the correct pattern for crash safety: a rename is atomic on POSIX filesystems, so the file is either the old version or the new version, never a partially written state. Preserved as the foundation for all write operations.

### JSONL for append-only logs
OpenClaw uses JSONL files for session transcripts. One entry per line, append-only. This gives O(1) appends (no read-modify-write) and human-readable logs. Preserved for conversation transcripts.

### JSON for metadata
OpenClaw uses JSON files for session metadata. Small documents where read-modify-write is acceptable. Pretty-printed for human readability. Preserved for conversation metadata.

### Crash-resilient JSONL reading
If the process crashes mid-append, the last line of a JSONL file may be incomplete. `readAllJsonl` detects this (the last non-empty line fails JSON parsing) and silently skips it. Corrupt non-trailing lines still throw `StorageCorruptionError` since those indicate a different problem.

## What We Omitted

### File locking (188 LOC in OpenClaw)
OpenClaw's `session-write-lock.ts` implements advisory file locking with stale lock detection and process cleanup. This exists because multiple agents in one process can concurrently access session files. With one-agent-per-process (Decision #9), there is exactly one writer. No concurrent access, no locking needed. Atomic writes handle crash safety.

### Caching
OpenClaw's session store has a cache with TTL and mtime-based invalidation. Storage is a thin I/O layer; caching belongs above it (Conversation Store holds messages in memory). No hidden state.

### Path resolution logic (73 LOC in OpenClaw)
OpenClaw's `paths.ts` derives deterministic file paths from agent IDs and session keys. Storage doesn't know about agents or sessions -- it resolves paths relative to a base directory. Domain-specific path conventions are the consumer's responsibility.

### Integrity checking / transcript repair (206 LOC in OpenClaw)
OpenClaw's `session-transcript-repair.ts` repairs broken tool-use/tool-result pairing in transcripts. This is domain logic, not storage. If needed, it belongs in the Conversation Store or Agent Loop.

### Session-aware operations
OpenClaw's `store.ts` (440 LOC) combines file I/O with session CRUD (load, save, update with merge logic). Storage provides generic primitives; the Conversation Store adds domain semantics.

## Design Decisions

### Factory function, not class
`createStorage(baseDir)` returns an object with methods, following the same pattern as `createOpenAIProvider` in the embeddings module. Methods are closures over the base directory, avoiding `this` binding issues. Rust-compatible: maps to a struct with methods.

### Auto-create parent directories on write
Write operations (`writeJson`, `writeJsonl`, `appendJsonl`) create parent directories automatically. Read operations do not. This keeps the API simple: callers don't need to pre-create directory structures.

### `readRangeJsonl` implemented naively
Reads all entries and slices the result. Efficient enough for conversation transcripts (compaction keeps them manageable). A streaming implementation can be added if needed without changing the interface.

### Empty `writeJsonl` produces empty file
Writing an empty array creates an empty file rather than deleting it. The file's existence may carry semantic meaning for consumers (e.g., "this conversation has been initialized").

### Specific error types, not generic
Three distinct error types (`StorageNotFoundError`, `StorageCorruptionError`, `StorageIOError`) instead of a single `StorageError`. Each carries the path and (for corruption/IO) the underlying cause. This serves auditability (Principle 4) and matches the pattern established by compaction's `InputTooLargeError` and embeddings' error hierarchy.

### Synchronous filesystem I/O
All operations use `node:fs` sync methods (`readFileSync`, `writeFileSync`, `appendFileSync`, `renameSync`, `unlinkSync`, `mkdirSync`) rather than async (`node:fs/promises`). Rationale:

1. **Disk writes are single-digit ms.** LLM API calls are seconds. Async I/O optimizes a 1ms operation inside a 3000ms turn -- negligible.
2. **One writer per process** (Decision #9). With no concurrent writers, there is nothing to unblock while waiting for disk I/O.
3. **Avoids tokio in Rust.** Sync maps directly to `std::fs`, eliminating an entire class of async runtime bugs.
4. **Simpler code.** No `async`/`await`, no `Promise` return types, no `.then()` chains. Every function returns its value directly.

This was initially implemented with async I/O and converted to sync after analysis showed the async overhead provided no user-facing benefit.

# Testing Strategy

This document defines Komatachi's testing approach. Different architectural layers require different testing strategies.

## Layer-Based Testing

| Layer | Examples | Dependencies | Testing Approach |
|-------|----------|--------------|------------------|
| **Leaf (adapters)** | `EmbeddingProvider`, future DB adapters | External APIs, databases | Mock external deps; unit test our logic |
| **Core (domain)** | `cosineSimilarity`, token estimation | Pure functions, internal types | No mocks; unit test directly |
| **Orchestration** | Future `MemoryManager` | Multiple internal components | Real internal deps; mock only external boundary |

## Rationale

### Leaf Layers

Leaf layers adapt external services to our interfaces. The external service is the true boundary.

**Example**: `EmbeddingProvider` tests mock `fetch` because:
- OpenAI's API is external and unreliable for tests
- We're testing *our* logic: request formatting, response parsing, error handling
- The mock verifies we handle the API contract correctly

```typescript
// Correct: mock the external boundary
global.fetch = vi.fn().mockResolvedValue(mockOpenAIResponse([[0.1, 0.2]]));
const result = await provider.embed("test");
expect(result).toEqual([0.1, 0.2]);
```

### Core Layers

Pure functions and domain logic need no mocks. Test them directly with known inputs and expected outputs.

**Example**: `cosineSimilarity` tests use mathematical properties:
```typescript
// No mocks needed - pure function
expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);  // orthogonal
expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);  // identical
```

### Orchestration Layers

Orchestrators coordinate multiple internal components. Mocking internal deps hides integration bugs.

**Principle**: Use real internal dependencies; mock only at the external boundary.

**Example**: Future `MemoryManager` tests should:
```
MemoryManager
├── Real: EmbeddingProvider (our code)
├── Real: Storage (our code, in-memory SQLite)
├── Real: HybridSearch (our code)
└── Mocked: fetch (external boundary)
```

This catches bugs between our components while isolating from external services.

## Test Rigor Review

After writing tests, review each one asking:

1. **Is this a free pass?** Does the test actually verify behavior, or just confirm the mock returns what we told it to?

2. **Does it test requirements?** Each test should enforce a specific requirement, not just exercise code.

3. **Are edge cases covered?** Empty inputs, error conditions, boundary values.

4. **Is the assertion specific?** `toEqual([0.1, 0.2])` is better than `toBeDefined()`.

### Red Flags

- Test name doesn't match what it actually tests
- Mock returns exactly what the assertion expects (circular)
- No error case tests
- Only happy path coverage

### Good Patterns

- Tests with known mathematical properties (cosine similarity of orthogonal vectors = 0)
- Tests that verify exact request/response formats
- Tests that check error types AND error properties
- Edge case tests (empty arrays, whitespace strings, dimension mismatches)

## Test Organization

Tests are colocated with source files:
```
src/
├── embeddings/
│   ├── index.ts
│   └── index.test.ts    # Tests for this module
├── compaction/
│   ├── index.ts
│   └── index.test.ts
```

## Running Tests

```bash
npm test              # Run all tests
npm test -- --watch   # Watch mode
npm run test:coverage # With coverage report
```

## When to Write Tests

Following decision #8 ("Validate before advancing"):
- Write tests for each distilled component before moving to the next
- Tests often reveal design issues early
- Unvalidated foundations are risky

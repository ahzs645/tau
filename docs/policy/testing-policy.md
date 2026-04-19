---
title: 'Testing Policy'
description: 'Writing high-quality tests across the Tau monorepo. Assert observable behavior, error assertions, resource cleanup, mock factories, and async patterns. Covers Vitest, kernel tests, and API tests.'
status: active
created: '2026-03-09'
updated: '2026-03-10'
related:
  - docs/policy/react-testing-policy.md
  - docs/policy/typescript-policy.md
  - docs/research/typescript-overloads.md
---

# Testing Policy

Internal reference for writing high-quality tests across the Tau monorepo. Distilled from patterns observed in `packages/runtime`, `apps/ui`, and `apps/api`.

**See also:** [React Testing Policy](react-testing-policy.md) for hook and component testing patterns specific to `apps/ui`.

## Rationale

Tests that assert implementation details become brittle when refactoring and provide false confidence. Asserting observable behavior ensures tests verify what consumers and collaborators actually care about. Consistent patterns for error assertions, resource cleanup, and mock factories reduce bugs and improve maintainability across the monorepo.

## 1. Assert Observable Behavior, Not Implementation

Every assertion must verify something a consumer or collaborator can observe.
A test that only checks "does not throw" without verifying the resulting state
is incomplete.

```typescript
// INCORRECT: asserts nothing meaningful
it('should close ports on dispose', () => {
  const handle = createBridgePort(fs);
  expect(() => handle.dispose()).not.toThrow(); // proves nothing
});

// CORRECT: asserts the observable effect of closing ports
it('should close both ports on dispose, preventing further communication', async () => {
  vi.useFakeTimers();
  try {
    const handler = vi.fn().mockResolvedValue('ok');
    const handle = createBridgePort({ ping: handler });
    const proxy = createBridgeProxy<{ ping(): Promise<string> }>(handle.port);

    expect(await proxy.ping()).toBe('ok');
    expect(handler).toHaveBeenCalledOnce();

    handle.dispose();

    const pendingCall = proxy.ping();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pendingCall).rejects.toThrow('timed out');
    expect(handler).toHaveBeenCalledOnce(); // server never received the call
  } finally {
    vi.useRealTimers();
  }
});
```

**Rule of thumb:** If you remove the function under test and the test still
passes, the test is broken.

## 2. Test Naming

Use `it('should <verb> <outcome> [when <condition>]')` for consistency.

```typescript
// CORRECT
it('should reject pending calls when disposed');
it('should skip fetch for recently failed packages');
it('should preserve error name across the bridge');

// INCORRECT: imperative without "should"
it('renders single-key code object'); // unclear what's being asserted

// INCORRECT: vague
it('works correctly');
it('handles errors');
```

Nest `describe` blocks by feature or scenario:

```typescript
describe('ModuleManager', () => {
  describe('cache hit / miss', () => { ... });
  describe('retry backoff', () => { ... });
  describe('CDN fallback', () => { ... });
});
```

## 3. Error Assertions

Always assert both the error message and the error type when testing error
propagation. Use `rejects.toThrow` for async rejections.

```typescript
// CORRECT: asserts message and type
try {
  await call('fail', []);
  expect.fail('should have thrown');
} catch (error) {
  expect((error as Error).message).toBe('type mismatch');
  expect((error as Error).name).toBe('TypeError');
}

// CORRECT: async rejection
await expect(proxy.readFile('/missing.txt')).rejects.toThrow('ENOENT');

// INCORRECT: catches everything without inspecting
try {
  await riskyCall();
} catch {
  // test passes but we don't know what was thrown
}
```

Use `expect.fail('reason')` after a call that should throw, so the test
fails with a clear message if the exception is not raised.

## 4. Resource Cleanup

Always clean up resources (timers, workers, ports, mocks) in `afterEach` or
`finally` blocks. Never rely on the happy path reaching a manual cleanup call.

```typescript
// INCORRECT: cleanup only runs if the test passes
it('should timeout', async () => {
  vi.useFakeTimers();
  // ... if an assertion fails here, real timers are never restored
  vi.useRealTimers();
});

// CORRECT: finally guarantees cleanup
it('should timeout', async () => {
  vi.useFakeTimers();
  try {
    // ... test logic
  } finally {
    vi.useRealTimers();
  }
});
```

For shared resources (workers, servers, connections), use `afterEach`:

```typescript
let activeCleanup: (() => void) | undefined;

afterEach(() => {
  activeCleanup?.();
  activeCleanup = undefined;
});
```

## 5. Type-Safe Mocks with `mock<T>()`

Use `mock<T>()` from `vitest-mock-extended` (already installed) to create typed
test doubles. Never use `as unknown as T` to cast partial objects to full types.

**Why**: `as unknown as` bypasses the compiler entirely. `mock<T>()` returns a
deep Proxy that satisfies the full interface, auto-stubbing methods with
`vi.fn()` and properties with `undefined`, while allowing overrides.

```typescript
import { mock } from 'vitest-mock-extended';

// CORRECT: typed mock with overrides
const client = mock<RuntimeClient>({ terminate: vi.fn() });
const options = mock<RuntimeClientOptions>();
const ref = mock<ProjectContext['fileManagerRef']>({ send: vi.fn() });

// INCORRECT: bypasses type system
const client = {} as unknown as RuntimeClient;
const options = {} as unknown as RuntimeClientOptions;
```

For deeply nested mocks (NestJS services, complex interfaces), use `mockDeep<T>()`:

```typescript
import { mockDeep } from 'vitest-mock-extended';

const mockResult = mockDeep<StreamTextResult>();
```

For domain objects with sensible defaults, use shared factory functions:

```typescript
import { createMockFileSystem } from '#testing/kernel-testing.utils.js';

const filesystem = createMockFileSystem();
filesystem.mocks.exists.mockResolvedValue(true);
```

**Limitation**: `mock<T>()` returns a Proxy. Objects that must be serialized
(`JSON.stringify`, `postMessage`, `structuredClone`) cannot use `mock<T>()`.
In those cases, use a plain object with a single `as T` assertion.

See `docs/research/typescript-overloads.md` for why overloaded function types
are incompatible with `vi.fn()` mapped types.

## 6. Async Patterns

Prefer `await expect(promise).rejects.toThrow()` over try/catch for simple
rejection tests. Use try/catch only when inspecting multiple error properties.

```typescript
// CORRECT: for simple cases
await expect(proxy.readFile('/missing.txt')).rejects.toThrow('ENOENT');

// Use try/catch when asserting multiple properties
try {
  await call('fail', []);
  expect.fail('should have thrown');
} catch (error) {
  expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
  expect((error as Error).message).toContain('not found');
}
```

For fake timers with async operations:

```typescript
vi.useFakeTimers();
try {
  const pendingCall = proxy.readFile('/path');
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(pendingCall).rejects.toThrow('timed out');
} finally {
  vi.useRealTimers();
}
```

## 7. Immutability and Side-Effect Checks

When a function must not mutate its inputs, verify the original values
are unchanged after the call. Verify that outputs are new references.

```typescript
it('should not mutate the original array', async () => {
  const original = [{ id: 1, name: 'test' }];
  const originalCopy = structuredClone(original);

  const result = transform(original);

  expect(original).toEqual(originalCopy); // input unchanged
  expect(result).not.toBe(original); // new reference
});
```

## 8. Avoid Console Output in Tests

Do not leave `console.log` or `console.error` in test files. If diagnostic
output is needed during development, remove it before committing.

```typescript
// INCORRECT
console.log(`[debug] ${entries.length} files survived`);

// CORRECT: remove it, or use expect() to assert the value
expect(entries).toHaveLength(fileCount);
```

## 9. Structure Assertions Over Existence Assertions

When testing structured data (objects, arrays, geometry), assert the shape
and specific values, not just that the result exists or has length > 0.

```typescript
// INCORRECT: only checks existence
expect(result.data.length).toBeGreaterThan(0);

// CORRECT: checks structure
expect(result.data[0]).toEqual(
  expect.objectContaining({
    type: 'mesh',
    vertices: expect.any(Float32Array),
  }),
);
```

## 10. Test File Organization

| Convention        | Pattern                                             |
| ----------------- | --------------------------------------------------- |
| Placement         | `*.test.ts` co-located next to the source file      |
| Imports           | `import { describe, it, expect, vi } from 'vitest'` |
| Top `describe`    | Module or unit under test                           |
| Nested `describe` | Feature, scenario, or behavior group                |
| Section comments  | Use `// ===` separators for large test files        |
| Shared helpers    | Place in `testing/` directory with explicit exports |

## 11. No Type Assertions for Mocks

Never use `as unknown as T` to create mock objects or cast return values.

**Why**: Double assertions erase all type information. When the real type changes,
tests using `as unknown as` continue to compile and pass with stale shapes,
hiding regressions.

| Scenario                    | Pattern                                  | Notes                                          |
| --------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Partial interface stub      | `mock<ServiceType>({ method: vi.fn() })` | Auto-stubs missing members                     |
| Empty configuration         | `mock<ConfigType>()`                     | All properties default to `undefined`          |
| Deep nested mock            | `mockDeep<ComplexType>()`                | Recursively mocks nested objects               |
| Serialized data             | `{ field: 'value' } as DataType`         | Single assertion for plain data                |
| Intentionally invalid input | `'bad' as unknown as ValidType`          | Error-path tests only; requires oxlint-disable |

CORRECT:

```typescript
import { mock } from 'vitest-mock-extended';

const client = mock<RuntimeClient>({ terminate: vi.fn() });
const options = mock<RuntimeClientOptions>();
```

INCORRECT:

```typescript
const client = {} as unknown as RuntimeClient;
const options = {} as unknown as RuntimeClientOptions;
```

## Summary Checklist

Before merging a test:

- [ ] Every `it` block has at least one meaningful assertion on observable behavior
- [ ] Error tests assert message and/or error type
- [ ] Resources are cleaned up in `afterEach` or `finally`
- [ ] Fake timers are restored in `finally`
- [ ] No `console.log` statements
- [ ] Mock objects use `mock<T>()` from `vitest-mock-extended`, not `as unknown as`
- [ ] Mock factories are shared, not duplicated per test file
- [ ] Test names follow `should <verb> <outcome>` pattern
- [ ] Structured data assertions check shape, not just existence

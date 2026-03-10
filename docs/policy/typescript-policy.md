---
title: 'TypeScript Policy'
description: 'Type assertion rules, mock typing patterns, generic inference, and common gotchas for safe TypeScript usage across the Tau monorepo.'
status: active
created: '2026-03-09'
updated: '2026-03-09'
related:
  - docs/research/typescript-overloads.md
  - docs/policy/xstate-policy.md
---

# TypeScript Policy

Internal reference for safe, idiomatic TypeScript usage across the Tau monorepo.

## Rationale

Type assertions (`as`) bypass the compiler's structural checks. When misused — particularly `as never` and `as any` — they silently erase type information and mask real type errors, which surface later as runtime bugs. This policy codifies when assertions are acceptable, what alternatives to prefer, and how to handle the common scenarios that tempt developers toward unsafe casts.

## Rules

### 1. Never Use `as never`

`as never` is banned. The `no-restricted-syntax` ESLint rule (targeting `TSAsExpression > TSNeverKeyword`) enforces this at lint time. The rule is defined in `eslint.config.mjs` because oxlint's jsPlugin adapter does not expose TypeScript-specific AST nodes.

**Why**: `never` is the bottom type — assignable to everything and from nothing. Casting to `never` erases all type information with zero compile-time feedback. It is invariably a cover-up for an underlying type mismatch that should be fixed at the source.

CORRECT:

```typescript
const options = {} as unknown as KernelClientOptions;
```

INCORRECT:

```typescript
const options = {} as never;
```

### 2. Prefer Proper Typing Over Any Assertion

Before reaching for a type assertion, exhaust these alternatives in order:

1. **Fix the type** — If the types don't align, the type definitions may be wrong.
2. **Narrow the type** — Use type guards, discriminated unions, or `satisfies`.
3. **Annotate explicitly** — Add return type annotations or generic parameters.
4. **Use `as const`** — For literal type inference (event `type` fields, enum-like constants).

**Why**: Each alternative preserves compiler verification. Assertions skip verification entirely.

### 3. `as unknown as Type` Is the Sanctioned Escape Hatch

When a type assertion is genuinely necessary (complex mocks, WASM bindings, third-party type gaps), use the two-step `as unknown as Type` pattern.

**Why**: Unlike `as never`, `as unknown as Type` is explicit about the target type. The developer documents what they believe the value to be, and reviewers can verify the claim.

| Scenario                 | Pattern                                            | Required Comment                                                                                                        |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Mock object in test      | `mockObj as unknown as ServiceType`                | `oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock for unit test`                          |
| WASM enum binding        | `enumValue as unknown as Parameters<typeof fn>[N]` | `oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- WASM binding enum type mismatch`             |
| Overloaded function mock | `vi.fn() as unknown as OverloadedFn`               | `oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- overload mock (see typescript-overloads.md)` |

CORRECT:

```typescript
// oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock client for unit test
const client = mockClient as unknown as KernelClient;
```

INCORRECT:

```typescript
const client = mockClient as never;
```

### 4. Annotate Placeholder Actor Return Types

Placeholder actors (XState actors that `throw new Error('not provided')` and are overridden via `machine.provide()`) must have explicit return type annotations. Without them, TypeScript infers `Promise<never>`, and every `provide()` call requires an assertion.

**Why**: `throw` makes TypeScript infer the return type as `never`. Explicit annotation tells TypeScript the contract the `provide()` replacement must satisfy.

CORRECT — use generic parameters and an explicit return type annotation:

```typescript
type LoadedEvent = { type: 'loaded'; data: Data };
type LoadInput = { id: string };

const loadDataActor = fromSafeAsync<LoadedEvent, LoadInput>(async (): Promise<LoadedEvent> => {
  throw new Error('loadDataActor not provided');
});
```

INCORRECT — no return type annotation, infers `Promise<never>`:

```typescript
const loadDataActor = fromSafeAsync<LoadedEvent, LoadInput>(async () => {
  throw new Error('loadDataActor not provided');
});
```

### 5. Match Mock Types Exactly in `provide()`

When providing actor implementations via `machine.provide()`, the mock's input and return types must exactly match the placeholder actor's types. Use generic parameters on the mock's `fromSafeAsync` call.

**Why**: XState's `provide()` type system performs exact structural matching. Even subtle differences (e.g., `false` vs `boolean`, `string` vs `string | undefined`) cause type errors.

CORRECT — generic parameters match the original actor:

```typescript
machine.provide({
  actors: {
    loadDataActor: fromSafeAsync<LoadedEvent, LoadInput>(async ({ input }) => {
      return { type: 'loaded' as const, data: await fetchData(input.id) };
    }),
  },
});
```

INCORRECT — `as never` masks the type mismatch:

```typescript
machine.provide({
  actors: {
    loadDataActor: fromSafeAsync(async ({ input }) => {
      return { type: 'loaded' as const, data: await fetchData(input.id) };
    }) as never,
  },
});
```

### 6. Use `as const` for Event Type Discriminants

Event objects returned from `fromSafeAsync` must use `as const` on the `type` field to preserve the literal type.

**Why**: Without `as const`, TypeScript widens `'loaded'` to `string`, breaking discriminated union matching in XState's `on:` handlers.

CORRECT:

```typescript
return { type: 'dataFetched' as const, data };
```

INCORRECT:

```typescript
return { type: 'dataFetched', data };
```

### 7. Widen Literal Types in Mock Return Values

When a mock's return value has literal types (e.g., `false`, `undefined`) that are narrower than the slot's expected type (e.g., `boolean`, `string | undefined`), widen explicitly.

**Why**: TypeScript infers the narrowest possible literal type for object literals. If the slot expects `boolean` but the mock returns `{ hasMore: false }`, the literal `false` doesn't match `boolean` in invariant positions.

CORRECT:

```typescript
return { hasMore: false as boolean, endCursor: undefined as string | undefined };
```

### 8. Handle `process.exit` Mocks Correctly

`process.exit()` returns `never` (it never returns). Mock implementations cannot actually return `never`, so cast the mock function itself.

**Why**: Casting the return value `as never` would violate Rule 1. Instead, cast the entire function to match the `typeof process.exit` signature.

CORRECT:

```typescript
vi.spyOn(process, 'exit').mockImplementation(
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- process.exit returns never
  (() => undefined) as unknown as typeof process.exit,
);
```

### 9. Use `as T` for `JSON.parse` Return Values

`JSON.parse()` returns `any`. In generic functions with a known return type `T`, cast directly to `T`.

**Why**: `as T` is safe from `any` (which is assignable to everything) and more explicit than `as never`.

CORRECT:

```typescript
function parseJson<T>(input: string): T {
  return JSON.parse(input) as T;
}
```

### 10. Iterator `done` Results Use `void`, Not `never`

When implementing `AsyncIterator<T, TReturn>`, the `done: true` result needs `value: TReturn`. Use `TReturn = void` (not `never`) when the iterator has no meaningful return value.

**Why**: `void` accepts `undefined` as a value. `never` accepts nothing, forcing `as never` on every `return` statement.

CORRECT:

```typescript
async *generate(): AsyncGenerator<ServerMessage, void> {
  // ...
}

return { done: true as const, value: undefined };
```

INCORRECT:

```typescript
return { done: true, value: undefined as never };
```

## Anti-Patterns

### `as never` for XState `provide()` Type Mismatches

**Symptom**: `provide()` call fails because the mock actor type doesn't match the slot.

**Root cause**: The placeholder actor infers `Promise<never>` because it only throws, or the mock's input type doesn't match.

**Fix**: Add explicit return type to the placeholder (Rule 4), and annotate the mock's input parameter (Rule 5).

### `as never` for Empty Object Stubs

**Symptom**: `const options = {} as never` used for complex configuration objects in tests.

**Root cause**: The test doesn't need any specific configuration values but TypeScript requires the full type.

**Fix**: `{} as unknown as ConfigType` with an oxlint-disable comment (Rule 3).

### `as never` for WASM Enum Values

**Symptom**: OpenCASCADE WASM enum values cast `as never` because the binding types don't match the function parameter types.

**Root cause**: WASM binding type definitions are auto-generated and often imprecise.

**Fix**: `enumValue as unknown as Parameters<typeof fn>[N]` extracts the expected type from the function signature (Rule 3).

### `as never` in Unreachable Code Paths

**Symptom**: `return undefined as never` in branches guarded by type narrowing that TypeScript can't verify.

**Root cause**: The function's return type doesn't include `undefined`, but the code path is reachable from TypeScript's perspective.

**Fix**: Return the current value (`return context.field`), restructure with exhaustive checks, or widen the return type to include `undefined`.

## Summary Checklist

- [ ] No `as never` in any file (`no-restricted-syntax` ESLint rule enforced at lint time)
- [ ] No `as any` (`@typescript-eslint/no-explicit-any` enforced)
- [ ] All `as unknown as Type` have `oxlint-disable-next-line` with description
- [ ] Placeholder actors have explicit return type annotations
- [ ] Mock input types match original actor input types exactly
- [ ] Event `type` fields use `as const` in `fromSafeAsync` returns
- [ ] Iterator `TReturn` uses `void`, not `never`

## References

- Related: `docs/research/typescript-overloads.md` — overloaded function patterns and mock compatibility
- Related: `docs/policy/xstate-policy.md` — `fromSafeAsync` usage and async actor patterns
- [TypeScript Handbook — Type Assertions](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions)
- [TypeScript Handbook — Conditional Types (overload inference)](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html)

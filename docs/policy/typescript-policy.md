---
title: 'TypeScript Policy'
description: 'Type assertion rules, mock typing patterns, generic inference, and common gotchas for safe TypeScript usage across the Tau monorepo.'
status: active
created: '2026-03-09'
updated: '2026-03-10'
related:
  - docs/policy/testing-policy.md
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
import { mock } from 'vitest-mock-extended';
const options = mock<KernelClientOptions>();
```

INCORRECT:

```typescript
const options = {} as never;
const options = {} as unknown as KernelClientOptions;
```

### 2. Prefer Proper Typing Over Any Assertion

Before reaching for a type assertion, exhaust these alternatives in order:

1. **Fix the type** — If the types don't align, the type definitions may be wrong.
2. **Narrow the type** — Use type guards, discriminated unions, or `satisfies`.
3. **Annotate explicitly** — Add return type annotations or generic parameters.

**Why**: Each alternative preserves compiler verification. Assertions skip verification entirely.

### 3. Prefer Type-Safe Alternatives Over `as unknown as`

`as unknown as Type` bypasses the compiler entirely. Before using it, exhaust
these alternatives in order of preference:

1. **In tests**: Use `mock<T>()` from `vitest-mock-extended` (see `docs/policy/testing-policy.md` Rules 5 & 11).
2. **For third-party type gaps**: Create `.d.ts` module augmentation files.
3. **For WASM bindings**: Encapsulate casts in typed wrapper functions.
4. **Last resort**: `as unknown as Type` with `oxlint-disable-next-line` comment.

**Why**: Each higher-tier alternative preserves some compiler verification.
`as unknown as` preserves none.

| Scenario                         | Preferred Pattern           | Last Resort                              |
| -------------------------------- | --------------------------- | ---------------------------------------- |
| Mock object in test              | `mock<ServiceType>()`       | —                                        |
| WASM enum binding                | Typed wrapper function      | `as unknown as Parameters<typeof fn>[N]` |
| Third-party type gap             | Module augmentation `.d.ts` | `as unknown as Type`                     |
| Private library API              | `'prop' in obj` narrowing   | `as unknown as { prop: Type }`           |
| Intentionally invalid test input | —                           | `'bad' as unknown as ValidType`          |

CORRECT:

```typescript
import { mock } from 'vitest-mock-extended';
const client = mock<KernelClient>({ terminate: vi.fn() });
```

INCORRECT:

```typescript
const client = {} as unknown as KernelClient;
```

When `as unknown as` is genuinely necessary (last resort), every usage must
have an `oxlint-disable-next-line @typescript-eslint/consistent-type-assertions`
comment explaining why no higher-tier alternative is feasible.

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
      return { type: 'loaded', data: await fetchData(input.id) };
    }),
  },
});
```

INCORRECT — `as never` masks the type mismatch:

```typescript
machine.provide({
  actors: {
    loadDataActor: fromSafeAsync(async ({ input }) => {
      return { type: 'loaded', data: await fetchData(input.id) };
    }) as never,
  },
});
```

### 6. Do Not Use `as const` on Individual Literals

`as const` on individual literal values (e.g., `'foo' as const`, `true as const`, `42 as const`) is banned. The `tau-lint/no-literal-const-assertion` oxlint rule enforces this at lint time with auto-fix support.

**Why**: When a function's return type is constrained — by generic parameters (`fromSafeAsync<TReturn, TInput>`), explicit return type annotations, or contextual typing (`.provide()` overrides) — TypeScript contextually types string literals to their literal types automatically. The `as const` assertion is a no-op in these positions and adds visual noise.

CORRECT:

```typescript
return { type: 'dataFetched', data };
```

INCORRECT:

```typescript
return { type: 'dataFetched' as const, data };
```

**When `as const` IS needed** — inside `.map()`, `.flatMap()`, or other callbacks where contextual typing is lost, hoist `as const` to the outermost container instead of individual properties:

```typescript
// CORRECT — container-level as const
entries.map((e) => ({ type: e.isDir ? 'dir' : 'file', name: e.name }) as const);

// INCORRECT — literal-level as const (banned by lint rule)
entries.map((e) => ({ type: e.isDir ? ('dir' as const) : ('file' as const), name: e.name }));
```

The rule only targets `as const` on individual literal values — whole-object `{ ... } as const` and whole-array `[...] as const` are permitted and preferred.

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

return { done: true, value: undefined };
```

INCORRECT:

```typescript
return { done: true, value: undefined as never };
```

## Anti-Patterns

### `as unknown as` for Empty Mock Stubs in Tests

**Symptom**: `const options = {} as unknown as ConfigType` for configuration objects in tests.

**Root cause**: The test doesn't need specific configuration values but TypeScript requires the full type.

**Fix**: `mock<ConfigType>()` from `vitest-mock-extended` (Rule 3, testing-policy Rule 5).

### `as never` for XState `provide()` Type Mismatches

**Symptom**: `provide()` call fails because the mock actor type doesn't match the slot.

**Root cause**: The placeholder actor infers `Promise<never>` because it only throws, or the mock's input type doesn't match.

**Fix**: Add explicit return type to the placeholder (Rule 4), and annotate the mock's input parameter (Rule 5).

### `as never` for WASM Enum Values

**Symptom**: OpenCASCADE WASM enum values cast `as never` because the binding types don't match the function parameter types.

**Root cause**: WASM binding type definitions are auto-generated and often imprecise.

**Fix**: Encapsulate in typed wrapper functions. Use `as unknown as Parameters<typeof fn>[N]` inside the wrapper (Rule 3, last resort).

### `as never` in Unreachable Code Paths

**Symptom**: `return undefined as never` in branches guarded by type narrowing that TypeScript can't verify.

**Root cause**: The function's return type doesn't include `undefined`, but the code path is reachable from TypeScript's perspective.

**Fix**: Return the current value (`return context.field`), restructure with exhaustive checks, or widen the return type to include `undefined`.

## Summary Checklist

- [ ] No `as never` in any file (`no-restricted-syntax` ESLint rule enforced at lint time)
- [ ] No `as any` (`@typescript-eslint/no-explicit-any` enforced)
- [ ] No `as unknown as` for mock objects in tests (use `mock<T>()` from `vitest-mock-extended`)
- [ ] Remaining `as unknown as Type` have `oxlint-disable-next-line` with description
- [ ] Placeholder actors have explicit return type annotations
- [ ] Mock input types match original actor input types exactly
- [ ] No `literal as const` on individual values (`tau-lint/no-literal-const-assertion` enforced)
- [ ] Iterator `TReturn` uses `void`, not `never`

## References

- Related: `docs/policy/testing-policy.md` — `mock<T>()` usage and type-safe mock patterns
- Related: `docs/research/typescript-overloads.md` — overloaded function patterns and mock compatibility
- Related: `docs/policy/xstate-policy.md` — `fromSafeAsync` usage and async actor patterns
- [TypeScript Handbook — Type Assertions](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions)
- [TypeScript Handbook — Conditional Types (overload inference)](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html)

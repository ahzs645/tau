---
title: 'TypeScript Function Overloads: Patterns, Limitations, and Mock Compatibility'
description: 'Root cause, official TypeScript stance, and recommended patterns for overloads in @taucad/kernels; mock compatibility and factory patterns.'
status: active
created: '2026-03-03'
updated: '2026-03-09'
category: investigation
related:
  - docs/policy/testing-policy.md
---

# TypeScript Function Overloads: Patterns, Limitations, and Mock Compatibility

## Problem Statement

TypeScript function overloads in type literals (interfaces / object types) create
structural-type incompatibilities with generic utilities like `Parameters<T>`,
`ReturnType<T>`, and testing mocks (`vi.fn()` / `jest.fn()`).

This document captures the root cause, the official TypeScript stance, and
recommended patterns for the `@taucad/kernels` codebase.

---

## The Limitation (Official TypeScript Documentation)

From the [TypeScript Handbook — Conditional Types](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html):

> When inferring from a type with multiple call signatures (such as the type of
> an overloaded function), inferences are made from the **last** signature
> (which, presumably, is the most permissive catch-all case). It is not possible
> to perform overload resolution based on a list of argument types.

This is documented in the official handbook under
_"Inferring Within Conditional Types"_ and is a fundamental architectural
constraint, not a bug. The related GitHub issue
([microsoft/TypeScript#28789](https://github.com/microsoft/TypeScript/issues/28789))
was closed as **by design** and locked as **resolved**.

### Impact

Any TypeScript utility type that uses `infer` — which includes `Parameters<T>`,
`ReturnType<T>`, `ConstructorParameters<T>`, and `InstanceType<T>` — only
extracts the **last** overload signature.

```typescript
type ReadFileFn = {
  (path: string, encoding: 'utf8'): Promise<string>; // ← ignored by infer
  (path: string): Promise<Uint8Array<ArrayBuffer>>; // ← only this is seen
};

type P = Parameters<ReadFileFn>; // [path: string]  (missing encoding overload)
type R = ReturnType<ReadFileFn>; // Promise<Uint8Array<ArrayBuffer>>
```

---

## Consequences for Mocking

Testing libraries (Vitest, Jest) define `Mock<T>` types that use `Parameters<T>`
and `ReturnType<T>` internally. When `T` is an overloaded function:

1. `vi.fn<T>()` creates a `Mock` matching only the last overload.
2. The mock's call signature is a strict subset of the real type.
3. The mock is NOT structurally assignable to an interface with overloads.

```typescript
// KernelFileSystemBase has overloaded readFile:
//   readFile(path: string, encoding: 'utf8'): Promise<string>;
//   readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;

const mock = vi.fn<KernelFileSystem['readFile']>();
// mock only satisfies: (path: string) => Promise<Uint8Array<ArrayBuffer>>
// mock does NOT satisfy: (path: string, encoding: 'utf8') => Promise<string>

// Result: `as KernelFileSystem` assertion required.
```

---

## Pattern Comparison

### 1. Function Overloads (current)

```typescript
type FileSystem = {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
};
```

| Aspect                  | Rating                                        |
| ----------------------- | --------------------------------------------- |
| Call-site DX            | ★★★★★ — perfect narrowing, no casts needed    |
| `Parameters<T>` compat  | ✗ — only last overload extracted              |
| `ReturnType<T>` compat  | ✗ — only last overload extracted              |
| Mock assignability      | ✗ — `Mock<T>` misses overloads                |
| Exponential growth risk | ✗ — each new param variant doubles signatures |

**Best for:** Public APIs consumed by humans, where call-site ergonomics
outweigh generic-utility compat. _(This is our `KernelFileSystemBase` case.)_

### 2. Conditional Return Type (generic single signature)

```typescript
type FileSystem = {
  readFile<E extends 'utf8' | undefined = undefined>(
    path: string,
    encoding?: E,
  ): Promise<E extends 'utf8' ? string : Uint8Array<ArrayBuffer>>;
};
```

| Aspect                  | Rating                                                         |
| ----------------------- | -------------------------------------------------------------- |
| Call-site DX            | ★★★★★ — same narrowing as overloads                            |
| `Parameters<T>` compat  | ★★★★ — extracts widened params from single signature           |
| `ReturnType<T>` compat  | ★★★ — returns union (`string \| Uint8Array`)                   |
| Mock assignability      | ★★★ — widened return means mock is still not a perfect subtype |
| Exponential growth risk | ✓ — single signature handles all combinations                  |

**Best for:** Library internals that need to compose with generics, wrappers,
or type-level transforms. Good when you want one signature and don't need
separate overload documentation.

**Caveat:** Implementations must use a type assertion in the function body,
because TypeScript cannot narrow conditional return types inside the
implementation. This is the same trade-off as overloads (where the
implementation signature is only loosely checked).

### 3. Simple Union Return (no generics)

```typescript
type FileSystem = {
  readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>>;
};
```

| Aspect                  | Rating                                         |
| ----------------------- | ---------------------------------------------- |
| Call-site DX            | ★★ — always returns union, callers must narrow |
| `Parameters<T>` compat  | ★★★★★                                          |
| `ReturnType<T>` compat  | ★★★★★                                          |
| Mock assignability      | ★★★★★ — perfect match                          |
| Exponential growth risk | ✓                                              |

**Best for:** Internal helper functions where the return type is immediately
consumed and narrowed by the caller.

---

## Recommended Pattern for `@taucad/kernels`

### Keep overloads on the interface

The `KernelFileSystemBase.readFile` overloads provide excellent DX at call sites
across 20+ files in the kernels package. Every usage is either
`readFile(path, 'utf8')` (expects `string`) or `readFile(path)` (expects `Uint8Array`).
Replacing overloads with a union return would regress DX in every kernel, middleware,
and bundler file.

### Solve mock assignability at the mock layer

The `readFile` overload limitation is a **testing concern**, not an API design
concern. The fix belongs in the mock factory, not the interface.

The shared `createMockFileSystem()` in `kernel-testing.utils.ts` already handles
this by wrapping the underlying `vi.fn()` in a proper overloaded function:

```typescript
function readFile(path: string, encoding: 'utf8'): Promise<string>;
function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
async function readFile(path: string, encoding?: 'utf8') {
  return readFileFn(path, encoding); // delegates to vi.fn()
}
```

This wrapper satisfies the overloaded type while the underlying `readFileFn`
mock remains untyped (accepting any args and returning any value). The wrapper
IS structurally assignable to `KernelFileSystemBase` because it declares both
overload signatures.

**Rule:** All test files should use the shared `createMockFileSystem()` utility.
Do not define local `MockFileSystem` types with `ReturnType<typeof vi.fn>` —
these produce `Mock<Constructable | Procedure>` which cannot satisfy overloads.

---

### 4. Function Declaration in Object Literal (factory pattern)

When a factory function returns an object literal that must satisfy an interface
with overloaded methods, declare the overloaded function as a **function
statement** inside the factory, then assign it as a property. Function
statements receive _loose_ implementation checking (the implementation signature
need only be compatible with the overloads), while arrow functions in object
literals receive _strict_ checking.

```typescript
// ✓ GOOD — function declaration gets loose overload checking
const createProvider = async (): Promise<FileSystemProvider> => {
  const fs = await mountBackend();

  function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  async function readFile(path: string, encoding?: 'utf8') {
    const data = await fs.read(path);
    return encoding === 'utf8' ? decode(data) : data;
  }

  return { readFile /* … */ }; // no assertion needed
};
```

```typescript
// ✗ BAD — arrow/method in object literal gets strict checking
return {
  async readFile(path: string, encoding?: 'utf8') { /* … */ },
  // TS2322: implementation signature not assignable to overloads
};

// ✗ WORKAROUND — type assertion hides real errors
return { readFile: async (…) => { … } } as FileSystemProvider;
```

| Aspect                    | Rating                                         |
| ------------------------- | ---------------------------------------------- |
| Call-site DX              | ★★★★★ — overloads visible, narrowing works     |
| Implementation safety     | ★★★★ — loose checking catches gross mismatches |
| No assertion needed       | ✓                                              |
| Works in factory closures | ✓ — captures outer scope variables             |

**Best for:** Factory functions returning object literals with overloaded
methods (e.g., `createZenFsProvider`, `createMockFileSystem`).

**Reference:** [SO #74881861](https://stackoverflow.com/questions/74881861/),
[SO #34798989](https://stackoverflow.com/questions/34798989/)

---

### 5. Generic Backend Configuration (preserving inferred options)

When wrapping a library type like `BackendConfiguration<T extends Backend>`,
make both the options type and factory function generic over `T`. This lets
TypeScript infer the concrete backend type from the caller's argument, preserving
backend-specific options (e.g., `storeName` for IndexedDB, `handle` for
WebAccess) without resorting to `any` or `Record<string, unknown>`.

```typescript
// ✓ GOOD — generic preserves backend-specific options
type ProviderOptions<T extends Backend = Backend> = {
  backendConfig: BackendConfiguration<T>;
};

const create = async <T extends Backend>(opts: ProviderOptions<T>) => resolveMountConfig(opts.backendConfig); // T inferred from caller

// Caller: T inferred as typeof IndexedDB → storeName is valid
create({ backendConfig: { backend: IndexedDB, storeName: 'myfs' } });
```

```typescript
// ✗ BAD — erases backend-specific options
type ProviderOptions = {
  backendConfig: BackendConfiguration<Backend>;
  // OptionsOf<Backend> = object → no storeName, no handle
};

// ✗ BAD — escapes type system entirely
type ProviderOptions = {
  backendConfig: { backend: any } & Record<string, unknown>;
};
```

**Best for:** Wrapping library generic types where the concrete type parameter
flows from the caller's input.

---

## Anti-Patterns

### 1. Mapped mock types with `ReturnType<typeof vi.fn>`

```typescript
// ✗ BAD — Mock<Constructable | Procedure> does not satisfy overloaded methods
type MockFileSystem = {
  [K in keyof KernelFileSystem]: ReturnType<typeof vi.fn>;
};
```

`ReturnType<typeof vi.fn>` is `Mock<Constructable | Procedure>` — a union
that includes a constructor variant. This is never assignable to an overloaded
function type.

### 2. Inline `as KernelFileSystem` at every call site

```typescript
// ✗ BAD — assertion scattered across every test file
const plugin = createVfsPlugin({
  filesystem: filesystem as KernelFileSystem,
  moduleManager: new ModuleManager(filesystem as KernelFileSystem),
});
```

### 3. Double casts (`as unknown as T`)

```typescript
// ✗ BAD — suppresses ALL type checking, hides real bugs
const fs = mockObj as unknown as KernelFileSystem;
```

---

## Correct Pattern

```typescript
// ✓ GOOD — use the shared mock factory
import { createMockFileSystem } from '#testing/kernel-testing.utils.js';

const filesystem = createMockFileSystem();
// filesystem satisfies KernelFileSystem ✓
// filesystem.mocks.readFile gives access to the vi.fn() for assertions ✓

const plugin = createVfsPlugin({
  filesystem, // no assertion needed
  moduleManager: new ModuleManager(filesystem), // no assertion needed
});

// Mock setup via .mocks:
filesystem.mocks.readFile.mockResolvedValue('file content');
filesystem.mocks.exists.mockResolvedValue(true);

// Assertions via .mocks:
expect(filesystem.mocks.writeFile).toHaveBeenCalledWith('/path', data);
```

---

## Note on `satisfies` Operator

The `satisfies` operator (TypeScript 4.9+) validates conformance without
widening inferred types, but does **not** help with overloaded method
implementations. `satisfies FileSystemProvider` on an object literal with an
arrow-function `readFile` produces the same TS2322 error as a type annotation.
The function-declaration pattern (§4 above) remains the correct solution for
object literals with overloaded methods.

---

## References

- [TypeScript Handbook — Conditional Types (infer limitation)](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html)
- [microsoft/TypeScript#28789 — `Parameters<T>` only sees last overload](https://github.com/microsoft/TypeScript/issues/28789) (closed, by design)
- [microsoft/TypeScript#38685 — Related: overloaded function inference](https://github.com/microsoft/TypeScript/issues/38685)
- [vitest-dev/vitest#6085 — MockInstance with overloaded functions](https://github.com/vitest-dev/vitest/issues/6085)
- [Conditional Return Types for Function Overloading](https://blog.devgenius.io/conditional-return-type-for-function-overloading-in-typescript-e3c53b9a1fcb)
- [When to Use Conditional Types vs Function Overloads](https://www.craigmacintyre.co.uk/conditional-types-in-typescript/)
- [SO #74881861 — Object literal overload implementation](https://stackoverflow.com/questions/74881861/) (function declaration pattern)
- [SO #34798989 — Overload object function properties](https://stackoverflow.com/questions/34798989/) (separate declaration assignment)
- [TypeScript 4.9 `satisfies` docs](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html) (does not help with overloaded implementations)

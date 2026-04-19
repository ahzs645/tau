---
title: 'Disposable API for Embind Classes'
description: 'How TC39 Explicit Resource Management (Symbol.dispose / using) integrates with Emscripten embind classes and opencascade.js type generation.'
status: active
created: '2026-03-06'
updated: '2026-03-06'
category: reference
related:
  - docs/policy/resource-cleanup-policy.md
---

# Disposable API for Embind Classes

How TC39 Explicit Resource Management (`Symbol.dispose` / `using`) integrates with Emscripten embind classes, the opencascade.js type generation pipeline, and Tau's Monaco editor.

## Executive Summary

Emscripten 5.0.1 automatically adds `[Symbol.dispose]` to all embind class prototypes (aliased to `delete()`), enabling `using` declarations at runtime. However, the generated `.d.ts` files do not declare `[Symbol.dispose](): void`, causing TypeScript errors when users write `using shape = new BRepPrimAPI_MakeBox(...)`. The fix is a one-line addition to the TypeScript binding generator that emits the symbol method alongside `delete()`.

## Problem Statement

The opencascade.js WASM module produces thousands of C++ class bindings via Emscripten embind. Each class exposes a `delete()` method for manual C++ memory management. Since Emscripten PR #23818 (merged 2025-03-05), embind also assigns `[Symbol.dispose] = delete` on every class prototype, enabling the TC39 `using` syntax:

```typescript
using box = new oc.BRepPrimAPI_MakeBox_2(20, 20, 20).Shape();
// box is automatically deleted when scope exits
```

At runtime this works — the JavaScript bindings have `Symbol.dispose`. But the TypeScript declarations only emit `delete(): void`, so the compiler reports:

> Property '[Symbol.dispose]' is missing in type 'TopExp_Explorer' but required in type 'Disposable'. (TS2850)

## Background: TC39 Explicit Resource Management

### The Proposal

TC39 Stage 3 proposal ([tc39/proposal-explicit-resource-management](https://github.com/tc39/proposal-explicit-resource-management)) introduces:

| Symbol                | Declaration         | Cleanup timing             |
| --------------------- | ------------------- | -------------------------- |
| `Symbol.dispose`      | `using x = …`       | Synchronous, on scope exit |
| `Symbol.asyncDispose` | `await using x = …` | Async, on scope exit       |

### TypeScript Support

TypeScript 5.2+ supports `using` / `await using`. The types are in `lib.esnext.disposable.d.ts`:

```typescript
interface SymbolConstructor {
  readonly dispose: unique symbol;
  readonly asyncDispose: unique symbol;
}

interface Disposable {
  [Symbol.dispose](): void;
}
```

These are included automatically when `target: ESNext` (via `lib.esnext.d.ts` → `/// <reference lib="esnext.disposable" />`).

### Runtime Support

| Environment | Status                                          |
| ----------- | ----------------------------------------------- |
| Chrome 134+ | Shipped (unflagged)                             |
| Node.js 22+ | Behind `--harmony-explicit-resource-management` |
| Safari      | Not yet supported                               |
| Firefox     | Not yet supported                               |

### Bundler Considerations

Rolldown/esbuild/Vite do not downlevel `using` declarations. For shipped code targeting Safari, `try/finally` with `[Symbol.dispose]()` is the safe pattern. See `docs/policy/resource-cleanup-policy.md` for Tau's policy.

## Finding 1: Emscripten Adds Symbol.dispose at Runtime

In the compiled `opencascade_full.js` (line ~5327), Emscripten's embind runtime adds:

```javascript
const symbolDispose = Symbol.dispose;
if (symbolDispose) {
  proto[symbolDispose] = proto['delete'];
}
```

This runs for every embind class prototype during module initialization. The implementation:

- Aliases `[Symbol.dispose]` to `delete()` (no wrapper function, same reference)
- Guards with `if (symbolDispose)` for environments without `Symbol.dispose`
- Was added in Emscripten PR [#23818](https://github.com/emscripten-core/emscripten/pull/23818) (2025-03-05)

## Finding 2: TypeScript Generator Omits Symbol.dispose

The `.d.ts` generation in `repos/opencascade.js/src/bindings.py` (`TypescriptBindings.processFinalizeClass()`) emits only:

```typescript
/** Releases the C++ object. The caller must ensure no further access. */
delete(): void;
```

It does not emit `[Symbol.dispose](): void`. This is the sole source of the type error.

## Finding 3: ESNext Target Includes Disposable Types

Both the opencascade.js test tsconfig and Tau's Monaco editor use `target: ESNext`. TypeScript's `lib.esnext.d.ts` references `lib.esnext.disposable.d.ts`, which declares `Symbol.dispose` as a `unique symbol` on `SymbolConstructor`. No additional configuration is needed — `[Symbol.dispose](): void` in a `.d.ts` file is valid when the consumer targets ESNext.

## Finding 4: Static Declaration Files Also Need the Method

The static declaration templates at `repos/opencascade.js/src/declarations/builtin-bindings.d.ts` contain three manually-declared classes (`TColStd_IndexedDataMapOfStringString`, `TopoDS`, `OCJS`) that also have `delete(): void` and need matching `[Symbol.dispose](): void`.

## Recommendations

| #   | Action                                                                                         | Priority | Effort | Impact                                                       |
| --- | ---------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------ |
| R1  | Add `[Symbol.dispose](): void` to `TypescriptBindings.processFinalizeClass()` in `bindings.py` | P0       | Low    | All ~4,700 generated classes gain `Disposable` compatibility |
| R2  | Add `[Symbol.dispose](): void` to the three classes in `builtin-bindings.d.ts`                 | P0       | Low    | Covers the hand-authored classes                             |
| R3  | Add type tests for `Symbol.dispose` in `tests/types.test-d.ts`                                 | P1       | Low    | Prevents regression                                          |
| R4  | Regenerate `.d.ts` via `build-wasm.sh dts` and update downstream Tau integration               | P0       | Low    | Fixes the editor error shown in screenshot                   |

## Code Examples

### Generator Change (bindings.py)

```python
def processFinalizeClass(self):
    output = ""
    output += "  /** Releases the C++ object. The caller must ensure no further access. */\n"
    output += "  delete(): void;\n"
    output += "  [Symbol.dispose](): void;\n"
    output += "}\n\n"
    return output
```

### Static Declaration Change (builtin-bindings.d.ts)

```typescript
export declare class TColStd_IndexedDataMapOfStringString {
  constructor();
  /** Release the underlying C++ object to prevent memory leaks. */
  delete(): void;
  [Symbol.dispose](): void;
}
```

### Type Test

```typescript
it('should support Symbol.dispose for using declarations', () => {
  expectTypeOf<gp.Pnt>().toHaveProperty(Symbol.dispose);
  expectTypeOf<TopoDS_NS.Shape>().toHaveProperty(Symbol.dispose);
  expectTypeOf<BRepPrimAPI.MakeBox>().toHaveProperty(Symbol.dispose);
});
```

## References

- [TC39 Explicit Resource Management Proposal](https://github.com/tc39/proposal-explicit-resource-management)
- [TypeScript 5.2 Release Notes — using Declarations](https://typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html)
- [Emscripten PR #23818 — Embind: add explicit resource management support](https://github.com/emscripten-core/emscripten/pull/23818)
- Related: `docs/policy/resource-cleanup-policy.md`

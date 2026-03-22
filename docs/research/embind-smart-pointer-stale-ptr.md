---
title: 'Embind Smart Pointer Stale $$.ptr Root Cause Analysis'
description: 'Root cause investigation of use-after-free crash caused by Embind caching raw pointers from INTRUSIVE smart pointers without refreshing after C++ mutations via Handle& references'
status: active
created: '2026-03-21'
updated: '2026-03-21'
category: investigation
related:
  - docs/research/build-flag-audit.md
---

# Embind Smart Pointer Stale $$.ptr Root Cause Analysis

Investigation into a `table index is out of bounds` WASM crash in wasm-exceptions builds of opencascade.js, traced to Embind's smart pointer caching design.

## Executive Summary

When a C++ method takes `Handle<T>&` (smart pointer by reference) and modifies it, Embind's cached raw pointer (`$$.ptr`) becomes stale — pointing to freed memory. This is a fundamental Embind design gap: it caches `$$.ptr` at object creation and never re-derives it after the underlying smart pointer is mutated by C++ code. The fix belongs in Emscripten's `craftInvokerFunction`, adding a post-call refresh of `$$.ptr` for non-const INTRUSIVE smart pointer arguments using Embind's own `rawGetPointee` machinery.

## Problem Statement

The `gridfinity-box` benchmark crashes with `RuntimeError: table index is out of bounds` exclusively in wasm-exceptions builds of opencascade.js. The crash occurs when calling `Geom2d_Line.FirstParameter()` on an object returned from `Geom2dAPI_InterCurveCurve::Segment()`.

**Symptoms**:

- Crash only in `-fwasm-exceptions` builds; non-exception builds succeed silently
- The crashing object has a different vtable pointer than a freshly created instance of the same type
- The vtable at the stale address contains heap garbage instead of valid function table indices

## Methodology

1. **Stack trace analysis** — instrumented `replicad.kernel.ts` to capture raw WASM `RuntimeError.stack`
2. **Symbol map decoding** — cross-referenced WASM function indices with `.js.symbols` file
3. **Vtable comparison** — dumped WASM linear memory at the failing object's `$$.ptr` and compared with a freshly constructed `Geom2d_Line`
4. **Handle mutation tracing** — intercepted `Segment()` calls in `oc-tracing.ts` proxy to log `$$.ptr`, `$$.smartPtr`, and Handle entity before/after the C++ call
5. **Embind source analysis** — read `libembind.js` (`RegisteredPointer_fromWireType`, `genericPointerToWireType`, `craftInvokerFunction`) and `bind.h` (`smart_ptr_trait`, `_embind_register_smart_ptr`)
6. **Git history review** — traced the introduction of `ocjs_smart_ptr.h` in our opencascade.js fork

## Findings

### Finding 1: Embind's `$$.ptr` is Set Once and Never Re-Derived

When Embind creates a JavaScript handle for a smart pointer type, it calls `smart_ptr_trait::get()` once to extract the raw pointer and caches it in `$$.ptr`. This happens in `RegisteredPointer_fromWireType`:

```javascript
// repos/emscripten/src/lib/libembind.js (line ~1336)
return makeClassHandle(this.registeredClass.instancePrototype, {
  ptrType: this.pointeeType,
  ptr: rawPointer, // <-- cached ONCE, never updated
  smartPtrType: this,
  smartPtr: ptr, // <-- address of Handle on WASM heap
});
```

There is no mechanism in Embind to re-derive `$$.ptr` from `$$.smartPtr` after the initial creation. The `shallowCopyInternalPointer` function also just copies the stale value.

### Finding 2: INTRUSIVE Smart Pointers Pass the Handle Address by Reference

For INTRUSIVE sharing policy (which our `opencascade::handle<T>` uses), `genericPointerToWireType` passes `$$.smartPtr` directly:

```javascript
// repos/emscripten/src/lib/libembind.js (line ~1140)
case 1: // INTRUSIVE
  ptr = handle.$$.smartPtr;
  break;
```

This means C++ receives a reference to the actual Handle object in WASM memory. When C++ modifies the Handle (e.g., `Segment()` reassigns it to a different entity), the modification happens in-place at the `smartPtr` address. But Embind's cached `$$.ptr` is never updated.

### Finding 3: Definitive Proof of Stale Pointer via Handle Mutation Tracing

Instrumented `Segment()` interception in `oc-tracing.ts` produced the following trace:

| Field                   | Before `Segment(1)`      | After `Segment(1)`               |
| ----------------------- | ------------------------ | -------------------------------- |
| `h1.$$.ptr`             | `0xb4d8a8`               | `0xb4d8a8` (STALE)               |
| `h1.$$.smartPtr`        | `0xb4d8d8`               | `0xb4d8d8` (same)                |
| h1 entity (from Handle) | `0xb4d8a8`               | `0xb4d950` (CHANGED)             |
| vtable at `h1.$$.ptr`   | `0x2881f8` (Geom2d_Line) | `0x28837c` (Geom2d_TrimmedCurve) |
| `h2.$$.ptr`             | `0xb4d910`               | `0xb4d910` (STALE)               |
| h2 entity (from Handle) | `0xb4d910`               | `0xb4d8a8` (CHANGED)             |

After `Segment()`:

- The Handle at `h1.$$.smartPtr` now points to entity `0xb4d950` (a new curve from the intersection)
- But `h1.$$.ptr` still points to `0xb4d8a8` (the original `Geom2d_Line`, now freed)
- The freed memory at `0xb4d8a8` was reused for a `Geom2d_TrimmedCurve` (vtable `0x28837c`)
- When `h1.FirstParameter()` is called, Embind uses `$$.ptr = 0xb4d8a8` → reads wrong vtable → `call_indirect` with invalid function index → **crash**

### Finding 4: The Crash Is Build-Dependent Due to Memory Layout Differences

Non-exception builds don't crash because:

1. The freed memory at the stale `$$.ptr` address happens to still contain a valid-enough vtable (different allocation patterns, the memory hasn't been reused yet)
2. The function table indices at those vtable slots happen to be valid in the non-exception build's table layout
3. The method call "succeeds" by calling the wrong function, returning incorrect but non-crashing results

In wasm-exceptions builds, the different function table layout and exception handling code change memory allocation patterns. The freed memory is reused faster, and the wrong vtable entries contain out-of-bounds function indices → hard trap.

### Finding 5: Our Smart Pointer Trait Is Correctly Implemented

The `ocjs_smart_ptr.h` implementation follows Embind's `smart_ptr_trait` interface correctly:

```cpp
// repos/opencascade.js/src/ocjs_smart_ptr.h
template <typename T>
struct smart_ptr_trait<opencascade::handle<T>> {
  static element_type* get(const PointerType& ptr) { return ptr.get(); }
  static sharing_policy get_sharing_policy() { return sharing_policy::INTRUSIVE; }
  static void* share(void* v) {
    return static_cast<void*>(new PointerType(static_cast<element_type*>(v)));
  }
  static PointerType* construct_null() { return new PointerType(); }
};
```

The bug is not in our trait — it's in Embind's invocation machinery not accounting for smart pointer mutation after method calls.

### Finding 6: The Upstream opencascade.js Had No Smart Pointer Support

Git history shows:

- **Original upstream** (donalffons/opencascade.js): No `smart_ptr` registration. Handle types were passed via `allow_raw_pointers()` as raw pointers. No `$$.smartPtr`, no cached `$$.ptr` from smart pointers.
- **Our fork** (commit `96a475c`): Introduced `ocjs_smart_ptr.h` with `smart_ptr_trait<opencascade::handle<T>>`, `.smart_ptr<>()` registration for all `Standard_Transient`-derived classes, and constructors returning `Handle<T>` instead of raw `T*`.

The upstream approach avoided this bug by not using Embind smart pointers at all — but at the cost of no automatic reference counting, which leads to memory leaks and use-after-free from a different direction.

### Finding 7: The Invocation Gap Is in `craftInvokerFunction`

The method call flow in Embind:

```
JS args[i]  →  argTypes[i].toWireType()  →  C++ invoker  →  onDone()
```

In `craftInvokerFunction` (`libembind.js`, line ~680):

```javascript
// Convert args to wire types
for (var i = 0; i < expectedArgCount; ++i) {
  argsWired[i] = argTypes[i + 2].toWireType(destructors, args[i]);
}

// Call C++
var rv = cppInvokerFunc(...invokerFuncArgs);

// Post-call: only destructors and return conversion
// *** NO $$.ptr refresh for smart pointer args ***
```

There is no post-call step to re-derive `$$.ptr` from `$$.smartPtr` for smart pointer arguments that may have been mutated by the C++ function.

### Finding 8: Embind Has All Machinery Needed for the Fix

Each smart pointer's `RegisteredPointer` stores `rawGetPointee` — a WASM function that calls `smart_ptr_trait::get()` to extract the raw entity pointer from the Handle. This is already used at object creation time. The same function can be used post-call to refresh `$$.ptr`:

```javascript
// argType is the RegisteredPointer for the smart pointer parameter
// argType.isSmartPointer === true
// argType.rawGetPointee: (smartPtrAddr) => rawEntityPtr
var newPtr = argType.rawGetPointee(handle.$$.smartPtr);
handle.$$.ptr = newPtr;
```

## Recommendations

| #   | Action                                                                                                    | Priority | Effort | Impact                                                    |
| --- | --------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------------------------- |
| R1  | Patch Emscripten `craftInvokerFunction` to refresh `$$.ptr` after calls with non-const smart pointer args | P0       | Medium | High — fixes all smart pointer types for all Embind users |
| R2  | Remove the Tau-specific `refreshEmbindPtrsFromHandles` workaround in `oc-tracing.ts` once R1 is deployed  | P1       | Low    | Medium — removes fragile user-land patch                  |
| R3  | Submit upstream PR to Emscripten (or at minimum, maintain the patch in our Emscripten fork)               | P1       | Medium | High — benefits the ecosystem                             |

### R1: Emscripten Patch (Recommended Fix)

In `repos/emscripten/src/lib/libembind.js`, modify `craftInvokerFunction` to add a post-call refresh. The change goes in the `DYNAMIC_EXECUTION == 0` path, after the `cppInvokerFunc` call and before `onDone`:

```javascript
var rv = cppInvokerFunc(...invokerFuncArgs);

// After the C++ call, re-derive $$.ptr for non-const INTRUSIVE smart
// pointer arguments that may have been modified via Handle& references.
// Without this, $$.ptr becomes stale → use-after-free.
for (var i = 0; i < expectedArgCount; ++i) {
  var argType = argTypes[i + 2];
  if (argType.isSmartPointer && !argType.isConst && argType.rawGetPointee) {
    var handle = args[i];
    if (handle && handle.$$ && handle.$$.smartPtr) {
      handle.$$.ptr = argType.rawGetPointee(handle.$$.smartPtr);
    }
  }
}
```

**Why this works**:

- `argType.isSmartPointer` is `true` only for parameters registered via `.smart_ptr<>()`
- `argType.isConst` filters out `const Handle<T>&` (which C++ can't modify)
- `argType.rawGetPointee(smartPtr)` calls the C++ `smart_ptr_trait::get()` through WASM — a single pointer dereference, negligibly fast
- For methods without smart pointer args, the loop body is never entered (the `if` check fails immediately)
- If the Handle wasn't modified, `rawGetPointee` returns the same value as `$$.ptr` — the assignment is a harmless no-op

**Performance impact**: One additional property check per argument (`argType.isSmartPointer`). For the rare methods that take non-const smart pointer references, one WASM function call per such argument (`rawGetPointee` = pointer dereference). Negligible overall.

**The same fix must also be applied** to the `DYNAMIC_EXECUTION == 1` / `EMBIND_AOT` code paths in `craftInvokerFunction`, specifically in the `createJsInvoker` factory and `InvokerFunctions` templates.

## Trade-offs

| Approach                      | Correctness                            | Scope                | Effort | Fragility                            |
| ----------------------------- | -------------------------------------- | -------------------- | ------ | ------------------------------------ |
| **R1: Emscripten patch**      | Fixes all smart pointers at the source | All Embind users     | Medium | Low — uses Embind's own machinery    |
| **User-land proxy (current)** | Fixes only `Segment()` in Tau          | Tau only             | Done   | High — targets specific method names |
| **opencascade.js JS wrapper** | Could wrap all methods                 | opencascade.js users | Medium | Medium — monkey-patches prototypes   |
| **Binding codegen wrappers**  | Generates lambdas for Handle& params   | opencascade.js users | High   | Medium — complex codegen             |

The Emscripten patch (R1) is the clear winner: it's correct for all smart pointer types, uses existing Embind machinery, has negligible performance cost, and benefits the entire ecosystem.

## Code Examples

### The Trigger Pattern (replicad `intersections.ts`)

```typescript
const h1 = new oc.Geom2d_Line(ax1); // $$.ptr = entity A
intersector.Segment(i, h1, h2); // Handle now → entity B, $$.ptr still = A (STALE)
yield new Curve2D(h1); // h1.FirstParameter() uses stale ptr → CRASH
```

### Current Tau Workaround (`oc-tracing.ts`)

```typescript
function refreshEmbindPtrsFromHandles(args: unknown[]): void {
  const heap = __wasmHeapU32;
  if (!heap) return;
  for (const arg of args) {
    const emb = (arg as Record<string, unknown> | null)?.['$$'] as Record<string, unknown> | undefined;
    if (!emb?.['smartPtr']) continue;
    const smartPtr = emb['smartPtr'] as number;
    const newEntity = heap[smartPtr >> 2]!;
    if (newEntity && newEntity !== emb['ptr']) {
      emb['ptr'] = newEntity;
    }
  }
}
```

This reads the Handle's entity pointer directly from WASM memory. It works but is fragile: assumes `Handle<T>` layout is `{ T* entity; }` (first 4 bytes), requires access to `WebAssembly.Memory`, and must be manually hooked into every intercepted method.

### Proposed Emscripten Fix (R1)

The fix uses `rawGetPointee` — Embind's own C++ function for extracting the pointee from a smart pointer — eliminating assumptions about memory layout:

```javascript
// In craftInvokerFunction, after cppInvokerFunc(...) returns:
for (var i = 0; i < expectedArgCount; ++i) {
  var argType = argTypes[i + 2];
  if (argType.isSmartPointer && !argType.isConst && argType.rawGetPointee) {
    var handle = args[i];
    if (handle && handle.$$ && handle.$$.smartPtr) {
      handle.$$.ptr = argType.rawGetPointee(handle.$$.smartPtr);
    }
  }
}
```

## Diagrams

### Data Flow: Normal vs. Stale Pointer

```
NORMAL (object creation):
  JS: new oc.Geom2d_Line(ax)
    → C++: new handle<Geom2d_Line>(new Geom2d_Line(ax))
    → Embind: $$.smartPtr = &handle, $$.ptr = handle.get()  ← CONSISTENT

STALE (after Segment modifies Handle&):
  JS: intersector.Segment(i, h1, h2)
    → C++: self.Segment(i, *smartPtr_h1, *smartPtr_h2)   ← modifies handles in-place
    → C++: *smartPtr_h1 = new_curve                       ← old entity freed
    → JS: h1.$$.smartPtr → new entity                     ← handle updated
    → JS: h1.$$.ptr → old entity (freed!)                 ← STALE, never refreshed

FIX (post-call refresh):
  JS: after cppInvokerFunc(...)
    → JS: h1.$$.ptr = rawGetPointee(h1.$$.smartPtr)       ← re-derive from handle
    → JS: h1.$$.ptr → new entity                          ← CONSISTENT
```

## References

- Embind source: `repos/emscripten/src/lib/libembind.js` (lines 660–815: `craftInvokerFunction`, 1090–1164: `genericPointerToWireType`, 1302–1380: `RegisteredPointer_fromWireType`)
- Embind C++ headers: `repos/emscripten/system/include/emscripten/bind.h` (smart_ptr_trait, \_embind_register_smart_ptr)
- Our smart pointer trait: `repos/opencascade.js/src/ocjs_smart_ptr.h`
- Trigger code: `repos/replicad/packages/replicad/src/lib2d/intersections.ts` (`commonSegmentsIteration`)
- Current workaround: `packages/runtime/src/kernels/replicad/oc-tracing.ts` (`refreshEmbindPtrsFromHandles`)

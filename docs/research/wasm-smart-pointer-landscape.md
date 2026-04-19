---
title: 'WASM Smart Pointer Binding Landscape'
description: 'Survey of how major WASM/C++ projects handle smart pointers, output parameters, and object lifetime across the Embind/JS/C++ stack as of March 2026'
status: active
created: '2026-03-18'
updated: '2026-03-18'
category: comparison
related:
  - docs/research/embind-smart-pointer-stale-ptr.md
  - docs/research/ocjs-wasm-optimization.md
---

# WASM Smart Pointer Binding Landscape

Survey of how production WASM/C++ projects handle smart pointers, output-by-reference parameters, and object lifetime across Emscripten's Embind, WebIDL, and alternative binding stacks — with a focus on identifying best practices and idiomatic patterns that make for strong JavaScript developer experience.

## Executive Summary

Smart pointer management across the WASM/JS boundary is a largely unsolved problem in the Emscripten ecosystem. Embind's `smart_ptr_trait` mechanism provides the plumbing for custom smart pointers but caches raw pointers aggressively, creating stale-pointer bugs when C++ mutates smart pointers passed by reference. No major open-source project has solved this comprehensively. The dominant patterns fall into three tiers: (1) avoid smart pointers entirely and require manual `.delete()` (OpenCV.js, ammo.js), (2) register smart pointers but avoid output-by-reference patterns (CanvasKit, VTK prototype), or (3) generate `optional_override` lambda wrappers that transform output parameters into return values (our proposed approach for opencascade.js). SWIG's `argout` typemap and nanobind's intrusive counter represent the most mature cross-language solutions, but neither targets Emscripten. The idiomatic JavaScript pattern — return values over mutation — is universally preferred but requires binding-layer transformation for large C++ libraries with pervasive output-parameter APIs.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Binding Stack Overview](#binding-stack-overview)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

When compiling large C++ libraries (CAD kernels, physics engines, rendering frameworks) to WebAssembly via Emscripten, the binding layer must translate between C++ memory semantics (RAII, smart pointers, output-by-reference parameters) and JavaScript's garbage-collected, pass-by-value world. Three fundamental tensions arise:

1. **Lifetime mismatch**: C++ objects on the WASM heap outlive JS references unless explicitly freed.
2. **Pointer caching**: Embind caches `$$.ptr` (the raw C++ pointer) at JS object creation time and never re-derives it, causing stale pointers when C++ mutates smart pointer references.
3. **Output parameter idiom gap**: C++ uses `void foo(Handle<T>& out)` for output parameters; JavaScript has no equivalent — output must be expressed as return values.

This research surveys how production projects handle these tensions, identifies where solutions exist and where gaps remain, and recommends idiomatic patterns.

## Methodology

1. **Web survey** — searched GitHub issues, Emscripten documentation, project binding files, and technical articles for smart pointer handling patterns across 10+ WASM projects.
2. **Source analysis** — reviewed binding source code for CanvasKit (Skia), Filament, ammo.js (Bullet), OpenCV.js, box2d-wasm, opencascade.js, and the VTK-Embind prototype.
3. **Binding framework comparison** — analyzed Embind, WebIDL Binder, wasm-bindgen (Rust), SWIG, pybind11, nanobind, and cppyy for their approaches to smart pointers and output parameters.
4. **Issue tracker archaeology** — reviewed Emscripten issues #4583, #17765, #19200, #22575, #13338, and PRs #21022, #21692, #21935, #24053 for official stance and known limitations.

## Binding Stack Overview

Before diving into individual projects, it helps to understand the available binding mechanisms and their smart pointer support.

| Binding Stack     | Language Pair       | Smart Ptr Support                               | Output Param Support                                | Used By                                            |
| ----------------- | ------------------- | ----------------------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| **Embind**        | C++ → JS            | `smart_ptr_trait`, `shared_ptr` native          | None (manual wrappers)                              | CanvasKit, Filament, opencascade.js, VTK prototype |
| **WebIDL Binder** | C++ → JS            | None                                            | None                                                | ammo.js (Bullet), Box2D                            |
| **wasm-bindgen**  | Rust → JS           | Heap-based JS refs, `clone()` for `Arc/Rc`      | Return values (Rust idiom)                          | web-sys, wgpu                                      |
| **SWIG**          | C++ → Python/JS/... | `shared_ptr` directive, custom holders          | `argout` typemap                                    | Scientific Python                                  |
| **pybind11**      | C++ → Python        | `shared_ptr`, `unique_ptr`, custom holders      | Return value policies                               | Most Python/C++ projects                           |
| **nanobind**      | C++ → Python        | `intrusive_counter`, `shared_ptr`, `unique_ptr` | Return value policies, intrusive ownership transfer | Next-gen Python/C++                                |
| **cppyy**         | C++ → Python        | Transparent smart pointer proxying              | Automatic by-ref detection                          | ROOT (CERN)                                        |

## Findings

### Finding 1: Embind's `$$.ptr` Caching Is a Known, Unfixed Upstream Bug

Embind caches the raw pointer (`$$.ptr`) extracted from a smart pointer at JS object creation time in `RegisteredPointer_fromWireType`. It never re-derives this pointer after a C++ function call, even when the function takes a non-const smart pointer reference that it may modify.

**Evidence**: Emscripten issue #4583 (filed 2016, closed as stale 2019 with `wontfix` label) demonstrates the exact bug — after resetting a `shared_ptr`, member functions dereference the old, freed pointer while non-member functions work correctly. The reporter's test case proves `$$.smartPtrType.rawGetPointee($$.smartPtr)` returns a different address than `$$.ptr` after reset.

Issue #17765 (filed 2022, still open) reports the same root cause from a different angle: `RegisteredPointer` does not use `$$.smartPtr` for dereferencing on each access. Brendan Dahl (Emscripten maintainer) acknowledged: "I don't think the original author of this code is still active in the project" and noted a per-access dereference "would add another call into wasm which could be slower."

**Status**: Neither issue has been resolved. The Emscripten team has not committed to fixing this behavior.

### Finding 2: Most Production Projects Avoid Smart Pointers Entirely

The majority of production WASM/C++ projects avoid Embind smart pointers and rely on manual `.delete()` calls:

| Project                       | Binding | Smart Ptr Usage                               | Memory Pattern                                         |
| ----------------------------- | ------- | --------------------------------------------- | ------------------------------------------------------ |
| **OpenCV.js**                 | Embind  | None                                          | Manual `mat.delete()` on all `Mat` objects             |
| **ammo.js** (Bullet)          | WebIDL  | None (WebIDL lacks support)                   | Manual `Ammo.destroy(obj)`                             |
| **box2d-wasm**                | WebIDL  | None                                          | `LeakMitigator` utility for cleanup                    |
| **CanvasKit** (Skia)          | Embind  | `sk_sp<T>` used internally, not exposed to JS | `uintptr_t` casts for pointers; JS gets opaque handles |
| **Filament**                  | Embind  | Not exposed                                   | JS wrappers manage lifetime                            |
| **opencascade.js** (upstream) | Embind  | None (pre-fork)                               | `allow_raw_pointers()` everywhere                      |

**Key insight**: No major production WASM project successfully uses Embind's `smart_ptr_trait` with mutable references in a way that would trigger the stale-pointer bug. Projects either avoid smart pointers or use them only for return values and const references where the caching problem doesn't manifest.

### Finding 3: CanvasKit's Facade Pattern Sidesteps the Problem

Google's CanvasKit (Skia compiled to WASM) takes the most sophisticated approach: it creates a C++ facade layer that transforms the entire API before exposing it to Embind. Key patterns:

- **`uintptr_t` pointer casts**: Raw pointers are cast to `uintptr_t` and passed as plain numbers. CanvasKit's `WasmCommon.h` defines `WASMPointerF32`, `WASMPointerI32`, etc., as `uintptr_t` aliases. This completely sidesteps Embind's pointer registration machinery.

- **`emscripten::val` for complex returns**: Functions that would use output parameters in C++ return `emscripten::val` (a JS object proxy) instead.

- **`sk_sp<T>` stays internal**: While Skia uses `sk_sp<T>` (an intrusive smart pointer nearly identical to OCCT's `Handle<T>`) throughout its codebase, the Embind bindings never register `sk_sp` as a smart pointer. All `sk_sp` objects are unwrapped before crossing the boundary.

- **`JSSpan<T>` for array data**: A custom RAII wrapper that bridges JS TypedArrays to C++ spans, handling memory ownership explicitly.

**Implication**: Even Google, with full control over both the C++ library and the binding layer, chose to build a facade rather than rely on Embind's smart pointer support.

### Finding 4: VTK's Prototype Validates the Intrusive Smart Pointer Approach

The `vtksmartptr-embind-prototype` by Jaswant Panchumarti (Kitware) is the only known attempt to use Embind's `smart_ptr_trait` with an intrusive reference-counted smart pointer (`vtkSmartPointer<T>`, functionally identical to OCCT's `Handle<T>`). The prototype demonstrates that automatic reference counting across the JS/C++ boundary is achievable for object creation and return values.

However, the prototype does not address the `$$.ptr` caching bug — it avoids mutable smart pointer references entirely. The documented "stack unwind" problem (objects destroyed when C++ `main()` exits) is a separate lifetime issue specific to VTK's event loop architecture.

### Finding 5: nanobind's Intrusive Counter Is the Gold Standard for Cross-Language Smart Pointers

nanobind (successor to pybind11) provides the most complete solution for intrusive smart pointers across language boundaries:

- **Single counter**: Instead of maintaining separate Python and C++ reference counts, nanobind packs either a reference counter or a `PyObject*` pointer into a single `sizeof(void*)` field.
- **Ownership transfer**: When a C++ object is first exposed to Python, lifetime management switches to Python's reference counting via `set_self_py()`.
- **No stale pointers**: Because the object itself carries the reference count (not a separate control block), there's no cached pointer that can go stale.
- **`intrusive_base`**: A base class that provides `inc_ref()`, `dec_ref()`, and `set_self_py()` — conceptually identical to OCCT's `Standard_Transient`.

**Limitation**: nanobind targets Python (CPython specifically), not JavaScript. Its design cannot be directly applied to Embind, but the architectural principles — single counter, ownership transfer, no separate pointer cache — are the correct model.

### Finding 6: SWIG's `argout` Typemap Is the Best Model for Output Parameter Transformation

SWIG solves the output-parameter problem through its typemap system, specifically the `argout` typemap:

```
%typemap(in,numinputs=0) Handle<Geom2d_Curve>& out (Handle<Geom2d_Curve> temp) {
    $1 = &temp;  // Point the C++ argument at a local variable
}
%typemap(argout) Handle<Geom2d_Curve>& out {
    $result = SWIG_Python_AppendOutput($result, SWIG_NewPointerObj(...));
}
```

This approach:

1. **Suppresses the output parameter from the target language signature** (`numinputs=0`)
2. **Creates a local C++ variable** to receive the output
3. **Appends the result** to the function's return value after the C++ call

**Direct parallel to our proposed approach**: Our `optional_override` lambda wrappers in `bindings.py` implement the same pattern — create local `Handle<T>` variables, call the original C++ method, return the locals as a struct. SWIG does this via declarative typemaps; we do it via procedural AST-driven code generation.

### Finding 7: Embind's Recent Return Value Policy Support (2024) Does Not Address Smart Pointer Mutation

Emscripten merged return value policies for functions (PR #21692, May 2024) and properties (PR #21935, June 2024), adding `take_ownership` and `reference` policies. These control object lifetime when returning to JavaScript but do not address:

- Post-call `$$.ptr` refresh for mutated smart pointer arguments
- Output parameter transformation to return values
- The stale-pointer bug with `INTRUSIVE` sharing policy

The AOT (Ahead-of-Time) JS generation improvements (PR #21168) also focus on invoker signature matching, not smart pointer refresh.

**Assessment**: Emscripten's evolution is oriented toward return value lifetime semantics (influenced by pybind11's `return_value_policy`), not toward fixing the fundamental `$$.ptr` caching gap for mutable arguments.

### Finding 8: wasm-bindgen (Rust) Eliminates the Problem by Design

Rust's wasm-bindgen avoids the entire class of problems by design:

- **No mutable aliasing**: Rust's ownership model prevents two references from mutating the same data.
- **Heap-based JS references**: JS objects are stored in a module-local heap; WASM code receives indices, not raw pointers.
- **`clone()` is cheap**: For types like `HtmlElement`, `clone()` creates another wrapper to the same underlying JS object without deep copying.
- **No cached pointers**: There's no `$$.ptr` equivalent — every access goes through the heap index.

**Implication**: The stale-pointer class of bugs is structurally impossible in wasm-bindgen. This validates our conclusion that the fix must happen at the binding layer (transforming the API), not by trying to make Embind's caching correct for all mutation patterns.

### Finding 9: The `{ current: value }` Wrapper Pattern Is Used But Non-Idiomatic

Emscripten issue #13338 documents two patterns for handling primitive output parameters:

**Pattern A: Wrapper struct**

```cpp
struct intRef { int current; };
function("increment", [](intRef& r) { increment(r.current); });
```

**Pattern B: `emscripten::val`**

```cpp
function("increment", [](emscripten::val c) {
    auto i = c["current"].as<int>();
    increment(i);
    c.set("current", i);
});
```

Both require the JavaScript caller to create a wrapper object (`{ current: 0 }`), which is non-idiomatic and error-prone. For smart pointer output parameters specifically, neither pattern avoids the stale `$$.ptr` problem — they just move it to a different wrapper object.

**Our approach** (returning the outputs as new objects) is superior because:

- The caller receives fresh, correctly-initialized smart pointer wrappers
- No wrapper objects need to be pre-created
- The JavaScript API becomes `const [h1, h2] = intersector.Segment(i)` instead of requiring pre-allocated handles

### Finding 10: FinalizationRegistry Is a Safety Net, Not a Solution

Emscripten added `FinalizationRegistry` integration (PR #8474, updated PR #15327) to automatically invoke C++ destructors when JS wrappers are garbage collected. However:

- The spec provides **zero guarantees** about callback timing — callbacks may never fire.
- Emscripten uses it primarily for **leak detection in ASSERTIONS mode**, not as the primary cleanup mechanism.
- It addresses the "forgot to call `.delete()`" problem, not the stale-pointer problem.

All surveyed projects still require manual `.delete()` for deterministic cleanup. `FinalizationRegistry` is best understood as defense-in-depth, not a replacement for explicit lifetime management.

## Recommendations

| #   | Action                                                                                                                                                 | Priority | Effort | Impact                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------------------------------------------------ |
| R1  | Generate `optional_override` wrappers for `Handle<T>&` output params at the binding codegen level, transforming output params into typed return values | P0       | Medium | High — eliminates stale pointers by construction |
| R2  | Register return structs as `value_array` for multi-output methods to provide idiomatic JS destructuring (`const [a, b] = ...`)                         | P0       | Low    | High — best JavaScript DX                        |
| R3  | Patch Embind's `craftInvokerFunction` to refresh `$$.ptr` after calls with non-const smart pointer args as defense-in-depth                            | P1       | Medium | Medium — catches edge cases the codegen misses   |
| R4  | Document the stale-pointer limitation in our fork's README and consider an upstream Emscripten PR                                                      | P2       | Low    | Medium — benefits ecosystem                      |

### Recommended Architecture

Based on this landscape survey, the recommended architecture for handling smart pointer output parameters in auto-generated Embind bindings is:

1. **AST detection**: Identify non-const `handle<T>&` parameters using the binding generator's existing type resolution.
2. **Lambda wrapper generation**: Generate `optional_override` lambdas that declare local handles, call the original C++ method, and return results via `value_array`-registered structs.
3. **TypeScript signature adjustment**: Strip output parameters and change return types to match the wrapper's return type.
4. **No runtime JS fixup**: The stale-pointer problem is eliminated at the source — new JS objects with correct `$$.ptr` values are created for each output.

This approach aligns with the idiomatic patterns of every surveyed binding framework (SWIG's `argout`, nanobind's return value policies, wasm-bindgen's return-by-value) and produces the best JavaScript developer experience.

## Trade-offs

| Approach                                   | Projects Using It                           | DX Quality          | Stale Ptr Safe        | Perf Overhead | Maintenance     |
| ------------------------------------------ | ------------------------------------------- | ------------------- | --------------------- | ------------- | --------------- |
| **No smart pointers + manual delete**      | OpenCV.js, ammo.js, upstream opencascade.js | Poor                | N/A (different bugs)  | None          | Low             |
| **Facade layer with uintptr_t**            | CanvasKit                                   | Good (hand-crafted) | Yes                   | None          | High (manual)   |
| **Register smart ptr, avoid mutable refs** | VTK prototype                               | Moderate            | Partial               | None          | Low             |
| **Runtime $$.ptr refresh (proxy)**         | Tau workaround                              | Poor (fragile)      | Yes (targeted)        | Low           | High            |
| **Embind craftInvokerFunction patch**      | None (proposed)                             | Transparent         | Yes (universal)       | Negligible    | Medium          |
| **Codegen optional_override wrappers**     | None yet (our proposed approach)            | Excellent           | Yes (by construction) | Minimal       | Low (automated) |

The codegen approach is unique in being both fully automated (no manual facade) and architecturally correct (new objects, no stale pointers). No surveyed project has implemented this at scale.

## Code Examples

### Pattern 1: Manual Delete (OpenCV.js)

```javascript
const src = new cv.Mat(height, width, cv.CV_8UC4);
const gray = new cv.Mat();
cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
// Must manually delete ALL intermediate objects
gray.delete();
src.delete();
```

**DX assessment**: Error-prone; forgetting any `.delete()` leaks WASM memory permanently.

### Pattern 2: uintptr_t Facade (CanvasKit)

```cpp
// C++ binding side
using WASMPointerF32 = uintptr_t;
class_<SkCanvas>("Canvas")
    .function("drawRect", optional_override([](SkCanvas& self,
                                               WASMPointerF32 fPtr) {
        const SkRect* rect = reinterpret_cast<const SkRect*>(fPtr);
        self.drawRect(*rect, SkPaint());
    }));
```

```javascript
// JS side — caller manages typed array memory
const rectPtr = CanvasKit.Malloc(Float32Array, 4);
rectPtr[0] = 0;
rectPtr[1] = 0;
rectPtr[2] = 100;
rectPtr[3] = 100;
canvas.drawRect(rectPtr);
CanvasKit.Free(rectPtr);
```

**DX assessment**: Requires understanding WASM memory layout; suitable for performance-critical hot paths.

### Pattern 3: Codegen optional_override Wrapper (Our Proposed Approach)

```cpp
// Generated by bindings.py for Geom2dAPI_InterCurveCurve::Segment
.function("Segment", optional_override([](
    const Geom2dAPI_InterCurveCurve& self,
    int Index) -> HandleOutput2<Geom2d_Curve> {
  opencascade::handle<Geom2d_Curve> Curve1, Curve2;
  self.Segment(Index, Curve1, Curve2);
  return HandleOutput2<Geom2d_Curve>{Curve1, Curve2};
}))
```

```typescript
// JS side — idiomatic destructuring
const [h1, h2] = intersector.Segment(i);
const param = h1.FirstParameter(); // $$.ptr is always correct
h2.delete();
```

**DX assessment**: Idiomatic JavaScript; no pre-allocation; no stale pointers; fully automated.

### Pattern 4: SWIG argout Typemap (Python Comparison)

```swig
%typemap(in,numinputs=0) Handle_Geom2d_Curve& (Handle_Geom2d_Curve temp) {
    $1 = &temp;
}
%typemap(argout) Handle_Geom2d_Curve& {
    %append_output(SWIG_NewPointerObj(new Handle_Geom2d_Curve(*$1), ...));
}
```

```python
h1, h2 = intersector.Segment(i)  # Output params become return tuple
```

**DX assessment**: Excellent Python DX; declarative typemaps are maintainable; our codegen approach achieves the same result for Embind.

## Diagrams

### Binding Layer Landscape

```
                    C++ Library (OCCT, Skia, Bullet, OpenCV)
                              │
            ┌─────────────────┼─────────────────────┐
            │                 │                      │
       ┌────▼────┐     ┌─────▼──────┐      ┌───────▼────────┐
       │  Embind  │     │  WebIDL    │      │ Custom Facade  │
       │          │     │  Binder    │      │ (uintptr_t)    │
       └────┬─────┘     └─────┬──────┘      └───────┬────────┘
            │                 │                      │
   ┌────────┼────────┐       │              ┌───────┴────────┐
   │        │        │       │              │                │
 smart_  raw ptr   val     raw ptr        num cast       val/array
 ptr_    allow_*   return   only          only           return
 trait                                    (CanvasKit)
   │
   ├─ $$.ptr cached ONCE (BUG)
   ├─ no post-call refresh
   └─ no output param support
```

### Solution Comparison: Where Each Fix Operates

```
JS caller  ──►  Embind invoker  ──►  C++ method  ──►  Return to JS
                     │                    │                  │
                     │              ┌─────┴─────┐           │
                     │              │ Mutates    │           │
                     │              │ Handle&    │           │
                     │              │ args       │           │
                     │              └─────┬─────┘           │
                     │                    │                  │
  Fix Layer:         │                    │                  │
                     │                    │                  │
  ┌──────────────────┼────────────────────┼──────────────────┤
  │                  │                    │                  │
  │ R3: Patch        │ R1: Codegen        │                  │
  │ craftInvoker     │ optional_override  │                  │
  │ (post-call       │ (eliminate output  │                  │
  │  $$.ptr refresh) │  params entirely)  │                  │
  │                  │                    │                  │
  │ WHERE: embind.js │ WHERE: bindings.py │                  │
  │ WHEN: after call │ WHEN: build time   │                  │
  │ HOW: rawGet      │ HOW: local vars +  │                  │
  │   Pointee()      │   value_array ret  │                  │
  └──────────────────┴────────────────────┴──────────────────┘
```

## References

- Emscripten issue #4583: [Embind smart pointer is incorrect after resetting](https://github.com/emscripten-core/emscripten/issues/4583) (2016, wontfix)
- Emscripten issue #17765: [RegisteredPointer doesn't dereference via $$.smartPtr](https://github.com/emscripten-core/emscripten/issues/17765) (2022, open)
- Emscripten issue #19200: [No way to implement shared_ptr factory in JS without leak](https://github.com/emscripten-core/emscripten/issues/19200)
- Emscripten issue #22575: [Leaked C++ object when calling from C++ to JS](https://github.com/emscripten-core/emscripten/issues/22575)
- Emscripten issue #13338: [References to C++ built-in datatypes with Embind](https://github.com/emscripten-core/emscripten/issues/13338)
- Emscripten PR #21692: [Return value policy for function bindings](https://github.com/emscripten-core/emscripten/pull/21692)
- Emscripten PR #21935: [Return value policy for properties](https://github.com/emscripten-core/emscripten/pull/21935)
- Emscripten PR #24053: [Fix misindexed template parameters for policies](https://github.com/emscripten-core/emscripten/pull/24053)
- nanobind ownership docs: [Intrusive reference counting](https://nanobind.readthedocs.io/en/latest/ownership_adv.html)
- SWIG typemaps: [argout typemap documentation](https://www.swig.org/Doc4.2/Typemaps.html)
- CanvasKit bindings: [canvaskit_bindings.cpp](https://github.com/google/skia/blob/main/modules/canvaskit/canvaskit_bindings.cpp)
- VTK prototype: [vtksmartptr-embind-prototype](https://github.com/jspanchu/vtksmartptr-embind-prototype)
- opencascade.js Embind migration: [PR #8](https://github.com/donalffons/opencascade.js/pull/8)
- Kitware VTK WASM: [Surviving the Stack Unwind](https://www.kitware.com/surviving-the-stack-unwind-a-vtk-wasm-story/)
- Related: `docs/research/embind-smart-pointer-stale-ptr.md`
- Related: `docs/research/ocjs-wasm-optimization.md`

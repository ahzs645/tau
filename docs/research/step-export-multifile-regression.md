---
title: 'STEP Export Multi-File Mode Regression'
description: 'Root cause investigation of empty STEP geometry caused by null-to-empty-string parameter change triggering multi-file export mode'
status: active
created: '2026-04-10'
updated: '2026-04-10'
category: investigation
related:
  - docs/research/brep-edge-mesh-regression.md
---

# STEP Export Multi-File Mode Regression

Investigation into the replicad STEP export pipeline producing files with no geometry after the OCCT V8 suffix-free overload migration.

## Executive Summary

STEP exports from the replicad kernel contained only XCAF metadata (product structure, document references) but zero geometry entities. The root cause was a `null` → `""` parameter change in the `STEPCAFControl_Writer.Transfer` call's third argument (`theIsMulti`). In OCCT, a non-null `theIsMulti` pointer — even an empty string — activates multi-file export mode, which writes geometry to external `.stp` files that are discarded in the WASM filesystem. The fix replaces `Transfer` + `Write` with `Perform`, which internally calls `Transfer` with `nullptr` (single-file mode).

## Problem Statement

Exporting a replicad model to STEP produced a syntactically valid but geometrically empty file. The exported file contained only 45 STEP entities: product metadata, document references, and an empty `SHAPE_REPRESENTATION` with a single origin `AXIS2_PLACEMENT_3D`. No `CLOSED_SHELL`, `ADVANCED_BREP_SHAPE_REPRESENTATION`, `B_SPLINE_CURVE`, or any geometry entities were present.

All other export formats (GLB, GLTF, STL) worked correctly — the issue was specific to the XCAF-based STEP assembly export pipeline.

## Methodology

1. Examined the exported STEP file to identify what was present vs missing
2. Traced git history in `repos/replicad/` for changes to `assemblyExporter.ts`
3. Compared old (suffix-based) and new (suffix-free) API calls
4. Analyzed OCCT `STEPCAFControl_Writer::Transfer` source code for parameter semantics
5. Examined the generated C++ embind binding for `Transfer` to understand CString wrapping
6. Validated the fix with geometry-content assertions in the test suite

## Findings

### Finding 1: The `theIsMulti` Parameter Semantics

OCCT's `STEPCAFControl_Writer::Transfer` signature:

```cpp
Standard_Boolean Transfer(
    const Handle(TDocStd_Document)& theDoc,
    STEPControl_StepModelType theMode,
    const Standard_CString theIsMulti,  // const char*
    const Message_ProgressRange& theProgress
);
```

The `theIsMulti` parameter controls single-file vs multi-file export mode using **pointer truthiness**, not string content:

| Value               | `!theIsMulti` | Mode        | Behavior                                  |
| ------------------- | ------------- | ----------- | ----------------------------------------- |
| `nullptr`           | `true`        | Single-file | All geometry written to main STEP file    |
| `""` (empty string) | `false`       | Multi-file  | Geometry written to external `.stp` files |
| `"prefix"`          | `false`       | Multi-file  | External files prefixed with string       |

In multi-file mode (lines 714–727 of `STEPCAFControl_Writer.cxx`), `transferExternFiles()` creates separate STEP files for each non-assembly part. The main file receives only the assembly structure — no geometry. Colors, layers, materials, and SHUO data are also skipped for the main model (lines 738–779 are gated by `!theIsMulti`).

### Finding 2: The Suffix-Free Migration Changed `null` to `""`

In the OCCT V8 suffix-free migration (commit `12bd9cf` → `4c9541c`):

**Before** (working, suffix-based):

```typescript
writer.Transfer_1(
  new oc.Handle_TDocStd_Document_2(doc.wrapped),
  oc.STEPControl_StepModelType.STEPControl_AsIs,
  null, // ← null pointer → single-file mode
  progress,
);
```

**After** (broken, suffix-free):

```typescript
writer.Transfer(
  doc.wrapped,
  oc.STEPControl_StepModelType.STEPControl_AsIs,
  '', // ← empty string (NON-null) → multi-file mode
  progress,
);
```

The change from `null` to `""` was made because the binding's CString wrapper (`std::string` + `strdup`) does not support null pointer passthrough.

### Finding 3: The CString Binding Cannot Express Null

The generated C++ binding wraps `const char*` parameters in `std::string`:

```cpp
std::function<bool(STEPCAFControl_Writer&,
    const occ::handle<TDocStd_Document>&,
    const STEPControl_StepModelType,
    std::string,                          // ← always non-null
    const Message_ProgressRange&)>(
    [](... std::string theIsMulti ...) {
        auto ret = that.Transfer(theDoc, theMode,
            strdup(theIsMulti.c_str()),   // ← strdup("") returns non-null
            theProgress);
        return ret;
    }
)
```

`strdup("")` allocates a non-null pointer to a null-terminated empty string. There is no way to pass `nullptr` through this binding path for the `theIsMulti` parameter.

### Finding 4: `Perform` Bypasses the Issue

`STEPCAFControl_Writer::Perform` combines `Transfer` + `Write` and always uses `nullptr` for `theIsMulti`:

```cpp
bool STEPCAFControl_Writer::Perform(
    const Handle(TDocStd_Document)& theDoc,
    const char* const theFileName,
    const Message_ProgressRange& theProgress)
{
    if (!Transfer(theDoc, STEPControl_AsIs, nullptr, theProgress))
        return false;
    return Write(theFileName) == IFSelect_RetDone;
}
```

This eliminates the null/empty-string ambiguity entirely. `Perform` is already bound in the WASM module and available in the `.d.ts`.

## Recommendations

| #   | Action                                                                  | Priority | Effort | Impact |
| --- | ----------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Replace `Transfer`+`Write` with `Perform` in `assemblyExporter.ts`      | P0       | Low    | High   |
| R2  | Add STEP geometry-content tests (not just byte-count checks)            | P0       | Low    | High   |
| R3  | Fix CString binding to support null passthrough for sentinel parameters | P2       | Medium | Medium |

### R1: Use `Perform` (implemented)

The fix replaces the two-step `Transfer` + `Write` with a single `Perform` call:

```typescript
const filename = 'export.step';
const progress = r(new oc.Message_ProgressRange());
const success = writer.Perform(doc.wrapped, filename, progress);

if (success) {
  const file = oc.FS.readFile('/' + filename);
  oc.FS.unlink('/' + filename);
  return new Blob([file as BlobPart], { type: 'application/STEP' });
} else {
  throw new Error('WRITE STEP FILE FAILED.');
}
```

All writer configuration (`SetColorMode`, `SetNameMode`, `Interface_Static` settings) is preserved — these are set on the writer instance before `Perform` and remain active.

### R2: Geometry Content Tests (implemented)

Tests now validate that exported STEP files contain actual geometry entities:

```typescript
const stepContent = new TextDecoder().decode(exportResult.data[0]!.bytes);
expect(stepContent).toContain('CLOSED_SHELL');
expect(stepContent).toContain('ADVANCED_BREP_SHAPE_REPRESENTATION');
```

The assembly test additionally validates that per-shape names appear in the output.

### R3: CString Null Passthrough (deferred)

The bindings generator (`bindings.py`) wraps `const char*` parameters in `std::string` for CString conversion. A future improvement could detect sentinel `const char*` parameters (where null has semantic meaning) and generate an `emscripten::val`-based wrapper that checks for `null`/`undefined` and passes `nullptr`:

```cpp
auto isMulti = arg.isNull() || arg.isUndefined()
    ? nullptr
    : strdup(arg.as<std::string>().c_str());
```

This is deferred because `Perform` fully resolves the immediate issue and no other CString-sentinel parameters are known to be affected.

## Diagrams

```
Single-file mode (nullptr):           Multi-file mode (""):

  Transfer(doc, AsIs, nullptr, ...)    Transfer(doc, AsIs, "", ...)
       │                                    │
       ▼                                    ▼
  ┌──────────────────┐              ┌──────────────────┐
  │ per-label loop:  │              │ per-label loop:  │
  │ writer.Transfer  │              │ transferExtern   │──→ part1.stp (discarded)
  │   (shape, AsIs)  │              │   Files(...)     │──→ part2.stp (discarded)
  └────────┬─────────┘              └────────┬─────────┘
           │                                 │
  ┌────────▼─────────┐              ┌────────▼─────────┐
  │ Write colors,    │              │ SKIPPED:         │
  │ layers, names,   │              │ !theIsMulti is   │
  │ materials, SHUO  │              │ false → no color │
  └────────┬─────────┘              │ /layer/material  │
           │                        └────────┬─────────┘
  ┌────────▼─────────┐                       │
  │ Write(filename)  │              ┌────────▼─────────┐
  │ → main.stp with  │              │ writeExternRefs  │
  │   full geometry  │              │ → main.stp with  │
  └──────────────────┘              │   refs but NO    │
                                    │   geometry       │
                                    └──────────────────┘
```

## References

- OCCT source: `repos/OCCT/src/DataExchange/TKDESTEP/STEPCAFControl/STEPCAFControl_Writer.cxx` (lines 598–835)
- Binding output: `repos/opencascade.js/build/bindings/DataExchange/TKDESTEP/STEPCAFControl/STEPCAFControl_Writer.hxx/STEPCAFControl_Writer.cpp`
- Related: `docs/research/brep-edge-mesh-regression.md`

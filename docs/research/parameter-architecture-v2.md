---
title: 'Parameter Architecture v2'
description: 'Refined exploration of parameter overlay architecture: keeping the kernel-agnostic unified format while adding expression support, per-CU scoping, and watch granularity'
status: draft
created: '2026-04-08'
updated: '2026-04-08'
category: architecture
related:
  - docs/research/parameter-architecture-design-space.md
  - docs/research/parameter-storage-architecture.md
  - docs/research/parameter-middleware-architecture.md
  - docs/policy/filesystem-policy.md
---

# Parameter Architecture v2

Refined exploration of the parameter overlay architecture, starting from the position that the kernel-agnostic parameter file resolver is a strategic asset — not a liability. The investigation focuses on extending the unified format with expression support and per-CU scoping while preserving the middleware-driven overlay model.

## Executive Summary

Tau's parameter file resolver middleware creates a kernel-agnostic overlay: one format, all kernels, human and AI editable. Walking toward kernel-native parameter formats would fragment this ecosystem. The missing capability is not format diversity — it is a **scripting layer** that lets parameter values depend on one another (`hole = radius / 2`). This document evaluates three expression models (inline expressions in JSON, a companion script module, and an expression-aware JSON superset), recommends **inline expressions with a formula prefix convention** as the primary approach, and treats per-CU file scoping as an orthogonal improvement that independently solves the watch granularity problem.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Design Principles](#design-principles)
- [Current Architecture Strengths](#current-architecture-strengths)
- [The Missing Capability](#the-missing-capability)
- [Orthogonal Concern: Per-CU Scoping](#orthogonal-concern-per-cu-scoping)
- [Expression Models](#expression-models)
- [Comparison Matrix](#comparison-matrix)
- [Recommendations](#recommendations)
- [Expression Evaluation Design](#expression-evaluation-design)
- [Schema and UI Impact](#schema-and-ui-impact)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

The v1 design space exploration (`parameter-architecture-design-space.md`) considered five architectural models including kernel-native parameter protocols and native bundler imports. On reflection, these approaches trade away a critical strength: **the kernel-agnostic parameter overlay creates a unified ecosystem** where JSON/YAML parameter files work identically across Replicad, Manifold, JSCAD, OpenCascade, OpenSCAD, and KCL. Each kernel has its own native parameter idiom (function arguments, `-D` flags, AST injection), but the parameter file resolver normalizes all of them behind a single data format.

The remaining gaps are:

1. **No expression support**: `{ "hole": 15 }` works but `{ "hole": "=radius / 2" }` does not. Parameters cannot reference or derive from one another.
2. **All-CU blast radius**: Editing one CU's parameters re-renders all CUs (analyzed in `content-aware-watch-filtering.md`).
3. **JSON-only format**: No YAML or other human-friendly serialization option (lower priority).

This document focuses on gap 1 (expressions) and treats gap 2 (scoping) as an orthogonal concern with its own solution.

## Design Principles

These principles guide the architecture:

1. **Kernel-agnostic overlay**: The parameter format is an overlay on kernel data structures. It works the same regardless of kernel. Kernels receive resolved `Record<string, unknown>` — they never parse the parameter file.

2. **Human and AI symmetric editing**: Both humans (via Parameters panel) and AI (via filesystem tools) read and write the same file format with the same semantics.

3. **Static-first, expressions opt-in**: Most parameters are literal values. Expressions are an enhancement, not a prerequisite. A parameter file with zero expressions is valid and common.

4. **Expressions are data, not code**: Expression strings are declarative formulas evaluated in a sandboxed context. They are not arbitrary JavaScript. This keeps the format serializable, diffable, and safe.

5. **Middleware owns the complexity**: The framework evaluates expressions and delivers resolved values to kernels. Kernels never see expression strings — they receive numbers, strings, booleans, and objects.

## Current Architecture Strengths

### Unified Ecosystem Value

The parameter file resolver creates value at multiple layers:

| Layer                 | Value                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **Runtime consumers** | `@taucad/runtime` users get parameter persistence without implementing their own storage  |
| **AI agent**          | Agent reads/writes one JSON format for all kernels — no kernel-specific parameter editing |
| **UI**                | Parameters panel renders from JSON Schema, edits go to one file format                    |
| **Set management**    | Named parameter sets (presets) work uniformly across all kernels                          |
| **Portability**       | `.tau/parameters.json` can be shared, version-controlled, or exported with the project    |

### Why Kernel-Native Formats Fragment This

If Replicad used `.params.ts`, OpenSCAD used `.params.json` with customizer annotations, and KCL used `.params.kcl` — the AI agent needs kernel-specific editing logic, the UI needs per-kernel renderers, set management diverges, and the parameter file is no longer a portable artifact.

## The Missing Capability

### What Expressions Enable

| Scenario                           |                   Without expressions                   |                           With expressions                            |
| ---------------------------------- | :-----------------------------------------------------: | :-------------------------------------------------------------------: |
| Hole positioned at half the width  | `"holeX": 15` (magic number, breaks when width changes) |                        `"holeX": "=width / 2"`                        |
| Fillet radius proportional to size |            `"fillet": 3` (manually updated)             |                  `"fillet": "=min(width * 0.1, 5)"`                   |
| Array of evenly spaced holes       |                 Not expressible in JSON                 |            `"count": 4, "spacing": "=width / (count + 1)"`            |
| Dependent dimension                |             User must manually keep in sync             |        `"innerDiameter": "=outerDiameter - 2 * wallThickness"`        |
| Material-dependent property        |                 Separate parameter sets                 | `"density": 7.85, "mass": "=volume * density"` (if volume is a param) |

### Prior Art in Parametric CAD

| Tool                    | Expression model                                                   | Scope                                              |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| **FreeCAD**             | Full expression engine with named references, spreadsheet cells    | Property → property, explicit DAG, cycle detection |
| **Onshape**             | `#variable` references in dimension fields, arithmetic + functions | Feature-scoped, ordered by feature tree            |
| **SolidWorks**          | Equations manager, `=` formulas referencing dimensions             | Global equation list, dependency graph             |
| **Grasshopper**         | Slider expressions (`x/2`, `Rad(x)`) — unary transforms only       | Single-value, no cross-slider dependencies         |
| **OpenSCAD Customizer** | No expressions in customizer; expressions in `.scad` code only     | Customizer is literals + widget metadata           |

The common pattern: **named identifiers + arithmetic + functions**, evaluated as a **DAG** with **cycle detection**. Tau's expression model should follow this well-established pattern.

## Orthogonal Concern: Per-CU Scoping

The watch granularity problem (all CUs re-render on any parameter change) is orthogonal to the expression question. It is solved by changing the **storage topology**, not the **value format**.

### Current: Shared File

```json
{
  "version": 1,
  "files": {
    "main.ts": { "activeSet": "default", "sets": { "default": { "values": { "width": 30 } } } },
    "other.ts": { "activeSet": "default", "sets": { "default": { "values": { "height": 10 } } } }
  }
}
```

One file → all workers watch it → all CUs re-render.

### Proposed: Per-CU Files

```
.tau/parameters/main.ts.json     → watched by Worker A only
.tau/parameters/other.ts.json    → watched by Worker B only
```

Each file contains a `FileParameterEntry` (same schema as today's per-file entry, without the outer `files` wrapper):

```json
{
  "activeSet": "default",
  "sets": {
    "default": {
      "values": { "width": 30 }
    }
  }
}
```

**Implementation**: The middleware's `getDependencies` and `wrapCreateGeometry` resolve the per-CU file path instead of indexing into a shared file. The `parameterConfig` utils adapt to read/write individual files. A migration path reads the shared file, splits into per-CU files, and removes the shared file.

**Why `.tau/parameters/<entry>.json` (not co-located)**: Keeps project source tree clean. The `.tau/` directory is already established as the framework's metadata namespace. Co-located files (e.g., `main.params.json` next to `main.ts`) add visible clutter and naming ambiguity.

**This is independent of expressions** — per-CU scoping works with pure literal values and with expression-enabled values alike. The two improvements compose cleanly.

## Expression Models

### Model 1: Inline Expressions with Formula Prefix

Parameter values are either **literals** (number, string, boolean, array, object) or **formula strings** prefixed with `=`.

```json
{
  "activeSet": "default",
  "sets": {
    "default": {
      "values": {
        "width": 30,
        "height": 20,
        "depth": "=width * 0.5",
        "filletRadius": "=min(width * 0.1, 5)",
        "holeX": "=width / 2",
        "holeY": "=height / 2"
      }
    }
  }
}
```

**Convention**: A string value starting with `=` is a formula. All other strings are literal string values. This matches the spreadsheet convention (Excel, Google Sheets, FreeCAD).

**Evaluation**: The middleware parses formulas, builds a dependency graph, topologically sorts, evaluates in order, and delivers resolved `Record<string, unknown>` to the kernel.

**Escaping**: A literal string that starts with `=` is written as `\=` (or `'=` following spreadsheet convention). In practice this is rare — CAD parameters are predominantly numeric.

**Nested objects**: Formulas can reference nested values with dot notation: `"inner": "=base.width - 2 * wallThickness"`.

**Trade-offs:**

- (+) Zero structural change to JSON — values are strings or primitives
- (+) Spreadsheet convention is universally understood by humans and AI
- (+) The `=` prefix is trivially detectable — no schema changes needed for storage
- (+) AI can generate formulas naturally (`"=radius / 2"` is obvious)
- (+) Backward compatible — existing files have no `=` prefixed strings
- (-) Type ambiguity: `"=width * 2"` is a string in JSON but evaluates to a number
- (-) Nested formula results require careful merge semantics
- (-) No IDE autocompletion for parameter names inside formula strings (solvable with Monaco/TipTap later)

### Model 2: Structured Expression Nodes

Instead of overloading string values, use an explicit discriminated structure for expressions:

```json
{
  "values": {
    "width": 30,
    "height": 20,
    "depth": { "$expr": "width * 0.5" },
    "filletRadius": { "$expr": "min(width * 0.1, 5)" }
  }
}
```

**Trade-offs:**

- (+) Unambiguous — `{ "$expr": ... }` is clearly an expression, not a literal
- (+) Can carry metadata: `{ "$expr": "width * 0.5", "$comment": "Half of width" }`
- (-) Verbose — `{ "$expr": "width * 0.5" }` vs `"=width * 0.5"`
- (-) Harder for humans to type and for AI to generate (more boilerplate)
- (-) Breaks `extractModifiedProperties` — a literal `15` and `{ "$expr": "width * 0.5" }` that evaluates to `15` are structurally different
- (-) JSON Schema validation is more complex (union types per field)

### Model 3: Companion Script Module

Keep the parameter file as pure literal JSON. Add an optional companion `.params.ts` file that exports computed overrides:

```typescript
// .tau/parameters/main.ts.params.ts
export default (params: { width: number; height: number }) => ({
  depth: params.width * 0.5,
  filletRadius: Math.min(params.width * 0.1, 5),
  holeX: params.width / 2,
  holeY: params.height / 2,
});
```

The middleware evaluates the script with the JSON values as input, then merges the computed results.

**Trade-offs:**

- (+) Full JavaScript expressiveness — loops, conditionals, imports
- (+) Type-safe with TypeScript
- (+) Separation of concerns — static config vs computation
- (-) Two files to manage per CU
- (-) AI must generate JS, not just JSON formulas — higher error rate
- (-) Script execution in the worker raises security/sandboxing concerns
- (-) Requires the esbuild bundler — won't work for non-bundled kernels (OpenSCAD, KCL)
- (-) Circular reference detection is the user's responsibility (runtime stack overflow)
- (-) Humans editing parameters now need to know when to edit JSON vs TS

### Model 4: JSON + Expressions Superset (Jsonnet-style)

Use a JSON superset (like Jsonnet, CUE, or a custom format) where expressions are first-class:

```jsonnet
{
  width: 30,
  height: 20,
  depth: self.width * 0.5,
  filletRadius: std.min(self.width * 0.1, 5),
}
```

**Trade-offs:**

- (+) Expressions are natural syntax, not string conventions
- (+) Tooling exists (Jsonnet has evaluators, formatters)
- (-) Not JSON — cannot use `JSON.parse`; requires a separate parser
- (-) AI and humans must learn a new syntax
- (-) Ecosystem fragmentation — tools that consume JSON won't work
- (-) Version control diffs are different from JSON
- (-) Two serialization formats in the codebase (JSON for everything else, Jsonnet for params)

## Comparison Matrix

| Dimension             |    Model 1: Formula Prefix    | Model 2: Structured Node  | Model 3: Script Module | Model 4: JSON Superset |
| --------------------- | :---------------------------: | :-----------------------: | :--------------------: | :--------------------: |
| Human readability     | High (spreadsheet convention) |     Medium (verbose)      |   Medium (two files)   |  Medium (new syntax)   |
| AI editability        |     High (`"=radius/2"`)      |   Medium (boilerplate)    |  Medium (generate JS)  |   Low (new language)   |
| Backward compat       |  Full (no `=` strings today)  |  Full (no `$expr` today)  |  Full (additive file)  |  Breaking (not JSON)   |
| Expression power      |    Arithmetic + functions     |  Arithmetic + functions   |    Full JavaScript     |   Language-dependent   |
| Cycle detection       |   Framework-provided (DAG)    | Framework-provided (DAG)  |  User responsibility   |   Language-dependent   |
| Sandbox safety        |     Controlled evaluator      |   Controlled evaluator    |   JS execution risks   |  Evaluator-dependent   |
| JSON roundtrip        | Yes (`JSON.parse/stringify`)  |            Yes            |    JSON + JS files     |           No           |
| Schema impact         |    Minimal (string union)     | Significant (union types) |  None (separate file)  | N/A (not JSON Schema)  |
| Storage change        |             None              |   `values` type changes   |     Additive file      |     Format change      |
| Implementation effort |          Low-Medium           |          Medium           |      Medium-High       |          High          |

## Recommendations

### R1: Inline Expressions with Formula Prefix (Model 1) — P0

The `=` prefix convention is the recommended expression model. It has the best balance of simplicity, backward compatibility, and ergonomics for both humans and AI.

**Why this wins:**

- The spreadsheet `=` convention is the most widely understood formula syntax in computing
- JSON remains JSON — no new parser, no new format, no new language
- AI models already understand `=` formulas from spreadsheet training data
- The storage format is unchanged — `values` remains `Record<string, unknown>` where values can be numbers, strings, booleans, or arrays
- Backward compatible — no existing parameter file has `=`-prefixed string values

### R2: Per-CU File Scoping — P0 Parallel

Split `.tau/parameters.json` into per-CU files under `.tau/parameters/`. This is independent of R1 and should be pursued in parallel.

| #   | Action                                 | Priority | Effort | Impact                                     |
| --- | -------------------------------------- | -------- | ------ | ------------------------------------------ |
| R1  | Formula prefix expression support      | P0       | Medium | High — enables parametric relationships    |
| R2  | Per-CU parameter file scoping          | P0       | Medium | High — eliminates cross-CU re-render waste |
| R3  | Content-aware watch filtering (bridge) | P1       | Low    | Medium — immediate fix while R2 migrates   |
| R4  | YAML format support                    | P2       | Low    | Low — human readability preference         |

### R3: Content-Aware Watch Filtering as Bridge — P1

Until R2 (per-CU files) is fully migrated, the `shouldInvalidate` + `getDependencyHash` hooks from `content-aware-watch-filtering.md` serve as a bridge fix. Once per-CU files are in place, these hooks become unnecessary (but harmless).

## Expression Evaluation Design

### Syntax

```
expression  := identifier
             | number
             | string
             | expression op expression
             | func '(' args ')'
             | '(' expression ')'
             | expression '.' identifier

op          := '+' | '-' | '*' | '/' | '%' | '**'
             | '==' | '!=' | '<' | '>' | '<=' | '>='
             | '&&' | '||'

func        := 'min' | 'max' | 'abs' | 'ceil' | 'floor' | 'round'
             | 'sqrt' | 'pow' | 'sin' | 'cos' | 'tan'
             | 'PI' | 'E'

identifier  := [a-zA-Z_][a-zA-Z0-9_]*
```

This is deliberately minimal — arithmetic, comparisons, boolean logic, and math functions. No assignment, no loops, no conditionals (ternary could be added later), no side effects.

### Evaluation Semantics

1. **Parse**: Each `=`-prefixed string is parsed into an AST
2. **Dependency extraction**: Free variables in each expression become edges in a dependency graph
3. **Topological sort**: Kahn's algorithm produces evaluation order; cycle → error reported to user
4. **Evaluate**: Walk the sorted list; each expression is evaluated with all previously-resolved values as context
5. **Type coercion**: Expression results are coerced to match the JSON Schema type for that field (number → number, string expression → string, etc.)

### Dependency Graph Example

```json
{
  "width": 30,
  "height": 20,
  "depth": "=width * 0.5",
  "filletRadius": "=min(width * 0.1, 5)",
  "holeX": "=width / 2",
  "holeY": "=height / 2",
  "volume": "=width * height * depth"
}
```

```
Dependency graph:
  width        → (literal, no deps)
  height       → (literal, no deps)
  depth        → depends on [width]
  filletRadius → depends on [width]
  holeX        → depends on [width]
  holeY        → depends on [height]
  volume       → depends on [width, height, depth]

Topological order: width, height, depth, filletRadius, holeX, holeY, volume
  (or any valid topo sort — depth must precede volume)
```

### Cycle Detection

```json
{
  "a": "=b + 1",
  "b": "=a + 1"
}
```

Topological sort fails → error: "Circular dependency between parameters: a → b → a"

### Nested Object Parameters

For nested parameter objects (e.g., `{ base: { width: 30 }, profile: { ... } }`):

- Expressions can reference nested values with dot notation: `"=base.width / 2"`
- The evaluation context is the flattened parameter namespace
- Evaluation order respects the full dependency graph across nesting levels

### Where Evaluation Happens

Expression evaluation occurs in the **parameter file resolver middleware**, after reading the file and before merging into `createGeometry` input. The kernel never sees expression strings — it receives fully resolved values.

```
.tau/parameters/main.ts.json
  { "width": 30, "depth": "=width * 0.5" }
        │
        ▼
  parameterFileResolverMiddleware
    1. Parse formulas
    2. Build dependency graph
    3. Topological sort
    4. Evaluate: { width: 30, depth: 15 }
        │
        ▼
  deepmerge(input.parameters, resolvedValues)
        │
        ▼
  Kernel receives { width: 30, depth: 15 }
```

### Evaluator Implementation

Recommend a **tiny purpose-built evaluator** (~200-400 lines) rather than depending on a library:

- **math.js**: Too large (600KB+) for a worker; full CAS is overkill
- **expr-eval**: Known CVEs; maintainer inactive
- **filtrex**: Good fit but adds a dependency for ~200 lines of logic
- **Custom**: A recursive descent parser for the grammar above is straightforward, auditable, and has zero dependency surface. The expression language is intentionally small enough to implement and test exhaustively.

The evaluator should be a standalone utility in `packages/runtime` (or `libs/utils`) — not UI-specific — since it runs in the kernel worker.

### Caching

Expression evaluation results are deterministic (pure function of input literals). The dependency hash already includes the full parameter file content hash, so:

- Changed literal → new file hash → new dependency hash → cache miss → re-evaluate expressions
- Unchanged file → same hash → geometry cache hit (expressions not re-evaluated)

No additional caching infrastructure is needed.

## Schema and UI Impact

### JSON Schema Extension

The JSON Schema from `getParameters` describes **code-level defaults** (what the kernel extracts). It does not know about expressions. No schema change is needed for expression support — the schema describes the **resolved types**, not the storage format.

However, the UI needs to know which values are expressions vs literals for display purposes. Two options:

**Option A: Separate expression metadata** — The middleware returns both resolved values and an expression map alongside the parameter data. The UI reads the expression map to display formula indicators.

**Option B: UI reads the parameter file directly** — The Parameters panel already reads `parameterConfig` from the project machine. It can inspect values for `=` prefixes to determine which fields have formulas. This is simpler and requires no middleware API change.

Recommendation: **Option B** — the UI already has access to the raw parameter values from `parameterConfig`.

### Parameters Panel Changes

| Component              | Current                  | With Expressions                                                                                |
| ---------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| **Number field**       | Slider + numeric input   | Slider + input that accepts `=` formulas; shows resolved value as slider position               |
| **Modified indicator** | Compares to code default | Same — expression `"=width/2"` that resolves to `15` is "modified" if code default is different |
| **Display**            | Shows numeric value      | Shows formula string (e.g., `=width/2`) with resolved value as tooltip or secondary display     |
| **Editing**            | Direct numeric input     | Toggle between value mode (slider) and formula mode (text input with `=` prefix)                |
| **Validation**         | JSON Schema type check   | Parse formula → check for syntax errors, unknown references, cycles                             |

### AI Agent Interaction

The AI agent edits `.tau/parameters/<entry>.json` via filesystem tools. Expression support is transparent:

```json
// AI writes this via editFile tool
{
  "activeSet": "default",
  "sets": {
    "default": {
      "values": {
        "width": 30,
        "wallThickness": 2,
        "innerWidth": "=width - 2 * wallThickness"
      }
    }
  }
}
```

The AI can use expressions or literals interchangeably. The format is self-documenting — `"=width - 2 * wallThickness"` is clear in both intent and mechanics.

### `extractModifiedProperties` Impact

The diff function compares serialized values. An expression string `"=width/2"` is structurally different from the numeric default `15`, so it will always be included in the override set. This is correct behavior — the user's intent is the formula, not the evaluated number.

## Diagrams

### Expression Evaluation Pipeline

```
Parameter file (JSON)
  { "width": 30, "depth": "=width * 0.5", "fillet": "=min(width*0.1, 5)" }
        │
        ▼
  ┌─────────────────────────────────┐
  │ 1. Partition: literals vs exprs │
  │    literals: { width: 30 }      │
  │    exprs: { depth, fillet }     │
  └──────────────┬──────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────┐
  │ 2. Parse expressions → ASTs    │
  │    depth: BinOp(*, Ref(width),  │
  │                     Lit(0.5))   │
  │    fillet: Call(min,            │
  │              BinOp(*, ...),     │
  │              Lit(5))            │
  └──────────────┬──────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────┐
  │ 3. Build dependency graph       │
  │    depth  → [width]             │
  │    fillet → [width]             │
  └──────────────┬──────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────┐
  │ 4. Topological sort             │
  │    Order: width, depth, fillet  │
  │    (Cycle? → error)             │
  └──────────────┬──────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────┐
  │ 5. Evaluate in order            │
  │    ctx = { width: 30 }          │
  │    depth = 30 * 0.5 = 15        │
  │    fillet = min(3, 5) = 3       │
  │    → { width: 30, depth: 15,   │
  │         fillet: 3 }             │
  └──────────────┬──────────────────┘
                 │
                 ▼
  deepmerge(input.parameters, resolved)
        │
        ▼
  Kernel receives { width: 30, depth: 15, fillet: 3 }
```

### Full Parameter Flow (Proposed)

```
┌─────────────────────────────────────────────────┐
│ User code: export const defaultParams = {       │
│   width: 30, height: 20, depth: 10              │
│ }                                               │
└──────────────────────┬──────────────────────────┘
                       │ getParameters (kernel)
                       ▼
              { width: 30, height: 20, depth: 10 }
              + JSON Schema
                       │
                       │ executeRender merges with currentParameters
                       ▼
              deepmerge(codeDefaults, currentParameters)
                       │
                       ▼
              createGeometry middleware chain
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│ parameterFileResolverMiddleware                  │
│                                                  │
│ Reads: .tau/parameters/main.ts.json              │
│ { "width": 50, "depth": "=width * 0.5" }        │
│                                                  │
│ Evaluates expressions:                           │
│ { width: 50, depth: 25 }                         │
│                                                  │
│ deepmerge(input.parameters, resolved)            │
│ → { width: 50, height: 20, depth: 25 }          │
└──────────────────────┬───────────────────────────┘
                       │
                       ▼
              Kernel receives
              { width: 50, height: 20, depth: 25 }
```

### Per-CU File Layout

```
project/
├── main.ts
├── housing.ts
├── .tau/
│   ├── cache/          (geometry + parameter cache)
│   └── parameters/
│       ├── main.ts.json        ← Worker A watches this only
│       └── housing.ts.json     ← Worker B watches this only
```

## Implementation Phases

| Phase       | Scope                        | Deliverables                                                                                                    | Depends on |
| ----------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| **Phase 1** | Per-CU parameter files       | Middleware resolves `.tau/parameters/<entry>.json`; migration from shared file; `parameterConfig` utils adapted | —          |
| **Phase 2** | Expression evaluator         | Recursive descent parser + DAG evaluator in `packages/runtime`; middleware integrates evaluation                | —          |
| **Phase 3** | UI expression support        | Number field formula mode; expression display/editing; cycle error display                                      | Phase 2    |
| **Phase 4** | Content-aware watch (bridge) | `shouldInvalidate` + `getDependencyHash` hooks for shared-file compat during Phase 1 migration                  | —          |

Phases 1 and 2 are independent and can proceed in parallel. Phase 3 depends on Phase 2. Phase 4 is a parallel bridge fix superseded by Phase 1 completion.

## References

- `docs/research/content-aware-watch-filtering.md` — watch granularity analysis
- `docs/research/parameter-architecture-design-space.md` — v1 design space exploration
- `docs/research/parameter-storage-architecture.md` — parameter storage analysis
- `docs/research/parameter-middleware-architecture.md` — middleware architecture
- `packages/runtime/src/framework/kernel-worker.ts` — render loop, dependency hashing
- `apps/ui/app/middleware/parameter-file-resolver.middleware.ts` — current middleware
- `apps/ui/app/utils/parameter-config.utils.ts` — parameter CRUD utilities
- `apps/ui/app/components/geometry/parameters/parameters.tsx` — RJSF form rendering
- `apps/ui/app/components/geometry/parameters/parameters-number-field.tsx` — numeric parameter widget
- `apps/ui/app/utils/object.utils.ts` — `extractModifiedProperties` diff logic
- FreeCAD expression engine: [wiki.freecad.org/Expressions](https://wiki.freecad.org/Expressions)
- Onshape variables and formulas: [onshape.com/blog/global-variables-formulas](https://www.onshape.com/en/blog/global-variables-formulas-configurations-parametric-design)

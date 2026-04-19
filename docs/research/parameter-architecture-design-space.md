---
title: 'Parameter Architecture Design Space'
description: 'Architectural exploration of how parameter overrides should flow from storage to geometry kernels, comparing middleware injection vs native resolution across multi-kernel, multi-format scenarios'
status: draft
created: '2026-04-08'
updated: '2026-04-08'
category: architecture
related:
  - docs/research/parameter-storage-architecture.md
  - docs/research/parameter-middleware-architecture.md
  - docs/policy/filesystem-policy.md
---

# Parameter Architecture Design Space

Architectural exploration of how parameter overrides should flow from storage to geometry kernels — evaluating whether the current middleware injection model is the right long-term architecture or whether a native resolution approach (where geometry files import their own parameters) would better serve a multi-kernel, multi-format future.

## Executive Summary

Tau's parameter system currently uses a **middleware injection model**: a single `.tau/parameters.json` file stores overrides for all compilation units, and `parameterFileResolverMiddleware` reads the JSON and merges overrides into `createGeometry` input — invisible to user code. This works but creates problems: all CUs re-render on any parameter change (see `content-aware-watch-filtering.md`), the format is locked to JSON, and the architecture cannot scale to non-JS kernels (OpenSCAD, KCL) that have their own parameter idioms. This document explores five architectural models spanning from incremental fixes to the current system through to a fundamentally native approach where geometry files resolve their own parameters, and assesses each against a multi-kernel, multi-format future.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Scope and Non-Goals](#scope-and-non-goals)
- [Current Architecture](#current-architecture)
- [Design Constraints](#design-constraints)
- [Architectural Models](#architectural-models)
- [Approach A: Scoped Middleware (Incremental)](#approach-a-scoped-middleware-incremental)
- [Approach B: Per-CU Parameter Files](#approach-b-per-cu-parameter-files)
- [Approach C: Native Import (Bundler-Resolved)](#approach-c-native-import-bundler-resolved)
- [Approach D: Virtual Module Provider](#approach-d-virtual-module-provider)
- [Approach E: Kernel-Native Parameter Protocol](#approach-e-kernel-native-parameter-protocol)
- [Comparison Matrix](#comparison-matrix)
- [Recommendations](#recommendations)
- [Diagrams](#diagrams)

## Problem Statement

### Immediate Pain

Parameter changes for one compilation unit trigger re-renders for all CUs because `.tau/parameters.json` is a single shared file watched at whole-file granularity (analyzed in `content-aware-watch-filtering.md`).

### Deeper Architectural Concerns

1. **Format lock-in**: Parameters are always JSON. Future scenarios include YAML configs, JS/TS modules returning computed values, KCL variable declarations, and OpenSCAD customizer annotations — all of which have their own parameter idioms.

2. **Framework magic**: The middleware silently intercepts `createGeometry` to merge overrides. User code never sees or controls parameter resolution. This makes the system opaque and harder to reason about, especially for 3rd-party runtime consumers.

3. **Kernel asymmetry**: JS/TS kernels (Replicad, Manifold, JSCAD, OpenCascade) use `export const defaultParams = {...}` and receive parameters as a function argument. OpenSCAD uses customizer annotations and `-D` CLI flags. KCL uses `let` variable declarations with AST injection. Each kernel has a native parameter concept that the middleware bypasses.

4. **Multi-file parameters**: A project might want parameters spread across multiple files — global config, per-component configs, material databases. The single-file model cannot represent this without the file growing unboundedly.

5. **Expressions and computation**: `width: baseWidth * 2` or `holes: range(0, count)` cannot be expressed in static JSON. JS/TS parameter files could enable computed defaults, validation logic, and interdependent parameter constraints.

## Scope and Non-Goals

**In scope**: How parameter overrides flow from persistent storage to kernel execution across all kernel types.

**Out of scope**: Parameter UI rendering (RJSF schema), parameter set management (create/delete/rename/switch), AI agent parameter interaction beyond the storage interface, and the specific content-aware watch filtering implementation (covered in its own document).

## Current Architecture

### Parameter Sources

Two canonical sources feed into geometry computation:

| Source             | Extraction                                                                                                                                                        | Format          | Kernel-specific |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | :-------------: |
| **Code defaults**  | `getParameters` executes the module, reads `defaultParams` export (JS/TS) or kernel-native extraction (OpenSCAD WASM `--export-format=param`, KCL mock execution) | Language-native |       Yes       |
| **User overrides** | `parameterFileResolverMiddleware` reads `.tau/parameters.json`                                                                                                    | JSON            |       No        |

### Merge Order

```
Code defaults (kernel getParameters)
        │
        ▼
  deepmerge with currentParameters (client/UI)
        │
        ▼
  createGeometry middleware chain
        │
        ▼
  parameterFileResolver: deepmerge with .tau/parameters.json[entryFile].activeSet.values
        │
        ▼
  Kernel receives final merged parameters
```

### Per-Kernel Parameter Injection

| Kernel          | How parameters enter the geometry function                                         |
| --------------- | ---------------------------------------------------------------------------------- |
| **Replicad**    | `main(replicadInstance, parameters)` or `main(parameters)` — function argument     |
| **Manifold**    | `main(manifoldCad, parameters)` or `main(parameters)` — function argument          |
| **JSCAD**       | `main(parameters)` — function argument; also supports `getParameterDefinitions()`  |
| **OpenCascade** | `main(oc, parameters)` or `main(parameters)` — function argument                   |
| **OpenSCAD**    | `-D name=value` CLI flags — no function arguments; parameters are global variables |
| **KCL**         | `injectParametersIntoProgram(ast, parameters)` — AST mutation before execution     |

### Bundler Capabilities

The esbuild-wasm bundler supports:

- **JS/TS/JSX/TSX**: Full bundling with VFS resolution
- **JSON**: `.json` imports via esbuild's `json` loader (explicit extension required)
- **YAML**: Not supported
- **Other formats**: Not supported without custom loaders

`resolveFileExtension` only probes `.ts`, `.tsx`, `.js`, `.jsx` — extensionless JSON imports are not auto-discovered.

## Design Constraints

Any architecture must satisfy:

1. **Multi-kernel**: Replicad, Manifold, JSCAD, OpenCascade (JS/TS bundled), OpenSCAD (WASM CLI), KCL (WASM AST) — and future kernels
2. **Deterministic dependency hash**: Parameters must contribute to the dependency hash for cache correctness
3. **Watch-driven re-render**: Parameter changes must trigger re-renders with appropriate granularity
4. **UI editability**: The Parameters panel must be able to read schemas and write overrides
5. **AI editability**: The agent must be able to read/write parameters via filesystem tools
6. **Set management**: Multiple named parameter sets per CU with active-set switching
7. **3rd-party DX**: `@taucad/runtime` consumers should have a clear, non-magical parameter story
8. **No user data loss**: Parameter overrides must persist across sessions (IndexedDB/OPFS)

## Architectural Models

### Approach A: Scoped Middleware (Incremental)

Keep the current middleware injection architecture but fix the granularity problems.

**Changes:**

- Add `shouldInvalidate` + `getDependencyHash` hooks (per `content-aware-watch-filtering.md`)
- Optionally split `.tau/parameters.json` into per-CU files (`.tau/parameters/<entry>.json`)

**How parameters flow:**
Same as today — middleware reads JSON, merges into `createGeometry` input. User code is unaware.

**Multi-format support:**
None inherent. Middleware could be extended to read YAML, but each format requires a new middleware or middleware option.

**Kernel compatibility:**

| Kernel                     | Works? | Notes                                                         |
| -------------------------- | :----: | ------------------------------------------------------------- |
| Replicad/Manifold/JSCAD/OC |  Yes   | Current behavior                                              |
| OpenSCAD                   |  Yes   | Parameters arrive via same `input.parameters` → `-D` flags    |
| KCL                        |  Yes   | Parameters arrive via same `input.parameters` → AST injection |

**Trade-offs:**

- (+) Minimal change to current system
- (+) Works for all kernels uniformly
- (-) Parameters remain invisible to user code — framework magic persists
- (-) Format locked to JSON (or whatever the middleware supports)
- (-) No path to computed/expression parameters
- (-) Does not leverage kernel-native parameter capabilities

### Approach B: Per-CU Parameter Files

Split storage so each compilation unit has its own parameter file. This is a data architecture change, not an execution architecture change.

**Storage layout options:**

```
Option B1: Per-CU JSON files
  .tau/parameters/main.ts.json
  .tau/parameters/housing.ts.json

Option B2: Co-located parameter files
  main.params.json      (next to main.ts)
  housing.params.json   (next to housing.ts)

Option B3: Convention-based co-location
  main.ts       →  main.params.ts (or .json, .yaml, etc.)
  housing.scad  →  housing.params.json
```

**How parameters flow:**
Still middleware-injected. The middleware resolves the per-CU file instead of extracting from a shared file.

**Watch granularity:**
Solved inherently — each worker watches only its own parameter file. No content-aware filtering needed.

**Multi-format support:**
B3 opens the door to per-kernel parameter formats. A `.params.ts` file could export computed values; a `.params.json` stays static; a `.params.yaml` uses YAML syntax.

**Kernel compatibility:**
Same as Approach A — middleware handles the format; kernels receive `input.parameters`.

**Trade-offs:**

- (+) Watch granularity solved by architecture, not framework hooks
- (+) B3 enables format flexibility per CU
- (+) AI agent can edit individual parameter files without touching other CUs
- (-) Breaking change to `FileParameterConfig` schema
- (-) Set management across files is more complex (each file has its own sets)
- (-) Atomicity: multi-CU parameter updates require multiple writes
- (-) User code still does not see or control parameters
- (-) B1/B2 adds file tree clutter

### Approach C: Native Import (Bundler-Resolved)

User code explicitly imports its parameter file. The bundler resolves and bundles it. No middleware injection — the geometry file is responsible for its own parameter resolution.

**User code (JS/TS kernel):**

```typescript
import params from './params.json';

export const defaultParams = params.width !== undefined ? params : { width: 30, height: 20, depth: 10 };

export function main(replicad, parameters) {
  const { width, height, depth } = parameters;
  // ... geometry code
}
```

Or with a JS/TS parameter module:

```typescript
// params.ts
export default {
  width: 30,
  height: 20,
  depth: Math.ceil(30 / 2),
  holes: Array.from({ length: 4 }, (_, i) => ({ x: i * 10, y: 0 })),
};
```

```typescript
import defaultParams from './params';

export { defaultParams };
export function main(replicad, parameters) {
  /* ... */
}
```

**How parameters flow:**

```
User code: import params from './params.json'
        │
        ▼
  Bundler resolves './params.json' → includes in bundle
        │
        ▼
  Module executes: exports defaultParams from imported data
        │
        ▼
  getParameters: extracts defaultParams from executed module
        │
        ▼
  executeRender: deepmerge(defaultParams, currentParameters)
        │
        ▼
  createGeometry receives merged parameters
```

No middleware involved. The parameter file is a regular dependency — watched, hashed, and cached like any source file.

**Watch granularity:**
Solved inherently — `./params.json` is in the `BundleResult.dependencies` for only the CU that imports it. Other CUs that import different param files are unaffected.

**Multi-format support:**

| Format | Bundler support | Notes                                                               |
| ------ | :-------------: | ------------------------------------------------------------------- |
| JSON   |       Yes       | esbuild `json` loader — works today with explicit `.json` extension |
| JS/TS  |       Yes       | Full bundling — expressions, computed values, imports               |
| YAML   |       No        | Requires esbuild loader plugin or pre-transform                     |
| Python |       No        | Not bundleable in esbuild; would need a different approach          |
| KCL    |       No        | KCL has its own parser/executor                                     |

**Kernel compatibility:**

| Kernel                     | Works?  | Notes                                                                                                |
| -------------------------- | :-----: | ---------------------------------------------------------------------------------------------------- |
| Replicad/Manifold/JSCAD/OC |   Yes   | User imports params natively; bundler resolves                                                       |
| OpenSCAD                   |   No    | OpenSCAD has no `import` mechanism; `.scad` files use `include`/`use` with variables, not JS modules |
| KCL                        | Partial | KCL has `import` but it's KCL-native, not JS. KCL variables could reference a KCL config file        |

**Trade-offs:**

- (+) No framework magic — user code is explicit and self-contained
- (+) Full expression support (JS/TS params can compute, validate, reference other modules)
- (+) Watch granularity is automatic (bundler dependency tracking)
- (+) Parameter file is a regular dependency — no special caching/hashing infrastructure
- (+) 3rd-party DX: runtime consumers understand standard imports
- (-) **Does not work for OpenSCAD** without a compatibility shim
- (-) **Breaks the UI parameter editing workflow**: the Parameters panel currently writes `.tau/parameters.json`; with native imports, it would need to generate/modify JS/TS/JSON source files per CU
- (-) **Set management becomes harder**: multiple named sets cannot naturally live in a single imported module without UI-driven code generation
- (-) Parameter files must exist in the project file tree — adds visible files the user must understand
- (-) Users must write the import boilerplate themselves (or scaffolding generates it)
- (-) Migration path from current system is complex

### Approach D: Virtual Module Provider

A hybrid of C and A. The runtime provides a virtual module that user code can import, but the module's content is synthesized by the framework from parameter storage.

**User code:**

```typescript
import params from 'tau:params'; // virtual module, resolved by bundler plugin

export const defaultParams = params;

export function main(replicad, parameters) {
  const { width, height, depth } = parameters;
  // ...
}
```

**How it works:**

1. The bundler has a built-in plugin for the `tau:params` (or `@tau/params`) specifier
2. When the bundler resolves `tau:params`, it reads the parameter storage for the current entry file and synthesizes a JS module: `export default { width: 30, height: 20 };`
3. The synthesized module is bundled inline — no real file on disk
4. The bundler plugin tracks the underlying storage file as a dependency

**For non-JS kernels:**

OpenSCAD and KCL don't use the bundler. For these kernels, the virtual module approach translates to a **kernel-level protocol**: the kernel worker provides parameter overrides to the kernel's native injection mechanism (which is what happens today).

**Multi-format parameter storage:**

The virtual module provider reads from whatever storage format exists. The storage could be JSON, YAML, JS/TS (evaluated), or even a database. The virtual module is always JS (the bundler's native format). Storage format is decoupled from consumption format.

```
Storage: .tau/params/main.yaml  ──┐
                                  ├──► Virtual Module Provider ──► export default { width: 30 }
Storage: .tau/params/main.ts   ──┘
```

**Watch granularity:**
The virtual module provider can register only the relevant storage file/path as a dependency. Per-CU granularity is built in.

**Trade-offs:**

- (+) User code has an explicit import — less magical than invisible middleware
- (+) Storage format is decoupled from consumption — JSON, YAML, JS/TS, or even computed
- (+) Watch granularity is natural (provider tracks per-CU storage)
- (+) Works for JS/TS kernels via bundler plugin
- (+) 3rd-party DX: `tau:params` is a documented convention
- (-) Requires a bundler plugin — adds complexity to the bundler
- (-) Non-JS kernels still need the middleware/injection path (OpenSCAD, KCL)
- (-) The `import` is somewhat magical — `tau:params` doesn't map to a real file
- (-) Two code paths: virtual module for bundled kernels, injection for non-bundled kernels
- (-) Set management still requires a storage layer the UI writes to

### Approach E: Kernel-Native Parameter Protocol

Instead of a single parameter storage format, define a **protocol** that each kernel implements natively. The framework provides primitives; each kernel (or kernel plugin) owns the format and resolution.

**Protocol:**

```typescript
type ParameterProtocol = {
  resolveParameterFile(entryFile: string, basePath: string): string | string[];
  readParameters(filePath: string, content: string | Uint8Array): Record<string, unknown>;
  writeParameters(filePath: string, parameters: Record<string, unknown>): string | Uint8Array;
  getParameterSchema(filePath: string, content: string | Uint8Array): JsonSchema;
};
```

**Per-kernel implementations:**

| Kernel                     | Parameter file     | Format                            | Resolution                              |
| -------------------------- | ------------------ | --------------------------------- | --------------------------------------- |
| Replicad/Manifold/JSCAD/OC | `main.params.ts`   | JS/TS module                      | Bundler import or co-located convention |
| OpenSCAD                   | `main.params.json` | JSON (matching customizer schema) | Co-located convention                   |
| KCL                        | `main.params.kcl`  | KCL variable declarations         | KCL `import`                            |
| Future Python              | `main.params.py`   | Python dict                       | Python import                           |

**How it works:**

1. `defineKernel` can optionally include a `parameterProtocol` field
2. The kernel worker calls `parameterProtocol.resolveParameterFile(entryFile, basePath)` to find the parameter file(s)
3. The resolved files are added to `getDependencies` and the watch set
4. The kernel worker calls `readParameters` to extract values, which feed into the merge chain
5. The UI calls `writeParameters` to serialize changes back
6. The schema comes from `getParameterSchema`, not from executing the module

**Watch granularity:**
Each kernel resolves its own parameter files. The dependency set is per-CU by construction.

**Multi-format support:**
Each kernel owns its format. No framework-level format constraints.

**Trade-offs:**

- (+) Each kernel uses its natural parameter idiom
- (+) New kernels define their own parameter format without touching framework code
- (+) Watch granularity is natural (kernel-resolved dependencies)
- (+) Extensible to any language/format
- (+) Clean separation of concerns: framework provides protocol, kernel provides implementation
- (-) **UI must understand kernel-specific formats** to render the Parameters panel and write changes — significant complexity
- (-) **Set management** must be implemented per kernel or abstracted by a separate layer
- (-) **Higher implementation cost** — each kernel needs a protocol implementation
- (-) **AI agent needs kernel-specific parameter editing logic** (or a generic serializer)
- (-) Existing kernels have no protocol implementation — migration effort per kernel
- (-) Breaks the current model where `FileParameterConfig` is a universal format

## Comparison Matrix

| Dimension              | A: Scoped MW | B: Per-CU Files  | C: Native Import | D: Virtual Module  | E: Kernel Protocol |
| ---------------------- | :----------: | :--------------: | :--------------: | :----------------: | :----------------: |
| Watch granularity fix  |  Via hooks   |     Inherent     |     Inherent     |      Inherent      |      Inherent      |
| Multi-format params    |      No      |     B3 only      |    JS/TS/JSON    |  Any (decoupled)   |  Any (per-kernel)  |
| Expression support     |      No      |     B3 (.ts)     |       Yes        |    Via storage     |     Per-kernel     |
| Framework magic        |     High     |       High       |       None       |        Low         |        Low         |
| OpenSCAD compat        |     Yes      |       Yes        | No (shim needed) | Partial (fallback) |    Yes (native)    |
| KCL compat             |     Yes      |       Yes        |     Partial      | Partial (fallback) |    Yes (native)    |
| UI edit complexity     |     Low      |       Low        |  High (codegen)  |       Medium       | High (per-kernel)  |
| AI edit complexity     |     Low      |       Low        |      Medium      |     Low-Medium     | High (per-kernel)  |
| Set management         |  Unchanged   |     Per-file     |       Hard       |     Unchanged      |     Per-kernel     |
| 3rd-party DX           |    Opaque    |      Opaque      |      Clear       |     Documented     |       Clear        |
| Breaking changes       |     None     | Schema migration | Workflow change  |   Bundler plugin   | Kernel API change  |
| Implementation effort  |     Low      |      Medium      |       High       |    Medium-High     |        High        |
| Migration from current |   Trivial    |     Moderate     |     Complex      |      Moderate      |      Complex       |

## Recommendations

### R1: Hybrid B3 + D — Co-located Parameter Files with Virtual Module Fallback — P0

The recommended architecture combines the best of Approaches B3 and D:

**Core idea:** Each CU's parameters live in a co-located file next to the entry file, following a naming convention. JS/TS kernels can optionally import the file directly (Approach C) or have it provided via a virtual module (Approach D). Non-JS kernels use the kernel worker's injection mechanism (current behavior).

**Convention:**

```
main.ts         →  main.params.json   (or .params.ts, .params.yaml)
housing.scad    →  housing.params.json
model.kcl       →  model.params.json  (or .params.kcl)
```

**Resolution order:**

1. Kernel checks for explicit import (`import params from './main.params'`) in the bundle dependencies
2. If no explicit import, framework resolves by convention: `<entry>.params.<ext>` with configurable extension priority
3. If no co-located file exists, falls back to legacy `.tau/parameters.json` lookup (migration compat)

**Watch granularity:**
Solved inherently — each file is a separate dependency per CU.

**Format flexibility:**

- `.params.json` — static JSON, editable by UI and AI
- `.params.ts` / `.params.js` — computed/expression parameters, imported natively by JS/TS kernels
- `.params.yaml` — human-readable config (requires YAML loader, lower priority)
- `.params.kcl` — KCL-native parameters (future)

**Set management:**
Sets remain in the parameter file structure. A `.params.json` file contains `{ activeSet, sets: { ... } }` (same `FileParameterEntry` schema, without the outer `files` wrapper). A `.params.ts` file exports the active values directly (sets managed by UI via a sidecar `.params.meta.json` or by having multiple `.params.*.ts` files).

**Implementation phases:**

| Phase       | Work                                                              | Benefit               |
| ----------- | ----------------------------------------------------------------- | --------------------- |
| **Phase 1** | Per-CU file resolution in middleware + migration from shared file | Watch granularity fix |
| **Phase 2** | JS/TS `.params.ts` support via bundler (native import)            | Expression support    |
| **Phase 3** | Virtual module `tau:params` for opt-in explicit import            | 3rd-party DX          |
| **Phase 4** | YAML loader, KCL-native params                                    | Multi-format          |

### R2: Scoped Middleware as Bridge (Approach A) — P0 Parallel

While R1 is the long-term architecture, `content-aware-watch-filtering.md`'s `shouldInvalidate` + `getDependencyHash` hooks should be implemented as an immediate fix. They are composable with R1: during migration, the shared `.tau/parameters.json` file benefits from content-aware filtering; after migration, each CU has its own file and the hooks become unnecessary (but harmless).

### R3: Avoid Kernel-Native Protocol (Approach E) as Primary — P2

The kernel-native protocol is the most architecturally pure but imposes too much cost on the UI and AI layers. Each kernel having its own parameter format means the Parameters panel, set management, and AI agent all need per-kernel adapters. Recommendation: use E's ideas selectively — allow kernels to declare a `resolveParameterFile` convention, but keep the storage/serialization format kernel-agnostic (JSON or JS/TS).

## Diagrams

### Current Architecture (Middleware Injection)

```
┌──────────────────────────────────────────────────┐
│ .tau/parameters.json                             │
│ { files: { "main.ts": {...}, "other.ts": {...} }}│
└──────────────┬───────────────────────────────────┘
               │ watched by ALL workers
               ▼
  ┌─────────────────────────────┐
  │ parameterFileResolverMiddleware │
  │ reads files[entryFile]      │
  │ deepmerge into input.params │
  └─────────────┬───────────────┘
                │
                ▼
        Kernel createGeometry
```

### Proposed Architecture (Co-located Files + Virtual Module)

```
┌─────────────┐  ┌──────────────────┐  ┌─────────────────┐
│ main.params  │  │ housing.params   │  │ model.params    │
│ .json        │  │ .ts              │  │ .json           │
└──────┬───────┘  └────────┬─────────┘  └───────┬─────────┘
       │ watched by         │ imported by         │ watched by
       │ Worker A only      │ Worker B (bundler)  │ Worker C only
       ▼                    ▼                     ▼
  MW resolves          Bundler resolves       MW resolves
  → inject params     → in bundle deps      → inject params
       │                    │                     │
       ▼                    ▼                     ▼
  Replicad kernel     Manifold kernel       OpenSCAD kernel
  main(rc, params)    main(mf, params)      -D key=value
```

### Migration Path

```
Phase 0 (current):   shared .tau/parameters.json + middleware
                            │
Phase 1:             per-CU .params.json files + updated middleware
                     (shared file kept for backward compat with fallback)
                            │
Phase 2:             JS/TS .params.ts support for expression params
                     (bundler native import path for JS/TS kernels)
                            │
Phase 3:             virtual module tau:params for explicit opt-in
                     (user code: import params from 'tau:params')
                            │
Phase 4:             YAML/KCL-native format support
                     (loader plugins, kernel-specific resolution)
```

## Code Examples

### Phase 1: Per-CU Parameter File Resolution

```typescript
const parameterFileResolverMiddleware = defineMiddleware({
  name: 'parameter-file-resolver',

  optionsSchema: z.object({
    extensions: z.array(z.string()).default(['.params.json']),
    legacyFile: z.string().default('.tau/parameters.json'),
  }),

  getDependencies({ filePath, basePath }, options) {
    const paramFile = resolveParameterFile(filePath, basePath, options.extensions);
    if (paramFile) return [paramFile];
    return [`${basePath}/${options.legacyFile}`];
  },

  async wrapCreateGeometry(input, handler, runtime) {
    const paramFile = resolveParameterFile(input.filePath, input.basePath, runtime.options.extensions);

    if (paramFile) {
      runtime.registerWatchPath(paramFile, { debounceMs: 200 });
      try {
        const content = await runtime.filesystem.readFile(paramFile, 'utf8');
        const entry = JSON.parse(content) as FileParameterEntry;
        const activeValues = entry.sets[entry.activeSet]?.values;
        if (activeValues) {
          return handler({
            ...input,
            parameters: deepmerge(input.parameters, activeValues),
          });
        }
      } catch {
        /* fall through */
      }
    }

    // Legacy fallback: read from shared .tau/parameters.json
    return legacyResolve(input, handler, runtime);
  },
});

function resolveParameterFile(entryFile: string, basePath: string, extensions: string[]): string | undefined {
  const base = entryFile.replace(/\.[^.]+$/, '');
  for (const ext of extensions) {
    const candidate = `${base}${ext}`;
    return candidate; // existence check deferred to read
  }
  return undefined;
}
```

### Phase 2: Native Import in User Code

```typescript
// main.params.ts — expression-capable parameter defaults
const baseWidth = 30;

export default {
  width: baseWidth,
  height: baseWidth * 0.67,
  depth: 10,
  filletRadius: Math.min(baseWidth * 0.1, 5),
  holePositions: Array.from({ length: 4 }, (_, i) => ({
    x: (i + 1) * (baseWidth / 5),
    y: baseWidth * 0.33,
  })),
};
```

```typescript
// main.ts — user imports params explicitly
import defaultParams from './main.params';

export { defaultParams };

export function main(replicad, parameters) {
  const { width, height, depth, filletRadius, holePositions } = parameters;
  // ... geometry
}
```

The bundler resolves `./main.params` → `./main.params.ts` via standard extension resolution. The file appears in `BundleResult.dependencies`. Watch granularity is automatic.

### Phase 3: Virtual Module

```typescript
// main.ts — opt-in virtual module
import params from 'tau:params';

export const defaultParams = params;

export function main(replicad, parameters) {
  /* ... */
}
```

Bundler plugin:

```typescript
const tauParamsPlugin: esbuild.Plugin = {
  name: 'tau-params',
  setup(build) {
    build.onResolve({ filter: /^tau:params$/ }, (args) => ({
      path: args.importer,
      namespace: 'tau-params',
    }));

    build.onLoad({ filter: /.*/, namespace: 'tau-params' }, async (args) => {
      const paramFile = resolveParameterFile(args.path, projectPath, extensions);
      const content = await filesystem.readFile(paramFile, 'utf8');
      const entry = JSON.parse(content);
      const values = entry.sets[entry.activeSet]?.values ?? {};
      return {
        contents: `export default ${JSON.stringify(values)};`,
        loader: 'js',
        watchFiles: [paramFile],
      };
    });
  },
};
```

## Trade-offs

| Dimension              |     Current (MW injection)      |       R1 (Co-located + Virtual)        |
| ---------------------- | :-----------------------------: | :------------------------------------: |
| Watch granularity      |      All CUs on any change      |         Per-CU by construction         |
| Format flexibility     |            JSON only            |       JSON, JS/TS, YAML (phased)       |
| Expression support     |               No                |           Yes (JS/TS params)           |
| User code transparency |       Opaque (middleware)       |    Explicit (import or convention)     |
| OpenSCAD/KCL compat    |              Full               |   Full (MW fallback for non-bundled)   |
| UI editing             |      Simple (single file)       |  Per-CU file (slightly more complex)   |
| AI editing             | Single file, specific JSON path |     Per-CU file (simpler per file)     |
| Migration effort       |              None               |           Phased (4 phases)            |
| Set management         |           Centralized           | Per-CU file (same schema, distributed) |

## References

- `docs/research/content-aware-watch-filtering.md` — immediate watch filtering fix
- `docs/research/parameter-storage-architecture.md` — prior parameter storage analysis
- `docs/research/parameter-middleware-architecture.md` — middleware architecture documentation
- `packages/runtime/src/framework/kernel-worker.ts` — render loop, dependency computation
- `packages/runtime/src/bundler/esbuild-core.ts` — bundler VFS, JSON loader, extension resolution
- `packages/runtime/src/kernels/*/` — per-kernel parameter extraction and injection
- `apps/ui/app/middleware/parameter-file-resolver.middleware.ts` — current middleware
- `libs/types/src/types/cad.types.ts` — `FileParameterConfig`, `FileParameterEntry` types

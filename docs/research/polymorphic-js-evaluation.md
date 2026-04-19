---
title: 'Polymorphic JavaScript Evaluation'
description: 'Best-practice approaches for evaluating ESM code strings across Node.js, browser, and worker environments'
status: active
created: '2026-04-16'
updated: '2026-04-16'
category: comparison
related:
  - docs/research/converter-runtime-consolidation.md
---

# Polymorphic JavaScript Evaluation

Investigation of best-practice approaches (as of April 2026) for dynamically evaluating ESM code strings across Node.js, browser, and Web Worker environments — motivated by `@taucad/runtime`'s need to execute esbuild-bundled CAD scripts in all three contexts.

## Executive Summary

Dynamically executing ESM code from a string remains a fragmented problem across JavaScript runtimes. No single mechanism works identically in Node.js, browsers, and Web Workers. The ecosystem has converged on two dominant patterns: **Blob/data URL `import()`** for browser/worker environments and **temp-file `import()`** for Node.js when ESM loader hooks are present. The `node:vm` module's ESM support (`vm.SourceTextModule`) remains experimental behind `--experimental-vm-modules` as of Node.js v25.9.0, with a new replacement API proposed in April 2026 (nodejs/node#62720). The recommended approach for `@taucad/runtime` is environment-gated evaluation: Blob URLs in browsers/workers, temp-file `import()` in Node.js.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Environment Landscape](#environment-landscape)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [References](#references)

## Problem Statement

`@taucad/runtime` bundles user-authored CAD scripts (TypeScript/JavaScript) via esbuild-wasm into a single ESM string. This string must then be dynamically imported to extract the `main` function and `defaultParams` exports. The code runs in three environments:

1. **Browser main thread** — the web editor
2. **Web Worker** — kernel workers for off-main-thread CAD processing
3. **Node.js** — CLI (`@taucad/cli`), test runners (Vitest), server-side rendering

The original implementation used `data:text/javascript` URLs universally:

```javascript
const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
const mod = await import(url);
```

This broke in Node.js when ESM loader hooks (`@oxc-node/core/register`, `tsx`, `ts-node/esm`) are active — the hooks intercept all `import()` calls and reject `data:` URLs with `ERR_UNKNOWN_BUILTIN_MODULE` or `ERR_INVALID_URL`. This is not a Node.js limitation (Node natively supports `data:` URL imports since v12.10.0) but a loader-hook ecosystem problem.

## Methodology

1. Surveyed the Node.js `vm` module API documentation (v20.x through v25.9.0) and stabilization roadmap (nodejs/node#37648)
2. Analyzed the April 2026 `vm/modules` redesign proposal (nodejs/node#62720)
3. Reviewed `data:` URL import support history (nodejs/node#43060, nodejs/node#42860)
4. Examined ESM loader hook behavior with `tsx`, `@oxc-node/core/register`, and `@swc-node/register`
5. Benchmarked and compared approaches via zachleat's `javascript-eval-modules` research repository
6. Reviewed production implementations: `import-module-string`, `module-from-string`, Vite's inline worker strategy, Deno's `eval` auto-detection (denoland/deno#32472)
7. Tested `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` (Node.js v20.12.0+) for dynamic `import()` support in `vm.Script`

## Environment Landscape

| Environment                 | `import('data:...')` | `import(Blob URL)`     | `vm.Script`  | `vm.SourceTextModule` | Temp file `import()` |
| --------------------------- | -------------------- | ---------------------- | ------------ | --------------------- | -------------------- |
| Node.js (vanilla)           | Yes (v12.10+)        | No (blob: unsupported) | Yes (stable) | Experimental          | Yes                  |
| Node.js + loader hooks      | **Broken**           | No                     | Yes (stable) | Experimental          | Yes                  |
| Browser main thread         | Yes                  | Yes                    | N/A          | N/A                   | N/A                  |
| Web Worker (dedicated)      | Yes                  | Yes                    | N/A          | N/A                   | N/A                  |
| Web Worker (shared/service) | Yes                  | Yes                    | N/A          | N/A                   | N/A                  |
| Deno                        | Yes                  | Yes (blob: supported)  | Partial      | No                    | Yes                  |
| Bun                         | Yes                  | Yes                    | Partial      | No                    | Yes                  |

## Findings

### Finding 1: `data:` URL imports break under ESM loader hooks

Node.js natively supports `import('data:text/javascript,...')` since v12.10.0. However, ESM loader hooks registered via `--import` or `module.register()` intercept **all** `import()` calls. Loaders like `@oxc-node/core/register` (used by `@taucad/cli`) and `tsx` attempt to resolve data URLs as file paths, producing:

- `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: data:text/javascript;...`
- `ERR_INVALID_URL` (tsx appends `?tsx-namespace=` to data URLs — privatenumber/tsx#750)

This is documented in nodejs/node#43060 (closed 2022, regression fixed for vanilla Node) and tsx#750 (opened October 2025). The issue is architectural: loader hooks lack a `shortCircuit` convention for URL schemes that Node's default resolver already handles.

Evidence: `@taucad/cli` uses `node --import @oxc-node/core/register` for TypeScript support. The runtime's `executeCode` function (esbuild-core.ts) originally used `data:text/javascript` URLs universally, which worked in browser/worker environments but failed in the CLI context.

### Finding 2: Blob URLs are the correct browser/worker approach

Blob URLs (`URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))`) are the idiomatic browser approach and work in all modern browsers (Chrome, Firefox, Safari, WebKit). Key properties:

- **No URL encoding overhead** — code is stored as-is in memory (unlike `encodeURIComponent` for data URLs)
- **No size limits** — data URLs have practical limits (Chrome: 512 MB, Firefox: 512 MB, Safari: 2048 MB), but Blob URLs are memory-bound only
- **Revocable** — `URL.revokeObjectURL()` enables explicit cleanup
- **ESM-compatible** — `export`/`import` syntax works correctly when the Blob has `type: 'text/javascript'` or `type: 'application/javascript'`

Blob URLs do **not** work in Node.js: `import(blob:...)` throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` — "Only URLs with a scheme in: file, data, and node are supported." This has been the case through v25.x with no fix planned.

### Finding 3: `node:vm` ESM support remains experimental (April 2026)

The `vm.SourceTextModule` API has been behind `--experimental-vm-modules` since Node.js v12 (~2019). As of April 2026:

- **Stabilization roadmap** (nodejs/node#37648): Several blockers resolved but still open
- **New API proposal** (nodejs/node#62720, April 13, 2026): Proposes replacing `vm.SourceTextModule` with new `vm/modules` module exporting `SourceTextModule`, `SyntheticModule`, and `SourceTextModuleLoader` — the existing API accumulated too much technical debt
- **Memory leaks fixed** (nodejs/node#59118): Resolved in 2026
- **`vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`** (Node.js v20.12.0+, stable): Allows `vm.Script` to handle dynamic `import()` without `--experimental-vm-modules`, but does not enable static `import`/`export` syntax — only dynamic `import()` calls within `vm.Script` code

The critical limitation: `vm.Script` cannot parse ESM syntax (`export`, `import` declarations). It only evaluates scripts, not modules. Only `vm.SourceTextModule` can parse ESM, and it requires the experimental flag. The `USE_MAIN_CONTEXT_DEFAULT_LOADER` constant helps `vm.Script` support dynamic `import()`, but our bundled output uses static `export` declarations — making `vm.Script` unsuitable without wrapping.

### Finding 4: Temp-file `import()` is the production Node.js pattern

When ESM loader hooks are active and `data:` URLs fail, the reliable pattern is writing code to a temporary `.mjs` file and importing it via `file://` URL:

```javascript
const tmpFile = path.join(os.tmpdir(), `exec-${process.pid}-${counter}.mjs`);
fs.writeFileSync(tmpFile, code, 'utf8');
try {
  return await import(`file://${tmpFile}?v=${counter}`);
} finally {
  fs.unlinkSync(tmpFile);
}
```

Properties:

- **Universally compatible** — works with all loader hooks (they pass `file://` through to the default resolver)
- **Cache-busting** — Node.js caches modules by URL; appending a query parameter (`?v=N`) forces re-evaluation
- **Synchronous write, async import** — `writeFileSync` + `import()` minimizes window for race conditions
- **Cleanup** — best-effort `unlinkSync` in `finally`; OS reclaims on process exit regardless

This pattern is used by Vite's dev server (inline workers use `data:text/javascript` with `encodeURIComponent` in browsers, file-backed modules in Node SSR), and by `@taucad/runtime`'s current `executeCodeNode` implementation.

### Finding 5: `vm.Script` + wrapping is theoretically viable but impractical

A theoretically clean approach: wrap ESM code in a `vm.Script` that uses dynamic `import()` with `USE_MAIN_CONTEXT_DEFAULT_LOADER`:

```javascript
const script = new vm.Script(`(async () => await import('data:text/javascript,${encodeURIComponent(code)}'))()`, {
  importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const mod = await script.runInThisContext();
```

Problems:

1. **Circular** — the inner `import('data:...')` still hits the loader-hook interception problem. Using `file://` instead requires a temp file anyway, reducing to Finding 4.
2. **Experimental warning** — `USE_MAIN_CONTEXT_DEFAULT_LOADER` emits an experimental warning when the default loader handles the `import()`
3. **No added value** — if we must write a temp file, the `vm.Script` wrapper adds complexity without benefit over a direct `import()` of the temp file
4. **Security theater** — `vm.Script` runs in the same V8 isolate; it does not provide sandbox isolation

### Finding 6: The `import-module-string` package solves a different problem

Zachleat's `import-module-string` (v2.0.3, March 2026) is the state-of-the-art for evaluating ESM strings with relative/bare imports across runtimes. It uses `esm-import-transformer` to recursively rewrite `import` declarations to inline `data:`/Blob URLs.

This solves the **import resolution** problem (relative/bare specifiers in code strings) but not the **loader-hook interception** problem. Since `@taucad/runtime`'s esbuild bundler already resolves and inlines all imports (the output is a single self-contained ESM module), `import-module-string`'s import transformation is unnecessary. The package would still fail in Node.js with loader hooks because it uses `data:` URLs internally.

### Finding 7: `new Function()` cannot evaluate ESM syntax

The `Function` constructor is the fastest dynamic code execution mechanism (~83M ops/sec vs ~389 ops/sec for Blob imports per MeasureThat.net benchmarks). However, it evaluates scripts, not modules — `export`/`import` syntax produces `SyntaxError`. Since esbuild outputs ESM (`export default`, `export { ... }`), `new Function()` is unusable without a format transformation step to CJS, which would require additional esbuild configuration and lose ESM semantics (top-level `await`, named exports).

### Finding 8: `require()` in Node.js-only files needs `createRequire` in ESM

Files like `from-node-fs.ts` and `executeCodeNode` use bare `require()` for Node.js builtins (`node:fs`, `node:path`, `node:os`). This works when the consuming code runs through a loader that provides `require` (e.g., Vitest, `@oxc-node/core/register`) but fails in strict ESM contexts.

The correct pattern for Node.js-only code in an ESM package:

```javascript
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
```

However, for `@taucad/runtime` which is consumed as source (not built output), these `require()` calls are guarded by `isNode()` checks and are tree-shaken from browser builds by esbuild. The `require()` calls are an acceptable pragmatic choice — they work in all current Node.js consumption patterns (Vitest, `@oxc-node/core/register`, `tsx`) because those loaders provide `require`. A `createRequire` refactor is recommended only if a strict ESM consumer surfaces.

## Recommendations

| #   | Action                                                                                                                                                                     | Priority | Effort | Impact                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------- |
| R1  | Keep environment-gated `executeCode`: Blob URL for browser/worker, temp-file `import()` for Node.js                                                                        | P0       | Done   | High — unblocks CLI and test-runner usage |
| R2  | Keep bare `require()` in Node.js-gated code paths (`executeCodeNode`, `fromNodeFS`); refactor to `createRequire` only if a strict ESM consumer surfaces                    | P1       | Low    | Medium — avoids unnecessary churn         |
| R3  | Monitor `vm/modules` proposal (nodejs/node#62720) for stabilization; when stable, consider replacing temp-file pattern with `SourceTextModule` evaluation                  | P2       | N/A    | Medium — eliminates filesystem I/O        |
| R4  | Add `data:` URL fallback in `executeCodeNode` for environments where loader hooks are known-absent (e.g., vanilla `node` without `--import`), guarded by a capability test | P3       | Medium | Low — marginal perf improvement           |

## Trade-offs

| Approach               | Browser | Worker | Node.js (vanilla) | Node.js (+ loader)  | Perf    | Complexity | ESM exports           |
| ---------------------- | ------- | ------ | ----------------- | ------------------- | ------- | ---------- | --------------------- |
| `import('data:...')`   | Yes     | Yes    | Yes               | **No**              | High    | Low        | Yes                   |
| `import(Blob URL)`     | Yes     | Yes    | No                | No                  | High    | Low        | Yes                   |
| Temp file `import()`   | N/A     | N/A    | Yes               | Yes                 | Medium  | Medium     | Yes                   |
| `vm.SourceTextModule`  | N/A     | N/A    | Experimental      | Experimental        | High    | High       | Yes                   |
| `vm.Script` + wrapper  | N/A     | N/A    | Partial           | Partial             | Medium  | High       | Via `import()` only   |
| `new Function()`       | Yes     | Yes    | Yes               | Yes                 | Highest | Low        | **No** (scripts only) |
| `import-module-string` | Yes     | Yes    | Yes               | **No** (data: URLs) | High    | Medium     | Yes                   |
| `module-from-string`   | N/A     | N/A    | Yes               | Depends             | Medium  | Medium     | Yes (via vm)          |

### Why not `vm.Script` + `USE_MAIN_CONTEXT_DEFAULT_LOADER`?

This approach appears elegant in isolation: use a stable API (`vm.Script`, Stability: 2) with a stable constant (`USE_MAIN_CONTEXT_DEFAULT_LOADER`, v20.12.0+) to avoid the experimental `--experimental-vm-modules` flag. However, it collapses to the temp-file pattern once loader hooks are present — the inner `import()` still needs a `file://` URL. The `vm.Script` wrapper adds indirection without adding value in our use case.

### Why not `data:` URLs universally?

Data URLs work in vanilla Node.js and all browsers. The blocker is exclusively ESM loader hooks, which are increasingly common in TypeScript-first development. Since `@taucad/cli` requires TypeScript execution (via `@oxc-node/core/register`), and Vitest uses its own loader hooks, `data:` URLs fail in both primary Node.js consumption patterns. The temp-file approach costs ~1-2ms of filesystem I/O — negligible compared to the ~100-500ms esbuild bundle step that precedes it.

## Code Examples

### Current implementation (recommended)

```typescript
export async function executeCode(code: string): Promise<ExecuteResult> {
  const cached = executeCacheMap.get(code);
  if (cached !== undefined) {
    return { success: true, value: cached };
  }

  try {
    let moduleExports: unknown;

    if (isNode()) {
      moduleExports = await executeCodeNode(code);
    } else {
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        moduleExports = await import(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    executeCacheMap.set(code, moduleExports);
    return { success: true, value: moduleExports };
  } catch (error) {
    return {
      success: false,
      issues: [{ message: error instanceof Error ? error.message : String(error), type: 'runtime', severity: 'error' }],
    };
  }
}

async function executeCodeNode(code: string): Promise<unknown> {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');

  const tmpFile = path.join(os.tmpdir(), `taucad-exec-${process.pid}-${++counter}.mjs`);
  fs.writeFileSync(tmpFile, code, 'utf8');
  try {
    return await import(`file://${tmpFile}?v=${counter}`);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* best-effort */
    }
  }
}
```

### Future: `vm.SourceTextModule` (when stable)

```typescript
async function executeCodeVm(code: string): Promise<unknown> {
  const { SourceTextModule } = await import('vm/modules');

  const mod = new SourceTextModule(code, { identifier: 'taucad://bundled' });
  // New API: synchronous linking for modules without dependencies
  mod.instantiate();
  const result = await mod.evaluate();
  return mod.namespace;
}
```

This would eliminate filesystem I/O entirely but is blocked on the `vm/modules` proposal (nodejs/node#62720) reaching stability.

## References

- [nodejs/node#43060](https://github.com/nodejs/node/issues/43060) — Cannot import builtins in data: URL module
- [nodejs/node#37648](https://github.com/nodejs/node/issues/37648) — Roadmap for stabilization of vm modules
- [nodejs/node#62720](https://github.com/nodejs/node/issues/62720) — Proposal: new vm module primitives & loader API for ESM customization (April 2026)
- [nodejs/node#51244](https://github.com/nodejs/node/pull/51244) — vm: support using the default loader to handle dynamic import()
- [privatenumber/tsx#750](https://github.com/privatenumber/tsx/issues/750) — tsImport from tsx adds ?tsx-namespace to data urls
- [zachleat/javascript-eval-modules](https://github.com/zachleat/javascript-eval-modules) — Comprehensive playground for dynamic script execution methods
- [zachleat — How to import() a JavaScript String](https://www.zachleat.com/web/dynamic-import/) — Analysis of data URL and Blob URL approaches (June 2025)
- [import-module-string](https://github.com/zachleat/import-module-string) — Multi-runtime ESM string evaluation (v2.0.3, March 2026)
- [module-from-string](https://github.com/exuanbo/module-from-string) — Node.js vm-based module evaluation (v3.3.1)
- [2ality — Evaluating JavaScript code via import()](https://2ality.com/2019/10/eval-via-import.html) — Dr. Axel Rauschmayer's foundational analysis
- [Node.js vm documentation (v25.9.0)](https://nodejs.org/dist/latest/docs/api/vm.html) — vm.Script, vm.SourceTextModule, vm.constants
- [denoland/deno#32472](https://github.com/denoland/deno/pull/32472) — Deno eval auto-detects CJS vs ESM (March 2026)

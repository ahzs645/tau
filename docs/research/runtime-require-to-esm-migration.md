---
title: 'Runtime require() to ESM Migration'
description: 'Audit of require() usage in @taucad/runtime and plan to migrate to ESM-first with polymorphic environment isolation'
status: active
created: '2026-04-16'
updated: '2026-04-16'
category: audit
related:
  - docs/research/polymorphic-js-evaluation.md
---

# Runtime require() to ESM Migration

Comprehensive audit of all `require()` usage in `@taucad/runtime`, analysis of the polymorphic environment challenges they create, and a recommended migration plan to ESM-first patterns that ensure browser consumers never encounter Node.js builtin warnings or errors.

## Executive Summary

`@taucad/runtime` contains 4 production files with `require()` calls for Node.js builtins (`node:fs`, `node:os`, `node:path`, `node:worker_threads`). These exist because the package is isomorphic — the same source runs in browser Web Workers, Node.js CLI, and test runners. While `require()` was used to prevent bundlers from statically analyzing and externalizing the imports, this approach has three problems: (1) it fails in strict ESM `.mjs` contexts (the CLI's temp-file execution), (2) it requires lint suppressions on every call site, and (3) it doesn't actually prevent all bundler warnings since Vite/Rollup recognize `require()` tokens. The recommended fix is a two-layer strategy: **dynamic `await import()`** for Node.js builtins inside environment-gated functions, combined with **separate subpath exports** (`@taucad/runtime/filesystem/node`) for Node.js-only modules like `fromNodeFS`.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [References](#references)

## Problem Statement

Three symptoms triggered this investigation:

1. **CLI execution failure**: `@taucad/cli`'s temp-file evaluation (`.mjs`) fails with `ReferenceError: require is not defined` because esbuild-bundled CAD code is executed in a strict ESM context where `require()` is unavailable.

2. **Bundler pollution risk**: Browser consumers building with Vite/Rollup see `require('node:fs')` tokens in the source (since `@taucad/runtime` is consumed as source via `"exports": { ".": "./src/index.ts" }`). While these are inside `isNode()` guards, bundlers may still emit warnings about unresolvable Node.js builtins.

3. **Lint noise**: Every `require()` call requires 3 lint suppression comments (`@typescript-eslint/no-require-imports`, `unicorn/prefer-module`, `@typescript-eslint/consistent-type-imports`), adding 9+ suppression lines per call site.

## Methodology

1. `grep -r 'require(' packages/runtime/src/` to inventory all `require()` usage
2. Analyzed each call site's environment context (browser-reachable vs Node-only)
3. Reviewed `package.json` exports structure for subpath isolation opportunities
4. Researched conditional exports (`"node"`, `"browser"`, `"default"` conditions) in Node.js 22–25 and npm packaging best practices (April 2026)
5. Tested `await import('node:fs')` behavior in esbuild `platform: 'browser'` builds and Vite dev mode
6. Reviewed Vite's handling of dynamic `import()` with `node:` prefix in dead-code branches (vitejs/vite#21121, #21326, #5676)
7. Reviewed esbuild's platform-conditional branching patterns (evanw/esbuild#3992)

## Findings

### Finding 1: Complete `require()` inventory (4 production files)

| File                                          | Modules Required                  | Call Site Context                           | Browser-Reachable?                               |
| --------------------------------------------- | --------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| `bundler/esbuild-core.ts` (`executeCodeNode`) | `node:fs`, `node:os`, `node:path` | Inside `isNode()` branch of `executeCode()` | Yes (same module as browser `executeCode`)       |
| `filesystem/from-node-fs.ts`                  | `node:fs/promises`, `node:path`   | Top of function body                        | Yes (exported via `@taucad/runtime/filesystem`)  |
| `framework/runtime-message-adapter.ts`        | `node:worker_threads`             | Inside try-catch in `getNodeParentPort()`   | Yes (imported by kernel worker entry)            |
| `framework/environment.ts` (`resolveFileUrl`) | `node:url` (via `await import`)   | Inside `isNode()` guard                     | Yes (already uses ESM `import()` — no `require`) |

Additionally, 2 test files contain `require()` in test fixtures (user-authored CJS-style CAD scripts) — these are intentional and not migration targets.

### Finding 2: The `require()` pattern was chosen to hide imports from bundlers

The original rationale (documented in lint suppression comments): "dynamic require avoids bundling Node.js builtins in browser builds." The idea is that `require('node:fs')` as a dynamic expression is not statically analyzable, so bundlers won't try to resolve it.

This is partially true:

- **esbuild** (`platform: 'browser'`): Does not resolve `require()` calls — it leaves them as-is or externalizes them. However, the resulting code still contains `require()` tokens, which fail at runtime in strict ESM.
- **Vite/Rollup**: Recognizes `require()` tokens during SSR and pre-bundling. In dev mode, Vite may emit "Module externalized for browser compatibility" warnings.
- **`@oxc-node/core/register`**: Provides `require()` in the calling module's scope, but the temp `.mjs` file evaluated via `import()` does NOT have `require()` since it's a standalone ESM module.

### Finding 3: `await import('node:...')` is the correct ESM replacement

Dynamic `await import('node:fs')` is the ESM-native equivalent of `require('node:fs')`. Key properties:

- **Tree-shakeable in dead-code branches**: Vite fixed `import()` inside unreachable code branches in v6.1 (vitejs/vite#21326, closed January 2026). When behind an `isNode()` guard that evaluates to `false` at build time, the dynamic import is eliminated.
- **No `require` dependency**: Works in strict `.mjs` files and any ESM context without needing `createRequire`.
- **Async**: Unlike `require()`, `await import()` is async. All call sites in the runtime are already in async functions, so this is a non-issue.
- **Already proven**: `environment.ts:resolveFileUrl` already uses `await import('node:url')` successfully — this is the established pattern in the codebase.

### Finding 4: `fromNodeFS` needs its own subpath export

`fromNodeFS` is Node-only by definition (it wraps `node:fs/promises`), but it's currently co-exported with browser-safe code from `@taucad/runtime/filesystem`. This means any consumer importing `@taucad/runtime/filesystem` pulls in `fromNodeFS` and its `require('node:fs/promises')` reference, even if they only need `fromMemoryFS` or `fromFsLike`.

The fix is a separate subpath: `@taucad/runtime/filesystem/node`. This uses the package.json `exports` field to isolate Node-only code into an explicitly opted-in subpath that browser consumers never import.

### Finding 5: `runtime-message-adapter.ts` try-catch pattern is safe but suboptimal

The `getNodeParentPort()` function uses try-catch around `require('node:worker_threads')`:

```typescript
function getNodeParentPort() {
  try {
    const workerThreads = require('node:worker_threads');
    return workerThreads.parentPort ?? undefined;
  } catch {
    return undefined;
  }
}
```

esbuild treats `require()` inside try-catch as an optional dependency (evanw/esbuild#3992) — it won't error during bundling. However, this still leaves `require()` tokens in the output. Converting to `await import()` would make this ESM-clean while maintaining the same graceful-failure semantics.

### Finding 6: Bundler behavior with `import('node:...')` in browser builds

When esbuild encounters `import('node:fs')` with `platform: 'browser'`:

- It externalizes the import (marks it as external)
- The import remains in the output but is never reached if inside a dead `isNode()` branch

When Vite encounters `import('node:fs')`:

- In dev mode (SSR): Uses Node's native resolution — works fine
- In client build: Externalizes with a warning — "Module 'node:fs' has been externalized for browser compatibility"
- With Vite 6.1+ (January 2026): Dynamic imports inside unreachable code paths are properly eliminated, so the warning should not appear if the branch is dead-code-eliminated

The key insight: `import('node:fs')` inside an `if (isNode())` guard where `isNode()` can be statically determined to be `false` during browser builds (via `--define` or platform detection) will be tree-shaken. Since `@taucad/runtime` runs in Web Workers where `process.versions.node` is undefined, the `isNode()` guard is effectively `false` at runtime, but **bundlers cannot statically prove this** without `--define` hints.

### Finding 7: Conditional exports with `"node"` condition

Package.json `exports` supports a `"node"` condition that is only matched by Node.js runtimes (not browser bundlers). This is the cleanest way to provide environment-specific code:

```json
{
  "exports": {
    "./filesystem": {
      "node": "./src/filesystem/index.node.ts",
      "default": "./src/filesystem/index.ts"
    }
  }
}
```

However, this approach has a major caveat for `@taucad/runtime`: the package is consumed as **source** inside the monorepo (exports point to `.ts` files). Conditional exports with `"node"` conditions work at the npm resolution level but are not uniformly respected by all build tools during source-level consumption. Vite respects `exports` conditions via `resolve.conditions`, but the behavior during dev vs build may differ.

The safer approach is explicit subpath separation: consumers import `@taucad/runtime/filesystem/node` when they want Node-specific code, and `@taucad/runtime/filesystem` when they want browser-safe code. This is explicit, unambiguous, and works with every bundler.

### Finding 8: The `executeCodeNode` problem is architectural, not syntactic

The `require()` in `executeCodeNode` is not just a syntax issue — it's a code placement issue. `executeCodeNode` lives in `esbuild-core.ts` alongside 1000+ lines of browser-compatible bundler code. This means:

1. Every consumer of the esbuild bundler (including browser kernel workers) transitively imports `executeCodeNode`
2. The `require('node:fs')` / `require('node:os')` / `require('node:path')` tokens are visible to the browser build toolchain
3. Even after converting to `await import()`, the dynamic `import('node:fs')` will appear in the browser bundle (externalized but present)

The architectural fix: extract `executeCodeNode` into a separate module that is lazily imported only in Node.js contexts. Since `executeCode` already has an `if (isNode())` branch, the lazy import pattern is:

```typescript
if (isNode()) {
  const { executeCodeNode } = await import('./execute-code-node.js');
  moduleExports = await executeCodeNode(code);
}
```

This ensures the Node.js-specific module (and its `import('node:fs')` references) never enters the browser bundle's module graph.

## Recommendations

| #   | Action                                                                                                                                                   | Priority | Effort | Impact                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------------------------------------------------- |
| R1  | Extract `executeCodeNode` into `bundler/execute-code-node.ts`, lazily import it from `executeCode` via `await import()` inside the `isNode()` branch     | P0       | Medium | High — unblocks CLI, eliminates `node:fs`/`node:os`/`node:path` from browser bundle |
| R2  | Convert `executeCodeNode` internals from `require()` to `await import()` for `node:fs`, `node:os`, `node:path`                                           | P0       | Low    | High — eliminates `require` dependency in ESM temp files                            |
| R3  | Move `fromNodeFS` to a dedicated `@taucad/runtime/filesystem/node` subpath export; remove it from `@taucad/runtime/filesystem` barrel                    | P1       | Low    | Medium — prevents browser consumers from pulling in `node:fs/promises`              |
| R4  | Convert `runtime-message-adapter.ts` `getNodeParentPort()` from `require('node:worker_threads')` to `await import('node:worker_threads')` with try-catch | P1       | Low    | Low — consistency; removes last `require()` from production code                    |
| R5  | After all migrations, add an ESLint rule (or oxlint rule) banning `require()` in `packages/runtime/src/` to prevent regressions                          | P2       | Low    | Medium — enforces ESM-first going forward                                           |

## Trade-offs

### `await import()` vs `require()` for Node.js builtins

| Dimension             | `require()`                           | `await import()`                                        |
| --------------------- | ------------------------------------- | ------------------------------------------------------- |
| ESM compatibility     | Fails in strict `.mjs`                | Works everywhere                                        |
| Bundler visibility    | Partially hidden (dynamic expression) | Visible but tree-shakeable                              |
| Sync vs async         | Synchronous                           | Asynchronous (requires `await`)                         |
| Lint suppressions     | 3 per call site                       | 0                                                       |
| Dead-code elimination | Not eliminated by bundlers            | Eliminated by Vite 6.1+ / Rollup 3.21+ in dead branches |

### Separate subpath vs conditional export for `fromNodeFS`

| Approach                                             | Pros                                                   | Cons                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `@taucad/runtime/filesystem/node` (separate subpath) | Explicit opt-in; works with all bundlers; no ambiguity | Consumers must know to import the `/node` subpath                                         |
| `"node"` conditional export                          | Automatic; consumers import the same path              | May not be respected by all build tools during source consumption; harder to reason about |

**Recommendation**: Separate subpath. Explicitness is more valuable than magic for a library with diverse consumers.

### Lazy `import()` vs co-located code for `executeCodeNode`

| Approach                                                  | Pros                                                              | Cons                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| Lazy `import('./execute-code-node.js')` inside `isNode()` | Node-only code never enters browser bundle; clean module boundary | One extra file; one extra dynamic import per first execution          |
| Co-located in `esbuild-core.ts` (current)                 | Single file; no import overhead                                   | `node:fs` tokens visible to browser bundler; externalization warnings |

**Recommendation**: Lazy import. The one-time dynamic import cost (~0.1ms for a same-package module) is negligible compared to the bundling/evaluation it precedes (~100-500ms).

## Code Examples

### R1 + R2: Extracted `execute-code-node.ts` with ESM imports

```typescript
// packages/runtime/src/bundler/execute-code-node.ts

let counter = 0;

export async function executeCodeNode(code: string): Promise<unknown> {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const tmpFile = path.join(os.tmpdir(), `taucad-exec-${process.pid}-${++counter}.mjs`);
  fs.writeFileSync(tmpFile, code, 'utf8');
  try {
    return await import(`file://${tmpFile}?v=${counter}`);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }
}
```

### R1: Updated `executeCode` with lazy import

```typescript
// In esbuild-core.ts
export async function executeCode(code: string): Promise<ExecuteResult> {
  const cached = executeCacheMap.get(code);
  if (cached !== undefined) {
    return { success: true, value: cached };
  }

  try {
    let moduleExports: unknown;

    if (isNode()) {
      const { executeCodeNode } = await import('#bundler/execute-code-node.js');
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
```

### R3: Separate filesystem subpath

```json
// In package.json exports (dev mode)
{
  "./filesystem": "./src/filesystem/index.ts",
  "./filesystem/node": "./src/filesystem/from-node-fs.ts"
}
```

```typescript
// Consumer: Node.js CLI
import { fromNodeFS } from '@taucad/runtime/filesystem/node';

// Consumer: Browser app (never touches node:fs)
import { fromMemoryFS } from '@taucad/runtime/filesystem';
```

### R4: Converted `getNodeParentPort`

```typescript
async function getNodeParentPort(): Promise<import('node:worker_threads').MessagePort | undefined> {
  try {
    const workerThreads = await import('node:worker_threads');
    return workerThreads.parentPort ?? undefined;
  } catch {
    return undefined;
  }
}
```

## References

- [Node.js Conditional Exports](https://nodejs.org/api/packages.html#conditional-exports) — `"node"`, `"browser"`, `"default"` conditions
- [vitejs/vite#21326](https://github.com/vitejs/vite/issues/21326) — Dead-code elimination of dynamic imports in unreachable branches (fixed January 2026)
- [vitejs/vite#21121](https://github.com/vitejs/vite/issues/21121) — Async imports tree-shaking (fixed March 2026)
- [evanw/esbuild#3992](https://github.com/evanw/esbuild/issues/3992) — Platform-conditional branching patterns
- [esmodules.com/publishing](https://esmodules.com/publishing/) — ESM package publishing best practices (2026)
- [debugg.ai — JS Runtimes Have Forked](https://debugg.ai/resources/js-runtimes-have-forked-2025-cross-runtime-libraries-node-bun-deno-edge-workers) — Cross-runtime library authoring (2025)
- Related: `docs/research/polymorphic-js-evaluation.md` — Companion research on ESM code string evaluation across environments

---
title: 'TypeScript ESM Extension Resolution'
description: 'Analysis of TypeScript ESM .js→.ts extension resolution and how Tau VFS plugin diverges from standard bundler behavior'
status: active
created: '2026-04-02'
updated: '2026-04-02'
category: investigation
related:
  - docs/research/unresolved-dependency-watch-gap.md
---

# TypeScript ESM Extension Resolution

Investigation into how TypeScript's ESM module resolution handles `.js` import extensions resolving to `.ts` source files, how standard bundlers implement this, and where Tau's VFS esbuild plugin diverges — causing ENOENT errors when AI agents use `.js` extensions in imports.

## Executive Summary

TypeScript has supported resolving `.js` import specifiers to `.ts` source files since TypeScript 2.0, and every major bundler (native esbuild, Vite, Rollup, webpack) implements this behavior. Tau's custom VFS esbuild plugin bypasses esbuild's native resolver with a custom `onResolve` handler that does not implement this remapping — the `resolveFileExtension` function bails early when the import already has an extension. This causes ENOENT errors when AI models write `import './lib/nozzle.js'` while the source file is `nozzle.ts`. The fix requires two changes: (1) extension remapping in `resolveFileExtension` and (2) cross-extension variant tracking in the `unresolvedPaths` watch set.

## Problem Statement

Observed in production: an AI model (Gemini 3.1 Pro) creating a multi-file CAD project writes `main.ts` with:

```typescript
import { makeNozzleBase } from './lib/nozzle.js';
```

The model then creates `lib/nozzle.ts`. The kernel reports:

```
Failed to load 'lib/nozzle.js': ENOENT: no such file or directory '/projects/.../lib/nozzle.js'
```

The file exists — but as `.ts`, not `.js`. The model must then correct its own import extension to `.ts`, wasting a tool call and degrading user experience.

This is distinct from the missing-file watch gap (documented in `docs/research/unresolved-dependency-watch-gap.md`). That bug occurs when the file doesn't exist at all yet. This bug occurs when the file exists but with a different (TypeScript) extension.

## Methodology

1. Source analysis of Tau's `resolveFileExtension` and `onResolve` in `packages/runtime/src/bundler/esbuild-core.ts`
2. Review of TypeScript compiler's extension resolution algorithm (PR #51471, PR #8895)
3. Review of esbuild's native resolver source (`resolver.go` extension swap logic)
4. Review of Vite's `.js`→`.ts` resolution fix (PR #18889, merged Vite 6.1)
5. Review of TypeScript `moduleResolution` modes (`bundler`, `nodenext`) and `allowImportingTsExtensions`

## Findings

### Finding 1: TypeScript has resolved `.js` specifiers to `.ts` files since v2.0

TypeScript's module resolution algorithm, when encountering an import like `./module.js`, attempts the following resolution order:

| Step | Tried path      | Extension swap  |
| ---- | --------------- | --------------- |
| 1    | `./module.ts`   | `.js` → `.ts`   |
| 2    | `./module.tsx`  | `.js` → `.tsx`  |
| 3    | `./module.d.ts` | `.js` → `.d.ts` |
| 4    | `./module.js`   | literal match   |

This behavior was introduced in [TypeScript PR #8895](https://github.com/microsoft/TypeScript/pull/8895) and applies regardless of the `moduleResolution` setting. It was the original mechanism enabling the `NodeNext` convention of writing `.js` extensions in ESM imports even when source files are `.ts`.

### Finding 2: The canonical extension remapping table

TypeScript and esbuild both use a well-defined set of cross-extension mappings:

| Import extension | Tried alternatives (in order) |
| ---------------- | ----------------------------- |
| `.js`            | `.ts`, `.tsx`, `.d.ts`        |
| `.jsx`           | `.tsx`, `.d.ts`               |
| `.mjs`           | `.mts`, `.d.mts`              |
| `.cjs`           | `.cts`, `.d.cts`              |

For Tau's runtime context (no declaration files, no `.mjs`/`.cjs`), the relevant subset is:

| Import extension | Tried alternatives |
| ---------------- | ------------------ |
| `.js`            | `.ts`, `.tsx`      |
| `.jsx`           | `.tsx`             |

### Finding 3: Every major bundler implements this natively

| Bundler              | `.js`→`.ts` support | Mechanism                                                                                          |
| -------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| **esbuild** (native) | Yes                 | Built into `resolver.go`; extension swap before filesystem lookup                                  |
| **Vite**             | Yes (since 6.1)     | [PR #18889](https://github.com/vitejs/vite/pull/18889) — resolved regardless of `moduleResolution` |
| **Rollup**           | Yes                 | Via `@rollup/plugin-typescript`                                                                    |
| **webpack**          | Yes                 | Via `resolve.extensions` config                                                                    |
| **Bun**              | Yes                 | Native TypeScript support                                                                          |
| **Deno**             | Yes                 | Native TypeScript support                                                                          |

The Vite fix is particularly relevant — the maintainers initially thought this behavior depended on `moduleResolution: "Node16"`, but discovered it has been supported since TypeScript 2.0 across all modes.

### Finding 4: Tau's VFS plugin bypasses esbuild's native resolution

Tau's esbuild plugin registers a custom `onResolve` handler that intercepts **all** imports (filter: `/.*/`). This is necessary because the plugin serves files from a virtual filesystem (VFS) rather than the real disk. However, it means esbuild's built-in extension resolution — including the `.js`→`.ts` swap — is completely bypassed.

The resolution function in `esbuild-core.ts`:

```typescript
async function resolveFileExtension(filesystem, path) {
  // If already has extension, return as-is
  if (/\.[jt]sx?$/.test(path)) {
    return path; // ← BAILS HERE for './lib/nozzle.js'
  }

  // Try common extensions in order (never reached for .js imports)
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
  // ...
}
```

When `./lib/nozzle.js` is imported, the regex `/\.[jt]sx?$/` matches, and the function returns the path unchanged. No attempt is made to check if `nozzle.ts` or `nozzle.tsx` exists instead.

### Finding 5: The `unresolvedPaths` watch set also misses cross-extension variants

The recently added `unresolvedPaths` tracking (from the unresolved dependency watch gap fix) has two tracking points:

1. **`onResolve`** (line 458): Only adds extension variants for extensionless imports (`!/\.[jt]sx?$/.test(resolvedPath)`). Imports with explicit `.js` extension skip this entirely.
2. **`onLoad`** catch block (line 611): Adds the literal failed path (`nozzle.js`). But the file that actually exists is `nozzle.ts`, so the watch set contains the wrong path.

### Finding 6: AI models frequently produce `.js` extension imports

This is a high-frequency issue because:

- TypeScript's `NodeNext` convention (dominant in documentation and training data) requires `.js` extensions
- AI models trained on ESM-heavy codebases often produce `.js` import specifiers
- The Tau editor uses `.ts` source files exclusively — there are no `.js` files to import
- The mismatch between what the model writes (`.js`) and what exists (`.ts`) is a systematic friction point

## Recommendations

| #   | Action                                                              | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Add `.js`→`.ts` extension remapping in `resolveFileExtension`       | P0       | Low    | High   |
| R2  | Add cross-extension variants to `unresolvedPaths` in `onResolve`    | P1       | Low    | Medium |
| R3  | Add cross-extension variants to `unresolvedPaths` in `onLoad` catch | P1       | Low    | Medium |

### R1: Extension remapping in `resolveFileExtension`

Modify `resolveFileExtension` to try TypeScript alternatives when a `.js`/`.jsx` file doesn't exist:

```typescript
const tsExtensionSwap: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
};

async function resolveFileExtension(filesystem, path) {
  if (/\.[jt]sx?$/.test(path)) {
    // Check if the file exists with current extension first
    if (await filesystem.exists(path)) {
      return path;
    }

    // Try TypeScript extension remapping (.js → .ts, .tsx)
    const ext = path.slice(path.lastIndexOf('.'));
    const alternatives = tsExtensionSwap[ext];
    if (alternatives) {
      const basePath = path.slice(0, -ext.length);
      for (const alt of alternatives) {
        const altPath = basePath + alt;
        if (await filesystem.exists(altPath)) {
          return altPath;
        }
      }
    }

    return path;
  }

  // Extensionless resolution (unchanged)
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
  // ...
}
```

**Trade-off**: This adds one extra `filesystem.exists()` call for `.js`/`.jsx` imports that resolve successfully (the common case in CDN modules under `/node_modules/`). For project files, the overhead is negligible. For CDN modules, the exists check on the VFS is an in-memory lookup — also negligible.

### R2: Cross-extension `unresolvedPaths` in `onResolve`

When a `.js`/`.jsx` import can't be resolved (after R1's remapping), add the TypeScript variants to `unresolvedPaths` so the watch set covers both extensions:

```typescript
if (unresolvedPaths && withExtension === resolvedPath) {
  if (/\.[jt]sx?$/.test(resolvedPath)) {
    // Explicit extension failed — add cross-extension variants
    const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.'));
    const alternatives = tsExtensionSwap[ext];
    if (alternatives) {
      const basePath = resolvedPath.slice(0, -ext.length);
      for (const alt of alternatives) {
        unresolvedPaths.add(basePath + alt);
      }
    }
    unresolvedPaths.add(resolvedPath);
  } else {
    // Extensionless — add all variants (existing behavior)
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      unresolvedPaths.add(resolvedPath + ext);
    }
  }
}
```

### R3: Cross-extension `unresolvedPaths` in `onLoad` catch

When `onLoad` fails for a `.js` path, also add the `.ts` variant (and vice versa) so that creating the TypeScript file triggers a re-render:

```typescript
} catch (error) {
  const failedAbsolutePath = toAbsolute(args.path);
  if (unresolvedPaths && !failedAbsolutePath.includes('/node_modules/')) {
    unresolvedPaths.add(failedAbsolutePath);
    // Add cross-extension variants for watch-set coverage
    const ext = failedAbsolutePath.slice(failedAbsolutePath.lastIndexOf('.'));
    const alternatives = tsExtensionSwap[ext];
    if (alternatives) {
      const basePath = failedAbsolutePath.slice(0, -ext.length);
      for (const alt of alternatives) {
        unresolvedPaths.add(basePath + alt);
      }
    }
  }
  // ...
}
```

## Trade-offs

| Approach                                     | Pros                                                                                                            | Cons                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **R1 only** (resolve fix)                    | Fixes the ENOENT immediately; matches all bundler behavior                                                      | Doesn't help if file doesn't exist yet (watch gap for `.js` imports) |
| **R1 + R2 + R3** (resolve + watch)           | Complete coverage: fixes resolution AND ensures creating `.ts` files triggers re-render for stale `.js` imports | Slightly more `unresolvedPaths` entries; minor memory overhead       |
| **Rewrite to use esbuild native resolution** | Zero maintenance; inherits all esbuild resolution improvements                                                  | Impossible — VFS architecture requires custom `onResolve`/`onLoad`   |

Recommendation: implement all three (R1 + R2 + R3). R1 is the primary fix. R2 and R3 provide defense-in-depth for the file-creation timing gap.

## Scope and Non-Goals

**In scope**: `.js`↔`.ts` and `.jsx`↔`.tsx` extension remapping in the VFS esbuild plugin

**Out of scope**:

- `.mjs`/`.cjs` resolution (Tau doesn't use these in CAD scripts)
- Declaration file (`.d.ts`) resolution (handled separately by type acquisition)
- `tsconfig.json` paths remapping (not applicable in Tau's CAD editor context)

## Code Examples

### Current failure path

```
main.ts:  import { makeNozzleBase } from './lib/nozzle.js';
                                           ↓
onResolve: resolveRelativePath('./lib/nozzle.js', '/projects/.../main.ts')
         → '/projects/.../lib/nozzle.js'
                                           ↓
resolveFileExtension: /\.[jt]sx?$/ matches → return as-is
         → '/projects/.../lib/nozzle.js'
                                           ↓
onLoad: filesystem.readFile('/projects/.../lib/nozzle.js')
      → ENOENT (file is nozzle.ts, not nozzle.js)
```

### Fixed resolution path (after R1)

```
main.ts:  import { makeNozzleBase } from './lib/nozzle.js';
                                           ↓
onResolve: resolveRelativePath('./lib/nozzle.js', '/projects/.../main.ts')
         → '/projects/.../lib/nozzle.js'
                                           ↓
resolveFileExtension: /\.[jt]sx?$/ matches → check exists('.../nozzle.js')
                    → false → try swap: exists('.../nozzle.ts')
                    → true → return '/projects/.../lib/nozzle.ts'
                                           ↓
onLoad: filesystem.readFile('/projects/.../lib/nozzle.ts')
      → success, loader: 'ts'
```

## Diagrams

```
Current resolveFileExtension flow:

  path has extension? ──yes──► return path (NO existence check)
         │
         no
         │
         ▼
  try [.ts, .tsx, .js, .jsx, /index.ts, /index.js]
         │
     found? ──yes──► return path + extension
         │
         no
         │
         ▼
  return original path


Proposed resolveFileExtension flow:

  path has extension? ──yes──► exists? ──yes──► return path
         │                        │
         no                       no
         │                        │
         ▼                        ▼
  try [.ts, .tsx, .js,       try TS swap
  .jsx, /index.ts,          (.js→.ts/.tsx
  /index.js]                 .jsx→.tsx)
         │                        │
     found? ──yes──►         found? ──yes──► return swapped path
         │              return       │
         no                          no
         │                           │
         ▼                           ▼
  return original path          return original path
```

## References

- [TypeScript PR #8895](https://github.com/microsoft/TypeScript/pull/8895) — Original `.js`→`.ts` resolution support (TypeScript 2.0, 2016)
- [TypeScript PR #51471](https://github.com/microsoft/TypeScript/pull/51471) — Extension lookup priority refactor
- [TypeScript Issue #62342](https://github.com/microsoft/TypeScript/issues/62342) — Proposal to enable `allowImportingTsExtensions` by default in TS 6.0
- [Vite PR #18889](https://github.com/vitejs/vite/pull/18889) — `.js`→`.ts` resolution fix (Vite 6.1)
- [esbuild resolver.go](https://github.com/evanw/esbuild/blob/main/pkg/api/api_impl.go) — Native extension swap implementation
- Related: `docs/research/unresolved-dependency-watch-gap.md`

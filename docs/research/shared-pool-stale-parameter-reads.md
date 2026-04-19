---
title: 'SharedPool Stale Parameter Reads'
description: 'Root cause analysis of parameter overrides not affecting geometry after filePoolBuffer was wired into the kernel worker'
status: active
created: '2026-04-08'
updated: '2026-04-08'
category: investigation
related:
  - docs/research/shared-memory-pool-api-audit.md
  - docs/research/geometry-data-transfer-architecture.md
---

# SharedPool Stale Parameter Reads

Root cause investigation into why parameter overrides stopped affecting geometry output after the `filePoolBuffer` was wired into the cad machine's `client.connect()` call.

## Executive Summary

Parameter overrides stored in `.tau/parameters.json` were not reflected in geometry renders. The root cause was a missing cache invalidation path: when the kernel worker's `_invalidateCachesForPaths` cleared internal caches on file change, it did not invalidate the `SharedPool` (file pool). The bridge proxy served stale binary data from the pool, so the parameter-file-resolver middleware always read outdated values. A secondary issue was that `SharedPool.invalidate()` only worked on the writer side (FM worker), making it ineffective when called from the reader side (kernel worker).

## Problem Statement

After wiring `filePoolBuffer` into `client.connect()` (cad machine change: `client.connect({ port })` → `client.connect({ port, filePoolBuffer })`), parameter slider changes in the editor no longer affected geometry output. The UI correctly displayed modified parameter values (with asterisk indicators), but the rendered geometry did not reflect the overrides.

## Methodology

Traced the full parameter data flow from UI slider through to kernel geometry function:

1. **UI → Project machine**: `handleParametersChange` → `setCompilationUnitParameters` → `setCompilationUnitParametersInContext` updates `parameterConfig` in context
2. **parameterStoring region**: Writes serialized config to `.tau/parameters.json` via `contentService.write()`
3. **File watch**: Kernel worker detects `.tau/parameters.json` change via bridge watch subscription
4. **Cache invalidation**: `_invalidateCachesForPaths` clears `fileHashCache`, `fileContentCache`, `bundleResultCache`
5. **Re-render**: `executeRender()` → `createGeometry()` → middleware chain
6. **Middleware**: `parameterFileResolver.wrapCreateGeometry` reads `.tau/parameters.json` via `runtime.filesystem.readFile(path, 'utf8')`
7. **Bridge proxy**: `readFile` checks `SharedPool` before sending RPC — **cache hit with stale data**

## Findings

### Finding 1: SharedPool not invalidated on file change

The `_invalidateCachesForPaths` method in `KernelWorker` cleared three internal caches but did not touch the `SharedPool`:

```typescript
private _invalidateCachesForPaths(changedPaths: string[]): void {
  for (const path of changedPaths) {
    this.fileHashCache.delete(path);
    this.fileContentCache.delete(path);
    this.fileContentCache.delete(`utf8:${path}`);
    // SharedPool NOT invalidated — stale reads persist
  }
}
```

The bridge proxy's `readFile` implementation checks the pool before sending RPC:

```typescript
async call(method, args) {
  if (options?.filePool && method === 'readFile') {
    const cached = options.filePool.resolveCopy(filePath);
    if (cached) {
      return encoding === 'utf8' ? new TextDecoder().decode(cached) : cached;
    }
  }
  // ... RPC fallback
}
```

Since the pool was never invalidated, the stale entry remained `READY`, and the proxy returned old data.

### Finding 2: SharedPool.invalidate only worked on writer side

The `SharedPool.invalidate()` method relied on `_keyToIndex`, a local `Map` populated by `store()`. Since only the FM worker (bridge server) calls `store()`, the kernel worker's (bridge client) `_keyToIndex` was always empty, making `invalidate()` a no-op:

```typescript
public invalidate(key: string): void {
  const index = this._keyToIndex.get(key);
  // index is always undefined on reader side → no-op
  if (index !== undefined) {
    this._arena.markStale(index);
    this._keyToIndex.delete(key);
  }
}
```

### Finding 3: Regression introduced by filePoolBuffer wiring

The diff in `cad.machine.ts` that introduced the regression:

```diff
-  await client.connect({ port });
+  await client.connect({ port, filePoolBuffer: snapshot.context.filePoolBuffer });
```

Before this change, no file pool was passed to the kernel worker, so `_filePool` was `undefined` and the bridge proxy always sent RPC calls (fresh reads). After the change, the pool was active, and stale reads occurred for any file written between renders.

### Finding 4: Pool population path creates stale cycle

The pool is populated on the **server side** (FM worker) during RPC responses:

```typescript
if (options?.filePool && method === 'readFile' && result instanceof Uint8Array) {
  options.filePool.store(filePath, result);
}
```

Once populated, the **client side** (kernel worker) serves subsequent reads from the pool without RPC, so the server never gets a chance to store updated content. This creates an irrecoverable stale cycle until the process restarts.

## Fix

Two changes were required:

**1. `SharedPool.invalidate` — reader-side hash scan fallback**

When `_keyToIndex` doesn't contain the key (reader side), fall back to an O(n) hash scan through the arena:

```typescript
public invalidate(key: string): void {
  const localIndex = this._keyToIndex.get(key);
  if (localIndex !== undefined) {
    this._arena.markStale(localIndex);
    this._keyToIndex.delete(key);
    return;
  }
  const [hashHi, hashLo] = fnv1a64(key);
  const entryIndex = this._arena.findEntry(hashHi, hashLo);
  if (entryIndex !== -1) {
    this._arena.markStale(entryIndex);
  }
}
```

**2. `KernelWorker._invalidateCachesForPaths` — pool invalidation**

Added `this._filePool?.invalidate(path)` to the cache invalidation loop:

```typescript
private _invalidateCachesForPaths(changedPaths: string[]): void {
  for (const path of changedPaths) {
    this.fileHashCache.delete(path);
    this.fileContentCache.delete(path);
    this.fileContentCache.delete(`utf8:${path}`);
    this._filePool?.invalidate(path);
  }
}
```

## References

- `packages/memory/src/shared-pool.ts` — SharedPool implementation
- `packages/runtime/src/framework/kernel-worker.ts` — cache invalidation
- `packages/runtime/src/framework/runtime-filesystem-bridge.ts` — bridge proxy pool check
- `apps/ui/app/machines/cad.machine.ts` — filePoolBuffer wiring
- `apps/ui/app/middleware/parameter-file-resolver.middleware.ts` — parameter override middleware

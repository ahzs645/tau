---
title: 'Geometry Data Transfer Architecture'
description: 'Root cause analysis of ArrayBuffer detachment in geometry cache and evaluation of transfer strategies across the runtime data pipeline'
status: draft
created: '2026-04-02'
updated: '2026-04-02'
category: investigation
related:
  - docs/policy/filesystem-policy.md
  - docs/research/cache-strategy-analysis.md
  - docs/research/filesystem-mount-overlay-architecture.md
---

# Geometry Data Transfer Architecture

Investigation into the `ArrayBuffer already detached` error caused by the interaction between the L1 geometry memory cache and `postMessage` transfer semantics, with an evaluation of architectural alternatives for binary data transfer across the runtime pipeline.

## Executive Summary

The recently added `geometryMemoryCache` (LRU) stores the **same object reference** that the worker dispatcher later transfers via `postMessage`. Transfer detaches the backing `ArrayBuffer`s on the sender side; on the next cache hit, the middleware returns objects with detached buffers, causing the observed crash. The root cause is a violation of filesystem policy Rule 6 ("Transfer, don't clone — do not reference [the buffer] after `postMessage`"). Three fix strategies are evaluated: structured clone fallback (simplest, one copy), clone-on-store (preserves transfer, one copy), and `SharedArrayBuffer` pipeline (zero-copy but blocked by Three.js `GLTFLoader` constraints). The recommended fix is **clone-on-store** with transfer preserved, because it maintains zero-copy worker-to-main delivery while keeping cached buffers intact.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

After adding an in-memory L1 `LruMap` cache to `geometry-cache.middleware.ts`, the UI shows:

> Failed to execute 'postMessage' on 'DedicatedWorkerGlobalScope': ArrayBuffer at index 0 is already detached.

The error occurs on the **second render** of the same geometry (i.e., a cache hit). The first render succeeds because the buffers are fresh from the kernel. Subsequent renders fail because the cached buffers were detached by the first transfer.

## Methodology

Source-level trace of the complete geometry data pipeline:

1. Kernel produces `GeometryResponse[]` with `Uint8Array` GLTF content
2. Geometry cache middleware stores result in L1 `LruMap`
3. `KernelWorker.createGeometry` returns result to dispatcher
4. `extractGltfTransferables` collects `ArrayBuffer` references
5. `port.postMessage(response, transferables)` transfers and detaches
6. Main thread receives fresh `ArrayBuffer`s via structured clone
7. `cad.machine.ts` stores `Geometry[]` in context
8. `CadViewer` → `GltfMesh` → `GLTFLoader.parseAsync(buffer)` renders

Cross-referenced against: filesystem policy Rule 6, `SharedContentPool` API, Three.js `GLTFLoader` SAB constraints, and COOP/COEP header configuration.

## Findings

### Finding 1: L1 Cache Stores the Same Reference That Gets Transferred

The root cause is a shared-reference aliasing bug. On a cache miss (first compute):

```
geometry-cache.middleware.ts:246  →  geometryMemoryCache.set(cacheKey, result)
geometry-cache.middleware.ts:267  →  return result  (same object)
kernel-worker.ts:808–816          →  shallow spread (...geometry) preserves content ref
runtime-worker-dispatcher.ts:29   →  seen.add(geometry.content.buffer)
runtime-worker-dispatcher.ts:58   →  port.postMessage(response, transferables)  ← DETACHES
```

After transfer, `result.data[*].content.buffer` is detached. The LRU cache still holds `result`, so `geometryMemoryCache.get(cacheKey)` returns objects with **dead buffers**.

On the next L1 hit:

```
geometry-cache.middleware.ts:219  →  geometryMemoryCache.get(cacheKey) → detached result
geometry-cache.middleware.ts:222  →  return memoryCached  ← detached buffers
runtime-worker-dispatcher.ts:29  →  seen.add(geometry.content.buffer)  ← detached
runtime-worker-dispatcher.ts:58  →  postMessage throws "already detached"
```

### Finding 2: Parameter Cache Is Not Affected

The parameter cache stores `GetParametersResult` (JSON objects). Parameter responses are sent via `respond({ type: 'parametersResolved', ... })` **without a transfer list**. No `ArrayBuffer`s are involved, so the parameter L1 cache is safe.

### Finding 3: L2 Filesystem Cache Accidentally Avoids the Bug

The L2 path (`deserializeResult`) creates **new** `Uint8Array` copies:

```typescript
// geometry-cache.middleware.ts:86–89
for (const geometry of entry.result.data) {
  if (geometry.format === 'gltf') {
    geometry.content = new Uint8Array(geometry.content);
  }
}
```

This copy exists to detach from the MessagePack shared decode buffer, but it also means L2 hits produce fresh `ArrayBuffer`s. However, these fresh buffers are then stored in L1 (`geometryMemoryCache.set(cacheKey, result)` at line 232) **and** returned — reintroducing the aliasing problem. The L2 path is affected on the **third** access (L1 hit of an L2-populated entry after its first return was transferred).

### Finding 4: Filesystem Policy Rule 6 Violation

Filesystem policy Rule 6 states:

> Binary data sent to the worker for writes must use `extractTransferables` to build a transfer list. **The sender's buffer is detached after transfer — do not reference it after `postMessage`.**

The cache directly violates this principle by retaining a reference to buffers that are subsequently transferred. The cache stores data _before_ transfer, then the dispatcher transfers _the same buffers_ without knowledge of the cache.

### Finding 5: Three Fix Strategies — Cost Analysis

Each strategy addresses the aliasing problem differently:

| Strategy                                | Copies per cache hit        | Copies per miss    | Implementation complexity | Cache validity |
| --------------------------------------- | --------------------------- | ------------------ | ------------------------- | -------------- |
| **A: Drop transfer (structured clone)** | 0 (SC copies)               | 0 (SC copies)      | Trivial (1 line)          | Always valid   |
| **B: Clone-on-store**                   | 0 + transfer                | 1 clone + transfer | Low (helper fn)           | Always valid   |
| **C: SharedArrayBuffer pipeline**       | 1 (SAB → AB for GLTFLoader) | 1 (kernel → SAB)   | High (architecture)       | N/A (shared)   |

**Strategy A — Drop transfer, use structured clone:**
Remove GLTF buffers from the transfer list. `postMessage` uses structured clone, which **copies** data without detaching the sender. Cache retains valid buffers naturally.

- Pro: One-line fix (`extractGltfTransferables` returns `[]`)
- Con: Structured clone copies the full GLTF binary (~100 KB–5 MB) on every postMessage
- Net copies: 1 per postMessage (identical cost to pre-cache behavior since SC was always happening for non-transferred fields)

**Strategy B — Clone GLTF content before storing in cache:**
When populating L1, deep-clone the `Uint8Array` GLTF content. The cache stores independent copies; the original flows through transfer and gets detached.

- On miss: clone content for cache, return original → transfer (zero-copy to main)
- On L1 hit: clone content from cache, return clone → transfer (zero-copy to main)
- Pro: Preserves zero-copy transfer to main thread; explicit about ownership
- Con: One explicit copy per cache interaction (same total cost as Strategy A)

**Strategy C — SharedArrayBuffer geometry pipeline:**
Store GLTF binaries in a `SharedArrayBuffer` visible to both worker and main thread. No transfer or clone needed for the shared data itself.

- Blocker: Three.js `GLTFLoader.parseAsync` calls `new DataView(buffer)`, and `gltf-mesh.tsx` **explicitly rejects SAB**:
  ```typescript
  // gltf-mesh.tsx:252–254
  if (typeof SharedArrayBuffer === 'function' && gltfFile.buffer instanceof SharedArrayBuffer) {
    throw new TypeError('SharedArrayBuffer is not supported in <GltfMesh />');
  }
  ```
- Even if this guard were removed, `GLTFLoader` would need a regular `ArrayBuffer` copy, negating the zero-copy benefit.
- `SharedContentPool.resolve()` already copies to regular `ArrayBuffer` (line 118: `return new Uint8Array(view)`).
- Net copies with SAB: **2** (kernel → SAB write + SAB → regular AB read) vs **1** for Strategies A/B.

### Finding 6: SharedArrayBuffer Is Already Available but Not Suited for Geometry

COOP/COEP headers are configured in `apps/ui/netlify.toml`:

```
Cross-Origin-Opener-Policy = "same-origin"
Cross-Origin-Embedder-Policy = "credentialless"
```

SAB is already used in the runtime for:

- **Signal channel**: `signalBuffer` (`runtime-worker-client.ts:192`) for abort/state signaling via `Atomics`
- **Content pool**: `contentPoolBuffer` for zero-IPC file reads (`SharedContentPool`)

However, `SharedContentPool` has structural limitations for geometry caching:

- **Bump-only allocator**: no space reuse after `markStale` — geometry churn fills the arena permanently
- **Single-writer model**: kernel worker produces geometry but the current writer is the file manager worker
- **Linear scan lookup**: `findEntry` is O(n) on entry count
- **Path-keyed**: geometry would need synthetic path keys or a parallel keying scheme

### Finding 7: Data Ownership Model Through the Full Pipeline

| Segment                 | Owner         | Copy/Transfer               | Buffer state after            |
| ----------------------- | ------------- | --------------------------- | ----------------------------- |
| Kernel produces GLTF    | Worker        | —                           | Fresh AB                      |
| Cache stores (current)  | Worker        | **Alias** (same ref)        | Shared ref                    |
| Dispatcher transfers    | Worker → Main | **Transfer** (detach)       | Worker: detached, Main: fresh |
| Cache returns on hit    | Worker        | **Returns detached**        | Crash                         |
| `cad.machine.ts` stores | Main          | Reference in XState context | Main-thread owned             |
| `CadViewer` renders     | Main          | Reference via selector      | Main-thread owned             |
| `GltfMesh` parses       | Main          | `parseAsync(buffer)` → GPU  | GPU owns mesh data            |

The fundamental issue: the cache and the transfer list compete for **exclusive ownership** of the same `ArrayBuffer`. Transfer is a move semantic — it revokes the sender's access. Caching requires retained access. These two requirements are incompatible unless the cache holds an **independent copy**.

### Finding 8: Quantitative Impact of Clone-on-Store

Typical GLTF geometry sizes in Tau:

| Geometry complexity | Approximate GLTF size | Clone cost (memcpy) |
| ------------------- | --------------------- | ------------------- |
| Simple primitive    | 10–50 KB              | < 0.01 ms           |
| Medium model        | 100–500 KB            | 0.05–0.2 ms         |
| Complex assembly    | 1–5 MB                | 0.5–2 ms            |
| Large CAD model     | 5–20 MB               | 2–10 ms             |

Clone cost is negligible relative to kernel computation time (typically 100 ms–10 s). The clone happens once per cache population; subsequent L1 hits also clone but avoid the far more expensive disk I/O + MessagePack deserialization path.

## Recommendations

| #   | Action                                                              | Priority | Effort | Impact                            |
| --- | ------------------------------------------------------------------- | -------- | ------ | --------------------------------- |
| R1  | Implement clone-on-store for L1 geometry cache                      | P0       | Low    | Critical — fixes crash            |
| R2  | Add clone-on-hit for L1 returns (both miss and hit paths)           | P0       | Low    | Required — prevents re-detachment |
| R3  | Add regression test: two consecutive renders with same hash         | P0       | Low    | Prevents recurrence               |
| R4  | Document transfer-vs-cache ownership invariant in filesystem policy | P1       | Low    | Prevents similar bugs             |
| R5  | Do NOT pursue SAB for geometry pipeline (blocked by GLTFLoader)     | —        | —      | Avoids wasted effort              |

### R1+R2: Clone helper implementation

A helper function deep-clones the GLTF `Uint8Array` content while shallow-copying everything else:

```typescript
function cloneGeometryResult(result: KernelSuccessResult<GeometryResponse[]>): KernelSuccessResult<GeometryResponse[]> {
  return {
    ...result,
    data: result.data.map((geometry) =>
      geometry.format === 'gltf' ? { ...geometry, content: new Uint8Array(geometry.content) } : geometry,
    ),
  };
}
```

Apply at **both** cache store and cache return sites:

```typescript
// L1 hit: return a clone so transfer doesn't corrupt cache
const memoryCached = geometryMemoryCache.get(cacheKey);
if (memoryCached) {
  return cloneGeometryResult(memoryCached);
}

// L2 hit: store in L1, return a clone
const result = deserializeResult(cachedData);
geometryMemoryCache.set(cacheKey, result);
return cloneGeometryResult(result);

// Compute miss: store a clone in L1, return original (will be transferred)
geometryMemoryCache.set(cacheKey, cloneGeometryResult(result));
// return result; (original flows to dispatcher → transfer)
```

### R3: Regression test

```typescript
it('should serve L1 cache hit without detached buffer error', async () => {
  // First render: populates L1
  const result1 = await wrapCreateGeometry(input, handler, env);
  expect(result1.success).toBe(true);

  // Simulate transfer detachment (what postMessage does)
  for (const geometry of result1.data) {
    if (geometry.format === 'gltf') {
      // Transfer the buffer to simulate postMessage detach
      const { port1, port2 } = new MessageChannel();
      port1.postMessage(geometry.content, [geometry.content.buffer]);
      port1.close();
      port2.close();
    }
  }

  // Second render: L1 hit must return valid (non-detached) buffers
  const result2 = await wrapCreateGeometry(input, handler, env);
  expect(result2.success).toBe(true);
  for (const geometry of result2.data) {
    if (geometry.format === 'gltf') {
      expect(geometry.content.byteLength).toBeGreaterThan(0);
      expect(geometry.content.buffer.byteLength).toBeGreaterThan(0);
    }
  }
});
```

## Trade-offs

| Dimension             | Clone-on-store (recommended)  | Drop transfer           | SAB pipeline               |
| --------------------- | ----------------------------- | ----------------------- | -------------------------- |
| **Copies per render** | 1 (explicit clone)            | 1 (structured clone)    | 2 (write + read)           |
| **Transfer to main**  | Zero-copy (transfer)          | Copy (structured clone) | N/A (shared)               |
| **Cache validity**    | Always valid                  | Always valid            | N/A                        |
| **Implementation**    | ~20 lines                     | 1 line                  | Architecture change        |
| **GLTFLoader compat** | Full                          | Full                    | Blocked                    |
| **Memory peak**       | 2× briefly (cache + original) | 2× briefly (SC buffer)  | 1× (shared) + 1× (AB copy) |
| **Policy alignment**  | Full (Rule 6 compliant)       | Violates Rule 6 intent  | N/A                        |

**Why clone-on-store over drop-transfer:**

- Both have the same copy cost (one `memcpy` per geometry)
- Clone-on-store preserves the `postMessage` transfer optimization: the original buffer reaches the main thread without a second copy
- Drop-transfer is simpler but structured clone copies **all** message fields (not just GLTF content), adding overhead for the message envelope
- Clone-on-store makes ownership explicit: the cache owns clones, the caller owns originals — a clear separation that prevents future aliasing bugs

**Why NOT SharedArrayBuffer for geometry:**

- `GLTFLoader.parseAsync` requires regular `ArrayBuffer` — a copy from SAB is mandatory at the consumer
- `SharedContentPool`'s bump-only arena doesn't support geometry churn (no space reuse)
- The kernel worker is not the pool's designated writer (file manager worker is)
- Net copy count with SAB (2) exceeds clone-on-store (1)
- SAB remains valuable for its current uses (signal channel, file content pool) where the single-writer/many-reader model fits and consumers accept SAB views directly

## Diagrams

### Current (broken) data flow

```
Kernel Worker                                    Main Thread
┌──────────────────────────────────┐            ┌──────────────────┐
│ createGeometry()                 │            │                  │
│   ↓                              │            │                  │
│ geometry-cache.middleware        │            │                  │
│   L1 miss → compute             │            │                  │
│   geometryMemoryCache.set(result)│◄──┐        │                  │
│   return result ─────────────────│───┤        │                  │
│                                  │   │ SAME   │                  │
│ extractGltfTransferables(result) │   │ REF    │                  │
│   collects geometry.content.buffer   │        │                  │
│                                  │   │        │                  │
│ postMessage(response, transfers) │───┘        │ receives fresh   │
│   ✗ DETACHES sender's buffers    │  ──────►   │ ArrayBuffers     │
│   ✗ Cache now holds dead refs    │            │                  │
│                                  │            │ cad.machine.ts   │
│ NEXT RENDER (L1 hit):            │            │   ↓              │
│   geometryMemoryCache.get()      │            │ CadViewer        │
│   returns DETACHED buffers       │            │   ↓              │
│   postMessage → CRASH ✗          │            │ GltfMesh         │
└──────────────────────────────────┘            └──────────────────┘
```

### Fixed data flow (clone-on-store)

```
Kernel Worker                                    Main Thread
┌──────────────────────────────────┐            ┌──────────────────┐
│ createGeometry()                 │            │                  │
│   ↓                              │            │                  │
│ geometry-cache.middleware        │            │                  │
│   L1 miss → compute             │            │                  │
│   geometryMemoryCache.set(CLONE) │  CLONE     │                  │
│   return result (original) ──────│──────►     │                  │
│                                  │ TRANSFER   │                  │
│ extractGltfTransferables(result) │  (zero-    │ receives fresh   │
│ postMessage(response, transfers) │  copy)     │ ArrayBuffers     │
│   Original detached (not cached) │            │                  │
│   Cache holds INDEPENDENT clone  │ ──────►    │ cad.machine.ts   │
│                                  │            │   ↓              │
│ NEXT RENDER (L1 hit):            │            │ CadViewer        │
│   geometryMemoryCache.get()      │            │   ↓              │
│   returns CLONE of cached entry  │            │ GltfMesh         │
│   postMessage transfers clone ✓  │            │   parseAsync()   │
│   Cache still holds valid data ✓ │            │                  │
└──────────────────────────────────┘            └──────────────────┘
```

## References

- Filesystem policy Rule 6: `docs/policy/filesystem-policy.md`
- Cache strategy analysis: `docs/research/cache-strategy-analysis.md`
- `SharedContentPool`: `packages/filesystem/src/shared-content-pool.ts`
- `SharedMemoryArena`: `packages/filesystem/src/shared-memory-arena.ts`
- MDN — Transferable objects: [developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
- Three.js GLTFLoader ArrayBuffer requirement: `apps/ui/app/components/geometry/graphics/three/react/gltf-mesh.tsx:252–254`

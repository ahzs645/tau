---
title: 'Shared-Memory Geometry Pipeline'
description: 'Architecture for @taucad/memory — a zero-dependency SharedPool with configurable eviction over SharedArrayBuffer, replacing domain-specific pools for unified zero-copy cross-thread caching and rendering'
status: active
created: '2026-04-02'
updated: '2026-04-08'
category: architecture
related:
  - docs/policy/filesystem-policy.md
  - docs/research/geometry-data-transfer-architecture.md
  - docs/research/cache-strategy-analysis.md
  - docs/research/filesystem-mount-overlay-architecture.md
  - docs/research/filesystem-gap-analysis.md
  - docs/research/shared-worker-fs-architecture.md
---

# Shared-Memory Geometry Pipeline

Feasibility analysis of replacing the `postMessage` + transfer geometry pipeline with a `SharedArrayBuffer`-backed shared-memory layer that unifies caching, eliminates the transfer/detach ownership conflict, and enables zero-IPC geometry reads across worker boundaries.

## Executive Summary

The current geometry pipeline suffers from a fundamental ownership conflict: the L1 cache and `postMessage` transfer lists compete for exclusive ownership of the same `ArrayBuffer`. This research explores whether a `SharedArrayBuffer`-backed pipeline can unify cache, transport, and rendering. The key finding is that since Tau owns the entire Three.js integration layer, the `GLTFLoader` `instanceof ArrayBuffer` gate (the only hard blocker) is patchable via `pnpm patch` — a **single-line change**. With that patch, `GLTFLoader.parseAsync` works directly on SAB-backed views (`DataView`, typed arrays, and `gl.bufferData` all accept SAB natively in modern browsers). Combined with `@react-three/offscreen` (pmndrs' drop-in R3F worker rendering package), a complete zero-main-thread pipeline is architecturally feasible: kernel worker → shared pool → render worker → `OffscreenCanvas` → `ImageBitmap` display.

A critical design finding is that a domain-specific `SharedGeometryPool` class is **not** the right abstraction. `SharedContentPool` is already ~90% generic — the only file-specific aspects are naming (`path` vs `key`) and the `maxSingleFileBytes` option. Creating parallel domain classes (geometry pool, parameter pool) would duplicate nearly all of the arena, hashing, Atomics, and store/resolve logic. Instead, the shared-memory primitives (`SharedMemoryArena`, `SharedContentPool`) should be extracted from `@taucad/filesystem` into a new zero-dependency **`@taucad/memory`** package, refactored into a generic **`SharedPool`** parameterized by eviction policy (`'none' | 'lru'`), with the kernel worker exposing **`KernelWorker.geometryPool`** for the geometry cache/transport path and **`KernelWorker.filePool`** for the filesystem bridge, and the dispatcher using **`toTransportGeometry(geo, worker.geometryPool)`** for pooled delivery. The `@taucad/memory` package has no dependencies on `@taucad/types`, `@taucad/utils`, or any other Tau package — it is a pure SharedArrayBuffer/Atomics primitive. The recommended path is a **four-phase strategy**: immediate clone-on-store fix (Phase 1), unblock the SAB pipeline with GLTFLoader patch and dead infrastructure wiring (Phase 2), create `@taucad/memory` with generic `SharedPool`, LRU eviction, and runtime pool management (Phase 3), and adopt `@react-three/offscreen` for worker-side rendering (Phase 4). **Phases 1–3 are complete.** Phase 3 culminated in a **two-layer transport type architecture** — protocol-level types carry a discriminated `GltfContentDelivery` union (`delivery: 'inline' | 'pooled'`), while consumer-facing types always contain resolved content. `RuntimeClient` acts as the resolution boundary, resolving pool references before emitting geometry events. The dispatcher converts geometries to transport types via `toTransportGeometry()`, sending `delivery: 'pooled'` when the SharedPool has the key. `extractGltfTransferables` and `cloneGeometryResult` have been removed. Cache hits (L1/L2) write to the SharedPool with per-geometry keys, guarded by `pool.has()`. Zero copies on cache hit are achieved. Phase 4 (`@react-three/offscreen`) is future work.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

Three issues motivate this investigation:

1. **Transfer/detach crash**: The L1 `geometryMemoryCache` stores the same object reference that gets transferred via `postMessage`, detaching the cached `ArrayBuffer`s (see `geometry-data-transfer-architecture.md`).

2. **Architectural friction**: Filesystem caching (L2), in-memory caching (L1), `postMessage` transfer, and Three.js consumption each impose different ownership requirements on the same GLTF binary data. These layers fight rather than compose.

3. **Incomplete SAB wiring (historical)**: File-pool and geometry-pool buffers are now first-class on the initialize command (`filePoolBuffer`, `geometryPoolBuffer`). **`RuntimeClient` allocates only the geometry pool** from `sharedMemory.geometry`; the **file pool SAB is allocated by the file-manager machine** and passed through `client.connect({ filePoolBuffer })` (with `cad.machine` sourcing `snapshot.context.filePoolBuffer`). The zero-IPC file read path is wired when both sides share that buffer.

## Methodology

- Source-level trace of the full geometry pipeline (kernel worker → dispatcher → main thread → cad machine → GltfMesh)
- Review of all filesystem research documents (12 docs) and `filesystem-policy.md`
- Analysis of `SharedContentPool`, `SharedMemoryArena`, `MountTable`, and all filesystem providers
- Review of `createRuntimeClient`, middleware system, and runtime protocol types
- **Full-depth Three.js r179 source trace**: every `instanceof ArrayBuffer`, `DataView`, typed array constructor, `.slice()`, `Blob`, `postMessage`, and `gl.bufferData` call in `GLTFLoader.js`, `BufferAttribute.js`, `WebGLAttributes.js`, and `DRACOLoader.js`
- **`SharedArrayBuffer` inventory**: every SAB/Atomics usage across the codebase, mapped by writer/reader thread and wired/unwired status
- **`@react-three/offscreen`** evaluation: R3F worker rendering capabilities, event forwarding, Drei compatibility, fallback behavior
- Cross-reference with COOP/COEP deployment headers (`apps/ui/netlify.toml` + `@taucad/vite` cross-origin-isolation plugin for dev)
- ECMAScript spec verification: `DataView(SharedArrayBuffer)` support across browsers (Chrome 68+, Firefox 79+, Safari 15.2+)
- Architectural critique of domain-specific pool proliferation vs generic pool with configurable eviction: API surface analysis of `SharedContentPool`, `SharedMemoryArena`, `BoundedFileCache`, and `LruMap` to identify what is domain-specific vs structurally generic
- **Package boundary analysis**: full import/dependency audit of `SharedMemoryArena`, `SharedContentPool`, and all arena constants across the monorepo to determine correct package home; signal channel SAB analysis to verify protocol coupling

## Findings

### Finding 1: Three Viable Architectural Approaches

| #   | Approach                                    | Description                                                         | Copy count (miss) | Copy count (hit) | Complexity |
| --- | ------------------------------------------- | ------------------------------------------------------------------- | ----------------- | ---------------- | ---------- |
| A   | **Clone-on-store**                          | Cache holds clones; originals flow through transfer                 | 1                 | 1                | Trivial    |
| B   | **Generic SharedPool + patched GLTFLoader** | SAB pool with configurable eviction; GLTFLoader reads SAB directly  | 1                 | **0**            | Medium     |
| C   | **Filesystem overlay mount**                | SAB-backed `FileSystemProvider` mounted at `/.tau/shared/geometry/` | 1                 | **0**            | High       |

With the GLTFLoader patch (Finding 4), approaches B and C achieve **zero copies on cache hit** — the pool IS the cache, and the viewer reads directly from shared memory.

### Finding 2: The Filesystem Overlay Is Over-Coupled

The user's initial intuition — mounting a SAB-backed filesystem at a path like `/.tau/shared/geometry/` — is **feasible** but **architecturally over-coupled**:

**What MountTable supports today:**

- `mount(prefix, provider, config)` — one provider per path prefix (isolated mounts, not union overlays)
- `resolve(path)` — longest-prefix routing to provider
- `getMountsUnder(path)` — readdir merge for child mount names

**What a geometry overlay mount would require:**

- A new `SharedMemoryProvider` implementing `FileSystemProvider` (or extending `MemoryProvider`)
- A new backend type in `libs/types/src/constants/filesystem.constants.ts`
- Wiring through `FileService`, bridge server, bridge client, kernel worker, and main thread
- The full filesystem contract (`stat`, `readdir`, `mkdir`, `rmdir`, `rename`, `unlink`, `watch`) for a cache that only needs `readFile` and `writeFile`
- Path-based keying (synthetic paths like `/.tau/shared/geometry/{hash}.bin`) when the natural key is the dependency hash

**Why it's over-coupled:**

- Geometry cache entries are **content-addressed by hash**, not path-addressed. Mapping hashes to filesystem paths adds indirection without benefit.
- The cache needs **LRU eviction**, not the filesystem's `unlink`/`rmdir` lifecycle.
- The filesystem bridge's `readFile` → `postMessage` → `extractTransferables` path reintroduces the exact transfer/detach problem we're solving.
- The `SharedContentPool` already provides the right primitive (hash-keyed shared bytes) without the filesystem abstraction layer.

### Finding 3: Generic SharedPool — Not Domain-Specific Classes

Analysis of `SharedContentPool` reveals it is **~90% generic**. The only file-specific aspects are naming (`path` in API and comments, `maxSingleFileBytes`) and the copy behavior of `resolve()`. Creating a parallel `SharedGeometryPool` would duplicate nearly all logic:

| Aspect                        | SharedContentPool (files)          | Hypothetical SharedGeometryPool | Shared?       |
| ----------------------------- | ---------------------------------- | ------------------------------- | ------------- |
| Wraps `SharedMemoryArena`     | Yes                                | Yes                             | Identical     |
| Key type                      | String (path)                      | String (dependency hash)        | Identical     |
| Hash function                 | FNV-1a 64-bit → `[hashHi, hashLo]` | Same                            | Identical     |
| Value type                    | `Uint8Array`                       | `Uint8Array` (GLTF binary)      | Identical     |
| `Atomics` state transitions   | `FREE → WRITING → READY → STALE`   | Same                            | Identical     |
| `store(key, data)`            | Copy into SAB, publish entry       | Same                            | Identical     |
| Writer-side `Map<key, index>` | For O(1) invalidation              | Same                            | Identical     |
| Eviction                      | None (bump-only)                   | LRU (max entries)               | **Different** |
| `resolve()` return            | Copy to new `ArrayBuffer`          | SAB view (zero-copy)            | **Different** |
| Max entry size                | 10 MB default                      | Configurable                    | **Config**    |

**Three differences, all expressible as configuration.** A generic `SharedPool` in a new `@taucad/memory` package eliminates the duplication:

```typescript
// @taucad/memory — zero dependencies
export type SharedPoolOptions = {
  maxEntries?: number;
  maxEntryBytes?: number; // renamed from maxSingleFileBytes
  eviction?: 'none' | 'lru'; // default: 'none' (current bump-only behavior)
};

export class SharedPool {
  constructor(buffer: SharedArrayBuffer, options?: SharedPoolOptions);
  store(key: string, data: Uint8Array<ArrayBuffer>): boolean;
  resolve(key: string): Uint8Array | undefined; // SAB view (zero-copy)
  resolveCopy(key: string): Uint8Array<ArrayBuffer> | undefined; // copy (current behavior)
  invalidate(key: string): void;
  has(key: string): boolean;
  clear(): void;
}
```

**`resolve()` vs `resolveCopy()`:** Two methods, not two classes. `resolve()` returns a `Uint8Array` view into the SAB (zero-copy, for patched GLTFLoader). `resolveCopy()` returns a copy into a regular `ArrayBuffer` (backward-compatible, for consumers that need owned buffers like the current `FileContentService` → `BoundedFileCache` path). `SharedContentPool.resolve()` today always copies (`return new Uint8Array(view)` at line 118); the existing JSDoc claiming "zero-copy" is inaccurate.

**Protocol change:** The initialize command carries **dedicated optional buffers** (not a string-keyed map):

```typescript
type RuntimeCommand = {
  type: 'initialize';
  // ...existing fields...
  geometryPoolBuffer?: SharedArrayBuffer;
  filePoolBuffer?: SharedArrayBuffer;
};
```

**Worker access:** `KernelWorker` exposes **`geometryPool`** and **`filePool`** getters (`SharedPool | undefined`) backed by those buffers after `setGeometryPoolBuffer` / `setFilePoolBuffer`. The **dispatcher** calls `toTransportGeometry(geometry, worker.geometryPool)` so pooled geometry transport does not rely on a middleware-runtime map. The **filesystem bridge** receives **`filePool`** when constructing the proxy. Parameter caching remains JSON-based and does not use these pools.

### Finding 4: GLTFLoader Is Patchable — SAB Requires a Single-Line Change

Three.js r179 `GLTFLoader.parse` has one gate (line ~426):

```javascript
} else if ( data instanceof ArrayBuffer ) {
```

`SharedArrayBuffer` is **not** `instanceof ArrayBuffer` in ECMAScript, so the binary path is skipped. However, a comprehensive trace of the entire GLTFLoader parse pipeline reveals that **every other operation** in the binary path works natively with SAB:

| GLTFLoader operation                       | SAB compatible | Evidence                                                                                                                                                                |
| ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new DataView(data, offset, length)`       | Yes            | [MDN: DataView accepts SAB](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DataView/DataView) (Chrome 68+, Firefox 79+, Safari 15.2+) |
| `new Uint8Array(data, offset, length)`     | Yes            | All typed array constructors accept SAB                                                                                                                                 |
| `data.slice(offset, end)`                  | Yes            | `SharedArrayBuffer.prototype.slice` exists (returns new SAB)                                                                                                            |
| `textDecoder.decode(new Uint8Array(data))` | **No**         | Browsers reject SAB-backed views in TextDecoder.decode() — patch copies text chunks to AB via `_toDecodable()`                                                          |
| `new Blob([bufferView])`                   | Yes            | Blob accepts ArrayBufferView backed by SAB                                                                                                                              |
| `BufferAttribute(typedArray)`              | Yes            | Stores the typed array; no AB check                                                                                                                                     |
| `gl.bufferData(type, array, usage)`        | Yes            | WebGL accepts any ArrayBufferView                                                                                                                                       |

**The fix:** `pnpm patch three` with two changes:

1. Widen the `instanceof` check at line ~426 to include `SharedArrayBuffer`
2. Wrap all 4 `TextDecoder.decode()` calls with `_toDecodable()` — a helper that copies SAB-backed views to `ArrayBuffer`-backed copies before decoding, since browsers reject SAB views in `TextDecoder.decode()`. Only the small text portions (4-byte magic header, JSON chunk ~KB) are copied; the binary chunk (geometry data, ~MB) remains zero-copy.

**Our guard** in `gltf-mesh.tsx:252-254` is then removed — it was a defensive measure, not a Three.js limitation.

**Extension caveat:** `DRACOLoader` (line ~227) calls `worker.postMessage(buffer, [buffer])` which fails for SAB (cannot transfer shared memory). Tau does **not** wire `DRACOLoader` into `GLTFLoader` — Draco decoding uses `@taucad/converter`'s custom `GltfDracoDecoder` instead. If `DRACOLoader` is ever added, it would need a separate fix (copy to regular AB before posting to its decode worker).

**Full-depth trace results (all line numbers from `node_modules/three/examples/jsm/loaders/GLTFLoader.js`):**

- `GLBinaryExtension` (1914–1977): `DataView`, `Uint8Array`, `.slice()` — all SAB-safe
- `loadBuffer` (3087–3110): returns the `.body` slice — SAB-backed, works
- `loadBufferView` (3115–3140): `.slice()` on buffer — returns new SAB, works
- `loadAccessor` (3145–3277): typed array constructors over bufferView — SAB-backed, works
- `BufferAttribute` (core): stores `.array` — no AB check; SAB-backed typed arrays accepted
- `WebGLAttributes.createBuffer` (8–14): `gl.bufferData(bufferType, array, usage)` — WebGL reads bytes from any ArrayBufferView

### Finding 5: Copy Count Analysis — SAB Pool Achieves True Zero-Copy to GLTFLoader

With the GLTFLoader patch (Finding 4), the consumer-side copy is eliminated entirely. `GLTFLoader.parseAsync` creates `DataView` and typed array views directly into the SAB — no intermediate `ArrayBuffer` copy needed.

**Cache miss (first computation):**

| Step                      | Clone-on-store (A)       | SharedPool (eviction: 'lru') + patched loader (B) |
| ------------------------- | ------------------------ | ------------------------------------------------- |
| Kernel produces GLTF      | 0 (native)               | 0 (native)                                        |
| Cache write               | 1 (clone for LruMap)     | 1 (copy to SAB pool)                              |
| Worker → main             | 0 (transfer, zero-copy)  | 0 (no data in message)                            |
| GLTFLoader parse input    | 0 (reads transferred AB) | 0 (reads SAB view directly)                       |
| **Total explicit copies** | **1**                    | **1**                                             |

**Cache hit (subsequent render, same geometry):**

| Step                      | Clone-on-store (A)       | SharedPool (eviction: 'lru') + patched loader (B) |
| ------------------------- | ------------------------ | ------------------------------------------------- |
| Cache read                | 1 (clone from LruMap)    | 0 (pool already has data)                         |
| Worker → main             | 0 (transfer clone)       | 0 (no data in message)                            |
| GLTFLoader parse input    | 0 (reads transferred AB) | 0 (reads SAB view directly)                       |
| **Total explicit copies** | **1**                    | **0**                                             |

**On the hit path, the SAB pool achieves zero explicit copies.** The pool IS the cache; the viewer reads directly from shared memory via `pool.resolve(hash)`. GLTFLoader's internal `.slice()` calls (for `bufferView` extraction) still copy, but these are smaller per-mesh slices, not full-file copies, and they occur identically in both approaches.

### Finding 6: What SAB Pool DOES Solve — Ownership Model

Despite equal (or worse) copy counts, the SAB pool eliminates the **class of bugs** that caused the original crash:

| Property                          | Clone-on-store            | SharedPool (SAB)          |
| --------------------------------- | ------------------------- | ------------------------- |
| Cache and transfer compete for AB | Yes (must clone)          | No (no transfer)          |
| Detached buffer risk              | Mitigated (clones)        | Eliminated (no transfer)  |
| Main thread reads independently   | No (waits for transfer)   | Yes (reads pool directly) |
| Cache valid after consumption     | Yes (if cloned correctly) | Always (SAB is shared)    |
| Cross-CU cache sharing            | No (per-worker LruMap)    | Yes (shared memory)       |

The pool model is **structurally safe** — the ownership conflict is impossible because shared memory has no transfer semantics. The cache never needs to "give up" its data.

### Finding 7: Existing Infrastructure — What's Ready vs What's Missing

**Already built and working:**

| Component                                                                    | Status                              | Location                                     |
| ---------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| `SharedArrayBuffer` available                                                | ✅ COOP/COEP headers deployed       | `apps/ui/netlify.toml:80-83`                 |
| `SharedMemoryArena`                                                          | ✅ Production                       | `packages/memory/src/shared-memory-arena.ts` |
| `SharedPool` (generic, replaces `SharedContentPool`)                         | ✅ Production                       | `packages/memory/src/shared-pool.ts`         |
| `SharedContentPool` (backward-compat re-export)                              | ✅ Production                       | `packages/memory/src/shared-content-pool.ts` |
| `geometryPoolBuffer` / `filePoolBuffer` in protocol                          | ✅ Defined                          | `runtime-protocol.types.ts`                  |
| `RuntimeWorkerClient.initialize({ geometryPoolBuffer, filePoolBuffer })`     | ✅ Implemented                      | `runtime-worker-client.ts`                   |
| `KernelWorker.setGeometryPoolBuffer` / `setFilePoolBuffer`                   | ✅ Implemented                      | `kernel-worker.ts`                           |
| `KernelWorker.geometryPool` / `filePool`                                     | ✅ Implemented                      | `kernel-worker.ts`                           |
| Bridge `readFile` fast path (pool resolve before RPC)                        | ✅ Implemented                      | `runtime-filesystem-bridge.ts:398-407`       |
| `createRuntimeClient` geometry SAB allocation + `filePoolBuffer` passthrough | ✅ Implemented                      | `runtime-client.ts`                          |
| App-level geometry pool config (100 MB, 20-entry LRU)                        | ✅ Wired                            | `kernel-worker.constants.ts`                 |
| FM worker `filePool` late binding                                            | ✅ Implemented                      | `file-manager.worker.ts`, `file-service.ts`  |
| FM machine SAB allocation for content pool (50 MB)                           | ✅ Implemented                      | `file-manager.machine.ts`                    |
| Dispatcher `toTransportGeometry` + `geometryPool.store`                      | ✅ Pool populated on transport path | `runtime-worker-dispatcher.ts`               |

**Remaining gaps (post-Phase 1–3 implementation):**

| Gap                                                                           | Impact                                                                         | Fix effort                 | Status                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`createRuntimeClient` never passes pool buffers~~                           | ~~High-level apps cannot use any shared pool~~                                 | ~~Low~~                    | ✅ `sharedMemory.geometry` allocates the geometry SAB; `connect({ filePoolBuffer })` forwards the FM-owned file buffer; exposes **`client.geometryPool`** (geometry only) |
| ~~Protocol uses single `contentPoolBuffer` field~~                            | ~~Cannot pass multiple named pools~~                                           | ~~Low~~                    | ✅ Dedicated `geometryPoolBuffer` + `filePoolBuffer` on initialize (replaces older single-field / map shapes)                                                             |
| ~~`FileService` in FM worker constructed without `filePool`~~                 | ~~Writer side never populates pool~~                                           | ~~Low~~                    | ✅ `setFilePool()` late binding; FM worker listens for the file-pool message                                                                                              |
| ~~`FileContentService` in main thread constructed without file pool~~         | ~~Main reader pool not wired~~                                                 | ~~Low~~                    | ✅ FM machine allocates file-pool SAB, passes **`FilePool`** reader to `FileContentService`                                                                               |
| ~~Shared-memory primitives trapped in `@taucad/filesystem`~~                  | ~~Runtime must dynamic-import entire FS package for pool~~                     | ~~Medium~~                 | ✅ Extracted to `@taucad/memory`                                                                                                                                          |
| ~~`SharedContentPool` is file-specific naming/API~~                           | ~~Cannot reuse for geometry or parameters~~                                    | ~~Medium~~                 | ✅ Refactored to generic `SharedPool`                                                                                                                                     |
| ~~`SharedMemoryArena` is bump-only (no space reuse)~~                         | ~~High-churn geometry exhausts arena permanently~~                             | ~~Medium~~                 | ✅ LRU eviction mode added                                                                                                                                                |
| ~~Kernel worker had no typed pool handles~~                                   | ~~Transport could not use SharedPool~~                                         | ~~Low~~                    | ✅ `KernelWorker.geometryPool` / `filePool` + dispatcher integration                                                                                                      |
| ~~`GltfMesh` rejects SAB-backed buffers~~                                     | ~~Defensive guard, not a Three.js limitation~~                                 | ~~Trivial~~                | ✅ Guard removed                                                                                                                                                          |
| ~~`GLTFLoader` `instanceof ArrayBuffer` gate~~                                | ~~Only blocker for SAB GLTF parsing~~                                          | ~~Trivial~~                | ✅ `pnpm patch` applied                                                                                                                                                   |
| No `@react-three/offscreen` integration                                       | Rendering stays on main thread                                                 | Medium — new render worker | ❌ Phase 4 (future)                                                                                                                                                       |
| ~~Dispatcher still uses `extractGltfTransferables` + `postMessage` transfer~~ | ~~Geometry data copied via transfer; L1 cache buffers detached on second hit~~ | ~~Low~~                    | ✅ Replaced with `toTransportGeometry()` + `GltfContentDelivery`                                                                                                          |
| ~~`cad.machine.ts` reads `result.data` from event, not the geometry pool~~    | ~~Main thread never reads from SharedPool; zero-copy on hit not achieved~~     | ~~Low~~                    | ✅ `RuntimeClient` resolves pool refs at boundary before emitting ( **`client.geometryPool`** is the reader handle)                                                       |
| ~~Pool not populated on cache re-hit~~                                        | ~~Stale pool on re-hit~~                                                       | ~~Low~~                    | ✅ Per-geometry keys with `has()` guard on dispatcher transport path                                                                                                      |
| ~~`cloneGeometryResult` still active on cache write path~~                    | ~~Phase 1 fallback still required because transfer detaches L1 buffers~~       | ~~—~~                      | ✅ Removed — pool is canonical store, no transfer detach                                                                                                                  |

### Finding 8: Demand Assessment — Who Benefits from Shared-Memory Geometry?

| Consumer                            | Current pain                                         | SAB pool benefit                             | Status                                                                     |
| ----------------------------------- | ---------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| **Geometry cache middleware**       | Transfer detaches cached clone buffers on 2nd L1 hit | No transfer → no detach                      | ✅ Two-layer transport types; pool read path wired; clone-on-store removed |
| **File content (FM worker ↔ main)** | IPC per read                                         | Zero-IPC via **`FilePool`**                  | ✅ Both sides wired (R5)                                                   |
| **Parameter cache middleware**      | No pain (JSON, no ArrayBuffers)                      | Marginal (avoids stringify/parse)            | ⏸️ Low priority                                                            |
| **Multi-CU rendering**              | Each CU independently computes/caches                | Cross-CU cache sharing via shared pool       | ✅ Pool read path wired via RuntimeClient resolution                       |
| **Main-thread consumers**           | Must wait for postMessage delivery                   | Can read pool at any time after notification | ✅ RuntimeClient resolves pooled content before emitting                   |
| **Export pipeline**                 | Separate transfer path for export bytes              | Could share pool                             | ⏸️ Future                                                                  |
| **OffscreenCanvas (future)**        | Not implemented                                      | Render worker reads pool directly            | ❌ Phase 4                                                                 |
| **`@taucad/react` useRender**       | Same transfer path as cad machine                    | Same benefits                                | ✅ Benefits from RuntimeClient resolution boundary                         |

### Finding 9: OffscreenCanvas Render Worker — `@react-three/offscreen` Is the Missing Piece

The most compelling case for SAB geometry pools is **OffscreenCanvas rendering in a worker**, and the ecosystem now provides the tooling.

**`@react-three/offscreen`** (pmndrs, 517 GitHub stars, last updated Jan 2025) is a **drop-in** R3F Canvas replacement that runs the entire Three.js scene in a Web Worker:

```jsx
// Main thread — drop-in replacement for R3F Canvas
import { Canvas } from '@react-three/offscreen'
const worker = new Worker(new URL('./render.worker.tsx', import.meta.url), { type: 'module' })
<Canvas worker={worker} fallback={<Scene />} />

// render.worker.tsx — full R3F scene runs here
import { render } from '@react-three/offscreen'
render(<Scene />)
```

**Key capabilities:**

- Accepts all standard R3F `Canvas` props (`dpr`, `shadows`, `gl`, etc.)
- DOM events automatically forwarded to worker (pointer, wheel, resize)
- Works with Drei components (`OrbitControls`, `Environment`, etc.)
- Automatic fallback to main-thread rendering in unsupported browsers
- Patches Three.js and provides document/window shims for worker context

**Full pipeline with SAB + `@react-three/offscreen`:**

1. Kernel worker computes GLTF → writes to `SharedPool('geometry')` (SAB)
2. Kernel worker sends `{ type: 'geometryComputed', poolKeys }` (metadata only, no binary)
3. Main thread `cad.machine.ts` receives notification → forwards pool keys to render worker
4. Render worker (running R3F via `@react-three/offscreen`) reads GLTF from shared pool
5. Patched `GLTFLoader.parseAsync` parses directly from SAB views (zero copy)
6. Three.js builds `BufferGeometry` from SAB-backed typed arrays
7. `gl.bufferData` uploads to GPU from SAB views (zero copy)
8. `OffscreenCanvas` renders → result appears on main thread canvas

**Zero GLTF parsing on main thread. Zero WebGL calls on main thread. Zero `postMessage` data copies.**

**Constraints that exist but are manageable:**

- Scene components that touch the DOM directly (e.g., Drei `Html`) won't work in workers — Tau doesn't use these
- `OrbitControls` needs event forwarding — `@react-three/offscreen` handles this
- The `shared-renderer.tsx` pattern (main-thread OffscreenCanvas for context sharing) is a **different** pattern from worker-side rendering — they serve different purposes and can coexist
- `GltfMesh`'s material/line processing (`applyFatLineSegments`, `applyMatcap`) runs in-worker — these are CPU-only Three.js operations that benefit from being off main thread

**Existing OffscreenCanvas usage in Tau:**

- `shared-renderer.tsx` uses `OffscreenCanvas` on the **main thread** to multiplex one WebGL context across doc preview views via `transferToImageBitmap`. This is about **context limits**, not worker rendering.
- The `@react-three/offscreen` approach is architecturally different: `transferControlToOffscreen` moves the GL context **to** the worker. They are complementary patterns.

### Finding 10: `@taucad/memory` — Correct Package Boundary

`SharedMemoryArena` and `SharedContentPool` currently live in `@taucad/filesystem`, but they are not filesystem primitives — they are generic shared-memory data structures that happen to have file-oriented naming. A dependency audit confirms this:

**What cross-package consumers actually import from `@taucad/filesystem` for shared memory:**

| Consumer                               | Symbol                    | Usage                                                   |
| -------------------------------------- | ------------------------- | ------------------------------------------------------- |
| `@taucad/runtime` (`kernel-worker.ts`) | `FilePool` / `SharedPool` | Reader pool for filesystem bridge                       |
| `apps/ui` (`file-content-service.ts`)  | `FilePool` (type)         | Optional file-pool parameter for main-thread file reads |

**No** cross-package consumer imports `SharedMemoryArena`, `ARENA_ENTRY_STATE`, `ARENA_HEADER_BYTES`, `ArenaEntry`, or `SharedMemoryArenaOptions` directly — those are internal to `@taucad/filesystem`.

**Why a new `@taucad/memory` package:**

- `SharedPool` and `SharedMemoryArena` are **zero-dependency** primitives (no `@taucad/types`, `@taucad/utils`, or `jszip` needed). They use only `SharedArrayBuffer`, `Atomics`, and `Int32Array`.
- Keeping them in `@taucad/filesystem` forces `@taucad/runtime` to dynamic-import the entire filesystem package (including `MountTable`, `FileService`, providers, `jszip`) just for the pool constructor.
- The generic pool serves geometry, parameters, and file content. It does not belong in a filesystem package.
- The signal channel SAB stays in `@taucad/runtime` — it is protocol-coupled (`signalSlot` layout, `WorkerState` enum, abort generation) and only consumed within the runtime framework.

**Package contents:**

| Export                                   | Description                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `SharedPool`                             | Generic string-keyed `Uint8Array` pool over SAB with configurable eviction |
| `SharedPoolOptions`                      | Options type (`maxEntries`, `maxEntryBytes`, `eviction`)                   |
| `SharedMemoryArena`                      | Low-level SAB index + data region with Atomics state machine               |
| `ARENA_ENTRY_STATE`                      | Entry lifecycle constants (`FREE`, `WRITING`, `READY`, `STALE`)            |
| `ArenaEntry`, `SharedMemoryArenaOptions` | Supporting types                                                           |

**Dependency graph (✅ implemented):**

```
@taucad/memory          (zero dependencies) ✅
  ├── SharedPool
  ├── SharedContentPool (backward compat wrapper)
  └── SharedMemoryArena

@taucad/filesystem      (depends on @taucad/memory) ✅
  ├── FileService        (uses `FilePool` for file pool, setFilePool())
  ├── BoundedFileCache
  ├── MountTable, providers, etc.
  └── re-exports SharedPool, SharedContentPool, SharedMemoryArena from @taucad/memory

@taucad/runtime         (depends on @taucad/memory) ✅
  ├── KernelWorker       (imports SharedPool from @taucad/memory)
  ├── createRuntimeClient (allocates geometry SAB, optional filePoolBuffer passthrough, exposes client.geometryPool)
  └── signal channel     (stays here — protocol-coupled)

apps/ui                 ✅
  ├── file-manager.machine.ts (allocates file-pool SAB, posts to FM worker)
  ├── file-manager.worker.ts  (listens for file-pool message, late-binds to FileService)
  ├── FileContentService      (receives `FilePool` reader from FM machine)
  ├── kernel-worker.constants.ts (configures geometry pool: 100 MB, 20-entry LRU)
  └── cad.machine.ts          (✅ receives resolved content from RuntimeClient)
```

**Backward compatibility:** `@taucad/filesystem` re-exports `SharedPool` as `SharedContentPool` (type alias) so existing consumers continue to compile without import changes during migration.

### Finding 11: Unified Cache Architecture — Generic Pools with Runtime Management

The current architecture has **three separate cache layers** that don't compose:

```
Current (fragmented):
  Kernel Worker:  LruMap (L1) + filesystem .tau/cache (L2)
  File Manager:   `FilePool` / `SharedPool` in @taucad/filesystem (bump-only)
  Main Thread:    BoundedFileCache in @taucad/filesystem (JS heap)
```

A unified model replaces domain-specific caches with named instances of `SharedPool` from `@taucad/memory`:

```
Target (unified):
  @taucad/memory SharedPool('geometry', eviction: 'lru'):  kernel writes, main/render reads
  @taucad/memory file pool (shared `FilePool` / `SharedPool`): FM writes, kernel/main reads
  Filesystem L2 (cold):                                    .tau/cache/* for persistence
  BoundedFileCache (unchanged):                            main-thread JS-heap file reads
```

**One class, one package, one API.** Domain specificity lives in configuration, not in class hierarchy or package boundaries.

**Integration point — `createRuntimeClient` options:**

```typescript
const client = createRuntimeClient({
  kernels: [...],
  middleware: [...],
  sharedMemory: {
    geometry: { maxEntries: 20, bytes: 100 * 1024 * 1024, eviction: 'lru' },
  },
});
```

`RuntimeClient` allocates the **geometry** `SharedArrayBuffer` from `sharedMemory.geometry` and exposes **`client.geometryPool`**. The **file** pool buffer is **not** configured here: the file-manager machine allocates it and the app passes **`filePoolBuffer`** into **`client.connect({ port, filePoolBuffer })`** (e.g. from `snapshot.context.filePoolBuffer` in `cad.machine`). Initialize sends **`geometryPoolBuffer`** and **`filePoolBuffer`** as separate optional fields. The dispatcher uses **`worker.geometryPool`** for `toTransportGeometry()`.

**Benefits:**

- Adding a new pool domain (e.g., export, preview) requires zero new classes, packages, or protocol fields
- `@taucad/memory` has zero dependencies — can be used by any package without pulling in filesystem, types, or utils
- `@taucad/runtime` no longer dynamic-imports `@taucad/filesystem` just for the pool constructor
- `@taucad/filesystem` re-exports `SharedPool` as `SharedContentPool` for backward compatibility

## Recommendations

| #       | Action                                                                                                                                                                                                                                                      | Priority | Effort      | Impact                                            | Phase | Status                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ------------------------------------------------- | ----- | --------------------------------------------------------- |
| ~~R1~~  | ~~Clone-on-store fix for geometry cache~~                                                                                                                                                                                                                   | ~~P0~~   | ~~Low~~     | ~~Critical (fixes crash)~~                        | ~~1~~ | ✅ RESOLVED                                               |
| ~~R2~~  | ~~`pnpm patch three` — GLTFLoader SAB gate~~                                                                                                                                                                                                                | ~~P1~~   | ~~Trivial~~ | ~~Unblocks entire SAB pipeline~~                  | ~~2~~ | ✅ RESOLVED                                               |
| ~~R3~~  | ~~Remove SAB guard in `gltf-mesh.tsx`~~                                                                                                                                                                                                                     | ~~P1~~   | ~~Trivial~~ | ~~Enables SAB GLTF parsing~~                      | ~~2~~ | ✅ RESOLVED                                               |
| ~~R4~~  | ~~Wire `geometryPoolBuffer` / `filePoolBuffer` through `createRuntimeClient` + `connect`~~                                                                                                                                                                  | ~~P1~~   | ~~Low~~     | ~~Enables existing SAB infrastructure~~           | ~~2~~ | ✅ RESOLVED                                               |
| ~~R5~~  | ~~Wire `filePool` to FM worker `FileService` + main `FileContentService` (FM-owned SAB)~~                                                                                                                                                                   | ~~P1~~   | ~~Low~~     | ~~Activates file-read SAB fast path~~             | ~~2~~ | ✅ RESOLVED (Pool API tidy-up: domain ownership explicit) |
| ~~R6~~  | ~~Create `@taucad/memory` package; move `SharedMemoryArena` + `SharedContentPool` from `@taucad/filesystem`~~                                                                                                                                               | ~~P2~~   | ~~Medium~~  | ~~Correct package boundary, zero deps~~           | ~~3~~ | ✅ RESOLVED                                               |
| ~~R7~~  | ~~Refactor `SharedContentPool` → generic `SharedPool` with configurable eviction (in `@taucad/memory`)~~                                                                                                                                                    | ~~P2~~   | ~~Medium~~  | ~~One class for all shared-memory caching~~       | ~~3~~ | ✅ RESOLVED                                               |
| ~~R8~~  | ~~Add LRU eviction mode to `SharedMemoryArena` (slot + data reuse, in `@taucad/memory`)~~                                                                                                                                                                   | ~~P2~~   | ~~Medium~~  | ~~Enables high-churn pool domains~~               | ~~3~~ | ✅ RESOLVED                                               |
| ~~R9~~  | ~~Add `geometryPoolBuffer` / `filePoolBuffer` to protocol; worker `geometryPool` for transport; pool population on transport path~~                                                                                                                         | ~~P2~~   | ~~Medium~~  | ~~Unified cache/transport model~~                 | ~~3~~ | ✅ RESOLVED                                               |
| R10     | Adopt `@react-three/offscreen` for worker-side R3F rendering                                                                                                                                                                                                | P3       | Medium      | Zero main-thread GPU work                         | 4     | ❌ NOT DONE                                               |
| ~~R11~~ | ~~Do NOT build filesystem overlay mount for geometry~~                                                                                                                                                                                                      | ~~—~~    | ~~—~~       | ~~Avoids over-coupling~~                          | ~~—~~ | ✅ FOLLOWED                                               |
| ~~R12~~ | ~~Wire geometry read path through SharedPool via two-layer transport types: `GltfContentDelivery` discriminated union at protocol layer, `RuntimeClient` as resolution boundary, `toTransportGeometry()` in dispatcher, remove `extractGltfTransferables`~~ | ~~P0~~   | ~~Low~~     | ~~Zero-copy on cache hit; fixes L1 detach crash~~ | ~~3~~ | ✅ RESOLVED                                               |
| ~~R13~~ | ~~Ensure geometry pool keys on all cache paths (per-geometry keys, `pool.has` guard); remove `cloneGeometryResult`~~                                                                                                                                        | ~~P0~~   | ~~Trivial~~ | ~~Pool always populated for main-thread reads~~   | ~~3~~ | ✅ RESOLVED                                               |

### ~~R1: Immediate Fix (Clone-on-Store)~~ ✅ RESOLVED

~~As specified in `geometry-data-transfer-architecture.md`, add `cloneGeometryResult()` to the geometry cache middleware. This fixes the crash with minimal change and no architectural risk. Required regardless of whether the SAB pipeline is pursued.~~

**Status**: **RESOLVED** — `cloneGeometryResult()` implemented in `packages/runtime/src/middleware/geometry-cache.middleware.ts`. Deep-clones each GLTF content buffer before storing in the L1 `geometryMemoryCache`, ensuring cached data survives `postMessage` transfer/detach. Regression tests verify independence of cached buffers from originals.

### ~~R2–R3: Patch GLTFLoader + Remove Guard~~ ✅ RESOLVED → SUPERSEDED

**Status**: **SUPERSEDED** — The `patches/three.patch` was removed after R1 encapsulated SAB resolution inside `RuntimeClient` via `resolveCopy()`. Consumers (including `GLTFLoader`) now always receive `Uint8Array<ArrayBuffer>`, so SAB-awareness in Three.js is no longer needed. The defensive `TypeError` guard in `gltf-mesh.tsx` was also removed — the type system (`Uint8Array<ArrayBuffer>`) now enforces `ArrayBuffer` backing at compile time.

### ~~R4–R5: Wire the Dead SAB Infrastructure~~ ✅ RESOLVED

**~~R4~~ ✅** — Legacy single-field / map-based pool shapes removed. `RuntimeClientOptions.sharedMemory` is **`{ geometry?: SharedMemoryConfig }`** (no file pool on the client options object). `createRuntimeClient` allocates the geometry `SharedArrayBuffer`, creates the main-thread **`client.geometryPool`** reader, and forwards **`geometryPoolBuffer`** (and optional **`filePoolBuffer`** from `connect`) via `workerClient.initialize()`. `client.filePool` / `client.filePoolBuffer` are **not** part of the public `RuntimeClient` API. App wiring in `kernel-worker.constants.ts` configures the geometry pool (e.g. 100 MB, 20-entry LRU).

**~~R5~~ ✅** — **`FileService.setFilePool()`** late binding (pool arrives after construction). `file-manager.worker.ts` receives the FM-allocated SAB and calls **`setFilePool()`** with a **`FilePool`** (`SharedPool`) wrapping that buffer. The FM machine allocates the file-pool SAB (domain-driven ownership), posts it to the worker, and passes a reader to **`FileContentService`**. **`cad.machine`** reads **`snapshot.context.filePoolBuffer`** and passes **`client.connect({ port, filePoolBuffer })`**. Both writer (FM worker) and reader (main thread) sides of the file-read SAB fast path are active. **Resolved** by the Pool API tidy-up (explicit geometry vs file ownership).

### ~~R6–R9: `@taucad/memory` Package + Generic SharedPool + Runtime Pool Management~~ ✅ RESOLVED

All four changes are implemented at the library layer:

**~~R6~~ ✅** — `@taucad/memory` package created at `packages/memory/`. Zero dependencies. Exports `SharedPool`, `SharedMemoryArena`, `SharedContentPool` (backward compat), arena constants and types. `@taucad/filesystem` depends on `@taucad/memory` and re-exports all symbols for backward compatibility. Original source files deleted from `@taucad/filesystem`. Tests moved alongside source.

**~~R7~~ ✅** — `SharedContentPool` refactored to generic `SharedPool` in `@taucad/memory`. `path` renamed to `key`, `maxSingleFileBytes` renamed to `maxEntryBytes`, `eviction` option added (`'none' | 'lru'`). `resolve()` returns SAB-backed `Uint8Array` view (zero-copy). `resolveCopy()` returns `ArrayBuffer`-backed copy (backward-compatible).

**~~R8~~ ✅** — LRU eviction added to `SharedMemoryArena`. `ENTRY_FIELD_LRU_SEQ` slot tracks access order. `_findEvictionCandidate()` prefers STALE/FREE slots, then evicts the entry with the lowest LRU sequence counter. Slot reuse on eviction. Tests verify STALE reclamation, LRU ordering, and access-order updates.

**~~R9~~ ✅** — Protocol updated: initialize carries **`geometryPoolBuffer?`** and **`filePoolBuffer?`**. `KernelWorker` uses **`setGeometryPoolBuffer` / `setFilePoolBuffer`**, exposes **`geometryPool`** / **`filePool`**, and the dispatcher runs **`toTransportGeometry(geo, worker.geometryPool)`**. `KernelWorker` imports `SharedPool` from `@taucad/memory`. ~~**Remaining gap**: `createRuntimeClient` does not yet allocate SABs or forward pool buffers (see R4).~~ **RESOLVED** — R4 wires app-level geometry allocation and FM-driven file buffer passthrough.

### ~~R12: Wire Geometry Read Path Through SharedPool via Two-Layer Transport Types~~ ✅ RESOLVED

**Status**: **RESOLVED** — Two-layer transport type architecture fully implemented:

**Protocol layer** (`runtime-protocol.types.ts`): `GltfContentDelivery` discriminated union (`delivery: 'inline' | 'pooled'`), `GeometryGltfTransport`, `GeometryTransport`, `HashedGeometryResultTransport`. `RuntimeResponse.geometryComputed` now uses `HashedGeometryResultTransport`. The pooled branch is **`{ delivery: 'pooled', key }`** (Pool API tidy-up: no `pool: string` field — there is a single geometry `SharedPool`).

**Dispatcher** (`runtime-worker-dispatcher.ts`): `toTransportGeometry()` checks `pool.has(geometry.hash)` to decide `delivery: 'pooled'` vs `delivery: 'inline'`. `toTransportResult()` maps each geometry. `extractGltfTransferables` removed. Pooled content is sent without a transfer list.

**RuntimeWorkerClient** (`runtime-worker-client.ts`): Callback/promise types updated to `HashedGeometryResultTransport` — pure passthrough.

**RuntimeClient** (`runtime-client.ts`): `resolveGeometry()` and `resolveTransportResult()` resolve pool references before emitting events. Consumers always receive `HashedGeometryResult` with content bytes — never pool references.

**Consumer types** (`cad.types.ts`): `GeometryGltf.content` widened to bare `Uint8Array` (defaults to `Uint8Array<ArrayBufferLike>`, accepting both `ArrayBuffer` and `SharedArrayBuffer` backing).

### ~~R13: Ensure SharedPool Is Populated on Cache Hits~~ ✅ RESOLVED

**Status**: **RESOLVED** — Dispatcher transport path ensures the geometry `SharedPool` holds entries before emitting pooled refs:

1. Per-geometry keys aligned with `Geometry.hash` / kernel output.
2. `pool.has(key)` guard before `pool.store()` — prevents redundant arena allocations.
3. Coherent with L1/L2 cache paths (pool stays valid for `RuntimeClient.resolveCopy()` at the boundary).
4. `cloneGeometryResult` removed — no longer needed since buffers are not transferred via `postMessage`.

### R10: `@react-three/offscreen` Worker Rendering — ❌ NOT DONE

Phase 4 — future work. `@react-three/offscreen` is not installed. Prerequisites (R4 app-level geometry SAB wiring, R5 FM **`filePool`**) are complete — the render worker would use **`client.geometryPool`** for reads. **R12 is complete** — the geometry pool read path is active before rendering can move off-thread.

### ~~R11: Why NOT Filesystem Overlay~~ ✅ FOLLOWED

Recommendation against action — followed as prescribed. No filesystem overlay mount was built for geometry. The generic `SharedPool` in `@taucad/memory` provides the correct abstraction.

## Trade-offs

| Dimension              | Clone-on-store (Phase 1)     | **Current state (Phase 3 complete)**                      | + OffscreenCanvas (Phase 4)                |
| ---------------------- | ---------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| **Copies (miss)**      | 1                            | 1 (pool write)                                            | 1                                          |
| **Copies (hit)**       | 1                            | **0** (pool already populated)                            | **0**                                      |
| **Main thread work**   | GLTF parse + WebGL           | GLTF parse + WebGL                                        | **None**                                   |
| **Ownership conflict** | Mitigated (clone discipline) | **Eliminated** (no transfer, pool is canonical store)     | Eliminated                                 |
| **Cross-CU sharing**   | No                           | **Yes** (shared memory pool)                              | Yes                                        |
| **Allocator**          | JS heap LruMap               | Slot-based LRU in SAB + JS heap L1                        | Same                                       |
| **Complexity**         | Trivial                      | Medium                                                    | Medium-High                                |
| **New APIs**           | 0                            | `@taucad/memory` `SharedPool` + two-layer transport types | + render worker setup                      |
| **Browser deps**       | None                         | COOP/COEP (already set)                                   | + OffscreenCanvas (Chrome/FF/Safari 17.4+) |

**Phase progression justification:**

- **Phase 1 → Phase 3**: The SAB pool reduces hit-path copies from 1 to 0, eliminates the ownership conflict **structurally** (not just by discipline), and enables cross-CU cache sharing. The GLTFLoader patch (Phase 2) is a prerequisite — without it, the pool must copy to regular AB via `resolveCopy()`, negating the zero-copy benefit.
- **Phase 3 → Phase 4**: Moving rendering to a worker via `@react-three/offscreen` is the culmination — zero main-thread GPU work. The SAB pool is a prerequisite because the render worker needs direct access to geometry data without postMessage copies.

## Diagrams

### Current architecture (Phase 3 complete): SharedPool('geometry', eviction: 'lru') — two-layer transport types

```
Kernel Worker                   SharedArrayBuffer              Main Thread
┌─────────────────┐            ┌───────────────┐             ┌──────────────┐
│ Middleware chain │            │ SharedPool    │             │              │
│   ↓              │            │ 'geometry'    │             │              │
│ geometry-cache   │            │ eviction: lru │             │              │
│   pool.store() ──├──WRITE───►│ [hash] → data │◄──READ──────┤ cad.machine  │
│   ↓              │            │ [hash] → data │             │   ↓          │
│ return metadata  │            │ LRU eviction  │             │ pool.resolve │
│   (no content)   │            └───────────────┘             │   ↓          │
│   ↓              │                                          │ SAB view     │
│ dispatcher ──────┼──► postMessage (metadata only) ────►     │   ↓          │
│ (no transfer     │    { geometryComputed, hash }            │ GltfMesh     │
│  list needed)    │                                          │ parseAsync() │
└─────────────────┘                                          │  (SAB input) │
                                                              └──────────────┘
```

### Phase 4: Full zero-main-thread pipeline (`@react-three/offscreen`)

```
Kernel Worker          SharedArrayBuffer          Render Worker          Main Thread
┌───────────────┐     ┌───────────────┐         ┌───────────────┐      ┌──────────┐
│ Compute GLTF  │     │ SharedPool    │         │ R3F scene     │      │          │
│   ↓            │     │ 'geometry'    │         │ (offscreen)   │      │ DOM only │
│ pool.store() ─├─W──►│ [hash] → data │◄──R─────┤               │      │          │
│   ↓            │     │ [hash] → data │         │ GltfMesh      │      │ Events   │
│ Send metadata │     └───────────────┘         │   parseAsync  │      │   ↓      │
│   ↓            │                               │   (SAB view)  │      │ Forward  │
│ dispatcher    │                               │   ↓            │      │ to wrkr  │
│   ↓            │  postMessage                  │ WebGL render  │      │          │
│   ├───────────┼──► { hash } ──► cad.machine ──►│OffscreenCanvas │      │          │
│   │            │   (metadata    forwards key   │   ↓            │      │          │
│   │            │    only)       to worker       │ ImageBitmap   │─────►│ Display  │
└───┘            │                               └───────────────┘      └──────────┘
                                                  ↑                       ↓
                                                  └─── DOM events ────────┘
                                                   (pointer, wheel, resize)
                                                   via @react-three/offscreen
```

### Phased implementation roadmap

```
Phase 1 ✅ COMPLETE:  Clone-on-store fix (superseded by Phase 3)
                      ├── ✅ cloneGeometryResult() in geometry-cache.middleware.ts
                      ├── ✅ Regression test (transfer + re-read)
                      └── ✅ cloneGeometryResult REMOVED — Phase 3 pool read path eliminates need

Phase 2 ✅ COMPLETE:  Unblock SAB pipeline
                      ├── ✅ pnpm patch three (GLTFLoader instanceof gate)
                      ├── ✅ Remove SAB guard in gltf-mesh.tsx
                      ├── ✅ Wire geometryPoolBuffer + filePoolBuffer through createRuntimeClient + connect (SAB allocation + forwarding)
                      ├── ✅ Connect FileService + FileContentService to file pool
                      └── ✅ File-read SAB fast path fully activated (FM worker + main thread)

Phase 3 ✅ COMPLETE:  @taucad/memory + generic SharedPool + runtime pool management
                      ├── ✅ Create @taucad/memory package (zero dependencies)
                      ├── ✅ Move SharedMemoryArena + SharedContentPool from @taucad/filesystem
                      ├── ✅ Refactor SharedContentPool → SharedPool
                      ├── ✅ Add eviction option ('none' | 'lru')
                      ├── ✅ Add LRU mode to SharedMemoryArena (slot + data reuse)
                      ├── ✅ Add resolve() (SAB view) alongside resolveCopy()
                      ├── ✅ @taucad/filesystem depends on @taucad/memory, re-exports for compat
                      ├── ✅ @taucad/runtime imports SharedPool from @taucad/memory
                      ├── ✅ Protocol: geometryPoolBuffer + filePoolBuffer (replaces older map/single-field shapes)
                      ├── ✅ KernelWorker geometryPool + filePool; dispatcher toTransportGeometry
                      ├── ✅ Pool population on transport path (dispatcher) + cache coherence
                      ├── ✅ Cache hits (L1/L2) write to pool with per-geometry keys (R13)
                      ├── ✅ Two-layer transport types: GltfContentDelivery discriminated union (R12)
                      ├── ✅ Dispatcher uses toTransportGeometry(), extractGltfTransferables removed (R12)
                      ├── ✅ RuntimeClient resolves pool refs → content at boundary (R12)
                      ├── ✅ cloneGeometryResult removed (no longer needed)
                      └── ✅ Zero copies on cache hit achieved via SharedPool read path

Phase 4 ❌ NOT DONE:  @react-three/offscreen worker rendering
                      ├── ❌ pnpm install @react-three/offscreen
                      ├── ❌ Create render.worker.tsx with R3F scene
                      ├── ❌ Replace Canvas in three-context.tsx
                      ├── ❌ Render worker reads SharedPool('geometry')
                      ├── ❌ DOM events forwarded by library
                      ├── ❌ Automatic fallback for unsupported browsers
                      └── ❌ Zero main-thread GLTF parsing + WebGL
```

## References

- `geometry-data-transfer-architecture.md` — Root cause of the transfer/detach crash
- `cache-strategy-analysis.md` — Broader cache strategy taxonomy
- `filesystem-policy.md` — Rule 6 (Transfer, don't clone) and Rule 4 (Bounded caches)
- `filesystem-mount-overlay-architecture.md` — MountTable design and overlay deferral
- `filesystem-gap-analysis.md` — R20 (SharedContentPool), R23 (CoW overlays deferred)
- `shared-worker-fs-architecture.md` — SAB unavailable in SharedWorkers
- `SharedContentPool` / `SharedMemoryArena` — `packages/filesystem/src/` (target: `packages/memory/src/` as `@taucad/memory`)
- Three.js r179 GLTFLoader source — `instanceof ArrayBuffer` gate at line ~426
- Three.js `BufferAttribute` / `WebGLAttributes` — SAB-compatible typed array path
- [MDN: DataView accepts SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DataView/DataView) (Chrome 68+, Firefox 79+, Safari 15.2+)
- [Can I Use: DataView SharedArrayBuffer](https://caniuse.com/mdn-javascript_builtins_dataview_dataview_sharedarraybuffer_support)
- [`@react-three/offscreen`](https://github.com/pmndrs/react-three-offscreen) — Drop-in R3F worker rendering (pmndrs, 517 stars)
- [Evil Martians — OffscreenCanvas + Three.js](https://evilmartians.com/chronicles/faster-webgl-three-js-3d-graphics-with-offscreencanvas-and-web-workers)
- [MDN: SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- [Structured Clone Tax](https://loke.dev/blog/structured-clone-tax-shared-array-buffer) — SAB eliminates postMessage copying overhead

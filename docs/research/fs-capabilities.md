---
title: 'Filesystem Capabilities & Performance Research'
description: "Investigation of ZenFS architecture, transfer performance, bridge efficiency, and optimization opportunities for Tau's filesystem."
status: active
created: '2026-03-03'
updated: '2026-03-05'
category: investigation
related:
  - docs/policy/filesystem-policy.md
  - docs/research/filesystem-architecture.md
---

# Filesystem Capabilities & Performance Research

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Critical Finding: Missing Transferable Support](#critical-finding-missing-transferable-support)
3. [ZenFS Architecture Deep Dive](#zenfs-architecture-deep-dive)
4. [ZenFS Capabilities We Can Leverage](#zenfs-capabilities-we-can-leverage)
5. [Current Data Flow Analysis](#current-data-flow-analysis)
6. [Performance Improvement Opportunities](#performance-improvement-opportunities)
7. [ZenFS RPC vs Tau Bridge Comparison](#zenfs-rpc-vs-tau-bridge-comparison)

---

## Executive Summary

Analysis of the full filesystem data flow reveals **one critical performance gap** and **several optimization opportunities**:

1. **CRITICAL**: Neither our bridge nor ZenFS uses `Transferable` lists for `Uint8Array`/`ArrayBuffer` in `postMessage()`. Every binary payload is **copied** via structured clone instead of **transferred** zero-copy. For large CAD files (STL, STEP, GLTF), this means double allocation and double copy on every read/write. Notably, the kernel dispatcher already correctly uses transfer lists for GLTF geometry results -- the filesystem bridge should follow the same pattern.

2. **ZenFS has a built-in PortFS/RPC layer** (`attachFS`/`detachFS`/`resolveRemoteMount`) that handles cross-worker filesystem access. While our custom bridge is simpler and purpose-built for the `RuntimeFileSystem` contract, ZenFS's PortFS provides a full `node:fs`-compatible API over MessagePort, including features like `catchMessages` (message buffering during initialization) and an `Async` mixin with sync cache.

3. **ZenFS's `SingleBuffer` backend** uses `SharedArrayBuffer` + `Atomics` for true zero-copy, lock-free concurrent access. This is potentially a future option for kernel workers that need synchronous FS access.

4. **Architecture is correctly designed**: Kernel workers talk **directly** to the file-manager worker via transferred `MessagePort`s. The main thread is only involved at setup time. This is the optimal topology for throughput.

---

## Critical Finding: Missing Transferable Support

### The Problem

Every `postMessage()` call in the filesystem bridge uses **structured clone only** -- no transfer list:

```typescript
// createBridgeServer - line 82 of runtime-filesystem-bridge.ts
port.postMessage({ id, result } satisfies BridgeResponse);

// createBridgeCall - line 211 of runtime-filesystem-bridge.ts
port.postMessage({ id, method, args } satisfies BridgeRequest);
```

The `postMessage(data, transferList)` second argument is **never used** for filesystem operations. This means:

- `readFile()` returning a 10 MB `Uint8Array` → **allocates 10 MB, copies 10 MB** on send, then **allocates 10 MB, copies 10 MB** on receive = 40 MB total allocation for 10 MB of data
- `writeFile()` with a 10 MB `Uint8Array` → same story in the other direction
- `readFiles()` / `getDirectoryContents()` → multiplied across all files

### What Transfer Lists Do

```typescript
// WITHOUT transfer (current - structured clone):
port.postMessage({ id, result: uint8array });
// uint8array is COPIED - original remains valid, new copy created

// WITH transfer (zero-copy):
port.postMessage({ id, result: uint8array }, [uint8array.buffer]);
// uint8array.buffer is MOVED - original becomes detached (zero-length), no copy
```

Transfer is **zero-copy** -- the `ArrayBuffer` ownership is moved to the receiving thread. The original `ArrayBuffer` becomes neutered (detached, zero-length). This is perfect for filesystem operations where the sender doesn't need the buffer after sending.

### Contrast: Kernel Geometry Already Uses Transfer

The runtime worker dispatcher correctly uses transfer lists for GLTF geometry results:

```typescript
// runtime-worker-dispatcher.ts
function extractGltfTransferables(result: HashedGeometryResult): Transferable[] {
  if (!result.success) return [];
  const buffers: Transferable[] = [];
  // ... extracts ArrayBuffers from GLTF ...
  return buffers;
}

const transferables = extractGltfTransferables(result);
respond({ type: 'geometryComputed', requestId, result }, transferables);
```

The filesystem bridge should follow exactly the same pattern.

### ZenFS Has the Same Gap

ZenFS's `handleRequest` in `rpc.ts` declares a `transferList` but never populates it:

```typescript
// repos/zenfs/core/src/internal/rpc.ts - lines 359-396
const transferList: TransferListItem[] = [];
// ... switch cases that produce Uint8Array values ...
port.send({ _zenfs: true, ...pick(request, 'id', 'method', 'stack'), error, value }, transferList);
// transferList is always []
```

This is a known gap in ZenFS -- the plumbing exists but is unused.

### Impact Assessment

| Operation                  | Typical Size    | Current Cost            | With Transfer |
| -------------------------- | --------------- | ----------------------- | ------------- |
| `readFile` (STL)           | 1-50 MB         | 2 copies (2-100 MB)     | 0 copies      |
| `readFile` (KCL source)    | 1-100 KB        | 2 copies (negligible)   | 0 copies      |
| `writeFile` (STEP)         | 5-200 MB        | 2 copies (10-400 MB)    | 0 copies      |
| `readFiles` (project load) | 10-500 files    | 2 copies per file       | 0 copies      |
| `getDirectoryContents`     | Entire dir tree | 2 copies per file       | 0 copies      |
| `getZippedDirectory`       | Blob result     | 1 copy (Blob is cloned) | 0 copies      |

For a CAD application dealing with large binary files, this is the **single biggest performance win** available.

### Recommended Fix

Add transfer list extraction to both the server (response) and client (request) sides of the bridge:

```typescript
// Helper to extract transferable ArrayBuffers from a value
function extractTransferables(value: unknown): Transferable[] {
  if (value instanceof ArrayBuffer) return [value];
  if (ArrayBuffer.isView(value)) return [value.buffer];
  if (value instanceof Blob) return []; // Blob is not transferable
  if (Array.isArray(value)) return value.flatMap(extractTransferables);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(extractTransferables);
  }
  return [];
}

// Server side (createBridgeServer):
const result = await fn(...args);
const transferables = extractTransferables(result);
port.postMessage({ id, result }, transferables);

// Client side (createBridgeCall):
const transferables = args.flatMap(extractTransferables);
port.postMessage({ id, method, args }, transferables);
```

**Caveat**: After transfer, the sender's `ArrayBuffer` becomes detached. This is fine for:

- `readFile` responses (file-manager worker doesn't need the buffer after sending)
- `writeFile` requests (caller doesn't need the buffer after sending)

But requires care for batch operations where the same buffer might be referenced multiple times.

---

## ZenFS Architecture Deep Dive

### Core Architecture

ZenFS implements a complete Node.js `fs` API with pluggable backends:

```
┌─────────────────────────────────────────────┐
│  ZenFS Public API (fs, fs.promises)          │
├─────────────────────────────────────────────┤
│  VFS Layer (mount/umount, path resolution)   │
├─────────────────────────────────────────────┤
│  FileSystem Abstract Class                   │
│  (read, write, stat, mkdir, unlink, etc.)    │
├─────────────────────────────────────────────┤
│  Backends:                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ InMemory │ │ PortFS   │ │ SingleBuffer │ │
│  └──────────┘ └──────────┘ └──────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │IndexedDB │ │WebAccess │ │ Passthrough  │ │
│  └──────────┘ └──────────┘ └──────────────┘ │
└─────────────────────────────────────────────┘
```

### RPC Layer (`src/internal/rpc.ts`)

ZenFS's RPC protocol:

- **Request**: `{ _zenfs: true, id: string, method: Method, args: Parameters<Methods[Method]>, stack: string }`
- **Response**: `{ _zenfs: true, id: string, method: Method, value: ReturnType<Methods[Method]>, error?: ExceptionJSON }`
- **Channel types**: `WebMessagePort`, `NodeMessagePort`, `WebSocket`
- **Port factory**: `from(channel)` creates a unified `Port` adapter

RPC Methods (lower-level than `fs.promises`):

| Method       | Parameters                 | Returns            |
| ------------ | -------------------------- | ------------------ |
| `ready`      | (none)                     | void               |
| `usage`      | (none)                     | UsageInfo          |
| `rename`     | (oldPath, newPath)         | void               |
| `createFile` | (path, options)            | Uint8Array (inode) |
| `unlink`     | (path)                     | void               |
| `rmdir`      | (path)                     | void               |
| `mkdir`      | (path, options)            | Uint8Array (inode) |
| `readdir`    | (path)                     | string[]           |
| `touch`      | (path, metadata)           | void               |
| `exists`     | (path)                     | boolean            |
| `link`       | (target, link)             | void               |
| `sync`       | (none)                     | void               |
| `read`       | (path, buffer, start, end) | Uint8Array         |
| `write`      | (path, buffer, offset)     | void               |
| `stat`       | (path)                     | Uint8Array (inode) |

Key differences from our approach:

- ZenFS works at the **inode level** (raw `Uint8Array` for metadata), not the `readFile`/`writeFile` level
- `read`/`write` are buffer-based (offset + length), not whole-file
- `stat` returns serialized `Inode` (a `Uint8Array`), not a plain object

### PortFS Backend (`src/backends/port.ts`)

PortFS bridges a remote filesystem over a MessagePort-like channel:

- Extends `Async(FileSystem)` -- gets an in-memory sync cache (`_sync`) for free
- Sync operations run against the local cache, then pipeline asynchronously to the remote
- `ready()` calls `rpc('ready')` and then loads the sync cache from the remote FS
- `sync()` flushes the local cache to the remote

Key pattern -- **sync cache with async pipeline**:

```
Sync call → local InMemory cache → eventual async pipeline to remote
Async call → RPC request/response to remote
```

### `attachFS` / `detachFS` / `resolveRemoteMount`

- `attachFS(channel, fs)`: Register a request handler on the port that serves a `FileSystem`
- `detachFS(channel, fs)`: Remove the request handler
- `resolveRemoteMount(channel, config)`: Create a backend, attach it to the port, and replay any messages that arrived during initialization

The `catchMessages` pattern is notable for handling race conditions during worker setup:

```typescript
// Buffers messages during FS creation to avoid losing requests
const stopAndReplay = RPC.catchMessages(port);
const fs = await resolveMountConfig(config, _depth);
attachFS(port, fs);
await stopAndReplay(fs);
```

### `SingleBuffer` Backend (`src/backends/single_buffer.ts`)

A filesystem stored entirely within a single `ArrayBuffer`/`SharedArrayBuffer`:

- Uses `Atomics.wait` / `Atomics.notify` for metadata block locking
- Uses CRC32C checksums for integrity validation
- Structured as: `SuperBlock` → `MetadataBlock` chain → Data blocks
- **Key capability**: When backed by `SharedArrayBuffer`, enables true synchronous multi-threaded access
- Uses `Atomics.add` for atomic offset allocation (bump allocator)

This is relevant for future optimization where kernel workers need synchronous FS access (e.g., for WASM modules that call synchronous `read()`).

### `Async` Mixin (`src/mixins/async.ts`)

Provides synchronous method implementations on async backends:

- Maintains an in-memory `_sync` cache
- Sync operations read/write the cache and pipeline changes asynchronously
- `ready()` preloads the remote FS contents into the sync cache
- `sync()` / `queueDone()` flushes pending pipeline operations

---

## ZenFS Capabilities We Can Leverage

### 1. PortFS as an Alternative to Our Bridge

Currently, our architecture:

```
Kernel Worker → createBridgeProxy<RuntimeFileSystemBase>(port) → our bridge RPC → file-manager worker → ZenFS
```

ZenFS's PortFS can do:

```
Kernel Worker → PortFS(port) → ZenFS RPC → file-manager worker → attachFS(port, fs) → ZenFS
```

**Pros of using ZenFS PortFS directly**:

- Full `node:fs` API surface automatically (including streams, watchers, etc.)
- `Async` mixin provides sync cache for free (useful for WASM kernels)
- Battle-tested message buffering during initialization (`catchMessages`)
- Less code to maintain in our bridge layer

**Cons**:

- Tight coupling to ZenFS in the `@taucad/runtime` package (which we explicitly decoupled)
- ZenFS's RPC is lower-level (inode-based), more verbose than our method-based bridge
- No transfer list optimization (same as our current bridge)
- PortFS has a default 250ms timeout, too aggressive for large file operations

**Recommendation**: Keep our bridge for `@taucad/runtime` (preserves the `FsLike` abstraction). Use ZenFS's PortFS capabilities only in the `apps/ui` layer where ZenFS coupling is acceptable. Specifically, consider using `resolveRemoteMount` / `attachFS` for the **main-thread ↔ file-manager worker** connection (replacing `createFileManagerProxy`), as this would give the main thread a full `node:fs`-compatible API without a manual proxy.

### 2. `catchMessages` for Initialization Race Handling

Our current `file-manager.worker.ts` relies on the machine state to prevent sends before the worker is ready. ZenFS's `catchMessages` pattern is more robust:

```typescript
// Buffer messages while the FS is being configured
const stopAndReplay = RPC.catchMessages(port);
await ensureFileSystemConfigured('indexeddb');
attachFS(port, fs);
await stopAndReplay(fs);
```

This eliminates any window where a message could be lost during worker initialization.

### 3. `SingleBuffer` + `SharedArrayBuffer` for Sync Kernel Access

Future opportunity for WASM-based kernels (OpenCASCADE, KCL) that need synchronous `read()`:

```typescript
// Main thread or file-manager worker:
const buffer = new SharedArrayBuffer(64 * 1024 * 1024); // 64 MB
const fs = SingleBuffer.create({ buffer });

// Kernel worker (synchronous access!):
const fs = SingleBuffer.create({ buffer }); // same SharedArrayBuffer
const data = fs.readSync('/model.step'); // No RPC, no async, no copy
```

**Requirements**: `SharedArrayBuffer` requires `Cross-Origin-Isolation` headers (`COOP`/`COEP`), which we may or may not have configured.

### 4. `CopyOnWrite` Backend for Snapshots

ZenFS's CopyOnWrite backend layers a writable FS over a read-only FS. This could be useful for:

- Build snapshots (read from IndexedDB, write to InMemory during a build)
- Undo/redo at the filesystem level
- Testing (overlay test data without modifying the real FS)

---

## Current Data Flow Analysis

### Connection Topology (Correct)

```
Main Thread                File-Manager Worker           Kernel Worker
     │                            │                           │
     │ ── MessageChannel ──────► │                           │
     │    port1 transferred      │                           │
     │    port2 kept as proxy    │                           │
     │                            │                           │
     │ ── MessageChannel ───────────────────────────────────► │
     │    port1 to fm-worker     │                           │
     │    port2 to runtime client │                           │
     │                            │ ◄─── direct comms ──────► │
     │                            │    (no main thread)       │
```

After setup, the main thread is **not in the hot path**. This is correct and optimal.

### Data Flow for `readFile` (Kernel → FM Worker)

```
Kernel Worker                                    File-Manager Worker
     │                                                │
     │ ── postMessage({id, method:'readFile',          │
     │     args:['/model.step']})                      │
     │     [NO transfer list]                         │
     │                                                │
     │                                          ZenFS readFile()
     │                                          Returns Buffer
     │                                          new Uint8Array(buffer)
     │                                                │
     │     postMessage({id, result: uint8array}) ◄─── │
     │     [NO transfer list]                         │
     │                                                │
     │ STRUCTURED CLONE: uint8array is COPIED          │
     │ 2× allocation, 2× copy for the data            │
```

### Data Flow for `readFile` (Main Thread → FM Worker)

Same as above but through `createFileManagerProxy` on `channel.port2`.

### Data Flow for `writeFile` (Kernel → FM Worker)

```
Kernel Worker                                    File-Manager Worker
     │                                                │
     │ ── postMessage({id, method:'writeFile',         │
     │     args:['/out.step', uint8array]})            │
     │     [NO transfer list]                         │
     │                                                │
     │ STRUCTURED CLONE: uint8array in args is COPIED  │
     │                                                │
     │                                          ZenFS writeFile()
     │                                                │
     │     postMessage({id, result: undefined}) ◄──── │
```

---

## Performance Improvement Opportunities

### Priority 1 (Critical): Add Transferable Support to Bridge — ✅ IMPLEMENTED

**Status**: Implemented via `extractTransferables(value)` utility. Both `createBridgeServer` (response) and `createBridgeCall` (request) now extract `ArrayBuffer` instances from values and include them in the `postMessage` transfer list. De-duplication prevents `DataCloneError` when the same buffer appears multiple times.

### Priority 2 (High): Batch Operations in RuntimeFileSystem — ✅ IMPLEMENTED

**Status**: `RuntimeFileSystem` now includes `readFiles`, `readdirContents`, `readdirStat`, and `ensureDir` as first-class methods. Default implementations are built from the 11 primitives via `createRuntimeFileSystem(base)`. Backends can supply optimized overrides.

### Priority 3 (Medium): Replace Manual Proxy with Generic Bridge Proxy — ✅ IMPLEMENTED

**Status**: `file-manager-proxy.ts` (hand-written ~140-line proxy) replaced by `createBridgeProxy<FileManagerProtocol>(port)` — a single-line generic `Proxy`-based RPC client. Eliminates method-by-method boilerplate. ZenFS PortFS was **not** adopted for the main-thread connection because it would bypass our custom `serialized()` write queue, reintroducing the TOCTOU race condition.

### Priority 4 (Medium): Message Buffering During Initialization — ✅ IMPLEMENTED

**Status**: `catchMessages(port)` adopted from ZenFS's pattern into the bridge primitives. Used in `file-manager.worker.ts` to buffer incoming connection messages until the server handler is set up.

### Priority 5 (Low): SharedArrayBuffer for Sync WASM Access

For future WASM kernels that need synchronous `read()`, investigate `SingleBuffer` + `SharedArrayBuffer`. Requires Cross-Origin-Isolation headers.

### Priority 6 (Low): CopyOnWrite for Build Isolation

Use ZenFS's `CopyOnWrite` backend to layer an in-memory write cache over the IndexedDB backend during builds. Prevents build artifacts from polluting the main FS until committed.

---

## ZenFS RPC vs Tau Bridge Comparison

| Aspect                       | ZenFS RPC                                          | Tau Bridge                                           |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| **Message shape (request)**  | `{ _zenfs, id, method, args, stack }`              | `{ id, method, args }`                               |
| **Message shape (response)** | `{ _zenfs, id, method, error?, value }`            | `{ id, result?, error? }`                            |
| **API level**                | Low-level inode ops (`read(path,buf,start,end)`)   | High-level (`readFile(path)`)                        |
| **Binary serialization**     | Structured clone (MessagePort), base64 (WebSocket) | Structured clone only                                |
| **Transfer lists**           | Plumbed but unused (`transferList = []`)           | Not plumbed                                          |
| **Channel support**          | MessagePort, Worker, WebSocket, Node MessagePort   | MessagePort only                                     |
| **Error format**             | `ExceptionJSON` (errno, code, message, stack)      | `BridgeError` (name, message, stack, code, metadata) |
| **Initialization safety**    | `catchMessages` buffers during setup               | Relies on machine state ordering                     |
| **Sync cache**               | `Async` mixin with `InMemory` sync cache           | None (fully async)                                   |
| **Attach/detach**            | `attachFS`/`detachFS` lifecycle management         | `createBridgeServer` (no detach)                     |
| **Timeout**                  | 250ms default (PortFS), 1000ms (generic RPC)       | 30,000ms                                             |
| **Message discrimination**   | `_zenfs: true` marker on all messages              | None (assumes all messages are bridge protocol)      |

### What We Do Better

- Higher-level API matches consumer needs (`readFile`/`writeFile` vs `read`/`write`)
- Richer error metadata (`BridgeError` with `metadata` field)
- Generous timeout (30s) appropriate for large file operations
- Clean generic bridge (generic `<T extends Record<string, unknown>>`) not tied to FS methods

### What ZenFS Does Better

- Message buffering during initialization (`catchMessages`)
- Sync cache via `Async` mixin (enables sync operations on async backends)
- Multi-channel support (WebSocket, Node.js `worker_threads`)
- Structured attach/detach lifecycle
- Message discrimination (`_zenfs: true`) prevents interference with other messages on the same port

---

## Recommendations Summary

| #   | Item                                                      | Priority | Impact        | Effort |
| --- | --------------------------------------------------------- | -------- | ------------- | ------ |
| 1   | Add `Transferable` support to bridge `postMessage`        | Critical | High          | Small  |
| 2   | Add batch `readFiles` to `RuntimeFileSystem` interface    | High     | Medium        | Small  |
| 3   | Use ZenFS `PortFS` for main-thread proxy in `apps/ui`     | Medium   | Medium        | Medium |
| 4   | Adopt `catchMessages` pattern for init safety             | Medium   | Low           | Small  |
| 5   | Investigate `SharedArrayBuffer` + `SingleBuffer` for WASM | Low      | High (future) | Large  |
| 6   | `CopyOnWrite` backend for project isolation               | Low      | Low           | Medium |

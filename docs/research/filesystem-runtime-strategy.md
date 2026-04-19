---
title: 'Filesystem Runtime Strategy'
description: 'Strategic analysis of browser filesystem approaches, ZenFS overhead, and the path to a world-class multi-runtime filesystem for Tau'
status: active
created: '2026-03-28'
updated: '2026-04-06'
category: comparison
related:
  - docs/research/shared-worker-gate-startup-performance.md
  - docs/research/vscode-fs-performance.md
  - docs/research/large-repo-import-performance.md
  - docs/research/filesystem-architecture.md
  - docs/policy/filesystem-policy.md
  - docs/policy/vision-policy.md
---

# Filesystem Runtime Strategy

Strategic analysis of whether Tau should continue building on ZenFS or adopt a different approach to achieve world-class filesystem performance across browser, Node.js, Deno, Cloudflare, and Electron runtimes — aligned with the vision policy's "files are the interface" principle.

## Executive Summary

~~Tau has built ~1500 lines of workaround code to compensate for ZenFS's architectural overhead.~~ **✅ FULLY IMPLEMENTED** — All six migration phases are complete. ZenFS has been fully replaced by `DirectIdbProvider` (VS Code-style path-keyed IDB storage), `OPFSProvider` for large binary files (mounted at `/node_modules/` via `MountTable`), and `CrossTabCoordinator` for cross-tab synchronization via `navigator.locks` + `BroadcastChannel`. The inode layer, TOCTOU vulnerability, ZenFS workaround code (`BulkImportableStoreFS`, `tauIndexedDb`, `createZenFsProvider`, `WriteCoordinator`) have all been removed. Startup scan eliminated (shallow `readDirectory` replaces recursive `getDirectoryStat`). The `FileSystemProvider` interface remains runtime-agnostic as designed.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Part 1: Tau's Actual Filesystem Requirements](#part-1-taus-actual-filesystem-requirements)
- [Part 2: ZenFS Overhead Assessment](#part-2-zenfs-overhead-assessment)
- [Part 3: Landscape Analysis](#part-3-landscape-analysis)
- [Part 4: Multi-Runtime Strategy](#part-4-multi-runtime-strategy)
- [Recommendation](#recommendation)
- [Trade-offs](#trade-offs)

## Problem Statement

The vision policy states "files are the interface" — geometry, tests, metadata, agent skills, and scripts are all files. If the filesystem is slow, the platform is unusable. Current evidence shows a 12–16 second blank screen on page refresh (see `shared-worker-gate-startup-performance.md`), driven by ZenFS creating ~19,000 IDB transactions for a 9517-entry recursive scan. This prompted the question: is Tau reinventing the wheel, and is there a better architectural path?

## Part 1: Tau's Actual Filesystem Requirements

### Access Patterns

| Path                 | Operations                                                   | Frequency                            | Latency Target |
| -------------------- | ------------------------------------------------------------ | ------------------------------------ | -------------- |
| **Kernel hot path**  | `readFile` (source), `readFile` (cache), `writeFile` (cache) | Every render cycle (debounced 300ms) | < 20ms         |
| **Editor warm path** | `readFile` (content), `writeFile` (edits)                    | Per user action                      | < 50ms         |
| **AI agent path**    | `readFile`, `writeFile`, `readdir`, `exists` via RPC         | Per tool call                        | < 100ms        |
| **Tree display**     | `readdir` + `stat` (shallow or recursive)                    | On mount, on mutation                | < 100ms        |
| **Import cold path** | Bulk `writeFile` (6000+ files from ZIP)                      | Once per import                      | < 5s           |
| **Export cold path** | Recursive `readFile` + ZIP                                   | User-initiated                       | < 5s           |

### File Size Distribution

| Category                            | Size Range   | Count per Project | Storage Type     |
| ----------------------------------- | ------------ | ----------------- | ---------------- |
| Source code (.ts, .js, .scad, .kcl) | 1–100 KB     | 10–200            | UTF-8 text       |
| Configuration (.json, parameters)   | < 10 KB      | 5–20              | UTF-8 JSON       |
| Geometry cache (.bin)               | 100 KB–10 MB | 10–100            | Binary (msgpack) |
| Transcripts (.jsonl)                | 10 KB–5 MB   | 1–10              | UTF-8 JSONL      |
| CAD export (.stl, .step, .glb)      | 1–100 MB     | Transient         | Binary           |

### Concurrency Model

Single writer (file manager worker), multiple readers (main thread + N kernel workers). All access through MessagePort bridge RPC. The writer serializes mutations; readers can proceed concurrently.

### Runtime Targets

| Runtime              | Storage          | Status                          | Need                               |
| -------------------- | ---------------- | ------------------------------- | ---------------------------------- |
| Browser (Web Worker) | IndexedDB / OPFS | **Current**                     | Full 11 primitives + watch         |
| Node.js              | `node:fs`        | **Partial** (tests, benchmarks) | Full 11 primitives                 |
| Electron             | `node:fs`        | **Future**                      | Full 11 + native watch             |
| Deno                 | `Deno.fs`        | **Future**                      | Full 11 primitives                 |
| Cloudflare Workers   | R2 / KV          | **Future**                      | read, write, exists, stat, readdir |

### What Tau Does NOT Need from a Filesystem

- Hard links, symlinks, or `nlink` tracking
- POSIX permissions/modes (all files are 0o644)
- Inode numbers (paths are the canonical identifiers)
- Synchronous APIs on the main thread (all FS work is in workers)
- Directory listing blobs stored in the backing store

## Part 2: ZenFS Overhead Assessment

### How ZenFS Works

ZenFS implements a Unix inode filesystem over a key-value store:

| Layer              | Implementation                                      | Overhead                                           |
| ------------------ | --------------------------------------------------- | -------------------------------------------------- |
| IDB keys           | Numeric inode IDs                                   | 2 lookups per read (inode → data)                  |
| IDB values         | Binary inode structs + file content                 | Must parse inode struct for metadata               |
| Directory listings | JSON blob at `inode.data`: `Record<string, number>` | Read-modify-write on every child mutation → TOCTOU |
| Path resolution    | `_ids: Map<string, number>` (in-memory)             | O(1) but requires full mount preload               |
| Mount preload      | `getAllKeys()` + `get(id)` for every key            | ~12,530 IDB reads for 6265 files                   |
| Transaction per op | `db.transaction('tau-fs', 'readwrite')`             | ~0.2ms fixed overhead × N operations               |

### What Tau Built to Work Around ZenFS

| Workaround                | Lines    | Problem It Solves                                                          |
| ------------------------- | -------- | -------------------------------------------------------------------------- |
| `InMemoryFileTree`        | ~300     | stat/readdir creates IDB transactions even for cached data                 |
| `BulkImportableStoreFS`   | ~130     | Per-file write creates ~5 IDB transactions (30,000 for a 6000-file import) |
| `ResourceWriteQueue`      | ~110     | `commitNew` read-modify-write on parent dir listing has TOCTOU             |
| `WriteCoordinator`        | ~70      | Defensive global serialization against TOCTOU                              |
| `DirectoryTreeCache`      | ~90      | Read-through cache to avoid ZenFS readdir overhead                         |
| `tauIndexedDb` backend    | ~80      | Custom backend factory returning `BulkImportableStoreFS`                   |
| `createZenFsProvider`     | ~150     | Adapter wrapping ZenFS into `FileSystemProvider`                           |
| **Total workaround code** | **~930** | —                                                                          |

### VS Code's Approach (For Comparison)

VS Code's `IndexedDBFileSystemProvider` (~430 lines) achieves better performance with a simpler architecture:

| Aspect         | ZenFS                                                                   | VS Code                                                     |
| -------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| IDB keys       | Numeric inode IDs                                                       | **Path strings** (`/src/main.ts`)                           |
| `readFile`     | path → `_ids.get()` → inode ID → `tx.get(ino)` → parse → `tx.get(data)` | **`objectStore.get(path)`** — one call                      |
| `writeFile`    | ~5 IDB transactions (exist, stat, create/commit, write, touch)          | **`objectStore.put(content, path)`** in batched tx          |
| `stat`         | 1 new IDB transaction (cache hit, but tx creation overhead)             | **0 IDB transactions** (in-memory tree)                     |
| `readdir`      | 1 new IDB transaction + 2 gets (inode + dir listing)                    | **0 IDB transactions** (in-memory tree)                     |
| Directories    | Stored as JSON blobs in IDB (TOCTOU vulnerability)                      | **In-memory only** (no IDB storage, no TOCTOU)              |
| Preload        | `getAllKeys()` + `get(id)` for every key                                | **`getAllKeys()` only** (no values, tree from path strings) |
| Write batching | 1 tx per op                                                             | **`Throttler` coalesces writes** into single tx             |
| Cross-tab sync | None                                                                    | **`BroadcastChannel`**                                      |

## Part 3: Landscape Analysis

### Browser Filesystem Solutions

| Solution                 | Architecture                                   | Performance                           | Applicability                                |
| ------------------------ | ---------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| **OPFS**                 | Native browser API, sandboxed, sync in workers | **3–4x faster than IDB** for file ops | High — aligns with Tau's worker architecture |
| **VS Code IDB provider** | Path-keyed IDB, in-memory tree                 | Proven at scale (100k+ files)         | High — simplest correct approach             |
| **ZenFS**                | Inode-based FS over IDB                        | Overhead from inode layer             | Current — working but suboptimal             |
| **WebContainers**        | Proprietary, single-instance                   | N/A — not reusable                    | None                                         |
| **Lightning-FS**         | IDB-backed `fs` for isomorphic-git             | Simpler than ZenFS, less featured     | Low — too narrow                             |
| **memfs**                | In-memory only                                 | Fast but no persistence               | None for production                          |

### Multi-Runtime FS Abstractions

| Solution                       | Pattern                  | Runtimes          | FS Support                                      |
| ------------------------------ | ------------------------ | ----------------- | ----------------------------------------------- |
| **unstorage** (UnJS)           | KV with drivers          | All               | **No** — key-value only, no dirs/stat/rename    |
| **ZenFS**                      | Virtual FS with backends | Browser + Node    | **Yes** — full POSIX, but heavy                 |
| **WinterTC** (TC55)            | Standard API surface     | All               | **Excluded** — FS not in Minimum Common Web API |
| **@cross/fs**                  | Cross-runtime fs         | Node + Deno + Bun | **No browser**                                  |
| **Tau's `FileSystemProvider`** | Provider interface       | Any (by design)   | **Yes** — 11 primitives, runtime-agnostic       |

**Key finding**: No standard or library provides a POSIX-like filesystem API across browser + server runtimes. WinterTC explicitly excludes filesystem. This is a userland problem that each application must solve.

**Key finding**: unstorage solves a different problem (KV config/cache). A CAD platform needs directory listings, file metadata, binary data, rename/move, hierarchical paths, and watch events — none of which map cleanly to a KV abstraction.

### The `node:fs` Convergence

The `node:fs` API has become the de facto portable filesystem interface:

- **Bun**: 92% `node:fs` compatibility
- **Deno**: ~95% `node:fs` compatibility via `node:` specifiers
- **ZenFS**: Full `node:fs` API in browser
- **Electron**: Native `node:fs` access

This convergence validates Tau's `FileSystemProvider` interface, which maps 1:1 to a subset of `node:fs/promises`.

## Part 4: Multi-Runtime Strategy

### Tau's Existing Architecture is Sound

Tau's `packages/filesystem` already implements the correct pattern — a **runtime-agnostic provider interface** with pluggable backends:

```
Application Code (FileService, FileTreeService, FileContentService)
       ↓
  FileSystemProvider interface (11 primitives)
       ↓
  ProviderRegistry (mount/unmount, capability flags)
       ↓
  [IndexedDB] [WebAccess] [Memory] [future: OPFS, Node, Deno, R2]
```

The `RuntimeFileSystemBase` interface used by kernel workers is a narrowed view of the same contract. Nothing in the provider interface depends on ZenFS, IndexedDB, or the browser.

### What Needs to Change

The issue is not the architecture — it's the **browser IDB provider implementation** sitting under it. ZenFS adds an inode layer that Tau pays for but doesn't need. Replacing this one provider with a VS Code-style direct IDB implementation would:

1. Eliminate the inode indirection (2 IDB reads → 1 per `readFile`)
2. Eliminate directory listing blobs (and the TOCTOU vulnerability)
3. Make `stat`/`readdir` pure in-memory (zero IDB transactions)
4. Replace 12-second preload (`getAllKeys` + `get` for every key) with ~26ms preload (`getAllKeys` only)
5. Enable write batching natively (VS Code's `Throttler` pattern)
6. Remove ~930 lines of ZenFS workaround code

### The Emscripten Question

The strongest argument for keeping ZenFS is `@zenfs/emscripten`, which mounts ZenFS into Emscripten's internal FS for WASM kernels. However, Tau's kernel workers don't directly mount ZenFS — they access files through `createBridgeProxy<RuntimeFileSystemBase>`, which calls back across a MessagePort to the file manager worker. The Emscripten FS adapter for OpenSCAD and OpenCASCADE kernels populates the WASM FS from bridge RPC results, not from a ZenFS mount.

If a kernel needs synchronous filesystem access (some Emscripten modules require `readFileSync`), this can be provided through a lightweight `MEMFS` + pre-population pattern rather than a full ZenFS mount.

## Recommendation

### Strategy: Replace the ZenFS IDB Backend, Keep Everything Above It ✅ COMPLETE

```
                    KEPT (runtime-agnostic) ✅
┌─────────────────────────────────────────────────────────┐
│  FileService  │  FileTreeService  │  FileContentService │
│  InMemoryFileTree  │  WatchRegistry  │  ChangeEventBus  │
│  BoundedFileCache  │  ResourceQueue  │  MountTable      │
├─────────────────────────────────────────────────────────┤
│              FileSystemProvider interface                │
│              ProviderRegistry                           │
├─────────────────────────────────────────────────────────┤

                    REMOVED ✅
┌─────────────────────────────────────────────────────────┐
│  ✅ ZenFS StoreFS + IndexedDB backend — removed         │
│  ✅ BulkImportableStoreFS — removed                     │
│  ✅ tauIndexedDb — removed                              │
│  ✅ WriteCoordinator — replaced by ResourceQueue        │
│  ✅ createZenFsProvider — removed                       │
└─────────────────────────────────────────────────────────┘

                    ADDED ✅
┌─────────────────────────────────────────────────────────┐
│  ✅ DirectIdbProvider (VS Code-style, path-keyed)       │
│  ✅ OPFSProvider (OPFS /node_modules/ mount)            │
│  ✅ FileSystemAccessProvider (File System Access API)   │
│  ✅ MemoryProvider (in-memory)                          │
│  ✅ CrossTabCoordinator (navigator.locks + BC)          │
│  ✅ MountTable (longest-prefix provider routing)        │
│  ✅ SharedContentPool (SAB zero-IPC reads)              │
└─────────────────────────────────────────────────────────┘
```

### What the DirectIDBProvider Looks Like

A VS Code-style provider where path strings are IDB keys, file content is the IDB value, and directory metadata is in-memory only:

- **`readFile(path)`**: `objectStore.get(path)` → `Uint8Array` (1 IDB read)
- **`writeFile(path, data)`**: Queue → batched `objectStore.put(data, path)` (amortized to 0.08ms/file)
- **`stat(path)`**: In-memory tree lookup (0 IDB transactions)
- **`readdir(path)`**: In-memory tree lookup (0 IDB transactions)
- **`mkdir(path)`**: In-memory only (directories don't exist in IDB)
- **`unlink(path)`**: Queue → batched `objectStore.delete(path)` + tree update
- **Preload**: `getAllKeys()` (~26ms for 10K keys) → build in-memory tree from path segments
- **Bulk import**: Single `objectStore.put()` per file in one transaction

This eliminates: inode resolution, directory listing blobs, TOCTOU vulnerability, `WriteCoordinator`, `BulkImportableStoreFS`, `tauIndexedDb`, and `createZenFsProvider`.

### Migration Path

| Phase | Action                                                                  | Effort     | Risk       | Status                                                                                                  |
| ----- | ----------------------------------------------------------------------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| ~~1~~ | ~~Implement `DirectIDBProvider` behind `FileSystemProvider` interface~~ | ~~Medium~~ | ~~Low~~    | ✅ RESOLVED                                                                                             |
| ~~2~~ | ~~Add feature flag to toggle between ZenFS and DirectIDB~~              | ~~Low~~    | ~~Low~~    | ✅ RESOLVED — `DirectIdbProvider` is the default; ZenFS removed                                         |
| ~~3~~ | ~~Migrate existing ZenFS databases to path-keyed format~~               | ~~Medium~~ | ~~Medium~~ | ✅ RESOLVED — ZenFS fully removed; no migration needed (fresh databases)                                |
| ~~4~~ | ~~Remove ZenFS workaround code~~                                        | ~~Low~~    | ~~Low~~    | ✅ RESOLVED — ZenFS imports, `BulkImportableStoreFS`, `tauIndexedDb`, `createZenFsProvider` all removed |
| ~~5~~ | ~~Add OPFS backend for large binary files~~                             | ~~Medium~~ | ~~Low~~    | ✅ RESOLVED — `OPFSProvider` implemented; `/node_modules/` mounted on OPFS via `MountTable`             |
| ~~6~~ | ~~Add `BroadcastChannel` cross-tab sync~~                               | ~~Low~~    | ~~Low~~    | ✅ RESOLVED — `CrossTabCoordinator` with `navigator.locks` + `BroadcastChannel`                         |

### Multi-Runtime Extension Points

The `FileSystemProvider` interface supports new runtimes without any changes to the service layer:

| Runtime    | Provider                                                          | Notes                                 | Status            |
| ---------- | ----------------------------------------------------------------- | ------------------------------------- | ----------------- |
| Browser    | `DirectIdbProvider` + `OPFSProvider` + `FileSystemAccessProvider` | Path-keyed IDB + OPFS + FS Access API | ✅ Implemented    |
| Node.js    | `NodeFSProvider` (wrap `node:fs/promises`)                        | Already exists as `fromNodeFS`        | ✅ Implemented    |
| Electron   | Same as Node.js                                                   | Native FS access                      | ⏸️ Not yet needed |
| Deno       | `DenoFSProvider` (wrap `Deno.fs`)                                 | Similar to Node adapter               | ⏸️ Not yet needed |
| Cloudflare | `R2Provider` (objects) + `KVProvider` (metadata)                  | R2 for content, KV for tree           | ⏸️ Not yet needed |

## Trade-offs

| Dimension                | Keep ZenFS                        | Replace with DirectIDB                          |
| ------------------------ | --------------------------------- | ----------------------------------------------- |
| **Effort**               | Zero (status quo)                 | Medium (new provider + migration)               |
| **Performance**          | 12s startup scan, ~5 IDB tx/write | ~26ms preload, ~0.08ms/write (batched)          |
| **Code complexity**      | ~930 lines of workarounds         | ~300 lines of provider (net -630 lines)         |
| **TOCTOU risk**          | Requires `ResourceWriteQueue`     | Eliminated (no dir listing blobs)               |
| **Emscripten FS**        | `@zenfs/emscripten` available     | Need lightweight MEMFS pre-population           |
| **`node:fs` API compat** | Full (via ZenFS)                  | Only 11 primitives (sufficient for Tau)         |
| **OPFS upgrade path**    | Via `@zenfs/dom` WebAccess        | Direct OPFS provider                            |
| **Cross-tab sync**       | Not available                     | `BroadcastChannel` (VS Code pattern)            |
| **Data migration**       | None                              | One-time IDB migration (inode keys → path keys) |

**Bottom line**: ZenFS provides POSIX fidelity Tau doesn't need, at a performance cost Tau can't afford. The inode layer, directory listing blobs, and per-operation IDB transactions are architectural overhead — not features. Tau's `FileSystemProvider` interface is already runtime-agnostic and sound. The change is surgical: replace one provider implementation, keep everything above it.

## References

- VS Code `IndexedDBFileSystemProvider`: `repos/vscode/src/vs/platform/files/browser/indexedDBFileSystemProvider.ts`
- ZenFS internals: `repos/zenfs/core/`, `repos/zenfs/dom/`
- Tau FS architecture blueprint: `docs/research/filesystem-architecture.md`
- Startup performance analysis: `docs/research/shared-worker-gate-startup-performance.md`
- VS Code FS patterns: `docs/research/vscode-fs-performance.md`
- Import performance audit: `docs/research/large-repo-import-performance.md`
- Filesystem policy: `docs/policy/filesystem-policy.md`
- Vision policy: `docs/policy/vision-policy.md`
- OPFS benchmarks: [chromestatus.com/feature/5765583086780416](https://chromestatus.com/feature/5765583086780416)
- WinterTC (TC55): [wintercg.org](https://wintercg.org)

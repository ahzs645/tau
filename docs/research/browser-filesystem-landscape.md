---
title: 'Browser Filesystem Landscape 2025-2026'
description: 'Comprehensive landscape analysis of browser-based filesystem solutions: OPFS, WebContainers, ZenFS, WASI, SQLite VFS, and cross-runtime convergence.'
status: draft
created: '2026-03-31'
updated: '2026-03-31'
category: comparison
related:
  - docs/research/filesystem-architecture.md
  - docs/policy/filesystem-policy.md
  - docs/research/large-repo-import-performance.md
  - docs/research/vscode-fs-performance.md
---

# Browser Filesystem Landscape 2025-2026

Survey of browser-based filesystem solutions and cross-runtime convergence, evaluated for applicability to a web CAD platform with multi-worker architecture and future runtime portability.

## Executive Summary

The browser filesystem space has matured significantly since 2023. OPFS has achieved universal browser support and offers 3-4x performance over IndexedDB for file I/O, but its synchronous API is restricted to dedicated workers. SQLite WASM over OPFS has emerged as a high-performance persistence layer (10-100x over raw IndexedDB for structured queries). ZenFS has replaced the deprecated BrowserFS as the standard Node.js `fs` emulation layer. WASI Preview 2 provides a capability-based filesystem abstraction but lacks browser-native support. Runtime convergence (Bun 92% `node:fs` compat, Deno near-complete) makes `node:fs` the de facto portable API surface. For Tau's architecture, the current ZenFS + IndexedDB stack remains sound; the primary upgrade path is OPFS as the storage backend with ZenFS as the API layer.

## Table of Contents

- [1. OPFS (Origin Private File System)](#1-opfs-origin-private-file-system)
- [2. StackBlitz WebContainers](#2-stackblitz-webcontainers)
- [3. CodeSandbox Nodebox / Sandpack](#3-codesandbox-nodebox--sandpack)
- [4. VS Code for Web](#4-vs-code-for-web)
- [5. isomorphic-git lightning-fs](#5-isomorphic-git-lightning-fs)
- [6. memfs / unionfs / ZenFS](#6-memfs--unionfs--zenfs)
- [7. WinterTC (formerly WinterCG)](#7-wintertc-formerly-wintercg)
- [8. Runtime FS Convergence](#8-runtime-fs-convergence)
- [9. Capacitor / Tauri Filesystem](#9-capacitor--tauri-filesystem)
- [10. WASM Filesystem Approaches](#10-wasm-filesystem-approaches)
- [11. SQLite WASM as Filesystem VFS](#11-sqlite-wasm-as-filesystem-vfs)
- [Comparison Matrix](#comparison-matrix)
- [Recommendations](#recommendations)

## Problem Statement

Tau's filesystem serves three access patterns — interactive editing (<50ms), kernel computation (batch reads, cache I/O), and asset management (large binary import/export). The current architecture uses ZenFS with an IndexedDB backend in a single FS worker. This research evaluates whether newer solutions offer meaningful improvements in performance, portability, or architectural simplicity.

## Methodology

Web research across official documentation, GitHub repositories, benchmark pages, and technical blog posts. Evaluation criteria: architecture approach, performance characteristics, browser/runtime support, concurrency model, and applicability to a multi-worker CAD platform.

## Findings

### 1. OPFS (Origin Private File System)

**Architecture**: Browser-native private filesystem API. Files are stored in a sandboxed origin-scoped directory invisible to the user. Two access modes: asynchronous (main thread + workers) and synchronous via `createSyncAccessHandle()` (dedicated workers only).

**Performance**:

| Metric               | OPFS                       | IndexedDB            | Notes                           |
| -------------------- | -------------------------- | -------------------- | ------------------------------- |
| General throughput   | 3-4x faster                | Baseline             | RxDB benchmarks                 |
| 100KB × 1000 writes  | ~Node.js parity            | ~3-4x slower         | OPFS-tools benchmark            |
| Sync handle overhead | ~0 (no Promise resolution) | N/A                  | Eliminates async tax in workers |
| Small I/O (<512B)    | Regression in WasmFS       | Faster for small ops | Chrome/Edge WasmFS issue #24639 |

**Browser Support** (universal as of 2023):

| Browser          | Supported Since | Current |
| ---------------- | --------------- | ------- |
| Chrome/Edge      | 108             | 146+    |
| Firefox          | 111             | 148+    |
| Safari           | 16.4            | 26.2+   |
| Safari iOS       | 16.4            | 26.2+   |
| Samsung Internet | 21              | 29+     |

**Concurrency Constraints**:

- `createSyncAccessHandle()`: exclusive lock by default (`readwrite` mode). Only one handle per file.
- `read-only` mode: multiple concurrent handles allowed.
- `readwrite-unsafe` mode: multiple handles with no safety guarantees.
- Handles are not transferable between workers via `postMessage()` (throws `DataCloneError`).
- Multi-tab coordination requires explicit locking (Navigator locks, BroadcastChannel).

**Private browsing**: Chrome limits OPFS to ~100MB in incognito. Firefox and Safari disable OPFS entirely in private mode.

**Applicability to Tau**: High. OPFS is the natural upgrade path for the IndexedDB storage backend. The synchronous API aligns with Tau's dedicated FS worker architecture. The exclusive-lock model is compatible with the single-writer policy. Key constraint: OPFS handles cannot be shared between workers, so the centralized FS worker pattern remains necessary (handles stay in the FS worker, RPC bridge serves other workers).

### 2. StackBlitz WebContainers

**Architecture**: In-browser Node.js runtime using WebAssembly. Filesystem is an in-memory virtual FS exposed via a subset of the Node.js `fs` API (`readFile`, `readdir`, `rm`, `writeFile`, `mkdir`). Files are loaded via `mount()` with `FileSystemTree` objects or binary snapshots (`@webcontainer/snapshot`).

**Requirements**: SharedArrayBuffer (cross-origin isolation via COOP/COEP headers), HTTPS, single instance per page. Heavy reliance on `Atomics` API for synchronous inter-worker communication.

**Limitations**:

- Intentionally limited `fs` API — full Node.js `fs` compatibility is a stated non-goal.
- Single WebContainer instance per page.
- Proprietary, closed-source core.
- No persistence beyond session (files live in memory).

**Performance**: Optimized for development workflow speed (npm install, bundling, dev servers). Not designed for large file I/O or binary asset management.

**Applicability to Tau**: Low. The proprietary, single-instance model conflicts with Tau's multi-worker architecture. The limited `fs` API cannot support CAD file operations. The cross-origin isolation requirement (COOP/COEP headers) imposes deployment constraints. However, the binary snapshot mounting pattern is a useful reference for Tau's bulk import architecture.

### 3. CodeSandbox Nodebox / Sandpack

**Architecture**: Nodebox is an in-browser Node.js abstraction running in Sandpack 2.0. The filesystem is persistent (backed by git source control at `/project/workspace`), supports file watching, and provides a Node.js `fs`-like API with batch operations, upload/download, and directory operations.

**Key Design Decision**: Unified filesystem shared across all runtime components (browser, Python interpreter, bash shell). Files written by one component are immediately visible to others without manual data transfer.

**Applicability to Tau**: Medium-low. The unified FS visibility model is architecturally interesting — Tau achieves similar semantics through its centralized FS worker + RPC bridge. The persistent git-backed storage is not relevant for client-side CAD. Sandpack is designed for code playground embedding, not heavy compute workloads.

### 4. VS Code for Web (vscode.dev)

**Architecture**: Multi-layered filesystem with three providers:

1. **File System Access API**: Bridges to the user's local filesystem via `FileSystemHandle`. Handles stored in IndexedDB (`vscode-web-db` / `vscode-filehandles-store`) for cross-session persistence. Persistent permissions since Chrome 122 ("Allow on every visit").

2. **IndexedDBFileSystemProvider**: Full in-browser filesystem backed by IndexedDB. Key optimizations:
   - Native `Uint8Array` storage (no string conversion for binary data).
   - Batched write/delete operations in single IndexedDB transactions.
   - Persisted directory structure (not memory-only).
   - Optimized `readdir` (no full-scan of all files).

3. **FileSystemProvider interface**: Abstraction layer (`watch`, `stat`, `readDirectory`, `createDirectory`, `readFile`, `writeFile`, `delete`, `rename`, `copy`) that extensions can implement to surface remote filesystems (FTP, SSH, cloud storage).

**Applicability to Tau**: High — VS Code's architecture is the most directly relevant reference. Tau already draws from VS Code patterns (the `repos/vscode` reference clone). Key takeaways:

- The `FileSystemProvider` abstraction is similar to Tau's provider pattern.
- IndexedDB batching optimizations are directly applicable.
- The persistent `FileSystemHandle` storage pattern could enable Tau to offer "open local folder" functionality in supported browsers.

### 5. isomorphic-git lightning-fs

**Architecture**: Minimal Node.js `fs` subset backed by IndexedDB, designed for isomorphic-git. Hybrid in-memory/IndexedDB design:

| Operation Type                                | Storage   | Latency             |
| --------------------------------------------- | --------- | ------------------- |
| `mkdir`, `rmdir`, `readdir`, `rename`, `stat` | In-memory | ~0ms                |
| `writeFile`, `readFile`, `unlink`             | IndexedDB | Bottlenecked by IDB |

The in-memory filesystem tree is persisted to IndexedDB with a 500ms debounce. Multi-tab access uses a mutex via IndexedDB polling with atomic compare-and-replace, releasing after 500ms inactivity.

**Performance at Scale**:

| Repository              | Before optimization | After optimization | Speedup |
| ----------------------- | ------------------- | ------------------ | ------- |
| VS Code (~5k files)     | ~60s                | ~20s               | 3x      |
| TypeScript (~50k files) | ~15+ min            | ~2 min             | 7.5x    |

Key optimizations: batched IndexedDB writes and fixing O(N²) inode allocation.

**Applicability to Tau**: Medium. Tau's `InMemoryFileTree` and `BulkImportableStoreFS` already implement similar patterns (O(1) stat/readdir via in-memory tree, single-transaction bulk import). Lightning-fs validates the hybrid in-memory-tree + IDB-persistence architecture that Tau uses. The mutex-based multi-tab coordination is a simpler alternative to Tau's single-writer model, but lacks the performance guarantees needed for concurrent kernel access.

### 6. memfs / unionfs / ZenFS

#### memfs

**Architecture**: TypeScript in-memory filesystem implementing Node.js `fs` API. Since July 2025, also implements the browser File System Access API on top of its core Superblock class (`CoreFileSystemHandle`, `CoreFileSystemDirectoryHandle`, `CoreFileSystemFileHandle`).

**Ecosystem**: `unionfs` (v4.6.0) layers multiple `fs` implementations; `fs-monkey` patches Node's `fs`; `linkfs` redirects paths; `spyfs` spies on operations.

**Applicability to Tau**: Low-medium. Useful for testing (virtual filesystem mocks) but not designed for persistent browser storage. The unionfs layering concept is architecturally relevant — similar to how Tau layers project files over template files.

#### ZenFS (BrowserFS successor)

**Architecture**: Maintained fork of the deprecated BrowserFS (deprecated March 2024). Cross-platform TypeScript library emulating Node.js `fs`. Modular backend system:

| Backend                   | Package           | Description                 |
| ------------------------- | ----------------- | --------------------------- |
| InMemory                  | `@zenfs/core`     | RAM-only                    |
| IndexedDB                 | `@zenfs/dom`      | Browser persistence         |
| WebStorage                | `@zenfs/dom`      | localStorage/sessionStorage |
| Fetch                     | `@zenfs/core`     | Read-only HTTP              |
| Dropbox, Google Drive, S3 | `@zenfs/cloud`    | Cloud storage               |
| ISO, ZIP                  | `@zenfs/archives` | Archive formats             |
| Port                      | `@zenfs/core`     | Cross-worker proxy          |
| CopyOnWrite               | `@zenfs/core`     | Overlay filesystem          |

**Adoption**: isomorphic-git migrated from lightning-fs to ZenFS (November 2025). Eclipse Theia migrated from BrowserFS. ~8,800 weekly npm downloads (surpassing BrowserFS). Current release: v2.5.4 (March 2026).

All backends support synchronous operations. The Port backend enables cross-worker access (similar to Tau's RPC bridge pattern).

**Applicability to Tau**: Critical — ZenFS is Tau's current filesystem layer. The modular backend system enables swapping IndexedDB for OPFS without changing consumer code. The Port backend validates the cross-worker proxy architecture. The CopyOnWrite backend is relevant for potential branching/undo features. ZenFS's sync API matches Tau's kernel requirements (WASM kernels need synchronous `fs` calls).

### 7. WinterTC (formerly WinterCG)

**Architecture**: Ecma TC55 technical committee (promoted from W3C Community Group in January 2025) defining a minimum common API for server-side JavaScript runtimes. Core principle: "the browser is the baseline" — servers adopt browser APIs rather than inventing new ones.

**Key Deliverables**:

- **ECMA-429 (December 2025)**: Minimum Common Web API standard — curated subset of Web Platform APIs that all server runtimes should implement. Published annually.
- **Sockets API (draft, June 2025)**: TCP connections for non-browser runtimes using `ReadableStream`/`WritableStream`.

**Filesystem Status**: WinterTC does **not** include a filesystem API in the minimum common standard. Filesystem access is inherently platform-specific (browser sandbox vs. server full access), making it unsuitable for a cross-runtime baseline. The standard focuses on network, crypto, encoding, and streaming APIs.

**Applicability to Tau**: Low for filesystem specifically. WinterTC validates the approach of targeting browser APIs as the baseline and extending for server runtimes. For Tau's potential server-side rendering or backend file processing, WinterTC-compliant APIs (streams, crypto) are relevant, but filesystem portability must be solved at a higher layer (ZenFS, WASI, or custom abstraction).

### 8. Runtime FS Convergence

#### Bun

`node:fs` and `node:fs/promises` are fully implemented with **92% of Node.js test suite passing** (Bun 1.2, January 2025). File I/O is faster than Node.js. Core limitation: native C/C++ addons compiled for V8 don't work (Bun uses JavaScriptCore). Practical drop-in replacement for Node.js filesystem code.

#### Deno

Near-complete `node:fs` compatibility as of March 2026:

- `FileHandle` methods: mostly implemented (February 2026).
- `fs.stat`/`fs.statSync`: full compatibility including `ino`, `nlink`, `blocks` on Windows (September 2025).
- Top-level APIs: `fchown`, `fchmod`, `glob`, `lchmod` implemented (March 2026).
- Outstanding: `openAsBlob` unimplemented; permission errors throw `NotCapable` instead of Node-compatible `EACCES` codes (breaks Emscripten NODEFS — relevant for Tau's WASM kernels).

#### Convergence Assessment

| API                    | Node.js      | Bun        | Deno        | Browser            |
| ---------------------- | ------------ | ---------- | ----------- | ------------------ |
| `node:fs`              | Native       | 92% compat | ~95% compat | Via ZenFS/memfs    |
| `node:fs/promises`     | Native       | Full       | Full        | Via ZenFS          |
| OPFS                   | N/A          | N/A        | N/A         | Native             |
| File System Access API | N/A          | N/A        | N/A         | Chrome/Edge/Safari |
| WASI filesystem        | Via wasmtime | Via jco    | Deno.wasi   | Polyfill only      |

`node:fs` has become the de facto portable filesystem API. All three server runtimes support it with high compatibility. Browser environments require a shim layer (ZenFS), but the API surface is the same. This validates Tau's choice of the `node:fs` API as the abstraction boundary.

**Applicability to Tau**: High. If Tau ever targets server-side or native runtimes (Tauri, Electron, server-side pre-rendering), the `node:fs` API surface works across all targets. The ZenFS browser backend provides the browser implementation, while native runtimes use their built-in `node:fs`.

### 9. Capacitor / Tauri Filesystem

#### Tauri v2 (`@tauri-apps/plugin-fs`)

**Architecture**: Rust-backed filesystem plugin with JavaScript bindings. Supports Linux, Windows, macOS, Android, iOS. Security model: scope-based access control with glob patterns, path traversal prevention.

**API**: `readFile`, `writeFile`, `readDir`, `mkdir`, `remove`, `rename`, `copyFile`, `stat`, `exists`, `watch`. Base directory system (`$APPDATA`, `$DESKTOP`, `$DOWNLOAD`, etc.) for platform-portable paths.

**Applicability to Tau**: Medium-high for native distribution. If Tau ships as a Tauri app, the filesystem plugin provides direct OS-level file access with cross-platform abstraction. The security scope model (glob-based path restrictions) could replace or complement the browser sandbox. The `watch` API provides native filesystem events, superior to IndexedDB polling.

#### Capacitor (`@capacitor/filesystem`)

**Architecture**: Node.js-like API for mobile/web. Methods: `readFile`, `writeFile`, `appendFile`, `deleteFile`, `mkdir`, `rmdir`, `readdir`, `stat`, `rename`, `copy`. Platform-specific permission handling (Android `READ_EXTERNAL_STORAGE`, iOS `UIFileSharingEnabled`).

**Applicability to Tau**: Low-medium. Relevant only if Tau targets native mobile apps. The API is simpler than Tauri's and lacks the performance characteristics needed for CAD workloads. The permission model adds complexity without benefit for a browser-first application.

### 10. WASM Filesystem Approaches

#### Emscripten Filesystems

| Filesystem  | Type                         | Persistence         | Memory             | Performance                       |
| ----------- | ---------------------------- | ------------------- | ------------------ | --------------------------------- |
| MEMFS       | In-memory ramdisk            | None                | All data in RAM    | Fastest for reads                 |
| IDBFS       | MEMFS + IndexedDB sync       | `syncfs()` to IDB   | All data in RAM    | Same as MEMFS + sync overhead     |
| WasmFS/OPFS | New framework + OPFS backend | Direct to OPFS      | Minimal (streamed) | 2x slower for small I/O in Chrome |
| mapfs       | Manifest-based multi-backend | Depends on backends | Minimal            | New (March 2025)                  |

**Key Finding**: WasmFS/OPFS has a performance regression for small reads/writes (<512B) compared to IDBFS in Chrome/Edge (issue #24639). Root cause: WasmFS falls back to a legacy blob API for read-only files to enable concurrent tab reads. This is being addressed but means IDBFS remains the practical choice for small-file-heavy workloads (like CAD source files).

**IDBFS RAM caveat**: IDBFS does not reduce memory usage — it is MEMFS with a persistence layer. All filesystem contents remain in RAM. For Tau's kernel workers processing large assemblies, this means IDBFS memory consumption scales linearly with project size.

#### WASI Preview 2 (`wasi:filesystem`)

**Architecture**: Capability-oriented filesystem in the WebAssembly Component Model. Phase 3 (implementation). Provides sandboxed path resolution, file/directory operations, and `metadata-hash` (replacing inode/device concepts).

**Browser Support**: No native browser implementation. Requires a JavaScript polyfill host (e.g., `jco` for component model). The Bytecode Alliance's `wasmtime` is the reference implementation, targeting server-side WASM.

**Applicability to Tau**: Low for near-term, medium for long-term. WASI filesystem does not run natively in browsers. However, if the WASM ecosystem converges on Component Model, Tau's kernels could use `wasi:filesystem` as a capability-based API, with the host (Tau's FS worker) implementing the actual storage backend. This would decouple kernels from the storage layer more cleanly than the current Emscripten MEMFS approach. The `mapfs` backend is architecturally interesting — it enables composing multiple backends via a manifest, similar to how Tau layers project files, cache, and assets.

### 11. SQLite WASM as Filesystem VFS

**Architecture**: SQLite compiled to WASM with a Virtual File System (VFS) layer that maps SQLite's file operations to browser storage. Two primary VFS implementations for OPFS:

| VFS                   | Concurrency                   | Use Case                  |
| --------------------- | ----------------------------- | ------------------------- |
| `AccessHandlePoolVFS` | Single worker only            | Simple single-tab apps    |
| `OPFSCoopSyncVFS`     | Multi-tab via Navigator locks | Production multi-tab apps |

**Performance**:

| Metric                     | SQLite WASM/OPFS | IndexedDB | Source                      |
| -------------------------- | ---------------- | --------- | --------------------------- |
| Notion caching layer       | 10x faster       | Baseline  | Production deployment       |
| Email client (Supersorted) | 100x faster load | Baseline  | Real-world migration        |
| wa-sqlite MemoryVFS insert | 40x faster       | N/A       | Proxy elimination (PR #273) |

**Bundle Size**: ~3MB gzipped. Requires COOP/COEP headers for SharedArrayBuffer.

**Applicability to Tau**: Medium for specific use cases. Not a replacement for the general-purpose filesystem, but compelling for:

- **Geometry cache**: SQL queries over cached geometry metadata (parametric variants, dependency graphs).
- **Project index**: Fast structured queries over file metadata, search indexes.
- **Parameter storage**: SQL schema for parameter overrides instead of JSON files.

The 3MB bundle cost and COOP/COEP header requirement are the main trade-offs. Tau already requires COOP/COEP for SharedArrayBuffer (used by runtime workers), so the header constraint is not incremental.

## Comparison Matrix

| Solution             | API Model           | Storage Backend                      | Persistence          | Concurrency              | Bundle Size    | Browser Support      | Performance vs IDB  |
| -------------------- | ------------------- | ------------------------------------ | -------------------- | ------------------------ | -------------- | -------------------- | ------------------- |
| **OPFS**             | Browser-native      | Origin-private files                 | Yes                  | Exclusive lock per file  | 0 (native)     | Universal (2023+)    | 3-4x faster         |
| **WebContainers**    | Node.js subset      | In-memory                            | No                   | Single instance          | Proprietary    | COOP/COEP required   | N/A                 |
| **Nodebox/Sandpack** | Node.js `fs`-like   | Git-backed                           | Yes                  | Shared across components | SDK            | Broad                | N/A                 |
| **VS Code Web**      | FileSystemProvider  | IndexedDB + FSA API                  | Yes                  | Single-writer batched    | N/A (monolith) | Broad                | Optimized IDB       |
| **lightning-fs**     | Node.js `fs` subset | IndexedDB + in-memory                | Yes (500ms debounce) | Mutex via IDB polling    | ~15KB          | All IDB browsers     | In-memory ops ~0ms  |
| **ZenFS**            | Node.js `fs` full   | Pluggable (IDB, OPFS, memory, cloud) | Backend-dependent    | Port backend for workers | ~30KB core     | Universal            | Backend-dependent   |
| **memfs**            | Node.js `fs` + FSA  | In-memory                            | No                   | N/A (in-memory)          | ~25KB          | Universal            | RAM speed           |
| **SQLite WASM**      | SQL                 | OPFS VFS                             | Yes                  | Navigator locks          | ~3MB gzipped   | COOP/COEP required   | 10-100x for queries |
| **WASI filesystem**  | Capability-based    | Host-provided                        | Host-dependent       | Host-controlled          | Polyfill ~50KB | Polyfill only        | Host-dependent      |
| **Tauri FS**         | Plugin API          | Native OS                            | Yes                  | OS-level                 | N/A (native)   | N/A (desktop/mobile) | Native speed        |
| **Capacitor FS**     | Plugin API          | Native OS                            | Yes                  | OS-level                 | ~5KB           | Web + native         | Native speed        |

## Recommendations

| #   | Action                                                                                                              | Priority | Effort | Impact                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------ |
| R1  | Evaluate ZenFS OPFS backend (`@zenfs/dom` or custom) as drop-in replacement for IndexedDB backend                   | P1       | Medium | High — 3-4x I/O improvement for file-heavy operations        |
| R2  | Keep ZenFS as the API layer — `node:fs` is the converged portable API across all runtimes                           | P0       | None   | High — future-proofs for Bun/Deno/native targets             |
| R3  | Investigate SQLite WASM/OPFS for geometry cache and project index (structured queries over metadata)                | P2       | High   | Medium — eliminates custom cache serialization               |
| R4  | Monitor WASI Preview 2 browser polyfills — potential clean kernel/FS decoupling in 2027+                            | P3       | None   | Medium-long term architectural improvement                   |
| R5  | Consider File System Access API integration for "open local folder" in Chrome/Edge (VS Code pattern)                | P2       | Medium | Medium — enables local-first workflow without import         |
| R6  | Avoid WasmFS/OPFS for kernel filesystems until small-I/O regression is resolved (Emscripten #24639)                 | P1       | None   | High — prevents performance regression for source file reads |
| R7  | If native distribution via Tauri is pursued, the filesystem plugin provides a natural drop-in for the ZenFS backend | P3       | Low    | Medium — eliminates browser storage constraints              |

## Trade-offs

### OPFS vs IndexedDB as Storage Backend

| Dimension        | OPFS                              | IndexedDB                       |
| ---------------- | --------------------------------- | ------------------------------- |
| Raw throughput   | 3-4x faster                       | Baseline                        |
| API ergonomics   | File-oriented (natural for FS)    | Object-store (requires mapping) |
| Sync access      | Yes (dedicated workers only)      | No (always async)               |
| Multi-tab access | Requires explicit locking         | Built-in transaction isolation  |
| Private browsing | Disabled in Firefox/Safari        | Works everywhere                |
| Debugging tools  | Limited (OPFS Explorer extension) | Chrome DevTools built-in        |
| Maturity         | 2 years in production             | 10+ years                       |

**Verdict**: OPFS is the superior storage backend for Tau's architecture. The single-writer FS worker model eliminates the multi-tab locking concern. The sync access in workers aligns with kernel requirements. The private browsing limitation is acceptable (Tau projects require persistence). Migration path: implement OPFS backend for ZenFS while keeping IndexedDB as fallback.

### ZenFS vs Custom FS Layer

| Dimension          | ZenFS                         | Custom              |
| ------------------ | ----------------------------- | ------------------- |
| API coverage       | Full `node:fs`                | Only what Tau needs |
| Backend system     | Pluggable, maintained         | Full control        |
| Community          | Growing (8.8k downloads/week) | Internal only       |
| Bundle size        | ~30KB                         | Potentially smaller |
| Maintenance burden | External                      | Internal            |
| Sync support       | All backends                  | Controllable        |

**Verdict**: Continue with ZenFS. The pluggable backend system enables OPFS migration without rewriting consumers. The full `node:fs` API is needed for kernel compatibility (Emscripten NODEFS, esbuild, etc.). The maintenance burden of a custom implementation outweighs the ~10KB bundle savings.

## References

- [OPFS — web.dev](https://web.dev/articles/origin-private-file-system)
- [OPFS browser support — Can I Use](https://caniuse.com/wf-origin-private-file-system)
- [OPFS createSyncAccessHandle — MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)
- [WasmFS OPFS regression — Emscripten #24639](https://github.com/emscripten-core/emscripten/issues/24639)
- [ZenFS core — GitHub](https://github.com/zen-fs/core)
- [lightning-fs — GitHub](https://github.com/isomorphic-git/lightning-fs)
- [WebContainers API — StackBlitz](https://webcontainers.io/api)
- [VS Code IndexedDBFileSystemProvider — GitHub PR #105022](https://github.com/microsoft/vscode/pull/105022)
- [WinterTC announcement — W3C](https://www.w3.org/community/wintercg/2025/01/10/goodbye-wintercg-welcome-wintertc/)
- [WASI filesystem — GitHub](https://github.com/WebAssembly/wasi-filesystem)
- [SQLite OPFS persistence — PowerSync](https://www.powersync.co/blog/sqlite-persistence-on-the-web)
- [RxDB OPFS benchmarks](https://rxdb.info/rx-storage-opfs.html)
- [memfs FSA implementation — GitHub PR #1131](https://github.com/streamich/memfs/pull/1131)
- [Tauri filesystem plugin — Tauri v2](https://v2.tauri.app/plugin/file-system)
- [Capacitor filesystem plugin](https://capacitorjs.com/docs/v5/apis/filesystem)
- [Bun node:fs compatibility](https://bun.sh/docs/ecosystem/nodejs)
- [Deno node:fs compatibility](https://docs.deno.com/api/node/fs/)
- [ECMA-429 Minimum Common Web API](https://min-common-api.proposal.wintercg.org/)

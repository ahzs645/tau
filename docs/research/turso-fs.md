---
title: 'Turso Filesystem & Database Architecture for Browser-Native CAD'
description: 'Deep analysis of Turso database engine, AgentFS filesystem abstraction, and database-wasm browser architecture — extracting patterns, techniques, and recommendations for Tau filesystem evolution.'
status: active
created: '2026-03-28'
updated: '2026-03-28'
category: reference
related:
  - docs/research/filesystem-gap-analysis.md
  - docs/research/filesystem-architecture.md
  - docs/research/vscode-fs-performance.md
  - docs/research/fs-capabilities.md
  - docs/policy/filesystem-policy.md
  - docs/policy/vision-policy.md
---

# Turso Filesystem & Database Architecture for Browser-Native CAD

Deep-dive into the Turso database ecosystem — Turso (SQLite rewrite in Rust), AgentFS (POSIX filesystem over SQLite), and `@tursodatabase/database-wasm` (browser WASM runtime) — to extract architectural patterns, browser API techniques, and performance strategies applicable to Tau's filesystem layer.

## Executive Summary

Turso demonstrates a production-grade approach to browser-native database and filesystem access: shared WASM linear memory between main thread and a dedicated OPFS worker, completion-based async IO, SQLite-backed POSIX filesystem abstraction with inode/dentry/chunked-blob schema, and copy-on-write overlays for agent isolation. Key findings for Tau: (1) shared `WebAssembly.Memory` eliminates bulk data copying between threads, (2) dedicated OPFS worker with sync access handles provides 3-4x IDB performance, (3) inode+dentry+chunked-blob schema enables SQL-debuggable filesystem with partial reads, (4) RAM-first caching policy on WASM builds trades memory for fewer storage round-trips, (5) copy-on-write overlays enable agent branching/experimentation. Ten concrete recommendations are provided for Tau's filesystem evolution.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Turso Database Engine](#finding-1-turso-database-engine-architecture)
- [SharedArrayBuffer IO Pattern](#finding-2-sharedarraybuffer--shared-wasm-memory-io-pattern)
- [OPFS Worker Architecture](#finding-3-dedicated-opfs-worker-architecture)
- [Completion-Based Async IO](#finding-4-completion-based-async-io-model)
- [Virtual File System Layer](#finding-5-virtual-file-system-vfs-layer)
- [Page Cache Strategy](#finding-6-wasm-optimized-page-cache-strategy)
- [AgentFS POSIX Filesystem](#finding-7-agentfs-posix-filesystem-over-sqlite)
- [Copy-on-Write Overlay](#finding-8-copy-on-write-overlay-filesystem)
- [Bundler Integration](#finding-9-bundler-integration-patterns)
- [Cross-Origin Isolation](#finding-10-cross-origin-isolation-requirements)
- [Recommendations](#recommendations)
- [Tau Alignment Analysis](#tau-alignment-analysis)

## Problem Statement

Tau's vision (docs/policy/vision-policy.md) demands a filesystem that scales to 100,000+ files, serves multiple concurrent workers (kernel, editor, file manager), and handles binary CAD assets up to 100 MB — all in the browser. The existing architecture uses IndexedDB with structured-clone transfers and ZenFS abstractions. Turso and AgentFS represent state-of-the-art browser database and filesystem implementations. This investigation mines their architectures for patterns that could strengthen Tau's filesystem layer.

## Methodology

1. Cloned `tursodatabase/turso` and `tursodatabase/agentfs` via `repos.yaml` into `repos/turso` and `repos/agentfs`
2. Fetched and analyzed four Turso blog posts: "Introducing Turso in the Browser", "Turso v0.5.0", "AgentFS in the Browser", and the AgentFS marketing site
3. Deep source-code analysis of `bindings/javascript/packages/wasm-common/` (browser runtime), `bindings/javascript/src/browser.rs` (Rust WASM bridge), `core/io/` (VFS layer), `core/storage/` (page cache, WAL), `sdk/typescript/` (AgentFS TypeScript SDK), and `sdk/rust/` (AgentFS Rust SDK)
4. Cross-referenced findings against Tau's filesystem architecture blueprint, gap analysis, and VS Code performance research

## Findings

### Finding 1: Turso Database Engine Architecture

Turso is a complete rewrite of SQLite in Rust, not a thin wrapper. The browser build targets `wasm32-wasip1-threads` via `napi build --features browser`, producing a full database engine compiled to WASM.

**Thread model:**

| Thread       | Role                                                | API Surface                                     |
| ------------ | --------------------------------------------------- | ----------------------------------------------- |
| Main thread  | WASM module execution, SQL stepping, query results  | Async `Database.prepare().run()`                |
| OPFS worker  | Synchronous `FileSystemSyncAccessHandle` operations | `read`, `write`, `flush`, `truncate`, `getSize` |
| emnapi child | NAPI module attachment for worker-side bindings     | Internal plumbing                               |

The main thread runs all compute (SQL parsing, query execution, VDBE stepping). IO is offloaded to the dedicated OPFS worker. This split is deliberate — Turso benchmarked worker-to-main communication overhead and found it cheaper to keep compute on main and only offload storage IO.

**Source:** `repos/turso/bindings/javascript/packages/wasm-common/index.ts` (lines 419–484)

### Finding 2: SharedArrayBuffer / Shared WASM Memory IO Pattern

Turso does **not** use a hand-rolled `SharedArrayBuffer` ring buffer or `Atomics.wait`/`Atomics.notify` for IO coordination. Instead, it uses **shared `WebAssembly.Memory`** — the WASM linear memory itself is backed by a `SharedArrayBuffer`:

```typescript
const __sharedMemory = new WebAssembly.Memory({
  initial: 4000, // ~256 MB initial
  maximum: 65536, // ~4 GB maximum
  shared: true,
});
```

Both the main thread and OPFS worker share this memory. When the main thread needs IO, it passes **pointer + length + offset** via `postMessage`. The worker creates a `Uint8Array` view into the same shared memory and performs the OPFS operation directly — no data copying across threads for bulk content.

```typescript
function getUint8ArrayFromMemory(memory: WebAssembly.Memory, ptr: number, len: number): Uint8Array {
  ptr = ptr >>> 0;
  return new Uint8Array(memory.buffer).subarray(ptr, ptr + len);
}
```

**Key insight for Tau:** The zero-copy pattern here is **pointer-passing over shared memory**, not `postMessage` transferables. The main thread and worker operate on the same buffer simultaneously. This is fundamentally different from Tau's current approach of structured cloning or ownership-transferring `ArrayBuffer`s across the worker boundary.

**Tradeoff:** Requires `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin` headers for `SharedArrayBuffer` availability.

**Source:** `repos/turso/bindings/javascript/packages/wasm-common/index.ts` (lines 10–13, 426–430)

### Finding 3: Dedicated OPFS Worker Architecture

Turso's OPFS worker owns all `FileSystemSyncAccessHandle` instances. The `OpfsDirectory` class manages file registration, handle lifecycle, and synchronous IO:

| Operation     | Implementation                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Register file | `navigator.storage.getDirectory()` → `getFileHandle(path, {create: true})` → `createSyncAccessHandle()` |
| Read          | `handle.read(buffer, { at: offset })` — returns bytes read                                              |
| Write         | `handle.write(buffer, { at: offset })` — returns bytes written                                          |
| Flush         | `handle.flush()` — durability barrier                                                                   |
| Truncate      | `handle.truncate(size)`                                                                                 |
| Get size      | `handle.getSize()`                                                                                      |
| Unregister    | `handle.close()`                                                                                        |

**Pre-registration requirement:** Files must be registered before the database opens. Turso pre-registers the DB file and its `-wal` companion. The Rust engine's `lookup_file` returns `-404` for unregistered paths. This design avoids "create on first open" races in the async/sync boundary.

**Worker message protocol:** Simple string-tagged objects via `postMessage`, not a binary command ring:

| Direction     | Tag              | Payload                                |
| ------------- | ---------------- | -------------------------------------- |
| Main → Worker | `register`       | `path`, `id`                           |
| Main → Worker | `read_async`     | `handle`, `ptr`, `len`, `offset`, `id` |
| Main → Worker | `write_async`    | `handle`, `ptr`, `len`, `offset`, `id` |
| Main → Worker | `sync_async`     | `handle`, `id`                         |
| Main → Worker | `truncate_async` | `handle`, `len`, `id`                  |
| Worker → Main | response         | `id`, `result`, `error?`               |

**Locking:** `OpfsFile::lock_file` / `unlock_file` are **no-ops** in the browser. OPFS's `createSyncAccessHandle()` implicitly locks the file to the worker — no advisory locking needed. This constrains one database to one tab.

**Source:** `repos/turso/bindings/javascript/packages/wasm-common/index.ts` (lines 171–264, 300–414)

### Finding 4: Completion-Based Async IO Model

The Rust engine uses a **completion-based** IO model, not blocking syscalls. When the VDBE (Virtual Database Engine) needs IO:

1. Rust calls `pread_async` / `pwrite_async` — registers a `Completion` in a thread-local `HashMap<u32, Completion>` keyed by monotonic `completion_no`
2. JS `mainImports` forwards `{ handle, ptr, len, offset, id }` to the OPFS worker via `postMessage`
3. The OPFS worker performs synchronous IO and responds
4. JS calls `nativeCompleteOpfs(completion_no, result)` → Rust removes the completion and resolves it
5. `IONotifier.notify()` wakes any waiters in the SQL step loop

```typescript
completeOpfs = (c, res) => {
  nativeCompleteOpfs(c, res);
  ioNotifier.notify();
};

class IONotifier {
  private waiters: Array<() => void> = [];
  waitForCompletion(): Promise<void> {
    /* ... */
  }
  notify() {
    /* flush waiters */
  }
}
```

The SQL step loop calls `await io()` when `stepSync()` returns `STEP_IO`, cooperatively yielding to the event loop rather than blocking.

**Buffer lifetime:** For async writes, Rust explicitly keeps the write buffer alive until the completion fires: `c.keep_write_buffer_alive(buffer.clone())`. This prevents the WASM allocator from reclaiming the buffer while the worker is still reading from it via the shared memory view.

**Relevance to Tau:** This pattern — cooperative IO yielding integrated with an execution loop — is directly applicable to kernel workers that need non-blocking filesystem access. Tau's current `await proxy.readFile()` is functionally equivalent but less granular (entire RPC round-trip vs per-page IO).

**Source:** `repos/turso/bindings/javascript/src/browser.rs` (lines 52–81), `repos/turso/bindings/javascript/packages/common/promise.ts`

### Finding 5: Virtual File System (VFS) Layer

Turso defines a portable `IO` + `File` trait system, not SQLite's C VFS:

```
IO trait: open_file, create_directory, remove_dir, run_in_thread
File trait: lock_file, unlock_file, pread, pwrite, sync, size, truncate
```

Four implementations:

| Backend    | Usage                  | Key Detail                                     |
| ---------- | ---------------------- | ---------------------------------------------- |
| `UnixIO`   | Native Linux/macOS     | POSIX `pread`/`pwrite`, `fcntl` advisory locks |
| `MemoryIO` | Tests + WASM ephemeral | `BTreeMap<page_no, Vec<u8>>` pages             |
| `Opfs`     | Browser persistent     | WASM imports → JS → OPFS worker                |
| `VfsMod`   | C extension callbacks  | For SQLite extension compatibility             |

**WASM-specific behavior:** On wasm targets, the engine forces **`MemoryIO`** for all intermediate/ephemeral calculations (temp tables, sorting spill, subquery materialization). This avoids the constraint that OPFS files must be pre-registered:

```rust
// core/vdbe/execute.rs
#[cfg(target_family = "wasm")]
{
    use crate::MemoryIO;
    db_file_io = Arc::new(MemoryIO::new());
    let file = db_file_io.open_file("temp-file", OpenFlags::Create, false)?;
    db_file = Arc::new(DatabaseFile::new(file));
}
```

**Relevance to Tau:** The VFS abstraction pattern maps directly to Tau's `FileSystemProvider` contract. The key difference is Turso's providers are **page-oriented** (fixed-size blocks with offsets) while Tau's are **file-oriented** (whole-file read/write). AgentFS bridges this gap with chunked blobs (Finding 7).

**Source:** `repos/turso/core/io/mod.rs`, `repos/turso/core/io/unix.rs` (lines 134–160), `repos/turso/core/vdbe/execute.rs` (lines 11006–11016)

### Finding 6: WASM-Optimized Page Cache Strategy

Turso's page cache uses a SIEVE eviction algorithm with platform-specific tuning:

| Platform | Default Cache Size                | Spill Enabled |
| -------- | --------------------------------- | ------------- |
| Native   | 2,000 pages (~8 MB at 4 KB pages) | Yes           |
| WASM     | **100,000 pages** (~400 MB)       | **No**        |

```rust
// core/storage/page_cache.rs
#[cfg(not(target_family = "wasm"))]
const DEFAULT_PAGE_CACHE_SIZE_IN_PAGES: usize = 2000;
#[cfg(target_family = "wasm")]
const DEFAULT_PAGE_CACHE_SIZE_IN_PAGES: usize = 100000;

#[cfg(target_family = "wasm")]
pub fn new(capacity: usize) -> Self {
    Self::new_with_spill(capacity, false)
}
```

**Rationale:** OPFS synchronous access is ~10x slower than native `pread`/`pwrite`. Trading RAM for fewer storage round-trips is the correct optimization in the browser where memory is abundant relative to IO bandwidth. Disabling spill ensures the cache never evicts to OPFS mid-query.

**WAL locking on WASM:** `RwLock` guards use `try_write` + `spin_loop` instead of blocking on the main thread (browsers cannot park the main thread):

```rust
// core/storage/wal.rs
#[cfg(target_family = "wasm")]
{
    loop {
        let Some(lock) = self.shared.try_write() else {
            std::hint::spin_loop();
            continue;
        };
        return lock;
    }
}
```

**Relevance to Tau:** Tau's `BoundedFileCache` (200 entries) is conservative compared to Turso's approach. For the file content cache, Tau should consider larger cache sizes on desktop-class browsers with abundant RAM. The spin-lock pattern is relevant if Tau ever shares state between main thread and workers via `SharedArrayBuffer`.

**Source:** `repos/turso/core/storage/page_cache.rs` (lines 13–157), `repos/turso/core/storage/wal.rs` (lines 2267–2303)

### Finding 7: AgentFS POSIX Filesystem over SQLite

AgentFS stores an entire POSIX filesystem in a single SQLite database using four core tables:

**Schema (from `SPEC.md` v0.4):**

```sql
-- Configuration (immutable after init)
CREATE TABLE fs_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Inode metadata (POSIX stat fields)
CREATE TABLE fs_inode (
  ino INTEGER PRIMARY KEY AUTOINCREMENT,
  mode INTEGER NOT NULL,       -- file type + permissions
  nlink INTEGER NOT NULL DEFAULT 0,
  uid INTEGER NOT NULL DEFAULT 0,
  gid INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  atime INTEGER NOT NULL,      -- access time
  mtime INTEGER NOT NULL,      -- modification time
  ctime INTEGER NOT NULL,      -- change time
  rdev INTEGER NOT NULL DEFAULT 0,
  atime_nsec INTEGER NOT NULL DEFAULT 0,
  mtime_nsec INTEGER NOT NULL DEFAULT 0,
  ctime_nsec INTEGER NOT NULL DEFAULT 0
);

-- Directory entries (namespace)
CREATE TABLE fs_dentry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_ino INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  UNIQUE(parent_ino, name)
);
CREATE INDEX idx_fs_dentry_parent ON fs_dentry(parent_ino, name);

-- File content (chunked blobs)
CREATE TABLE fs_data (
  ino INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (ino, chunk_index)
);

-- Symbolic links
CREATE TABLE fs_symlink (
  ino INTEGER PRIMARY KEY,
  target TEXT NOT NULL
);
```

**Key design decisions:**

1. **Separation of namespace from data:** `fs_dentry` handles path resolution; `fs_inode` stores metadata; `fs_data` stores content. This mirrors Unix kernel VFS separation and enables efficient operations on each concern independently.

2. **Fixed-size chunking:** `fs_config.chunk_size` (default 4096) splits files into fixed-size chunks. Reads/writes only touch affected chunks — `pread(offset, len)` translates to a `SELECT` on `chunk_index` range. Last chunk may be shorter.

3. **Composite index for path resolution:** `UNIQUE(parent_ino, name)` on `fs_dentry` enables O(log n) path component lookups. Path resolution walks from root (ino=1), one component at a time.

4. **`readdirPlus` optimization:** A single `JOIN` query returns directory entries with full inode metadata, avoiding N+1 stat calls:

   ```sql
   SELECT d.name, i.* FROM fs_dentry d
   JOIN fs_inode i ON d.ino = i.ino
   WHERE d.parent_ino = ?
   ```

5. **Dentry cache (Rust SDK):** LRU cache of 10,000 `(parent_ino, name) → child_ino` entries for hot path resolution, with prefix invalidation on rename/delete.

**POSIX API surface (TypeScript SDK):**

| Method                                     | Description                                                 |
| ------------------------------------------ | ----------------------------------------------------------- |
| `stat(path)` / `lstat(path)`               | POSIX stat with full field set                              |
| `readFile(path, encoding?)`                | Full file read (reassembles chunks)                         |
| `writeFile(path, data)`                    | Full file write (chunks data)                               |
| `readdir(path)` / `readdirPlus(path)`      | Directory listing (with/without metadata)                   |
| `mkdir(path)` / `rmdir(path)`              | Directory operations                                        |
| `unlink(path)` / `rm(path, {recursive?})`  | File/tree deletion                                          |
| `rename(src, dst)`                         | Atomic rename                                               |
| `copyFile(src, dst)`                       | File copy                                                   |
| `symlink(target, path)` / `readlink(path)` | Symbolic links                                              |
| `access(path, mode)`                       | Permission check                                            |
| `statfs(path)`                             | Filesystem statistics                                       |
| `open(path, flags)` → `FileHandle`         | POSIX open with `pread`/`pwrite`/`truncate`/`fsync`/`fstat` |

**KV store (orthogonal):** `kv_store` table for session/agent metadata — JSON text values with `set`/`get`/`list(prefix)`/`delete`. Timestamps for `created_at`/`updated_at`.

**Tool call observability:** `tool_calls` table for audit trail — `start`/`success`/`error`/`record` lifecycle with duration tracking.

**Source:** `repos/agentfs/SPEC.md`, `repos/agentfs/sdk/typescript/src/filesystem/` (interface.ts, agentfs.ts)

### Finding 8: Copy-on-Write Overlay Filesystem

AgentFS implements a CoW overlay for agent isolation:

| Component          | Role                                                       |
| ------------------ | ---------------------------------------------------------- |
| **Base layer**     | Read-only reference filesystem (`Arc<dyn FileSystem>`)     |
| **Delta layer**    | Writable AgentFS instance (SQLite-backed)                  |
| **Whiteout table** | Records deleted paths from base                            |
| **Origin table**   | Maps delta inodes to base inodes for stable inode identity |

**Resolution order:** Delta first → if not found → check whiteouts → if not whiteout → read from base.

**Whiteout schema:**

```sql
CREATE TABLE fs_whiteout (
  path TEXT PRIMARY KEY,
  parent_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_fs_whiteout_parent ON fs_whiteout(parent_path);
```

**Origin mapping:** `fs_origin` maps `delta_ino → base_ino` so that a file copied up (first write) retains the same inode number from the consumer's perspective. This is critical for FUSE/NFS where inode stability affects caching.

**Snapshot/rollback:** Not a first-class database primitive. Snapshots are achieved by **copying the SQLite `.db` file**. WAL-based point-in-time recovery provides finer granularity. The entire agent session lives in a single portable file.

**FUSE/NFS mounts:** AgentFS exposes the SQLite-backed FS as real mount points:

- **Linux:** FUSE mount with `HostFS` passthrough for base layer
- **macOS:** NFSv3 server (`nfsserve/`) with `vfs` trait implementation

**Relevance to Tau:** CoW overlay maps directly to Tau's agentic CAD vision — AI agents experimenting with geometry could operate in isolated overlays, with human review before merging changes back. The `fs-capabilities Rec 6` (CopyOnWrite for overlays) already tracks this; AgentFS provides a concrete reference implementation.

**Source:** `repos/agentfs/sdk/rust/src/filesystem/overlayfs.rs`, `repos/agentfs/cli/src/fuser/`, `repos/agentfs/cli/src/nfsserve/`

### Finding 9: Bundler Integration Patterns

Turso ships three export variants to handle bundler-specific WASM and Worker loading issues:

| Export                                   | Use Case          | Technique                                                                  |
| ---------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `@tursodatabase/database-wasm`           | Production        | Fetch WASM binary + separate `worker.js` asset                             |
| `@tursodatabase/database-wasm/vite`      | Vite dev          | Inline WASM as base64 data URL; `Worker(import.meta.url)` self-Worker hack |
| `@tursodatabase/database-wasm/turbopack` | Turbopack         | Inline WASM; `Worker(new URL('./worker.js', import.meta.url))`             |
| `@tursodatabase/database-wasm/bundle`    | Library consumers | `import Worker from "./worker.js?worker&inline"` for Rollup/Vite builds    |

**Vite dev hack (`index-vite-dev-hack.ts`):**

1. WASM binary is base64-encoded and inlined (avoids Vite dev server WASM loading issues)
2. Worker uses `new Worker(import.meta.url, { type: 'module' })` — the same file serves as both main entry and worker entry
3. Worker-side code path detected via message handler branch

**Relevance to Tau:** Tau already faces similar bundler challenges with WASM kernels (`@taucad/vite` plugins). Turso's approach of conditional exports per bundler validates Tau's existing strategy. The `Worker(import.meta.url)` self-Worker pattern could simplify Tau's kernel worker loading.

**Source:** `repos/turso/bindings/javascript/packages/wasm/package.json`, `repos/turso/bindings/javascript/packages/wasm-common/index-vite-dev-hack.ts`

### Finding 10: Cross-Origin Isolation Requirements

`SharedArrayBuffer` (and therefore shared `WebAssembly.Memory`) requires cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Impact:** All cross-origin resources (CDN scripts, fonts, images) must opt in via `Cross-Origin-Resource-Policy: cross-origin` or be loaded via `<link crossorigin>`. This is a deployment-wide requirement, not a library-local one.

**Turso's fallback:** None observed in the codebase. Without isolation, shared `WebAssembly.Memory` fails entirely. The `:memory:` mode avoids OPFS but still expects the same WASM threading story.

**Relevance to Tau:** Tau already deploys with COOP/COEP headers for `SharedArrayBuffer` support (required for WASM kernels). This means Turso-style shared memory patterns are feasible without additional deployment changes. However, adopting shared memory for the FS worker would require careful coordination with Tau's existing `extractTransferables` pattern — you cannot transfer an `ArrayBuffer` that is part of a shared `WebAssembly.Memory`.

**Source:** `repos/turso/examples/javascript/database-wasm-vite/README.md`, `repos/turso/examples/javascript/database-wasm-vite/vite.config.ts`

## Recommendations

| #   | Action                                                                                                                                                                       | Priority | Effort | Impact | Source Finding              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ | --------------------------- |
| T1  | Evaluate shared `WebAssembly.Memory` for FS worker bridge to eliminate structured clone overhead for bulk file content                                                       | P2       | High   | High   | F2 (SharedArrayBuffer IO)   |
| T2  | Adopt dedicated OPFS worker with sync access handles for hot-path file operations, separate from the IDB-based file manager worker                                           | P2       | High   | High   | F3 (OPFS worker)            |
| T3  | Implement chunked file storage (4 KB blocks with `pread`/`pwrite` semantics) for large binary CAD files, enabling partial reads without loading entire files                 | P2       | High   | Medium | F7 (AgentFS chunked blobs)  |
| T4  | Increase `BoundedFileCache` size on desktop browsers (Turso uses 100,000 pages / ~400 MB for WASM; Tau's 200-entry cache is conservative for modern hardware)                | P1       | Low    | Medium | F6 (page cache strategy)    |
| T5  | Add `readdirPlus`-style joined queries to `DirectIdbProvider` — return directory entries with metadata in a single IDB transaction instead of N+1 stat calls                 | P1       | Low    | Medium | F7 (`readdirPlus`)          |
| T6  | Implement path resolution caching (LRU dentry cache) in `FileTreeService` for frequently accessed paths, mirroring AgentFS Rust SDK's 10,000-entry cache                     | P2       | Low    | Medium | F7 (dentry cache)           |
| T7  | Pre-register files in OPFS worker before hot-path access (Turso's register/unregister pattern prevents "create on first open" races)                                         | P2       | Medium | Low    | F3 (pre-registration)       |
| T8  | Use RAM-first policy for temporary/ephemeral data on WASM builds (geometry cache intermediate results, sorting buffers) — avoid touching persistent storage for scratch work | P1       | Low    | Medium | F5, F6 (MemoryIO, no-spill) |
| T9  | Design CoW overlay architecture for agentic CAD experimentation — agent operates on delta layer, human reviews before merge to base                                          | P3       | High   | High   | F8 (CoW overlay)            |
| T10 | Add SQL-debuggable filesystem layer (inode+dentry schema) as a future alternative to flat IDB key-value storage, enabling rich queries over filesystem state                 | P3       | High   | Medium | F7 (schema design)          |

## Tau Alignment Analysis

### Current Architecture vs Turso Patterns

| Concern                        | Tau Current                                                       | Turso/AgentFS                                                          | Gap                                                                             | Severity      |
| ------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------- |
| Thread-to-worker data transfer | Structured clone (with `extractTransferables` for `ArrayBuffer`s) | Shared `WebAssembly.Memory` — zero-copy pointer passing                | **Major** — Tau copies file content across worker boundary; Turso shares memory | P2            |
| Storage backend                | IndexedDB (primary), OPFS, File System Access, Memory             | OPFS with `FileSystemSyncAccessHandle` (primary), Memory for ephemeral | **Different tradeoff** — Tau supports more backends; Turso optimizes for one    | Informational |
| File content storage           | Flat key-value (path → full content)                              | Chunked blobs (inode → chunk_index → 4KB block)                        | **Medium** — Tau loads entire files; AgentFS enables partial reads              | P2            |
| Directory listing              | `getAllKeys()` prefix scan → filter                               | `fs_dentry` table with `UNIQUE(parent_ino, name)` index                | **Different approach** — both work; SQL enables richer queries                  | P3            |
| Cache sizing                   | 200-entry `BoundedFileCache`                                      | 100,000-page (~400 MB) cache with no spill                             | **Conservative** — Tau could safely increase cache sizes                        | P1            |
| Ephemeral data                 | Stored alongside persistent data                                  | Forced `MemoryIO` for temp/intermediate work                           | **Gap** — Tau doesn't distinguish ephemeral from persistent scratch work        | P1            |
| Write coordination             | `ResourceQueue` per-file serialization                            | No explicit coordination (single-writer SQLite model)                  | **Tau ahead** — ResourceQueue is more flexible than single-writer               | —             |
| CoW/branching                  | Not implemented (DEFERRED)                                        | Full overlay with whiteouts and origin mapping                         | **Expected** — validates deferral; provides reference when needed               | P3            |
| Cross-tab coordination         | Not implemented (DEFERRED)                                        | OPFS `createSyncAccessHandle` implicitly locks to one tab              | **Different constraint** — Turso's lock is more restrictive than Tau's goal     | P3            |
| Event coalescing               | Single 50ms window                                                | N/A (database transaction model, not event-driven)                     | **N/A** — different architectures                                               | —             |

### Vision Alignment

Turso's ecosystem aligns with several Tau vision principles:

1. **"Files are the interface"** — AgentFS makes this literal: every agent operation (file, KV, tool calls) flows through a filesystem abstraction backed by a single SQLite file. Tau's filesystem should be equally comprehensive.

2. **"Everything is pluggable"** — Turso's `IO`/`File` trait system and AgentFS's `FileSystem` interface mirror Tau's `FileSystemProvider` contract. The pattern validates Tau's provider abstraction.

3. **"Browser-native"** — Turso demonstrates that production-grade database+filesystem can run entirely in the browser with OPFS persistence, zero server dependency. This validates Tau's browser-first architecture.

4. **"AI agents are collaborators"** — AgentFS's copy-on-write overlay is purpose-built for agent isolation. As Tau's AI capabilities grow (multi-agent orchestration, Phase 3 vision), CoW overlays become essential for safe agent experimentation.

### Patterns Tau Should Adopt (Prioritized)

**Immediate (P1):**

- Increase file content cache sizes — modern browsers have 2-8 GB available RAM; 200 entries is overly conservative
- `readdirPlus` joined queries — eliminate N+1 stat calls in `DirectIdbProvider`
- RAM-first ephemeral policy — geometry cache intermediate results, esbuild temp files should stay in-memory

**Medium-term (P2):**

- Chunked file storage for binary assets — enables streaming reads for large STEP/STL files
- Shared WASM memory evaluation — potential elimination of structured clone overhead for file content transfer
- OPFS worker with sync access handles — dedicated fast path for hot file operations

**Long-term (P3):**

- CoW overlay for agentic experimentation — agent branches, snapshot/rollback, audit trail
- SQL-debuggable filesystem schema — rich queries over filesystem state, inode-based metadata

### Patterns Tau Should NOT Adopt

1. **Single-tab OPFS lock:** Turso's `createSyncAccessHandle()` locks files to one tab. Tau needs multi-tab access (different projects in different tabs). Tau should continue using IDB (which supports multi-tab) as primary and evaluate `navigator.locks` for coordination.

2. **SQLite as filesystem backend (today):** While elegant, replacing IDB with SQLite-in-WASM for Tau's filesystem would be a massive architectural change with unclear ROI. The existing IDB + OPFS provider architecture is sound. SQLite could be evaluated as a future alternative if query requirements grow.

3. **Turso's spin-lock pattern for WAL:** Tau's workers don't share mutable state via shared memory. The spin-lock is only needed if Tau adopts shared `WebAssembly.Memory` — and even then, lock-free designs should be preferred.

## Code Examples

### Turso SharedArrayBuffer + OPFS Worker Communication

```typescript
// Main thread: pass pointer into shared WASM memory to worker
function readFileAtWorker(handle, ptr, len, offset, id) {
  worker.postMessage({
    __turso__: true,
    type: 'read_async',
    handle,
    ptr,
    len,
    offset,
    id,
  });
}

// Worker: read OPFS directly into shared memory
onmessage = (e) => {
  if (e.data.type === 'read_async') {
    const buffer = getUint8ArrayFromMemory(memory, e.data.ptr, e.data.len);
    const result = opfsDir.read(e.data.handle, buffer, e.data.offset);
    postMessage({ __turso__: true, id: e.data.id, result });
  }
};
```

### AgentFS Path Resolution (Rust SDK)

```rust
// Walk from root, checking dentry cache at each step
fn resolve_path(&self, path: &str) -> Result<u64> {
    let mut current_ino = ROOT_INO; // 1
    for component in normalize(path).split('/').filter(|c| !c.is_empty()) {
        if let Some(ino) = self.dentry_cache.get(&(current_ino, component)) {
            current_ino = ino;
        } else {
            let ino = self.db.query_row(
                "SELECT ino FROM fs_dentry WHERE parent_ino = ? AND name = ?",
                [current_ino, component], |row| row.get(0)
            )?;
            self.dentry_cache.put((current_ino, component.to_owned()), ino);
            current_ino = ino;
        }
    }
    Ok(current_ino)
}
```

### AgentFS Chunked Read (TypeScript SDK)

```typescript
async pread(buffer: Buffer, offset: number, length: number, position: number) {
  const chunkSize = this.chunkSize;
  const startChunk = Math.floor(position / chunkSize);
  const endChunk = Math.floor((position + length - 1) / chunkSize);

  const rows = await this.db.execute(
    `SELECT chunk_index, data FROM fs_data
     WHERE ino = ? AND chunk_index >= ? AND chunk_index <= ?
     ORDER BY chunk_index`,
    [this.ino, startChunk, endChunk]
  );
  // Reassemble requested byte range from chunks
}
```

## References

- Source: `repos/turso/` (tursodatabase/turso — Rust SQLite rewrite)
- Source: `repos/agentfs/` (tursodatabase/agentfs — POSIX FS over SQLite)
- External: [Introducing Turso in the Browser](https://turso.tech/blog/introducing-turso-in-the-browser)
- External: [Turso v0.5.0 changelog](https://turso.tech/blog/turso-0.5.0)
- External: [AgentFS in the Browser](https://turso.tech/blog/agentfs_browser)
- External: [AgentFS website](https://www.agentfs.ai/)
- External: [AgentFS spec (SPEC.md)](https://github.com/tursodatabase/agentfs/blob/main/SPEC.md)
- Related: `docs/research/filesystem-gap-analysis.md`
- Related: `docs/research/filesystem-architecture.md`
- Related: `docs/research/vscode-fs-performance.md`
- Related: `docs/research/fs-capabilities.md`
- Related: `docs/policy/filesystem-policy.md`
- Related: `docs/policy/vision-policy.md`

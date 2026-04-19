---
title: 'SharedWorker Filesystem Architecture Assessment'
description: 'Deep analysis of SharedWorker suitability for cross-tab FS coordination in Tau, comparing against navigator.locks + BroadcastChannel and evaluating architectural trade-offs.'
status: active
created: '2026-03-28'
updated: '2026-04-06'
category: architecture
related:
  - docs/research/filesystem-architecture.md
  - docs/research/filesystem-gap-analysis.md
  - docs/research/filesystem-runtime-strategy.md
  - docs/research/turso-fs.md
  - docs/research/shared-worker-gate-startup-performance.md
  - docs/research/vscode-fs-performance.md
  - docs/policy/filesystem-policy.md
  - docs/policy/vision-policy.md
---

# SharedWorker Filesystem Architecture Assessment

Assessment of whether a SharedWorker is the right primitive for cross-tab filesystem access in Tau, evaluating architectural fit against the current dedicated-worker + `navigator.locks` + `BroadcastChannel` + `SharedArrayBuffer` design.

## Executive Summary

**SharedWorker is not a suitable replacement for Tau's file-manager dedicated worker.** Three blocking constraints eliminate it from consideration: (1) `SharedArrayBuffer` is inaccessible from SharedWorkers — even with COOP/COEP headers — breaking Tau's `SharedContentPool` (now `SharedPool` in `@taucad/memory`) zero-IPC reads; (2) `FileSystemSyncAccessHandle` (OPFS synchronous I/O) is restricted to dedicated Workers, blocking the R21 OPFS fast path; (3) Android Chrome does not support SharedWorker, creating a critical mobile gap. Tau's current architecture — per-tab dedicated worker with `navigator.locks` for write serialization and `BroadcastChannel` for change notifications — is the architecturally correct approach, validated by VS Code's identical choice. `navigator.locks` is not redundant; it solves a problem (cross-tab mutual exclusion and tab-death detection) that SharedWorker alone cannot. The most performant architecture is the one Tau already has, with the `SharedContentPool` / `SharedPool` providing zero-IPC reads that SharedWorker fundamentally cannot achieve. All four "recommendation against action" items (R-SW1–R-SW4) have been ✅ FOLLOWED. R-SW5 (strengthen cross-tab coordination) remains ❌ NOT DONE.

## Problem Statement

Tau's filesystem architecture uses a dedicated Web Worker (`file-manager.worker.ts`) per browser tab. Each tab creates its own `FileService` instance backed by IndexedDB. Cross-tab coordination is handled by `CrossTabCoordinator` using `navigator.locks` (per-file write serialization) and `BroadcastChannel` (mutation notifications). The R20 `SharedContentPool` uses `SharedArrayBuffer` for zero-IPC cached reads across threads.

Three questions drive this investigation:

1. Is `SharedWorker` a better fit than dedicated workers for cross-tab FS access?
2. Should `file-manager.worker.ts` become a SharedWorker?
3. Does `navigator.locks` become redundant if we use a SharedWorker?

## Methodology

1. Read all Tau filesystem research documents (`filesystem-architecture.md`, `filesystem-gap-analysis.md`, `filesystem-runtime-strategy.md`, `turso-fs.md`, `shared-worker-gate-startup-performance.md`, `vscode-fs-performance.md`) and the filesystem policy
2. Explored VS Code's cross-tab coordination patterns via `repos/vscode` — searching for `SharedWorker`, `BroadcastChannel`, `navigator.locks`, and `SharedArrayBuffer` usage
3. Analyzed Notion's SharedWorker + OPFS SQLite architecture (the most prominent production SharedWorker case study)
4. Explored Turso's dedicated OPFS worker pattern via `repos/turso`
5. Researched SharedWorker browser support, `SharedArrayBuffer` compatibility, and `FileSystemSyncAccessHandle` availability constraints in 2026
6. Cross-referenced against `docs/policy/vision-policy.md` requirements

## Findings

### Finding 1: SharedArrayBuffer Is Inaccessible from SharedWorkers

**Severity**: Blocking — eliminates SharedWorker as a candidate for Tau's FS worker

Even with correct cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` or `credentialless`), SharedWorkers report `crossOriginIsolated === false` and `typeof SharedArrayBuffer === 'undefined'`. This is a known issue in both Chrome and Firefox:

- The HTML spec assigns SharedWorkers "logical" (not "concrete") cross-origin isolation, which does not grant `SharedArrayBuffer` access
- Firefox bug #1984864 (filed mid-2025, status: ASSIGNED) tracks this
- Confirmed in Chrome 138+ on Linux
- Not selected for Interop 2025 or 2026 — no timeline for resolution

**Impact on Tau**: The R20 `SharedContentPool` — Tau's zero-IPC cached read mechanism — relies on `SharedArrayBuffer` for a bump allocator (`SharedMemoryArena`) shared between the file-manager worker and kernel workers. If the file-manager worker were a SharedWorker, the `SharedContentPool` would be completely non-functional. This would regress Tau's filesystem performance to pre-R20 levels, eliminating the zero-IPC read path that is the cornerstone of the shared memory architecture.

**Source**: Browser standards analysis, Firefox bugzilla #1984864, Chrome behavior testing

### Finding 2: FileSystemSyncAccessHandle Restricted to Dedicated Workers

**Severity**: Blocking — eliminates SharedWorker for OPFS fast-path (R21)

`FileSystemSyncAccessHandle` — the synchronous OPFS I/O API that provides 3-4x faster file access than IndexedDB — is only available in dedicated Web Workers. SharedWorkers and the main thread cannot create sync access handles. This is by design: the spec requires worker thread exclusivity to prevent contention.

This means a SharedWorker-based file-manager could never use OPFS synchronous access handles, blocking the R21 recommendation (dedicated OPFS worker with sync access handles for hot-path file operations). Turso and Notion both work around this constraint with a three-tier architecture:

| Tier             | Technology   | Role                         |
| ---------------- | ------------ | ---------------------------- |
| Main thread      | React/UI     | Query initiation             |
| SharedWorker     | Routing only | Cross-tab coordination       |
| Dedicated Worker | OPFS/SQLite  | Actual I/O with sync handles |

Both architectures use the SharedWorker as a **routing layer**, not as the I/O worker. The actual filesystem operations happen in a dedicated Worker.

**Source**: WHATWG spec, `repos/turso/bindings/javascript/packages/wasm-common/index.ts`, Notion engineering blog

### Finding 3: Android Chrome Does Not Support SharedWorker

**Severity**: High — mobile browser gap

| Browser | Desktop            | Mobile                      |
| ------- | ------------------ | --------------------------- |
| Chrome  | Supported (v4+)    | **Not supported** (Android) |
| Edge    | Supported (v79+)   | Not supported (Android)     |
| Firefox | Supported (v29+)   | Supported (v148+, Android)  |
| Safari  | Supported (v16.0+) | Supported (iOS 16.0+)       |

Android Chrome is the last major holdout. The Chromium team has stated it's "a matter of when, not if" but has committed no timeline. SharedWorker is **not Baseline** per MDN due to this gap.

**Impact on Tau**: Tau targets web browsers broadly. Android Chrome exclusion would require a dedicated fallback path (dedicated worker + `navigator.locks`), resulting in two FS coordination architectures to maintain — the SharedWorker path and the fallback. This complexity would contradict the architecture's single-worker design simplicity.

**Source**: MDN browser compatibility data, Can I Use

### Finding 4: VS Code Does Not Use SharedWorker

VS Code's web version — the most mature browser-based editor — uses no SharedWorker for filesystem or cross-tab coordination. Searching `repos/vscode` reveals:

- **No `new SharedWorker(...)` in product code** — the only `sharedworker` reference is in the Service Worker's `clients.matchAll({ type: 'sharedworker' })` for message routing (handling browser client types, not owning a SharedWorker)
- **No `navigator.locks`** — zero matches in the VS Code codebase
- **`BroadcastChannel` is the sole cross-tab primitive** — via `BroadcastDataChannel` (`src/vs/base/browser/broadcast.ts`) with `localStorage` fallback

VS Code's cross-tab FS strategy:

1. **Each tab creates its own `IndexedDBFileSystemProvider`** — no shared worker
2. **IndexedDB is the shared state** — all tabs read/write the same IDB database
3. **`BroadcastDataChannel` notifies other tabs of changes** — channel name `vscode.indexedDB.${scheme}.changes`
4. **No write coordination beyond IDB transactions** — IDB provides per-transaction atomicity

This is exactly Tau's pre-R12 architecture, with `BroadcastChannel` added for notifications. VS Code's choice validates the dedicated-worker approach: no SharedWorker complexity, no `navigator.locks` overhead, relying on IndexedDB's built-in transaction isolation.

**Source**: `repos/vscode/src/vs/base/browser/broadcast.ts`, `repos/vscode/src/vs/platform/files/browser/indexedDBFileSystemProvider.ts`

### Finding 5: Notion's Three-Tier Architecture — SharedWorker as Router Only

Notion's SharedWorker + OPFS SQLite architecture (shipped mid-2024) is the most prominent production SharedWorker case study. Key findings:

**Architecture**: SharedWorker serves solely as a **routing layer** — it holds no state and performs no I/O. All SQLite queries from all tabs flow through the SharedWorker to a single "active" dedicated Worker that owns the OPFS sync access handle. The SharedWorker's only job is knowing which tab's Worker is active and forwarding `MessagePort` connections.

**Why not SharedWorker for I/O**: Because `FileSystemSyncAccessHandle` is unavailable in SharedWorkers. Notion tried four simpler architectures first — all failed due to OPFS corruption, COOP/COEP constraints, or single-tab limitations. The three-tier architecture was the last resort.

**Web Locks role**: Notion uses `navigator.locks` for **tab-death detection**, not write coordination. Each tab acquires a Web Lock that never resolves — when the tab crashes or closes, the browser releases the lock, and the SharedWorker detects this to migrate the active Writer role. This is the canonical "infinitely-open lock" pattern.

**Performance**: 20% faster page navigation (28-33% in high-latency regions).

**Critical insight for Tau**: Notion's architecture solves a fundamentally different problem — single-writer SQLite coordination. Tau's IndexedDB-based filesystem allows concurrent readers and writers (with per-transaction atomicity) and doesn't need a single active writer. The SharedWorker routing layer adds no value when the underlying storage already supports multi-tab access.

**Source**: Notion engineering blog "How we sped up Notion in the browser with WASM SQLite", Roy Hashimoto's wa-sqlite discussion #81

### Finding 6: navigator.locks Solves Problems SharedWorker Cannot

`navigator.locks` and SharedWorker solve orthogonal problems:

| Capability                   | SharedWorker                                         | `navigator.locks`                          |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Mutual exclusion across tabs | Must implement manually via message passing          | Built-in (`mode: 'exclusive'`)             |
| Lock queuing (FIFO)          | Must implement manually                              | Built-in queue management                  |
| Tab-death detection          | No reliable mechanism (`port.onclose` doesn't exist) | Automatic lock release on tab close/crash  |
| Leader election              | Must implement manually                              | Built-in via `mode: 'exclusive'` + `steal` |
| Shared state                 | Yes (in-memory within worker)                        | No — locks only, no state                  |
| Auto-release on tab crash    | No (ports go silent, no notification)                | Yes (browser guarantees release)           |
| Browser support              | No Android Chrome                                    | Baseline since March 2022 (all browsers)   |

**`navigator.locks` is not redundant** — it provides guarantees that SharedWorker cannot:

1. **Crash-safe lock release**: When a tab crashes (not just closes), `navigator.locks` automatically releases all held locks. SharedWorker has no way to detect crashed tabs — ports go silent with no error or close event.
2. **Built-in FIFO queuing**: Multiple tabs requesting the same exclusive lock queue automatically. SharedWorker requires implementing a queue manually.
3. **Zero state corruption risk**: Locks are managed by the browser, not by application code. A bug in SharedWorker routing logic can cause deadlocks or missed messages.

Tau's `CrossTabCoordinator` uses `navigator.locks` for per-file exclusive write locks — this is the **correct** primitive for filesystem write coordination. Using a SharedWorker for this would be strictly worse: more complex, less reliable, and missing crash-safe guarantees.

**Source**: Web Locks API spec, Notion's architecture analysis, browser compatibility data

### Finding 7: SharedWorker Lifecycle Creates Fragility

SharedWorker lifecycle introduces several failure modes that dedicated workers avoid:

| Issue                                        | Impact                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Single-tab reload kills worker**           | If only one tab is open, reloading kills the SharedWorker (owner set becomes empty during navigation) |
| **No `beforeunload` equivalent**             | SharedWorker cannot detect impending termination — no cleanup opportunity                             |
| **Tab discarding**                           | Chrome silently discards background tabs, killing the SharedWorker without notification               |
| **`onerror` broken in Chrome 119+**          | Chrome does not fire `onerror` on SharedWorker instances                                              |
| **Console output invisible**                 | Logs/errors don't appear in standard DevTools; requires `chrome://inspect/#workers`                   |
| **Port cleanup is manual**                   | `MessagePort` has no `onclose` event — must implement heartbeat/ping-pong                             |
| **`Cache-Control: no-store` causes restart** | Pages with these headers cause SharedWorker restart during navigation                                 |

For Tau's file-manager worker, which holds critical filesystem state (`FileService`, `ProviderRegistry`, `DirectoryTreeCache`, `ChangeEventBus`), SharedWorker lifecycle fragility would introduce intermittent data loss scenarios:

- User with one tab refreshes → SharedWorker dies → in-memory tree cache lost → full IDB re-scan on next load
- Chrome discards background tab → SharedWorker terminates → kernel workers lose filesystem bridge → geometry compilation fails silently

Dedicated workers are more predictable: one worker per tab, lifecycle tied to the tab, no cross-tab lifecycle dependencies.

**Chrome 139+ Extended Lifetime** (origin trial): `extendedLifetime: true` keeps the SharedWorker alive for ~30s after the last tab closes. This mitigates the single-tab-reload problem but is desktop-only and trial-only in 2026.

**Source**: WHATWG HTML spec, Chrome DevRel documentation, browser issue trackers

### Finding 8: Current Architecture Is Already Optimal

Tau's current FS architecture achieves the goals that SharedWorker proponents claim, without SharedWorker's constraints:

| Goal                   | SharedWorker Approach                        | Tau's Current Approach                           | Winner                                                       |
| ---------------------- | -------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| Cross-tab write safety | Route all writes through one worker          | `navigator.locks` per-file exclusive locks       | **Tau** — crash-safe, no routing overhead                    |
| Change notifications   | SharedWorker broadcasts to ports             | `BroadcastChannel` via `CrossTabCoordinator`     | Equivalent                                                   |
| Zero-IPC cached reads  | Impossible (no `SharedArrayBuffer` access)   | R20 `SharedContentPool` over `SharedArrayBuffer` | **Tau** — SharedWorker can't do this                         |
| OPFS fast path         | Impossible (no `FileSystemSyncAccessHandle`) | R21 dedicated OPFS worker (planned)              | **Tau** — SharedWorker can't do this                         |
| Shared file cache      | Single in-memory cache across tabs           | Per-tab `BoundedFileCache` + `SharedContentPool` | **Tau** — SAB-based cache is faster than RPC to SharedWorker |
| Mobile support         | No Android Chrome                            | Works everywhere                                 | **Tau**                                                      |
| State consistency      | Single instance, but lifecycle-fragile       | Per-tab instance, IndexedDB is source of truth   | **Tau** — simpler failure modes                              |

The only potential advantage of a SharedWorker — deduplicating the file-manager worker instance across tabs — is outweighed by the three blocking constraints (no SAB, no OPFS sync, no Android Chrome) and lifecycle fragility.

### Finding 9: Turso's OPFS Worker Validates Dedicated Worker Pattern

Turso's browser runtime (analyzed in `docs/research/turso-fs.md`) uses a **dedicated OPFS worker**, not a SharedWorker, for all I/O. The main thread shares WASM linear memory (`SharedArrayBuffer`) with the dedicated worker, passing `{ ptr, len, offset }` tuples via `postMessage`. The worker reads/writes directly into shared memory using OPFS `FileSystemSyncAccessHandle`.

This pattern — dedicated worker + shared memory — is exactly what Tau's R20 + R21 architecture prescribes. Turso does not use SharedWorker because:

1. OPFS sync handles are unavailable in SharedWorkers
2. Shared WASM memory requires `SharedArrayBuffer`, which SharedWorkers can't access
3. Single-database-per-OPFS-handle means concurrency is managed at the application level anyway

**Source**: `repos/turso/bindings/javascript/packages/wasm-common/index.ts`

## Recommendations

### ~~R-SW1: Do Not Convert file-manager.worker.ts to SharedWorker~~ ✅ FOLLOWED

**Priority**: N/A (recommendation against action)

**Status**: **FOLLOWED** — File-manager worker remains a dedicated Web Worker. No SharedWorker conversion was attempted.

### ~~R-SW2: Keep navigator.locks for Cross-Tab Write Coordination~~ ✅ FOLLOWED

**Priority**: N/A (maintain current architecture)

**Status**: **FOLLOWED** — `CrossTabCoordinator` uses `navigator.locks` for per-file exclusive write serialization. No change to this pattern.

### ~~R-SW3: Keep BroadcastChannel for Change Notifications~~ ✅ FOLLOWED

**Priority**: N/A (maintain current architecture)

**Status**: **FOLLOWED** — `CrossTabCoordinator` uses `BroadcastChannel` for cross-tab change notifications. No change to this pattern.

### ~~R-SW4: Consider SharedWorker as Future Routing Layer Only~~ ✅ FOLLOWED

**Priority**: P3 (future, conditional)

**Status**: **FOLLOWED** — No SharedWorker adopted. None of the three prerequisite conditions are met in April 2026: Android Chrome still lacks SharedWorker support, the underlying storage doesn't require single-writer semantics, and `SharedArrayBuffer` access from SharedWorkers remains unresolved in browser specs.

### R-SW5: Strengthen Current Cross-Tab Architecture — ❌ NOT DONE

**Priority**: P2

The existing `CrossTabCoordinator` can be enhanced without SharedWorker. None of these enhancements have been implemented:

1. ❌ **Tab-death detection via infinitely-open Web Lock** (Notion pattern) — `CrossTabCoordinator.withWriteLock` acquires exclusive locks for the duration of write operations only; no long-held liveness lock exists
2. ❌ **Active-tab content pool invalidation** on tab death — `SharedContentPool` (now in `@taucad/memory`) has no cross-tab invalidation mechanism
3. ❌ **BroadcastChannel reliability** with sequence-numbered `ChangeNotification` messages — `BroadcastChannel` notifications have no sequence numbers or delivery guarantees

## Trade-offs Summary

| Dimension            | SharedWorker FS                            | Current Architecture (Dedicated + navigator.locks + SAB) |
| -------------------- | ------------------------------------------ | -------------------------------------------------------- |
| SharedArrayBuffer    | Not available                              | Available (R20 SharedContentPool)                        |
| OPFS sync handles    | Not available                              | Available (R21 future)                                   |
| Android Chrome       | Not supported                              | Fully supported                                          |
| Cross-tab writes     | Application-level routing                  | `navigator.locks` (crash-safe, built-in)                 |
| Change notifications | SharedWorker message ports                 | `BroadcastChannel` (simpler, equivalent)                 |
| Worker lifecycle     | Fragile (reload, discard, no error events) | Predictable (tied to tab)                                |
| Debugging            | Requires `chrome://inspect/#workers`       | Standard DevTools                                        |
| Memory deduplication | Single instance across tabs                | Per-tab (mitigated by SAB shared pool)                   |
| Complexity           | 3-tier (main + SharedWorker + Worker)      | 2-tier (main + Worker)                                   |
| VS Code precedent    | Not used                                   | Matches VS Code's approach                               |
| Notion precedent     | Used as routing-only layer                 | N/A (different problem domain)                           |
| Performance ceiling  | Limited by postMessage RPC                 | Zero-IPC via SharedArrayBuffer                           |

## Conclusion

Tau's current filesystem architecture — dedicated worker + `navigator.locks` + `BroadcastChannel` + `SharedArrayBuffer` `SharedContentPool` — is the architecturally optimal approach for a browser-based CAD platform. SharedWorker would strictly degrade performance (losing zero-IPC reads), restrict platform reach (no Android Chrome), and add lifecycle complexity. The `navigator.locks` + `BroadcastChannel` combination provides cross-tab coordination that is simpler, more reliable, and more broadly supported than SharedWorker routing. VS Code's identical architectural choice and Turso's dedicated-worker-with-shared-memory pattern independently validate this conclusion.

The most performant cross-tab FS access path is not routing all operations through a shared worker — it is each tab maintaining a fast local worker with `SharedArrayBuffer`-based shared memory, coordinated by browser-native locking primitives.

## References

- VS Code cross-tab patterns: `repos/vscode/src/vs/base/browser/broadcast.ts`, `repos/vscode/src/vs/platform/files/browser/indexedDBFileSystemProvider.ts`
- Turso OPFS worker: `repos/turso/bindings/javascript/packages/wasm-common/index.ts`
- Notion architecture: [How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)
- Roy Hashimoto wa-sqlite discussion: [wa-sqlite #81](https://github.com/rhashimoto/wa-sqlite/discussions/81)
- Firefox SharedWorker SAB bug: [bugzilla #1984864](https://bugzilla.mozilla.org/show_bug.cgi?id=1984864)
- SharedWorker Extended Lifetime: [Chrome 139+ origin trial](https://developer.chrome.com/blog/shared-worker-extended-lifetime)
- Related: `docs/research/filesystem-architecture.md`
- Related: `docs/research/filesystem-gap-analysis.md`
- Related: `docs/research/filesystem-runtime-strategy.md`
- Related: `docs/research/turso-fs.md`
- Related: `docs/research/shared-worker-gate-startup-performance.md`
- Related: `docs/research/vscode-fs-performance.md`
- Related: `docs/policy/filesystem-policy.md`
- Related: `docs/policy/vision-policy.md`

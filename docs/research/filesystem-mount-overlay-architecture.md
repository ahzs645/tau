---
title: 'Filesystem Mount & Overlay Architecture'
description: 'Analysis of mount-point support in the new multi-provider FS architecture: current limitations, concrete use cases, design patterns from VS Code/ZenFS/OverlayFS, and a proposed MountTable abstraction.'
status: active
created: '2026-03-28'
updated: '2026-04-06'
category: architecture
related:
  - docs/research/filesystem-architecture.md
  - docs/research/filesystem-runtime-strategy.md
  - docs/research/filesystem-gap-analysis.md
  - docs/research/node-vfs-applicability.md
  - docs/research/fs-capabilities.md
  - docs/research/vscode-fs-performance.md
  - docs/research/browser-filesystem-landscape.md
  - docs/policy/filesystem-policy.md
  - docs/policy/vision-policy.md
---

# Filesystem Mount & Overlay Architecture

Investigation into whether the new multi-provider filesystem architecture supports mounting different providers at specific path prefixes, what use cases require it, and what changes would enable it.

## Executive Summary

~~The current architecture uses a **single active provider** model.~~ **UPDATE (April 2026)**: The `MountTable` abstraction has been implemented and integrated into `FileService`. It uses longest-prefix matching to route operations to different providers by path. The first production mount is an OPFS-backed `/node_modules/` cache, separate from the project's primary IndexedDB provider. Of 10 recommendations: **6 RESOLVED** (R1, R2, R5, R6, R7, R8), **3 NOT DONE** (R3, R4, R10), and **1 DEFERRED** (R9). Key capabilities delivered:

- **`MountTable` class** (`packages/filesystem/src/mount-table.ts`): Pre-sorted mount list, longest-prefix resolution, `getMountsUnder` for readdir merge ✅
- **`FileService` integration**: All operations route through `_resolveProvider()`, which consults the mount table or falls back to the active provider. Cross-mount rename implemented as copy+delete. Readdir merges synthetic entries from child mounts. ✅
- **OPFS `/node_modules/` mount**: `file-manager.worker.ts` creates a `FileSystemAccessProvider` backed by an OPFS subdirectory handle (`tau-node-modules`) and mounts it at `/node_modules`, with graceful degradation when OPFS is unavailable. ✅
- **`readdirWithStats`**: Eliminates N+1 stat calls across all providers (`DirectIdbProvider` with `_fileSizes` cache, `FileSystemAccessProvider` via `entries()`, `MemoryProvider`). ✅
- **Directory handle LRU cache**: 10K-entry cache in `FileSystemAccessProvider._resolveDirectoryHandle` with prefix invalidation on mutations. ✅

Remaining: ephemeral `.tau/cache/` mount (R3 ❌), git isolation (R4 ❌), overlay provider (R9 ⏸️), mount resolution benchmarking (R10 ❌).

## Problem Statement

A user asked: "Can I mount files at a specific location using a different filesystem — e.g., in-memory files overlaid on an IndexedDB primary?" The answer today is **no**. This investigation examines why, identifies the concrete use cases that would benefit, surveys mount-table patterns from VS Code, ZenFS, OverlayFS, and unionfs, and proposes an architecture that fits Tau's existing provider stack.

## Table of Contents

- [Current Architecture: Why Mounts Are Not Possible](#current-architecture-why-mounts-are-not-possible)
- [Concrete Use Cases](#concrete-use-cases)
- [Design Patterns from Existing Systems](#design-patterns-from-existing-systems)
- [Proposed Architecture: MountTable](#proposed-architecture-mounttable)
- [Design Decisions](#design-decisions)
- [Recommendations](#recommendations)

## ~~Current Architecture: Why Mounts Are Not Possible~~ ✅ RESOLVED

> **Note**: This section documents the **original** single-provider limitations that motivated `MountTable`. These limitations have been fully resolved — `FileService` now routes all operations through `_resolveProvider()` which consults the `MountTable` for longest-prefix matching, falling back to the active provider only for unmounted paths.

### ~~Single Active Provider Model~~ ✅ RESOLVED

~~`ProviderRegistry` manages providers keyed by **backend type** (`indexeddb`, `opfs`, `webaccess`, `memory`), not by path. It exposes one "active" backend:~~

```typescript
// provider-registry.ts
private _activeBackend: FileSystemBackend = 'indexeddb';

public async getActiveProvider(): Promise<FileSystemProvider> {
  return this.getProvider(this._activeBackend);
}
```

~~`FileService` routes every operation through `getActiveProvider()`:~~

```typescript
// file-service.ts — all reads/writes
public async readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const provider = await this._registry.getActiveProvider();
  return provider.readFile(path);
}
```

~~There is **no path inspection** in the routing layer.~~ **RESOLVED** — `FileService` now calls `_resolveProvider(path)` which checks the `MountTable` first, falling back to the active provider only if no mount matches. `MountTable.resolve(path)` uses longest-prefix matching with a pre-sorted mount list.

### What `reconfigure` Does

`FileService.reconfigure(backend)` calls `switchActiveProvider`, which replaces the **entire** active provider. It is a global backend swap, not a mount operation:

```typescript
// file-service.ts
public async reconfigure(backend: FileSystemBackend): Promise<void> {
  await this._registry.switchActiveProvider(backend);
  this._treeCache.clear();
  // ... reset in-memory tree, watches, etc.
}
```

### ZenFS's Mount System (Previously Available, Not Used)

ZenFS supported `configure({ mounts: { '/': Backend1, '/git': Backend2 } })` with longest-prefix path resolution. However, `zenfs-config.ts` only ever configured a single `'/'` mount per backend — the documented `'/git'` mount was never implemented. Git operations use a path prefix (`/git/projects/{projectId}`) on the same provider via `FileManagerProxy`.

### ~~Summary of Limitations~~ — Current Status

| Capability                                                  | Original Status                                  | Current Status                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Multiple providers active simultaneously                    | ~~Cached but only one is "active" for I/O~~      | ✅ RESOLVED — `MountTable` supports multiple providers via longest-prefix routing |
| Path-based provider selection                               | ~~Not implemented; all paths → active provider~~ | ✅ RESOLVED — `_resolveProvider(path)` consults `MountTable`                      |
| Overlay / union reads (check layer A, fall back to layer B) | Not implemented                                  | ❌ NOT DONE (R9 — `OverlayProvider` deferred)                                     |
| Mount a provider at a sub-path (e.g., `/tmp` → memory)      | ~~Not implemented~~                              | ✅ RESOLVED — `/node_modules/` mounted on OPFS via `MountTable`                   |
| Cross-mount rename (copy+delete fallback)                   | ~~Not implemented~~                              | ✅ RESOLVED — R8 implemented                                                      |
| Watch events across mount boundaries                        | ~~Not needed (single provider)~~                 | ✅ RESOLVED — Events use original absolute paths (R7)                             |

## Concrete Use Cases

Source-code analysis reveals six areas where the codebase already treats paths as architecturally distinct but serves them from the same backend.

### Use Case 1: Geometry & Parameter Cache (`.tau/cache/`)

**Evidence**: `geometry-cache.middleware.ts` writes MessagePack blobs to `.tau/cache/geometry/`; `parameter-cache.middleware.ts` writes JSON to `.tau/cache/parameters/`. `kernel-worker.ts` explicitly excludes `.tau/cache/` from dependency watches and file change events. `filesystem-policy.md` Rule 3 defines separate eviction (max-age / max-entries) for cache entries.

**Why mount helps**: Cache writes are high-frequency binary blobs that are fully regenerable. Storing them on an ephemeral, fast provider (in-memory or OPFS with `createSyncAccessHandle`) while keeping source files on durable IndexedDB would:

- Reduce IDB write amplification on the directory-listing metadata path
- Allow aggressive cache clearing without touching project data
- Eliminate contention between cache writes and user file writes in the write coordinator

**Mount config**: `projectRoot/.tau/cache/**` → `MemoryProvider` or dedicated `OPFSProvider`

### Use Case 2: Git Object Store (`/git/`)

**Evidence**: `git.machine.ts` defines `gitMountPrefix = '/git'` and constructs paths like `/git/projects/{projectId}`. `isomorphic-git` operates against a `FileManagerProxy` adapter. `zenfs-config.ts` documents `'/git'` as an isolated mount but never configures it.

**Why mount helps**: Git's access pattern (many small random reads of pack objects, bulk writes on clone/fetch) differs fundamentally from CAD file editing. Isolating git storage prevents git operations from inflating the project tree's `InMemoryFileTree` path index and competing for write coordinator slots.

**Mount config**: `/git` → separate `DirectIdbProvider` (different IDB database name) or `OPFSProvider`

### Use Case 3: CDN / Node Module Cache (`/node_modules/`)

**Evidence**: `module-manager.ts` writes fetched ESM packages to `/node_modules/{pkg}/`. `esbuild-core.ts` documents CDN modules cached at the filesystem root. These are throwaway dependency artifacts that persist in the same IDB as user project files.

**Why mount helps**: CDN packages are large, numerous, and fully re-fetchable. A separate ephemeral provider would prevent them from bloating the project's IDB store and `getAllKeys` preload. Clearing the CDN cache would not touch user files.

**Mount config**: `/node_modules/**` → `MemoryProvider` (session-scoped) or dedicated `DirectIdbProvider`

### Use Case 4: Transcripts (`.tau/transcripts/`)

**Evidence**: `transcript.middleware.ts` writes append-only JSONL to `.tau/transcripts/{chatId}.jsonl`. `filesystem-context-policy.md` mandates append-only semantics. `at-reference.utils.ts` resolves transcript paths for `@` references.

**Why mount helps**: Append-heavy write patterns compete with random-access source file I/O under the global write coordinator. A dedicated provider could use append-optimized storage (e.g., a single IDB key per transcript, updated via read-modify-write) rather than the path-keyed model optimized for random files.

**Mount config**: `projectRoot/.tau/transcripts/` → dedicated provider or same provider with separate write queue

### Use Case 5: Scratch / Temp Files

**Evidence**: OCCT kernels use Emscripten MEMFS `/tmp/export_*.glb` for export scratch. `tool-offloading.middleware.ts` writes large text to `.tau/offloaded-tool-results/`. `.tau/artifacts/*.glb` stores viewer GLB blobs.

**Why mount helps**: Temporary and artifact files are large binary blobs that should not persist across sessions or inflate backup/export payloads. An in-memory mount would auto-clear on page refresh.

**Mount config**: `projectRoot/.tau/artifacts/` → `MemoryProvider`; `projectRoot/.tau/offloaded-tool-results/` → `MemoryProvider`

### Use Case 6: Read-Only Template Overlay (Future)

**Evidence**: `use-context-payload.ts` reads `.tau/skills/*/SKILL.md` and `.tau/AGENTS.md`. New project creation seeds template files from kernel option metadata.

**Why mount helps**: Organization-wide defaults (skill templates, AGENTS.md templates) could be served from a read-only provider, with project-specific overrides written to the primary provider. This is a classic union/overlay pattern: read from upper (project) first, fall back to lower (template).

**Mount config**: `projectRoot/.tau/skills/` → union of `MemoryProvider` (read-only templates) + project provider (user overrides)

## Design Patterns from Existing Systems

### VS Code: URI Scheme Dispatch

VS Code routes operations by **URI scheme** (`file://`, `vscode-remote://`, `memfs://`) via a flat `Map<string, IFileSystemProvider>`. One provider per scheme, no path-based routing within a scheme. Cross-scheme operations (move/copy) detect `sourceProvider !== targetProvider` and fall back to copy+delete.

**Applicability to Tau**: Tau's paths have no URI scheme — all paths live under `/`. Scheme dispatch is not viable; path-prefix dispatch is needed instead.

**Valuable patterns to adopt**: Event fan-in (each provider emits events; service unifies them), cross-provider copy+delete for rename, ref-counted watch deduplication.

### ZenFS: Longest-Prefix Mount Table

ZenFS's `resolveMount()` sorts mounts by path length descending and matches the first (longest) prefix:

```typescript
// Simplified from ZenFS source
function resolveMount(path: string): { fs: FileSystem; path: string } {
  const sorted = [...mounts].sort((a, b) => b[0].length - a[0].length);
  for (const [mountPoint, fs] of sorted) {
    if (isParentOf(mountPoint, path)) {
      const relative = path.slice(mountPoint.length) || '/';
      return { fs, path: relative };
    }
  }
}
```

**Performance concern**: Sorts on every call (O(n log n)). Should pre-sort on mount/unmount.

**Applicability**: Direct model for Tau. Paths are POSIX-style, mounts are path prefixes, resolution is longest-prefix match.

### Linux OverlayFS: Layered Read/Write

OverlayFS stacks read-only lowerdirs under a writable upperdir. Reads check upper first, fall through to lower. Writes always go to upper (copy-on-write on first modification). Deletions create whiteout files. Renames across layers return `EXDEV`.

**Applicability**: Overlay semantics are needed for Use Case 6 (template overlay) but not for the simpler mount-table use cases (1–5), which are isolated mounts where each path prefix maps to exactly one provider.

### unionfs (npm): Global Overlay

`unionfs` maintains an ordered array of filesystems. Reads try each from last-added to first-added. `readdir` merges entries from all layers. Watches fan out to all filesystems.

**Applicability**: Too coarse for Tau — no path-prefix scoping. However, the `readdir` merge pattern is relevant for overlay mounts where a directory spans two providers.

## Proposed Architecture: MountTable

### Core Abstraction

A `MountTable` sits between `FileService` and individual providers, replacing the single-provider routing in `ProviderRegistry.getActiveProvider()`:

```
FileService
    │
    ▼
MountTable ── resolveMount(path) ──▶ { provider, relativePath }
    │
    ├── "/" ──────────────▶ DirectIdbProvider  (primary)
    ├── "/.tau/cache/" ──▶ MemoryProvider      (ephemeral cache)
    ├── "/git/" ─────────▶ DirectIdbProvider   (isolated git DB)
    └── "/node_modules/" ▶ MemoryProvider      (CDN cache)
```

### Path Resolution

Longest-prefix matching with a pre-sorted mount list:

```typescript
type MountEntry = {
  readonly prefix: string;
  readonly provider: FileSystemProvider;
};

class MountTable {
  // Sorted by prefix length descending on mutation, not on every resolve
  private _mounts: MountEntry[] = [];

  public resolve(absolutePath: string): { provider: FileSystemProvider; path: string } {
    for (const mount of this._mounts) {
      if (absolutePath === mount.prefix || absolutePath.startsWith(mount.prefix + '/') || mount.prefix === '/') {
        const relative = mount.prefix === '/' ? absolutePath : absolutePath.slice(mount.prefix.length) || '/';
        return { provider: mount.provider, path: relative };
      }
    }
    throw new Error(`No mount for path: ${absolutePath}`);
  }

  public mount(prefix: string, provider: FileSystemProvider): void {
    this._mounts.push({ prefix: normalizePath(prefix), provider });
    this._mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  public unmount(prefix: string): void {
    this._mounts = this._mounts.filter((m) => m.prefix !== prefix);
  }
}
```

Resolution is O(n) where n = number of mounts (typically 3–6). No sorting on resolve.

### Integration with FileService

`FileService` would call `mountTable.resolve(path)` instead of `registry.getActiveProvider()`:

```typescript
// Before (current)
public async readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const provider = await this._registry.getActiveProvider();
  return provider.readFile(path);
}

// After (with mount table)
public async readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const { provider, path: relative } = this._mountTable.resolve(path);
  return provider.readFile(relative);
}
```

### Backward Compatibility

A mount table with a single `'/'` entry is equivalent to the current single-provider model. Migration can be incremental: wire the `MountTable` first with just `'/'`, then add sub-mounts one at a time.

## Design Decisions

### Decision 1: Isolated Mounts vs. Union Overlay

| Model               | Reads                                 | Writes                             | Complexity |
| ------------------- | ------------------------------------- | ---------------------------------- | ---------- |
| **Isolated mounts** | Path resolves to exactly one provider | Writes go to that provider         | Low        |
| **Union overlay**   | Check upper layer, fall back to lower | Writes go to upper (copy-on-write) | High       |

**Recommendation**: Start with **isolated mounts**. This covers Use Cases 1–5 cleanly. Union overlay (Use Case 6) can be implemented later as a special `OverlayProvider` that wraps two providers into one, mounted at a single path — keeping the mount table itself simple.

### Decision 2: Relative vs. Absolute Paths at Provider Level

Two approaches for what the provider sees after mount resolution:

| Approach     | Provider receives            | Example: read `/projects/A/.tau/cache/foo.bin` with mount at `/.tau/cache/` |
| ------------ | ---------------------------- | --------------------------------------------------------------------------- |
| **Relative** | Path relative to mount point | Provider sees `/foo.bin`                                                    |
| **Absolute** | Original absolute path       | Provider sees `/projects/A/.tau/cache/foo.bin`                              |

**Recommendation**: **Relative paths** (ZenFS model). Each provider operates on its own namespace. This allows a `MemoryProvider` mounted at `/.tau/cache/` to use simple short keys, and allows the same provider class to be mounted at different paths without path collision.

### Decision 3: Cross-Mount Rename

`rename('/projects/A/file.ts', '/git/repo/file.ts')` crosses mount boundaries.

| Approach          | Behavior                             | Trade-off                              |
| ----------------- | ------------------------------------ | -------------------------------------- |
| **Throw EXDEV**   | Caller must handle cross-mount moves | POSIX-correct; simple                  |
| **Copy + delete** | Transparent to caller                | Non-atomic; slow for large directories |

**Recommendation**: **Copy + delete** with a log warning. Application code should not need to know about mount boundaries. Non-atomicity is acceptable because cross-mount renames are rare in Tau's use cases (users don't move files between `.tau/cache/` and the project root).

### Decision 4: Event Propagation

Each mounted provider emits events with paths relative to its namespace. The mount table must re-prefix events before delivering them to `ChangeEventBus`:

```
MemoryProvider at /.tau/cache/ emits: { type: 'fileWritten', path: '/geometry/hash.bin' }
MountTable re-prefixes:            { type: 'fileWritten', path: '/.tau/cache/geometry/hash.bin' }
```

Watch subscriptions must be resolved through the mount table: a `watch({ paths: ['/.tau/cache/'] })` is routed to the `MemoryProvider` at that mount point, with the path stripped to `/`.

### Decision 5: readdir at Mount Boundaries

If `/` is mounted to IndexedDB and `/.tau/cache/` is mounted to memory, then `readdir('/.tau/')` must **merge** entries from both providers:

- IndexedDB's `readdir` for `/.tau/` returns `['parameters.json', 'transcripts', ...]`
- Memory provider at `/.tau/cache/` contributes `'cache'` as a synthetic directory entry

This is a **readdir merge** at mount boundaries — the same pattern `unionfs` uses for `readdir`. The mount table must detect when child mounts exist under the readdir path and inject their mount-point names into the results.

### Decision 6: `InMemoryFileTree` and Mount Awareness

`InMemoryFileTree` currently maintains a single flat path index. With mounts, it must either:

1. **Unified tree**: Merge paths from all mounts into one tree (simpler for consumers, complex for updates)
2. **Per-mount trees**: Each mount has its own tree; queries merge at resolution time

**Recommendation**: **Per-mount trees** initially. The `MountTable` resolves the path to a mount, and each mount has its own `InMemoryFileTree`. `getDirectoryStat` at mount boundaries merges results. This avoids coupling tree internals to mount logic.

## Recommendations

| #      | Action                                                                                     | Priority | Effort     | Impact       | Status                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------ | -------- | ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| ~~R1~~ | ~~Implement `MountTable` with longest-prefix resolution and pre-sorted mount list~~        | ~~P1~~   | ~~Medium~~ | ~~High~~     | ✅ RESOLVED — `packages/filesystem/src/mount-table.ts`                                                                 |
| ~~R2~~ | ~~Wire `MountTable` into `FileService` with single `'/'` mount (backward-compatible)~~     | ~~P1~~   | ~~Low~~    | ~~Low~~      | ✅ RESOLVED — `_resolveProvider()` consults `MountTable`                                                               |
| R3     | Mount `MemoryProvider` at `projectRoot/.tau/cache/` for ephemeral geometry/parameter cache | P1       | Low        | High         | ❌ NOT DONE — `.tau/cache/` still served by the root IndexedDB provider                                                |
| R4     | Mount isolated `DirectIdbProvider` at `/git/` for git object store separation              | P2       | Medium     | Medium       | ❌ NOT DONE — `/git/` paths still served by root provider                                                              |
| ~~R5~~ | ~~Mount OPFS-backed provider at `/node_modules/` for CDN dependency cache~~                | ~~P2~~   | ~~Low~~    | ~~Medium~~   | ✅ RESOLVED — `FileSystemAccessProvider` backed by OPFS `tau-node-modules` handle, mounted in `file-manager.worker.ts` |
| ~~R6~~ | ~~Implement readdir merge at mount boundaries~~                                            | ~~P1~~   | ~~Medium~~ | ~~High~~     | ✅ RESOLVED — `getMountsUnder()` injects synthetic directory entries                                                   |
| ~~R7~~ | ~~Implement event re-prefixing in mount table for cross-mount event propagation~~          | ~~P1~~   | ~~Medium~~ | ~~High~~     | ✅ RESOLVED — events use original absolute paths                                                                       |
| ~~R8~~ | ~~Implement cross-mount rename as copy+delete with warning~~                               | ~~P2~~   | ~~Low~~    | ~~Low~~      | ✅ RESOLVED — cross-mount rename implemented as copy+delete                                                            |
| R9     | Design `OverlayProvider` for union read-through semantics (template overlay)               | P3       | High       | Low (future) | ⏸️ DEFERRED — union overlay not needed yet; isolated mounts cover current use cases                                    |
| R10    | Benchmark mount resolution overhead (target: <0.01ms per resolve for ≤6 mounts)            | P2       | Low        | Medium       | ❌ NOT DONE — no formal benchmark exists for mount resolution performance                                              |

## References

- VS Code `FileService`: `src/vs/platform/files/common/fileService.ts` — scheme-dispatch, cross-provider move
- ZenFS `resolveMount`: `src/emulation/shared.ts` — longest-prefix matching, path stripping
- Linux OverlayFS: [kernel docs](https://docs.kernel.org/filesystems/overlayfs.html) — upper/lower layers, whiteouts, EXDEV
- unionfs (npm): `streamich/unionfs` — global overlay, readdir merge, fan-out watches
- WebContainers `mount()`: data-loading API, not storage routing
- `node:vfs` proposal: `docs/research/node-vfs-applicability.md` — `mount(prefix)` with overlay mode
- CopyOnWrite pattern: `docs/research/fs-capabilities.md` — ZenFS CopyOnWrite backend

## Appendix: Current Path-Routing Trace

For reference, the complete call path for `readFile('/projects/A/main.ts')` today:

```
FileService.readFile(path)
  → this._registry.getActiveProvider()
    → ProviderRegistry._activeBackend  // e.g. 'indexeddb'
    → ProviderRegistry._providers.get('indexeddb')
      → DirectIdbProvider
  → DirectIdbProvider.readFile('/projects/A/main.ts')
    → IDB transaction.get('/projects/A/main.ts')
```

With mount table:

```
FileService.readFile(path)
  → this._mountTable.resolve('/projects/A/main.ts')
    → longest-prefix match: '/' → DirectIdbProvider
    → relative path: '/projects/A/main.ts'
  → DirectIdbProvider.readFile('/projects/A/main.ts')
    → IDB transaction.get('/projects/A/main.ts')
```

With sub-mount at `/.tau/cache/`:

```
FileService.readFile('/.tau/cache/geometry/hash.bin')
  → this._mountTable.resolve('/.tau/cache/geometry/hash.bin')
    → longest-prefix match: '/.tau/cache/' → MemoryProvider
    → relative path: '/geometry/hash.bin'
  → MemoryProvider.readFile('/geometry/hash.bin')
    → Map.get('/geometry/hash.bin')
```

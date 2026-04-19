---
title: 'File Tree Stale Directory After Deletion'
description: 'Root cause investigation of directories persisting in the UI file tree after deletion'
status: active
created: '2026-04-06'
updated: '2026-04-06'
category: investigation
related:
  - docs/policy/filesystem-policy.md
---

# File Tree Stale Directory After Deletion

Investigation into why deleted directories continue to appear in the file tree UI after the user confirms deletion.

## Executive Summary

Directories deleted via the file tree UI remained visible due to multiple compounding bugs in the deletion pipeline. The initial root cause was a path format inconsistency where `deleteDirectory` passed relative paths to `proxy.unlink`. A secondary issue in `handleWorkerFileChanged` applied an extra parent-level indirection to `directoryChanged` events. A deeper investigation revealed that even after fixing these, **orphaned subdirectory entries** in the provider's `_dirs` set caused `readdir` to resurface deleted directories during tree refresh. Additionally, `fileRenamed` events only refreshed the new path's parent (not the old), and `files/route.tsx` used a fragile `replace('//', '/')` for path construction.

## Problem Statement

After confirming directory deletion in the file tree (e.g., deleting `.tau/cache`), the directory continued to appear in the UI. The deletion dialog closed, but the tree did not update. No error was visible to the user because the async `deleteDirectory` call was fire-and-forget (`void treeService.deleteDirectory(path)`).

## Methodology

1. Traced the deletion flow from `confirmDelete` in `chat-editor-file-tree.tsx` through `FileTreeService.deleteDirectory` to the worker-side `FileService.rmdir`.
2. Analyzed `FileService.getDirectoryStat` return value format under both InMemoryFileTree-built and InMemoryFileTree-not-built conditions.
3. Traced the worker event pipeline (`ChangeEvent` → `handleWorkerFileChanged` → `scheduleRefreshForParent`) to identify whether the tree would self-correct via event-driven refresh.
4. Wrote failing tests reproducing both issues, then fixed the implementation.

## Findings

### Finding 1: Inconsistent Path Format from `getDirectoryStat`

`FileService.getDirectoryStat(path)` returns `FileStatEntry[]` with paths in two different formats depending on internal state:

| InMemoryFileTree state | Path format returned          | Example                              |
| ---------------------- | ----------------------------- | ------------------------------------ |
| **Built** (common)     | Relative to queried directory | `model.glb`, `sub/file.ts`           |
| **Not built**          | Absolute provider path        | `/projects/xxx/.tau/cache/model.glb` |

The InMemoryFileTree is built after the first `getDirectoryStat` call, which happens early in the project lifecycle (context suggestions, file stats). For active projects, the tree is essentially always built.

`FileTreeService.deleteDirectory` passed `entry.path` directly to `proxy.unlink`:

```typescript
const entries = await this.proxy.getDirectoryStat(absolutePath);
for (const entry of entries) {
  await this.proxy.unlink(entry.path); // relative path → mount table throws
}
```

When paths are relative (e.g., `model.glb`), `FileService.unlink('model.glb')` calls `MountTable.resolve('model.glb')`, which throws `"No mount matches path: model.glb"` because the path doesn't start with `/`. The `deleteDirectory` promise rejects, the manual tree prune at the end never executes, and the error is silently swallowed by the `void` call in `confirmDelete`.

### Finding 2: `directoryChanged` Event Refreshes Wrong Level

`handleWorkerFileChanged` called `scheduleRefreshForParent(relativePath)` for ALL event types. But `directoryChanged` events already carry the parent directory whose listing changed (set by `FileService.rmdir` as `parentDirectory(deletedDir)`). Applying `scheduleRefreshForParent` goes up one extra level:

| Event              | Path in event         | What `scheduleRefreshForParent` refreshes | Correct target       |
| ------------------ | --------------------- | ----------------------------------------- | -------------------- |
| `fileDeleted`      | The deleted file      | Parent directory                          | Parent directory     |
| `directoryChanged` | Parent of changed dir | Grandparent directory                     | The directory itself |

For the deletion case: deleting `.tau/cache` emits `directoryChanged(path: '/projects/xxx/.tau')`. `handleWorkerFileChanged` converts to relative `.tau`, then `scheduleRefreshForParent('.tau')` refreshes root (`''`). The `.tau` directory listing is never refreshed, so stale children could persist even if the manual prune succeeds.

### Finding 3: Existing Test Masked the Bug

The existing `deleteDirectory` test mocked `getDirectoryStat` to return absolute paths:

```typescript
{ path: '/project/src/a.ts', name: 'a.ts', type: 'file', size: 1, mtimeMs: 0 }
```

This does not match real behavior when the InMemoryFileTree is built. The test passed because absolute paths work with `proxy.unlink`, masking the relative-path failure that occurs in production.

### Finding 4: Orphaned Subdirectory Entries After `deleteDirectory`

`deleteDirectory` unlinks all files returned by `getDirectoryStat`, then calls `rmdir` on the top-level directory only. However, `getDirectoryStat` (via `InMemoryFileTree._collectStats`) returns only **file** entries — directories are recursed into but never included in results. Intermediate subdirectory entries remain in the provider's `_dirs` set as orphans.

The chain:

| Step | What happens                          | Result                                                         |
| ---- | ------------------------------------- | -------------------------------------------------------------- |
| 1    | `getDirectoryStat('.tau/cache')`      | Returns files only: `meshes/part.glb`, `meshes/sub/nested.glb` |
| 2    | `unlink` each file                    | Files removed from provider `_paths`                           |
| 3    | `rmdir('.tau/cache')`                 | Removes `.tau/cache` from `_dirs`                              |
| 4    | `.tau/cache/meshes/` still in `_dirs` | **Orphaned**                                                   |
| 5    | `readdir('.tau')` scans `_dirs`       | Finds `.tau/cache/meshes/` prefix match                        |
| 6    | Returns `cache` as child              | Tree refresh re-adds `.tau/cache`                              |

Both `DirectIdbProvider` and `MemoryProvider` exhibit this pattern — `rmdir` deletes only the exact path, not descendants.

### Finding 5: `fileRenamed` Events Only Refresh New Path Parent

`handleWorkerFileChanged` uses `extractPathFromEvent` which returns only `event.newPath` for `fileRenamed` events. The old path's parent directory is never refreshed via the event pipeline, so the old file entry lingers in the UI tree until a manual refresh or polling cycle.

| Before fix                                      | After fix                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Only `scheduleRefreshForParent(newPath)` called | Both `scheduleRefreshForParent(newPath)` and `scheduleRefreshForParent(oldPath)` called |
| Old entry persists until manual refresh         | Both directories updated via coalesced refresh                                          |

### Finding 6: Fragile Path Construction in `files/route.tsx`

The `deleteRecursive` function in `files/route.tsx` constructs paths via:

```typescript
const fullPath = `${directoryPath}/${entry}`.replace('//', '/');
```

`String.prototype.replace` with a string pattern only replaces the **first** occurrence. While double-slashes mid-path are unlikely in practice, this is a correctness issue. The codebase has a purpose-built `joinPath` utility that handles path normalization correctly.

## Recommendations

| #   | Action                                                                                            | Priority | Effort | Impact | Status   |
| --- | ------------------------------------------------------------------------------------------------- | -------- | ------ | ------ | -------- |
| R1  | Fix `deleteDirectory` to resolve relative paths to absolute before `unlink`                       | P0       | Low    | High   | Resolved |
| R2  | Fix `handleWorkerFileChanged` to use `scheduleRefresh` (not parent) for `directoryChanged` events | P1       | Low    | Medium | Resolved |
| R3  | Consider normalizing `getDirectoryStat` return format to always use a consistent path convention  | P2       | Medium | Medium | Open     |
| R4  | Derive and `rmdir` intermediate subdirectories deepest-first in `deleteDirectory`                 | P0       | Low    | High   | Resolved |
| R5  | Refresh old path's parent directory for `fileRenamed` events in `handleWorkerFileChanged`         | P1       | Low    | Medium | Resolved |
| R6  | Replace `replace('//', '/')` with `joinPath` in `files/route.tsx`                                 | P2       | Low    | Low    | Resolved |

## Code Examples

### Fix 1: Path Resolution in `deleteDirectory` (R1)

```typescript
const entryPath = entry.path.startsWith('/') ? entry.path : joinPath(absolutePath, entry.path);
await this.proxy.unlink(entryPath);
```

### Fix 2: Event-specific Refresh Level (R2)

```typescript
if (event.type === 'directoryChanged') {
  this.scheduleRefresh(relativePath);
} else {
  this.scheduleRefreshForParent(relativePath);
}
```

### Fix 3: Subdirectory Cleanup in `deleteDirectory` (R4)

```typescript
const subdirs = new Set<string>();
for (const entry of entries) {
  const entryPath = entry.path.startsWith('/') ? entry.path : joinPath(absolutePath, entry.path);
  await this.proxy.unlink(entryPath);
  const relativePart = entry.path.startsWith('/') ? entryPath.slice(absolutePath.length + 1) : entry.path;
  const parts = relativePart.split('/');
  for (let i = 1; i < parts.length; i++) {
    subdirs.add(joinPath(absolutePath, parts.slice(0, i).join('/')));
  }
}
const sortedSubdirs = [...subdirs].sort((a, b) => b.split('/').length - a.split('/').length);
for (const dir of sortedSubdirs) {
  await this.proxy.rmdir(dir);
}
await this.proxy.rmdir(absolutePath);
```

### Fix 4: Old-Path Refresh for Renames (R5)

```typescript
if (event.type === 'fileRenamed') {
  const oldAbsolute = event.oldPath;
  if (oldAbsolute.startsWith(rootPrefix) || oldAbsolute === this.rootDirectory) {
    const oldRelative = oldAbsolute.startsWith(rootPrefix) ? oldAbsolute.slice(rootPrefix.length) : '';
    this.scheduleRefreshForParent(oldRelative);
  }
}
```

### Fix 5: Path Construction in `files/route.tsx` (R6)

```typescript
const fullPath = joinPath(directoryPath, entry);
```

## References

- Policy: `docs/policy/filesystem-policy.md`

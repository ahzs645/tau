---
title: 'Cache Strategy Analysis'
description: 'Inventory of caching sites across Tau, access pattern classification, and cache strategy recommendations beyond simple LRU'
status: draft
created: '2026-04-02'
updated: '2026-04-02'
category: audit
related:
  - docs/policy/library-api-policy.md
  - docs/research/ui-startup-performance-gap-analysis.md
---

# Cache Strategy Analysis

Systematic audit of every caching site across the Tau monorepo, classifying access patterns and recommending the most appropriate cache strategy for each.

## Executive Summary

The codebase contains 20+ caching sites spanning five distinct access patterns. Not all benefit from the same strategy. LRU is the right default for content-addressable caches (geometry/parameter middleware), but several sites are better served by singletons, lookup tables, TTL caches, or structural deduplication. Of the non-LRU patterns, only one — **lazy async initialization** — is repeated enough (13+ sites, 3 ad-hoc implementations, 8+ unmemoized WASM inits) to warrant a shared utility alongside `LruMap<V>`. This document classifies each site and recommends the minimum-cost, maximum-impact strategy.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Cache Strategy Taxonomy](#cache-strategy-taxonomy)
- [Access Pattern Classification](#access-pattern-classification)
- [Findings by Area](#findings-by-area)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)

## Problem Statement

Multiple subsystems use unbounded `Map` instances, repeat expensive computations (WASM init, diff algorithms, esbuild builds), or re-read from disk when in-memory results would suffice. A blanket "add LRU everywhere" approach would be wrong — different access patterns demand different strategies. This investigation classifies every caching site to match the right tool to the right problem.

## Methodology

1. Grepped for `new Map`, `Map<`, `cache`, `lru`, `memoize`, `singleton` across all packages
2. Read implementations of every identified caching site (not just signatures)
3. Traced invalidation paths (watch handlers, file change events, lifecycle hooks)
4. Classified each site by access pattern (key domain, read:write ratio, staleness model, value size)
5. Mapped access patterns to cache strategy taxonomy

## Cache Strategy Taxonomy

Six strategies cover every site identified in this audit.

| Strategy                  | Mechanism                                                | Best for                                       | Key property                                    |
| ------------------------- | -------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| **LRU Map**               | Bounded Map, evict least-recently-used                   | Large key domains with temporal locality       | Bounded memory, hot-path speed                  |
| **Singleton / Lazy-Once** | Module-scoped promise or value, initialized on first use | Expensive one-time setup (WASM, IO)            | Zero key domain, amortized init                 |
| **Lookup Table**          | `Map<id, value>` rebuilt on source change                | Small fixed sets with frequent lookups         | O(1) access, no eviction needed                 |
| **TTL Cache**             | Entries expire after a time window                       | External data with bounded staleness tolerance | Freshness guarantee without manual invalidation |
| **Structural Dedup**      | Lift computation, share result via props/context         | Duplicate work in one component tree           | Zero cache overhead, architectural fix          |
| **Content-Addressable**   | Key = hash of input content                              | Pure functions on large inputs                 | Deduplication across callers and time           |

## Access Pattern Classification

Every caching site falls into one of five access patterns.

### Pattern A: Content-Addressable Hot Path

Same input deterministically produces the same output. Key is a content hash. High call frequency on the critical render/compute path.

**Characteristics**: Pure function, large key domain, read-heavy after first compute, values may be large (geometry buffers), invalidation is implicit (new hash = new entry).

**Strategy**: LRU Map (bounded by entry count or bytes).

### Pattern B: One-Time Expensive Init

A resource (WASM module, IO instance, highlighter) is initialized once and reused for the lifetime of the process or worker. There is exactly one result to cache.

**Characteristics**: Single key, write-once-read-many, never invalidated, expensive first call (~100ms+ for WASM).

**Strategy**: Singleton / Lazy-Once (`let cached: T | undefined`).

### Pattern C: Small Fixed Lookup

A small, known set of entries (providers, models, format mappings) is queried by ID. The set changes rarely (process restart, explicit refresh).

**Characteristics**: Small key domain (tens of entries), O(n) scans replaceable with O(1) Map, source refreshes infrequently.

**Strategy**: Lookup Table (Map rebuilt on source change).

### Pattern D: External Data with Staleness Tolerance

Data fetched from an external source (Ollama API, CDN) that changes over time but doesn't need to be fresh on every access.

**Characteristics**: Network I/O cost, bounded staleness acceptable (30-60s), key domain small to medium.

**Strategy**: TTL Cache (expire after time window).

### Pattern E: Duplicate Computation in Component Tree

The same pure function is called multiple times in a single render cycle because different components independently compute the same result from the same inputs.

**Characteristics**: Same (input1, input2) pair diffed/highlighted 2-3x per render, React `useMemo` only partially covers it, fix is structural (lift and share).

**Strategy**: Structural Dedup (lift computation, pass as props).

## Findings by Area

### Finding 1: Runtime Middleware — Content-Addressable (Pattern A)

**Files**: `packages/runtime/src/middleware/parameter-cache.middleware.ts`, `geometry-cache.middleware.ts`

| Property      | Parameter Cache                         | Geometry Cache                                                          |
| ------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| Key           | `dependencyHash` (SHA-256, 64-char hex) | `dependencyHash` (SHA-256, 64-char hex)                                 |
| Value         | `GetParametersResult` (JSON, ~1-10 KiB) | `KernelSuccessResult<GeometryResponse[]>` (binary GLTF, ~100 KiB-5 MiB) |
| Current cache | Filesystem only (`.tau/cache/`)         | Filesystem only (`.tau/cache/`)                                         |
| Read:write    | Read-heavy (same hash on re-render)     | Read-heavy (same hash on re-render)                                     |
| Invalidation  | Implicit (new hash = new key)           | Implicit (new hash = new key)                                           |

**Strategy**: LRU Map as L1 in front of filesystem L2. Content-addressable keys make LRU ideal — temporal locality is strong (users iterate on a small set of files). Parameter cache should have higher `maxEntries` (50) than geometry cache (20) due to smaller value size.

### Finding 2: Kernel Worker Unbounded Maps — Content-Addressable (Pattern A)

**File**: `packages/runtime/src/framework/kernel-worker.ts`

| Cache                   | Line                 | Key              | Bounded?        | Invalidation                    |
| ----------------------- | -------------------- | ---------------- | --------------- | ------------------------------- |
| `bundleResultCache`     | 294                  | Entry path       | No              | Per-path on file change         |
| `fileHashCache`         | 253                  | Absolute path    | No              | Per-path on file change         |
| `fileContentCache`      | 254                  | Absolute path    | No              | Per-path on file change         |
| `executeCacheMap`       | esbuild-core.ts:1064 | Full code string | No              | Per-code on bundle invalidation |
| `assetHashCache`        | 251                  | Asset URL        | Naturally small | On cleanup()                    |
| `middlewareModuleCache` | 266                  | Module URL       | Naturally small | Never                           |

`bundleResultCache`, `fileHashCache`, `fileContentCache`, and `executeCacheMap` grow unboundedly with project size and code churn. In long-running workers editing large projects, these can accumulate thousands of stale entries (invalidation only removes changed paths, not unrelated old entries).

**Strategy**: Replace with LRU Map. The invalidation logic (delete on file change, clear on overflow/reset) is already correct — LRU adds a memory ceiling without changing invalidation semantics. Suggested bounds: `fileHashCache` 500 entries, `fileContentCache` 200 entries (larger values), `bundleResultCache` 50 entries (large values), `executeCacheMap` 50 entries.

### Finding 3: WASM/IO Initialization — Singleton (Pattern B)

**Files**: `packages/converter/src/gltf.utils.ts`, `packages/converter/src/loaders/assimp.loader.ts`, `packages/converter/src/loaders/occt.loader.ts`, `packages/runtime/src/middleware/gltf-*.middleware.ts`

| Init site                              | Called from                                        | Per-call cost             |
| -------------------------------------- | -------------------------------------------------- | ------------------------- |
| `createNodeIo()` (Draco WASM + NodeIO) | 8 call sites across converter + runtime middleware | ~50-200ms (WASM compile)  |
| `assimpjs()`                           | Every Assimp import                                | ~100-300ms (WASM compile) |
| `occtimportjs()`                       | Every OCCT import                                  | ~100-300ms (WASM compile) |
| `rhino3dm()`                           | Every 3DM import                                   | ~100-300ms (WASM compile) |
| Draco `createDecoderModule` in loaders | GltfLoader, DracoLoader                            | ~50-100ms                 |

Every call to these functions creates a new WASM module instance. The output is deterministic and stateless — the same WASM binary always produces the same module.

**Strategy**: Singleton / Lazy-Once. Memoize at module scope with a `Promise` guard:

```typescript
let cachedIo: Promise<NodeIO> | undefined;
export const createNodeIo = (): Promise<NodeIO> => {
  cachedIo ??= initNodeIo();
  return cachedIo;
};
```

This is not LRU — there is exactly one result to cache. No eviction needed.

### Finding 4: Provider/Model Lookups — Lookup Table (Pattern C)

**Files**: `apps/api/app/api/providers/provider.service.ts`, `apps/api/app/api/models/model.service.ts`

| Site                                 | Current                 | Problem                                                         | Key domain            |
| ------------------------------------ | ----------------------- | --------------------------------------------------------------- | --------------------- |
| `getProviders()`                     | Fresh object every call | 2+ full rebuilds per chat request                               | ~10 providers (fixed) |
| `this.models.find(m => m.id === id)` | O(n) scan per lookup    | Multiple scans per request (buildModel, getContextWindow, etc.) | ~20-50 models         |

**Strategy**: Lookup Table.

For providers: memoize `getProviders()` result at instance scope. Config is stable for the process lifetime. Invalidate only on explicit config refresh (which doesn't exist today).

For models: build a `Map<string, Model>` once after each `getModels()` call. Replace all `this.models.find(m => m.id === id)` with `this.modelMap.get(id)`. The map is rebuilt when `getModels()` refreshes the list (startup + explicit refresh).

### Finding 5: Ollama Model Discovery — TTL Cache (Pattern D)

**File**: `apps/api/app/api/models/model.service.ts` (lines 153-206)

`getOllamaModels()` calls `ollama.list()` followed by `ollama.show()` for each model. This involves N+1 HTTP requests to the local Ollama server.

| Property            | Value                                         |
| ------------------- | --------------------------------------------- |
| Call frequency      | Every `GET /v1/models` request                |
| Staleness tolerance | 30-60s acceptable (models don't change often) |
| Key domain          | Single result (the full model list)           |

**Strategy**: TTL Cache. Cache the Ollama model list for 30-60 seconds. A simple timestamp check is sufficient — no LRU needed (single key).

```typescript
private ollamaCache?: { models: Model[]; expiresAt: number };
```

### Finding 6: Diff Computation — Structural Dedup (Pattern E)

**Files**: `apps/ui/app/components/code/diff-viewer.tsx`, `apps/ui/app/components/chat/chat-tool-file-operation.tsx`

`DiffPreview` triggers `processDiffWithContext` twice per render (once in `getDiffLineCount`, once in `DiffViewer`'s `useMemo`). `CollapsibleFileOperationTrigger` runs a third `diffLines` pass via `getFirstChangedLine`.

| Call                     | Source                                   | Redundant?                                       |
| ------------------------ | ---------------------------------------- | ------------------------------------------------ |
| `processDiffWithContext` | `getDiffLineCount` in DiffPreview render | Yes — same (orig, mod) pair                      |
| `processDiffWithContext` | `DiffViewer` useMemo                     | No — this is the canonical one                   |
| `diffLines`              | `getFirstChangedLine` in trigger         | Yes — already computed in processDiffWithContext |

**Strategy**: Structural Dedup. Lift `processDiffWithContext` into a single `useMemo` at the `DiffPreview` level. Derive `lineCount` and `firstChangedLine` from the segments array instead of recomputing the diff. Pass segments down as props to `DiffViewer`.

This eliminates 2 redundant diff passes per render cycle without any cache infrastructure.

### Finding 7: DirectoryTreeCache — Bounded LRU (Pattern A)

**File**: `packages/filesystem/src/directory-tree-cache.ts`

Stores `Map<string, TreeEntry>` per directory path with no eviction. Invalidated on mutations (`writeFile`, `rename`, `unlink`, `rmdir`) via `invalidate`/`invalidateSubtree`/`invalidateAncestors`. Can grow unboundedly with project directory count.

**Strategy**: Add LRU eviction to the outer Map (keyed by directory path). Keep invalidation semantics unchanged. Suggested bound: 1000 directories (covers most projects with margin).

### Finding 8: Lazy Async Init — Utility Assessment (Pattern B)

The singleton/lazy-once pattern appears across the codebase in three forms, with inconsistent correctness:

**Form 1 — `??=` guard (simple, but caches rejected promises)**

Used in `shiki.lib.ts`, `feature-flags.ts`, `github-api.ts`, `chat-rpc-socket.service.ts`:

```typescript
let cached: Promise<T> | undefined;
export const getResource = () => {
  cached ??= expensiveInit();
  return cached;
};
```

If `expensiveInit()` rejects (network failure, missing WASM), the rejected promise is cached permanently. All future callers receive the same rejection.

**Form 2 — Double-flag guard (verbose, handles rejection manually)**

Used in `esbuild-core.ts`, `javascript-import-parser.ts`:

```typescript
let initialized = false;
let initPromise: Promise<void> | undefined;
export const ensureInit = () => {
  if (!initialized) {
    initPromise = doInit().then(() => {
      initialized = true;
    });
  }
  return initPromise!;
};
```

Handles rejection (flag stays `false`) but requires 4 variables and subtle ordering.

**Form 3 — No guard (repeated init, current WASM loaders)**

Used in 8+ sites in `packages/converter/`:

| File                          | Function                 | Per-call cost                      |
| ----------------------------- | ------------------------ | ---------------------------------- |
| `gltf.utils.ts`               | `createNodeIo()`         | ~50-200ms (Draco WASM ×2 + NodeIO) |
| `assimp.loader.ts`            | `assimpjs()`             | ~100-300ms                         |
| `assimp.exporter.ts`          | `assimpjsExporter()`     | ~100-300ms                         |
| `occt.loader.ts`              | `occtimportjs()`         | ~100-300ms                         |
| `3dm.loader.ts`               | `rhino3dm()`             | ~100-300ms                         |
| `gltf.loader.ts`              | `createDecoderModule()`  | ~50-100ms                          |
| `file-resolver-io.ts`         | `createFileResolverIo()` | ~100-200ms (Draco ×2)              |
| `draco/gltf-draco-decoder.ts` | `createDecoderModule()`  | ~50-100ms                          |

**Already-memoized sites** (5+, using Forms 1–2):

| File                             | Variable                | Pattern                          |
| -------------------------------- | ----------------------- | -------------------------------- |
| `shiki.lib.ts:4`                 | `cachedHighlighter`     | Form 1 (`??=`)                   |
| `esbuild-core.ts:89`             | `initializationPromise` | Form 2 (double-flag)             |
| `handle-store.ts:49`             | `openPromise`           | Form 1 (coalesced, then cleared) |
| `javascript-import-parser.ts:14` | `initPromise`           | Form 2 (double-flag)             |
| `kcl-symbol-service.ts:1401`     | Module singleton        | Form 1 (`??=`)                   |

**Assessment**: A `lazyAsync<T>` utility standardizes this pattern, handles rejection correctly (clears cached promise on failure so the next call retries), and is immediately applicable to 8+ unmemoized WASM init sites. The utility is ~15 lines. TTL caches (1-2 sites), lookup tables (2 sites), and structural dedup (1 site) do not justify utilities — their inline patterns are trivial.

### Finding 9: System Prompt Assembly — No Cache (Assessed)

**File**: `apps/api/app/api/chat/prompts/cad-agent.prompt.ts`

`getCadSystemPrompt()` builds the full prompt per request. The "static" bucket includes `chatId`-dependent sections, making cross-request caching incorrect without structural refactoring. Provider-side prompt caching (Anthropic `cache_control`) already handles the expensive part.

**Strategy**: No application-level cache recommended. The current provider-side caching is the correct layer. Splitting static vs dynamic sections would require architectural changes disproportionate to the benefit.

## Recommendations

| #   | Site                                   | Strategy               | Priority | Effort | Impact                                                  |
| --- | -------------------------------------- | ---------------------- | -------- | ------ | ------------------------------------------------------- |
| R1  | Geometry/parameter middleware          | LRU Map (L1/L2)        | P0       | Low    | High — eliminates disk I/O on hot render path           |
| R2  | `createNodeIo` + WASM inits (8+ sites) | `lazyAsync`            | P1       | Low    | High — saves 100-300ms per converter/middleware call    |
| R3  | Kernel worker unbounded Maps           | LRU Map                | P1       | Medium | Medium — bounds memory in long sessions                 |
| R4  | Provider service `getProviders`        | Lookup Table           | P1       | Low    | Medium — eliminates 2+ object rebuilds per chat request |
| R5  | Model service `find` scans             | Lookup Table           | P2       | Low    | Low — O(n) → O(1), small n                              |
| R6  | Diff computation duplication           | Structural Dedup       | P2       | Low    | Medium — eliminates 2 redundant diff passes per render  |
| R7  | Ollama model discovery                 | TTL Cache              | P2       | Low    | Medium — eliminates N+1 HTTP calls within TTL window    |
| R8  | `DirectoryTreeCache`                   | LRU eviction           | P3       | Low    | Low — prevents memory growth in large projects          |
| R9  | `analyzeGlb` in testing                | Content-Addressable    | P3       | Low    | Low — helps benchmark/CI only                           |
| R10 | Existing ad-hoc singletons (5+ sites)  | Migrate to `lazyAsync` | P3       | Low    | Low — consistency + rejection handling                  |

### Utilities to ship in `@taucad/utils/cache`

Two utilities cover the full range of cases that warrant shared abstractions:

**1. `LruMap<V>`** — Bounded Map with LRU eviction (entry-count-based).

Consumers: R1 (middleware L1 caches), R3 (kernel worker Maps), R8 (DirectoryTreeCache), R9 (analyzeGlb).

```typescript
export class LruMap<V> {
  constructor(options: { maxEntries: number });
  get(key: string): V | undefined;
  peek(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  clear(): void;
  get size(): number;
}
```

**2. `lazyAsync<T>`** — One-time async initialization with rejection retry.

Consumers: R2 (8+ WASM inits in converter), R10 (5+ existing ad-hoc singletons).

```typescript
export const lazyAsync = <T>(factory: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) {
      cached = factory().catch((error) => {
        cached = undefined;
        throw error;
      });
    }
    return cached;
  };
};
```

Key properties:

- Concurrent callers share the same in-flight promise (no stampede)
- On rejection, clears the cached promise so the next call retries
- Zero-config — wrap the factory, get a memoized accessor
- ~10 lines of implementation

### What does NOT warrant a utility

| Pattern              | Sites                                | Why inline is sufficient                                                        |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| **TTL Cache**        | 1-2 (Ollama, maybe type acquisition) | 3-line inline: `if (!c \|\| Date.now() > c.expiresAt) c = { value, expiresAt }` |
| **Lookup Table**     | 2 (providers, models)                | One-liner: `new Map(items.map(i => [i.id, i]))`                                 |
| **Structural Dedup** | 1 (diff computation)                 | Architectural refactor, not a data structure                                    |

## Trade-offs

### LRU Map vs unbounded Map

|            | Unbounded Map                    | LRU Map                             |
| ---------- | -------------------------------- | ----------------------------------- |
| Memory     | Grows without limit              | Bounded by `maxEntries`             |
| Eviction   | Only explicit delete/clear       | Automatic oldest eviction           |
| Risk       | Memory pressure in long sessions | Evicting a still-useful entry       |
| Complexity | None                             | Minimal (Map insertion-order trick) |

For content-addressable caches, evicting an entry only costs one re-computation or disk read on the next access — acceptable.

### `lazyAsync` vs ad-hoc singleton patterns

|                    | `??=` guard                         | Double-flag            | `lazyAsync` utility          |
| ------------------ | ----------------------------------- | ---------------------- | ---------------------------- |
| Rejection handling | Caches rejected promise permanently | Manual flag management | Automatic retry on rejection |
| Concurrent callers | Coalesced (correct)                 | Coalesced (correct)    | Coalesced (correct)          |
| Lines per site     | 3-4                                 | 6-8                    | 1 (wrap call)                |
| Correctness risk   | Silent permanent failure            | Flag ordering bugs     | None (handled internally)    |

The rejection behavior is the critical differentiator. The `??=` pattern is concise but silently breaks on transient failures — if WASM download fails once (network hiccup, CDN issue), all subsequent callers permanently receive the same rejection. `lazyAsync` clears the cached promise on rejection, allowing the next caller to retry.

### Singleton vs per-call init

|             | Per-call init              | Singleton                                                     |
| ----------- | -------------------------- | ------------------------------------------------------------- |
| Memory      | Temporary (GC'd after use) | Persistent for process lifetime                               |
| Concurrency | Independent instances      | Shared state (stateless OK, stateful risky)                   |
| Risk        | None (current behavior)    | WASM module corruption if mutated (unlikely for NodeIO/Draco) |

`NodeIO` and Draco modules are stateless readers/writers — safe to share.

### TTL vs on-demand refresh

|           | TTL Cache                            | On-demand refresh               |
| --------- | ------------------------------------ | ------------------------------- |
| Freshness | Bounded staleness (30-60s)           | Always fresh                    |
| Cost      | One set of HTTP calls per TTL window | N+1 HTTP calls per request      |
| Risk      | Serving slightly stale model list    | Ollama latency on every request |

30-60s staleness is acceptable for the models picker — users don't install/remove Ollama models mid-session.

### Structural dedup vs process-level LRU for diffs

|            | Lift useMemo                   | Process LRU                           |
| ---------- | ------------------------------ | ------------------------------------- |
| Scope      | One component tree             | Cross-mount, cross-session            |
| Complexity | Props refactor                 | Cache key management, memory overhead |
| Coverage   | Eliminates 2/3 redundant calls | Could cache across navigations        |

Structural dedup is the right first step — it fixes the root cause (duplicate computation) rather than masking it with caching.

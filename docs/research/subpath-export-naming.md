---
title: 'Subpath Export Naming Conventions'
description: 'Research into singular vs plural naming for package.json subpath exports, with library survey and recommendation'
status: active
created: '2026-03-11'
updated: '2026-03-11'
category: comparison
related:
  - docs/policy/library-api-policy.md
---

# Subpath Export Naming Conventions

Investigation into whether `package.json` subpath exports should use singular or plural nouns, surveying major TypeScript libraries and analyzing the current `@taucad/kernels` structure.

## Executive Summary

No official specification prescribes singular vs plural for subpath exports. Survey of major TypeScript libraries (tRPC, Effect-TS, TanStack Router, Drizzle ORM) shows a strong consensus toward singular nouns — treating subpaths as module namespaces, not REST-style collections. The current `@taucad/kernels` package has an inconsistency (`./kernels` plural vs `./bundler` and `./middleware` singular) that creates cognitive friction and a doubled-name stutter. Recommendation: use singular for all subpath segments.

## Problem Statement

The `@taucad/kernels` package uses inconsistent casing across its subpath exports:

```text
@taucad/kernels/kernels        (plural)
@taucad/kernels/bundler        (singular)
@taucad/kernels/middleware     (singular)
@taucad/kernels/transport      (singular)
@taucad/kernels/filesystem     (singular)
@taucad/kernels/testing        (singular)
```

This inconsistency creates three problems:

1. **Unpredictability**: a developer who knows `./bundler` cannot predict whether the kernel barrel is `./kernel` or `./kernels`
2. **Doubled name**: `import { replicad } from '@taucad/kernels/kernels'` stutters the package name
3. **Masked inconsistency**: `middleware` happens to work as both singular and plural (mass noun), hiding the mismatch with `kernels`

## Methodology

1. Checked npm, Node.js, and TypeScript documentation for any specification on subpath export naming — none exists
2. Surveyed subpath export structures of five high-DX TypeScript libraries with rich subpath maps
3. Examined REST API naming conventions for comparison (different domain but useful signal)
4. Analyzed the current `@taucad/kernels` export structure against the findings

## Findings

### Finding 1: No Official Standard Exists

There is no Node.js, npm, or TypeScript specification that prescribes singular vs plural for subpath exports. The `package.json` `exports` field is purely a routing mechanism — it does not impose naming semantics. The [Node.js documentation on subpath exports](https://nodejs.org/api/packages.html#subpath-exports) uses arbitrary path names in its examples without commentary on naming conventions.

### Finding 2: Major Libraries Use Singular

| Library         | Version surveyed | Subpath examples                                               | Pattern                                                         |
| --------------- | ---------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| `@trpc/server`  | 11.x             | `./http`, `./observable`, `./rpc`, `./shared`                  | Singular standalone modules                                     |
| `@trpc/server`  | 11.x             | `./adapters/express`, `./adapters/fastify`, `./adapters/fetch` | Plural category parent (`adapters`), singular child (`express`) |
| Effect-TS       | 3.x              | `effect/Schema`, `effect/Stream`, `effect/Config`              | All singular — each is a distinct module                        |
| TanStack Router | 1.x              | `./ssr/server`, `./ssr/client`                                 | Singular throughout                                             |
| Drizzle ORM     | 0.3x             | `./pg-core`, `./mysql-core`, `./sqlite-core`                   | Singular self-contained modules                                 |

The one exception found was tRPC's `./adapters` category parent, which uses plural to denote "the adapters category." However, the individual implementations within it (`./adapters/express`) are all singular.

### Finding 3: REST API Conventions Do Not Apply

REST APIs have standardized on plural nouns for collection endpoints (`/users`, `/products`, `/orders`), with singular used for singletons. However, package exports are module namespaces, not entity collections. A developer is not querying "all the kernels" — they are importing from a specific module category. The semantics are fundamentally different.

| Domain          | Concept                | Convention            | Reason                                  |
| --------------- | ---------------------- | --------------------- | --------------------------------------- |
| REST APIs       | Collection of entities | Plural (`/users`)     | URL addresses a collection of resources |
| Package exports | Module namespace       | Singular (`./kernel`) | Path selects a module to import from    |

### Finding 4: Consistency Is the Critical Success Factor

Every source examined — library documentation, style guides, developer experience research — agrees on one universal finding: **consistency is the critical success factor**. Inconsistent naming creates "cognitive friction" — developers cannot predict the import path and must constantly look it up. Predictable, consistent naming enables autocomplete-driven discovery.

### Finding 5: Current `@taucad/kernels` Analysis

The package has three plugin categories, each with a parent entry (the barrel) and child entries (individual implementations):

| Category           | Current subpath           | Children                                     | Issue                         |
| ------------------ | ------------------------- | -------------------------------------------- | ----------------------------- |
| Kernel plugins     | `./kernels` (plural)      | `./kernels/replicad`, `./kernels/jscad`, ... | Doubles the package name      |
| Bundler plugins    | `./bundler` (singular)    | `./bundler/esbuild`                          | Inconsistent with `./kernels` |
| Middleware plugins | `./middleware` (singular) | `./middleware/parameter-cache`, ...          | Inconsistent with `./kernels` |

The standalone modules (`./transport`, `./filesystem`, `./testing`, `./types`, `./worker`) are all singular, which is unambiguously correct.

## Recommendations

| #   | Action                                                             | Priority | Effort | Impact                                             |
| --- | ------------------------------------------------------------------ | -------- | ------ | -------------------------------------------------- |
| R1  | Adopt singular for all subpath export segments                     | P0       | Low    | High — eliminates stutter, enables path prediction |
| R2  | Rename `./kernels` → `./kernel` (and `./kernels/*` → `./kernel/*`) | P0       | Low    | High — the only change needed                      |
| R3  | Document the convention in library API policy                      | P0       | Low    | Medium — prevents future drift                     |

### Recommended structure

```text
@taucad/kernels                            (root — package name is plural scope)
@taucad/kernels/kernel                     (barrel: replicad, jscad, manifold, ...)
@taucad/kernels/kernel/replicad            (individual kernel)
@taucad/kernels/bundler                    (barrel: esbuild — already singular)
@taucad/kernels/bundler/esbuild            (individual bundler — already singular)
@taucad/kernels/middleware                 (barrel: parameterCache, ... — already singular)
@taucad/kernels/middleware/parameter-cache  (individual middleware — already singular)
@taucad/kernels/transport                  (standalone — already singular)
@taucad/kernels/filesystem                 (standalone — already singular)
@taucad/kernels/testing                    (standalone — already singular)
```

The semantic distinction: the **package name** (`@taucad/kernels`) is plural because it scopes a collection of many things. The **subpath** (`/kernel`) is singular because it is a module namespace you import from.

This aligns with the tRPC pattern where `@trpc/server` (singular "server") uses `./adapters/express` (plural category, singular implementation). In our case: `@taucad/kernels` (plural package) → `./kernel/replicad` (singular namespace → specific implementation).

## Trade-offs

| Approach                       | Pros                                                             | Cons                                                                 |
| ------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| **All singular** (recommended) | Consistent; no stutter; matches tRPC/Effect/Drizzle; predictable | Requires renaming `./kernels` → `./kernel` (breaking change)         |
| **All plural**                 | Also consistent                                                  | Creates stutter (`kernels/kernels`); diverges from library consensus |
| **Mixed** (current)            | No migration needed                                              | Unpredictable; cognitive friction; developers cannot guess paths     |

## References

- [Node.js Subpath Exports Documentation](https://nodejs.org/api/packages.html#subpath-exports)
- [`@trpc/server` package.json exports](https://github.com/trpc/trpc/blob/main/packages/server/package.json)
- [Effect-TS package.json exports](https://github.com/Effect-TS/effect/blob/main/packages/effect/package.json)
- [Drizzle ORM package.json exports](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/package.json)
- [TanStack Router package.json exports](https://github.com/TanStack/router/blob/main/packages/react-router/package.json)
- Policy: `docs/policy/library-api-policy.md`

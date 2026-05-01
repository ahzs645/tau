---
title: 'Runtime Smells Outside Async Transport Scope'
description: 'Inventory of runtime architectural/code smells that are adjacent but out-of-scope for the async-event contract and transport-topology refactor.'
status: draft
created: '2026-04-22'
updated: '2026-04-22'
category: audit
related:
  - docs/research/runtime-async-event-contract-v2.md
  - docs/research/runtime-async-event-contract.md
---

# Runtime Smells Outside Async Transport Scope

Audit of runtime smells discovered during the async transport contract investigation but intentionally excluded from that implementation scope.

## Executive Summary

The async transport contract work should stay focused on event materialisation, ordering/correlation, and transport/backplane abstraction. During the audit, we found additional issues in `packages/runtime/src` (module size/complexity, type-escape hatches, mutable global state, logging discipline, and upstream workaround coupling). These are real, but folding them into the transport refactor would increase risk and dilute execution.

This document captures those smells with evidence, severity, and recommended follow-up tracks.

## Problem Statement

The user requested that non-scope smells be separated from the primary transport-contract research. Without this split, transport architecture decisions would be entangled with unrelated refactors and lose delivery clarity.

## Methodology

1. Broad scan of `packages/runtime/src` for structural smells and repeated suppression patterns.
2. Categorization into:
   - **In transport scope**
   - **Out of transport scope**
3. Evidence collection from representative files.

## Findings

### Finding 1: Megamodule risk in central runtime files

Large, high-centrality files increase blast radius and review burden.

| File                                                      | Signal                                 | Why it matters                                                                                                         |
| --------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/client/runtime-client.ts`           | ~1597 lines                            | Core API lifecycle, render orchestration, event wiring, and terminate semantics are co-located; hard to change safely. |
| `packages/runtime/src/bundler/esbuild-core.ts`            | ~1k+ lines                             | Bundler internals are dense and difficult to reason about incrementally.                                               |
| `packages/runtime/src/framework/runtime-worker-client.ts` | `handleMessage` complexity suppression | Message protocol handling has grown monolithic.                                                                        |

This is partially adjacent to transport work (`runtime-client`, `runtime-worker-client`) but mostly a separate maintainability track.

### Finding 2: Complexity suppressions indicate deferred decomposition

Representative examples:

- `packages/runtime/src/framework/runtime-worker-client.ts` uses `oxlint-disable-next-line complexity` for `handleMessage`.
- `packages/runtime/src/utils/import-off.ts` suppresses complexity for `parseOff`.
- `packages/runtime/src/kernels/zoo/kcl-utils.ts` suppresses complexity in `createExportFormat`.

Not all suppressions are wrong, but accumulation indicates missing decomposition boundaries.

### Finding 3: Type-escape hatches in production paths

Examples include `as any` and generic `(...args: any[]) => any` constraints in bridge/proxy and source-map interop paths.

These are often pragmatic interop points, but they weaken compile-time guarantees in code that already handles complex runtime behavior.

### Finding 4: Mutable module-level state patterns

`packages/runtime/src/framework/cooperative-abort.ts` uses module-level mutable state (`abortSignalView`, `abortGeneration`). This can be legitimate for singleton worker contexts but becomes fragile under test parallelism, multi-instance embedding, or future re-entrant topologies.

### Finding 5: Console logging in runtime internals

Several non-test files still use `console.*` directly (e.g., bridge error handling, some kernel utility paths). Inconsistent logging strategy can fragment observability and make host integration behavior unpredictable.

### Finding 6: Upstream workaround coupling in Zoo engine connection

`packages/runtime/src/kernels/zoo/engine-connection.ts` contains explicit behavior that ignores `auth_token_missing` due upstream bug expectation.

This can be necessary short-term, but is a high-risk coupling smell and should be tracked with explicit removal criteria.

### Finding 7: Stub-vs-shipping ambiguity in remote transport

`createWebSocketTransport` intentionally exists as a shape-conformance stub. This is acceptable, but if not clearly labeled in docs/release notes, users can infer runtime readiness that does not exist.

This intersects with transport scope but should be managed as release communication + feature gating, not core async contract mechanics.

## Recommendations

| #   | Action                                                                                                                             | Priority | Effort | Impact |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Create a runtime decomposition plan for `runtime-client.ts` and `runtime-worker-client.ts` after transport contract stabilization. | P1       | Medium | High   |
| R2  | Track complexity suppressions with explicit issue links and decomposition milestones.                                              | P1       | Low    | Medium |
| R3  | Audit production `any`/`as any` sites and classify: unavoidable interop vs fixable typing debt.                                    | P2       | Medium | Medium |
| R4  | Define policy for module-level mutable state in framework internals (allowed contexts, test constraints).                          | P2       | Medium | Medium |
| R5  | Standardize runtime logging strategy (`onLog`/telemetry-first, minimal direct `console.*`).                                        | P2       | Low    | Medium |
| R6  | Isolate upstream workaround behavior behind typed feature flags and issue metadata.                                                | P1       | Low    | Medium |
| R7  | Add docs/testing labels distinguishing "shape-conformant stub transport" vs "behavior-conformant transport".                       | P1       | Low    | High   |

## Scope Boundary

These findings are **out-of-scope** for the immediate async transport contract refactor unless they directly block:

- transport-neutral protocol/backplane abstraction,
- event ordering/correlation guarantees,
- or removal of async surface antipatterns.

Everything else should run as follow-up tracks to keep the transport initiative focused and shippable.

## References

- `docs/research/runtime-async-event-contract-v2.md`
- `docs/research/runtime-async-event-contract.md`
- `packages/runtime/src/client/runtime-client.ts`
- `packages/runtime/src/framework/runtime-worker-client.ts`
- `packages/runtime/src/framework/cooperative-abort.ts`
- `packages/runtime/src/kernels/zoo/engine-connection.ts`

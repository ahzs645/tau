---
title: 'Runtime Quickstart DX Regression Gap Analysis'
description: 'Audit of the v5 RuntimeClient API surface against quickstart/landing documentation, identifying 9 DX regressions and recommendations to restore one-call elegance without giving up the v5 lifecycle guarantees.'
status: active
created: '2026-04-22'
updated: '2026-04-22'
category: audit
related:
  - docs/policy/library-api-policy.md
  - docs/research/runtime-event-driven-api-blueprint-v5.md
  - docs/research/runtime-client-type-safety-audit.md
---

# Runtime Quickstart DX Regression Gap Analysis

Cross-reference of the v5 `RuntimeClient` API surface (post-blueprint implementation) against the working-copy documentation in `apps/ui/content/docs/(runtime)/`, focused on standalone npm consumers landing on the package for the first time.

## Executive Summary

The v5 blueprint added genuinely valuable lifecycle primitives — explicit `connect()`, `RenderSettlement` supersession, typed lifecycle errors, `lifecycleState`, autonomous `openFile`/`updateParameters` — but the documentation pass that followed _uniformly assumed every consumer is a UI application driving an autonomous render loop_. Standalone npm consumers (CLI users, Node.js scripts, the landing-page snippet, the quickstart) inherited boilerplate they do not need: explicit `connect({ fileSystem: fromMemoryFS() })`, `client.on('geometry', ...)` subscriptions, `unsubscribe()` calls, and `RenderSettlement.superseded` checks that can never be `true` in a single-shot script.

The implementation already preserves **lazy auto-connect for inline `code:` input** (`runtime-client.ts:1087–1131`) and exposes a one-shot `client.export(format, input)` overload that returns a `Promise<ExportResult>` directly. The regression is purely a documentation choice: the quickstart now models the production-wiring code path instead of the npm-consumer code path. Restoring the original "10-line elegant quickstart" requires no API changes — only re-aligning the docs with the simplest supported path.

The quickstart grew from 13 lines to 22 lines (+69%) and introduced 5 net-new concepts (`fromMemoryFS`, `connect`, `on('geometry')`, `unsubscribe`, `settlement.superseded`) before the reader has rendered their first model. This is the largest single-page DX regression across the runtime docs and is the focus of this analysis.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [References](#references)

## Problem Statement

Two questions from the user, framed as gap-analysis triggers:

1. **Why did `fileSystem` move from a `createRuntimeClient` argument to an explicit `client.connect({ fileSystem })` call across every documented snippet** — when auto-connect is preserved for inline-`code:` input and `createRuntimeClient({ fileSystem })` still triggers lazy connect on first command?
2. **Why do all quickstarts demonstrate the autonomous event-driven render loop** (`client.on('geometry', ...)` + `client.openFile(...)` + `RenderSettlement.superseded`) instead of the imperative one-shot `client.export(format, input)` overload that returns geometry directly?

Both reduce to the same DX regression: the docs adopted the production-wiring contract (port-based bridges, deferred FS attachment, autonomous re-rendering) as the default code path, even on the page whose stated goal is "Render your first 3D model in under 4 minutes."

Library-API policy (`docs/policy/library-api-policy.md`) explicitly warns against this pattern: factories should "do the right thing by default" and lazy/explicit ceremony should be opt-in for advanced wiring scenarios.

## Methodology

1. Read `runtime-event-driven-api-blueprint-v5.md` and the implementation plan (`runtime_v5_blueprint_implementation_77c44607.plan.md`) to recover the original justification for each new lifecycle primitive.
2. Read every working-copy diff under `apps/ui/content/docs/(runtime)/` (15 files, +268/-161 lines) to catalog the new ceremony introduced by the v5 doc pass.
3. Read the `RuntimeClient` implementation (`packages/runtime/src/client/runtime-client.ts:1087–1196`) to verify which lazy / auto-connect paths the v5 implementation actually preserves (vs. removes) — this is the gap between what the API supports and what the docs demonstrate.
4. Cross-referenced each documented snippet against `library-api-policy.md` heuristics ("factories should do the right thing by default", "events for streams, promises for one-shots", "errors over silent fallbacks", "narrow defaults, wide opt-in").

## Findings

### Finding 1: Quickstart line count and concept count nearly doubled — RESOLVED

**Status**: RESOLVED — `apps/ui/content/docs/(runtime)/getting-started/quick-start.mdx` rewritten to a 14-line `client.export('glb', { code, file })` snippet (1 top-level import). Locked down by `scripts/src/validate-quickstart-budget.ts` (≤15 lines, ≤3 imports) wired into `pnpm docs:validate`.

**Severity**: P0 — The page whose entire job is first-impression elegance.

| Metric                              | Before (working tree HEAD)           | Working copy                   | Δ    |
| ----------------------------------- | ------------------------------------ | ------------------------------ | ---- |
| Code lines in primary snippet       | 13                                   | 22                             | +69% |
| Public symbols imported             | 2 (`createRuntimeClient`, `presets`) | 3 (+ `fromMemoryFS`)           | +50% |
| Net-new concepts before first model | 0                                    | 5 (see below)                  | +5   |
| Awaited calls                       | 1 (`client.render`)                  | 2 (`connect`, `openFile`)      | +1   |
| Cleanup calls                       | 1 (`terminate`)                      | 2 (`unsubscribe`, `terminate`) | +1   |

The 5 net-new concepts surfaced before the reader sees geometry: (a) `fromMemoryFS()` factory, (b) explicit `connect()` step, (c) `client.on('geometry', handler)` event subscription, (d) `RenderSettlement.superseded` discriminated branch, (e) `unsubscribe()` cleanup.

**Sources**: `apps/ui/content/docs/(runtime)/getting-started/quick-start.mdx` (working copy vs. HEAD).

### Finding 2: Auto-connect for inline `code:` is implemented but undocumented — RESOLVED

**Status**: RESOLVED — Auto-connect contract documented as a `@public` JSDoc invariant on `RuntimeClient.openFile`/`export`/`connect` overloads and `RuntimeClientOptions.fileSystem` (see `packages/runtime/src/client/runtime-client.ts`). `createNodeClient` reverted to the lazy-connect shape (no eager `connect`, no unconditional `fromMemoryFS()` fallback). Contract locked down by new tests in `packages/runtime/src/client/runtime-client-export-auto-connect.test.ts`, expanded `runtime-client-open-file.test.ts`, and expanded `node.test.ts`.

**Severity**: P1 — Working code path is invisible to consumers.

`runtime-client.ts:1087–1131` (the body of `openFile`) demonstrates that `openFile({ code, file })` provisions an in-memory filesystem internally (`managedFileSystem ??= fromMemoryFS()`) and calls `ensureConnected({ fileSystem: managedFileSystem })` automatically. The same path is reused by `client.export(format, { code, file })` via internal delegation.

The v5 docs do not advertise this. Every snippet that uses `code:` input is preceded by an explicit `await client.connect({ fileSystem: fromMemoryFS() })` — duplicating work the implementation already does, and forcing the reader to learn `fromMemoryFS` before they can render anything.

**Evidence**:

```typescript
// packages/runtime/src/client/runtime-client.ts:1087
async openFile(input: CodeInput<...> | FileInput): Promise<RenderSettlement> {
  assertNotTerminated();
  if (!input.code && lifecycleState !== 'connected' && !options.fileSystem) {
    throw new RuntimeNotConnectedError('openFile');
  }
  // ...
  if (input.code) {
    managedFileSystem ??= fromMemoryFS();           // <-- auto-provisioned
    // ...
    const client = await ensureConnected({ fileSystem: managedFileSystem }); // <-- auto-connect
    client.openFile(resolvedFile, parameters, renderOptions);
  } else {
    const client = await ensureConnected();          // file-only path requires prior connect or createRuntimeClient({ fileSystem })
    // ...
  }
}
```

The `assertNotTerminated()` (looser) gate is intentional: the v5 author preserved auto-connect for the _exact_ code path quickstarts demonstrate.

**Sources**: `runtime-client.ts:1087–1147`; `runtime-event-driven-api-blueprint-v5.md` Finding 18 (which scopes "explicit connect" to the production / port-based wiring case, not inline-code consumers).

### Finding 3: One-shot `client.export(format, input)` overload exists, not used in quickstart — RESOLVED

**Status**: RESOLVED — Quickstart, your-first-kernel, index, and all swept doc pages now lead with `client.export(format, input)` for single-shot demos. The autonomous-loop API is reserved for `guides/live-rendering.mdx`.

**Severity**: P1 — Imperative one-shot API is the canonical "show capability" surface.

The v5 blueprint `Render-vs-Export Dichotomy` (Finding 14 of the blueprint) explicitly carved out `export(format, input?)` as the one-shot API for non-autonomous consumers (CLI, "Save As" buttons, scripts). When called with inline `code:` input, it self-renders, returns a `Promise<ExportResult>`, and never requires the consumer to subscribe to any event channel.

The landing page (`apps/ui/content/docs/(runtime)/index.mdx:11–30`) already uses `client.export('step', { code, file })`. The quickstart does not; instead, it models the autonomous loop via `openFile` + `on('geometry')`. This is inconsistent — and the autonomous path is the wrong default for a first-render demo.

**Sources**: `runtime-event-driven-api-blueprint-v5.md` Finding 14; `apps/ui/content/docs/(runtime)/index.mdx`; quickstart working copy.

### Finding 4: Event subscription pattern leaked into single-shot snippets — RESOLVED

**Status**: RESOLVED — All single-shot snippets across the swept files (`quick-start.mdx`, `index.mdx`, `your-first-kernel.mdx`, `using-middleware.mdx`, `custom-kernel.mdx`, `error-handling.mdx`, `api/types.mdx`, `api/client.mdx`) use `client.export(format, input)` (Promise) instead of `client.on('geometry', ...)` (event). Event-based usage is documented exclusively in the new `guides/live-rendering.mdx`.

**Severity**: P1 — Forces stream consumer mental model on one-shot consumer.

`client.on('geometry', handler)` is an autonomous-stream API: it makes sense for a UI viewer that needs to re-render whenever parameters change, files mutate, or the user toggles options. In a quickstart that performs a single render and immediately calls `terminate()`, the subscription has no second tick to deliver. Cleanup (`unsubscribe()`) is added defensively but conveys nothing about the model's render result.

Library-API policy (`docs/policy/library-api-policy.md` §"Events vs Promises"): events are for streams, promises are for one-shots. The quickstart violates this by using events for what is provably a one-shot operation.

### Finding 5: `RenderSettlement.superseded` check is dead code in a script — RESOLVED

**Status**: RESOLVED — `RenderSettlement.superseded` coverage moved to `guides/live-rendering.mdx` (where slider-drag scenarios make supersession a live, observable branch). Single-shot snippets no longer mention it.

**Severity**: P1 — Documents a state that cannot occur in the demonstrated flow.

```typescript
const settlement = await client.openFile({ code, file: 'main.ts' });
if (settlement.superseded) {
  // A newer command took ownership before this settled
}
```

For `superseded` to be `true`, the consumer must have issued a _second_ `openFile`/`updateParameters`/`setOptions` call before the first settled. The quickstart issues exactly one such call, then terminates. The branch is unreachable. Documenting unreachable error states in a quickstart trains the reader that they need to handle them — every time, in every script. This is the textbook "ceremony tax" anti-pattern from the library-API policy.

### Finding 6: `index.mdx` landing snippet still gates one-shot export on explicit `connect` — RESOLVED

**Status**: RESOLVED — `apps/ui/content/docs/(runtime)/index.mdx` hero snippet drops the explicit `client.connect({ fileSystem: fromMemoryFS() })` line; auto-provisioning carries the `code:` input.

**Severity**: P1 — Same defect as the quickstart, on a higher-traffic page.

```typescript
// apps/ui/content/docs/(runtime)/index.mdx:14-15 (working copy)
const client = createRuntimeClient(presets.all());
await client.connect({ fileSystem: fromMemoryFS() });

const result = await client.export('step', {
  code: { 'box.ts': '...' },
  file: 'box.ts',
});
```

Same `code:` input that auto-provisions a filesystem inside `openFile`/`export`. The explicit `connect` is unnecessary for this snippet and adds two tokens of vocabulary (`connect`, `fromMemoryFS`) to the first impression of the package.

**Sources**: `apps/ui/content/docs/(runtime)/index.mdx:11–30`.

### Finding 7: `your-first-kernel.mdx` requires `@ts-nocheck` to compile — RESOLVED

**Status**: RESOLVED — All `@ts-nocheck` directives removed from `your-first-kernel.mdx`. Steps 3–5 collapsed into self-contained `client.export(format, { code, file, parameters })` snippets that type-check end-to-end.

**Severity**: P2 — Symptom of an over-constrained demo flow, not a doc-only issue.

````mdx
// apps/ui/content/docs/(runtime)/getting-started/your-first-kernel.mdx:78

```typescript @ts-nocheck
await client.connect({ fileSystem });
```
````

````

The `@ts-nocheck` directive disables JSDoc codeblock type-checking (per the JSDoc policy) because the snippet references a `fileSystem` variable that is not declared in the previous step. This is a structural smell — the doc is splitting `connect` and `openFile` across steps in a way the type system rejects, requiring an escape hatch. The escape hatch is in turn invisible to the reader, who copy-pastes a snippet that no longer type-checks once assembled. Restoring the `client.export(format, input)` form (Finding 3) eliminates the escape hatch entirely.

**Sources**: `apps/ui/content/docs/(runtime)/getting-started/your-first-kernel.mdx:78, 115, 130, 146`.

### Finding 8: Doc pass spread across 15 files, all mirroring the same regression — RESOLVED

**Status**: RESOLVED — Sweep complete. `using-middleware.mdx`, `custom-kernel.mdx`, `error-handling.mdx`, `api/types.mdx`, `api/client.mdx`, `concepts/architecture.mdx`, `concepts/render-lifecycle.mdx` all now lead with `client.export` for single-shot demos and cross-link to the new `guides/live-rendering.mdx` and `guides/embedding-in-a-host.mdx`. `api/client.mdx` gained a "When do I need `connect()`?" subsection. Nav (`meta.json`) registers both new guides.

**Severity**: P2 — Cleanup scope is wider than the quickstart.

```text
apps/ui/content/docs/(runtime)/api/client.mdx                          | +77/-25
apps/ui/content/docs/(runtime)/api/types.mdx                           | +12/-4
apps/ui/content/docs/(runtime)/concepts/architecture.mdx               | +28/-14
apps/ui/content/docs/(runtime)/concepts/interactive-architecture.mdx   | +5/-3
apps/ui/content/docs/(runtime)/concepts/kernel-selection.mdx           | +5/-3
apps/ui/content/docs/(runtime)/concepts/render-lifecycle.mdx           | +14/-8
apps/ui/content/docs/(runtime)/concepts/worker-model.mdx               | +22/-13
apps/ui/content/docs/(runtime)/getting-started/quick-start.mdx         | +18/-9
apps/ui/content/docs/(runtime)/getting-started/your-first-kernel.mdx   | +25/-13
apps/ui/content/docs/(runtime)/guides/custom-kernel.mdx                | +6/-4
apps/ui/content/docs/(runtime)/guides/custom-middleware.mdx            | +4/-3
apps/ui/content/docs/(runtime)/guides/error-handling.mdx               | +73/-42
apps/ui/content/docs/(runtime)/guides/using-middleware.mdx             | +8/-8
apps/ui/content/docs/(runtime)/index.mdx                               | +5/-2
````

Every page that ships a snippet now begins with the same explicit `connect({ fileSystem })` ceremony. This is a uniform pattern that needs a uniform reversal: the `code:` form should land first, with `connect()` reserved for the (single) doc page that explains production wiring (port-based bridges, externally-allocated SABs).

**Sources**: `git diff --stat apps/ui/content/docs`.

### Finding 9: Library-API policy alignment — RESOLVED

**Status**: RESOLVED — All four ❌ rows in the policy heuristics table now pass: factory does the right thing by default (auto-connect for inline `code:`), promises for one-shots (`client.export`), narrow defaults / wide opt-in (autonomous loop available but not the default demo), `@ts-nocheck` removed from quickstart and your-first-kernel. Locked down by `validate-quickstart-budget.ts`.

**Severity**: P0 — Restoring the policy-aligned shape is the same change as Findings 1, 3, 6.

| Policy heuristic                                  | Pre-v5 quickstart | v5 quickstart (working copy)  | One-shot `export` recipe (proposed) |
| ------------------------------------------------- | ----------------- | ----------------------------- | ----------------------------------- |
| Factory does the right thing by default           | ✅                | ❌ (requires `connect`)       | ✅                                  |
| Promises for one-shots, events for streams        | ✅                | ❌ (event for one-shot)       | ✅                                  |
| Narrow defaults, wide opt-in                      | ✅                | ❌                            | ✅                                  |
| Errors over silent fallbacks                      | ✅                | ✅                            | ✅                                  |
| Surface area scales with consumer ambition        | ✅                | ❌ (dead `superseded` branch) | ✅                                  |
| Documented snippets compile without `@ts-nocheck` | ✅                | ❌                            | ✅                                  |

All four ❌ rows collapse under a single recommendation: switch the inline-`code:` snippets back to `client.export(format, input)` and remove the explicit `connect` from npm-consumer pages.

**Sources**: `docs/policy/library-api-policy.md`.

## Recommendations

| #   | Action                                                                                                                                                                        | Priority | Effort | Impact | Status      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ | ----------- |
| R1  | Rewrite `quick-start.mdx` primary snippet to use `client.export('glb', { code, file })`. Drop `fromMemoryFS`, `connect`, `on('geometry')`, `unsubscribe`, `superseded`.       | P0       | Low    | High   | ✅ RESOLVED |
| R2  | Rewrite `index.mdx` landing snippet to drop the explicit `client.connect({ fileSystem: fromMemoryFS() })` line. The `code:` input self-provisions.                            | P0       | Low    | High   | ✅ RESOLVED |
| R3  | Rewrite `your-first-kernel.mdx` Step 3 to use a single `client.export('step', { code, file, parameters })` call. Remove all `@ts-nocheck` directives in the file.             | P0       | Low    | High   | ✅ RESOLVED |
| R4  | Document the auto-connect contract for `code:` input as a `@public` JSDoc invariant on `RuntimeClient.openFile`/`export` so consumers can rely on it.                         | P1       | Low    | Medium | ✅ RESOLVED |
| R5  | Move `client.on('geometry', ...)` + `RenderSettlement` + autonomous-loop coverage into a dedicated `guides/live-rendering.mdx` page (or a section of `render-lifecycle.mdx`). | P1       | Medium | Medium | ✅ RESOLVED |
| R6  | Move `connect({ port })` and externally-allocated `filePoolBuffer` coverage into `guides/embedding-in-a-host.mdx` (UI-application wiring), not the quickstart.                | P1       | Medium | Medium | ✅ RESOLVED |
| R7  | Add a "When do I need `connect()`?" subsection to `api/client.mdx` enumerating the three cases (port-based bridge, file-mode without `code:`, deferred FS attachment).        | P1       | Low    | Medium | ✅ RESOLVED |
| R8  | Sweep the remaining 12 doc files (Finding 8) for the same ceremony — replace explicit `connect` with one-shot `export` wherever the snippet is a single-shot script.          | P1       | Medium | Medium | ✅ RESOLVED |
| R9  | Add a frozen-snippet doctest (`pnpm docs:validate` extension or vitest) that pins the quickstart at ≤15 lines and ≤3 imports — a regression budget.                           | P2       | Medium | Medium | ✅ RESOLVED |

## Trade-offs

| Concern                                                     | Pre-v5 (`client.render`) | v5 working copy (`connect` + `openFile` + event) | Proposed (`client.export(format, input)`)   |
| ----------------------------------------------------------- | ------------------------ | ------------------------------------------------ | ------------------------------------------- |
| Lines in quickstart                                         | 13                       | 22                                               | ~12                                         |
| Surfaces autonomous re-rendering                            | ❌                       | ✅                                               | ❌ (covered in dedicated guide instead)     |
| Surfaces supersession                                       | ❌                       | ✅ (dead branch)                                 | ❌ (covered in dedicated guide)             |
| Surfaces error handling                                     | ✅ (`result.success`)    | ✅ (`on('geometry')` + lifecycle errors)         | ✅ (`result.success` on `ExportResult`)     |
| Surfaces `RenderTimeoutError` / `RuntimeTerminatedError`    | ❌                       | ✅                                               | ❌ (covered in `guides/error-handling.mdx`) |
| Compiles without `@ts-nocheck`                              | ✅                       | ❌                                               | ✅                                          |
| Forces consumer to learn `MessagePort` / FS bridge concepts | ❌                       | ❌ (but ships the vocabulary)                    | ❌                                          |
| Tells the reader "you can render and get bytes in 5 lines"  | ✅                       | ❌                                               | ✅                                          |
| Production wiring path remains documented                   | ✅                       | ✅                                               | ✅ (in dedicated guide, R6)                 |

The v5 lifecycle primitives are not removed by any recommendation — they remain available for consumers who need them. The proposal only changes which path the docs _demonstrate first_.

## Code Examples

### Proposed `quick-start.mdx` primary snippet (R1)

```typescript
import { createRuntimeClient, presets } from '@taucad/runtime';

const client = createRuntimeClient(presets.all());

const result = await client.export('glb', {
  code: {
    'main.ts': `
      import { drawRoundedRectangle } from 'replicad';
      export default function main() {
        return drawRoundedRectangle(30, 50, 5).sketchOnPlane('XY').extrude(10);
      }
    `,
  },
  file: 'main.ts',
});

if (result.success) {
  console.log(`Exported ${result.data.bytes.byteLength} bytes (${result.data.mimeType})`);
} else {
  console.error('Export failed:', result.issues);
}

client.terminate();
```

11 lines of code, 2 imports, 0 lifecycle ceremony. The `presets.all()` factory + the `code:` input + the one-shot `export(format, input)` overload do all the work.

### Proposed `index.mdx` landing snippet (R2)

```typescript
import { createRuntimeClient, presets } from '@taucad/runtime';

const client = createRuntimeClient(presets.all());

const result = await client.export('step', {
  code: {
    'box.ts': `
      import { makeBaseBox } from 'replicad';
      export default function main() {
        return makeBaseBox(10, 20, 30);
      }
    `,
  },
  file: 'box.ts',
});

// result.data -> { name: 'box.step', bytes: Uint8Array, mimeType: 'model/step' }
```

### Proposed `your-first-kernel.mdx` Step 3 (R3)

```typescript
const result = await client.export('glb', {
  code: { 'main.ts': modelCode },
  file: 'main.ts',
  parameters: { width: 50, depth: 15 },
});

if (result.success) {
  console.log(`Rendered ${result.data.bytes.byteLength} bytes (${result.data.mimeType})`);
} else {
  for (const issue of result.issues) {
    console.error(`[${issue.severity}] ${issue.message}`);
  }
}
```

No `@ts-nocheck`. No `client.connect({ fileSystem })`. No `client.on('geometry', handler)`. The Step 4 STEP-export snippet then either becomes a second `client.export('step', { code, file, parameters })` call (re-running with a different format) or — if the doc wants to demonstrate render-state reuse — re-introduces `openFile` + `export(format)` as an "advanced: reuse render context" callout.

### When `client.connect()` _is_ needed (proposed `api/client.mdx` callout, R7)

```typescript
// Case 1: Port-based bridge (UI host owns the FS worker)
const port = await openFileManagerPort();
await client.connect({ port });

// Case 2: File-mode rendering against an externally supplied FS
await client.connect({ fileSystem });
await client.openFile({ file: '/projects/my-project/main.ts' });

// Case 3: Deferred FS attachment (FS becomes available later in the host's lifecycle)
const client = createRuntimeClient(options);
// ... later, once FS is ready ...
await client.connect({ fileSystem });
```

For inline-`code:` input the consumer never reaches any of these cases — the runtime auto-provisions an in-memory FS on first call.

## References

- Policy: `docs/policy/library-api-policy.md`
- Blueprint: `docs/research/runtime-event-driven-api-blueprint-v5.md` (Findings 14, 18)
- Implementation: `packages/runtime/src/client/runtime-client.ts:1087–1196`
- Working-copy diffs: `git diff apps/ui/content/docs/(runtime)`
- Filesystem gap-analysis (template precedent): `docs/research/filesystem-gap-analysis.md`

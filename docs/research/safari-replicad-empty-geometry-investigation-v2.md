---
title: 'Safari Replicad Empty Geometry — Smoking Gun (v2)'
description: 'Refined root-cause investigation: the empty success comes from a third silent path in onCreateGeometry, surfaced by a swallowed throw in selectKernel that hides initOpenCascade failures on Safari.'
status: active
created: '2026-04-20'
updated: '2026-04-20'
category: investigation
related:
  - docs/research/safari-replicad-empty-geometry-investigation.md
  - docs/research/staging-cors-coep-safari-rendering-audit.md
  - docs/research/replicad-occt-normal-pipeline-v3.md
---

# Safari Replicad Empty Geometry — Smoking Gun (v2)

A second-pass investigation, after applying R1+R2 from `safari-replicad-empty-geometry-investigation.md` failed to surface a kernel-side warning in Safari. The new logs prove the empty result comes from a third, previously unidentified, code path.

## Executive Summary

Applying R1 (`console.warn` in `cad.machine.ts` for empty success) and R2 (`runtime.logger.warn` in `replicad.kernel.ts` for the two known empty-success paths) made R1 fire in Safari but **R2 never fired**. The reason is now clear: in Safari, the kernel's own `createGeometry` is **never called**. The empty-success result originates from a third, completely silent short-circuit in `KernelRuntimeWorker.onCreateGeometry()` (`packages/runtime/src/framework/kernel-runtime-worker.ts:138-141`):

```ts
const kernel = await this.ensureActiveKernel(input.filePath, runtime);
if (!kernel) {
  return { success: true, data: [], issues: [] };
}
```

`ensureActiveKernel` returns `undefined` because `selectKernel()` returns `undefined`. `selectKernel()` returns `undefined` because **both Pass 1 (extension/regex) and Pass 2 (bundler-detect) silently swallow exceptions in `} catch {` blocks**, and the only thing that throws inside those passes is `ensureKernelInitialized()` → `replicad.initialize()` → `initOpenCascade()`. The "Initializing kernel: replicad" log fires four times in Safari (twice per `selectKernel` call: Pass 1 and Pass 2; called twice from `getParameters` + `createGeometry`) precisely because **each attempt throws inside `initOpenCascade()` and resets `kernel.initialized` back to `false`** for the next attempt. Replicad's `Loading default font` and `Replicad kernel initialized` logs never appear, confirming the throw happens at or before line 358 of `replicad.kernel.ts` (the `replicad.setOC(openCascade)` call after `initOpenCascade` resolves).

The user-visible failure (blank Safari viewport) is downstream collateral; the **smoking gun is a swallowed-throw observability hole** that masks the real Safari WASM init failure.

## Table of Contents

- [Executive Summary](#executive-summary)
- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: R2 warn never fires because kernel.createGeometry is never called](#finding-1-r2-warn-never-fires-because-kernelcreategeometry-is-never-called)
  - [Finding 2: A third silent empty-success path lives in onCreateGeometry](#finding-2-a-third-silent-empty-success-path-lives-in-oncreategeometry)
  - [Finding 3: Two `} catch {` blocks in selectKernel hide the real Safari error](#finding-3-two--catch--blocks-in-selectkernel-hide-the-real-safari-error)
  - [Finding 4: Four "Initializing kernel: replicad" lines map exactly to 2 calls × 2 passes](#finding-4-four-initializing-kernel-replicad-lines-map-exactly-to-2-calls--2-passes)
  - [Finding 5: ensureKernelInitialized is not single-flight, amplifying the storm](#finding-5-ensurekernelinitialized-is-not-single-flight-amplifying-the-storm)
  - [Finding 6: initOpenCascade silences print/printErr by default](#finding-6-initopencascade-silences-printprinterr-by-default)
  - [Finding 7: Auto-render flushLogs gap is real but is not the root cause](#finding-7-auto-render-flushlogs-gap-is-real-but-is-not-the-root-cause)
- [Root Cause Decision Tree](#root-cause-decision-tree)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

After applying R1 and R2 from `safari-replicad-empty-geometry-investigation.md`:

1. **R1 in `cad.machine.ts`** — `console.log` swapped for `console.warn` when `result.success && result.data.length === 0`, with `issuesLength` and `firstIssue.message` in the payload. **Fired correctly in Safari**: `[Warning] [CadMachine] geometry event received – {success: true, dataLength: 0, issuesLength: 0, firstIssue: undefined}`.
2. **R2 in `replicad.kernel.ts`** — `runtime.logger.warn` at the two known empty paths in `createGeometry` (`shapes === undefined` → `'main-returned-undefined'`; `shapes3d.length === 0 && shapes2d.length === 0` → `'render-output-filtered-empty'`). **Did not fire in Safari**.

Chrome continued to work correctly: `dataLength: 1`, `nodeCount=1`, `byteLength=14520`, `Cached 1 geometries`. Safari rendered a blank viewport.

The contradiction — empty success with zero issues, no R2 warning, but also no error — proves the empty result originates **outside** of `replicad.kernel.ts:createGeometry`. We needed to find which code path returns `{ success: true, data: [], issues: [] }` without invoking `kernel.definition.createGeometry`.

## Methodology

1. **Side-by-side log diff** of Safari vs Chrome traces (provided by the user).
2. **Static trace** of `kernel-worker.ts` → `kernel-runtime-worker.ts` from the cached `setFile` → `handleSetFile` → auto-render path that currently misses an explicit `flushLogs()`.
3. **Search for all early returns** in the createGeometry pipeline that produce `{ success: true, data: [] }` without invoking `kernel.definition.createGeometry`.
4. **Cross-check** that the previously identified two empty-success paths (`replicad.kernel.ts:478, 518`) are the only ones in replicad — confirming any third path must live in framework code above the kernel.
5. **Audit** `selectKernel` and `ensureKernelInitialized` for swallowed throws and re-entry behaviour, since the four-fold "Initializing kernel: replicad" repetition is a classic non-idempotent-init signature.

## Findings

### Finding 1: R2 warn never fires because kernel.createGeometry is never called

The new Safari trace shows:

```
[Warning] [CadMachine] geometry event received – {success: true, dataLength: 0, issuesLength: 0, firstIssue: undefined}
[Log]     [CadMachine] setGeometries – {count: 0, file: "main.ts"}
[Debug]   [Kernel:worker] – "Initializing kernel: replicad"
[Debug]   [Kernel:worker] – "Initializing OpenCASCADE WASM (ocTracing: summary, wasm: single)"
[Debug]   [Kernel:worker] – "createGeometry completed" – {ms: 318.44}
```

`createGeometry completed` is logged at `packages/runtime/src/framework/kernel-worker.ts:890`. Both R2 warnings live inside `replicad.kernel.ts:createGeometry` — which is invoked by `KernelRuntimeWorker.onCreateGeometry` at `packages/runtime/src/framework/kernel-runtime-worker.ts:150`. Their **mutual silence proves we never reached line 150**.

### Finding 2: A third silent empty-success path lives in onCreateGeometry

`packages/runtime/src/framework/kernel-runtime-worker.ts:134-141`:

```ts
protected override async onCreateGeometry(
  input: CreateGeometryInput,
  runtime: KernelRuntime,
): Promise<CreateGeometryResult> {
  const kernel = await this.ensureActiveKernel(input.filePath, runtime);
  if (!kernel) {
    return { success: true, data: [], issues: [] };
  }
  // ... kernel.definition.createGeometry(...) ...
}
```

This is the **third** code path that returns `{ success: true, data: [], issues: [] }`. It was missed by the v1 investigation because it lives in framework code, not in the replicad kernel. It produces an empty success silently — no `runtime.logger.warn`, no issue, no telemetry. R1's `[CadMachine] geometry event received {dataLength: 0, issuesLength: 0}` is the **only** symptom on the wire.

| Path                        | File                           | Line    | `runtime.logger.warn`? | Issue emitted?        |
| --------------------------- | ------------------------------ | ------- | ---------------------- | --------------------- |
| `shapes === undefined` (R2) | `replicad.kernel.ts`           | 478     | YES (R2)               | YES (`info` severity) |
| `renderOutput → empty` (R2) | `replicad.kernel.ts`           | 518     | YES (R2)               | NO                    |
| **`!kernel` short-circuit** | **`kernel-runtime-worker.ts`** | **140** | **NO**                 | **NO**                |

### Finding 3: Two `} catch {` blocks in selectKernel hide the real Safari error

`packages/runtime/src/framework/kernel-runtime-worker.ts:397-413` — Pass 1 (extension/regex):

```ts
try {
  // ...
  const code = await runtime.filesystem.readFile(filePath, 'utf8');
  // ...
  if (matched) {
    const kernel = await this.loadKernelModule(config, runtime.tracer);
    await this.ensureKernelInitialized(kernel, runtime); // ← throws here in Safari
    // ...
    return { kernel, method: 'regex' };
  }
} catch {
  continue; // ← swallows the error, no log, no issue, no telemetry
}
```

`packages/runtime/src/framework/kernel-runtime-worker.ts:425-462` — Pass 2 (bundler-detect):

```ts
try {
  // ...
  const primaryKernel = await this.loadKernelModule(primaryConfig, runtime.tracer);
  await this.ensureKernelInitialized(primaryKernel, runtime); // ← throws here too
  // ...
  return { kernel: primaryKernel, method: 'bundler' };
} catch {
  // Bundler detection failed — fall through to catch-all
}
```

Both `} catch {` blocks discard the `error` binding entirely. There is no `logger.warn`, no `console.error`, no telemetry span attribute. Any throw inside `ensureKernelInitialized` is structurally invisible to every downstream consumer.

When both passes fail and Pass 3's catch-all entry is `undefined`, `selectKernel()` returns `undefined`, `ensureActiveKernel()` returns `undefined`, and `onCreateGeometry()` returns the empty success. **End to end, an `initOpenCascade` throw on Safari produces a successful-looking, fully-empty geometry result with zero diagnostic output.**

### Finding 4: Four "Initializing kernel: replicad" lines map exactly to 2 calls × 2 passes

The v1 investigation tentatively attributed the 4× repetition to "2 workers × 2 kernel modules". The new evidence falsifies that: there is only **one** `Loaded transcoder: converter` and **one** `Loading kernel module: replicad`. If two workers were active, both top-level lines would also appear twice.

The correct accounting is one worker per `cad.machine`, one selectKernel invocation per `getParameters` and per `createGeometry` (= 2 calls), and within each call **both Pass 1 and Pass 2 attempt `ensureKernelInitialized`**, because Pass 1's swallowed throw forces Pass 2 to retry the same operation:

| Trigger          | Pass                | "Initializing kernel: replicad" log |
| ---------------- | ------------------- | ----------------------------------- |
| `getParameters`  | 1 (extension/regex) | #1                                  |
| `getParameters`  | 2 (bundler-detect)  | #2                                  |
| `createGeometry` | 1 (extension/regex) | #3                                  |
| `createGeometry` | 2 (bundler-detect)  | #4                                  |

Total: 4. This matches exactly what the user observed in Safari and explains why Chrome shows only 1 (Chrome's `initOpenCascade` returns successfully, Pass 1 sets `kernel.initialized = true`, all later calls early-return at `if (kernel.initialized) return;`).

### Finding 5: ensureKernelInitialized is not single-flight, amplifying the storm

`packages/runtime/src/framework/kernel-runtime-worker.ts:327-341`:

```ts
private async ensureKernelInitialized(kernel: LoadedKernel, runtime: KernelRuntime): Promise<void> {
  if (kernel.initialized) {
    return;
  }
  this.logger.trace(`Initializing kernel: ${kernel.entry.id}`);
  // ...
  kernel.ctx = await kernel.definition.initialize(validatedOptions, runtime);
  kernel.initialized = true;
}
```

`kernel.initialized = true` is set **after** the async `initialize()` resolves. Two concurrent callers both observe `initialized: false` and both start a fresh `initialize()`. There is no in-flight promise cache (`kernel.initPromise ??= ...` style) to deduplicate them.

This is not the primary bug here (the throw forces a retry storm anyway), but it amplifies the failure mode: each retry costs a fresh WASM compile, a fresh font fetch, fresh source-map load, and a fresh OC instance write via `replicad.setOC(...)` that races with any previously-completed init's OC handle. Even on Chrome, two concurrent renders of two different files could thrash the global OC singleton in `replicad`.

### Finding 6: initOpenCascade silences print/printErr by default

`packages/runtime/src/kernels/replicad/init-open-cascade.ts:66-67`:

```ts
print: options?.print ?? noop,
printErr: options?.printErr ?? noop,
```

`replicad.kernel.ts:initialize` calls `initOpenCascade(resolved.wasmUrl, resolved.bindingsFactory, { tracer })` with no `print`/`printErr`. Emscripten's stderr is therefore silenced. Whatever WASM-level error message is printed during a Safari-specific instantiation failure (link errors, missing imports, exception-table mismatches) is dropped on the floor before our `try/catch` can see it.

This is the **second** observability hole. Even after R2/R3 (logging the swallowed throws) is applied, the throw itself may be a generic `Error: WebAssembly.instantiate(): ...` whose root cause was printed-then-discarded by Emscripten.

### Finding 7: Auto-render flushLogs gap is real but is not the root cause

`runtime-worker-dispatcher.ts:203-228` (the `render` command path) explicitly calls `flushLogs()` and `worker.flushTelemetry()` before responding. The `setFile` command at `runtime-worker-dispatcher.ts:230-233` is fire-and-forget (`worker.handleSetFile(...)`) and does **not** call `flushLogs()`. Auto-render geometry events fire via `worker.onGeometryComputed` (a direct `respond({ type: 'geometryComputed', ... })`) and bypass `flushLogs()` entirely.

This is a real bug — it is why the apparent ordering of `[CadMachine] geometry event received` vs `[Kernel:worker] createGeometry completed` is inverted in both Safari and Chrome traces — but it is **not** the smoking gun. Even if every log were flushed instantly, the swallowed throws in `selectKernel` would still produce zero diagnostic output. Fixing the flush gap (R6 below) is necessary for correct ordering in future investigations but does not change the empty-success symptom.

## Root Cause Decision Tree

```
Safari render → empty viewport
└─ cad.machine logs `dataLength: 0, issuesLength: 0`
   └─ Empty-success origin: which of 3 paths?
      ├─ replicad:478 (`shapes === undefined`)        → R2 warn would fire — DID NOT
      ├─ replicad:518 (`renderOutput filtered empty`) → R2 warn would fire — DID NOT
      └─ kernel-runtime-worker:140 (`!kernel`)        → no warn, no issue ✓ MATCH
         └─ Why is `kernel` undefined?
            └─ `selectKernel()` returned undefined
               ├─ Pass 1 (regex): caught + swallowed by `} catch {`
               ├─ Pass 2 (bundler): caught + swallowed by `} catch {`
               └─ Pass 3 (catch-all): no catch-all entry registered
                  └─ Why did Pass 1 + Pass 2 throw?
                     └─ `ensureKernelInitialized` threw
                        └─ `replicad.initialize()` threw
                           └─ `initOpenCascade()` threw or hung
                              ├─ Reached "Initializing OpenCASCADE WASM" log ✓
                              ├─ Did NOT reach "Loading default font" ✗
                              ├─ Did NOT reach "Replicad kernel initialized" ✗
                              └─ Real cause: WASM-level (Safari)
                                 ├─ Possible: WebAssembly.instantiate failure
                                 ├─ Possible: -fwasm-exceptions edge case
                                 ├─ Possible: import object mismatch
                                 └─ Whatever it is, Emscripten printed it to
                                    stderr — we discarded it via `printErr: noop`
```

## Recommendations

| #   | Action                                                                                                                                                                                                          | Priority | Effort | Impact   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------- |
| R1  | **Add `runtime.logger.warn` to the `!kernel` short-circuit** in `KernelRuntimeWorker.onCreateGeometry` (line 140). Mirror R2's pattern: include `filePath` and the operation name (`'kernel-not-selected'`).    | P0       | XS     | High     |
| R2  | **Replace `} catch {` with `} catch (error) { logger.warn('selectKernel pass 1 (extension/regex) failed', { error: ..., kernel: config.id, file: filePath }); continue; }`** in `selectKernel` Pass 1.          | P0       | XS     | Critical |
| R3  | **Same treatment for Pass 2** (bundler-detect) — capture the error, log a structured warning that names the bundler and matched configs, then fall through to the catch-all.                                    | P0       | XS     | Critical |
| R4  | **Wire `printErr` (and ideally `print` at trace level) through `initOpenCascade`** so Emscripten/WASM-level diagnostics reach the runtime logger. Default callback can route to `runtime.logger.error`/`trace`. | P0       | S      | High     |
| R5  | **Make `ensureKernelInitialized` single-flight** via an `initPromise` cache on `LoadedKernel`. Concurrent callers await the same promise; failures clear the cache so a manual retry can recover.               | P1       | S      | Medium   |
| R6  | **Add `flushLogs()` + `flushTelemetry()` to the auto-render path** (in `KernelWorker.handleSetFile` / wherever `onGeometryComputed` fires for fire-and-forget renders).                                         | P1       | XS     | Medium   |
| R7  | Once R2-R4 are in place, **re-run Safari and capture the structured error**. The expected output is a `WebAssembly.LinkError` or `Error: ...` whose message will localise the Safari WASM regression.           | P0       | XS     | Critical |
| R8  | After R7 confirms the WASM-side cause, **add a Safari-specific WASM compatibility test** to `packages/runtime` that compiles `replicad_single.wasm` in jsdom-with-WASM (or via a headless Safari fixture).      | P2       | M      | Medium   |
| R9  | **Audit every other `} catch { continue; }` / `} catch { /* ... */ }` block** in `packages/runtime/src/framework/` for the same empty-binding-discard antipattern. Add a custom oxlint rule if practical.       | P1       | S      | High     |
| R10 | Once R1 lands, **upgrade the existing R1 in `cad.machine.ts` to render a user-visible "Kernel failed to initialize" toast / placeholder** when the empty-success carries a `kernel-not-selected` provenance.    | P2       | S      | Medium   |

## Code Examples

### R1 — Surface the third silent path

`packages/runtime/src/framework/kernel-runtime-worker.ts`:

```typescript
protected override async onCreateGeometry(
  input: CreateGeometryInput,
  runtime: KernelRuntime,
): Promise<CreateGeometryResult> {
  const kernel = await this.ensureActiveKernel(input.filePath, runtime);
  if (!kernel) {
    runtime.logger.warn('createGeometry returning empty: kernel-not-selected', {
      data: { filePath: input.filePath, loadedKernels: [...this.loadedKernels.keys()] },
    });
    return { success: true, data: [], issues: [] };
  }
  // ... existing code ...
}
```

### R2 + R3 — Stop swallowing throws in selectKernel

```typescript
// Pass 1 (extension/regex)
try {
  // ... existing code ...
} catch (error) {
  runtime.logger.warn('selectKernel pass 1 (extension/regex) failed', {
    data: { kernel: config.id, file: filePath, error: String(error) },
  });
  continue;
}

// Pass 2 (bundler-detect)
try {
  // ... existing code ...
} catch (error) {
  runtime.logger.warn('selectKernel pass 2 (bundler-detect) failed', {
    data: {
      file: filePath,
      configs: configsWithBuiltins.map((c) => c.id),
      error: String(error),
    },
  });
  // Fall through to catch-all
}
```

### R4 — Wire Emscripten print/printErr through to logger

`packages/runtime/src/kernels/replicad/replicad.kernel.ts`:

```typescript
const resolved = await resolveWasm(wasm, tracer);
let openCascade = await initOpenCascade(resolved.wasmUrl, resolved.bindingsFactory, {
  tracer,
  print: (text) => logger.trace('OCJS stdout', { data: { text } }),
  printErr: (text) => logger.warn('OCJS stderr', { data: { text } }),
});
```

### R5 — Single-flight ensureKernelInitialized

```typescript
type LoadedKernel = {
  // ... existing fields ...
  initPromise?: Promise<void>;
};

private async ensureKernelInitialized(kernel: LoadedKernel, runtime: KernelRuntime): Promise<void> {
  if (kernel.initialized) return;
  if (kernel.initPromise) return kernel.initPromise;

  kernel.initPromise = (async () => {
    this.logger.trace(`Initializing kernel: ${kernel.entry.id}`);
    const rawOptions = kernel.entry.options ?? {};
    const validatedOptions = kernel.definition.optionsSchema
      ? kernel.definition.optionsSchema.parse(rawOptions)
      : rawOptions;
    try {
      kernel.ctx = await kernel.definition.initialize(validatedOptions, runtime);
      kernel.initialized = true;
    } finally {
      // Allow retry on failure; clear only the cache, not the `initialized` flag
      if (!kernel.initialized) kernel.initPromise = undefined;
    }
  })();

  return kernel.initPromise;
}
```

## Diagrams

### Empty-success origins (all three known)

```
                       ┌──────────────────────────────────┐
                       │  cad.machine: dataLength === 0   │
                       │  issuesLength === 0              │
                       └────────────────┬─────────────────┘
                                        │
                ┌───────────────────────┼────────────────────────┐
                │                       │                        │
                ▼                       ▼                        ▼
   ┌─────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
   │ replicad:478        │  │ replicad:518         │  │ kernel-runtime-      │
   │ shapes===undefined  │  │ renderOutput empty   │  │ worker:140           │
   │ R2 warn: ✓          │  │ R2 warn: ✓           │  │ !kernel short-circ.  │
   │ Issue: info severity│  │ No issue             │  │ NO WARN, NO ISSUE    │
   └─────────────────────┘  └──────────────────────┘  │ ← THIS IS SAFARI'S   │
                                                      │   PATH               │
                                                      └──────────┬───────────┘
                                                                 │
                                                                 ▼
                                          ┌──────────────────────────────────────┐
                                          │ selectKernel returned undefined      │
                                          │ Pass 1: } catch { continue; }        │
                                          │ Pass 2: } catch { /* fall thru */ }  │
                                          │ Pass 3: catchAllEntry undefined      │
                                          └──────────────────┬───────────────────┘
                                                             │
                                                             ▼
                                          ┌──────────────────────────────────────┐
                                          │ ensureKernelInitialized threw        │
                                          │ → replicad.initialize() threw        │
                                          │ → initOpenCascade() threw            │
                                          │   (between "Initializing OCJS WASM"  │
                                          │   and "Loading default font")        │
                                          │   Real WASM error printed to stderr  │
                                          │   then discarded by `printErr: noop` │
                                          └──────────────────────────────────────┘
```

### Why Safari sees 4 init logs and Chrome sees 1

```
Chrome:
  getParameters → selectKernel
                     └─ Pass 1: ensureKernelInitialized → init succeeds → set initialized=true
                                                          ↓
                                                       LOG #1
                     ← return
  createGeometry → selectKernel → activeKernelId already cached → no Pass 1 needed
                                                                ↓
                                                          (no log: cache hit)

Safari:
  getParameters → selectKernel
                     └─ Pass 1: ensureKernelInitialized → init throws → swallowed
                     │                                    ↓
                     │                                 LOG #1
                     └─ Pass 2: ensureKernelInitialized → init throws → swallowed
                                                          ↓
                                                       LOG #2
                     ← return undefined
  createGeometry → selectKernel
                     └─ Pass 1: ensureKernelInitialized → init throws → swallowed
                     │                                    ↓
                     │                                 LOG #3
                     └─ Pass 2: ensureKernelInitialized → init throws → swallowed
                                                          ↓
                                                       LOG #4
                     ← return undefined
                  → onCreateGeometry returns {success: true, data: [], issues: []}
                                          ↓
                  cad.machine `geometry event received {dataLength: 0}`
```

## References

- `packages/runtime/src/framework/kernel-runtime-worker.ts:138-141` — the third silent empty-success path
- `packages/runtime/src/framework/kernel-runtime-worker.ts:411-413, 460-462` — the two `} catch {}` blocks that hide every Safari-specific throw
- `packages/runtime/src/framework/kernel-runtime-worker.ts:327-341` — non-single-flight `ensureKernelInitialized`
- `packages/runtime/src/kernels/replicad/init-open-cascade.ts:66-67` — `printErr: noop` discards Emscripten stderr
- `packages/runtime/src/framework/runtime-worker-dispatcher.ts:203-228, 230-233` — `flushLogs()` present in explicit `render`, missing in fire-and-forget `setFile`
- v1 investigation: `docs/research/safari-replicad-empty-geometry-investigation.md`
- Prior Safari audit: `docs/research/staging-cors-coep-safari-rendering-audit.md` (R6 diagnostic patch family)

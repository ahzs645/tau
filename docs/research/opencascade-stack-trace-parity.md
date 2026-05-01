---
title: 'OpenCascade Stack-Trace Parity with Replicad'
description: 'Root cause analysis and recommendations for restoring user-source stack frame resolution in OpenCascade kernel errors so the issues panel reports `./main.ts:5:12` instead of `blob:.../<uuid>:4514:16`.'
status: draft
created: '2026-04-23'
updated: '2026-04-23'
category: investigation
---

# OpenCascade Stack-Trace Parity with Replicad

Investigate why OpenCascade kernel errors render with bundled blob-URL frames in the issues panel while Replicad kernel errors render with project-relative source paths, and recommend the minimal fixes needed to bring OpenCascade to parity.

## Executive Summary

Both kernels share the same bundler (`EsbuildBundler`, inline source maps), the same browser execution path (`executeCode` → blob URL + dynamic `import()`), and the same shared OCCT error pipeline (`OcKernelError`, `formatRuntimeErrorWithOc`, `parseStackTrace`). The Replicad kernel **passes the inline source map** from `bundleResult.sourceMap` (and `executeResult.entryUrl`) into its `parseStackTrace` callback, which causes `applySourceMapToFrames` to remap blob-URL frames back to `./main.ts`. The OpenCascade kernel **does not** pass the source map and supplies an identity `applySourceMaps` fn — so the very same machinery is short-circuited and frames stay at engine positions inside the bundle.

**Single concrete fix**: thread `bundleResult.sourceMap` (and `executeResult.entryUrl`) through `formatRuntimeErrorWithOc` in the OpenCascade kernel's `getParameters` and `createGeometry` `catch` blocks, exactly as Replicad's `runMain` already does.

## Problem Statement

User report (with screenshots): a `bad-call.ts` fixture that calls `BRepPrimAPI_MakeBox(0, 0, 0)` from `main()` produces an issue card showing:

```text
KernelError: Mathematical domain error — input is outside the valid domain (Standard_DomainError)
(b4ea1f99-ad09-46e6-8934-e46fb31ed04a:4514:16)

Stack trace:
1 | main (blob:http://localhost:3000/b4ea1f99-ad09-46e6-8934-e46fb31ed04a:4514:16)
  ▸ Show platform internals (9 frames)
```

The blob URL identifies the in-memory bundle (`URL.createObjectURL`) and line 4514 is a valid line **inside the generated bundle**, but the frame should display as `./main.ts:5:7` (or wherever the user's `BRepPrimAPI_MakeBox` call lives in source). Replicad errors do render that way today, so the regression is OpenCascade-specific.

## Methodology

- Read the full Replicad and OpenCascade kernel source (`packages/runtime/src/kernels/replicad/replicad.kernel.ts`, `packages/runtime/src/kernels/opencascade/opencascade.kernel.ts`).
- Read the shared OCCT error pipeline (`packages/runtime/src/kernels/occt/oc-tracing.ts`, `oc-exceptions.ts`, `oc-kernel-error.ts`).
- Read the bundler and execution path (`packages/runtime/src/bundler/esbuild-core.ts`).
- Read the source-map remapper (`packages/runtime/src/framework/error-enrichment.ts`).
- Confirmed the UI does no remapping (`apps/ui/app/routes/projects_.$id/chat-stack-trace.tsx` renders `frame.fileName` verbatim).
- Cross-referenced every call site of `formatRuntimeErrorWithOc` and `parseStackTrace` between the two kernels.

## Findings

### Finding 1: The shared pipeline is symmetric — both kernels share bundler, executor, and OC exception capture

The pipeline up to and including `OcKernelError` construction is **identical** for both kernels:

| Stage                      | Component                                                             | Behavior                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle                     | `EsbuildBundler.bundle` (`esbuild-core.ts:747`)                       | `sourcemap: 'inline'` by default; the `bundleResult.sourceMap` field carries the extracted JSON map for both kernels                                                                                          |
| Execute (browser)          | `executeCode` (`esbuild-core.ts:1095-1134`)                           | `Blob` + `URL.createObjectURL` + dynamic `import(entryUrl)` for both kernels                                                                                                                                  |
| WASM exception capture     | `wrapOcForExceptions` / `wrapOcWithTracing` (`oc-tracing.ts:155-196`) | Catches `WebAssembly.Exception`, builds `OcKernelError`, calls `Error.captureStackTrace(kernelError, rethrowIfWasmException)` so V8's stack starts **above** the wrapper and includes the user's `main` frame |
| Issue assembly entry point | `formatRuntimeErrorWithOc` (`oc-exceptions.ts:251-329`)               | Both kernels invoke this same function from their `catch` blocks                                                                                                                                              |

Critically, the `Error.captureStackTrace` call at `oc-tracing.ts:179` does its job correctly for OpenCascade: when V8 unwinds, the captured `error.stack` does include a frame for the user's `main` function. The frame's `fileName` simply reads `blob:http://.../<uuid>` and the `lineNumber`/`columnNumber` are positions inside the generated bundle. The information needed to translate that back to `./main.ts` is in the inline source map — but only Replicad passes it through.

### Finding 2: `parseStackTrace` already supports source-map remapping; OpenCascade just never feeds it the map

`parseStackTrace` in `error-enrichment.ts:29-73` accepts a `sourceMap` option and forwards it to `applySourceMapToFrames`. That function (`error-enrichment.ts:179-233`) classifies any frame whose `fileName` starts with `blob:` / `data:` / matches `lastEntryName` as a "bundled frame" and runs it through `SourceMapConsumer.originalPositionFor` to recover the original `vfs:main.ts` source path, line, and column.

The Replicad kernel wires this in two places (`replicad.kernel.ts`):

```typescript
function parseError(
  error: unknown,
  options?: { sourceMapJson?: string; projectPath?: string; lastEntryName?: string },
): KernelStackFrame[] {
  return parseStackTrace(error, {
    classifyFrame: frameClassifier,
    sourceMap: options?.sourceMapJson, // ← passed through
    resolveSourcePath: (s) => resolveSourcePath(s, options?.projectPath),
    lastEntryName: options?.lastEntryName, // ← passed through
  });
}
```

```typescript
const mainResult = await runMain<MainResultShapes>({
  module,
  parameters,
  context,
  sourceMapJson: bundleResult.sourceMap, // ← supplied
  projectPath: basePath,
  lastEntryName: executeResult.entryUrl, // ← supplied
});
```

The OpenCascade kernel (`opencascade.kernel.ts:97-101`) deliberately omits both:

```typescript
function parseError(error: unknown, options?: { projectPath?: string }): KernelStackFrame[] {
  return parseStackTrace(error, {
    classifyFrame: frameClassifier,
    resolveSourcePath: (s) => resolveSourcePath(s, options?.projectPath),
    // No sourceMap. No lastEntryName.
  });
}
```

…and the `formatRuntimeErrorWithOc` call sites at `opencascade.kernel.ts:258-264` (`getParameters`) and `347-353` (`createGeometry` `catch`) both supply an identity `applySourceMaps`:

```typescript
const issue = formatRuntimeErrorWithOc({
  error,
  ocInstance: context.oc,
  parseStackTrace: (errorToFormat) => parseError(errorToFormat, { projectPath: basePath }),
  applySourceMaps: (frames) => frames, // ← no-op
  deriveLocation: (frames) => deriveLocation(frames, basePath),
});
```

`deriveLocation` (`opencascade.kernel.ts:104-105`) similarly passes `undefined` as the source map argument, so even the location-extraction step (used to draw the inline editor underline) cannot recover an original line:

```typescript
function deriveLocation(frames: KernelStackFrame[], projectPath?: string): ErrorLocation | undefined {
  return deriveLocationFromFrames(frames, undefined, (s) => resolveSourcePath(s, projectPath));
}
```

### Finding 3: The `applySourceMaps` callback in Replicad is layered on top of the bundle remap

Replicad's `applySourceMaps` (`resolveLibraryFrames`, `replicad.kernel.ts:153-159`) is **not** how user lines get mapped. It is a _secondary_ pass that resolves frames inside the `replicad` npm chunk back to the upstream library's own source map (loaded via `loadReplicadSourceMap` / `withSourceMapping`) and demangles minified function names. User-source mapping for `./main.ts` happens earlier, **inside** `parseStackTrace` via the inline `bundleResult.sourceMap`.

This means OpenCascade does **not** need a Replicad-equivalent library map (there is no upstream `opencascade.js` JS source map shipped today, and the WASM stack frames are already opaque to V8). The fix only needs the user-bundle pass.

### Finding 4: The `executeResult.entryUrl` cache-hit gotcha

`executeCode` (`esbuild-core.ts:1095-1134`) returns `entryUrl` only on a cache miss; cache hits return `{ success: true, value: cached }` without `entryUrl`. This is why `applySourceMapToFrames` is defensive — it matches `blob:` / `data:` URLs by prefix in addition to checking equality with `lastEntryName`. So even when `entryUrl` is `undefined`, the prefix match handles the typical cached-execute case. Passing `lastEntryName` is still useful (covers exotic non-blob URLs in alternative executors) but is not required for the immediate fix.

### Finding 5: Equivalent frame for Replicad vs OpenCascade

For a Replicad user error in `main()` (e.g. `draw().sketchCircle(0).done()` throws):

1. The `OcKernelError` (or plain `Error`) is captured with V8's stack pointing into the generated bundle at e.g. `blob:http://.../<uuid>:1234:7`.
2. `parseStackTrace` regex-parses the line into a `KernelStackFrame` with `fileName: 'blob:.../<uuid>'`, `lineNumber: 1234`, `columnNumber: 7`.
3. Because `sourceMap: bundleResult.sourceMap` was supplied, `applySourceMapToFrames` matches the `blob:` prefix, calls `consumer.originalPositionFor({ line: 1234, column: 6 })`, gets `{ source: 'vfs:main.ts', line: 5, column: 12, name: 'main' }`.
4. `resolveSourcePath` strips the `vfs:` namespace to `./main.ts`.
5. `resolveLibraryFrames` runs as a second pass — for `replicad/...` frames it would consult the library map; for the user `main` frame it is a no-op.
6. UI renders `main (./main.ts:5:12)`.

For the same conceptual bug in OpenCascade today:

1. Identical V8 capture.
2. Identical regex parse → `fileName: 'blob:.../<uuid>'`, `lineNumber: 4514`, `columnNumber: 16`.
3. **No `sourceMap` supplied** → `applySourceMapToFrames` early-returns at the `if (!sourceMapJson) return frames;` guard (`error-enrichment.ts:186-188`).
4. `applySourceMaps: (frames) => frames` is also a no-op.
5. UI renders `main (blob:.../<uuid>:4514:16)`.

### Finding 6: `ErrorLocation` (the "underline this line in the editor" hint) is also wrong today

`deriveLocationFromFrames` is what the issues panel (and editor underline integrations) use to point a user at the failing line. Without the source map argument it cannot recover `startLineNumber: 5, startColumn: 12`; it picks up the bundle's `4514:16` instead. This means **any client that lints by `issue.location` is also broken** for OpenCascade today, not just the visible stack frames.

### Finding 7: No Replicad-specific runner exists

There is no `replicad-runner.ts` or alternative executor; both kernels go through the same `runtime.execute(code)` path defined in `executeCode`. This eliminates the bundler/executor as a source of difference and isolates the fix to the kernel's `formatRuntimeErrorWithOc` call sites.

## Side-by-side comparison

| Concern                                               | Replicad (today)                                                     | OpenCascade (today)                           | After fix                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| esbuild inline source map produced                    | ✅                                                                   | ✅ (already; same bundler)                    | ✅                                        |
| `bundleResult.sourceMap` plumbed through `parseError` | ✅ (`replicad.kernel.ts:466-473`)                                    | ❌                                            | ✅                                        |
| `executeResult.entryUrl` plumbed through `parseError` | ✅                                                                   | ❌                                            | ✅ (defensive belt-and-braces)            |
| `applySourceMaps` in `formatRuntimeErrorWithOc`       | `resolveLibraryFrames` (library demangle)                            | identity `(f) => f`                           | identity (no library remap needed for OC) |
| `deriveLocation` source-map arg                       | `bundleResult.sourceMap` in `runMain` (`replicad.kernel.ts:277-279`) | `undefined` (`opencascade.kernel.ts:104-105`) | `bundleResult.sourceMap`                  |
| Typical UI `fileName`                                 | `./main.ts`                                                          | `blob:...`                                    | `./main.ts`                               |
| `KernelIssue.location.startLineNumber`                | original source line                                                 | bundle line (e.g. 4514)                       | original source line                      |

## Recommendations

| #   | Action                                                                                                                                                                                                                                                        | Priority | Effort | Impact                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------- |
| R1  | Extend `opencascade.kernel.ts:parseError` to accept `sourceMapJson` and `lastEntryName`; pass them into `parseStackTrace` (mirror Replicad signature)                                                                                                         | P0       | Low    | High — restores user-source frames                             |
| R2  | Extend `opencascade.kernel.ts:deriveLocation` to take an optional `sourceMapJson` and forward it to `deriveLocationFromFrames`                                                                                                                                | P0       | Low    | High — fixes editor underline / `issue.location`               |
| R3  | In `createGeometry`, after `executeResult`, capture `bundleResult.sourceMap` and `executeResult.entryUrl` in closure-accessible variables and feed them into the `catch`-block `formatRuntimeErrorWithOc` call (currently at `opencascade.kernel.ts:347-353`) | P0       | Low    | High                                                           |
| R4  | Same wiring in `getParameters` (`opencascade.kernel.ts:258-264`)                                                                                                                                                                                              | P0       | Low    | Medium — getParameters errors are rarer but should not regress |
| R5  | Add a TDD test in `opencascade.kernel.test.ts` (sibling to the recently-added `exception decoding` block) that asserts `issue.stackFrames[0].fileName === '<relative-user-source-path>'` and that `fileName` does **not** start with `blob:`                  | P0       | Low    | High — pins the parity                                         |
| R6  | Consider extracting the shared "`runMain`-with-source-map" pattern from Replicad into a helper in `kernels/occt/` so future kernels (manifold, openscad, jscad) get the same wiring for free                                                                  | P2       | Medium | Medium — DRYs out per-kernel boilerplate                       |
| R7  | Audit the other kernel `defineKernel` modules (`manifold`, `openscad`, `jscad`, `kcl`) for the same bug; the OpenCascade pattern was likely copy-pasted to one or more of them                                                                                | P1       | Low    | Medium — protect parity across the kernel family               |

Recommendations R1–R5 collectively are the minimum to close the issue. R6/R7 are systemic-hardening follow-ups.

## Code Examples

### Minimal patch sketch (illustrative, not the final implementation)

```typescript
// packages/runtime/src/kernels/opencascade/opencascade.kernel.ts

function parseError(
  error: unknown,
  options?: { sourceMapJson?: string; projectPath?: string; lastEntryName?: string },
): KernelStackFrame[] {
  return parseStackTrace(error, {
    classifyFrame: frameClassifier,
    sourceMap: options?.sourceMapJson,
    resolveSourcePath: (s) => resolveSourcePath(s, options?.projectPath),
    lastEntryName: options?.lastEntryName,
  });
}

function deriveLocation(
  frames: KernelStackFrame[],
  sourceMapJson?: string,
  projectPath?: string,
): ErrorLocation | undefined {
  return deriveLocationFromFrames(frames, sourceMapJson, (s) => resolveSourcePath(s, projectPath));
}

// Inside createGeometry:
const bundleResult = await runtime.bundler.bundle(filePath);
// ...
const executeResult = await runtime.execute(bundleResult.code);
// ...

try {
  // existing happy path
} catch (error) {
  if (error instanceof OcctBuildError) throw error;

  const issue = formatRuntimeErrorWithOc({
    error,
    ocInstance: context.oc,
    parseStackTrace: (e) =>
      parseError(e, {
        sourceMapJson: bundleResult.sourceMap,
        projectPath: basePath,
        lastEntryName: executeResult.entryUrl,
      }),
    applySourceMaps: (frames) => frames,
    deriveLocation: (frames) => deriveLocation(frames, bundleResult.sourceMap, basePath),
    sourceMap: bundleResult.sourceMap,
  });
  throw new OcctBuildError([issue]);
}
```

### TDD assertion sketch (extends `opencascade.kernel.test.ts`)

```typescript
it('should resolve user source path for stack frames via inline source map', async () => {
  const geometryFile = createGeometryFile('bad-call.ts');
  const result = await worker.createGeometry({ file: geometryFile, parameters: {} });

  assertFailure(result, 'bad-call createGeometry');
  const issue = result.issues[0]!;
  expect(issue.stackFrames?.length ?? 0).toBeGreaterThan(0);

  const userFrame = issue.stackFrames!.find((f) => f.context === 'user');
  expect(userFrame).toBeDefined();
  expect(userFrame!.fileName).not.toMatch(/^blob:/);
  expect(userFrame!.fileName).toMatch(/bad-call\.ts$/);

  expect(issue.location?.fileName).toMatch(/bad-call\.ts$/);
});
```

## Diagrams

```mermaid
flowchart LR
  subgraph Shared["Shared (both kernels)"]
    A[esbuild bundle\nsourcemap: 'inline'] --> B[extractInlineSourceMap\n→ bundleResult.sourceMap]
    B --> C[executeCode\n→ blob: URL + import]
    C --> D[user main throws\nWebAssembly.Exception]
    D --> E[wrapOcForExceptions\nrethrowIfWasmException]
    E --> F[OcKernelError\n+ Error.captureStackTrace]
  end

  subgraph Replicad["Replicad runMain catch"]
    F --> G1[parseStackTrace<br>sourceMap: bundleResult.sourceMap<br>lastEntryName: entryUrl]
    G1 --> H1[applySourceMapToFrames<br>blob:... → ./main.ts]
    H1 --> I1[resolveLibraryFrames<br>replicad/* demangle]
    I1 --> J1[KernelIssue.stackFrames[0]<br>fileName=./main.ts]
  end

  subgraph OpenCascade["OpenCascade catch (today)"]
    F --> G2[parseStackTrace<br>NO sourceMap<br>NO lastEntryName]
    G2 --> H2[applySourceMapToFrames<br>early-returns at !sourceMapJson]
    H2 --> I2["applySourceMaps: (f) => f"]
    I2 --> J2[KernelIssue.stackFrames[0]<br>fileName=blob:.../uuid<br>lineNumber=4514]
  end
```

## Trade-offs

| Option                                                                  | Pros                                                                                                                                   | Cons                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **A. Inline the fix in `opencascade.kernel.ts`** (R1–R5)                | Minimal change, no new abstractions, identical pattern to Replicad already proven                                                      | Continues per-kernel duplication of the wiring                                                   |
| **B. Extract a shared `runMain` helper** in `kernels/occt/` (R6)        | Single point of truth for source-map plumbing across kernels; future kernels get parity for free                                       | Larger blast radius; needs a generic seam for kernel-specific `applySourceMaps` and library maps |
| **C. Move source-map remapping into `formatRuntimeErrorWithOc` itself** | Kernels would only need to pass `sourceMap` and `entryUrl` once; eliminates the parallel `parseStackTrace` / `deriveLocation` plumbing | Couples the OCCT helper to bundler concerns; harder to test in isolation; no clear win over B    |

Recommended: do **A first** (R1–R5) to close the user-visible bug, then revisit **B (R6)** when extracting the next kernel or when a sibling kernel exhibits the same regression (R7 audit).

## Out of Scope

- Improving the source map resolution itself (e.g., column-precision or expression extents) — already covered by `applySourceMapToFrames` and `deriveLocationFromFrames`.
- Adding a JS source map for `opencascade.js` (the WASM library) — analogous to Replicad's `replicad.js.map`. WASM frames are already filtered out by the frame classifier; this would only matter for thrown JS-side library errors, which are vanishingly rare.
- Changing the bundler from `inline` source maps to `external` — would require new transport for the map and is unrelated to the parity fix.
- Touching the UI rendering in `chat-stack-trace.tsx` — UI is correct; the input frames are wrong.

## References

- `packages/runtime/src/kernels/opencascade/opencascade.kernel.ts:97-105, 258-264, 347-353`
- `packages/runtime/src/kernels/replicad/replicad.kernel.ts:141-159, 199-205, 259-283, 466-473, 544-551`
- `packages/runtime/src/kernels/occt/oc-tracing.ts:155-196`
- `packages/runtime/src/kernels/occt/oc-exceptions.ts:251-329`
- `packages/runtime/src/framework/error-enrichment.ts:29-73, 179-233`
- `packages/runtime/src/bundler/esbuild-core.ts:286-295, 747, 786-791, 1095-1134`
- `apps/ui/app/routes/projects_.$id/chat-stack-trace.tsx:107-145`

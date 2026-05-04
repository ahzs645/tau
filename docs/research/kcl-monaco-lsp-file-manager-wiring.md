---
title: 'KCL Monaco LSP file-manager wiring regression'
description: 'Root-cause investigation for the editor-margin "engine: Failed to wait for promise from engine: No file manager available" error on KCL imports.'
status: active
created: '2026-05-04'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/zoo-kcl-std-prelude-load-failure.md
  - docs/research/monaco-lsp-lazy-activation-blueprint.md
  - docs/research/zoo-kcl-148-integration-audit.md
  - docs/research/kcl-lsp-relative-import-resolution.md
---

# KCL Monaco LSP file-manager wiring regression

Root-cause analysis for the editor-margin error `engine: Failed to wait for promise from engine: JsValue(Error: No file manager available …)` shown on `import "fan-housing.kcl" as fanHousing` in `apps/ui` after the Monaco lazy-activation refactor.

## Executive Summary

The Monaco KCL LSP error is **not** the same bug as the runtime kernel `std::prelude` empty-message failure — the two surfaces use independent WASM `Context` instances and independent file-manager bridges. The Monaco LSP failure is a **plain ordering bug** in `kcl-register-language.ts`: the lazy-activation refactor (commit `4af2363e6`, 2026-04-23) wraps `initializeLsp(monaco)` in `queueMicrotask(...)` so the LSP client is constructed **after** the synchronous body of `activate()` returns, but `setKclLspFileManager(...)` is still called **synchronously** inside that body. By the time `setKclLspFileManager` runs, `lspClient` is `undefined`, so the function falls into its `else` branch, logs `Cannot set file manager - client not initialized`, and **silently drops the file manager**. The `KclLspClient` is later constructed without ever being told about the file manager, and every subsequent `fileReadRequest` posted from the LSP worker is rejected by `KclLspClient.handleFileReadRequest` with the literal string `'No file manager available'`. WASM rejects, the JS-RPC layer surfaces the rejection as `engine: Failed to wait for promise from engine`, and Monaco renders it as a problem on the import line.

The fix is local to `apps/ui/app/lib/kcl-language/kcl-register-language.ts`: store the file manager at module scope and have `initializeLsp` apply it on construction (or immediately after `await lspClient.initialize()`), so the deferred boot sees the file manager regardless of the call order. **No `kcl-wasm-lib` rebuild is required.** The runtime kernel `std::prelude` investigation continues independently per the existing plan.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

In the screenshot:

- File: `apps/ui` editor open on `kcl-samples/axial-fan/main.kcl`.
- Source: `import "fan-housing.kcl" as fanHousing` / `import "motor.kcl" as motor` / `import "fan.kcl" as fan`.
- Editor margin / hover: `engine: Failed to wait for promise from engine: JsValue(Error: No file manager available Error: No file manager available at Oe.handleFileReadResponse (http://localhost:3000/assets/kcl-lsp-worker-DKexarOv.js:1:32898) at Fe (http://localhost:3000/assets/kcl-lsp-worker-DKexarOv.js:1:35719)) kcl`.
- Bottom-of-editor problems panel: a separate `{"error":{"kind":"semantic","details":{…,"msg":"Error loading imported file (std::prelude)…"}}}` (the runtime-kernel issue tracked in [`docs/research/zoo-kcl-std-prelude-load-failure.md`](zoo-kcl-std-prelude-load-failure.md)).

The user asked whether the Monaco LSP error means the KCL Monaco integration also needs updating. **Yes — and it is independent of the runtime-kernel investigation.**

## Methodology

| Step | Source examined                                                                                                        | Purpose                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1    | [`apps/ui/app/lib/kcl-language/lsp/kcl-lsp-worker.ts`](../../apps/ui/app/lib/kcl-language/lsp/kcl-lsp-worker.ts)       | Identify which JS frame emits the literal `No file manager available` (`FileSystemBridge.handleFileReadResponse`). |
| 2    | [`apps/ui/app/lib/kcl-language/lsp/kcl-lsp-client.ts`](../../apps/ui/app/lib/kcl-language/lsp/kcl-lsp-client.ts)       | Identify the source of the error string — `KclLspClient.handleFileReadRequest` (line 470).                         |
| 3    | [`apps/ui/app/lib/kcl-language/kcl-register-language.ts`](../../apps/ui/app/lib/kcl-language/kcl-register-language.ts) | Audit `setKclLspFileManager` and the `kclContribution.activate()` ordering.                                        |
| 4    | [`apps/ui/app/lib/monaco-language-registry.ts`](../../apps/ui/app/lib/monaco-language-registry.ts)                     | Confirm the `ActivationContext.fileManager` value is well-formed before `activate()` runs.                         |
| 5    | [`apps/ui/app/hooks/use-monaco-model-service.tsx`](../../apps/ui/app/hooks/use-monaco-model-service.tsx)               | Confirm callers pass a real `FileManagerApi`.                                                                      |
| 6    | `git log` / `git show 4af2363e6`                                                                                       | Pin the regression to the lazy-activation refactor.                                                                |

## Findings

### Finding 1: `No file manager available` originates in `KclLspClient`, not in WASM

The literal string in the screenshot is emitted from one place only — the main-thread `KclLspClient.handleFileReadRequest`:

```461:472:apps/ui/app/lib/kcl-language/lsp/kcl-lsp-client.ts
  private async handleFileReadRequest(request: FileSystemRequest): Promise<void> {
    log.debug('Handling file read request:', request.path);
    const { fileManager } = this.options;

    if (!fileManager) {
      log.debug('No file manager available, returning empty');
      this.worker?.postMessage({
        worker: kclWorkerType,
        eventType: lspWorkerEventType.fileReadResponse,
        eventData: { requestId: request.requestId, data: undefined, error: 'No file manager available' },
      });
      return;
    }
```

The worker-side `FileSystemBridge.handleFileReadResponse` reads the `error` field and rejects the pending promise:

```117:128:apps/ui/app/lib/kcl-language/lsp/kcl-lsp-worker.ts
    if (response.error) {
      log.debug('File read error:', response.error);
      pending.reject(new Error(response.error));
    } else if (response.data) {
      log.debug('File read success, bytes:', response.data.length);
      pending.resolve(response.data);
    } else {
      log.debug('File not found');
      // Return empty array for files that don't exist (WASM expects this)
      pending.resolve(new Uint8Array());
    }
```

The reject propagates into the WASM `Context` `Promise` chain that drives `lsp_run_kcl`, which is what turns it into the user-visible `engine: Failed to wait for promise from engine: JsValue(Error: No file manager available …)` text. The `kcl-lsp-worker-DKexarOv.js` filename in the screenshot stack trace is the Vite-bundled `kcl-lsp-worker.ts`.

**Implication:** the question is not "did WASM regress" but "why is `this.options.fileManager` undefined when `handleFileReadRequest` runs?".

### Finding 2: `setKclLspFileManager` silently drops the file manager when `lspClient` is undefined

```71:90:apps/ui/app/lib/kcl-language/kcl-register-language.ts
export function setKclLspFileManager(fileManager: LspFileManager): void {
  log.debug(' setKclLspFileManager called');
  log.debug(' - lspClient exists:', Boolean(lspClient));
  log.debug(' - lspClient ready:', lspClient?.ready);
  log.debug(' - fileManager.exists:', Boolean(fileManager.exists));
  log.debug(' - fileManager.readFile:', Boolean(fileManager.readFile));
  log.debug(' - openedDocuments count:', openedDocuments.size);
  log.debug(' - openedDocuments:', [...openedDocuments]);

  if (lspClient) {
    lspClient.setFileManager(fileManager);
    log.debug(' File manager set on client, triggering import re-processing');

    // Re-process all opened documents to parse and open their imports
    // This handles the case where documents were opened before the file manager was set
    void reprocessOpenedDocumentsForImports();
  } else {
    log.warn('Cannot set file manager - client not initialized');
  }
}
```

Two observations:

1. The JSDoc above the function explicitly claims the function _"tolerates the LSP not being ready yet — it stores the file manager and re-processes opened documents once the client is ready"_ (the call site comment in `activate()`, lines 864–871). The implementation **does not store anything**. It only branches on `lspClient` and warns when undefined. That is a contract violation.
2. There is no `pendingFileManager` module-scoped variable, no subscription on the client's `onInitialized` callback, and no retry loop.

### Finding 3: The lazy-activation refactor reversed the ordering

`kclContribution.activate()` is the only caller of `setKclLspFileManager` in production code:

```839:872:apps/ui/app/lib/kcl-language/kcl-register-language.ts
  activate(context: ActivationContext): ActivationResult {
    const { markerService, modelService, monaco } = context;
    …
    // Defer the heavy LSP boot (Web Worker spawn + WASM init + provider
    // registration) to a microtask so `activate()` returns synchronously and
    // does not block the registry's per-contribution loop. Mirrors VS Code's
    // TypeScript extension pattern.
    queueMicrotask(() => {
      void initializeLsp(monaco);
    });

    // Set up file manager for KCL LSP import resolution. `setKclLspFileManager`
    // tolerates the LSP not being ready yet — it stores the file manager and
    // re-processes opened documents once the client is ready.
    setKclLspFileManager({
      readFile: async (path: string) => context.fileManager.readFile(path),
      exists: async (path: string) => context.fileManager.exists(path),
      readdir: async (path: string) => context.fileManager.readdir(path),
    });
```

`queueMicrotask` enqueues `initializeLsp(monaco)` to run **after** the current synchronous task completes. `setKclLspFileManager(...)` runs **inside** the same synchronous task, immediately after the `queueMicrotask` call. Therefore the order of operations is:

| #   | When      | Operation                                                                                                                                       | `lspClient` state                                                 |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | sync      | `queueMicrotask(...)` schedules `initializeLsp` for the microtask queue                                                                         | `undefined`                                                       |
| 2   | sync      | `setKclLspFileManager({...})` runs                                                                                                              | `undefined` → warn branch fires, file manager dropped             |
| 3   | microtask | `initializeLsp` constructs `lspClient = new KclLspClient({...})` with `options = { onInitialized, onNotification }` only — **no `fileManager`** | constructed, `options.fileManager === undefined`                  |
| 4   | later     | LSP worker boots, processes opened doc, calls `FileSystemBridge.readFile`, posts `fileReadRequest`                                              | `options.fileManager === undefined` → "No file manager available" |

`git show 4af2363e6` confirms commit `4af2363e6 feat(ui): add lazy activation for Monaco language contributions` introduced the `queueMicrotask(...)` wrapper. Prior to that commit, `initializeLsp(monaco)` ran synchronously (or as a top-level await) inside `activate()`, so `lspClient` existed by the time `setKclLspFileManager` ran. The refactor delivered the intended lazy-boot behaviour but missed the file-manager dependency edge.

### Finding 4: This is independent of the runtime-kernel `std::prelude` failure

The runtime kernel and the Monaco LSP each load `@taucad/kcl-wasm-lib` 0.1.148 and each construct their own `Context` (or `LspServerConfig`) instance:

| Surface        | Module                                                                                          | WASM entry                        | File-system bridge                             |
| -------------- | ----------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------- |
| Runtime kernel | `packages/runtime/src/kernels/zoo/zoo.kernel.ts` (`zoo-engine-bridge`, `filesystem-manager`)    | `Context.execute` / `executeMock` | `FileSystemManager` (kernel-side)              |
| Monaco LSP     | `apps/ui/app/lib/kcl-language/lsp/kcl-lsp-worker.ts` (`FileSystemBridge`) + `kcl-lsp-client.ts` | `lsp_run_kcl(LspServerConfig, …)` | `LspFileManager` (Monaco main thread → worker) |

The `std::prelude` empty-message error reproduces inside `Context.execute` even when no Monaco LSP is mounted; the LSP `No file manager available` reproduces inside the LSP worker even if `Context.execute` succeeds. They are not chained. Phase 0 of the [`zoo-kcl-std-prelude-load-failure`](zoo-kcl-std-prelude-load-failure.md) plan is the right tool for the kernel surface; the LSP surface needs a separate one-line fix on the activation ordering.

### Finding 5: No path-translation layer exists for LSP import paths

If/when Finding 2 + 3 are fixed, the next failure mode to watch for is path translation. The LSP worker delegates `FileSystemBridge.readFile(path)` directly through to `context.fileManager.readFile(path)`. The path the WASM passes is determined by the Rust `ModulePath::Local::source` resolver applied to `import "fan-housing.kcl"` against the importing document's URI. `FileManagerApi` (`apps/ui/app/machines/file-manager.machine.types.ts:28`) is the project-scoped facade and expects project-relative paths (without a leading `/projects/<id>` prefix in some call sites) — the same wrapper used by `kcl-register-language.ts:868–870` is used elsewhere successfully, but no automated test exercises a multi-file import with this exact path shape, so a follow-up assertion is recommended once the file-manager is reaching the bridge.

This finding is **not blocking** the immediate fix; it is a follow-up risk.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                         | Priority | Effort | Impact |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Make `setKclLspFileManager` store the file manager at module scope and have `initializeLsp` apply it via the `KclLspClient` constructor (`new KclLspClient({ fileManager: pendingFileManager, … })`). Keep the `lspClient.setFileManager(...)` path for the live-mutate case. Remove the misleading `'Cannot set file manager - client not initialized'` warn. | P0       | XS     | High   |
| R2  | Add a regression test in `apps/ui/app/lib/kcl-language/kcl-register-language.test.ts` that calls `kclContribution.activate(...)` with a mock `fileManager`, lets the queued microtask run, and asserts the constructed `KclLspClient` exposes the file manager via `getFileManager()`.                                                                         | P0       | XS     | High   |
| R3  | Add an integration assertion (vitest, jsdom, mock `Worker`) that posts a synthetic `fileReadRequest` after `activate()` resolves and confirms the response contains `data` (not `error: 'No file manager available'`).                                                                                                                                         | P1       | S      | Medium |
| R4  | Once R1 lands, validate path translation end-to-end with a multi-file KCL fixture (`main.kcl` + `fan-housing.kcl`) and assert imports resolve through `context.fileManager.readFile`. Closes Finding 5.                                                                                                                                                        | P1       | S      | Medium |
| R5  | Cross-link this research from [`monaco-lsp-lazy-activation-blueprint.md`](monaco-lsp-lazy-activation-blueprint.md) so future contributors moving more boot work into microtasks see the file-manager dependency as a known cliff.                                                                                                                              | P2       | XS     | Low    |

## Code Examples

### The smoking-gun ordering

```typescript
// apps/ui/app/lib/kcl-language/kcl-register-language.ts (current — bug)
queueMicrotask(() => {
  void initializeLsp(monaco); // creates lspClient ← runs LATER
});

setKclLspFileManager({
  // ← runs NOW, lspClient is undefined, file manager dropped
  readFile: async (path) => context.fileManager.readFile(path),
  exists: async (path) => context.fileManager.exists(path),
  readdir: async (path) => context.fileManager.readdir(path),
});
```

### Suggested fix shape (R1)

```typescript
// Module scope
let pendingFileManager: LspFileManager | undefined;

export function setKclLspFileManager(fileManager: LspFileManager): void {
  pendingFileManager = fileManager;
  if (lspClient) {
    lspClient.setFileManager(fileManager);
    void reprocessOpenedDocumentsForImports();
  }
}

async function initializeLsp(monaco: typeof Monaco): Promise<void> {
  // …
  lspClient = new KclLspClient({
    fileManager: pendingFileManager,
    onInitialized() {
      log.debug(' Client initialized successfully');
    },
    onNotification(notification) {
      diagnosticsHandler(notification);
    },
  });
  await lspClient.initialize();
  await lspClient.waitForReady();
  if (pendingFileManager) {
    void reprocessOpenedDocumentsForImports();
  }
  // …
}
```

This preserves the lazy-boot win from `4af2363e6` and removes the silent-drop edge in two lines of code without touching the WASM tarball.

## Diagrams

```text
Main thread (renderer)                                Web Worker (kcl-lsp-worker.ts)
─────────────────────                                ────────────────────────────────
ActivationContext { fileManager } ──┐
                                    │
kclContribution.activate(context):  │
   queueMicrotask(initializeLsp)    │   ⏳ deferred
   setKclLspFileManager(fm)         │
       └─ if (lspClient) … else WARN│   ← lspClient is still undefined
                                    │     pendingFileManager NEVER stored
                                    │
microtask: initializeLsp(monaco)    │
   lspClient = new KclLspClient({}) │     options.fileManager === undefined
   spawn Worker(kcl-lsp-worker.ts)  │ ─►  init WASM, lsp_run_kcl()
                                    │     ↓
                                    │     KCL parses `import "fan-housing.kcl"`
                                    │     FileSystemBridge.readFile("…/fan-housing.kcl")
                                    │     postMessage(fileReadRequest)
   handleFileReadRequest:           │ ◄── fileReadRequest
       options.fileManager === undef│
       postMessage(fileReadResponse,│
         error: "No file manager")  │ ──► handleFileReadResponse rejects pending promise
                                    │     WASM rejects → "engine: Failed to wait for promise from engine"
```

## References

- Regression commit: `4af2363e6 feat(ui): add lazy activation for Monaco language contributions` (2026-04-23).
- Related (independent) investigation: [`docs/research/zoo-kcl-std-prelude-load-failure.md`](zoo-kcl-std-prelude-load-failure.md).
- Lazy-activation design: [`docs/research/monaco-lsp-lazy-activation-blueprint.md`](monaco-lsp-lazy-activation-blueprint.md).
- LSP client / worker code: `apps/ui/app/lib/kcl-language/lsp/kcl-lsp-client.ts`, `apps/ui/app/lib/kcl-language/lsp/kcl-lsp-worker.ts`.
- Activation surface: `apps/ui/app/lib/kcl-language/kcl-register-language.ts`, `apps/ui/app/lib/monaco-language-registry.ts`, `apps/ui/app/hooks/use-monaco-model-service.tsx`.

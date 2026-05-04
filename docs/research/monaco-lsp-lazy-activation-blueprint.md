---
title: 'Monaco LSP Lazy Activation Blueprint'
description: 'Defer KCL/OpenSCAD/JS-TS LSP cost in apps/ui Monaco setup until a model with a matching extension actually exists, using monaco.languages.onLanguage + provider factories instead of eager activation in MonacoModelServiceProvider.'
status: draft
created: '2026-04-23'
updated: '2026-05-04'
category: architecture
related:
  - docs/policy/library-api-policy.md
  - docs/research/monaco-intellisense-jsdoc-rendering.md
  - docs/research/ui-startup-performance-gap-analysis.md
  - docs/research/kernel-plugin-type-linkage.md
  - docs/research/kcl-monaco-lsp-file-manager-wiring.md
  - docs/research/kcl-lsp-relative-import-resolution.md
---

# Monaco LSP Lazy Activation Blueprint

Replace eager activation of every language contribution (KCL LSP worker + WASM, OpenSCAD providers, JS/TS ATA, USD/STL/STEP configs) in `apps/ui/app/components/code/code-editor.client.tsx` with a per-language activation model keyed on Monaco's own `monaco.languages.onLanguage` event so that an LSP only spins up when a matching file is actually opened.

## Executive Summary

The current Monaco bootstrap in `apps/ui` has two phases — `register` (metadata) and `activate` (providers + LSP) — but the second phase fires _eagerly for every contribution_ as soon as `MonacoModelServiceProvider` mounts. The screenshot evidence confirms the smoking gun: opening a Replicad project (TypeScript-only) still triggers `Loading kernel module: replicad`, **then** `Created mock executor context for LSP code` from `@taucad/kcl-wasm-lib`, plus implicit OpenSCAD provider registration and ATA initialisation. The KCL contribution alone fetches the KCL WASM, instantiates a JSON-RPC LSP worker, builds a mock execution `Context`, and processes stdlib — none of which is needed until a `.kcl` model is opened.

Monaco already ships the exact primitive required: `monaco.languages.onLanguage(id, callback)` fires once when the first model with that language ID materialises, and `monaco.languages.registerTokensProviderFactory` defers tokenizer creation to first encounter. VS Code's extension host applies the same model via `activationEvents: ["onLanguage:<id>"]`. We mirror this contract by keeping Phase 1 (`register`) eager and rewriting Phase 2 (`activate`) into a deferred per-language activation that the registry itself wires up via `onLanguage`. No consumer changes; the activation closure simply moves from "called once per provider mount" to "called once per first model encounter".

The recommended target reduces idle cost for a Replicad project from "all five LSPs + WASM + ATA" to "JS/TS ATA only", and conversely an OpenSCAD-only project pays nothing for the KCL WASM. The architecture is testable, reversible per contribution, and aligns with VS Code's published pattern.

## Table of Contents

- [Monaco LSP Lazy Activation Blueprint](#monaco-lsp-lazy-activation-blueprint)
  - [Executive Summary](#executive-summary)
  - [Table of Contents](#table-of-contents)
  - [Problem Statement](#problem-statement)
  - [Methodology](#methodology)
  - [Findings](#findings)
    - [Finding 1: `registry.activate` is eager and unconditional](#finding-1-registryactivate-is-eager-and-unconditional)
    - [Finding 2: KCL is the dominant offender — full LSP + WASM + mock context spin-up at mount](#finding-2-kcl-is-the-dominant-offender--full-lsp--wasm--mock-context-spin-up-at-mount)
    - [Finding 3: JS/TS ATA spins up even when no `.ts/.js` file is opened](#finding-3-jsts-ata-spins-up-even-when-no-tsjs-file-is-opened)
    - [Finding 4: OpenSCAD/STEP/STL/USD eager `register` is acceptable; `activate` is not](#finding-4-openscadstepstlusd-eager-register-is-acceptable-activate-is-not)
    - [Finding 5: Monaco already exposes the right primitive (`onLanguage` + provider factories)](#finding-5-monaco-already-exposes-the-right-primitive-onlanguage--provider-factories)
    - [Finding 6: VS Code's `onLanguage:<id>` activation event is the canonical inspiration](#finding-6-vs-codes-onlanguageid-activation-event-is-the-canonical-inspiration)
    - [Finding 7: Existing two-phase contract maps cleanly to lazy activation](#finding-7-existing-two-phase-contract-maps-cleanly-to-lazy-activation)
    - [Finding 8: Per-kernel routing alone is insufficient](#finding-8-per-kernel-routing-alone-is-insufficient)
    - [Finding 9: VS Code's `requestRichLanguageFeatures` is the upstream of Monaco's `onLanguage`](#finding-9-vs-codes-requestrichlanguagefeatures-is-the-upstream-of-monacos-onlanguage)
    - [Finding 10: VS Code splits "basic" from "rich" language features for finer-grained deferral](#finding-10-vs-code-splits-basic-from-rich-language-features-for-finer-grained-deferral)
    - [Finding 11: Activation is deduplicated at three layers in VS Code](#finding-11-activation-is-deduplicated-at-three-layers-in-vs-code)
    - [Finding 12: VS Code's TypeScript extension uses double deferral — `onLanguage` for activation, first matching document for `tsserver` spawn](#finding-12-vs-codes-typescript-extension-uses-double-deferral--onlanguage-for-activation-first-matching-document-for-tsserver-spawn)
    - [Finding 13: VS Code's language-configuration JSON is fetched lazily on `onDidRequestBasicLanguageFeatures`](#finding-13-vs-codes-language-configuration-json-is-fetched-lazily-on-ondidrequestbasiclanguagefeatures)
    - [Finding 14: VS Code surfaces activation telemetry via well-known performance marks](#finding-14-vs-code-surfaces-activation-telemetry-via-well-known-performance-marks)
  - [Target Architecture](#target-architecture)
    - [Activation Triggers](#activation-triggers)
    - [Updated `LanguageContribution` Interface](#updated-languagecontribution-interface)
    - [Updated `LanguageContributionRegistry.activate`](#updated-languagecontributionregistryactivate)
    - [Per-Contribution Activation IDs](#per-contribution-activation-ids)
    - [Required Refactor of KCL Contribution](#required-refactor-of-kcl-contribution)
    - [Active-Kernel Prefetch Hint (Optional)](#active-kernel-prefetch-hint-optional)
  - [Recommendations](#recommendations)
  - [Trade-offs](#trade-offs)
    - [Lazy activation vs eager pre-warming](#lazy-activation-vs-eager-pre-warming)
    - [Per-language `onLanguage` vs reactive model scan](#per-language-onlanguage-vs-reactive-model-scan)
    - [Active-kernel routing vs model-encounter gate](#active-kernel-routing-vs-model-encounter-gate)
    - [Fail-open vs fail-closed on activation error](#fail-open-vs-fail-closed-on-activation-error)
  - [Migration Path](#migration-path)
  - [Code Examples](#code-examples)
    - [Before: eager activation (status quo)](#before-eager-activation-status-quo)
    - [After: deferred activation](#after-deferred-activation)
    - [Test contract (R8)](#test-contract-r8)
  - [Diagrams](#diagrams)
    - [Provider mount sequence (target)](#provider-mount-sequence-target)
    - [Contribution activation matrix (illustrative cold start, Replicad project)](#contribution-activation-matrix-illustrative-cold-start-replicad-project)
  - [References](#references)
  - [Appendix: Per-Language Activation Cost Inventory](#appendix-per-language-activation-cost-inventory)

## Problem Statement

`apps/ui/app/components/code/code-editor.client.tsx` calls `await configureMonaco()` at module scope. `configureMonaco` registers metadata for every contribution via `LanguageContributionRegistry.registerAll(monaco)`. Then `MonacoModelServiceProvider` (`apps/ui/app/hooks/use-monaco-model-service.tsx`) calls `registry.activate(...)` exactly once per Monaco availability, which iterates every contribution's `activate` method synchronously. The result, captured in the user-supplied screenshot during a Replicad-only session:

| Symptom                                                             | Source                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Loading kernel module: replicad` (expected)                        | runtime worker bootstrap                                                              |
| `[Kernel:worker] - 'initializing kernel: replicad: ...'` (expected) | replicad WASM                                                                         |
| `Created mock executor context for LSP code`                        | `apps/ui/app/lib/kcl-language/kcl-register-language.ts` `initializeSymbolServiceWasm` |
| `using deprecated parameters for the initialization function ...`   | KCL WASM module bootstrap                                                             |
| `Failed to get privacy settings: Request Error ...`                 | KCL WASM telemetry path                                                               |

None of the KCL output should occur in a Replicad session. The KCL LSP worker, KCL WASM module, mock engine connection, and stdlib processing all run on cold start regardless of whether any `.kcl` model exists. Same eager pattern penalises OpenSCAD/STEP/STL/USD activations, plus the JS/TS ATA initialisation and `kernelTypeMaps` `addExtraLib` registrations from `apps/ui/app/lib/javascript-contribution.ts`.

The user's stated goal: "load LSPs on demand only when an extension is present in the monaco models that would use it."

## Methodology

1. **Source audit** — read every `*-register-language.ts` and the registry/provider that wires them (`apps/ui/app/lib/monaco-language-registry.ts`, `apps/ui/app/hooks/use-monaco-model-service.tsx`, `apps/ui/app/lib/javascript-contribution.ts`, `apps/ui/app/lib/monaco.lib.ts`, `apps/ui/app/components/code/code-editor.client.tsx`).
2. **Cost inventory** — classified each contribution's `activate` cost into network/CPU/memory categories (see [Appendix](#appendix-per-language-activation-cost-inventory)).
3. **Web research** — cross-checked Monaco's own lazy-loading source (`microsoft/monaco-editor` `src/languages/definitions/_.contribution.ts`), Monaco public API docs (`registerTokensProviderFactory`, `onLanguage`, `onLanguageEncountered`), and the VS Code extension host activation event spec (`onLanguage:<id>`). Validated known pitfalls including the historical `onLanguage` early-eager firing bug (microsoft/monaco-editor#2750) and provider duplicate-registration patterns (microsoft/monaco-editor#2084).
4. **Cross-checked with active kernel signal** — confirmed that kernel `extensions` arrays in `packages/runtime/src/kernels/*/`_.plugin.ts_`(e.g.,`replicad.plugin.ts → ['ts', 'js']`, `zoo.plugin.ts → ['kcl']`) are insufficient on their own for activation routing because user files (tests, JSON config, future-imported `.kcl` snippets) can require an LSP regardless of active kernel.
5. **Existing tests** — reviewed `apps/ui/app/lib/monaco-language-registry.test.ts` for the activation contract surface that must be preserved.

## Findings

### Finding 1: `registry.activate` is eager and unconditional

`LanguageContributionRegistry.activate` (`apps/ui/app/lib/monaco-language-registry.ts:97-125`) iterates `this.contributions.values()` and calls every contribution's `activate(context)` synchronously. There is no language-id gating, no model presence check, no `onLanguage` subscription. Activation runs once per `MonacoModelServiceProvider` mount + epoch:

```98:124:apps/ui/app/lib/monaco-language-registry.ts
public activate(context: ActivationContext): NavigationHandler[] {
  if (this.lastActivatedEpoch >= this.activationEpoch) {
    return this.currentHandlers;
  }

  // Dispose previous activation
  this.disposeActivation();

  this.currentHandlers = [];

  for (const contribution of this.contributions.values()) {
    try {
      const result = contribution.activate(context);

      this.activationDisposables.push(...result.disposables);

      if (result.navigationHandler) {
        this.currentHandlers.push(result.navigationHandler);
      }
    } catch (error) {
      console.error(`Failed to activate language contribution "${contribution.languageId}":`, error);
    }
  }

  // Commit epoch AFTER all contributions have been processed
  this.lastActivatedEpoch = this.activationEpoch;

  return this.currentHandlers;
}
```

This contract is the single root cause of all unnecessary LSP costs.

### Finding 2: KCL is the dominant offender — full LSP + WASM + mock context spin-up at mount

`kclContribution.register()` (`apps/ui/app/lib/kcl-language/kcl-register-language.ts:828-830`) calls `registerKclLanguage(monaco)`, which itself calls `void initializeLsp(monaco)` (line 411). `initializeLsp`:

1. Constructs `KclLspClient`, which immediately spawns a Web Worker via `new Worker(new URL('kcl-lsp-worker.ts', import.meta.url), { type: 'module' })` (`kcl-lsp-client.ts:284`).
2. Calls `lspClient.initialize()` and `waitForReady()` — full LSP handshake.
3. Registers eight Monaco language providers (`registerCompletionItemProvider`, `registerHoverProvider`, `registerSignatureHelpProvider`, `registerDocumentFormattingEditProvider`, `registerDocumentSemanticTokensProvider`, `registerFoldingRangeProvider`, `registerRenameProvider`, `registerDefinitionProvider`, `registerCodeActionProvider`).
4. Calls `setupDocumentSync` which subscribes to `onDidCreateModel`, `onDidChangeModelLanguage`, `onWillDisposeModel`.
5. Fires `void initializeSymbolServiceWasm()` which dynamic-imports `@taucad/kcl-wasm-lib`, `@taucad/kcl-wasm-lib/kcl.wasm?url`, and `@taucad/runtime/kernels/zoo/engine-connection`, instantiates a `MockEngineConnection`, builds a `Context`, processes stdlib sources.

Worse: the KCL contribution conflates the `register` and `activate` boundaries — `initializeLsp` runs from inside `register`, not `activate`. So the LSP boots even if `MonacoModelServiceProvider` never mounts (e.g., from `code-editor.client.tsx`'s top-level `await configureMonaco()`). This is the network/CPU spike visible in the screenshot.

### Finding 3: JS/TS ATA spins up even when no `.ts/.js` file is opened

`jsTsContribution.activate` (`apps/ui/app/lib/javascript-contribution.ts:45-130`):

1. Calls `setCompilerOptions` + `setEagerModelSync(true)` for both `typescriptDefaults` and `javascriptDefaults`.
2. Constructs `ModuleResolver` and registers four definition providers (TS, JS, TSX, JSX).
3. Constructs `TypeAcquisitionService`, calls `initialize` with **all** kernel type maps from `kernelTypeMaps` (replicad + opencascade + jscad + manifold), each becoming a separate `addExtraLib` registration at `file:///node_modules/<modulePath>/index.d.ts`.
4. Calls `ataInstance.startWatching()` which begins `onDidCreateModel` / `onDidChangeContent` subscriptions across every JS/TS model.

For an OpenSCAD-only or KCL-only project, all four kernel type maps and four definition providers register for nothing. The replicad bundle alone is the largest `.d.ts` payload in the repo.

### Finding 4: OpenSCAD/STEP/STL/USD eager `register` is acceptable; `activate` is not

OpenSCAD's `register` synchronously installs its tokenizer, language config, completion/hover/signature/definition providers — all pure JS, no WASM, no worker. STEP/STL/USD `register` only installs language metadata + autoclosing pairs. Their per-language `activate` is a no-op or registers a navigation handler.

The cost asymmetry matters: tiny, sync registrations like USD's `monaco.languages.register({ id, extensions })` are cheap enough to keep eager because Monaco needs them to resolve `monaco.Uri.file(filename) → languageId` before any model is created. The expensive parts (LSP workers, WASM, ATA) belong behind activation gates.

### Finding 5: Monaco already exposes the right primitive (`onLanguage` + provider factories)

Monaco's public API includes:

| Primitive                                                        | Fires when                                                                             | Use for                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `monaco.languages.onLanguage(id, cb)`                            | First time a model with `id` is created (via setModelLanguage or auto-detect from URI) | Lazy provider registration, LSP boot, ATA bootstrap |
| `monaco.languages.onLanguageEncountered(id, cb)`                 | Same trigger; auto-disposes after first fire                                           | Loading language config (brackets, comments)        |
| `monaco.languages.registerTokensProviderFactory(id, { create })` | First tokenization attempt for `id`                                                    | Loading Monarch grammar lazily                      |

Monaco itself uses this exact pattern in `src/languages/definitions/_.contribution.ts` for all 85 built-in grammars. Each language definition registers metadata eagerly (a few bytes) and `onLanguageEncountered` + `registerTokensProviderFactory` defer the grammar import — typically a dynamic `import('./typescript')` that becomes a Vite/Rollup chunk.

A historical bug (microsoft/monaco-editor#2750) caused `onLanguage` to fire eagerly for all languages due to a parameter-name shadow; that was fixed long before Monaco 0.30.x. The current implementation is reliable.

### Finding 6: VS Code's `onLanguage:<id>` activation event is the canonical inspiration

VS Code extensions declare `activationEvents: ["onLanguage:python"]` in `package.json` to defer extension activation until the first Python file opens. The extension host then runs `extension.activate(context)` exactly once. The pattern is the gold standard for "boot LSP only when needed" and the registry can mirror it directly: each contribution declares the language IDs it gates on, and the registry subscribes to `onLanguage` for each.

VS Code's documentation explicitly warns against the generic `onLanguage` (no ID) form because it activates on _any_ language. We adopt the specific form.

### Finding 7: Existing two-phase contract maps cleanly to lazy activation

The `LanguageContribution` interface (`apps/ui/app/lib/monaco-language-registry.ts:39-53`) already separates `register` from `activate`. The two phases align with VS Code:

| Phase               | Today                                                   | Target                                                                |
| ------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| `register(monaco)`  | Language metadata, syntax config                        | Same (eager — needed for URI → languageId resolution)                 |
| `activate(context)` | Provider registration, LSP boot, ATA — runs immediately | Defers to `onLanguage` for the contribution's `activationLanguageIds` |

The change is local to `LanguageContributionRegistry.activate`. Each contribution's `activate(context)` body is unchanged; the registry just delays calling it.

### Finding 8: Per-kernel routing alone is insufficient

`packages/runtime/src/kernels/*/*.plugin.ts` declare extensions arrays:

| Kernel                        | Extensions                    |
| ----------------------------- | ----------------------------- |
| `zoo` (KCL)                   | `['kcl']`                     |
| `replicad`                    | `['ts', 'js']`                |
| `opencascade`                 | `['ts', 'js']`                |
| `manifold`                    | `['ts', 'js']`                |
| `jscad`                       | `['ts', 'js']`                |
| `tau` (importer)              | `[...supportedImportFormats]` |
| `openscad` (separate package) | `['scad']`                    |

A naive "load LSP for the active kernel only" rule would be wrong:

- A Replicad project may have a `.json` parameter file open → JSON LSP needed.
- A user may open a `.kcl` reference snippet inside a Replicad project for inspiration → KCL LSP needed even though the active kernel is Replicad.
- The active kernel can switch at runtime; activation must be additive (load on first encounter) and idempotent, not "swap on kernel change".

The active-kernel signal is therefore a useful **prefetch hint** (preload the LSP that's likely to be used first) but not the gate. The gate must be model presence.

### Finding 9: VS Code's `requestRichLanguageFeatures` is the upstream of Monaco's `onLanguage`

A read of the VS Code source at `repos/vscode/` confirms that Monaco's `monaco.languages.onLanguage(id, cb)` is a thin shim over the same primitive VS Code itself uses internally. The full call chain is:

```
TextModel constructor / TextModel._setLanguage
  → ILanguageService.requestRichLanguageFeatures(languageId)
     → if (_requestedRichLanguages.has(id)) return;     // dedup Set
       _requestedRichLanguages.add(id);
       requestBasicLanguageFeatures(id);                 // cascade
       TokenizationRegistry.getOrCreate(id);             // resolve tokens factory
       _onDidRequestRichLanguageFeatures.fire(id);
```

Verified in:

| File                                                                   | Lines          | What it shows                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repos/vscode/src/vs/editor/common/services/languageService.ts`        | 29–31, 130–149 | `_requestedBasicLanguages` and `_requestedRichLanguages` Sets enforce per-id idempotency; the events `onDidRequestBasicLanguageFeatures` / `onDidRequestRichLanguageFeatures` only fire on the first request. |
| `repos/vscode/src/vs/editor/common/model/textModel.ts`                 | 406, 2101      | `TextModel` calls `requestRichLanguageFeatures(languageId)` from both its constructor (initial language) and `_setLanguage` (language change). Every model creation or language switch is the trigger.        |
| `repos/vscode/src/vs/editor/standalone/browser/standaloneLanguages.ts` | 53–69          | The public `monaco.languages.onLanguage(id, cb)` is implemented by subscribing to `onDidRequestRichLanguageFeatures` and self-disposing once `encounteredLanguageId === languageId`.                          |
| `repos/vscode/src/vs/editor/standalone/browser/standaloneLanguages.ts` | 72–90          | `monaco.languages.onLanguageEncountered` similarly wraps `onDidRequestBasicLanguageFeatures`.                                                                                                                 |

**Implication for the blueprint:** the gating primitive is correct and stable. The contract we depend on is in the editor core, not a fragile standalone-only adapter.

### Finding 10: VS Code splits "basic" from "rich" language features for finer-grained deferral

`requestBasicLanguageFeatures` and `requestRichLanguageFeatures` are two separate emitters with two separate dedup Sets, and `requestRichLanguageFeatures` cascades into `requestBasicLanguageFeatures` (see `languageService.ts:140–142`). VS Code uses this two-tier split deliberately:

| Tier      | Trigger                                             | Used for                                                                                                                                                                            | VS Code wiring                                                                                                                                                                                                                        |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Basic** | `requestBasicLanguageFeatures`                      | Loading `language-configuration.json` (brackets, comments, autoclose), implicit `onLanguage:<id>` activation event delivery to extensions, TextMate embedded-language announcements | `LanguageConfigurationFileHandler` subscribes to `onDidRequestBasicLanguageFeatures` (`repos/vscode/src/vs/workbench/contrib/codeEditor/common/languageConfigurationExtensionPoint.ts:104–108`)                                       |
| **Rich**  | `requestRichLanguageFeatures` (cascades into Basic) | Tokenizer factory resolution, full provider registration, language servers                                                                                                          | `_workbench.LanguageService` subscribes to `onDidRequestRichLanguageFeatures` and calls `_extensionService.activateByEvent('onLanguage:${id}')` (`repos/vscode/src/vs/workbench/services/language/common/languageService.ts:287–291`) |

**Implication for the blueprint:** Tau's contributions today have a single `activate` step. Adopting the basic/rich split lets us reserve the `Basic` tier for cheap config (e.g. KCL's `setLanguageConfiguration`) and gate only expensive boot (LSP worker, WASM, ATA) behind the `Rich` tier. In practice, since `requestRichLanguageFeatures` cascades into `requestBasicLanguageFeatures`, a single `monaco.languages.onLanguage(id, ...)` subscription is sufficient — both tiers fire by the time it runs. The split matters if we later want a cheaper "syntax-only" pass before the full LSP, e.g. for preview-style readers that should never spawn a worker.

### Finding 11: Activation is deduplicated at three layers in VS Code

Even with `_requestedRichLanguages` dedup at the editor core, VS Code adds two more dedup layers around extension activation. The full stack ensures that 50 simultaneously-opened `.kcl` files in one window cause **one** activation, not 50:

| Layer                                     | Mechanism                                                                                                                                                          | Source                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 1. Editor core                            | `Set<string>` of requested language ids — event fires at most once per id                                                                                          | `repos/vscode/src/vs/editor/common/services/languageService.ts:29–31, 130–149`                    |
| 2. Extension host manager (renderer side) | `_cachedActivationEvents: Map<event, Promise<void>>` — multiple `activateByEvent('onLanguage:kcl')` calls await the same Promise                                   | `repos/vscode/src/vs/workbench/services/extensions/common/extensionHostManager.ts:327–356`        |
| 3. Extension host (worker side)           | `_alreadyActivatedEvents: Record<string, true>` plus per-extension `ActivationOperation` reuse — the IPC short-circuits even if the renderer-side cache is cleared | `repos/vscode/src/vs/workbench/api/common/extHostExtensionActivator.ts:168–188, 217–228, 250–260` |

**Implication for the blueprint:** Layer 1 is exactly what `monaco.languages.onLanguage` already gives us. Layers 2 and 3 are overkill for our in-process Monaco setup — there is no IPC boundary, no separate extension host. But the `activated` flag closure in our proposed `runActivate()` (see [Target Architecture](#target-architecture)) plays the role of Layer 2 cache for the multi-id case (JS/TS gates on four ids; only the first encounter should activate). R3 already covers this; the VS Code reading just confirms the pattern.

### Finding 12: VS Code's TypeScript extension uses double deferral — `onLanguage` for activation, first matching document for `tsserver` spawn

VS Code's TypeScript extension is the closest analogue to Tau's KCL contribution. Its `package.json` declares `activationEvents: ["onLanguage:javascript", "onLanguage:typescript", ...]`, but the extension does **not** spawn `tsserver` on activation. Instead:

1. `extension.ts:80` constructs a `Lazy<TypeScriptServiceClientHost>` via `createLazyClientHost` — the host is a thunk; `tsserver` is **not** spawned yet.
2. `extension.ts:104` passes the lazy host to `lazilyActivateClient`, which:
   - Iterates `vscode.workspace.textDocuments` and checks `isSupportedDocument(supportedLanguage, doc)` (`lazyClientHost.ts:80`).
   - If a matching `.ts`/`.js` file is already open (e.g. workspace restore), forces the lazy: `void lazyClientHost.value` (line 70) — that's when `new TypeScriptServiceClientHost(...)` runs and `tsserver` boots.
   - Otherwise registers `vscode.workspace.onDidOpenTextDocument(maybeActivate)` and waits (line 82–86).
3. The `hasActivated` boolean (line 63) ensures the spawn happens exactly once.

```64:78:repos/vscode/extensions/typescript-language-features/src/lazyClientHost.ts
const maybeActivate = (textDocument: vscode.TextDocument): boolean => {
  if (!hasActivated && isSupportedDocument(supportedLanguage, textDocument)) {
    hasActivated = true;

    onActivate().then(() => {
      // Force activation
      void lazyClientHost.value;

      disposables.push(new ManagedFileContextManager(activeJsTsEditorTracker));
    });

    return true;
  }
  return false;
};
```

This is a **double-deferral**: the extension itself activates on `onLanguage` (so it can register commands and language descriptions), but the heavyweight `tsserver` process spawn waits for an actual matching `TextDocument`. Identical reasoning applies to KCL: registering completion/hover/definition providers at `onLanguage:kcl` is cheap; spawning the KCL LSP worker, downloading the WASM, and processing stdlib is not. The Promise the user sees as "first .kcl keystroke is laggy" can be moved off the synchronous `activate` boundary.

**Implication for the blueprint:** add a third optional tier inside `kclContribution.activate` that registers providers (cheap) but defers `new KclLspClient(...)` and `initializeSymbolServiceWasm()` until the first `.kcl` model is **actually** present (not just registered as a possible language). For Tau this is essentially a no-op vs the current blueprint because `monaco.languages.onLanguage('kcl', ...)` already fires only when a model exists — but for kernels where activation has both "register providers" and "spawn worker" sub-steps, the pattern is worth preserving as a contribution-author convention.

### Finding 13: VS Code's language-configuration JSON is fetched lazily on `onDidRequestBasicLanguageFeatures`

`LanguageConfigurationFileHandler` (`repos/vscode/src/vs/workbench/contrib/codeEditor/common/languageConfigurationExtensionPoint.ts:89–150`) subscribes to `onDidRequestBasicLanguageFeatures`, then `await whenInstalledExtensionsRegistered()`, then calls `_loadConfigurationsForMode(languageId)` which uses `IExtensionResourceLoaderService.readExtensionResource` to fetch the JSON. A content hash in `_done` prevents re-reads. JSON parse errors log to console — they do not surface to the user.

**Implication for the blueprint:** If we ever externalise OpenSCAD/STEP/STL/USD language configuration into JSON files (e.g. for community contribution), we can apply the same `onDidRequestBasicLanguageFeatures` deferral plus a content-hash dedup. Today these are inlined in TS modules so the dedup lives at the import boundary; the pattern is on standby for a future evolution.

### Finding 14: VS Code surfaces activation telemetry via well-known performance marks

The standardised mark names that drive VS Code's "Developer: Startup Performance" command and `extensionActivationTimes` telemetry:

| Mark                                                                                                                                             | Source                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `code/willLoadExtensions`, `code/didLoadExtensions`                                                                                              | `repos/vscode/src/vs/workbench/services/extensions/common/abstractExtensionService.ts:465, 477–478` |
| `code/willHandleExtensionPoints`, `code/willHandleExtensionPoint/<name>`, `code/didHandleExtensionPoint/<name>`, `code/didHandleExtensionPoints` | `abstractExtensionService.ts:1164–1172`                                                             |
| `code/extHost/willActivateExtension/<id>`, `code/extHost/didActivateExtension/<id>`                                                              | `repos/vscode/src/vs/workbench/api/common/extHostExtensionService.ts:493–496`                       |
| Telemetry event `extensionActivationTimes` with fields `codeLoadingTime`, `activateCallTime`, `activateResolvedTime`, `outcome`                  | `extHostExtensionService.ts:441–464`                                                                |

The `workspaceContains:` activation event is governed by `WORKSPACE_CONTAINS_TIMEOUT = 7000ms` (`repos/vscode/src/vs/workbench/services/extensions/common/workspaceContains.ts:18, 90–93`) — if the glob search exceeds 7s, the extension activates anyway. The eager-startup gate is `Promise.race([eager, timeout(10000)])` before `onStartupFinished` fires (`extHostExtensionService.ts:670–684`).

**Implication for the blueprint:** R10 should adopt the `code/willActivate*` / `code/didActivate*` naming convention so the marks are recognisable to anyone familiar with VS Code traces and so that future tooling (e.g. an in-app "Startup Performance" panel) can reuse the same scrape logic.

## Target Architecture

### Activation Triggers

```
┌────────────────────────────────────────────────────────────────────┐
│  configureMonaco() — module load                                  │
│  ───────────────────────────────────────────────────────────────  │
│  • Monaco core import                                             │
│  • registry.registerAll(monaco)  ← Phase 1 only                   │
│  • Shiki + theme setup                                            │
│  • JSON tokenizer override                                        │
│                                                                    │
│  NO LSP boots. NO WASM downloads. NO ATA.                         │
└────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  MonacoModelServiceProvider — mount                               │
│  ───────────────────────────────────────────────────────────────  │
│  • registry.activate(context) ← arms onLanguage subscriptions     │
│  • For each contribution: subscribe to onLanguage(id) for every   │
│    id in contribution.activationLanguageIds                        │
│                                                                    │
│  Contributions DO NOT run their activate body yet.                │
│  Only cheap event subscription happens.                            │
└────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  First model with matching languageId is created                  │
│  ───────────────────────────────────────────────────────────────  │
│  Monaco fires onLanguage(id) → registry runs                      │
│  contribution.activate(context) for the matching contribution     │
│  ONCE.  Subsequent encounters are no-ops.                          │
│                                                                    │
│  KCL LSP, JS/TS ATA, etc. boot here — and only here.              │
└────────────────────────────────────────────────────────────────────┘
```

### Updated `LanguageContribution` Interface

```typescript
export type LanguageContribution = {
  readonly languageId: string;

  /**
   * Language IDs that, when first encountered in a Monaco model, should
   * trigger this contribution's activate(). Defaults to [languageId].
   *
   * Contributions covering multiple Monaco language IDs (e.g., the JS/TS
   * contribution gates on typescript, javascript, typescriptreact,
   * javascriptreact) declare them all here.
   */
  readonly activationLanguageIds?: readonly string[];

  /** Phase 1: language metadata. Runs during configureMonaco(). */
  register(monaco: typeof Monaco): void;

  /**
   * Phase 2: providers, LSP boot, ATA. Runs ONCE on the first encounter
   * of any activationLanguageIds (deferred via monaco.languages.onLanguage).
   */
  activate(context: ActivationContext): ActivationResult;

  onProjectSessionChange?(projectId: string): void;
  dispose(): void;
};
```

### Updated `LanguageContributionRegistry.activate`

```typescript
public activate(context: ActivationContext): NavigationHandler[] {
  if (this.lastActivatedEpoch >= this.activationEpoch) {
    return this.currentHandlers;
  }

  this.disposeActivation();
  this.currentHandlers = [];

  for (const contribution of this.contributions.values()) {
    const ids = contribution.activationLanguageIds ?? [contribution.languageId];
    let activated = false;

    const runActivate = (): void => {
      if (activated) return;
      activated = true;

      try {
        const result = contribution.activate(context);
        this.activationDisposables.push(...result.disposables);
        if (result.navigationHandler) {
          this.currentHandlers.push(result.navigationHandler);
        }
      } catch (error) {
        console.error(
          `Failed to activate language contribution "${contribution.languageId}":`,
          error,
        );
      }
    };

    // Fast path: if any matching model already exists, activate immediately.
    const hasExistingModel = context.monaco.editor
      .getModels()
      .some((model) => ids.includes(model.getLanguageId()));

    if (hasExistingModel) {
      runActivate();
      continue;
    }

    // Defer: activate on first encounter of any matching language.
    for (const id of ids) {
      const disposable = context.monaco.languages.onLanguage(id, runActivate);
      this.activationDisposables.push(disposable);
    }
  }

  this.lastActivatedEpoch = this.activationEpoch;
  return this.currentHandlers;
}
```

The key invariants:

- **Fast path** for already-open models keeps split-view restore and direct route deep-links working (a user navigating to `/projects/xyz/edit?file=foo.kcl` will already have a `.kcl` model in `monaco.editor.getModels()` by the time `activate` runs).
- **Idempotency** preserved by the `activated` closure flag — `onLanguage` fires once per ID, but a contribution gating on multiple IDs (JS/TS) still activates exactly once.
- **Disposable hygiene** — both the `onLanguage` disposable (for unmounted contributions whose language never opens) and the contribution's own `result.disposables` flow through `activationDisposables`.

### Per-Contribution Activation IDs

| Contribution           | `activationLanguageIds`                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `kclContribution`      | `['kcl']`                                                            |
| `openscadContribution` | `['openscad']`                                                       |
| `stepfileContribution` | `['stepfile']`                                                       |
| `stlContribution`      | `['stl']`                                                            |
| `usdContribution`      | `['usd']`                                                            |
| `jsTsContribution`     | `['typescript', 'javascript', 'typescriptreact', 'javascriptreact']` |

### Required Refactor of KCL Contribution

`kclContribution.register` currently calls `initializeLsp(monaco)`. That call must move into `activate`. The split is mechanical:

| Stays in `register(monaco)`                                         | Moves to `activate(context)`                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `monaco.languages.register({ id: 'kcl', extensions: ['.kcl'], … })` | `new KclLspClient({...})` + `lspClient.initialize()` + `waitForReady()` |
| `monaco.languages.setLanguageConfiguration('kcl', { ... })`         | All eight `monaco.languages.register*Provider` calls                    |
|                                                                     | `setupDocumentSync(monaco, lspClient)`                                  |
|                                                                     | `void initializeSymbolServiceWasm()`                                    |
|                                                                     | Module-level `monacoInstance = monaco` (move to activate)               |

This change preserves correctness for the only existing entry point — `MonacoModelServiceProvider` already calls `registry.activate(...)` after `configureMonaco()` runs `registry.registerAll(...)`.

If additional work inside `activate()` is moved behind `queueMicrotask` (or another deferral) so the method returns synchronously, anything the deferred path needs — especially `ActivationContext.fileManager` and other handles passed only during `activate` — must still be stored before the microtask runs. A real regression from deferring LSP boot without persisting the file manager is analyzed in [`kcl-monaco-lsp-file-manager-wiring.md`](kcl-monaco-lsp-file-manager-wiring.md).

### Active-Kernel Prefetch Hint (Optional)

To smooth the first-keystroke latency for the dominant case, `MonacoModelServiceProvider` can call `registry.prefetch(extensionsForActiveKernel)` once `runtimeClient` reports the active kernel:

```typescript
useEffect(() => {
  if (!runtimeClient || !services.modelService) return;

  const unsubscribe = runtimeClient.on('activeKernelChanged', (event) => {
    const monacoIds = event.kernel.extensions
      .map((ext) => extensionToMonacoLanguage[ext])
      .filter((id): id is MonacoLanguage => id !== undefined);

    registry.prefetch(monacoIds);
  });

  return unsubscribe;
}, [runtimeClient, services.modelService]);
```

Where `prefetch(ids)` synthesises a transient model with the language ID (`monaco.editor.createModel('', id)` then immediately `dispose`) to fire `onLanguage` deterministically — the same trick Monaco uses in its `loadLanguage(id)` helper. This is purely an optimisation; correctness comes from the model-encounter gate.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                              | Priority | Effort  | Impact                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------------------------------------------------------------------------------- |
| R1  | Split `kclContribution.register` so `initializeLsp` + provider registration moves into `activate` (keep `monaco.languages.register({ id, extensions, ... })` and `setLanguageConfiguration` in `register`).                                                                                                                                                                                         | P0       | Low     | High — eliminates KCL WASM/worker boot for non-KCL projects                     |
| R2  | Add optional `activationLanguageIds: readonly string[]` to `LanguageContribution`.                                                                                                                                                                                                                                                                                                                  | P0       | Trivial | Enables R3                                                                      |
| R3  | Rewrite `LanguageContributionRegistry.activate` to subscribe via `monaco.languages.onLanguage` per `activationLanguageIds` with a fast path for already-open models, and defer the contribution body until first encounter (see [Target Architecture](#target-architecture)).                                                                                                                       | P0       | Low     | High — cuts every contribution's eager activation cost                          |
| R4  | Set `jsTsContribution.activationLanguageIds = ['typescript','javascript','typescriptreact','javascriptreact']` so ATA + four definition providers + four `addExtraLib` payloads only register on first JS/TS model.                                                                                                                                                                                 | P0       | Trivial | High — removes ATA from KCL/OpenSCAD-only sessions                              |
| R5  | Set `kclContribution.activationLanguageIds = ['kcl']` (after R1).                                                                                                                                                                                                                                                                                                                                   | P0       | Trivial | Pairs with R1                                                                   |
| R6  | Set per-contribution `activationLanguageIds` for OpenSCAD/STEP/STL/USD (default suffices but explicit declaration is self-documenting).                                                                                                                                                                                                                                                             | P1       | Trivial | Low — already cheap                                                             |
| R7  | Add a `registry.prefetch(ids)` API that creates+disposes throwaway models to deterministically fire `onLanguage` for the active kernel's languages. Wire from `MonacoModelServiceProvider` on the `activeKernelChanged` event.                                                                                                                                                                      | P1       | Low     | Medium — eliminates first-keystroke latency on the dominant code path           |
| R8  | Add a unit test in `monaco-language-registry.test.ts` asserting that no contribution's `activate` runs until `monaco.editor.createModel('', languageId)` is called, and that subsequent encounters do not re-activate.                                                                                                                                                                              | P0       | Low     | High — locks in the contract                                                    |
| R9  | Update `apps/ui/app/lib/monaco.lib.ts` doc comment to record the new "register-eager / activate-lazy" contract and link this research doc.                                                                                                                                                                                                                                                          | P2       | Trivial | Low                                                                             |
| R10 | Add a perf mark pair around `runActivate()` using VS Code's naming convention (`code/willActivateLanguage/<id>` and `code/didActivateLanguage/<id>`) so the marks are immediately recognisable to anyone familiar with VS Code traces and so future tooling can reuse the same scrape logic (Finding 14).                                                                                           | P2       | Low     | Medium — observability for future regressions                                   |
| R11 | Adopt VS Code's TypeScript-extension double-deferral pattern inside `kclContribution.activate` (Finding 12): on first `onLanguage:kcl` fire, register cheap providers synchronously but kick `initializeLsp` (worker + WASM + stdlib) into a microtask. Document the convention in `monaco-language-registry.ts` JSDoc so future kernels follow it.                                                 | P1       | Low     | Medium — moves the unavoidable LSP boot off the synchronous activation boundary |
| R12 | When a `contribution.activate` throws, surface a one-shot dismissable toast via the existing notification service rather than only `console.error`-ing — mirrors VS Code's dev-mode `notificationService.error` path in `mainThreadExtensionService.$onExtensionActivationError` (`abstractExtensionService.ts:1285–1299`). Today silent failures look identical to "no LSP available" to the user. | P2       | Low     | Medium — diagnosability                                                         |
| R13 | Add a contract test asserting that `monaco.editor.createModel('', 'kcl')` followed by `model.setLanguage('typescript')` causes both `kcl` and `typescript` contributions to activate exactly once (locks in the `_setLanguage`-triggered `requestRichLanguageFeatures` semantics from Finding 9).                                                                                                   | P1       | Low     | Medium — guards against future regression of the language-switch path           |
| R14 | (Optional, future) If/when we externalise `language-configuration.json` for OpenSCAD/STEP/STL/USD into JSON files for community contribution, mirror VS Code's `LanguageConfigurationFileHandler` pattern (Finding 13): subscribe to `monaco.languages.onLanguage`, fetch via `fetch()`, dedup by content hash.                                                                                     | P3       | Medium  | Low — enables future externalisation without re-architecting                    |

## Trade-offs

### Lazy activation vs eager pre-warming

| Dimension                                  | Lazy (recommended)                                          | Eager (status quo)                          |
| ------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------- |
| Cold-start CPU                             | Pays only what's needed                                     | Pays everything always                      |
| First-keystroke latency in active language | Brief delay on first model open (mitigated by R7 prefetch)  | Zero — already booted                       |
| Memory footprint                           | Per-language proportional to use                            | Always all five LSPs + KCL WASM in memory   |
| Predictability for tests                   | Activation is observable via `onLanguage`                   | Activation is unconditional but synchronous |
| Provider duplication risk                  | Same — `activated` flag + epoch guard preserves idempotency | Same                                        |

### Per-language `onLanguage` vs reactive model scan

Alternative: subscribe to `monaco.editor.onDidCreateModel` and scan `model.getLanguageId()`. Rejected because:

- Monaco's `onLanguage` fires before any provider is asked to do work; manual `onDidCreateModel` requires us to introspect the language ID after model creation (race if the language was inferred from URI vs explicit `setModelLanguage`).
- `onLanguage` auto-stops listening once fired (per the implementation in `standaloneLanguages.js`), so there's no per-event filtering cost.
- VS Code uses the same primitive — alignment with upstream pattern reduces bus-factor risk.

### Active-kernel routing vs model-encounter gate

| Approach                               | Pros                                     | Cons                                             |
| -------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| Active-kernel only                     | Predictable, tied to user intent         | Wrong: misses `.json`/`.kcl`/cross-kernel files  |
| Model-encounter only                   | Always correct                           | First open in a language pays activation latency |
| Model-encounter + kernel prefetch (R7) | Always correct + dominant case is warmed | Marginal extra complexity in provider            |

The blueprint chooses the third: model-encounter is the gate (correctness); kernel-prefetch is a hint (latency).

### Fail-open vs fail-closed on activation error

Status quo wraps `contribution.activate` in `try/catch` and continues to next contribution. The new design preserves this semantics — a KCL boot failure must not break TypeScript editing. Add a one-shot warning toast (deferred to a follow-up) so silent failures don't regress UX.

## Migration Path

1. **Step 1 — Registry change (R2 + R3 + R8).** Extend `LanguageContribution` with `activationLanguageIds`, rewrite `activate` to subscribe via `onLanguage`, update tests. All contributions still default to `[languageId]` so no behavioural change yet (every contribution still activates on first model creation, but they all activate on _their own_ language IDs eagerly because there are existing models for nothing yet — this step alone is a no-op for fresh projects).

2. **Step 2 — KCL split (R1 + R5).** Move `initializeLsp` from `register` to `activate`. Verify the integration test (`kcl-lsp-integration.test.ts`) still passes by explicitly creating a `.kcl` model before asserting LSP behaviour.

3. **Step 3 — JS/TS gating (R4).** Set `jsTsContribution.activationLanguageIds = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact']`. Verify Replicad, OpenCascade, JSCAD, Manifold projects still gain ATA when a `.ts` file opens.

4. **Step 4 — Verify KCL/SCAD/USD/STL/STEP (R6).** Add explicit `activationLanguageIds` (matching `[languageId]`) for self-documentation.

5. **Step 5 — Prefetch hint (R7).** Wire `runtimeClient.on('activeKernelChanged')` to `registry.prefetch(monacoIdsForKernel)` in `MonacoModelServiceProvider`. Implement `registry.prefetch(ids)` as a `monaco.editor.createModel('', id).dispose()` loop with idempotency.

6. **Step 6 — Observability (R10).** Add `performance.mark` around `runActivate`. Capture a baseline trace from a Replicad project before R1, and a comparison trace after R3+R4+R5 for the ui-startup performance research doc.

Each step is independently testable and revertible. The blueprint can ship as a single PR but is structured to allow staged rollout if the KCL split surfaces hidden coupling.

## Code Examples

### Before: eager activation (status quo)

```typescript
// apps/ui/app/lib/kcl-language/kcl-register-language.ts (lines 361-412, abridged)
export function registerKclLanguage(monaco: typeof Monaco): void {
  if (isRegistered) return;
  isRegistered = true;
  monacoInstance = monaco;

  monaco.languages.register({ id: 'kcl', extensions: ['.kcl'], ... });
  monaco.languages.setLanguageConfiguration('kcl', { ... });

  void initializeLsp(monaco);  // ← spawns worker, downloads WASM, processes stdlib
}

export const kclContribution: LanguageContribution = {
  languageId: 'kcl',
  register(monaco) { registerKclLanguage(monaco); },
  activate(context) {
    // Side-effects of LSP already happened in register()
    setKclLspFileManager({ ... });
    return { disposables: [], navigationHandler: { canHandle: (p) => p.endsWith('.kcl') } };
  },
  ...
};
```

### After: deferred activation

```typescript
// apps/ui/app/lib/kcl-language/kcl-register-language.ts (target)
export function registerKclLanguage(monaco: typeof Monaco): void {
  if (isRegistered) return;
  isRegistered = true;

  monaco.languages.register({ id: 'kcl', extensions: ['.kcl'], ... });
  monaco.languages.setLanguageConfiguration('kcl', { ... });
  // No LSP, no WASM here.
}

export const kclContribution: LanguageContribution = {
  languageId: 'kcl',
  activationLanguageIds: ['kcl'],

  register(monaco) { registerKclLanguage(monaco); },

  activate(context): ActivationResult {
    monacoInstance = context.monaco;
    globalMarkerService = context.markerService;

    // Boot LSP + WASM + providers ONLY when a .kcl model first appears.
    void initializeLsp(context.monaco);

    setKclLspFileManager({
      readFile: async (path) => context.fileManager.readFile(path),
      exists: async (path) => context.fileManager.exists(path),
      readdir: async (path) => context.fileManager.readdir(path),
    });

    return {
      disposables: activationDisposables,
      navigationHandler: { canHandle: (p) => p.endsWith('.kcl') },
    };
  },
  ...
};
```

### Test contract (R8)

```typescript
// apps/ui/app/lib/monaco-language-registry.test.ts
it('does not run activate for a contribution whose language has no models', () => {
  const activate = vi.fn(() => ({ disposables: [] }));
  const contribution: LanguageContribution = {
    languageId: 'kcl',
    activationLanguageIds: ['kcl'],
    register: vi.fn(),
    activate,
    dispose: vi.fn(),
  };

  const monaco = makeMonacoStub({ models: [], onLanguage: stubOnLanguage() });
  const registry = new LanguageContributionRegistry();
  registry.addContribution(contribution);
  registry.registerAll(monaco);

  registry.activate({ monaco, ... });

  expect(activate).not.toHaveBeenCalled();
});

it('activates a contribution when a matching model is created', () => {
  // ... same setup ...
  const triggerOnLanguage = monaco.__triggerOnLanguage; // test stub
  triggerOnLanguage('kcl');

  expect(activate).toHaveBeenCalledTimes(1);
});

it('activates each contribution at most once even with multiple matching languages', () => {
  const contribution: LanguageContribution = {
    languageId: 'typescript',
    activationLanguageIds: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    ...
  };
  // ... fire all four onLanguage events ...
  expect(activate).toHaveBeenCalledTimes(1);
});
```

## Diagrams

### Provider mount sequence (target)

```
configureMonaco()         registry.registerAll()         (no LSP work)
       │                          │
       ▼                          ▼
MonacoModelServiceProvider mount  ─►  registry.activate(context)
                                         │
                                         ├─► for each contribution:
                                         │     ├─► hasExistingModel? → run activate immediately
                                         │     └─► else: monaco.languages.onLanguage(id, runActivate)
                                         │
                                         ▼
                                    (idle — no KCL/JS/TS work)
                                         │
                                         ▼
              user opens main.kcl  ─►  monaco.editor.createModel(uri, 'kcl')
                                         │
                                         ▼
                              monaco fires onLanguage('kcl')
                                         │
                                         ▼
                              registry's runActivate() runs
                                         │
                                         ▼
                          KCL: initializeLsp + register providers + WASM
```

### Contribution activation matrix (illustrative cold start, Replicad project)

| Contribution           | Status today                    | Status after blueprint                       |
| ---------------------- | ------------------------------- | -------------------------------------------- |
| `jsTsContribution`     | activated (correct)             | activated on first `.ts` open (correct)      |
| `kclContribution`      | activated (waste — no `.kcl`)   | not activated (saves WASM + worker + stdlib) |
| `openscadContribution` | activated (waste — no `.scad`)  | not activated                                |
| `stepfileContribution` | activated (cheap but pointless) | not activated                                |
| `stlContribution`      | activated (cheap but pointless) | not activated                                |
| `usdContribution`      | activated (cheap but pointless) | not activated                                |

## References

- Monaco Editor source: `microsoft/monaco-editor` `src/languages/definitions/_.contribution.ts` — canonical `LazyLanguageLoader` + `registerTokensProviderFactory` + `onLanguageEncountered` pattern.
- Monaco Editor public API: `monaco.languages.onLanguage(id, callback): IDisposable` — fires once when first model with that language is needed.
- VS Code extension activation events spec: [`onLanguage:<id>` activation event](https://code.visualstudio.com/api/references/activation-events#onLanguage).
- Monaco issue [#2750](https://github.com/microsoft/monaco-editor/issues/2750) — historical `onLanguage` early-eager firing bug, fixed long before current Monaco version.
- Monaco issue [#2084](https://github.com/microsoft/monaco-editor/issues/2084) — provider duplicate-registration pitfall (mitigated by our `activated` flag + epoch guard).
- TypeFox blog: "Teaching the Language Server Protocol to Microsoft's Monaco Editor" — confirms `monaco-languageclient` defers LSP startup until provider-registration time, which the blueprint subsumes.
- VS Code source (read against `repos/vscode/`):
  - `src/vs/editor/common/services/languageService.ts:29–149` — the canonical `requestBasicLanguageFeatures` / `requestRichLanguageFeatures` two-tier dedup that Monaco's `onLanguage` and `onLanguageEncountered` wrap.
  - `src/vs/editor/common/model/textModel.ts:406, 2101` — every `TextModel` constructor and `_setLanguage` call funnels through `requestRichLanguageFeatures`; this is the trigger the blueprint relies on.
  - `src/vs/editor/standalone/browser/standaloneLanguages.ts:53–90` — the implementation of `monaco.languages.onLanguage` and `onLanguageEncountered` we depend on.
  - `src/vs/workbench/services/extensions/common/extensionHostManager.ts:327–356` and `src/vs/workbench/api/common/extHostExtensionActivator.ts:168–228, 250–260` — three-layer activation dedup pattern (Finding 11).
  - `extensions/typescript-language-features/src/lazyClientHost.ts:23–100` and `src/extension.ts:80, 104` — the `Lazy<TypeScriptServiceClientHost>` + `lazilyActivateClient` double-deferral pattern (Finding 12, R11).
  - `src/vs/workbench/contrib/codeEditor/common/languageConfigurationExtensionPoint.ts:89–150` — `LanguageConfigurationFileHandler` lazy JSON fetch on `onDidRequestBasicLanguageFeatures` (Finding 13, R14).
  - `src/vs/workbench/services/extensions/common/abstractExtensionService.ts:465, 477–478, 989–1064, 1164–1172, 1285–1299`, `extHostExtensionService.ts:441–496, 670–684`, `workspaceContains.ts:18, 90–93` — performance marks, telemetry events, and activation budgets (Finding 14, R10).
- Tau related docs:
  - `docs/research/monaco-intellisense-jsdoc-rendering.md` — overlay widget styling that survives unchanged.
  - `docs/research/ui-startup-performance-gap-analysis.md` — broader UI startup audit; this blueprint addresses the Monaco-shaped gap.
  - `docs/research/kernel-plugin-type-linkage.md` — kernel `extensions` arrays consumed by R7 prefetch.

## Appendix: Per-Language Activation Cost Inventory

Costs are estimated at cold start for a project with no matching files. "Network" includes WASM + chunked dynamic imports. "CPU" is the synchronous portion of `activate`.

| Contribution           | Files imported during `activate`                                                                                                                                                                     | Network cost                                                                           | CPU cost                                                                                                | Notes                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `kclContribution`      | `@taucad/kcl-wasm-lib` (multi-MB WASM), `@taucad/kcl-wasm-lib/kcl.wasm?url`, `@taucad/runtime/kernels/zoo/engine-connection`, eight provider modules, `kcl-lsp-worker.ts` (own bundle)               | High — KCL WASM + worker bundle + dynamic-imported engine-connection + JSON-RPC client | High — LSP handshake, mock context build, stdlib processing                                             | Largest single contributor to startup waste; documented in screenshot          |
| `jsTsContribution`     | `monaco-editor`'s built-in TS worker (already loaded), `kernelTypeMaps` from `@taucad/api-extractor` (replicad + opencascade + jscad + manifold `.d.ts` payloads), `TypeAcquisitionService` watchers | Medium — type-map JSON payloads (replicad alone is the largest `.d.ts` in the repo)    | Medium — `addExtraLib` × N modules, four `registerDefinitionProvider` calls, model-watcher subscription | Justified for Replicad/OCT/JSCAD/Manifold but pure waste for KCL/OpenSCAD-only |
| `openscadContribution` | `openscad-completions.js`, `openscad-hover.js`, `openscad-language.js`, `openscad-signature-help.js`, `openscad-definition.js`                                                                       | Low — pure JS, no WASM                                                                 | Low — sync provider registration                                                                        | Cheap; gated for hygiene only                                                  |
| `stepfileContribution` | none beyond contribution module                                                                                                                                                                      | Negligible                                                                             | Negligible                                                                                              | Metadata only                                                                  |
| `stlContribution`      | none beyond contribution module                                                                                                                                                                      | Negligible                                                                             | Negligible                                                                                              | Metadata only                                                                  |
| `usdContribution`      | none beyond contribution module                                                                                                                                                                      | Negligible                                                                             | Negligible                                                                                              | Metadata only                                                                  |

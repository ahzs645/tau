---
title: 'Binary File Open Perpetual Loading: Root Cause and VS Code-Inspired Fix'
description: 'Why opening a GLB (or any >1 MB binary) in the editor never advances past the spinner, and how VS Code architecturally avoids this class of bug.'
status: active
created: '2026-04-20'
updated: '2026-04-20'
category: investigation
related:
  - docs/policy/filesystem-policy.md
---

# Binary File Open Perpetual Loading: Root Cause and VS Code-Inspired Fix

Investigation into why opening a `.glb` (or any binary file larger than 1 MiB) in the project editor leaves the panel stuck on the loader, and how VS Code's editor input / model layer is structured to make this bug structurally impossible.

## Executive Summary

`FileEditor` in `chat-editor-dockview.tsx` gates _every_ render branch — including the binary-warning placeholder — on `fileContent` being a truthy `Uint8Array`. Content reaches the component through `useFileContent` → `FileContentService.peek` → `BoundedFileCache.get`. `BoundedFileCache.set` silently returns when `data.byteLength > maxSingleFileBytes` (default **1 MiB**). For binary files larger than that threshold (any non-trivial GLB), the worker successfully reads the bytes, the cache discards them, the subscriber notification fires against an unchanged `undefined` snapshot, React skips the re-render, and the loader stays on screen indefinitely. The "Open Anyway" warning the user is supposed to see is unreachable because its render-gate sits _above_ the binary check.

VS Code solves this by (1) making _binary detection_ a property of the resolve contract that throws a typed error before any content sits in a cache, (2) using a per-URI `TextFileEditorModel` instead of a global byte-bounded cache, and (3) routing both binary and oversize through a dedicated `EditorPlaceholder`-based pane with explicit user-actionable buttons. None of those branches depend on cache content being present, and crucially **none of them depend on the editor knowing the file's extension** — VS Code sniffs the first 512 bytes for BOM and NUL patterns, which works uniformly for every format the platform will ever encounter.

The recommended fix follows the same pattern: turn `FileContentService.resolve` into a typed contract that returns a discriminated result (`text` / `binary` / `too-large` / `error`) by sniffing the head of the stream during the read itself. The render gate then routes on that discriminator instead of on `Uint8Array | undefined`. Extension-based detection is **explicitly rejected** — it would require Tau's editor to maintain an inventory of every binary format users might ever open, which is the wrong layer of coupling.

## Architectural Stance: No Extension-Based Routing

A naive fix is to short-circuit the render gate on `getFileExtension(name)` against the existing `binaryExtensions` set. We are explicitly **not** taking that path. The reasoning:

1. **Wrong layer of coupling.** The editor's job is "render text or fall back to a placeholder." It should not double as the authoritative registry of every binary file format in existence. Adopting an extension gate makes Tau's editor the single point of maintenance for a list that grows every time a user opens a `.usdz`, `.3mf`, `.step`, `.iges`, `.dxf`, `.obj`, `.fbx`, `.bin`, `.wasm`, `.pdb`, `.map`, `.parquet`, `.feather`, … — i.e. forever.
2. **Property of bytes, not of names.** Binary-ness is a property of the file's content. A `.txt` containing a serialized blob is binary. A binary file renamed to `.log` is still binary. An extension list cannot answer either case correctly.
3. **VS Code already proves the alternative works.** Their `detectEncodingFromBuffer` runs a BOM + NUL-byte heuristic on the first 512 bytes (Finding 6). It works for every format the editor will ever see, including formats VS Code's authors never heard of. The MIME label on `BinaryEditorModel` is a fixed display string — `Mimes.binary` — never a routing key.
4. **The existing `binaryExtensions` set is a code smell.** It exists in `apps/ui/app/utils/filesystem.utils.ts` only because the binary-warning gate needs _something_ to decide on before content arrives. With a content-sniffing resolve contract, the extension list becomes vestigial and should be deleted.

This stance shapes every recommendation below: the goal is a typed resolve contract that does the binary decision **inside the read pipeline**, not a render-time gate that asks the path "are you binary."

## Problem Statement

Opening a `.glb` file (e.g. a 3D mascot model exported from a CAD project) in the editor area of `projects/$id` shows a perpetual loading spinner. The user-visible symptom: the tab opens, the spinner appears, and nothing else ever happens. No error is logged, no toast is fired, and the binary-warning placeholder ("The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding") never appears even though the extension `.glb` is in the binary set.

The bug is not specific to GLB. It manifests for any file whose size exceeds `maxSingleFileBytes` (1 MiB) — and it is latent for any binary file that happens to have an extension Tau hasn't enumerated, because the existing extension-based fast path in `isBinaryFile` only catches a hand-curated list (`png`, `jpg`, `glb`, `3ds`, `zip`, fonts, audio/video, …). Anything outside that set with binary content (e.g. `.step`, `.iges`, `.dxf`, `.usdz`, `.3mf`, `.wasm`, `.bin`) would either fall into the same trap once the file is large, or render as mojibake in Monaco.

## Methodology

1. Traced the render path: `EditorPanel` → `FileEditor` → `useFileContent` → `FileContentService.peek/resolve` → `BoundedFileCache`.
2. Read the gating order in `FileEditor` to identify the loader vs. binary-warning branch precedence.
3. Read `FileContentService.resolveFromWorker` to confirm worker reads succeed and feed `cache.set`.
4. Read `BoundedFileCache.set` for the silent-drop branch.
5. Cloned `microsoft/vscode` via `repos/` and read the equivalent paths: `TextFileEditorModel`, `BinaryEditorModel`, `BinaryFileEditor`, `TextFileEditor.handleSetInputError`, `FileService.validateReadFileLimits`, `TextFileOperationError`, `EditorPlaceholder`.
6. Cross-referenced VS Code's encoding sniff (`detectEncodingFromBuffer`) and editor placeholder pattern with Tau's current architecture.

## Findings

### Finding 1: `BoundedFileCache.set` silently drops files larger than 1 MiB

The cache's contract is "insert if it fits; otherwise no-op". There is no error, no telemetry, and no return value:

```60:63:packages/filesystem/src/bounded-file-cache.ts
  public set(path: string, data: Uint8Array<ArrayBuffer>): void {
    if (data.byteLength > this.maxSingleFileBytes) {
      return;
    }
```

Default limit comes from `bounded-file-cache.ts` line 1 (`1024 * 1024`) and is re-asserted in `FileContentService`:

```25:27:apps/ui/app/lib/file-content-service.ts
const defaultMaxEntries = 500;
const defaultMaxTotalBytes = 128 * 1024 * 1024;
const defaultMaxSingleFileBytes = 1024 * 1024;
```

The silent-drop semantic is reasonable for an LRU cache _by itself_, but lethal when the only consumer surface is `peek()`, which has no way to distinguish "not loaded yet" from "loaded but rejected".

### Finding 2: `FileContentService.resolveFromWorker` notifies subscribers regardless of cache outcome

The worker read succeeds; the cache silently discards; subscribers fire; React re-reads `peek()` and finds `undefined`:

```306:321:apps/ui/app/lib/file-content-service.ts
  private async resolveFromWorker(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const absolutePath = joinPath(this.rootDirectory, path);
    try {
      const data = await this.proxy.readFile(absolutePath);
      this.cache.set(path, data);
      this.setOrphaned(path, false);
      this.notifyPathSubscribers(path);
      this.notifyGlobalSubscribers({ type: 'read', path, data });
      return data;
    } catch (error) {
      ...
    }
  }
```

The promise returned to the caller _does_ carry the data, but the React subscription path does not — it goes through `peek`. The two paths disagree about whether content exists, and only the React path matters for what the user sees.

### Finding 3: `useFileContent` is gated on `peek()`, not on the resolve promise

```26:30:apps/ui/app/hooks/use-file-content.ts
  const content = useSyncExternalStore(
    useCallback((callback: () => void) => contentService?.subscribe(path, callback) ?? noop, [contentService, path]),
    useCallback(() => (path ? contentService?.peek(path) : undefined), [contentService, path]),
    () => undefined,
  );
```

```50:54:apps/ui/app/hooks/use-file-content.ts
  useEffect(() => {
    if (path && content === undefined && contentService) {
      void contentService.resolve(path);
    }
  }, [contentService, path, content]);
```

The effect fires once, calls `resolve`, ignores the returned promise. Because `content` (the dep) does not change after `notifyPathSubscribers` (still `undefined`), the effect never re-fires. There is no error path. There is no timeout. The component sits in `content: undefined` forever.

### Finding 4: `FileEditor` renders the loader _before_ the binary check

```189:199:apps/ui/app/routes/projects_.$id/chat-editor-dockview.tsx
  if (!activeFile) {
    return (
      <div className='flex h-full items-center justify-center'>
        <Loader className='size-8 stroke-1 text-muted-foreground' />
      </div>
    );
  }

  if (activeFile.isBinary && !forceOpenBinary) {
    return <ChatEditorBinaryWarning onForceOpen={handleForceOpenBinary} />;
  }
```

`activeFile` is built only when `fileContent` is truthy:

```102:115:apps/ui/app/routes/projects_.$id/chat-editor-dockview.tsx
  const activeFile = useMemo(() => {
    if (!fileContent) {
      return undefined;
    }
    ...
    return {
      path: filePath,
      name,
      isBinary: isBinaryFile(name, fileContent),
      ...
    };
  }, [filePath, fileContent]);
```

This is the structural bug: **binary detection is downstream of content load**, so any failure mode that prevents content from reaching `peek` also prevents the binary placeholder from rendering. `isBinaryFile` today accepts a filename and an optional `data` argument and short-circuits on a hand-curated extension list — a design we are also moving away from (see Architectural Stance), but worth understanding because it explains why this bug only manifests for _known-binary_ extensions whose files happen to be >1 MiB rather than failing universally:

```81:88:apps/ui/app/utils/filesystem.utils.ts
export function isBinaryFile(filename: string, data?: Uint8Array<ArrayBuffer>): boolean {
  const ext = getFileExtension(filename).toLowerCase();
  if (binaryExtensions.has(ext)) {
    return true;
  }
  ...
```

The detector's API is already correct. The component just doesn't call it until after the wrong gate.

### Finding 5: Even the SharedPool fast path has the same bug

`resolve()` checks the pooled file SAB first:

```70:77:apps/ui/app/lib/file-content-service.ts
    if (this.filePool) {
      const absolutePath = joinPath(this.rootDirectory, path);
      const poolData = this.filePool.resolveCopy(absolutePath);
      if (poolData) {
        this.cache.set(path, poolData);
        return poolData;
      }
    }
```

If the pool returns a >1 MiB GLB, `cache.set` again silently drops it; `peek` again returns `undefined`. The pooled-fast-path benefit is lost for exactly the workload that benefits most from zero-copy.

### Finding 6: VS Code separates "is this binary" from "do we have the bytes"

VS Code never asks "is this file binary" by inspecting cached content. It asks the resolve pipeline, and the pipeline answers _by throwing_ before any model is registered:

```141:145:repos/vscode/src/vs/workbench/services/textfile/common/encoding.ts
				// throw early if the source seems binary and
				// we are instructed to only accept text
				if (detected.seemsBinary && options.acceptTextOnly) {
					throw new DecodeStreamError('Stream is binary but only text is accepted for decoding', DecodeStreamErrorKind.STREAM_IS_BINARY);
				}
```

The error surfaces as a typed `TextFileOperationError`:

```229:244:repos/vscode/src/vs/workbench/services/textfile/browser/textFileService.ts
		} catch (error) {
			cts.dispose(true);
			if ((<DecodeStreamError>error).decodeStreamErrorKind === DecodeStreamErrorKind.STREAM_IS_BINARY) {
				throw new TextFileOperationError(localize('fileBinaryError', "File seems to be binary and cannot be opened as text"), TextFileOperationResult.FILE_IS_BINARY, options);
			}
```

The editor input layer catches that specific result and switches editor types — content state never enters the question:

```349:397:repos/vscode/src/vs/workbench/contrib/files/browser/editors/fileEditorInput.ts
	private async doResolveAsText(options?: IFileEditorInputOptions): Promise<ITextFileEditorModel | BinaryEditorModel> {
		try {
			...
			await this.textFileService.files.resolve(this.resource, {
				...
				allowBinary: this.forceOpenAs === ForceOpenAs.Text,
				reason: TextFileResolveReason.EDITOR,
				limits: this.ensureLimits(options)
			});
			...
			return model;
		} catch (error) {

			// Handle binary files with binary model
			if ((<TextFileOperationError>error).textFileOperationResult === TextFileOperationResult.FILE_IS_BINARY) {
				return this.doResolveAsBinary();
			}

			throw error;
		}
	}
```

VS Code's binary detection is content-based (BOM + NUL-byte heuristic on the first 512 bytes) rather than extension-based, but the architectural lesson is independent of the detector: **the decision is made by the resolve contract, returned as a typed error, and routed by the editor input — not derived in the render layer from cached state**.

### Finding 7: VS Code has no global byte-bounded content cache for editors

There is one cache key per URI, owned by a manager:

```72:75:repos/vscode/src/vs/workbench/services/textfile/common/textFileEditorModelManager.ts
	private readonly mapResourceToModel = new ResourceMap<TextFileEditorModel>();
	private readonly mapResourceToModelListeners = new ResourceMap<IDisposable>();
	private readonly mapResourceToDisposeListener = new ResourceMap<IDisposable>();
	private readonly mapResourceToPendingModelResolvers = new ResourceMap<Promise<void>>();
```

A failed resolve disposes the half-built model rather than leaving it as an undefined entry waiting forever:

```445:456:repos/vscode/src/vs/workbench/services/textfile/common/textFileEditorModelManager.ts
		try {
			await modelResolve;
		} catch (error) {
			if (didCreateModel) {
				model.dispose();
			}

			throw error;
		}
```

There is no analogue to "the cache silently dropped your data". Either a model exists (and has bytes) or no model exists (and the resolve promise rejected with a typed error the caller has to handle).

### Finding 8: VS Code separates open-time size policy from in-model representation limits

Two distinct gates live at two distinct layers. The open-time gate is enforced by the file service before any model is built:

```756:759:repos/vscode/src/vs/platform/files/common/fileService.ts
	private validateReadFileLimits(resource: URI, size: number, options?: IFileReadFileStreamOptions): void {
		if (typeof options?.limits?.size === 'number' && size > options.limits.size) {
			throw new TooLargeFileOperationError(localize('fileTooLargeError', "Unable to read file '{0}' that is too large to open", this.resourceForError(resource)), FileOperationResult.FILE_TOO_LARGE, size, options);
		}
	}
```

Defaults are scheme-aware (50 MiB on web, 10 MiB remote, 1 GiB local), overridable via `workbench.editorLargeFileConfirmation`:

```1632:1655:repos/vscode/src/vs/platform/files/common/files.ts
export function getLargeFileConfirmationLimit(arg?: string | URI): number {
	const isRemote = typeof arg === 'string' || arg?.scheme === Schemas.vscodeRemote;
	const isLocal = typeof arg !== 'string' && arg?.scheme === Schemas.file;

	if (isLocal) {
		return 1024 * ByteSize.MB;
	}

	if (isRemote) {
		return 10 * ByteSize.MB;
	}

	if (isWeb) {
		return 50 * ByteSize.MB;
	}

	return 1024 * ByteSize.MB;
}
```

The error is rendered as a placeholder with two explicit user actions — "Open Anyway" (re-resolve with `Number.MAX_VALUE` limit) and "Configure Limit" (jump to settings):

```1025:1047:repos/vscode/src/vs/workbench/common/editor.ts
export function createTooLargeFileError(group: IEditorGroup, input: EditorInput, options: IEditorOptions | undefined, message: string, preferencesService: IPreferencesService): Error {
	return createEditorOpenError(message, [
		toAction({
			id: 'workbench.action.openLargeFile', label: localize('openLargeFile', "Open Anyway"), run: () => {
				const fileEditorOptions: IFileEditorInputOptions = {
					...options,
					limits: {
						size: Number.MAX_VALUE
					}
				};

				group.openEditor(input, fileEditorOptions);
			}
		}),
		toAction({
			id: 'workbench.action.configureEditorLargeFileConfirmation', label: localize('configureEditorLargeFileConfirmation', "Configure Limit"), run: () => {
				return preferencesService.openUserSettings({ query: 'workbench.editorLargeFileConfirmation' });
			}
		}),
	], {
		forceMessage: true,
		forceSeverity: Severity.Warning
	});
}
```

Separately, `TextModel` has _representation_ thresholds that govern degraded behavior (no tokenization, no heap ops) once content has already been accepted:

```188:191:repos/vscode/src/vs/editor/common/model/textModel.ts
	static _MODEL_SYNC_LIMIT = 50 * 1024 * 1024; // 50 MB,  // used in tests
	private static readonly LARGE_FILE_SIZE_THRESHOLD = 20 * 1024 * 1024; // 20 MB;
	private static readonly LARGE_FILE_LINE_COUNT_THRESHOLD = 300 * 1000; // 300K lines
	private static readonly LARGE_FILE_HEAP_OPERATION_THRESHOLD = 256 * 1024 * 1024; // 256M characters, usually ~> 512MB memory usage
```

Tau collapses both concerns into one number (`maxSingleFileBytes = 1 MiB`) that silently controls cache admission and incidentally controls whether the editor can render at all. That's three layers of policy fused into one knob with no error path.

### Finding 9: VS Code's "Open Anyway" lives in a dedicated `EditorPlaceholder` editor pane

The binary placeholder is itself an editor — `BaseBinaryResourceEditor extends EditorPlaceholder` — and the "Open Anyway" action mutates the input (`setForceOpenAsText`) and replaces the editor in the group:

```50:78:repos/vscode/src/vs/workbench/browser/parts/editor/binaryEditor.ts
	protected async getContents(input: EditorInput, options: IEditorOptions): Promise<IEditorPlaceholderContents> {
		const model = await input.resolve();

		if (!(model instanceof BinaryEditorModel)) {
			throw new Error('Unable to open file as binary');
		}

		const size = model.getSize();
		this.handleMetadataChanged(typeof size === 'number' ? ByteSize.formatSize(size) : '');

		return {
			icon: '$(warning)',
			label: localize('binaryError', "The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding."),
			actions: [
				{
					label: localize('openAnyway', "Open Anyway"),
					run: async () => {
						await this.callbacks.openInternal(input, options);
						this._onDidOpenInPlace.fire();
					}
				}
			]
		};
	}
```

```46:95:repos/vscode/src/vs/workbench/contrib/files/browser/editors/binaryFileEditor.ts
	private async openInternal(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
		if (input instanceof FileEditorInput && this.group.activeEditor) {
			...
			let resolvedEditor: ResolvedEditor | undefined = await this.editorResolverService.resolveEditor({
				...untypedActiveEditor,
				options: {
					...options,
					override: EditorResolution.PICK
				}
			}, this.group);
			...
			if (isEditorInputWithOptions(resolvedEditor)) {
				for (const editor of resolvedEditor.editor instanceof DiffEditorInput ? [resolvedEditor.editor.original, resolvedEditor.editor.modified] : [resolvedEditor.editor]) {
					if (editor instanceof FileEditorInput) {
						editor.setForceOpenAsText();
						editor.setPreferredLanguageId(BINARY_TEXT_FILE_MODE);
					}
				}
			}

			await this.group.replaceEditors([{
				editor: activeEditor,
				replacement: resolvedEditor?.editor ?? input,
				options: {
					...resolvedEditor?.options ?? options
				}
			}]);
		}
	}
```

`BinaryEditorModel` carries metadata (`size`, `name`, `mime`) without ever touching the content cache — it's a separate model class with a different contract:

```14:47:repos/vscode/src/vs/workbench/common/editor/binaryEditorModel.ts
export class BinaryEditorModel extends EditorModel {

	private readonly mime = Mimes.binary;
    ...
	getMime(): string {
		return this.mime;
	}
```

Tau's `ChatEditorBinaryWarning` is the right idea, but it lives _below_ the content gate instead of _alongside_ it.

### Side-by-side comparison

| Concern                   | Tau (current)                                                      | VS Code                                                                                          |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Binary decision input     | Bytes (in `isBinaryFile`), but only after cache stores them        | Streamed first chunk + BOM/NUL heuristic, returned as typed error                                |
| Detection trigger point   | Render-time, downstream of `peek()`                                | Resolve-time, before any model exists                                                            |
| Detection contract        | Implicit (`activeFile.isBinary` derived from cache content)        | Explicit (`TextFileOperationResult.FILE_IS_BINARY` thrown)                                       |
| Failure mode for >1 MiB   | Silent — perpetual loader                                          | Typed error — placeholder with explicit actions                                                  |
| Cache layer               | Single `BoundedFileCache` (LRU, byte-bounded, silent eviction)     | Per-URI `TextFileEditorModel` in a `ResourceMap` (no content drop)                               |
| Open-time size policy     | None — implicit through cache admission                            | `IFileReadLimits.size` enforced in file service, scheme-aware defaults, user-overridable setting |
| In-representation limits  | None — text editor either has bytes or it doesn't                  | `TextModel` thresholds (20 MB / 300k lines / 256M chars) for degraded but functional editing     |
| "Open Anyway" UI location | `ChatEditorBinaryWarning`, gated on content load                   | `BaseBinaryResourceEditor` / `createTooLargeFileError`, render independently of content load     |
| What "Open Anyway" does   | Sets `forceOpenBinary` and falls through to `ChatEditorCodeViewer` | Re-resolves the input with `forceOpenAsText` / `limits: MAX_VALUE`                               |

## Root Cause

The bug is structural, not just an ordering mistake in `FileEditor`. Two layers fail together:

1. **The resolve contract is too narrow.** `FileContentService.resolve` returns either bytes or nothing (`Uint8Array | undefined`). It cannot communicate "I read the bytes but they're binary," "I read the bytes but the cache rejected them," or "this file is too large to open." The hook (`useFileContent`) inherits that narrowness and exposes a single `content` field whose `undefined` value conflates four distinct states.
2. **The render gate inherits the narrowness.** `FileEditor` has to pick a branch based only on `fileContent`. The loader gate fires whenever `fileContent` is undefined; the binary-warning gate fires only after `fileContent` is defined. There is no branch that says "the file resolved as binary and we never need to hold its bytes" — because the resolve contract can't say that.

Combined with `BoundedFileCache.set`'s silent-drop semantic for files >1 MiB, the consumer has no observable signal that anything happened. The cache budget (intended to bound memory) ends up gating whether the editor can render at all (an intent it was never meant to express). The fix is not to flip the order of two checks — it's to widen the resolve contract so binary-vs-text-vs-too-large becomes part of the value the hook returns, decided inside the read pipeline by sniffing bytes.

## Recommendations

All recommendations are content-driven; none introduce or rely on a path/extension registry.

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Priority | Effort | Impact |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Turn `FileContentService.resolve` into a typed contract that performs the binary decision **inside the read pipeline** by sniffing the first 512 bytes (BOM + NUL heuristic, matching VS Code's `detectEncodingFromBuffer`). Return a discriminated result `{ kind: 'text', content } \| { kind: 'binary', size, head } \| { kind: 'too-large', size } \| { kind: 'error', cause }` instead of `Uint8Array \| undefined`. The render layer routes on the discriminator. Extension lookups are not involved at any step. | P0       | M      | High   |
| R2  | Update `useFileContent` to expose the discriminated result directly (`FileContentResult`) and update `FileEditor` to route the four kinds: `text` → existing viewer, `binary` → `ChatEditorBinaryWarning`, `too-large` → "Open Anyway / Configure Limit" placeholder modeled on VS Code's `createTooLargeFileError`, `error` → orphan / generic-error placeholder. The loader stays only while `kind` is unresolved.                                                                                                    | P0       | S      | High   |
| R3  | Delete the `binaryExtensions` set in `apps/ui/app/utils/filesystem.utils.ts` and either remove `isBinaryFile` entirely or reduce it to a pure NUL-byte sniff over a `Uint8Array` (no filename argument). The function's current dual-mode signature (extension OR bytes) is the seam through which extension coupling could leak back in.                                                                                                                                                                               | P1       | S      | High   |
| R4  | Stop silently dropping cache writes. `BoundedFileCache.set` should return a boolean (or status enum); `FileContentService` translates "cache rejected" into the `too-large` kind from R1 rather than swallowing it. Subscribers should never be notified of a state change that `peek` can't observe.                                                                                                                                                                                                                   | P0       | S      | High   |
| R5  | Separate cache-admission policy from open-time policy. Introduce a content-service-level read limit (analogue of VS Code's `IFileReadLimits.size`, scheme-aware default, user-overridable via a future setting) that produces the `too-large` result before `proxy.readFile` even runs. Keep `BoundedFileCache.maxSingleFileBytes` as a pure LRU-budget knob, decoupled from open policy.                                                                                                                               | P1       | M      | Medium |
| R6  | Add a per-path resolve-outcome subscription channel. VS Code's `TextFileEditorModelManager` notifies on lifecycle events (resolved, error, dispose); Tau's `FileContentService` only notifies on `peek` change. A dedicated outcome channel lets `useFileContent` distinguish "still loading" from "resolved as binary/too-large" without forcing the content channel to carry sentinel values.                                                                                                                         | P2       | M      | Medium |
| R7  | Fold the SharedPool fast path through the same typed contract as the worker read (Finding 5). Pool reads either bypass the cache budget entirely (they already own the bytes via the SAB) or they emit the same `too-large` discriminator on rejection. Today they silently mirror the worker path's bug.                                                                                                                                                                                                               | P2       | S      | Medium |
| R8  | Add regression tests asserting the contract is content-driven, not name-driven: (a) opening a 5 MiB file whose extension is `.txt` but whose first bytes contain NUL renders `ChatEditorBinaryWarning`; (b) opening a 5 MiB file whose first bytes are valid UTF-8 resolves to the `too-large` kind and renders the "Open Anyway" placeholder; (c) opening a small text file resolves to `text` and renders normally. Critically — none of these tests should mention a file extension.                                 | P0       | S      | High   |

## Trade-offs

### "Bump the cache limit" vs. "Decouple cache from open policy"

Bumping `maxSingleFileBytes` (e.g. to 64 MiB) would make the symptom disappear without restructuring anything, but it inverts the cache's purpose — the cache exists precisely to bound memory pressure when many small files are open. A 50 MiB GLB occupying half the cache budget would evict every text file the user is editing on the next open. VS Code's split (file-service limits vs. cache vs. text-model thresholds) keeps these concerns from cannibalizing each other; R5 mirrors that split rather than relaxing the budget.

### Sniff-on-full-read vs. streaming head-chunk read

The cleanest implementation of R1 is a streaming read whose first chunk is sniffed and which can be cancelled if the bytes look binary — exactly what VS Code does with `VSBufferReadableStream` and `cts.dispose(true)` in `AbstractTextFileService.doRead`. Today `FileManagerProxy.readFile` returns the entire `Uint8Array`, so an interim implementation can sniff the first 512 bytes of the already-fully-read buffer without changing the worker contract. This costs one full disk read for every binary open (the worker reads the bytes; the main thread sniffs and discards them) but is strictly correct and unblocks the editor immediately. A follow-up can replace it with a streaming `readFileStream` that early-cancels at the chunk boundary, matching VS Code's bandwidth profile.

### Typed result vs. throw

VS Code uses thrown errors (`TextFileOperationError`, `TooLargeFileOperationError`) because `await input.resolve()` returns either a `TextFileEditorModel` or a `BinaryEditorModel` — different model types, different downstream pipelines, and the editor input layer is the one place that has to discriminate. Tau's `FileContentService.resolve` only ever returns bytes, so a discriminated **return** value (`FileContentResult`) maps more naturally onto the existing `useSyncExternalStore`-based hook and avoids try/catch noise in the React layer. Both designs encode the same information; the choice is ergonomic.

### Sniff heuristic: NUL-byte only vs. full chardet

VS Code optionally runs `jschardet` for fuller encoding detection (`files.autoGuessEncoding`), but the binary gate itself is just BOM + NUL on the first 512 bytes. That's the simplest reliable signal and the one we should adopt. We don't need encoding-family detection for the binary gate; we only need to distinguish "this is text" from "this contains a NUL byte and therefore is not text." Adopting just the BOM/NUL portion keeps the implementation small and dependency-free.

## Code Examples

### Sketch for R1 + R2 (typed, content-driven contract)

```typescript
// apps/ui/app/lib/file-content-service.ts

const HEAD_SNIFF_BYTES = 512;

export type FileContentResult =
  | { kind: 'loading' }
  | { kind: 'text'; content: Uint8Array<ArrayBuffer> }
  | { kind: 'binary'; size: number; head: Uint8Array<ArrayBuffer> }
  | { kind: 'too-large'; size: number; limit: number }
  | { kind: 'orphaned' }
  | { kind: 'error'; cause: unknown };

function seemsBinary(head: Uint8Array): boolean {
  // BOM check first (UTF-8 / UTF-16 BE/LE / UTF-32) — those are always text
  // and short-circuit the NUL scan.
  // ...BOM checks omitted for brevity...

  const limit = Math.min(head.length, HEAD_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (head[i] === 0) return true;
  }
  return false;
}
```

```typescript
// inside FileContentService.resolveFromWorker (sketch)

const data = await this.proxy.readFile(absolutePath);

if (seemsBinary(data)) {
  const head = data.slice(0, HEAD_SNIFF_BYTES);
  this.publishOutcome(path, { kind: 'binary', size: data.byteLength, head });
  return { kind: 'binary', size: data.byteLength, head };
}

if (data.byteLength > this.openLimit) {
  this.publishOutcome(path, {
    kind: 'too-large',
    size: data.byteLength,
    limit: this.openLimit,
  });
  return { kind: 'too-large', size: data.byteLength, limit: this.openLimit };
}

this.cache.set(path, data);
this.publishOutcome(path, { kind: 'text', content: data });
return { kind: 'text', content: data };
```

```typescript
// apps/ui/app/routes/projects_.$id/chat-editor-dockview.tsx

const result = useFileContent(filePath);

switch (result.kind) {
  case 'loading':
    return <Loader className='size-8 stroke-1 text-muted-foreground' />;
  case 'binary':
    return forceOpenBinary
      ? <BinaryHexViewer head={result.head} size={result.size} />
      : <ChatEditorBinaryWarning onForceOpen={handleForceOpenBinary} />;
  case 'too-large':
    return <FileTooLargePlaceholder size={result.size} limit={result.limit} onOpenAnyway={handleOverrideLimit} />;
  case 'orphaned':
    return <FileMissingPlaceholder path={filePath} />;
  case 'error':
    return <FileErrorPlaceholder cause={result.cause} />;
  case 'text':
    return <ViewerComponent filePath={filePath} content={decodeTextFile(result.content)} ... />;
}
```

Note: nothing in this code path inspects the filename for routing. `getFileExtension` and `isBinaryFile(name, ...)` no longer appear. The `binaryExtensions` set in `filesystem.utils.ts` becomes deletable (R3).

### Streaming head-chunk variant (follow-up, matches VS Code's bandwidth profile)

If/when `FileManagerProxy` grows a `readFileStream` API, the sniff happens on the first chunk and the worker can early-cancel for binary files larger than the open limit:

```typescript
const stream = await this.proxy.readFileStream(absolutePath);
const firstChunk = await stream.read(HEAD_SNIFF_BYTES);

if (seemsBinary(firstChunk)) {
  const size = await this.proxy.statSize(absolutePath);
  await stream.cancel();
  return { kind: 'binary', size, head: firstChunk };
}

// otherwise drain the stream into a buffer up to openLimit
```

This avoids the full read for binary files (relevant for multi-hundred-MB GLBs) but is not on the critical path for fixing the perpetual-loader bug.

## Diagrams

```
Tau today (broken)
──────────────────
user opens .glb
     │
     ▼
useFileContent(path)
     │           ┌─ peek() ──► undefined
     │           │
     │           └─ resolve() ──► worker.readFile(...)  ──► OK, 5 MiB
     │                                                        │
     │                                                        ▼
     │                                              BoundedFileCache.set
     │                                                        │
     │                                                  size > 1 MiB
     │                                                        │
     │                                                        ▼
     │                                                   silent return
     │                                                        │
     │                                                        ▼
     │                                              notifyPathSubscribers
     │                                                        │
     ▼                                                        ▼
FileEditor: peek() === undefined ◄────────────────  React re-reads
                                                     snapshot unchanged
     │                                                  no re-render
     ▼
<Loader/> (forever)


VS Code (working)
─────────────────
user opens .glb
     │
     ▼
FileEditorInput.doResolveAsText
     │
     ▼
TextFileService.readStream
     │
     ├─ FileService.validateReadFileLimits ── too big? ── throw FILE_TOO_LARGE
     │
     ▼
toDecodeStream → detectEncodingFromBuffer ── seemsBinary? ── throw FILE_IS_BINARY
     │                                                              │
     ▼                                                              ▼
TextFileEditorModel registered                       FileEditorInput.doResolveAsBinary
                                                                    │
                                                                    ▼
                                                       BinaryEditorModel (size, mime, name only)
                                                                    │
                                                                    ▼
                                                       BaseBinaryResourceEditor placeholder
                                                                    │
                                                                    └─ "Open Anyway" → setForceOpenAsText → re-resolve


Tau target (R1 + R2, content-driven, no extension lookup)
─────────────────────────────────────────────────────────
user opens any file
     │
     ▼
useFileContent(path) ──► peek/resolve outcome (FileContentResult)
     │
     ▼
FileContentService.resolveFromWorker
     │
     ├─ worker.readFile(...) ──► bytes
     │
     ▼
seemsBinary(head 512B)?  ── yes ──► outcome = { kind: 'binary', size, head }
     │                                              │
     │                                              ▼
     │                                    publishOutcome → React re-renders
     │                                              │
     │                                              ▼
     │                                    <ChatEditorBinaryWarning/>  ◄── extension list never consulted
     │                                              │
     │                                              └─ "Open Anyway" → re-resolve with forceOpenBinary
     ▼
size > openLimit?  ── yes ──► outcome = { kind: 'too-large', size, limit }
     │                                              │
     │                                              ▼
     │                                    <FileTooLargePlaceholder/>
     │                                              │
     │                                              └─ "Open Anyway" → re-resolve with limit override
     ▼
cache.set(path, data) ──► outcome = { kind: 'text', content }
     │
     ▼
<ViewerComponent/>
```

## References

- VS Code source explored: `repos/vscode/src/vs/workbench/services/textfile/`, `repos/vscode/src/vs/workbench/contrib/files/browser/editors/`, `repos/vscode/src/vs/workbench/common/editor/binaryEditorModel.ts`, `repos/vscode/src/vs/platform/files/common/files.ts`, `repos/vscode/src/vs/editor/common/model/textModel.ts`
- Related Tau code: `apps/ui/app/routes/projects_.$id/chat-editor-dockview.tsx`, `apps/ui/app/lib/file-content-service.ts`, `apps/ui/app/hooks/use-file-content.ts`, `apps/ui/app/utils/filesystem.utils.ts`, `packages/filesystem/src/bounded-file-cache.ts`
- Policy: `docs/policy/filesystem-policy.md`

## Appendix: VS Code threshold reference

| Constant                                 | Value             | Layer        | Purpose                                            |
| ---------------------------------------- | ----------------- | ------------ | -------------------------------------------------- |
| `getLargeFileConfirmationLimit` (web)    | 50 MiB            | File service | Open-time size gate, throws `FILE_TOO_LARGE`       |
| `getLargeFileConfirmationLimit` (remote) | 10 MiB            | File service | Open-time size gate (network-cost-aware)           |
| `getLargeFileConfirmationLimit` (local)  | 1024 MiB          | File service | Open-time size gate (essentially unlimited)        |
| `workbench.editorLargeFileConfirmation`  | user setting (MB) | Editor input | Override per-resource                              |
| `LARGE_FILE_SIZE_THRESHOLD`              | 20 MiB            | TextModel    | Disables tokenization                              |
| `LARGE_FILE_LINE_COUNT_THRESHOLD`        | 300k lines        | TextModel    | Disables tokenization                              |
| `LARGE_FILE_HEAP_OPERATION_THRESHOLD`    | 256M chars        | TextModel    | Disables heap-heavy ops (search-and-replace, etc.) |
| `_MODEL_SYNC_LIMIT`                      | 50 MiB            | TextModel    | Bounds sync between renderer and ext host          |
| `ZERO_BYTE_DETECTION_BUFFER_MAX_LEN`     | 512 bytes         | Encoding     | Window for binary sniff                            |
| `NO_ENCODING_GUESS_MIN_BYTES`            | 512 bytes         | Encoding     | Min buffered before deciding without chardet       |
| `AUTO_ENCODING_GUESS_MIN_BYTES`          | 4 KiB             | Encoding     | Min buffered before chardet runs                   |
| `AUTO_ENCODING_GUESS_MAX_BYTES`          | 64 KiB            | Encoding     | Max buffered for chardet                           |

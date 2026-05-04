---
title: 'KCL LSP relative import resolution'
description: 'Root-cause investigation for LSP diagnostics on valid sibling imports when project_directory is unset and WASM forwards bare filenames to the UI bridge.'
status: active
created: '2026-05-04'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/kcl-monaco-lsp-file-manager-wiring.md
  - docs/research/monaco-lsp-lazy-activation-blueprint.md
---

# KCL LSP relative import resolution

Investigation of `engine: Failed to wait for promise from engine: Error: File 'fan-housing.kcl' was not found` on import lines where the file exists next to the importer and command+click navigation succeeds.

## Executive Summary

The KCL WASM LSP mock executor uses `ExecutorSettings::default()`, so `project_directory` is always `None`. For imports from `ModulePath::Main`, `kcl-lib` therefore passes the **literal import string** (e.g. `fan-housing.kcl`) into the JS `FileSystemManager.readFile` path. In KittyCAD modeling-app, `FileSystemManager` prepends a **project root** `_dir` so flat layouts resolve. Tau projects nest (`public/kcl-samples/axial-fan/`), so the bridge must resolve relative paths against the **directory of the document being processed**, not the workspace root. Tracking that directory on `KclLspClient` and joining bare WASM paths before calling `FileManager` fixes diagnostics without rebuilding WASM.

## Problem Statement

Symptoms: red squiggles on `import "fan-housing.kcl"` in `main.kcl` with a stack referencing `kcl-lsp-worker` and `handleFileReadResponse`. File tree shows sibling files. Go-to-definition on the module name works because the main thread resolves the URI (`resolveKclImportToUri`) before `readFile`.

## Methodology

Code trace of `kcl-lib` import resolution in `repos/zoo-modeling-app`, comparison with `src/lang/std/fileSystemManager.ts`, and review of `KclLspClient.handleFileReadRequest` in `apps/ui`.

## Findings

### Finding 1: Bare path when `project_directory` is None

In `ModulePath::from_import_path`, when `import_from` is `Main` and `project_directory` is `None`, the resolved path is `path.clone()` — the raw specifier from the import. That value reaches WASM `FileManager::read` and becomes the string in `fileReadRequest`.

### Finding 2: Upstream `_dir` assumes flat project roots

`FileSystemManager.readFile` does `this.join(this.dir, targetPath)`. Route loaders set `projectFsManager.dir` to the project root. Nested-relative imports only work if the resolved path in Rust already includes subdirectories or `with_current_file` populated `project_directory`; the LSP path does neither for Monaco.

### Finding 3: Tau file manager is workspace-rooted

`readFile('fan-housing.kcl')` looks for a file at workspace root; actual path is `public/kcl-samples/axial-fan/fan-housing.kcl`.

## Recommendations

| #   | Action                                                                   | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------ | -------- | ------ | ------ |
| R1  | Track `currentDocumentDir` + `knownDocumentDirs` on `KclLspClient`       | P0       | Low    | High   |
| R2  | Call `setCurrentDocumentDir` from `notifyDocumentOpen` + reprocess pass  | P0       | Low    | High   |
| R3  | Fall back across known dirs when join misses (concurrent open edge case) | P1       | Low    | Medium |
| R4  | Document pattern; cross-link file-manager wiring research                | P1       | Low    | Low    |

## Trade-offs

| Approach                                  | Pros                                              | Cons                                                    |
| ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| Client-side dir join + known-dir fallback | No WASM rebuild; matches modeling-app `_dir` idea | Heuristic if WASM interleaves reads from multiple roots |
| Pass `rootUri` / workspaceFolders only    | Spec-aligned initialize                           | Does not change Rust resolver without upstream LSP work |
| Extend wire with originating URI          | Precise                                           | Requires `@taucad/kcl-wasm-lib` change                  |

Chosen: hybrid client-side tracking plus fallback set.

## References

- Related: `docs/research/kcl-monaco-lsp-file-manager-wiring.md`
- Related: `docs/research/monaco-lsp-lazy-activation-blueprint.md`
- Upstream reference: `repos/zoo-modeling-app/rust/kcl-lib/src/modules.rs`, `repos/zoo-modeling-app/src/lang/std/fileSystemManager.ts`

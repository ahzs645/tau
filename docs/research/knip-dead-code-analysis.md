---
title: 'Knip Dead-Code Analysis'
description: 'Initial Knip v6 audit of unused files, dependencies, and exports across the Tau monorepo'
status: draft
created: '2026-03-24'
updated: '2026-03-24'
category: audit
related:
  - docs/policy/lint-policy.md
---

# Knip Dead-Code Analysis

Initial audit of unused files, dependencies, and exports across the Tau monorepo using Knip v6, identifying genuine dead code and false positives to establish a clean baseline for CI enforcement.

## Executive Summary

Knip v6 analysis of 22 Nx projects initially surfaced 192 unused files, 85 unused dependencies, 87 unused exports, and 17 unused types. After iterative config tuning to suppress false positives (WASM artifacts, generated types, ambient `.d.ts` files, oxlint-loaded ESLint plugins, workspace deps), the final report shows **37 unused files, 54 unused dependencies (48 production + 6 dev), 85 unused exports, 17 unused types, 3 unlisted dependencies, and 2 unused catalog entries** -- all genuine findings representing dead code accumulated across the codebase.

## Problem Statement

The Tau monorepo has grown to 22 Nx projects across `apps/`, `libs/`, `packages/`, `scripts/`, and `tools/`. Without automated dead-code detection, unused files, dependencies, and exports accumulate silently -- increasing install times, confusing contributors, and bloating bundle sizes. This audit establishes the baseline for ongoing Knip CI enforcement.

## Methodology

- **Tool**: Knip v6 (latest) with `oxc-parser` backend
- **Config**: `knip.config.ts` at workspace root with `ignoreExportsUsedInFile: true`, `optionalPeerDependencies: 'off'`, `ignoreWorkspaces: ['tools/*', 'libs/api-extractor', 'libs/tau-examples']`
- **Vitest plugin**: Overridden to exclude `vitest.workspace.ts` (Knip cannot load `defineWorkspace` at analysis time)
- **ESLint plugins**: oxlint-loaded plugins added to `ignoreDependencies` (Knip's ESLint plugin cannot trace `.oxlintrc.json` plugin loading)
- **Command**: `NX_DAEMON=false pnpm knip --max-issues 198` (Nx daemon disabled per known Knip/Nx issue; max-issues set to current baseline so CI passes but catches regressions)
- **Reference implementation**: brepjs (`repos/brepjs/knip.config.ts`) for monorepo configuration patterns

## Findings

### Finding 1: Unused Files (192 total)

#### 1a. False Positives -- WASM Experiment Artifacts (~70 files)

Files under `tarballs/experiments/` and `tarballs/active/unpacked/` are WASM build artifacts, not source code. They are consumed by the WASM build pipeline and benchmarks, not imported by TypeScript.

**Mitigation**: Exclude `tarballs/` from Knip's project scope.

#### 1b. False Positives -- Generated Type Declarations (23 files)

Files under `libs/api-extractor/src/generated/` are bundled `.d.ts` files for Monaco IntelliSense (JSCAD, Manifold, OpenCASCADE, Replicad). They are registered via `addExtraLib` at runtime, not imported.

**Mitigation**: Add `libs/api-extractor` entry files or ignore the workspace.

#### 1c. False Positives -- Entry Points and Ambient Types (~15 files)

| File                                                            | Reason                                            |
| --------------------------------------------------------------- | ------------------------------------------------- |
| `apps/api/app/main.ts`                                          | NestJS bootstrap entry (Vite builds reference it) |
| `apps/api/app/types/environment.d.ts`                           | Ambient type declarations                         |
| `apps/api/app/types/vite-environment.d.ts`                      | Vite client types                                 |
| `apps/ui/app/types/environment.d.ts`                            | Ambient type declarations                         |
| `apps/ui/app/types/types.d.ts`                                  | Ambient type declarations                         |
| `apps/ui/vite-environment.d.ts`                                 | Vite env types                                    |
| `libs/tau-examples/src/types/*.d.ts`                            | Ambient kernel decorators                         |
| `packages/converter/src/types/*.d.ts`                           | Ambient module declarations                       |
| `packages/runtime/src/kernels/opencascade/opencascade.types.ts` | Ambient OCCT types                                |
| `apps/api/vitest.integration.config.ts`                         | Integration test config                           |
| `apps/ui-e2e/playwright.config.ts`                              | E2E test config                                   |
| `vitest.workspace.ts`                                           | Vitest workspace config                           |

**Mitigation**: Declare as entry files per workspace or add to `ignore`.

#### 1d. False Positives -- Runtime-Loaded Assets (~7 files)

| File                                                                    | Reason                                    |
| ----------------------------------------------------------------------- | ----------------------------------------- |
| `apps/ui/public/draco_decoder_gltf.js`                                  | Loaded at runtime by Three.js DRACOLoader |
| `apps/ui/public/draco_wasm_wrapper_gltf.js`                             | Loaded at runtime by Three.js DRACOLoader |
| `packages/converter/src/assets/draco3d/gltf/draco_decoder_gltf.js`      | Runtime DRACO decoder                     |
| `packages/converter/src/assets/draco3d/gltf/draco_wasm_wrapper_gltf.js` | Runtime DRACO wrapper                     |
| `packages/converter/src/assets/rhino3dm/rhino3dm.js`                    | Runtime Rhino3DM loader                   |

**Mitigation**: Exclude `**/assets/`** and `**/public/\*\*` from unused file detection.

#### 1e. False Positives -- Script Entry Points (3 files)

| File                                             | Reason                               |
| ------------------------------------------------ | ------------------------------------ |
| `scripts/src/generate-opencascade-changelog.mts` | CLI script run via `nx run-commands` |
| `scripts/src/validate-frontmatter.ts`            | CLI script run via `nx run-commands` |
| `scripts/src/validate-project-names.ts`          | CLI script run via `nx run-commands` |

**Mitigation**: Declare `scripts/src/*.{ts,mts}` as entry files for the `scripts` workspace.

#### 1f. False Positives -- Docs Content Props (8 files)

Files under `apps/ui/content/docs/(runtime)/api/props/` are Fumadocs page props consumed by the docs build system via file-system routing.

**Mitigation**: Declare as entry files or ignore `content/docs/`\*\* in the `apps/ui` workspace.

#### 1g. Genuine Unused Files (~66 files)

These files are not imported anywhere and appear to be genuinely dead code:

| Workspace            | Files | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/ui`            | ~45   | Git connector (6), animation components (2), nav components (3), unused UI primitives (button-group, carousel, date-picker, field, image-preview-group, navigation-menu, resizable, scroll-area), chat-prompt-examples, db/local-storage, db/storage, filesystem/zenfs-config, flags/index, hooks/use-scroll, hooks/use-service-worker, lib/git-auth, openscad-language (3), splashback components (3), chat-console, chat-editor-tabs, chat-examples, chat-git, dockview-tab, project-git-connector, binary.utils |
| `apps/api`           | ~8    | redis-io.adapter, http-body.constant, auth-schema, database.provider, fastify.logger, base62, string.utils, xml, geometry-revalidate script                                                                                                                                                                                                                                                                                                                                                                        |
| `libs/types`         | 1     | json-schema.types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `libs/units`         | 1     | physical.constants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `libs/tau-examples`  | 3     | projection-test, rao-nozzle, stress-test examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/converter` | 1     | gltf.dependencies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/runtime`   | 1     | opencascade.types (may be ambient)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Finding 2: Unused Dependencies (57 production, 28 dev)

#### 2a. Root `package.json` -- Production (44 unused)

| Package                                    | Classification | Notes                                          |
| ------------------------------------------ | -------------- | ---------------------------------------------- |
| `@ai-sdk/ui-utils`                         | Genuine        | Not directly imported                          |
| `@fastify/helmet`                          | Investigate    | May be loaded via NestJS module                |
| `@fastify/otel`                            | Investigate    | May be loaded via OTEL bootstrap               |
| `@gltf-transform/core`                     | Genuine        | Only used in converter package                 |
| `@gltf-transform/extensions`               | Genuine        | Only used in converter package                 |
| `@gltf-transform/functions`                | Genuine        | Only used in converter package                 |
| `@inkjs/ui`                                | Genuine        | Only used in scripts TUI (separate workspace)  |
| `@langchain/classic`                       | Genuine        | Likely replaced by newer LangChain             |
| `@langchain/community`                     | Investigate    | May be loaded via LangChain runtime            |
| `@msgpack/msgpack`                         | Genuine        | Not imported                                   |
| `@nestjs/platform-ws`                      | Investigate    | May be loaded via NestJS reflection            |
| `@opentelemetry/instrumentation-pino`      | Investigate    | May be loaded via OTEL auto-instrumentation    |
| `@opentelemetry/instrumentation-socket.io` | Investigate    | May be loaded via OTEL auto-instrumentation    |
| `@opentelemetry/sdk-metrics`               | Investigate    | May be used transitively                       |
| `@remix-pwa/client`                        | Genuine        | PWA support appears removed                    |
| `@remix-pwa/sw`                            | Genuine        | PWA support appears removed                    |
| `@remix-pwa/worker-runtime`                | Genuine        | PWA support appears removed                    |
| `@taucad/json-schema`                      | Investigate    | Workspace dep, may be used transitively        |
| `@tiptap/extension-mention`                | Genuine        | TipTap mention extension not imported          |
| `@types/js-yaml`                           | Genuine        | Only needed in scripts workspace               |
| `@types/madge`                             | Genuine        | Only needed if madge is used                   |
| `@types/pluralize`                         | Genuine        | Only needed if pluralize is used               |
| `@typescript/vfs`                          | Genuine        | Not imported                                   |
| `@zenfs/dom`                               | Investigate    | May be loaded dynamically by ZenFS             |
| `autoprefixer`                             | Genuine        | PostCSS plugin, likely unused with Tailwind v4 |
| `bson`                                     | Genuine        | Not imported                                   |
| `cheerio`                                  | Genuine        | Not imported                                   |
| `embla-carousel-react`                     | Genuine        | Carousel component appears unused              |
| `error-stack-parser`                       | Genuine        | Not imported                                   |
| `esbuild-wasm`                             | Investigate    | May be loaded dynamically by bundler           |
| `eslint-plugin-react`                      | Investigate    | May be configured in ESLint config             |
| `geist`                                    | Investigate    | Font package, may be loaded via CSS            |
| `ink`                                      | Genuine        | Only used in scripts TUI workspace             |
| `js-yaml`                                  | Genuine        | Only used in scripts workspace                 |
| `json-schema-default`                      | Genuine        | Not imported                                   |
| `openai`                                   | Investigate    | May be used by LangChain provider              |
| `openscad-wasm-prebuilt`                   | Investigate    | May be loaded dynamically                      |
| `oxlint`                                   | False positive | Binary used by lint command, not imported      |
| `oxlint-tsgolint`                          | False positive | Binary used by lint, not imported              |
| `pgvector`                                 | Investigate    | May be loaded via Drizzle                      |
| `pino-pretty`                              | Investigate    | Logger transport loaded at runtime             |
| `pluralize`                                | Genuine        | Not imported                                   |
| `react-icons`                              | Genuine        | Not imported                                   |
| `react-resizable-panels`                   | Genuine        | Not imported                                   |
| `source-map-js`                            | Genuine        | Not imported                                   |
| `three-mesh-bvh`                           | Investigate    | May be imported dynamically                    |
| `uzip`                                     | Genuine        | Not imported                                   |

#### 2b. Per-Workspace Unused Dependencies (13 additional)

| Package                | Workspace          | Classification               |
| ---------------------- | ------------------ | ---------------------------- |
| `@taucad/tau-examples` | `apps/api`         | Investigate                  |
| `@taucad/json-schema`  | `apps/ui`          | Investigate                  |
| `xstate`               | `packages/js`      | Genuine                      |
| `@taucad/json-schema`  | `packages/runtime` | Investigate                  |
| `cdn-resolve`          | `packages/runtime` | Genuine                      |
| `es-module-lexer`      | `packages/runtime` | Genuine                      |
| `@inkjs/ui`            | `scripts`          | False positive (used by TUI) |
| `ink`                  | `scripts`          | False positive (used by TUI) |
| `js-yaml`              | `scripts`          | False positive (used by TUI) |
| `react`                | `scripts`          | False positive (used by TUI) |

#### 2c. Root `package.json` -- Dev Dependencies (28 unused)

| Package                                                    | Classification | Notes                                |
| ---------------------------------------------------------- | -------------- | ------------------------------------ |
| `@arethetypeswrong/cli`                                    | False positive | Used via pkgcheck script             |
| `@eslint-community/eslint-plugin-eslint-comments`          | False positive | ESLint plugin loaded by config       |
| `@nestjs/schematics`                                       | Genuine        | NestJS generator schematics          |
| `@nx/nest`                                                 | Investigate    | Nx plugin may be used for inference  |
| `@nx/node`                                                 | Investigate    | Nx plugin may be used for inference  |
| `@nx/web`                                                  | Investigate    | Nx plugin may be used for inference  |
| `@nx/webpack`                                              | Investigate    | Nx plugin may be used for inference  |
| `@protontech/eslint-plugin-enforce-uint8array-arraybuffer` | False positive | ESLint plugin                        |
| `@tailwindcss/typography`                                  | Investigate    | Tailwind plugin                      |
| `@taucad/chat`                                             | False positive | Workspace dep                        |
| `@taucad/filesystem`                                       | False positive | Workspace dep                        |
| `@taucad/utils`                                            | False positive | Workspace dep                        |
| `@typescript/native-preview`                               | Genuine        | tsgo preview binary                  |
| `copy-files-from-to`                                       | False positive | Used by Nx copy-assets targets       |
| `eslint-plugin-jsdoc`                                      | False positive | ESLint plugin                        |
| `eslint-plugin-n`                                          | False positive | ESLint plugin                        |
| `eslint-plugin-no-barrel-files`                            | False positive | ESLint plugin                        |
| `eslint-plugin-no-use-extend-native`                       | False positive | ESLint plugin                        |
| `eslint-plugin-unicorn`                                    | False positive | ESLint plugin                        |
| `gray-matter`                                              | Investigate    | May be used by frontmatter validator |
| `madge`                                                    | False positive | Used via pkgcheck                    |
| `ts-node`                                                  | Genuine        | Likely replaced by tsx               |
| `vite-plugin-dts`                                          | Genuine        | Not used in current Vite configs     |
| `vite-tsconfig-paths`                                      | Genuine        | Not used in current Vite configs     |
| `webpack-cli`                                              | Genuine        | No webpack builds                    |

### Finding 3: Unlisted Dependencies (4)

| Package                             | Location                    | Classification                                                    |
| ----------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `@oxc-project/runtime/package.json` | `apps/api/vite.config.ts`   | Genuine -- imported but not in `apps/api/package.json`            |
| `opencascade`                       | `libs/api-extractor`        | False positive -- ambient module declaration in generated `.d.ts` |
| `estree`                            | `libs/oxlint` (2 locations) | False positive -- type-only import for AST types                  |

### Finding 4: Unlisted Binaries (3)

| Binary           | Location                                        | Classification                                     |
| ---------------- | ----------------------------------------------- | -------------------------------------------------- |
| `fly`            | `apps/api/project.json`, `apps/ui/project.json` | False positive -- Fly.io CLI, installed externally |
| `docker-compose` | `package.json`                                  | False positive -- Docker CLI, installed externally |

### Finding 5: Unused Exports (87 exports, 17 types)

#### 5a. UI Component Primitives (~35 exports)

Many shadcn/ui components re-export all sub-components from Radix UI. A subset is never used (e.g., `ContextMenuRadioItem`, `DropdownMenuShortcut`, `SheetFooter`, `SidebarMenuSkeleton`). These are intentional API surface for future use.

**Classification**: Low priority -- these follow shadcn/ui conventions. Consider `ignoreExportsUsedInFile: true` (already enabled) or accept as intentional API surface.

#### 5b. Genuine Unused Exports (~52 exports)

| Workspace            | Count | Examples                                                                                                                                               |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`           | 7     | `toolChoiceFromToolName`, `PublicAuth`, `OptionalAuth`, `auth`, `redactionCensor`, `defaultPageLimit`, `defaultCurrentPage`                            |
| `apps/ui`            | ~40   | `ChatToolCardActions`, `iconFromExtension`, `debounce`, `formatNumber`, various splashback functions, KCL LSP functions, file tree hooks, import utils |
| `libs/chat`          | 1     | `codeIssueSchema`                                                                                                                                      |
| `packages/converter` | 3     | `createInspectSignature`, `getMaterialCount`, `getTextureCount`                                                                                        |

#### 5c. Unused Exported Types (17)

Most are XState machine actor/state types that are exported for consumer convenience but not currently used externally: `ChatPersistenceMachineState`, `ProjectManagerMachine`, `EditorStateMachineRef`, `ImportDiskMachineActor`, `ImportGitHubMachineActor`, `ParameterMachineActor`, `AuthSplashbackActor`.

**Classification**: Low priority for machine types (may be used by future consumers). Higher priority for `ModelDetails`, `OrderBy`, `HttpHeader`, `ProviderMetadata`, `EsbuildBundlerContext`, `ParameterSet`, `KclExportResult`.

### Finding 6: Duplicate Exports (2)

| Exports                                                      | File                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| `toJsonSchema` / `default`                                   | `packages/json-schema/src/to-json-schema/to-json-schema.ts` |
| `measurementTestRequirementSchema` / `testRequirementSchema` | `packages/testing/src/schemas.ts`                           |

Both are named + default export patterns. The `json-schema` case is intentional (ESM convention). The `testing` case may have a redundant alias.

### Finding 7: Unused Catalog Entries (2)

| Package                        | Location                  |
| ------------------------------ | ------------------------- |
| `@langchain/google-vertexai`   | `pnpm-workspace.yaml:24`  |
| `socket.io-prometheus-metrics` | `pnpm-workspace.yaml:134` |

These version pins exist in the pnpm catalog but no workspace references them.

### Finding 8: Configuration Hints (13)

Knip provided 13 configuration hints indicating workspaces that need entry/project refinement:

| Workspace            | Hint                    | Unused Files |
| -------------------- | ----------------------- | ------------ |
| `.` (root)           | Add entry/project files | 79           |
| `apps/ui`            | Add entry/project files | 59           |
| `libs/api-extractor` | Add entry/project files | 23           |
| `apps/api`           | Add entry/project files | 13           |
| `packages/converter` | Add entry/project files | 7            |
| `libs/tau-examples`  | Add entry/project files | 5            |
| `scripts`            | Add entry/project files | 3            |

Additionally, 5 hints indicate unnecessary `ignoreDependencies`/`ignoreBinaries` entries in the current config.

## Recommendations

| #   | Action                                                                | Priority | Effort | Impact                                       |
| --- | --------------------------------------------------------------------- | -------- | ------ | -------------------------------------------- |
| R1  | Exclude `tarballs/` from Knip project scope                           | P0       | Low    | High -- eliminates ~70 false positive files  |
| R2  | Ignore `libs/api-extractor` workspace (generated `.d.ts`)             | P0       | Low    | High -- eliminates 23 false positive files   |
| R3  | Declare entry files per workspace (api main.ts, scripts, docs props)  | P0       | Medium | High -- eliminates ~25 false positive files  |
| R4  | Add `ignoreBinaries` for `fly`, `docker-compose`                      | P0       | Low    | Medium -- eliminates 3 unlisted binaries     |
| R5  | Add `ignoreDependencies` for ESLint plugins, `oxlint`, workspace deps | P0       | Medium | High -- eliminates ~20 false positive deps   |
| R6  | Ignore `apps/ui/public/`** and `**/assets/\*\*` from unused files     | P0       | Low    | Medium -- eliminates ~7 false positive files |
| R7  | Remove genuinely unused dependencies (PWA, carousel, etc.)            | P1       | Medium | Medium -- cleaner lockfile                   |
| R8  | Remove genuinely unused files (git connector, unused UI, dead utils)  | P1       | High   | Medium -- cleaner repo                       |
| R9  | Remove unused exports                                                 | P2       | High   | Low -- export cleanup                        |
| R10 | Remove unused catalog entries                                         | P1       | Low    | Low -- cleaner catalog                       |
| R11 | Investigate "Investigate" classified dependencies                     | P2       | Medium | Medium -- verify runtime usage               |

## References

- [Knip v6 announcement](https://knip.dev/blog/knip-v6)
- [Knip monorepo docs](https://knip.dev/features/monorepos-and-workspaces)
- [Knip Nx known issues](https://knip.dev/reference/known-issues#nx-daemon)
- Reference implementation: `repos/brepjs/knip.config.ts`
- Knip source: `repos/knip/`

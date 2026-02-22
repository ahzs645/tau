---
name: Kernel Migration to packages/kernels
overview: Migrate the kernel runtime framework from apps/ui/app/components/geometry/kernel/ to packages/kernels/ (@taucad/kernels) as a first-class publishable npm package, fully decoupled from the UI application, with a minimal public API surface and comprehensive dual-environment (browser + Node.js) test validation.
todos:
  - id: dep-tree
    content: "Phase 0: Generate and validate the full dependency tree inventory (every file, every import, classified as move/adapt/replace)"
    status: completed
  - id: extract-utils
    content: "Phase 1: Extract path, file, import utilities from UI app into libs/utils with new export paths"
    status: completed
  - id: filemanager-type
    content: "Phase 2: Decouple FileManager type -- make kernel-worker-filemanager-bridge.ts self-contained without importing the UI FileManager type"
    status: completed
  - id: scaffold-package
    content: "Phase 3a: Scaffold packages/kernels with package.json (exports map, deps), tsconfig, tsdown, vitest, project.json"
    status: completed
  - id: copy-kernel-files
    content: "Phase 3b: Copy kernel files to packages/kernels/src/ in new directory structure and rewrite all imports"
    status: completed
  - id: default-config-factory
    content: "Phase 3c: Implement createDefaultConfig() factory with self-resolving URLs via new URL(path, import.meta.url)"
    status: completed
  - id: adapt-tests
    content: "Phase 4: Adapt test files, create vitest.setup.ts, adapt kernel-testing.utils.ts, verify all tests pass in node environment"
    status: completed
  - id: dual-env-tests
    content: "Phase 5: Add dual-environment test gates -- node + jsdom matrix, CJS/ESM import smoke tests"
    status: completed
  - id: update-ui-imports
    content: "Phase 6: Update UI app to consume @taucad/kernels via createDefaultConfig() and workspace dependency, remove old kernel directory"
    status: completed
  - id: verify-build
    content: "Phase 7: Run typecheck, lint, test, build for both kernels package and UI app; verify tarball contents"
    status: completed
isProject: false
---

# Kernel Migration to `packages/kernels`

## 1. Current State

The kernel code lives at `[apps/ui/app/components/geometry/kernel/](apps/ui/app/components/geometry/kernel/)` (~80 files) and is tightly coupled to the UI app through `#`-prefixed imports.

A placeholder `[packages/kernels/](packages/kernels/)` already exists with scaffolding (`package.json` for `@taucad/kernels`, tsconfig, vitest, tsdown configs, `project.json`) but only contains `export const hello = 'world'`.

## 2. Target State

`@taucad/kernels` becomes a standalone, environment-agnostic, npm-publishable package that:

- Contains all kernel framework code, middleware, bundlers, kernel implementations, and utilities
- Depends only on `@taucad/*` packages/libs and external npm packages (zero `apps/ui/` imports)
- Exposes a minimal, stable public API via granular `exports` map
- Tests pass in both Node.js and jsdom environments
- Publishes as dual CJS/ESM with correct type declarations
- Works for both the Tau UI app and third-party consumers across bundler and runtime configurations

---

## 3. Complete Dependency Tree Inventory

Every file in `apps/ui/app/components/geometry/kernel/`, its imports, and the migration action.

### Legend

- **Move**: Copy to `packages/kernels/src/`, rewrite internal `#` paths
- **Adapt**: Copy + modify (dependency replacement, API change, or environment fix)
- **ExtDep**: External npm package (added to `package.json`)
- **LibDep**: Workspace `@taucad/`* dependency
- **UIReplace**: UI app import that must be replaced with a lib or local equivalent

### 3.1 Framework Files (→ `src/framework/`)


| File                                        | Imports                                                                                                                                                                                                                                                                                                                                          | Action    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `utils/kernel-worker.ts`                    | `@taucad/types` (LibDep), `@taucad/types/symbols` (LibDep), `@taucad/types/constants` (LibDep), `deepmerge` (ExtDep), `type-fest` (ExtDep), `package.json` (UIReplace→own pkg version), `#machines/file-manager.js` (UIReplace→self-contained type), `#utils/path.utils.js` (UIReplace→`@taucad/utils/path`), internal kernel `#` imports (Move) | **Adapt** |
| `utils/kernel-worker-client.ts`             | `@taucad/types` (LibDep) only                                                                                                                                                                                                                                                                                                                    | **Move**  |
| `utils/kernel-worker-dispatcher.ts`         | `@taucad/types` (LibDep), `@taucad/types/symbols` (LibDep), internal kernel `#` imports (Move)                                                                                                                                                                                                                                                   | **Move**  |
| `utils/kernel-message-adapter.ts`           | `@taucad/types` (LibDep), `node:worker_threads` (conditional)                                                                                                                                                                                                                                                                                    | **Move**  |
| `utils/kernel-worker-filemanager-bridge.ts` | `#machines/file-manager.js` (UIReplace→self-contained type)                                                                                                                                                                                                                                                                                      | **Adapt** |
| `utils/kernel-helpers.ts`                   | `@taucad/types` (LibDep)                                                                                                                                                                                                                                                                                                                         | **Move**  |
| `utils/kernel-tracer.ts`                    | `@taucad/types` (LibDep)                                                                                                                                                                                                                                                                                                                         | **Move**  |
| `utils/worker-telemetry.ts`                 | `@taucad/types` (LibDep)                                                                                                                                                                                                                                                                                                                         | **Move**  |
| `utils/error-enrichment.ts`                 | `@taucad/types` (LibDep)                                                                                                                                                                                                                                                                                                                         | **Move**  |
| `utils/common.ts`                           | `@taucad/types` (LibDep)                                                                                                                                                                                                                                                                                                                         | **Move**  |
| `kernel-runtime-worker.ts`                  | `@taucad/types` (LibDep), internal kernel `#` imports (Move)                                                                                                                                                                                                                                                                                     | **Move**  |


### 3.2 Middleware Files (→ `src/middleware/`)


| File                                                 | Imports                                                                                                                                                            | Action    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `middleware/kernel-middleware.ts`                    | `zod` (ExtDep), `type-fest` (ExtDep), `deepmerge` (ExtDep), `@taucad/types` (LibDep)                                                                               | **Move**  |
| `middleware/geometry-cache.middleware.ts`            | `@msgpack/msgpack` (ExtDep), `@taucad/types` (LibDep), `zod` (ExtDep), `#utils/path.utils.js` (UIReplace→`@taucad/utils/path`), internal kernel `#` imports (Move) | **Adapt** |
| `middleware/parameter-cache.middleware.ts`           | `@taucad/types` (LibDep), `#utils/path.utils.js` (UIReplace→`@taucad/utils/path`), internal kernel `#` imports (Move)                                              | **Adapt** |
| `middleware/gltf-coordinate-transform.middleware.ts` | `@taucad/types` (LibDep), internal kernel `#` imports (Move)                                                                                                       | **Move**  |
| `middleware/gltf-edge-detection.middleware.ts`       | `@taucad/types` (LibDep), internal kernel `#` imports (Move)                                                                                                       | **Move**  |


### 3.3 Bundler Files (→ `src/bundler/`)


| File                          | Imports                                                                                                                                                                          | Action                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `bundlers/esbuild.bundler.ts` | `esbuild-wasm` (ExtDep), `@taucad/types` (LibDep), `uint8array-extras` (ExtDep), `#utils/import.utils.js` (UIReplace→`@taucad/utils/import`), internal kernel `#` imports (Move) | **Adapt**                           |
| `utils/module-manager.ts`     | `@taucad/types` (LibDep), `#utils/import.utils.js` (UIReplace→`@taucad/utils/import`), `#utils/path.utils.js` (UIReplace→`@taucad/utils/path`)                                   | **Adapt**                           |
| `utils/wasm/esbuild.wasm`     | Binary asset                                                                                                                                                                     | **Copy** (via `copy-files-from-to`) |


### 3.4 Kernel Implementations (→ `src/kernels/`)


| File                                 | Imports                                                                                                                                                                                                                                                                      | Action    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `tau/tau.kernel.ts`                  | `@taucad/types` (LibDep), `@taucad/converter` (LibDep), `#utils/file.utils.js` → `asBuffer` (UIReplace→`@taucad/utils/file`), internal kernel `#` imports (Move)                                                                                                             | **Adapt** |
| `replicad/replicad.kernel.ts`        | `replicad` (ExtDep), `replicad-opencascadejs` (ExtDep), `@taucad/types` (LibDep), `source-map-js` (ExtDep), `#utils/schema.utils.js` (UIReplace→`@taucad/json-schema` or local), `#utils/file.utils.js` (UIReplace→`@taucad/utils/file`), internal kernel `#` imports (Move) | **Adapt** |
| `replicad/replicad.types.ts`         | `replicad` (ExtDep)                                                                                                                                                                                                                                                          | **Move**  |
| `replicad/init-open-cascade.ts`      | `replicad-opencascadejs` (ExtDep), `replicad` (ExtDep)                                                                                                                                                                                                                       | **Move**  |
| `replicad/oc-exceptions.ts`          | None                                                                                                                                                                                                                                                                         | **Move**  |
| `replicad/utils/normalize-color.ts`  | None                                                                                                                                                                                                                                                                         | **Move**  |
| `replicad/utils/render-output.ts`    | `@taucad/types` (LibDep), `replicad` (ExtDep)                                                                                                                                                                                                                                | **Move**  |
| `replicad/utils/replicad-to-gltf.ts` | `@taucad/types` (LibDep), `replicad` (ExtDep)                                                                                                                                                                                                                                | **Move**  |
| `jscad/jscad.kernel.ts`              | `@jscad/modeling` (ExtDep), `@taucad/types` (LibDep), `#utils/schema.utils.js` (UIReplace), `#utils/file.utils.js` (UIReplace), internal kernel `#` imports (Move)                                                                                                           | **Adapt** |
| `jscad/jscad.schema.ts`              | `@taucad/types` (LibDep)                                                                                                                                                                                                                                                     | **Move**  |
| `jscad/jscad-to-gltf.ts`             | `@taucad/types` (LibDep), `@jscad/modeling` (ExtDep)                                                                                                                                                                                                                         | **Move**  |
| `openscad/openscad.kernel.ts`        | `openscad-wasm-prebuilt` (ExtDep), `json-schema-default` (ExtDep), `json-schema` (ExtDep), `@taucad/types` (LibDep), `#utils/file.utils.js` (UIReplace), `#utils/path.utils.js` (UIReplace), internal kernel `#` imports (Move)                                              | **Adapt** |
| `openscad/parse-output.ts`           | `@taucad/types` (LibDep)                                                                                                                                                                                                                                                     | **Move**  |
| `openscad/parse-parameters.ts`       | `json-schema` (ExtDep)                                                                                                                                                                                                                                                       | **Move**  |
| `zoo/zoo.kernel.ts`                  | `@taucad/types` (LibDep), `@taucad/kcl-wasm-lib` (ExtDep), `#utils/file.utils.js` (UIReplace), `#utils/path.utils.js` (UIReplace), internal kernel `#` imports (Move)                                                                                                        | **Adapt** |
| `zoo/engine-connection.ts`           | `@taucad/types` (LibDep), `@taucad/kcl-wasm-lib` (ExtDep)                                                                                                                                                                                                                    | **Move**  |
| `zoo/error-mappers.ts`               | `@taucad/types` (LibDep), `@taucad/kcl-wasm-lib` (ExtDep)                                                                                                                                                                                                                    | **Move**  |
| `zoo/filesystem-manager.ts`          | `@taucad/types` (LibDep), `#utils/path.utils.js` (UIReplace→`@taucad/utils/path`)                                                                                                                                                                                            | **Adapt** |
| `zoo/kcl-errors.ts`                  | `@taucad/types` (LibDep), `@taucad/kcl-wasm-lib` (ExtDep)                                                                                                                                                                                                                    | **Move**  |
| `zoo/kcl-import-resolver.ts`         | `@taucad/types` (LibDep), `#utils/path.utils.js` (UIReplace→`@taucad/utils/path`)                                                                                                                                                                                            | **Adapt** |
| `zoo/kcl-utils.ts`                   | `@taucad/types` (LibDep), `@taucad/kcl-wasm-lib` (ExtDep)                                                                                                                                                                                                                    | **Move**  |
| `zoo/source-range-utils.ts`          | `@taucad/types` (LibDep)                                                                                                                                                                                                                                                     | **Move**  |
| `zoo/zoo-logs.ts`                    | `@taucad/types` (LibDep)                                                                                                                                                                                                                                                     | **Move**  |


### 3.5 Shared Utilities (→ `src/utils/`)


| File                        | Imports                                                      | Action   |
| --------------------------- | ------------------------------------------------------------ | -------- |
| `utils/content-cache-fs.ts` | None (pure Emscripten FS)                                    | **Move** |
| `utils/edge-detection.ts`   | `@taucad/types` (LibDep)                                     | **Move** |
| `utils/export-3mf.ts`       | `@taucad/types` (LibDep)                                     | **Move** |
| `utils/export-glb.ts`       | `@taucad/types` (LibDep)                                     | **Move** |
| `utils/export-stl.ts`       | `@taucad/types` (LibDep)                                     | **Move** |
| `utils/import-off.ts`       | None                                                         | **Move** |
| `utils/off-to-3mf.ts`       | Internal kernel `#` imports (Move)                           | **Move** |
| `utils/off-to-gltf.ts`      | `@taucad/types` (LibDep), internal kernel `#` imports (Move) | **Move** |
| `utils/off-to-stl.ts`       | Internal kernel `#` imports (Move)                           | **Move** |


### 3.6 Test Files (→ alongside source)


| File                                                      | Imports                                             | Action                       |
| --------------------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| `utils/common.test.ts`                                    | Internal kernel `#` imports                         | **Adapt** paths              |
| `utils/edge-detection.test.ts`                            | Internal kernel `#` imports                         | **Adapt** paths              |
| `utils/import-off.test.ts`                                | Internal kernel `#` imports                         | **Adapt** paths              |
| `utils/kernel-worker-hashing.test.ts`                     | Internal kernel `#` imports, `#utils/path.utils.js` | **Adapt**                    |
| `utils/module-manager.test.ts`                            | Internal kernel `#` imports                         | **Adapt** paths              |
| `utils/off-to-gltf.test.ts`                               | Internal kernel `#` imports                         | **Adapt** paths              |
| `bundlers/esbuild.bundler.test.ts`                        | Internal kernel `#` imports, mocks `esbuild-wasm`   | **Adapt** paths              |
| `jscad/jscad.schema.test.ts`                              | Internal kernel `#` imports                         | **Adapt** paths              |
| `jscad/jscad.worker.test.ts`                              | `@vitest-environment node`, internal `#` imports    | **Adapt** paths + test utils |
| `openscad/openscad.worker.test.ts`                        | `@vitest-environment node`, internal `#` imports    | **Adapt** paths + test utils |
| `openscad/parse-output.test.ts`                           | Internal kernel `#` imports                         | **Adapt** paths              |
| `replicad/replicad.worker.test.ts`                        | `@vitest-environment node`, internal `#` imports    | **Adapt** paths + test utils |
| `zoo/zoo.worker.test.ts`                                  | `@vitest-environment node`, internal `#` imports    | **Adapt** paths + test utils |
| `middleware/kernel-middleware.test.ts`                    | Internal kernel `#` imports                         | **Adapt** paths              |
| `middleware/kernel-worker-middleware.test.ts`             | Internal kernel `#` imports                         | **Adapt** paths              |
| `middleware/geometry-cache.middleware.test.ts`            | Internal kernel `#` imports                         | **Adapt** paths              |
| `middleware/gltf-coordinate-transform.middleware.test.ts` | Internal `#` imports                                | **Adapt** paths              |
| `middleware/gltf-edge-detection.middleware.test.ts`       | Internal kernel `#` imports                         | **Adapt** paths              |
| `middleware/parameter-cache.middleware.test.ts`           | Internal kernel `#` imports                         | **Adapt** paths              |


### 3.7 Testing Utilities (→ `src/testing/`)


| File                                     | Imports                                                                                                                                                                                            | Action          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `utils/kernel-testing.utils.ts`          | `@taucad/types` (LibDep), `@zenfs/core` (ExtDep), `#filesystem/zenfs-config.js` (UIReplace→self-contained in-memory ZenFS), `#utils/path.utils.js` (UIReplace), internal kernel `#` imports (Move) | **Adapt**       |
| `utils/kernel-geometry-testing.utils.ts` | `@gltf-transform/core` (ExtDep), `@gltf-transform/functions` (ExtDep), `@taucad/types` (LibDep)                                                                                                    | **Adapt** paths |


### 3.8 Binary Assets (→ `src/assets/` via copy)


| File                               | Action   |
| ---------------------------------- | -------- |
| `replicad/fonts/Geist-Regular.ttf` | **Copy** |
| `openscad/fonts/Geist-Bold.ttf`    | **Copy** |
| `openscad/fonts/Geist-Regular.ttf` | **Copy** |
| `utils/wasm/esbuild.wasm`          | **Copy** |


### 3.9 UI App Utility Dependencies (→ `libs/utils/`)


| UI File                 | Functions Used by Kernel                                                                                   | Current Deps                         | Migration Target                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `utils/path.utils.ts`   | `joinPath`, `normalizePath`                                                                                | None                                 | `@taucad/utils/path`                                                             |
| `utils/file.utils.ts`   | `asBuffer` only                                                                                            | None                                 | `@taucad/utils/file`                                                             |
| `utils/import.utils.ts` | `isBareSpecifier`, `parsePackageSpecifier`, `getCdnCachePath`, `resolveRelativePath`, `getNodeModulesPath` | `cdn-resolve`                        | `@taucad/utils/import`                                                           |
| `utils/schema.utils.ts` | `jsonSchemaFromJson`, `hasJsonSchemaObjectProperties`                                                      | `@taucad/json-schema`, `json-schema` | Keep in kernels package as local util (uses `@taucad/json-schema` as direct dep) |


### 3.10 Summary of UIReplace Resolutions


| UI Import                     | Used By             | Resolution                                                                               |
| ----------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| `#utils/path.utils.js`        | 7 files             | → `@taucad/utils/path` (new export in `libs/utils`)                                      |
| `#utils/file.utils.js`        | 5 files             | → `@taucad/utils/file` (new export in `libs/utils`)                                      |
| `#utils/import.utils.js`      | 2 files             | → `@taucad/utils/import` (new export in `libs/utils`)                                    |
| `#utils/schema.utils.js`      | 2 files             | → `#utils/schema.utils.js` (local copy in kernels pkg, depends on `@taucad/json-schema`) |
| `#machines/file-manager.js`   | 2 files (type only) | → Self-contained `FileManagerPortable` type in bridge file                               |
| `#filesystem/zenfs-config.js` | 1 file (test only)  | → Self-contained in-memory ZenFS setup in testing utils                                  |
| `package.json` (version)      | 1 file              | → Own `package.json` version or build-time constant                                      |


---

## 4. Public API Surface

Minimal viable API. Everything not listed here is internal and must not be importable by consumers.

### 4.1 Main Entry (`@taucad/kernels`)

Consumer-facing runtime API:

```typescript
// Zero-config factory -- resolves all module URLs internally via new URL(path, import.meta.url)
export { createDefaultConfig } from './config.js';
export type { DefaultConfigOptions, DefaultConfigResult } from './config.js';

// Main-thread client for communicating with kernel workers
export { KernelWorkerClient } from './framework/kernel-worker-client.js';
export type { OnLogCallback, OnTelemetryCallback, OnProgressCallback } from './framework/kernel-worker-client.js';

// FileManager bridge (main-thread side)
export { createFileManagerPort } from './framework/kernel-worker-filemanager-bridge.js';

// Re-export define helpers from @taucad/types for convenience
export { defineKernel, defineBundler } from '@taucad/types';

// Kernel result helpers for consumers building custom kernels
export { createKernelSuccess, createKernelError } from './framework/kernel-helpers.js';
```

### 4.2 Worker Entry (`@taucad/kernels/worker`)

Entry point for `new Worker()` or Node.js `worker_threads`. This file self-registers:

```typescript
// Re-exports KernelRuntimeWorker (self-registering in worker context)
export { KernelRuntimeWorker } from './framework/kernel-runtime-worker.js';
```

### 4.3 Middleware Authoring (`@taucad/kernels/middleware`)

For middleware authors:

```typescript
export { createKernelMiddleware, createMiddlewareRuntime } from './middleware/kernel-middleware.js';
export type { KernelMiddleware, KernelMiddlewareConfig } from './middleware/kernel-middleware.js';
```

### 4.4 Individual Kernel Modules (`@taucad/kernels/kernels/*`)

Each kernel is a standalone entry point, default-exporting a `KernelDefinition`. Consumers reference these by URL (browser) or import directly (Node.js/testing):

- `@taucad/kernels/kernels/replicad`
- `@taucad/kernels/kernels/jscad`
- `@taucad/kernels/kernels/openscad`
- `@taucad/kernels/kernels/zoo`
- `@taucad/kernels/kernels/tau`

### 4.5 Bundler Modules (`@taucad/kernels/bundler/*`)

- `@taucad/kernels/bundler/esbuild`

### 4.6 Middleware Modules (`@taucad/kernels/middleware/*`)

Each middleware is a standalone entry point, default-exporting a `KernelMiddleware`:

- `@taucad/kernels/middleware/parameter-cache`
- `@taucad/kernels/middleware/geometry-cache`
- `@taucad/kernels/middleware/gltf-coordinate-transform`
- `@taucad/kernels/middleware/gltf-edge-detection`

### 4.7 Testing Utilities (`@taucad/kernels/testing`)

For kernel/middleware authors writing tests:

```typescript
export {
  createTestWorker,
  initializeWorkerForTesting,
  seedTestFilesystem,
  clearTestFilesystem,
  createMockLogger,
  createMockFilesystem,
  createMockRuntime,
  createSuccessResult,
  createErrorResult,
  createMockInput,
  MockKernelWorker,
} from './testing/kernel-testing.utils.js';

export {
  validateGlbData,
  expectValidGltf,
  expectMeshCount,
  expectVertexCount,
  expectBoundingBoxSize,
} from './testing/kernel-geometry-testing.utils.js';
```

### 4.8 What Is NOT Exported (Internal)

- `KernelWorker` base class (framework internal, not for extension by consumers)
- `createWorkerDispatcher` (used only by the worker entry point)
- `KernelTracer`, `WorkerTelemetryCollector` (internal instrumentation)
- `createFileManagerProxy` (worker-side internal)
- `ResolvedMiddleware` type (framework internal)
- Middleware state management (`createMiddlewareState`, `createMiddlewareLogger`)
- All kernel-internal utilities (`off-to-gltf`, `edge-detection`, `content-cache-fs`, etc.)
- Module manager, import resolution internals

---

## 5. NPM Consumer Runtime Contract

### 5.1 The Problem

Kernels, middleware, and bundlers are loaded via dynamic `import(url)` **inside the worker thread**. In the browser, these URLs traditionally come from the bundler (e.g. Vite's `?url` suffix). In Node.js, there is no equivalent. Third-party consumers use different bundlers (webpack, esbuild, Rollup, Parcel) with different URL resolution strategies. Requiring consumers to use bundler-specific syntax (like `?url`) would limit the package to a single bundler ecosystem.

### 5.2 Design: Self-Resolving Modules with Configuration Override

**Approach**: Combine the cross-bundler universal `new URL('./path', import.meta.url)` pattern (already proven by `@taucad/converter` in this monorepo for WASM assets) with a `createDefaultConfig()` factory that pre-resolves all module URLs. This gives zero-config DX for 90% of consumers while preserving a full manual escape hatch.

**Industry precedent**: This is a hybrid of patterns used by Monaco Editor (`getWorkerUrl`/`getWorker`), PDF.js (`workerSrc`/`workerPort`), Three.js DRACOLoader (`setDecoderPath`/`resolveDependency`), and the web.dev-recommended universal asset pattern. It avoids the pitfalls of CDN-defaulting (Tesseract.js/ffmpeg.wasm), copy-to-public (Partytown), or bundler-plugin-required (Monaco/worker-loader) approaches.

**Why this works across environments**:

- **Vite, webpack 5, Rollup, esbuild**: All recognize `new URL('./static-path', import.meta.url)` and emit the referenced file with content hashing
- **Node.js**: `import.meta.url` resolves to `file://` URLs, which work with dynamic `import()` natively
- **Testing**: The existing `KernelModuleConfig.definition` field already supports direct injection (bypasses dynamic import entirely)

### 5.3 The `createDefaultConfig()` Factory

New file: `src/config.ts`

```typescript
import type { KernelConfig, MiddlewareConfig, BundlerConfig } from '@taucad/types';

type DefaultConfigOptions = {
  kernels?: {
    replicad?: { enabled?: boolean; options?: Record<string, unknown> };
    jscad?: { enabled?: boolean };
    openscad?: { enabled?: boolean };
    zoo?: { enabled?: boolean; options?: Record<string, unknown> };
    tau?: { enabled?: boolean };
  };
  middleware?: {
    parameterCache?: { enabled?: boolean };
    geometryCache?: { enabled?: boolean };
    gltfCoordinateTransform?: { enabled?: boolean };
    gltfEdgeDetection?: { enabled?: boolean };
  };
};

type DefaultConfigResult = {
  workerUrl: string;
  kernelConfig: KernelConfig;
  middlewareConfig: MiddlewareConfig;
  bundlerConfig: BundlerConfig;
};

export function createDefaultConfig(options?: DefaultConfigOptions): DefaultConfigResult {
  // All URLs self-resolve relative to this module's location in the built package.
  // This pattern works across all modern bundlers and Node.js without any bundler plugins.
  // @see https://web.dev/articles/bundling-non-js-resources#universal_pattern
  const workerUrl = new URL('./framework/kernel-runtime-worker.js', import.meta.url).href;

  const kernelConfig: KernelConfig = [
    { id: 'openscad', extensions: ['scad'],
      kernelModuleUrl: new URL('./kernels/openscad/openscad.kernel.js', import.meta.url).href },
    { id: 'zoo', extensions: ['kcl'], options: options?.kernels?.zoo?.options,
      kernelModuleUrl: new URL('./kernels/zoo/zoo.kernel.js', import.meta.url).href },
    { id: 'replicad', extensions: ['ts', 'js'], detectImport: /import.*from\s+['"]replicad['"]/s,
      builtinModuleNames: ['replicad'], options: options?.kernels?.replicad?.options,
      kernelModuleUrl: new URL('./kernels/replicad/replicad.kernel.js', import.meta.url).href },
    { id: 'jscad', extensions: ['ts', 'js'],
      detectImport: /import\s+.*from\s+['"]@jscad\/modeling(\/[^'"]*)?['"]/,
      builtinModuleNames: ['@jscad/modeling'],
      kernelModuleUrl: new URL('./kernels/jscad/jscad.kernel.js', import.meta.url).href },
    { id: 'tau', extensions: ['*'],
      kernelModuleUrl: new URL('./kernels/tau/tau.kernel.js', import.meta.url).href },
  ].filter(entry => options?.kernels?.[entry.id as keyof typeof options.kernels]?.enabled !== false);

  const middlewareConfig: MiddlewareConfig = [
    { url: new URL('./middleware/parameter-cache.middleware.js', import.meta.url).href },
    { url: new URL('./middleware/geometry-cache.middleware.js', import.meta.url).href },
    { url: new URL('./middleware/gltf-coordinate-transform.middleware.js', import.meta.url).href },
    { url: new URL('./middleware/gltf-edge-detection.middleware.js', import.meta.url).href },
  ];

  const bundlerConfig: BundlerConfig = [
    { bundlerModuleUrl: new URL('./bundler/esbuild.bundler.js', import.meta.url).href,
      extensions: ['ts', 'js', 'tsx', 'jsx'] },
  ];

  return { workerUrl, kernelConfig, middlewareConfig, bundlerConfig };
}
```

### 5.4 Consumer Usage Patterns

**Zero-config (any bundler or Node.js)** -- the recommended path:

```typescript
import { createDefaultConfig, KernelWorkerClient, createFileManagerPort } from '@taucad/kernels';

const { workerUrl, kernelConfig, middlewareConfig, bundlerConfig } = createDefaultConfig();
const worker = new Worker(workerUrl, { type: 'module' });
const client = new KernelWorkerClient(worker, onLog);
await client.initialize({ kernelModules: kernelConfig }, fileManagerPort, middlewareConfig, bundlerConfig);
```

**Customized (override specific options)**:

```typescript
const config = createDefaultConfig({
  kernels: {
    replicad: { options: { withExceptions: true } },
    zoo: { enabled: false },
  },
});
```

**Full manual control (power users)**:

```typescript
import { KernelWorkerClient, createFileManagerPort } from '@taucad/kernels';
import type { KernelConfig, MiddlewareConfig, BundlerConfig } from '@taucad/types';

// Consumer resolves URLs however their environment requires
const kernelConfig: KernelConfig = [
  { id: 'replicad', kernelModuleUrl: myCustomReplicadUrl, extensions: ['ts', 'js'], ... },
  { id: 'my-custom-kernel', kernelModuleUrl: myKernelUrl, extensions: ['xyz'] },
];
```

**Node.js (with worker_threads)**:

```typescript
import { Worker } from 'node:worker_threads';
import { createDefaultConfig, KernelWorkerClient } from '@taucad/kernels';

const { workerUrl, kernelConfig, middlewareConfig, bundlerConfig } = createDefaultConfig();
const worker = new Worker(new URL(workerUrl));
// kernel-message-adapter.ts handles Node.js MessagePort automatically
```

**Testing (direct injection, no worker or URL resolution needed)**:

```typescript
import replicadKernel from '@taucad/kernels/kernels/replicad';
import { createTestWorker } from '@taucad/kernels/testing';

const worker = await createTestWorker({
  kernels: [{ id: 'replicad', definition: replicadKernel }],
});
```

### 5.5 Why This Approach


| Concern                  | `?url` (Vite-only)    | `createDefaultConfig()` (proposed)             |
| ------------------------ | --------------------- | ---------------------------------------------- |
| Vite                     | Works                 | Works                                          |
| webpack 5                | Requires plugin       | Works natively (`new URL` pattern)             |
| Rollup/esbuild           | Not supported         | Works natively                                 |
| Node.js                  | Not supported         | Works natively (`file://` URLs)                |
| Bundler plugins required | Yes                   | No                                             |
| Consumer setup lines     | 10+ import statements | 1 function call                                |
| Customizability          | Full (manual URLs)    | Full (options + manual override)               |
| External CDN dependency  | No                    | No                                             |
| Tested in this monorepo  | N/A                   | `@taucad/converter` uses same pattern for WASM |


### 5.6 Build Output Requirements

`tsdown` must produce **unbundled** output (`unbundle: true`) so each subpath maps to a real file on disk. This ensures:

- `new URL('./kernels/replicad/replicad.kernel.js', import.meta.url)` resolves to an actual file in the published package
- Bundlers include the referenced files in their output with content hashing
- WASM and font assets are co-located with their consumers for correct `new URL('./asset', import.meta.url)` resolution
- Both the ESM and CJS builds preserve the file structure

### 5.7 Package `exports` Map

```json
{
  ".": "./src/index.ts",
  "./worker": "./src/framework/kernel-runtime-worker.ts",
  "./middleware": "./src/middleware/kernel-middleware.ts",
  "./kernels/replicad": "./src/kernels/replicad/replicad.kernel.ts",
  "./kernels/jscad": "./src/kernels/jscad/jscad.kernel.ts",
  "./kernels/openscad": "./src/kernels/openscad/openscad.kernel.ts",
  "./kernels/zoo": "./src/kernels/zoo/zoo.kernel.ts",
  "./kernels/tau": "./src/kernels/tau/tau.kernel.ts",
  "./bundler/esbuild": "./src/bundler/esbuild.bundler.ts",
  "./middleware/parameter-cache": "./src/middleware/parameter-cache.middleware.ts",
  "./middleware/geometry-cache": "./src/middleware/geometry-cache.middleware.ts",
  "./middleware/gltf-coordinate-transform": "./src/middleware/gltf-coordinate-transform.middleware.ts",
  "./middleware/gltf-edge-detection": "./src/middleware/gltf-edge-detection.middleware.ts",
  "./testing": "./src/testing/index.ts"
}
```

With corresponding `publishConfig.exports` defining dual CJS/ESM paths with type declarations.

---

## 6. Testing Strategy

### 6.1 Environment Matrix


| Test Category                                                | Environment                                  | Rationale                                                                |
| ------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------ |
| Framework unit tests (middleware, helpers, common)           | `node` (default)                             | Pure logic, no browser APIs                                              |
| Worker integration tests (`*.worker.test.ts`)                | `node` (explicit `@vitest-environment node`) | Tests kernel definitions end-to-end via in-process `KernelRuntimeWorker` |
| Utility tests (OFF parsing, edge detection, GLTF conversion) | `node`                                       | Pure computation                                                         |
| Bundler tests                                                | `node`                                       | esbuild-wasm works in Node.js                                            |
| Geometry validation tests                                    | `node`                                       | `@gltf-transform` is Node.js compatible                                  |


All tests default to `node` environment. Worker tests already use `@vitest-environment node` directives and will continue to do so.

### 6.2 Environment Agnosticism Validation

The following APIs are used by the kernel framework and must work in both environments:


| API                               | Node.js          | Browser     | Status                                         |
| --------------------------------- | ---------------- | ----------- | ---------------------------------------------- |
| `crypto.subtle.digest`            | 15+              | All modern  | Already used, works                            |
| `performance.now()`               | All              | All         | Already used, works                            |
| `TextEncoder`/`TextDecoder`       | All              | All         | Already used, works                            |
| `MessageChannel`/`MessagePort`    | `worker_threads` | All         | `kernel-message-adapter.ts` handles both       |
| `fetch`                           | 18+              | All         | Used for asset hashing; tests mock it          |
| Dynamic `import()`                | All              | All         | Used for module loading                        |
| `self.postMessage` / `parentPort` | `worker_threads` | Web Workers | `kernel-message-adapter.ts` detects and adapts |


### 6.3 Dual-Environment Test Gates (Phase 5)

Beyond the unit/integration tests above, add these validation gates:

1. **CJS import smoke test** (`src/testing/smoke-cjs.test.ts`):
  - Verifies the built CJS output can be `require()`'d
  - Checks that main exports resolve correctly
2. **ESM import smoke test** (`src/testing/smoke-esm.test.ts`):
  - Verifies the built ESM output can be `import`'d
  - Checks that subpath exports (`/kernels/replicad`, `/middleware`, etc.) resolve correctly
3. **jsdom environment gate** (`src/testing/browser-compat.test.ts`):
  - Uses `@vitest-environment jsdom`
  - Imports the main entry point and key modules
  - Verifies no Node.js-only APIs are unconditionally used at import time
  - Verifies `isBrowserWorkerContext()` / `isWorkerContext()` detection works

### 6.4 Test Adaptation

- `kernel-testing.utils.ts`: Replace `#filesystem/zenfs-config.js` imports with a self-contained in-memory ZenFS configuration. The function `seedTestFilesystem()` will configure ZenFS with `InMemory` backend directly, removing the dependency on the UI app's filesystem configuration.
- `kernel-geometry-testing.utils.ts`: Only needs import path updates.
- All test files: Rewrite `#components/geometry/kernel/...` imports to `#framework/...`, `#middleware/...`, `#kernels/...`, etc.

---

## 7. Package Configuration

### 7.1 `packages/kernels/package.json`

Key sections:

**Dependencies** (production):

```
@taucad/types: workspace:*
@taucad/utils: workspace:*
@taucad/converter: workspace:*
@taucad/json-schema: workspace:*
deepmerge, zod, type-fest
@msgpack/msgpack, uint8array-extras
esbuild-wasm, cdn-resolve
replicad, replicad-opencascadejs, source-map-js
@jscad/modeling
openscad-wasm-prebuilt, json-schema, json-schema-default
@taucad/kcl-wasm-lib
@gltf-transform/core, @gltf-transform/functions (for testing utils)
```

**Dev dependencies**:

```
vitest, @zenfs/core, @zenfs/dom (test only)
```

### 7.2 `tsdown.config.ts`

Multiple entry points (one per export path), `unbundle: true`, asset copying for fonts and WASM.

### 7.3 `vitest.config.ts`

Default `node` environment, setup file for minimal mocks, typecheck enabled.

### 7.4 `tsconfig.lib.json`

Project references to `libs/types`, `libs/utils`. `NodeNext` module resolution.

---

## 8. Directory Structure

```
packages/kernels/
  src/
    index.ts                          # Public API (Section 4.1)
    config.ts                         # createDefaultConfig() factory (Section 5.3)

    framework/
      kernel-worker.ts                # KernelWorker base class (internal)
      kernel-runtime-worker.ts        # Worker entry (self-registering)
      kernel-worker-client.ts         # Main-thread client (public)
      kernel-worker-dispatcher.ts     # Worker-side dispatcher (internal)
      kernel-message-adapter.ts       # Isomorphic message adapter (internal)
      kernel-worker-filemanager-bridge.ts  # FM bridge (public: createFileManagerPort)
      kernel-helpers.ts               # Result helpers (public)
      kernel-tracer.ts                # Tracer (internal)
      worker-telemetry.ts             # Telemetry (internal)
      error-enrichment.ts             # Error enrichment (internal)
      common.ts                       # Common utils (internal)

    middleware/
      kernel-middleware.ts            # createKernelMiddleware (public)
      geometry-cache.middleware.ts    # Built-in middleware (public as module)
      gltf-coordinate-transform.middleware.ts
      gltf-edge-detection.middleware.ts
      parameter-cache.middleware.ts

    bundler/
      esbuild.bundler.ts              # Built-in bundler (public as module)
      module-manager.ts               # Internal

    kernels/
      tau/tau.kernel.ts
      replicad/
        replicad.kernel.ts
        replicad.types.ts
        init-open-cascade.ts
        oc-exceptions.ts
        utils/normalize-color.ts
        utils/render-output.ts
        utils/replicad-to-gltf.ts
        fonts/Geist-Regular.ttf
      jscad/
        jscad.kernel.ts
        jscad.schema.ts
        jscad-to-gltf.ts
      openscad/
        openscad.kernel.ts
        parse-output.ts
        parse-parameters.ts
        fonts/Geist-Bold.ttf
        fonts/Geist-Regular.ttf
      zoo/
        zoo.kernel.ts
        engine-connection.ts
        error-mappers.ts
        filesystem-manager.ts
        kcl-errors.ts
        kcl-import-resolver.ts
        kcl-utils.ts
        source-range-utils.ts
        zoo-logs.ts

    utils/
      schema.utils.ts                 # Local schema utils (depends on @taucad/json-schema)
      content-cache-fs.ts
      edge-detection.ts
      export-3mf.ts
      export-glb.ts
      export-stl.ts
      import-off.ts
      off-to-3mf.ts
      off-to-gltf.ts
      off-to-stl.ts

    testing/
      index.ts                        # Public testing API barrel
      kernel-testing.utils.ts
      kernel-geometry-testing.utils.ts
```

---

## 9. Migration Sequence

### Phase 0: Dependency Tree Validation

- Generate the inventory above as a checklist
- Verify every file and import is accounted for
- Confirm no undiscovered dependencies

### Phase 1: Prepare `libs/utils`

- Add `path`, `file`, `import` export paths to `@taucad/utils`
- Copy `normalizePath`/`joinPath` → `libs/utils/src/path.utils.ts`
- Copy `asBuffer` → `libs/utils/src/file.utils.ts`
- Copy import resolution functions → `libs/utils/src/import.utils.ts`
- Add `cdn-resolve` as dependency of `@taucad/utils`
- Update `libs/utils/package.json` exports and `tsconfig`
- Update UI app to import from `@taucad/utils/*` for these functions
- Verify UI tests pass: `pnpm nx test ui --watch=false`

### Phase 2: Decouple `FileManager` Type

- In `kernel-worker-filemanager-bridge.ts`, replace `import type { FileManager } from '#machines/file-manager.js'` with a self-contained `FileManagerPortable` type that declares the method signatures needed by the proxy
- The proxy's return type already inline-defines the interface -- make the `FileManagerPortable` type the canonical reference
- Verify: `pnpm nx typecheck ui`

### Phase 3: Scaffold and Populate `packages/kernels/`

- **3a**: Set up all config files based on existing `packages/converter/` patterns:
  - `package.json` with exports map, dependencies, publishConfig
  - `tsconfig.json`, `tsconfig.lib.json`, `tsconfig.spec.json`, `tsconfig.build.json`
  - `vitest.config.ts`, `vitest.setup.ts`
  - `tsdown.config.ts` with unbundled multi-entry config
  - `project.json`, `copy-files-from-to.cjson`
- **3b**: Copy files per the directory structure above
- **3c**: Rewrite all imports:
  - `#components/geometry/kernel/utils/`* → `#framework/`* or `#utils/`*
  - `#components/geometry/kernel/middleware/`* → `#middleware/*`
  - `#components/geometry/kernel/bundlers/*` → `#bundler/*`
  - `#components/geometry/kernel/*/` → `#kernels/*/`
  - `#utils/path.utils.js` → `@taucad/utils/path`
  - `#utils/file.utils.js` → `@taucad/utils/file`
  - `#utils/import.utils.js` → `@taucad/utils/import`
  - `#utils/schema.utils.js` → `#utils/schema.utils.js` (local copy)
  - `#machines/file-manager.js` → removed (self-contained type)
  - `package.json` version → own package.json or constant
- **3d**: Copy `schema.utils.ts` into `src/utils/` (local to kernels, depends on `@taucad/json-schema`)
- **3e**: Create `src/config.ts` with `createDefaultConfig()` factory
  - Uses `new URL('./relative-path', import.meta.url).href` for all module URLs (worker, kernels, middleware, bundler)
  - Accepts optional `DefaultConfigOptions` for enabling/disabling kernels and overriding options
  - Returns `{ workerUrl, kernelConfig, middlewareConfig, bundlerConfig }`
  - Following the universal asset pattern already proven by `@taucad/converter`
- **3f**: Create `src/index.ts` with public API exports (including `createDefaultConfig`)
- **3g**: Create `src/testing/index.ts` barrel

### Phase 4: Adapt Tests

- Adapt `kernel-testing.utils.ts` to use self-contained in-memory ZenFS
- Rewrite test import paths
- Create `vitest.setup.ts` with minimal mocks
- Run: `pnpm nx test kernels --watch=false`
- Fix any failures

### Phase 5: Dual-Environment Test Gates

- Add CJS import smoke test
- Add ESM import smoke test
- Add jsdom browser-compatibility gate test
- Run: `pnpm nx test kernels --watch=false`

### Phase 6: Update UI App

- Add `@taucad/kernels: workspace:`* to UI `package.json`
- Rewrite `kernel-worker.constants.ts`:
  - Replace all `?url` imports with a single `createDefaultConfig()` call from `@taucad/kernels`
  - `defaultKernelConfig`, `debugKernelConfig`, `defaultMiddlewareConfig`, `defaultBundlerConfig` derived from the factory
  - The `debugKernelConfig` variant passes `{ kernels: { replicad: { options: { withExceptions: true } } } }`
  - The `ENV.TAU_WEBSOCKET_URL` for zoo kernel is injected via `createDefaultConfig({ kernels: { zoo: { options: { baseUrl } } } })`
- Update `kernel.machine.ts` to import `KernelWorkerClient` and `createFileManagerPort` from `@taucad/kernels`
- Update `kernel.machine.ts` to use `workerUrl` from the config instead of `?url` import of runtime worker
- Update route files that import kernel/middleware URLs directly (e.g. `auth-splashback.tsx`) to use `createDefaultConfig()` or individual subpath imports with the universal `new URL` pattern
- Update `kcl-register-language.ts` dynamic import path
- Remove `apps/ui/app/components/geometry/kernel/` directory
- Add `@taucad/kernels` to Vite's `optimizeDeps.exclude` to preserve `new URL()` resolution during dev
- Run: `pnpm nx test ui --watch=false`

### Phase 7: Final Verification

- `pnpm nx typecheck kernels`
- `pnpm nx lint kernels`
- `pnpm nx build kernels` -- verify dist output structure
- `pnpm nx typecheck ui && pnpm nx test ui --watch=false`
- Inspect tarball contents: `cd packages/kernels && pnpm pack --dry-run`
- Verify exports map resolves correctly in built output


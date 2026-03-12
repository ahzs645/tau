---
name: new-kernel
description: Add a new first-party CAD kernel to Tau's @taucad/kernels plugin system. Use when adding a kernel, integrating a new CAD engine, implementing defineKernel, or wiring kernel factories, exports, presets, and UI catalog entries.
---

# New Kernel Integration

Add a new first-party CAD kernel to Tau following the `@taucad/kernels` plugin architecture.

## Definition of Done

1. Kernel implementation at `packages/kernels/src/kernels/<id>/<id>.kernel.ts`
2. Comprehensive tests pass at `packages/kernels/src/kernels/<id>/<id>.kernel.test.ts`
3. Wired into plugin factories, presets, exports, build entries
4. UI default/debug options include kernel where applicable
5. Type/catalog metadata in `libs/types/src/constants/kernel.constants.ts`
6. Prompt configuration supports the kernel
7. Monaco IntelliSense types extracted, exported, and registered
8. Nx lint/typecheck/test pass

## 1) Implement Kernel

**File:** `packages/kernels/src/kernels/<id>/<id>.kernel.ts`

Use `defineKernel({...})` from `#types/kernel-worker.types.js`:

```typescript
import { defineKernel } from '#types/kernel-worker.types.js';
import { createKernelError, createKernelSuccess } from '#framework/kernel-helpers.js';

export default defineKernel({
  name: '<Name>Kernel',
  version: '1.0.0',
  optionsSchema, // zod schema

  async initialize(options, runtime) {
    /* load WASM/SDK, register modules */
  },
  async canHandle({ filePath, extension }, runtime) {
    /* detect file type — must be fast */
  },
  async getDependencies({ filePath }, runtime) {
    /* resolve deps — usually runtime.bundler.resolveDependencies(filePath) for JS/TS */
  },
  async getParameters({ filePath, basePath }, runtime, context) {
    /* extract defaultParams and return JSON schema */
  },
  async createGeometry({ filePath, basePath, parameters }, runtime, context) {
    /* bundle + execute user code; return { geometry, nativeHandle } */
  },
  async exportGeometry({ fileType, nativeHandle }, runtime, context) {
    /* export from nativeHandle */
  },
  async cleanup(context) {
    /* release WASM/manual resources (optional but recommended) */
  },
});
```

Key patterns:

- `runtime.bundler.registerModule(name, { code, version })` for built-in module registration
- `runtime.bundler.bundle(filePath)` + `runtime.execute(code)` for user code
- `createKernelSuccess(data)` / `createKernelError(issues)` for structured results in non-throw paths
- Throw `Error` with `.issues` array (custom `*BuildError`) for fatal geometry failures so framework returns structured issues
- Prefer stack enrichment utilities in `#framework/error-enrichment.js` for JS/TS kernels

Reference: `packages/kernels/src/kernels/replicad/replicad.kernel.ts`

## 2) Add Tests

**File:** `packages/kernels/src/kernels/<id>/<id>.kernel.test.ts`

### Mandatory shared utils

All kernel tests MUST use helpers from `#testing/kernel-testing.utils.js`. Do NOT define local mock helpers for filesystem, logger, or runtime — use the shared utilities.

| Helper                                            | Purpose                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `createMockKernelRuntime(options?)`               | Unit tests calling kernel methods directly (`canHandle`, `createGeometry`, etc.)  |
| `createTestWorker(definition, files, options?)`   | Integration tests via `KernelRuntimeWorker` with seeded filesystem                |
| `createGeometryFile(filename, basePath?)`         | Build `GeometryFile` for worker methods                                           |
| `createGeometryTestHelpers()`                     | GLTF validation (`expectValidGltf`, `expectVertexCount`, `expectBoundingBoxSize`) |
| `createMockLogger()`                              | Mock `KernelLogger` with vitest mocks for all log levels                          |
| `createMockFileSystem(options?)`                  | Mock `KernelFileSystem` with vitest mocks and `.mocks` property                   |
| `assertSuccess(result)` / `assertFailure(result)` | Type-narrowing assertions on `KernelResult`                                       |

### Test structure example

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { KernelRuntime, CanHandleInput, CreateGeometryInput } from '#types/kernel-worker.types.js';
import { createMockKernelRuntime } from '#testing/kernel-testing.utils.js';
import myKernel from '#kernels/my-kernel/my-kernel.kernel.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MyKernel', () => {
  describe('canHandle', () => {
    it('should return true for supported extension', async () => {
      const result = await myKernel.canHandle!(mock<CanHandleInput>({ extension: 'ext' }), mock<KernelRuntime>(), {});
      expect(result).toBe(true);
    });
  });

  describe('createGeometry', () => {
    it('should return geometry on success', async () => {
      const runtime = createMockKernelRuntime({
        filesystemOverrides: { readFileResult: new Uint8Array([1, 2, 3]) },
      });

      const result = await myKernel.createGeometry(
        mock<CreateGeometryInput>({ filePath: '/test/model.ext', basePath: '/test' }),
        runtime,
        {},
      );

      expect(result.geometry).toHaveLength(1);
    });
  });
});
```

### Minimum coverage

- `canHandle` — positive and negative cases
- `getParameters` — defaults extraction + empty fallback
- `createGeometry` — happy path + parameterized + error cases
- `exportGeometry` — supported and unsupported formats + no-geometry failure

Reference quality bar: `jscad.kernel.test.ts`, `replicad.kernel.test.ts`

## 3) Wire Into System

### 3.1 Plugin factory

**File:** `packages/kernels/src/plugins/kernel-factories.ts`

```typescript
export const <id> = createKernelPlugin<Options>({
  id: '<id>',
  moduleUrl: new URL('../kernels/<id>/<id>.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: /import.*from\s+["']<library>["']/s,
  builtinModuleNames: ['<library>'],
});
```

### 3.2 Export factory

**File:** `packages/kernels/src/plugins/kernels-entry.ts`

Add: `export { <id> } from '#plugins/kernel-factories.js';`

### 3.3 Presets

**File:** `packages/kernels/src/plugins/presets.ts`

Add `<id>()` to `presets.all().kernels` array in priority order.

### 3.4 Package exports

**File:** `packages/kernels/package.json`

Source export:

```json
"./kernels/<id>": "./src/kernels/<id>/<id>.kernel.ts"
```

publishConfig export (mirror `./kernels/tau` pattern):

```json
"./kernels/<id>": {
  "require": { "types": "./dist/cjs/kernels/<id>/<id>.kernel.d.cts", "default": "./dist/cjs/kernels/<id>/<id>.kernel.cjs" },
  "import": { "types": "./dist/esm/kernels/<id>/<id>.kernel.d.ts", "default": "./dist/esm/kernels/<id>/<id>.kernel.js" }
}
```

### 3.5 Build entry

**File:** `packages/kernels/tsdown.config.ts`

Add `'src/kernels/<id>/<id>.kernel.ts'` to `entry` array.

### 3.6 Smoke import

**File:** `packages/kernels/src/testing/smoke-esm.test.ts`

```typescript
const <id>Module = await import('#kernels/<id>/<id>.kernel.js');
expect(<id>Module.default).toBeDefined();
```

### 3.7 UI defaults

**File:** `apps/ui/app/constants/kernel-worker.constants.ts`

Import and add `<id>()` to `defaultKernelOptions.kernels`.

### 3.8 Catalog metadata

**File:** `libs/types/src/constants/kernel.constants.ts`

Add entry to `kernelConfigurations` with `id`, `name`, `language`, `dimensions`, `description`, `mainFile`, `backendProvider`, `longDescription`, `emptyCode`, `recommended`, `tags`, `features`.

### 3.9 Monaco IntelliSense types

The editor provides IntelliSense for kernel imports via bundled `.d.ts` files registered with Monaco's `addExtraLib`. If the kernel exposes a JS/TS API that users import (e.g. `import ... from '<library>'`), add type definitions to the Monaco pipeline.

All kernels use the same **JSON map approach**: `buildBundledTypes()` returns `Record<string, string>` mapping module paths to raw `.d.ts` content. Each entry is registered at `file:///node_modules/<modulePath>/index.d.ts`. Do **not** use `declare module` wrappers (causes TS1038 in already-ambient contexts).

1. **Create extraction script:** `libs/api-extractor/src/extract-<id>-types.ts`
   - Read the kernel's `.d.ts` file(s)
   - Keep `export declare` as-is (valid in raw module `.d.ts` files)
   - Export `buildBundledTypes(): Record<string, string>` (for testability) and a `main()` CLI entry
   - In `main()`, write `<id>.bundled.json` (JSON-serialized map) to `generated/<id>/`
   - Also write individual `.d.ts` files under `generated/<id>/modules/<module-path>/index.d.ts` for type-level testing
   - Use `extract-manifold-types.ts` as template (simple wrapping) or `extract-jscad-types.ts` (TS Compiler API deep extraction)

   For single-module kernels, the map has one entry. For kernels with subpath exports, include an entry per subpath:

   ```typescript
   export function buildBundledTypes(): Record<string, string> {
     return {
       '<library>': mainContent,
       '<library>/sub': subContent,
     };
   }
   ```

2. **Add Nx target:** `libs/api-extractor/project.json`

   ```json
   "extract-<id>": {
     "executor": "nx:run-commands",
     "options": {
       "command": "tsx src/extract-<id>-types.ts",
       "cwd": "libs/api-extractor"
     }
   }
   ```

3. **Export from `@taucad/api-extractor`:** `libs/api-extractor/src/index.ts`

   ```typescript
   export { default as <id>TypesMap } from '#generated/<id>/<id>.bundled.json?raw';
   ```

4. **Register in Monaco:** `apps/ui/app/lib/javascript-contribution.ts`

   Add the imported map to the `kernelTypeMaps` array. The existing `flatMap` loop handles parsing and registration automatically:

   ```typescript
   const kernelTypeMaps = [
     opencascadeTypesMap,
     replicadTypesMap,
     jscadModelingTypesMap,
     manifoldTypesMap,
     <id>TypesMap,
   ];
   ```

5. **Add type-level tests:** `libs/api-extractor/src/generated/<id>/<id>.bundled.test-d.ts`

   Add path mappings in `tsconfig.typetest.json` pointing to the `modules/` directory. Write `.test-d.ts` tests verifying module resolution, key exports, and class shapes using `expectTypeOf`.

6. **Run extraction:** `pnpm nx extract-<id> api-extractor`

## 4) Prompt System Integration

Add kernel prompt config files under `apps/api/app/api/chat/prompts/kernel-prompt-configs/`:

- `<id>.prompt.config.ts`
- `<id>.prompt.example.<ext>`
- Register in `kernel.prompt.config.ts` map

Use existing configs (replicad/jscad/zoo/openscad) as templates.

## 5) Documentation Updates

At minimum update:

- `docs/policy/kernel-architecture-policy.md`
- Kernel docs site pages under `apps/ui/content/docs/(kernels)/...`:
  - index, choosing-a-kernel, installation, api/kernels, concepts/plugin-system, guides/bundler-configuration

Update all kernel lists/comparison tables, examples, and selection priority references.

## 6) Verify

```bash
pnpm nx typecheck kernels
pnpm nx test kernels --watch=false
pnpm nx lint kernels
pnpm nx typecheck ui
pnpm nx lint ui
```

If `apps/api` files changed:

```bash
pnpm nx typecheck api
pnpm nx lint api
pnpm nx test api --watch=false
```

## 7) Agent Execution Protocol

Recommended order:

1. Implement kernel + tests first
2. Wire factories/exports/build/smoke
3. Wire UI + type catalog + prompts
4. Update docs
5. Run Nx checks and fix all regressions
6. Commit with descriptive message

Keep commits logically grouped (implementation, wiring, docs) if practical.

## File Checklist

- [ ] `packages/kernels/src/kernels/<id>/<id>.kernel.ts`
- [ ] `packages/kernels/src/kernels/<id>/<id>.kernel.test.ts`
- [ ] `packages/kernels/src/plugins/kernel-factories.ts`
- [ ] `packages/kernels/src/plugins/kernels-entry.ts`
- [ ] `packages/kernels/src/plugins/presets.ts`
- [ ] `packages/kernels/package.json`
- [ ] `packages/kernels/tsdown.config.ts`
- [ ] `packages/kernels/src/testing/smoke-esm.test.ts`
- [ ] `apps/ui/app/constants/kernel-worker.constants.ts`
- [ ] `libs/types/src/constants/kernel.constants.ts`
- [ ] `apps/api/app/api/chat/prompts/kernel-prompt-configs/<id>.prompt.config.ts`
- [ ] `apps/api/app/api/chat/prompts/kernel-prompt-configs/<id>.prompt.example.<ext>`
- [ ] `libs/api-extractor/src/extract-<id>-types.ts` (extraction script producing JSON map)
- [ ] `libs/api-extractor/src/index.ts` (export `<id>TypesMap` via `?raw`)
- [ ] `apps/ui/app/lib/javascript-contribution.ts` (add to `kernelTypeMaps` array)
- [ ] `libs/api-extractor/src/generated/<id>/<id>.bundled.test-d.ts` (type-level tests)
- [ ] `libs/api-extractor/tsconfig.typetest.json` (add path mappings for new kernel)
- [ ] Kernel docs pages + architecture policy updates

## Common Failure Modes

- Forgot `tsdown` entry → build output missing
- Forgot `kernels-entry.ts` export → consumer import fails
- `canHandle` too broad/slow → kernel mis-selection
- Missing `builtinModuleNames` for JS/TS kernels → transitive import detection fails
- Missing `publishConfig` export → package consumers break
- Added kernel to code but not to docs comparisons → docs drift
- Defined local mock helpers instead of using shared testing utils → maintenance burden
- Forgot Monaco IntelliSense types → no editor autocomplete for the kernel's API
- Used `declare module` wrapper instead of raw `.d.ts` + JSON map → TS1038 errors in Monaco
- Forgot to add `modules/` directory output in extraction script → type-level tests can't resolve imports
- Forgot to add path mappings in `tsconfig.typetest.json` → `vitest --typecheck` fails

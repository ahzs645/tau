---
name: new-kernel
description: Add a new first-party CAD kernel to Tau's @taucad/kernels plugin system. Use when adding a kernel, integrating a new CAD engine, implementing defineKernel, or wiring kernel factories, exports, presets, and UI catalog entries.
---

# New Kernel Integration

Add a new first-party CAD kernel to Tau following the `@taucad/kernels` plugin architecture.

## Definition of Done

1. Kernel implementation at `packages/kernels/src/kernels/<id>/<id>.kernel.ts`
2. Tests pass at `packages/kernels/src/kernels/<id>/<id>.kernel.test.ts`
3. Wired into plugin factories, presets, exports, build entries
4. UI default/debug options include kernel where applicable
5. Type/catalog metadata in `libs/types/src/constants/kernel.constants.ts`
6. Nx lint/typecheck/test pass

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
    /* detect file type */
  },
  async getDependencies({ filePath }, runtime) {
    /* resolve deps */
  },
  async getParameters({ filePath, basePath }, runtime, context) {
    /* extract defaultParams */
  },
  async createGeometry({ filePath, basePath, parameters }, runtime, context) {
    /* build geometry */
  },
  async exportGeometry({ fileType, nativeHandle }, runtime, context) {
    /* export STEP/STL/GLTF */
  },
});
```

Key patterns:

- `runtime.bundler.registerModule(name, { code, version })` for built-in module registration
- `runtime.bundler.bundle(filePath)` + `runtime.execute(code)` for user code
- `createKernelSuccess(data)` / `createKernelError(issues)` for structured results
- Throw `Error` with `.issues` array for fatal geometry failures

Reference: `packages/kernels/src/kernels/replicad/replicad.kernel.ts`

## 2) Add Tests

**File:** `packages/kernels/src/kernels/<id>/<id>.kernel.test.ts`

Use helpers from `#testing/kernel-testing.utils.js` and `#testing/kernel-geometry-testing.utils.js`.

Minimum coverage:

- `canHandle` — positive and negative cases
- `getParameters` — defaults extraction + empty fallback
- `createGeometry` — happy path + parameterized + error cases
- `exportGeometry` — supported and unsupported formats

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

## 4) Verify

```bash
pnpm nx typecheck kernels
pnpm nx test kernels --watch=false
pnpm nx lint kernels
pnpm nx typecheck ui
pnpm nx lint ui
```

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

## Common Failure Modes

- Forgot `tsdown` entry → build output missing
- Forgot `kernels-entry.ts` export → consumer import fails
- `canHandle` too broad → kernel mis-selection
- Missing `builtinModuleNames` → transitive import detection fails
- Missing `publishConfig` export → package consumers break

For detailed reference, see [docs/playbook/new-kernel-instructions.md](docs/playbook/new-kernel-instructions.md).

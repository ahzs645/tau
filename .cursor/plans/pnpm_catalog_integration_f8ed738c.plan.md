---
name: PNPM Catalog Integration
overview: "Add pnpm catalog infrastructure to the Tau monorepo to prevent dependency version drift across all workspace packages, integrated as an early phase of the kernel migration plan. All shared dependencies get centralized version definitions in pnpm-workspace.yaml with catalog: protocol references in package.json files."
todos:
  - id: catalog-setup
    content: "Phase C0: Add catalog section to pnpm-workspace.yaml with all Tier 1-3 deps and catalogMode: prefer"
    status: pending
  - id: catalog-root
    content: "Phase C1: Update root package.json -- replace all cataloged dep versions with catalog:"
    status: pending
  - id: catalog-subpackages
    content: "Phase C2: Update converter, js, json-schema, and ui package.json files to use catalog: (includes version alignment for gltf-transform, xstate, isbot)"
    status: pending
  - id: catalog-verify
    content: "Phase C3: Run pnpm install, typecheck, and tests to verify catalog migration"
    status: pending
  - id: catalog-publish-safety
    content: "Phase C4: Verify pnpm pack --dry-run for all publishable packages shows no catalog: in output manifest"
    status: pending
isProject: false
---

# PNPM Catalog Integration + Kernel Migration Plan Update

## Context

The Tau monorepo (pnpm 10.13.1, which supports catalogs since 9.5.0) currently has ~160 production deps + ~78 dev deps in the root [package.json](package.json), with minimal overlap across sub-packages today. However, as `@taucad/kernels` is extracted (carrying ~20 production deps out of root into its own `package.json`), version drift becomes a real risk. Catalogs solve this preemptively.

Current [pnpm-workspace.yaml](pnpm-workspace.yaml) has no catalog entries. The workspace contains 3 publishable packages (`converter`, `js`, `json-schema`) plus the soon-to-be-created `kernels`, 6 internal libs, and 2 apps.

---

## 1. Catalog Scope and Strategy

### 1.1 What Goes Into the Catalog

Three tiers of dependencies to catalog:

**Tier 1 -- Currently duplicated (version alignment needed first):**

- `@gltf-transform/core`: root `^4.3.0` vs converter `^4.2.1` -- align to `^4.3.0`
- `@gltf-transform/extensions`: root `^4.3.0` vs converter `^4.2.1` -- align to `^4.3.0`
- `@gltf-transform/functions`: root `^4.3.0` vs converter `^4.2.1` -- align to `^4.3.0`
- `xstate`: root `^5.19.3` vs js `^5.24.0` -- align to `^5.24.0`
- `@types/json-schema`: root devDeps `^7.0.15` = json-schema devDeps `^7.0.15` (already aligned)
- `@react-router/node`: root `^7.9.6` = ui `^7.9.6` (already aligned)
- `isbot`: root `^5.1.28` vs ui `^5` -- align to `^5.1.28`

**Tier 2 -- Will be duplicated after kernel extraction (proactive):**

These deps currently live only in root but will also appear in `packages/kernels/package.json`:

- `replicad`, `replicad-opencascadejs`, `@jscad/modeling`, `openscad-wasm-prebuilt`
- `@taucad/kcl-wasm-lib`, `esbuild-wasm`, `es-module-lexer`
- `cdn-resolve` (via `@taucad/utils`), `@msgpack/msgpack`, `deepmerge`
- `source-map-js`, `json-schema`, `json-schema-default`, `uint8array-extras`
- `zod`, `type-fest`, `comlink`
- `@zenfs/core`, `@zenfs/dom` (kernels devDeps)

**Tier 3 -- Shared tooling/framework deps (single version enforcement):**

Even if currently only in root, these should be cataloged to prevent drift when packages add their own devDeps:

- `vitest`, `@vitest/coverage-v8`, `@vitest/ui`
- `typescript`, `tsdown`, `tslib`
- `eslint`, `xo`, `prettier` and their plugins
- `@types/node`, `@types/react`, `@types/react-dom`
- `vite` and its plugins
- All `@nx/`* packages (pinned at `21.3.10`)
- `react`, `react-dom`, `react-router` and `@react-router/`*
- `@testing-library/`*

### 1.2 Catalog Structure

Use the **default catalog** (singular `catalog:` key) -- we don't need named catalogs since we aren't maintaining parallel version tracks of any dependency.

### 1.3 Enforcement

- Set `catalogMode: prefer` in [pnpm-workspace.yaml](pnpm-workspace.yaml) initially. This makes `pnpm add` prefer catalog versions but doesn't break on packages outside the catalog.
- After the full migration is stable, switch to `catalogMode: strict` to enforce all shared deps must come from the catalog.

---

## 2. Publishing Safety

### 2.1 How catalog: Works on Publish

From the pnpm source code (verified at `repos/pnpm/pkg-manifest/exportable-manifest/src/index.ts`):

- `pnpm publish` and `pnpm pack` call `createExportableManifest()` which processes all dependency fields (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`) through `replaceCatalogProtocol()`
- The catalog resolver looks up the entry in the workspace `catalogs[name][alias]` and substitutes the resolved version specifier
- Tests at `repos/pnpm/releasing/plugin-commands-publishing/test/publish.ts:630-748` confirm this works for both default and named catalogs

### 2.2 Known Risk

[Issue #9497](https://github.com/pnpm/pnpm/issues/9497) reports that `catalog:` replacement may not work for sub-packages in some configurations. The pnpm source and tests suggest it should work, but the issue remains open (last reproduced Feb 2026).

### 2.3 Mitigation

Add a verification step to Phase 7 of the kernel migration:

```bash
cd packages/kernels && pnpm pack --dry-run
# Inspect the output manifest -- verify no "catalog:" strings remain
tar -tzf taucad-kernels-*.tgz | xargs -I{} tar -xf taucad-kernels-*.tgz {} --to-stdout | grep -c "catalog:" 
# Expected: 0
```

If `catalog:` is not replaced, fallback to explicit version strings for publishable packages (keeping the catalog as a lint-time consistency check via overrides/CI scripts rather than a publish-time mechanism).

---

## 3. Implementation Plan

### Phase C0: Catalog Infrastructure Setup

**In [pnpm-workspace.yaml*](pnpm-workspace.yaml)*, add the catalog section:

```yaml
packages:
  - apps/*
  - libs/*
  - packages/*

catalogMode: prefer

catalog:
  # === Tier 1: Currently duplicated ===
  "@gltf-transform/core": "^4.3.0"
  "@gltf-transform/extensions": "^4.3.0"
  "@gltf-transform/functions": "^4.3.0"
  xstate: "^5.24.0"
  "@types/json-schema": "^7.0.15"
  "@react-router/node": "^7.9.6"
  isbot: "^5.1.28"

  # === Tier 2: Will be shared with @taucad/kernels ===
  replicad: "^0.19.1"
  replicad-opencascadejs: "^0.19.0"
  "@jscad/modeling": "^2.12.6"
  openscad-wasm-prebuilt: "^1.2.0"
  "@taucad/kcl-wasm-lib": "0.1.111"
  esbuild-wasm: "^0.27.2"
  es-module-lexer: "^2.0.0"
  cdn-resolve: "^2.1.2"
  "@msgpack/msgpack": "^3.1.2"
  deepmerge: "^4.3.1"
  source-map-js: "^1.2.1"
  json-schema: "^7.0.15"  # @types/json-schema version used for the actual types
  json-schema-default: "^1.0.2"
  uint8array-extras: "^1.4.0"
  zod: "^4.1.13"
  type-fest: "^4.35.0"
  comlink: "^4.4.2"
  "@zenfs/core": "^2.4.4"
  "@zenfs/dom": "^1.2.7"

  # === Tier 3: Shared tooling ===
  typescript: "~5.9.3"
  vitest: "3.2.4"
  "@vitest/coverage-v8": "3.2.4"
  "@vitest/ui": "3.2.4"
  tsdown: "^0.15.7"
  tslib: "^2.8.1"
  vite: "^7.0.6"
  eslint: "9.32.0"
  prettier: "3.4.2"
  "@types/node": "~24.0.15"
  react: "^19.0.0"
  react-dom: "^19.0.0"
  react-router: "^7.9.6"
  "@react-router/serve": "^7.9.6"
  "@react-router/dev": "^7.9.6"
  "@react-router/fs-routes": "^7.9.6"
  "@types/react": "19.0.12"
  "@types/react-dom": "19.0.4"
  "@testing-library/jest-dom": "6.6.3"
  "@testing-library/react": "16.2.0"
  # Nx family (all pinned)
  nx: "21.3.10"
  "@nx/devkit": "21.3.10"
  "@nx/eslint": "21.3.10"
  "@nx/eslint-plugin": "21.3.10"
  "@nx/js": "21.3.10"
  "@nx/nest": "21.3.10"
  "@nx/node": "21.3.10"
  "@nx/playwright": "21.3.10"
  "@nx/react": "21.3.10"
  "@nx/vite": "21.3.10"
  "@nx/web": "21.3.10"
  "@nx/webpack": "21.3.10"
```

### Phase C1: Update Root package.json

Replace all version specifiers in [package.json](package.json) (both `dependencies` and `devDependencies`) that have catalog entries with `"catalog:"`.

For example:

```json
{
  "dependencies": {
    "@gltf-transform/core": "catalog:",
    "react": "catalog:",
    "xstate": "catalog:",
    "zod": "catalog:",
    ...
  },
  "devDependencies": {
    "vitest": "catalog:",
    "typescript": "catalog:",
    "nx": "catalog:",
    ...
  }
}
```

### Phase C2: Update Sub-Package package.json Files

Update all existing sub-packages that have overlapping deps:

- [packages/converter/package.json](packages/converter/package.json): `@gltf-transform/*` deps change from `^4.2.1` to `catalog:` (version aligned to `^4.3.0`)
- [packages/js/package.json](packages/js/package.json): `xstate` changes from `^5.24.0` to `catalog:` (version aligned to `^5.24.0`)
- [packages/json-schema/package.json](packages/json-schema/package.json): `@types/json-schema` changes from `^7.0.15` to `catalog:`
- [apps/ui/package.json](apps/ui/package.json): `@react-router/node` and `isbot` change to `catalog:`

### Phase C3: Run pnpm install and Verify

```bash
pnpm install
pnpm nx run-many -t typecheck
pnpm nx run-many -t test -- --watch=false
```

### Phase C4: Verify Publish Safety

```bash
cd packages/converter && pnpm pack --dry-run
# Inspect tarball manifest -- no "catalog:" strings should remain
cd packages/js && pnpm pack --dry-run
cd packages/json-schema && pnpm pack --dry-run
```

---

## 4. Integration with Kernel Migration Plan

The catalog phases (C0-C4) should be executed **before Phase 3a** (Scaffold `packages/kernels`) of the existing kernel migration plan. This way:

1. The catalog infrastructure is already in place when we create `packages/kernels/package.json`
2. All of the kernels' production deps (Tier 2) can use `catalog:` from the start
3. The root `package.json` already uses `catalog:` for these deps, guaranteeing version alignment

When Phase 3a creates `packages/kernels/package.json`, its deps will look like:

```json
{
  "dependencies": {
    "@taucad/types": "workspace:*",
    "@taucad/utils": "workspace:*",
    "@taucad/converter": "workspace:*",
    "@taucad/json-schema": "workspace:*",
    "deepmerge": "catalog:",
    "zod": "catalog:",
    "type-fest": "catalog:",
    "@msgpack/msgpack": "catalog:",
    "uint8array-extras": "catalog:",
    "esbuild-wasm": "catalog:",
    "cdn-resolve": "catalog:",
    "replicad": "catalog:",
    "replicad-opencascadejs": "catalog:",
    "source-map-js": "catalog:",
    "@jscad/modeling": "catalog:",
    "openscad-wasm-prebuilt": "catalog:",
    "json-schema-default": "catalog:",
    "@taucad/kcl-wasm-lib": "catalog:",
    "es-module-lexer": "catalog:"
  },
  "devDependencies": {
    "@zenfs/core": "catalog:",
    "@zenfs/dom": "catalog:",
    "vitest": "catalog:",
    "@types/json-schema": "catalog:"
  }
}
```

---

## 5. Updated Migration Sequence (Full)

The complete ordered sequence, with catalog phases inserted:

1. **Phase 0**: Dependency tree validation (existing)
2. **Phase 1**: Extract utils to `libs/utils` (existing)
3. **Phase 2**: Decouple FileManager type (existing)
4. **Phase C0**: Catalog infrastructure in `pnpm-workspace.yaml`
5. **Phase C1**: Update root `package.json` to use `catalog:`
6. **Phase C2**: Update existing sub-package `package.json` files to use `catalog:`
7. **Phase C3**: `pnpm install` + verify typecheck/tests
8. **Phase C4**: Verify publish safety (`pnpm pack --dry-run`)
9. **Phase 3a**: Scaffold `packages/kernels` (using `catalog:` for all deps)
10. **Phase 3b**: Copy kernel files
11. **Phase 3c**: Implement `createDefaultConfig()` factory
12. **Phase 4**: Adapt tests
13. **Phase 5**: Dual-environment test gates
14. **Phase 6**: Update UI app imports
15. **Phase 7**: Final verification (including `pnpm pack --dry-run` for kernels)

---

## 6. Future Enforcement

After the migration is stable and verified:

- Change `catalogMode: prefer` to `catalogMode: strict` in `pnpm-workspace.yaml`
- Optionally enable `cleanupUnusedCatalogs: true` (pnpm 10.15+) to auto-remove stale entries
- Add a CI check that greps for non-`catalog:` version specifiers in any package.json for deps that exist in the catalog


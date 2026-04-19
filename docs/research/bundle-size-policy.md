---
title: 'Bundle Size Tracking'
description: 'Analysis of bundle size monitoring tools and recommendations for tracking JS and WASM artifact size growth in Tau packages.'
status: draft
created: '2026-03-24'
updated: '2026-03-24'
category: comparison
related:
  - docs/policy/library-api-policy.md
  - docs/research/ocjs-wasm-binary-size-forensics.md
  - docs/research/ocjs-wasm-build-comparison.md
---

# Bundle Size Tracking

Analysis of bundle size monitoring tools and patterns for tracking JavaScript and WASM artifact size growth across Tau packages, with recommendations derived from industry best practices and the current tool landscape (March 2026).

## Executive Summary

Tau has dormant bundle-size infrastructure (`pkgcheck` supports `size-limit` but no package defines limits) and robust WASM-size benchmarks, but no automated CI gate prevents JS bundle regressions. The industry standard is a two-tier approach — `size-limit` with `@size-limit/file` for JS distribution bundles plus Vitest tests for WASM binary tracking — that maps directly onto Tau's existing tooling. Recommendation: activate `size-limit` in `@taucad/runtime` with per-subpath-export budgets, add a WASM size assertion test, and wire the `size-limit-action` into CI for PR-level visibility.

## Problem Statement

Tau ships a multi-kernel CAD runtime (`@taucad/runtime`) with JS glue code, WASM binaries (10–18 MB per variant), and multiple subpath exports. Without enforced size budgets:

1. **Silent regressions** — a new dependency or missed tree-shaking boundary can inflate the published package without anyone noticing until users report slow loads.
2. **WASM bloat** — OCCT build flag changes, symbol additions, or post-processing regressions can increase WASM binaries by megabytes.
3. **No PR-level feedback** — reviewers cannot see the size impact of a change at review time.

The existing `pkgcheck` orchestrator already calls `pnpm size-limit` when a `size-limit` key exists in `package.json`, but no package defines one. WASM sizes are tracked via benchmarks (`collectWasmSizes`, `wasm-inspect`, `build-matrix-report`) but lack hard pass/fail thresholds in CI.

## Methodology

1. Analyzed open-source CAD library size-tracking patterns — `.size-limit.json` configs, binary-size benchmark tests, CI workflows.
2. Reviewed Tau's `tools/pkgcheck.ts` and `packages/runtime` build pipeline.
3. Surveyed the current tool landscape via web research (npm trends, GitHub repos, documentation) as of March 2026.
4. Cross-referenced WASM-specific size tracking approaches (`wasm-weight-tracker`, `wasm-slim`).

## Findings

### Finding 1: Two-Tier Size Architecture

Best practice for libraries with both JS glue and WASM binaries is a two-tier approach:

**Tier 1 — JS bundles via `size-limit`**

A `.size-limit.json` config defines per-export budgets using `@size-limit/file` (v12.0.1). Key design decisions used by production CAD libraries:

- Uses `@size-limit/file` (raw file size with Brotli compression), not webpack/esbuild bundling — appropriate for libraries that publish pre-built `dist/` artifacts.
- Per-export budgets mirror the `package.json` subpath exports, giving fine-grained visibility into which module grew.
- An aggregate `"total (all JS)"` entry catches cross-cutting regressions.
- Limits are tight with ~25% headroom above current measured sizes.

**Tier 2 — WASM binaries via Vitest tests**

A dedicated test file records WASM artifact sizes and asserts they stay within defined budgets:

- Measures individual artifacts (e.g., `replicad_single.wasm`, `replicad_with_exceptions.wasm`) via `fs.statSync`.
- Asserts sizes are below defined thresholds with hard pass/fail.
- Outputs a structured size report for CI consumption.
- Gracefully skips when WASM artifacts are not present (CI without pre-built binaries).

**CI integration**

The recommended CI approach:

- A `size` Nx target (with `dependsOn: ["build"]`) runs `size-limit` per package.
- Added to the `affected` task list so it runs automatically for any affected project.
- `andresz1/size-limit-action` (pinned to exact commit hash) posts size deltas as a PR comment.
- A generic build script discovers all packages with `.size-limit.json`, builds them, and writes a merged config for consolidated reporting.

### Finding 2: Tool Landscape (March 2026)

| Tool            | Stars    | Latest Version | Last Updated | Approach                                   |
| --------------- | -------- | -------------- | ------------ | ------------------------------------------ |
| **size-limit**  | 6,893    | 12.0.1         | Mar 2026     | Plugin-based: file, webpack, esbuild, time |
| **bundlewatch** | 439      | 0.4.1          | ~2025        | File glob + maxSize thresholds             |
| **bundlemon**   | 167      | 3.1.0          | ~2025        | PR checks with percentage change metrics   |
| **bundlesize**  | (legacy) | 0.18.2         | unmaintained | Predecessor to bundlewatch                 |

**size-limit** is the clear leader by adoption, maintenance, and feature depth. Used by MobX, Material-UI, Ant Design, PostCSS, nanoid, and others. Key advantages:

- **Modular plugin system**: `@size-limit/file` (raw size with Brotli/Gzip/none), `@size-limit/webpack` (bundle with deps), `@size-limit/esbuild` (faster alternative), `@size-limit/time` (execution time via headless Chrome).
- **Three presets**: `preset-small-lib` (<10 kB, esbuild+file), `preset-big-lib` (>10 kB, webpack+file+time), `preset-app` (file+time).
- **Compression options**: Brotli (default), Gzip (`gzip: true`), or none (`brotli: false`).
- **Tree-shaking analysis**: `import` option tests specific exports.
- **`--why` analysis**: Statoscope-powered bundle visualization.
- **GitHub Action**: `andresz1/size-limit-action` posts PR comments with size deltas.
- **Nx plugin**: `nx-size-limit` community plugin available.
- **Config formats**: `.size-limit.json`, `package.json` section, `.size-limit.ts`, `.size-limit.js`.

### Finding 3: Tau's Existing Infrastructure

Tau already has the pieces for bundle size enforcement, but they are not connected:

| Component                                                                    | Status                                   | Gap                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| `tools/pkgcheck.ts` — `runSizeLimit()`                                       | Implemented, checks for `size-limit` key | No package defines `size-limit` config |
| `pkgcheck.plugin.ts`                                                         | Wired for all publishable packages       | `size-limit` always skips              |
| `packages/runtime/scripts/wasm-inspect.mts`                                  | Implemented                              | Informational only, no thresholds      |
| `packages/runtime/src/benchmarks/benchmark-runner.ts` — `collectWasmSizes()` | Implemented                              | Records sizes, no pass/fail            |
| `packages/runtime/scripts/build-matrix-report.mts`                           | Implemented                              | HTML dashboard, no CI gate             |
| `apps/ui/vite.config.ts` — `rollup-plugin-visualizer`                        | Installed                                | Dev-time only, no budget enforcement   |
| CI workflow (`.github/workflows/ci.yml`)                                     | lint, test, build, typecheck             | No size check job                      |

### Finding 4: WASM-Specific Size Tracking

WASM binaries require different treatment from JS bundles:

- **Raw file size is the primary metric** — WASM is not minified or tree-shaken by bundlers, so the on-disk size closely approximates transfer size (after HTTP compression).
- **wasm-weight-tracker** (Rust/WASM Working Group): nightly benchmarks tracking raw and gzipped WASM sizes over time. File size is described as "a coarse metric" for what matters — time to user interaction.
- **wasm-slim**: Rust crate with budget validation — target, warning threshold, and maximum size.
- **Manual `fs.statSync`**: measure artifact sizes in test, output structured JSON. Simple, portable, no external tooling.

For OCCT-based WASM (10–18 MB), the dominant size factors are symbol count, exception handling mode (`-fwasm-exceptions`), SIMD, and post-processing (`wasm-opt`). These are tracked by Tau's provenance system (`postOptSize` in `provenance.json`) but not gated.

### Finding 5: Developer-Time Awareness Tools

Beyond CI gates, developer-time tools catch size issues before commit:

| Tool                    | Mechanism                                              | Status (March 2026) |
| ----------------------- | ------------------------------------------------------ | ------------------- |
| **Import Cost** (Wix)   | VS Code extension, inline size annotations via webpack | Legacy, slower      |
| **Bundle Size** (ambar) | VS Code extension, esbuild-powered, hover cards        | Active (Jan 2026)   |
| **Bundle Size Plus**    | VS Code extension, Vue SFC support, esbuild            | Active (Jan 2026)   |
| **bundlejs.com**        | Online bundler + size checker                          | Active              |
| **pkg-size**            | CLI/API for checking npm package sizes                 | Active              |

These complement CI checks by giving developers immediate feedback on import costs. Not a substitute for automated enforcement.

## Recommendations

| #   | Action                                                                                | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Add `.size-limit.json` to `@taucad/runtime` with per-export budgets                   | P0       | Low    | High   |
| R2  | Install `size-limit` and `@size-limit/file` as dev dependencies                       | P0       | Low    | High   |
| R3  | Add WASM size assertion test to `packages/runtime`                                    | P1       | Low    | Medium |
| R4  | Add `size-limit-action` to CI workflow for PR comments                                | P1       | Medium | High   |
| R5  | Extend `size-limit` to other publishable packages (`converter`, `react`, `telemetry`) | P2       | Low    | Medium |
| R6  | Document size budget update process in commit policy                                  | P2       | Low    | Medium |

### R1: Per-Export Size Budgets

Map entries to `publishConfig.exports` specifiers in `packages/runtime/package.json`. Use `@size-limit/file` — the runtime publishes pre-built `dist/` artifacts, so raw file size (with Brotli) is the appropriate metric.

Set initial limits at current size + 25% headroom (size-limit's recommended approach). Tighten limits as the package stabilizes.

```json
[
  { "name": "total (all JS)", "path": "dist/**/*.js", "limit": "<measure+25%>" },
  { "name": "@taucad/runtime", "path": "dist/esm/index.js", "limit": "<measure+25%>" },
  { "name": "@taucad/runtime/kernel", "path": "dist/esm/plugins/kernels-entry.js", "limit": "<measure+25%>" },
  { "name": "@taucad/runtime/middleware", "path": "dist/esm/plugins/middleware-entry.js", "limit": "<measure+25%>" },
  { "name": "@taucad/runtime/bundler", "path": "dist/esm/plugins/bundler-entry.js", "limit": "<measure+25%>" },
  { "name": "@taucad/runtime/transport", "path": "dist/esm/transport/index.js", "limit": "<measure+25%>" }
]
```

### R2: Dependencies

```bash
pnpm install -d size-limit @size-limit/file
```

Add `"size": "size-limit"` script to `packages/runtime/package.json`. The existing `pkgcheck` `runSizeLimit()` will automatically activate when `size-limit` config is present.

### R3: WASM Size Assertion Test

Create a test that:

1. Measures WASM artifact sizes via `fs.statSync`.
2. Asserts sizes are below defined thresholds (e.g., `replicad_single.wasm` < 12 MB).
3. Outputs a structured size report for CI consumption.
4. Gracefully skips when artifacts are absent.

This complements the existing `collectWasmSizes()` in `benchmark-runner.ts` by adding hard pass/fail thresholds.

### R4: CI Integration

Two layers of CI enforcement:

**Layer 1 — Affected gate**: Add `size` to the Nx affected task list so any project with a `size` target is automatically checked. No per-project CI config needed.

```yaml
- name: Run affected tasks
  run: pnpm nx affected -t lint test build typecheck size
```

**Layer 2 — PR comments**: A `size-report` job uses `size-limit-action` with a generic build script (`tools/size-build.mjs`) that discovers all projects with `.size-limit.json`, builds them via Nx, and writes a merged config at the workspace root. The action posts a single consolidated PR comment with size deltas across all packages.

```yaml
size-report:
  if: github.event_name == 'pull_request'
  runs-on: ubuntu-latest
  permissions:
    pull-requests: write
  steps:
    - uses: actions/checkout@v6
    - uses: ./.github/actions/setup-nx
    - uses: andresz1/size-limit-action@94bc357df29c36c8f8d50ea497c3e225c3c95d1d
      with:
        github_token: ${{ secrets.GITHUB_TOKEN }}
        build_script: 'size:build'
        package_manager: pnpm
```

The build script runs on both current and base branches, so the action produces accurate deltas. On the first PR introducing this infrastructure, the base branch may lack the script — the action gracefully falls back to showing current sizes only.

### R5: Extend to Other Packages

Once the pattern is proven on `@taucad/runtime`, apply to other publishable packages:

| Package               | Expected Size | Budget Type  |
| --------------------- | ------------- | ------------ |
| `@taucad/converter`   | Small–Medium  | Per-export   |
| `@taucad/react`       | Small         | Single entry |
| `@taucad/telemetry`   | Small         | Single entry |
| `@taucad/json-schema` | Small         | Single entry |

### R6: Budget Update Process

When a legitimate size increase occurs (new feature, new dependency), the developer should:

1. Run `pnpm size-limit` locally to see the new size.
2. Update `.size-limit.json` with the new limit (current + headroom).
3. Include the size-limit update in the same PR as the code change.
4. Document the reason for the increase in the PR description.

## Trade-offs

### size-limit vs bundlewatch vs bundlemon

| Criterion        | size-limit                 | bundlewatch    | bundlemon      |
| ---------------- | -------------------------- | -------------- | -------------- |
| Maintenance      | Active (Mar 2026)          | Stale (~1 yr)  | Stale (~1 yr)  |
| Adoption         | 6,893 stars                | 439 stars      | 167 stars      |
| Plugin system    | Yes (6 plugins, 3 presets) | No             | No             |
| Compression      | Brotli/Gzip/none           | Gzip/none      | Gzip           |
| PR comments      | Via GitHub Action          | Built-in       | Built-in       |
| `--why` analysis | Statoscope/esbuild         | No             | No             |
| Nx integration   | Community plugin           | No             | No             |
| Monorepo support | Config per package         | Central config | Central config |

**Verdict**: size-limit is the right choice for Tau. It is the most actively maintained, has the richest plugin ecosystem, and supports per-package configuration (essential for monorepos).

### `@size-limit/file` vs `@size-limit/preset-small-lib` vs `@size-limit/preset-big-lib`

| Preset             | Plugins               | When to use                                |
| ------------------ | --------------------- | ------------------------------------------ |
| `@size-limit/file` | file only             | Pre-built `dist/` artifacts, raw file size |
| `preset-small-lib` | esbuild + file        | Libraries <10 kB, need bundled size        |
| `preset-big-lib`   | webpack + file + time | Libraries >10 kB, need execution time      |
| `preset-app`       | file + time           | Applications with own bundler              |

**Verdict**: `@size-limit/file` for `@taucad/runtime` — the package publishes pre-built artifacts, so raw file size (with Brotli compression) is the accurate metric. Webpack/esbuild re-bundling would double-count the bundling step and add unnecessary CI time.

### Inline config (`package.json`) vs external config (`.size-limit.json`)

External `.size-limit.json` is preferred. Advantages:

- Keeps `package.json` focused on package metadata.
- The JSON array is more readable when tracking 10+ entries.
- Works with Tau's existing `pkgcheck` which checks for a `size-limit` key in `package.json` — the `.size-limit.json` file is auto-discovered by size-limit CLI.

**Caveat**: `pkgcheck`'s `runSizeLimit()` currently checks `packageJson['size-limit']` to decide whether to run. It needs a minor update to also check for a `.size-limit.json` file:

```typescript
async function runSizeLimit(): Promise<CheckResult> {
  if (!packageJson['size-limit'] && !existsSync(join(absoluteRoot, '.size-limit.json'))) {
    return { name: 'size-limit', status: 'skip', details: ['no config found'] };
  }
  // ...
}
```

## Code Examples

### Current pkgcheck size-limit detection (needs update)

```typescript
// tools/pkgcheck.ts — current: only checks package.json
async function runSizeLimit(): Promise<CheckResult> {
  if (!packageJson['size-limit']) {
    return { name: 'size-limit', status: 'skip', details: ['no config found in package.json'] };
  }
  // ...
}
```

### WASM binary-size tracking pattern

```typescript
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const runtimeRoot = resolve(import.meta.dirname, '../..');

const wasmBudgets = [
  { path: 'src/kernels/replicad/wasm/replicad_single.wasm', maxMb: 25 },
  { path: 'src/kernels/replicad/wasm/replicad_with_exceptions.wasm', maxMb: 26 },
];

describe('WASM binary size budgets', () => {
  for (const { path: wasmPath, maxMb } of wasmBudgets) {
    const name = wasmPath.split('/').pop()!;
    it(`${name} is within budget (${maxMb} MB)`, () => {
      const fullPath = resolve(runtimeRoot, wasmPath);
      if (!existsSync(fullPath)) return;
      const { size } = statSync(fullPath);
      expect(size).toBeLessThanOrEqual(maxMb * 1024 * 1024);
    });
  }
});
```

## References

- [size-limit](https://github.com/ai/size-limit) — performance budget tool for JS (v12.0.1, March 2026)
- [size-limit-action](https://github.com/andresz1/size-limit-action) — GitHub Action for PR comments
- [nx-size-limit](https://github.com/LironHazan/nx-size-limit) — Nx community plugin
- [bundlewatch](https://bundlewatch.io/) — alternative bundle size tracker
- [wasm-weight-tracker](https://rustwasm.github.io/wasm-weight-tracker/) — WASM size tracking by Rust/WASM Working Group
- Related: `docs/research/ocjs-wasm-binary-size-forensics.md`
- Related: `docs/research/ocjs-wasm-build-comparison.md`
- Policy: `docs/policy/library-api-policy.md`

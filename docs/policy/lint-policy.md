# Lint Policy

ESLint performance best practices for this monorepo.
Validated against `@typescript-eslint/eslint-plugin` v8, `eslint` v9+ flat config, and `eslint-plugin-import-x`.

## Performance principles

1. **Formatting is not linting.** Run Prettier via `prettier --check` (CI) and format-on-save (editor). Never run Prettier as an ESLint rule (`prettier/prettier`) — it doubles the parse cost of every file.
2. **Don't duplicate TypeScript.** Disable any ESLint rule whose check is already performed by `tsc`.
3. **Expensive rules run at CI only.** Rules that resolve the dependency graph or do cross-file analysis belong in CI, not in the editor's real-time feedback loop.
4. **No unused plugins.** Disable rule sets from frameworks not used by the project (e.g. Ava rules when using Vitest).
5. **Cache aggressively.** Always pass `--cache` to ESLint in local and CI invocations.

## Specific rules

### `prettier/prettier` — DISABLED

| Metric   | Value |
|----------|-------|
| Measured | **59 % of total lint time** (994 ms on a single 1006-line file) |
| Cause    | Runs Prettier on every file during linting — double-parses every file |
| Fix      | Use `eslint-config-prettier` (disables conflicting formatting rules) without `eslint-plugin-prettier` (which runs Prettier as a lint rule). Run `prettier --check .` separately in CI. |

Source: [typescript-eslint performance docs](https://typescript-eslint.io/troubleshooting/typed-linting/performance/#eslint-plugin-prettier)

### `import-x/namespace` — DISABLED (redundant with TypeScript)

TypeScript already validates namespace imports. Enabling this rule forces `import-x` to do its own module resolution and AST parsing — pure overhead.

Source: [typescript-eslint import plugin recommendations](https://typescript-eslint.io/troubleshooting/typed-linting/performance/#eslint-plugin-import)

### `import-x/no-named-as-default-member` — DISABLED (redundant with TypeScript)

TypeScript checks default-export member access. Same double-resolution cost as above.

### `import-x/no-cycle` — CI-ONLY

Builds a full dependency graph with O(N × M²) complexity. Has caused 3× regressions between minor versions and OOM on large monorepos. Run in CI pipelines, never in the editor.

Source: [import plugin no-cycle performance](https://github.com/import-js/eslint-plugin-import/issues/3047)

### `import-x/no-named-as-default` — CI-ONLY

Requires cross-file resolution. Safe to defer to CI.

Source: [typescript-eslint import plugin recommendations](https://typescript-eslint.io/troubleshooting/typed-linting/performance/#eslint-plugin-import)

### `ava/*` rules — DISABLED

XO enables 24 Ava test-runner rules by default. This project uses Vitest, not Ava. These rules add plugin initialisation cost and per-file evaluation for no benefit.

### `import-x/extensions` — MONITOR

Performs disk lookups to resolve each import and check for file-extension presence. Currently necessary because the project enforces `.js` extensions. If `moduleResolution` is switched to `nodenext`/`node16`, TypeScript enforces extensions natively and this rule can be dropped.

## Typed linting

- Use `parserOptions.projectService: true` (already configured). This is the recommended approach in typescript-eslint v8+.
- Keep tsconfig `include` patterns narrow. Broad globs like `**/*` cause TypeScript to pre-parse build artifacts.
- If linting is memory-constrained, increase the semi-space: `NODE_OPTIONS=--max-semi-space-size=256`.

## Caching

- Local: `eslint --cache` stores results in `.eslintcache`. Only changed files are re-linted.
- CI: Use `--cache` with cache restore between runs (e.g. via Nx's computation cache or GitHub Actions cache).
- Cache location: default is `.eslintcache` in the working directory. Add to `.gitignore`.

## Profiling

To identify slow rules, run:

```bash
TIMING=all pnpm eslint ./path/to/file.ts
```

For typescript-eslint debug logging:

```bash
DEBUG=typescript-eslint:* pnpm eslint ./path/to/file.ts
```

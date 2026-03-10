---
title: 'Lint Policy'
description: 'Hybrid oxlint + ESLint architecture, performance principles, rule-specific decisions, and caching for the Tau monorepo.'
status: active
created: '2026-03-04'
updated: '2026-03-05'
---

# Lint Policy

Linting architecture and performance best practices for this monorepo.

## Rationale

A hybrid oxlint-first setup delivers fast feedback in the editor while ESLint handles rules that require Nx project graph or cross-file resolution. Separating formatting (oxfmt) from linting avoids duplicate work and keeps CI fast. Performance principles (no TypeScript duplication, CI-only expensive rules, aggressive caching) prevent lint from becoming a bottleneck.

## Hybrid oxlint + ESLint architecture

This project uses a **hybrid linting** setup where **oxlint** runs first as a fast native pass, followed by **ESLint** for rules that oxlint cannot handle natively. Formatting is handled by **oxfmt** (Oxc formatter), not ESLint.

### How it works

1. `pnpm nx lint <project>` runs `oxlint . && eslint .` (configured in `nx.json` `targetDefaults`).
2. `eslint-plugin-oxlint` (last entry in `eslint.config.mjs`) reads `.oxlintrc.json` and disables every ESLint rule that oxlint handles natively, so ESLint only evaluates residual rules.
3. In VS Code, the Oxc extension provides real-time oxlint diagnostics, formatting via oxfmt, and the ESLint extension handles residual rules. Both support fix-on-save.
4. CI (`pnpm nx affected -t lint`) chains both tools transparently via the Nx lint target.

### What each tool handles

**Oxlint** (native Rust, fast):

- ESLint core rules (curly, no-restricted-imports, etc.)
- `unicorn/*` rules (native) + `unicorn-js/*` gap rules via jsPlugins (better-regex, prevent-abbreviations, etc.)
- `@typescript-eslint/*` rules (including type-aware via tsgolint)
- `react/*` rules
- `import/*` rules where natively supported (no-duplicates, no-cycle, no-self-import, etc.)
- `jsdoc/*` rules (native) + `jsdoc-js/*` gap rules via jsPlugins (require-jsdoc, require-description, etc.)
- `promise/*` and `node/*` rules
- `eslint-comments-js/*` rules via jsPlugins
- `no-barrel-files` via jsPlugins
- `@protontech/enforce-uint8array-arraybuffer` via jsPlugins
- Custom `tau-lint` rules (no-abusive-eslint-disable, require-disable-description)

**Oxfmt** (formatting):

- Code formatting (replaces Prettier)
- Tailwind CSS class sorting (built-in, replaces prettier-plugin-tailwindcss)
- Configuration in `.oxfmtrc.json`

**ESLint** (retained, slim):

- `@typescript-eslint/naming-convention` (not yet in tsgolint)
- `@nx/enforce-module-boundaries` (requires Nx project graph)
- `import-x/no-extraneous-dependencies` (monorepo package.json resolution)
- `import-x/extensions` (enforce `.js` extension)
- `import-x/consistent-type-specifier-style`
- `@typescript-eslint/explicit-member-accessibility`
- `eslint-plugin-max-params-no-constructor`
- `react/boolean-prop-naming` (custom regex not in oxlint)

### jsPlugins (oxlint JavaScript plugin API)

Oxlint's `jsPlugins` feature loads standard ESLint plugins in oxlint's JS runtime, extending coverage beyond native Rust rules. Plugins are registered in `.oxlintrc.json` under the `jsPlugins` array with aliases when needed to avoid name collisions with native plugins (e.g., `unicorn-js` for `eslint-plugin-unicorn`).

### Adding new rules

Prefer oxlint's native support when available. Check [oxlint rule reference](https://oxc.rs/docs/guide/usage/linter/rules.html). If oxlint doesn't support the rule natively, consider adding it via jsPlugins. Only add to ESLint if it cannot run in oxlint at all.

### Future: drop ESLint entirely

When tsgolint lands `naming-convention` (PR #664), the remaining ESLint-only rules shrink significantly. At that point, ESLint can be reduced to running only Nx/import-specific rules or replaced entirely.

## Performance principles

1. **Formatting is not linting.** Oxfmt handles formatting via `oxfmt --check` (CI) and format-on-save (editor). Formatting rules are disabled in ESLint.
2. **Don't duplicate TypeScript.** Disable any ESLint rule whose check is already performed by `tsc`.
3. **Expensive rules run at CI only.** Rules that resolve the dependency graph or do cross-file analysis belong in CI, not in the editor's real-time feedback loop.
4. **No unused plugins.** Disable rule sets from frameworks not used by the project (e.g. Ava rules when using Vitest).
5. **Cache aggressively.** Always pass `--cache` to ESLint in local and CI invocations.

## Specific rules

### `prettier/prettier` — REMOVED

Prettier has been fully replaced by **oxfmt** (Oxc formatter). The `eslint-plugin-prettier` integration that ran Prettier as an ESLint rule has been removed. Formatting is now handled entirely by oxfmt via the Oxc VS Code extension (format-on-save) and `oxfmt --check` in CI.

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

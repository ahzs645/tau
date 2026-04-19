---
title: 'JSDoc Policy'
description: 'Standards for JSDoc documentation: @public/@internal visibility, compilable examples, real-world usage, language tags, and @example <caption> requirements.'
status: active
created: '2026-03-11'
updated: '2026-03-11'
related:
  - docs/policy/documentation-policy.md
  - docs/policy/library-api-policy.md
---

# JSDoc Policy

Internal reference for writing JSDoc documentation on exported functions, types, and classes in `packages/` and `libs/`. Enforced by two tau-lint rules:

- **`tau-lint/validate-jsdoc-codeblocks`** — validates codeblock formatting (language tags, shorthand expansion) and type-checks `@public` TypeScript codeblocks inline via `tsgolint` (typescript-go).
- **`tau-lint/require-public-export-jsdoc`** — requires `@public` on symbols exported from package.json export entry files.

Both rules are **disabled for `apps/`** — only library and package code is enforced.

## Rationale

JSDoc examples are the first thing a developer sees when hovering a function in their editor. Stale, synthetic, or misleading examples erode trust and teach wrong patterns. Compilable examples that mirror real-world usage ensure documentation stays correct as types evolve and serve as executable specifications.

## Visibility Tags: `@public` and `@internal`

Every exported symbol with JSDoc should declare its visibility:

| Tag         | Meaning                                                                  | Compile-checked?                                  |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| `@public`   | Part of the package's public API (reachable from `package.json` exports) | Yes — `ts` codeblocks are compiled                |
| `@internal` | Framework-internal or implementation detail                              | No — `ts` codeblocks get syntax highlighting only |

### Where to place the tag

Add `@public` or `@internal` as the last line of the description section, before `@param`, `@returns`, `@example`, etc.:

````typescript
/**
 * Create a runtime client with plugin-based configuration.
 *
 * @public
 * @param options - Client configuration
 * @returns A configured RuntimeClient instance
 *
 * @example <caption>Basic usage</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * ```
 */
````

### Enforcement

- **`tau-lint/require-public-export-jsdoc`** (`warn`) resolves which files are publicly reachable from `package.json` exports by following barrel re-exports. Exported declarations in those files must have `@public` in their JSDoc.
- **`tau-lint/validate-jsdoc-codeblocks`** type-checks `@public` TypeScript codeblocks inline by spawning `tsgolint headless` per-file with `source_overrides`. Diagnostics flow through oxlint's native pipeline and appear in the IDE. Without `@public`, examples still get syntax highlighting in editors but are not type-checked.

### Why not just use `text` tags for internal code?

Using `text` instead of `ts` for internal TypeScript examples sacrifices DX: developers lose syntax highlighting, go-to-definition, and type information in IDE hover tooltips. The `@public`/`@internal` approach preserves full `ts` DX everywhere while selectively enforcing compilation only on public API surfaces.

## Rules

### 1. Examples Must Show Real-World Usage

Write the code a developer would actually write. If a function is always composed inside another (e.g., `replicad()` inside `createRuntimeClient`), the example must show that composition.

**Why**: An example of `replicad()` called in isolation is never how it is used — it only appears inside `createRuntimeClient({ kernels: [replicad()] })`.

### 2. No Synthetic Stubs

Never use `declare const`, `declare function`, or placeholder variables that exist only to satisfy the type checker. If an example needs external context, either show the real source of that value or simplify the example to be self-contained.

**Why**: `declare const wasmUrl: string` is code no developer would write. It adds noise and teaches nothing about where the value comes from.

### 3. All Fenced Codeblocks Require a Language Tag

Every fenced codeblock in a JSDoc comment must specify a language tag. Enforced by `tau-lint/validate-jsdoc-codeblocks` (`missingLanguageTag` message).

| Tag          | When to use                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `typescript` | TypeScript code examples (always use full name — `ts` shorthand is auto-fixed to `typescript`) |
| `javascript` | JavaScript code examples (always use full name — `js` shorthand is auto-fixed to `javascript`) |
| `text`       | Non-code content: output format, directory trees, data shapes                                  |
| `json`       | JSON configuration or data                                                                     |

**Why**: The `typescript` tag provides syntax highlighting and IDE support. Omitting the tag bypasses the linter silently. The `ts`/`js` shorthands are auto-fixed to their full forms by `tau-lint/validate-jsdoc-codeblocks`.

### 4. Public TypeScript Examples Must Compile

`typescript`-tagged codeblocks in `@public` JSDoc are type-checked inline by `tau-lint/validate-jsdoc-codeblocks`. The rule spawns `tsgolint headless` (typescript-go) per-file with `source_overrides`, parses binary-framed diagnostics, and reports errors via `context.report()`. This flows through oxlint's native diagnostic pipeline, so errors appear as IDE squigglies via the oxlint VS Code extension.

Module resolution works for `@taucad/*` packages because virtual files are placed adjacent to their source files in the project tree. The compiler uses the workspace `tsconfig.json` settings.

### 5. Use Self-Referencing Package Imports

Examples in `packages/` and `libs/` must use the package's public API import path, not internal `#hash` imports. This shows consumers the actual import they would write.

**Why**: Internal `#` imports are not available to consumers. Examples must use the paths from `package.json` `exports`.

### 6. Scope Examples to the Function's Audience

Match the example to who calls the function:

| Audience                                        | Example shows                                               |
| ----------------------------------------------- | ----------------------------------------------------------- |
| **Consumer** (app developer)                    | Importing from `@taucad/runtime` and calling the public API |
| **Plugin author** (middleware/kernel developer) | The `defineX` pattern with lifecycle hooks                  |
| **Framework internal** (low-level utility)      | How the utility is called within the framework              |
| **Test author**                                 | Mock setup and assertion patterns                           |

An internal utility like `detectEdges` should show how it is called inside middleware, not a synthetic standalone call. A testing utility like `createMockRuntimeClient` should show the test setup pattern.

### 7. Keep Examples Minimal but Complete

Include only what a developer needs to understand the function. Remove ceremony that is not relevant to the documented function.

- Include all imports
- Show the minimal realistic call site
- Omit unrelated setup (event subscriptions, error handling) unless that is the function's purpose
- Use inline string literals instead of variable references when the value is illustrative

### 8. One Example per Distinct Use Case

Use multiple `@example` tags when a function has genuinely different usage patterns (e.g., with vs. without options, different option shapes). Do not combine unrelated patterns into a single block.

### 9. Every `@example` Must Have a `<caption>`

Use the JSDoc `<caption>` tag on the same line as `@example` to provide a title. This is part of the JSDoc specification ([jsdoc.app/tags-example](https://jsdoc.app/tags-example)) and preserves full syntax highlighting in VS Code hover tooltips.

**Why**: Bare text after `@example` (e.g., `@example Browser setup`) causes VS Code's TypeScript language server to treat the entire block as plain text, breaking syntax highlighting. The `<caption>` tag is explicitly handled by VS Code's rendering pipeline and avoids this issue.

Enforced by `tau-lint/validate-jsdoc-codeblocks` (`exampleBareText` and `exampleMissingCaption` messages). Both violations are auto-fixable.

| Pattern                                           | Syntax highlighting? | Allowed?                                     |
| ------------------------------------------------- | -------------------- | -------------------------------------------- |
| `@example <caption>Title</caption>` + fenced code | Yes                  | **Yes**                                      |
| `@example <caption></caption>` + fenced code      | Yes                  | **Yes**                                      |
| `@example Title text` + fenced code               | No                   | **No** (auto-fixed to `<caption>`)           |
| `@example` + fenced code (no caption)             | Yes                  | **No** (auto-fixed to `<caption></caption>`) |

CORRECT:

````typescript
/**
 * Create a runtime client.
 *
 * @public
 *
 * @example <caption>Browser setup</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * const client = createRuntimeClient({ kernels: [replicad()] });
 * ```
 */
````

INCORRECT:

````typescript
/**
 * Create a runtime client.
 *
 * @example Browser setup
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * const client = createRuntimeClient({ kernels: [replicad()] });
 * ```
 */
````

## Scope

### Applies to

- `packages/**/*.{ts,tsx}` — published npm packages
- `libs/**/*.{ts,tsx}` — workspace-internal libraries

### Excluded

- `apps/**/*.{ts,tsx}` — application code (disabled via `.oxlintrc.json` override)
- `**/*.test.{ts,tsx}` — test files

## Anti-Patterns

### Isolated Factory Calls

Never show a factory function called in isolation when it is always composed into a parent call.

### Import-Less Snippets

Never omit imports. Even for simple calls, the import line shows the consumer which subpath to use.

### Testing Code in Non-Test Examples

Do not use `vi.fn()`, `expect()`, or `vi.mocked()` in examples for production APIs. Reserve vitest imports for testing utility documentation.

### Prose Disguised as Code

If the "example" is a directory tree, data shape, or output format, use a `text` tag, not `ts`.

### Using `text` for TypeScript Code

Never use `text` tags for TypeScript examples just to avoid compilation. Use `@internal` to skip compilation while preserving `ts` syntax highlighting.

## Summary Checklist

- [ ] Symbol has `@public` (if publicly exported) or `@internal` (if framework-internal)
- [ ] Example shows real-world usage (how a developer would actually call this)
- [ ] No `declare const/function` synthetic stubs
- [ ] Fenced codeblock has a language tag (`typescript`, `text`, `json`)
- [ ] `@public` `typescript`-tagged examples compile without errors
- [ ] Imports use public API paths (`@taucad/...`), not internal `#` paths
- [ ] Example audience matches the function's audience (consumer, plugin author, internal, test)
- [ ] Example is minimal but complete (all imports, no unrelated ceremony)
- [ ] Every `@example` has a `<caption>` tag (e.g., `@example <caption>Title</caption>`)

## References

- Related: `docs/policy/documentation-policy.md`
- Related: `docs/policy/library-api-policy.md`
- Lint rule (tag validation + type-check): `libs/oxlint/src/rules/validate-jsdoc-codeblocks.js`
- Lint rule (require @public): `libs/oxlint/src/rules/require-public-export-jsdoc.js`

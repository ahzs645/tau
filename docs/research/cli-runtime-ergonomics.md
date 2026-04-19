---
title: 'CLI Runtime Ergonomics'
description: 'Analysis of how the CLI consumes @taucad/runtime and recommendations for making the runtime more ergonomic for headless Node.js consumers'
status: active
created: '2026-04-16'
updated: '2026-04-16'
category: architecture
related:
  - docs/policy/library-api-policy.md
  - docs/research/runtime-require-to-esm-migration.md
---

# CLI Runtime Ergonomics

Analysis of whether the CLI should use `fromNodeFS` instead of inline `code` input, how the runtime can be more ergonomic for headless Node.js consumers, and what the thin-wrapper CLI should look like.

## Executive Summary

The current CLI bypasses the runtime's filesystem abstraction by reading source files itself, then passing them as inline code strings. This works for single-file models but **breaks multi-file projects** where the entry file imports from sibling modules. The runtime already has a `fileSystem` option designed for exactly this use case — the CLI should use `fromNodeFS` with the project directory as basePath, letting the runtime's bundler resolve all imports through the real filesystem. Beyond this fix, the runtime lacks a "batteries-included" Node.js factory — the CLI currently assembles 3 imports and 5 options that every headless consumer needs. A `createNodeClient` convenience factory would eliminate this ceremony and make the CLI a truly thin wrapper.

## Problem Statement

The `@taucad/cli` export command currently:

1. Reads the source file from disk via `node:fs/promises`
2. Creates a `RuntimeClient` with no filesystem
3. Calls `client.export(format, { code: { [filename]: source } })`

Internally, the runtime's `code` input path:

- Creates an in-memory filesystem (`fromMemoryFS()`)
- Writes the code entries into it
- Bundles via esbuild, which resolves all imports through that in-memory FS

This means **relative imports fail silently** — if `main.ts` contains `import { helper } from './utils'`, the bundler cannot find `./utils.ts` because only `main.ts` was written to the in-memory FS. The file doesn't exist in the virtual filesystem.

## Findings

### Finding 1: `code` input is designed for snippets, not project directories

The `CodeInput<T>` type accepts a `Record<string, string>` — a filename-to-content map. This is ideal for:

- AI chat generating code snippets (the API server's primary use case)
- Benchmark runners evaluating single-file geometry
- REPL-style evaluation

It is **not designed** for rendering a file from an existing project directory where the entry point imports from sibling files, `node_modules`, or shared utilities.

The `FileInput` type exists precisely for this use case:

```typescript
type FileInput = {
  file: string | GeometryFile;
  parameters?: Record<string, unknown>;
  renderOptions?: Record<string, unknown>;
};
```

With a `fileSystem` connected (via constructor option or `connect()`), the bundler resolves all imports through the filesystem abstraction, supporting multi-file projects naturally.

### Finding 2: The CLI reimplements plumbing the runtime already provides

The current export command:

```typescript
const source = await readFile(inputPath, 'utf8');
const client = createCliClient();
const result = await client.export(format, {
  code: { [inputFilename]: source },
  parameters,
});
await writeFile(outputPath, result.data.bytes);
```

With `fromNodeFS`, this becomes:

```typescript
const client = createCliClient(inputDirectory);
const result = await client.export(format, {
  file: inputFilename,
  parameters,
});
await writeFile(outputPath, result.data.bytes);
```

The file I/O (read source, resolve imports) is handled by the runtime. The CLI becomes thinner.

### Finding 3: `createCliClient` should accept a project path

Per library-api-policy §1 (Factory Functions), §3 (Flat Options), §9 (Lazy Initialization), and §10 (High-Level Wrappers with Low-Level Escape Hatches), a good factory hides ceremony:

| Current CLI ceremony                      | Should be handled by |
| ----------------------------------------- | -------------------- |
| `import { createRuntimeClient, presets }` | Factory internals    |
| `import { createInProcessTransport }`     | Factory internals    |
| `import { fromNodeFS }`                   | Factory internals    |
| `presets.all()`                           | Factory default      |
| `transport: createInProcessTransport()`   | Factory default      |
| `fileSystem: await fromNodeFS(dir)`       | Factory parameter    |

A `createNodeClient(projectPath)` factory (or enhancing `createCliClient` to accept a path) would encapsulate all of this.

### Finding 4: The runtime itself should provide the Node.js convenience factory

Per library-api-policy §10, the runtime should expose high-level wrappers for common use cases. A headless Node.js client is a primary consumer persona (CLI tools, CI pipelines, SSR, benchmarks, testing). The runtime already has `presets.all()` for zero-config — combining it with `createInProcessTransport()` and `fromNodeFS()` is the natural next step.

However, placing this in `@taucad/runtime` directly would pull Node-only imports (`fromNodeFS`, `createInProcessTransport`) into the main entry point, which is browser-safe. The correct location is a **dedicated subpath export**: `@taucad/runtime/node`.

This follows the same pattern as `@taucad/runtime/filesystem/node` — environment-specific code behind a conditional subpath.

### Finding 5: The CLI becomes a 4-line thin wrapper

With a `createNodeClient` factory at `@taucad/runtime/node`:

```typescript
// CLI export command (complete implementation)
const client = await createNodeClient(inputDirectory);
client.on('log', (entry) => consola[entry.level](entry.message));

const result = await client.export(format, { file: inputFilename, parameters });
await writeFile(outputPath, result.data.bytes);
client.terminate();
```

The CLI package's only responsibilities become:

1. CLI argument parsing (citty)
2. Console output formatting (consola)
3. Output file writing

This is the correct division of concerns — the runtime owns all CAD processing, the CLI owns the command-line interface.

### Finding 6: `createNodeClient` vs enhancing `createCliClient`

Two options:

| Option                            | Location               | Pros                                                                                   | Cons                                                 |
| --------------------------------- | ---------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A: `createNodeClient` in runtime  | `@taucad/runtime/node` | Reusable by any Node.js consumer (scripts, tests, CI); runtime owns its own ergonomics | New subpath export                                   |
| B: `createCliClient(path)` in CLI | `@taucad/cli`          | Simpler to implement                                                                   | CLI-specific; other Node.js consumers can't reuse it |

**Verdict**: Option A. Per library-api-policy §10, the runtime should provide high-level wrappers. The CLI should be a thin layer on top — it should not be the only place to get a pre-configured Node.js client. Test scripts, CI pipelines, and SSR renderers all need the same factory.

### Finding 7: API signature design for `createNodeClient`

Per library-api-policy §4 (Parameter Design), `createNodeClient` should take either:

**1-param design (options object)**:

```typescript
const client = await createNodeClient({
  projectPath: '/path/to/project',
  kernels: [replicad()], // override default
});
```

**2-param design (primary + config)**:

```typescript
const client = await createNodeClient('/path/to/project');
const client = await createNodeClient('/path/to/project', {
  kernels: [replicad()],
});
```

The 2-param design fits the §4 pattern: "one clear subject (projectPath) and a bag of optional configuration." The project path answers "what", the options answer "how". It also enables the zero-arg default for snippet-only usage (no filesystem needed).

The function is `async` because `fromNodeFS` is now async (Task 2 of the ESM migration).

## Recommendations

| #   | Action                                                                                                               | Priority | Effort | Impact                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------- |
| R1  | Add `createNodeClient` to `@taucad/runtime/node` subpath                                                             | P0       | Medium | High — enables thin CLI, reusable by all Node consumers |
| R2  | Update CLI export command to use `fromNodeFS` via `createNodeClient`                                                 | P0       | Low    | High — fixes multi-file project support                 |
| R3  | Remove the `createCliClient` wrapper in `@taucad/cli` — replace with re-export or direct usage of `createNodeClient` | P1       | Low    | Medium — reduces code, single source of truth           |

### R1: `createNodeClient` at `@taucad/runtime/node`

New file: `packages/runtime/src/node.ts`

```typescript
import { createRuntimeClient, presets } from './index.js';
import { createInProcessTransport } from './transport/index.js';
import { fromNodeFS } from './filesystem/from-node-fs.js';
import type { RuntimeClientOptions, RuntimeClient } from './index.js';

export async function createNodeClient(
  projectPath?: string,
  options?: Partial<RuntimeClientOptions>,
): Promise<RuntimeClient<Record<string, unknown>>> {
  const fileSystem = projectPath ? await fromNodeFS(projectPath) : undefined;

  return createRuntimeClient({
    ...presets.all(),
    ...options,
    transport: options?.transport ?? createInProcessTransport(),
    fileSystem: fileSystem ?? options?.fileSystem,
  });
}
```

Add to `package.json` exports:

```json
"./node": "./src/node.ts"
```

### R2: Update CLI export command

```typescript
import { createNodeClient } from '@taucad/runtime/node';

async run({ args }) {
  const client = await createNodeClient(inputDirectory);
  client.on('log', ...);

  const result = await client.export(format, {
    file: inputFilename,
    parameters,
  });
  await writeFile(outputPath, result.data.bytes);
  client.terminate();
}
```

### R3: Simplify `@taucad/cli` internal structure

`create-cli-client.ts` can be removed entirely — `createNodeClient` replaces it. The CLI's `src/runtime/` directory becomes unnecessary.

## References

- [Library API Policy](../policy/library-api-policy.md)
- [ESM Migration Research](runtime-require-to-esm-migration.md)
- RuntimeClient source: `packages/runtime/src/client/runtime-client.ts`
- esbuild VFS plugin: `packages/runtime/src/bundler/esbuild-core.ts` (line 336)

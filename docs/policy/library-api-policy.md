---
title: 'Library API Policy'
description: 'Design rules for world-class JavaScript/TypeScript library APIs: factories, defineX, flat options, max 3 params, naming, subpath exports, events, plugins, lazy init, escape hatches.'
status: active
created: '2026-02-23'
updated: '2026-03-11'
related:
  - docs/policy/api-evolution-policy.md
  - docs/policy/resource-cleanup-policy.md
  - docs/research/typescript-overloads.md
  - docs/research/subpath-export-naming.md
---

# Library API Policy

Internal reference for designing world-class JavaScript/TypeScript library APIs. Distilled from analysis of Clerk JS, Vite, React Router, Vercel AI SDK, Stripe, and other high-DX libraries.

## Rationale

Consistent API design reduces cognitive load for consumers and plugin authors. These rules codify patterns from high-DX libraries so Tau packages feel familiar and predictable. Factory functions, flat options, and semantic naming enable discoverability without documentation. The max-3-params rule and same-concern smell tests prevent API drift that leads to placeholder parameters and inconsistent interfaces.

For versioning, stability tiers, and breaking change management, see [Version Policy](version-policy.md). For release mechanics, see [Release Policy](release-policy.md). For resource cleanup conventions (`Disposable`, `DisposableStore`, semantic cleanup names), see [Resource Cleanup Policy](resource-cleanup-policy.md). For API evolution, stability annotations, and advanced patterns, see [API Evolution Policy](api-evolution-policy.md).

## 1. Factory Functions Over Classes

Use `createX()` factory functions for consumer-facing instances. Keep class internals hidden behind the returned interface.

```typescript
// CORRECT: factory returns an opaque interface
const client = createKernelClient({ kernels: [replicad()] });

// INCORRECT: exposing class constructors
const client = new KernelWorkerClient(worker, onLog); // leaks implementation
```

**Why**: Factories allow lazy initialization, hide constructor complexity, and support return-type narrowing without exposing class hierarchies.

## 2. Define Functions for Plugin Authors

Use `defineX()` functions for plugin implementation contracts. The function validates shape and provides type inference without runtime overhead.

```typescript
export default defineKernel({
  name: 'MyKernel',
  version: '1.0.0',
  async onInitialize(options, runtime) { ... },
  async onCreateGeometry(input, runtime, ctx) { ... },
});
```

**Why**: `defineX` is a well-known pattern (Vite's `defineConfig`, Nuxt's `defineNuxtConfig`) that signals "this is a configuration/plugin definition" and enables full type inference on the generic context parameter.

## 3. Flat Options with Sensible Defaults

Prefer flat option objects over deeply nested configuration. Use optional fields with defaults, not required nested objects.

```typescript
// CORRECT: flat, obvious defaults
replicad({ wasm: 'single-exceptions', linearTolerance: 0.1 });

// INCORRECT: deeply nested, hard to read
replicad({
  options: {
    exceptions: { enabled: true },
    mesh: { tolerances: { linear: 0.1 } },
  },
});
```

## 4. Parameter Design

Maximum **3 positional parameters**. Prefer fewer. Each positional parameter must represent a **distinct architectural concern**, not just a different piece of data.

### When to use 1, 2, or 3 parameters

**1 param (options object)** -- Default for factory functions, configuration, and any function where all arguments describe the same concern (operation data, config, etc.). Self-documenting at call sites, trivially extensible.

```typescript
// CORRECT: single object -- self-documenting, easy to extend
createKernelClient({ kernels: [replicad()], transport: workerTransport });
render({ file, parameters, tessellation });

// INCORRECT: positional args for same-concern data
render(file, parameters, tessellation);
```

**2 params (primary + config)** -- When there is one clear "subject" and a bag of optional configuration. The first param answers "what", the second answers "how".

```typescript
// CORRECT: clear subject + optional config
exposeFileSystem(fileSystem, options?)
on(event, handler)
fromFsLike(fsLike, rootPath?)
```

**3 params (distinct architectural concerns)** -- Only when each parameter represents a genuinely different concern in a consistent interface contract. All methods on the same interface must use the same positional convention.

```typescript
// CORRECT: each param is a different architectural layer
createGeometry(input, runtime, context)
//              ^       ^        ^
//              |       |        └─ kernel state ("mine")
//              |       └────────── framework services ("theirs")
//              └────────────────── operation data ("what")

// CORRECT: standard middleware/interceptor pattern
wrapCreateGeometry(input, handler, runtime)
//                  ^       ^        ^
//                  |       |        └─ middleware context
//                  |       └────────── next-in-chain function
//                  └────────────────── operation data

// INCORRECT: all three are the same concern (operation input data)
createGeometry(file, parameters, tessellation?)
// Should be: createGeometry({ file, parameters, tessellation? })
```

**4+ params -- Never.** Refactor to an object pattern.

### Smell tests

Three signals that indicate a parameter design violation:

**1. Placeholder params.** If a developer writes underscored params (`_runtime, _ctx`) to skip past positions and reach the arg they need, the API has a positional problem. The arg they need should be accessible without dead code.

```typescript
// INCORRECT: developer must write _runtime, _ctx just to reach nativeHandle
async exportGeometry({ fileType, tessellation }, _runtime, _ctx, nativeHandle) {
  // Only uses fileType, tessellation, and nativeHandle

// CORRECT: nativeHandle is in the input object, no placeholders needed
async exportGeometry({ fileType, tessellation, nativeHandle }, _runtime, _ctx) {
  // Everything the developer needs is in the first param
```

**2. Same-concern params.** If all parameters answer the same question ("what should this operation do?"), they belong in one object regardless of count. Three "input data" params is worse than one input object -- even though it's within max-3.

```typescript
// INCORRECT: all three are operation input data
createGeometry(file, parameters, tessellation?)

// CORRECT: single input object
createGeometry({ file, parameters, tessellation? })
```

**3. Inconsistent destructuring.** If you destructure the first param but pass others through as-is at the same conceptual level, the grouping is wrong. When params at the same level are split across positions, they should be merged.

### Consistency principle

Within a contract interface (`KernelDefinition`, `BundlerDefinition`, middleware hooks), every method must follow the same positional pattern. A developer who learns `createGeometry(input, runtime, context)` should be able to predict the shape of `getParameters(input, runtime, context)` without reading docs. This consistency builds muscle memory and reduces cognitive load across all Tau packages.

### Rationale: why (input, runtime, context) is 3 params, not 2

The `context` and `runtime` parameters represent different ownership boundaries:

- `**runtime`\*\* is "theirs" -- framework-provided services (filesystem, logger, tracer, bundler). The kernel author consumes these but doesn't own or create them.
- `**context**` is "mine" -- the kernel's own state, created during `initialize` and threaded through every subsequent call. The kernel author owns and mutates this.

Merging them into a single object would conflate ownership, require making `KernelRuntime` generic over every kernel's context type, and remove the visual signal at the call site that distinguishes framework services from kernel state. The 3-param pattern is also consistent with the middleware `(input, handler, runtime)` pattern -- a standard composition model used by Express, Koa, and gRPC interceptors.

**Why**: Parameter conventions are enforced by `max-params: 3` in ESLint. The same-concern smell tests require semantic understanding and are enforced through code review and agentic documentation.

## 5. Naming Conventions

Names should describe **what** the code does, not **how** the framework routes it internally. A consumer reading `client.render()` understands the action; `client.renderEntry()` leaks an internal dispatch layer.

### Principles

**Describe the action, not the architecture.** Method names should tell the consumer what happens, not how the framework routes the call.

```typescript
// CORRECT: describes the action
client.render({ file, parameters });
worker.initialize(input);

// INCORRECT: leaks internal dispatch architecture
worker.renderEntry(input);
worker.initializeEntry(input);
```

**Describe the concept, not the container.** Type names should say what the object _is_, not where it lives in an array.

```typescript
// CORRECT: says what the object represents
type KernelRegistration = {
  id: string;
  extensions: string[];
  moduleUrl: string;
};

// INCORRECT: says where it lives (an "entry" in a list)
type KernelWorkerEntry = {
  id: string;
  extensions: string[];
  kernelModuleUrl: string;
};
```

**No abbreviations in public API.** Use full words for exported symbols and parameters. Internal code follows the same principle for readability, with narrow exceptions for universally understood abbreviations (`id`, `url`, `fs`).

```typescript
// Good
(tessellation, context, module, buffer, path);

// Avoid
(tess, ctx, mod, buf, p);
```

**Avoid overloading terms.** If a word is already used for one concept, don't reuse it for another. For example, "entry" was previously overloaded as both "item in a registration list" (`MiddlewareEntry`) and "method entry point" (`renderEntry`), which motivated the rename to `MiddlewareRegistration` and `render()`.

### Consistent prefixes by role

Each naming prefix signals a specific role:

| Prefix     | Role                            | Examples                                            |
| ---------- | ------------------------------- | --------------------------------------------------- |
| `create`\* | Factory function                | `createKernelClient`, `createBridgePort`            |
| `define*`  | Plugin definition               | `defineKernel`, `defineMiddleware`, `defineBundler` |
| `is*`      | Type guard                      | `isGeometryFile`, `isKernelPlugin`                  |
| `from*`    | Conversion constructor          | `fromNodeFS`, `fromMemoryFS`, `fromFsLike`          |
| `on*`      | Framework hook / event callback | `onInitialize`, `onLog`, `onProgress`               |

### Callback and hook naming

Always use the `on*` prefix for callbacks and framework hooks. Never use `*Callback` suffixes or bare verbs.

```typescript
// CORRECT: on* prefix for callbacks
client.on('progress', handler)
{ onLog: (entry) => console.log(entry) }

// CORRECT: on* prefix for framework hooks (subclass overrides)
protected abstract onInitialize(input, runtime): Promise<Context>;
protected abstract onCreateGeometry(input, runtime): Promise<Result>;

// INCORRECT: bare verbs or *Callback suffix
{ print: (msg) => console.log(msg) }
{ logCallback: (entry) => console.log(entry) }
```

**Why**: Consistent naming prefixes let developers predict API shape without reading docs. When every factory starts with `create`_, every type guard starts with `is_`, and every hook starts with `on\*`, the API becomes self-documenting.

## 6. Subpath Exports

Organize `package.json` exports by what each audience needs, not by internal file structure.

```text
@taucad/runtime                -- createKernelClient, presets, types (consumer)
@taucad/runtime/kernel         -- replicad(), openscad() factories (consumer)
@taucad/runtime/middleware     -- defineMiddleware(), cache factories (author + consumer)
@taucad/runtime/bundler        -- defineBundler(), esbuild() factory (author + consumer)
@taucad/runtime/transport      -- KernelTransport, createWorkerTransport (advanced)
@taucad/runtime/testing        -- test utilities (testing)
```

### Singular subpath naming

Use **singular nouns** for all subpath export segments. Subpaths are module namespaces that a developer imports from, not REST-style collection endpoints. The package name itself may be plural (it scopes a collection of modules), but every subpath within it is singular.

**Why**: Singular subpaths eliminate the doubled-name stutter (`@taucad/runtime/kernels`), align sibling categories so developers can predict paths by analogy, and match the convention used by tRPC, Effect-TS, Drizzle ORM, and TanStack Router.

CORRECT:

```typescript
import { replicad } from '@taucad/runtime/kernel';
import { esbuild } from '@taucad/runtime/bundler';
import { defineMiddleware } from '@taucad/runtime/middleware';
```

INCORRECT:

```typescript
import { replicad } from '@taucad/runtime/kernels'; // stutters package name
import { esbuild } from '@taucad/runtime/bundlers'; // inconsistent with ./middleware
```

| Segment type              | Convention    | Examples                                   |
| ------------------------- | ------------- | ------------------------------------------ |
| Category barrel           | Singular      | `./kernel`, `./bundler`, `./middleware`    |
| Individual implementation | Singular      | `./kernel/replicad`, `./bundler/esbuild`   |
| Standalone module         | Singular      | `./transport`, `./filesystem`, `./testing` |
| Package name              | May be plural | `@taucad/runtime` (scopes a collection)    |

For the full library survey, analysis, and trade-offs behind this convention, see [Subpath Export Naming Research](../research/subpath-export-naming.md).

## 7. Subscribe-Anytime Events

Use `.on(event, handler)` returning an unsubscribe function. Events should be subscribable at any point in the lifecycle.

```typescript
const off = client.on('progress', (phase) => console.log(phase));
// Later:
off();
```

**Why**: Works naturally with React's `useEffect` cleanup, avoids config-time binding, and follows the EventEmitter pattern without inheriting `EventEmitter`.

## 8. Plugin Factories Return Plain Objects

Plugin selection functions return plain registration objects, not class instances. The object carries the module URL and configuration.

```typescript
export function replicad(options?: ReplicadOptions): KernelPlugin {
  return {
    id: 'replicad',
    moduleUrl: new URL('../kernels/replicad.kernel.js', import.meta.url).href,
    extensions: ['ts', 'js'],
    options,
  };
}
```

**Why**: Plain objects are serializable, inspectable, and composable. No prototype chain, no hidden state.

## 9. Lazy Initialization for Expensive Resources

Defer Worker creation, WASM loading, and network connections until first use. The factory call itself should be instant.

```typescript
const client = createKernelClient({ ... }); // instant, no Worker created
await client.connect({ fileSystem });        // Worker created here
await client.render({ file, params });        // auto-connects if needed
```

## 10. High-Level Wrappers with Low-Level Escape Hatches

Expose a simple high-level API for 90% of users. Export the lower-level primitives for advanced use cases.

```typescript
// High-level (most users)
import { createKernelClient } from '@taucad/runtime';

// Low-level (custom transport authors)
import { createWorkerTransport } from '@taucad/runtime/transport';
```

## 11. No Optional Interface Methods

All methods on a contract interface should be required. If a method is optional, the framework must handle the missing case, which adds complexity. Instead, require all methods and let the framework build higher-level operations from the primitives.

```typescript
// CORRECT: all required, framework builds ensureDirectoryExists internally
type KernelFileSystem = {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  // ... all required
};

// INCORRECT: optional methods that need fallback logic everywhere
type KernelFileSystem = {
  readFile(path: string): Promise<string>;
  mkdir?(path: string): Promise<void>; // optional = complexity
  ensureDirectoryExists?(path: string): void; // maybe exists, maybe not
};
```

## 12. TypeScript-First Design

- Export types separately using `export type`
- Use comprehensive generics for plugin context types
- Prefer `type` over `interface` (project convention)
- Use discriminated unions for message protocols

For advanced TypeScript patterns (overloaded function types, generic wrappers, factory assignability), see [TypeScript Overloads Research](../research/typescript-overloads.md).

## 13. JSDoc Standards

Every public export must include:

- A description (1-2 sentences explaining purpose)
- `@param` with description for each parameter
- `@returns` with description
- `@example` for factory functions and key utilities
- `@internal` for framework-only APIs
- `@deprecated` with migration path when deprecating

## 14. Environment-Aware Conditional Exports

Use `package.json` export conditions for environment-specific code:

```json
{
  "exports": {
    ".": {
      "import": {
        "types": "./dist/esm/index.d.ts",
        "default": "./dist/esm/index.js"
      },
      "require": {
        "types": "./dist/cjs/index.d.cts",
        "default": "./dist/cjs/index.cjs"
      }
    }
  }
}
```

## 15. Presets for Zero-Config

Provide preset configurations that cover common use cases. Let advanced users compose their own.

```typescript
import { createKernelClient, presets } from '@taucad/runtime';

const client = createKernelClient(presets.all());
```

## 16. ES Module Asset Injection

When a factory option selects between heavy asset variants (e.g., WASM builds, large modules), use the **two-tier dynamic import pattern** to enable code-splitting and tree-shaking.

**Design the option as a discriminated union** of preset strings and a custom config object:

```typescript
type WasmOption = 'single' | 'single-exceptions' | { wasmUrl: string; wasmBindingsUrl: string };
```

This allows zero-config consumers to benefit from code-split presets, while advanced consumers can inject custom builds at runtime.

See [ES Module Policy](es-module-policy.md) for the full pattern, bundler compatibility matrix, serialization constraints, and anti-patterns.

## 17. Error Design

Errors in a library API should be predictable, debuggable, and actionable. Adapted from Stripe's error object design and Google Cloud's error model.

### Error Codes

Use string error codes rather than numeric codes or bare message strings. Error codes are stable across releases and can be referenced in documentation:

```typescript
type KernelError = {
  code: 'KERNEL_NOT_FOUND' | 'WASM_INIT_FAILED' | 'BUNDLER_ERROR' | 'RENDER_TIMEOUT';
  message: string;
  cause?: unknown;
};
```

### Actionable Messages

Error messages should tell the developer what to do, not just what went wrong:

```typescript
// CORRECT: actionable
throw new Error(
  `Kernel "${id}" not found. Available kernels: ${available.join(', ')}. ` +
    'Make sure you included it in the `kernels` array when calling createKernelClient().',
);

// INCORRECT: describes the problem without guidance
throw new Error(`Unknown kernel: ${id}`);
```

### Migration-Aware Errors

When an API is renamed or removed, the error message at the old call site should point to the replacement:

```typescript
// When a future flag obsoletes an old config name
if (config.future?.unstable_splitModules !== undefined) {
  throw new Error(
    '"future.unstable_splitModules" has been stabilized as "future.v2_splitModules". ' +
      'Please update your configuration.',
  );
}
```

For advanced error hierarchy patterns with `Symbol.for()` markers and cross-realm `isInstance()` checks, see [API Evolution Policy § Error Hierarchy](api-evolution-policy.md#5-error-hierarchy-with-symbol-markers).

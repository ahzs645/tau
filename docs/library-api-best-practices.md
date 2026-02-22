# Library API Best Practices

Internal reference for designing world-class JavaScript/TypeScript library APIs. Distilled from analysis of Clerk JS, Vite, and other high-DX libraries.

## 1. Factory Functions Over Classes

Use `createX()` factory functions for consumer-facing instances. Keep class internals hidden behind the returned interface.

```typescript
// Good: factory returns an opaque interface
const client = createKernelClient({ kernels: [replicad()] });

// Avoid: exposing class constructors
const client = new KernelWorkerClient(worker, onLog); // leaks implementation
```

**Why**: Factories allow lazy initialization, hide constructor complexity, and support return-type narrowing without exposing class hierarchies.

## 2. Define Functions for Plugin Authors

Use `defineX()` functions for plugin implementation contracts. The function validates shape and provides type inference without runtime overhead.

```typescript
export default defineKernel({
  name: 'MyKernel',
  version: '1.0.0',
  async initialize(options, runtime) { ... },
  async createGeometry(input, runtime, ctx) { ... },
});
```

**Why**: `defineX` is a well-known pattern (Vite's `defineConfig`, Nuxt's `defineNuxtConfig`) that signals "this is a configuration/plugin definition" and enables full type inference on the generic context parameter.

## 3. Flat Options with Sensible Defaults

Prefer flat option objects over deeply nested configuration. Use optional fields with defaults, not required nested objects.

```typescript
// Good: flat, obvious defaults
replicad({ withExceptions: true, linearTolerance: 0.1 })

// Avoid: deeply nested, hard to read
replicad({ options: { exceptions: { enabled: true }, mesh: { tolerances: { linear: 0.1 } } } })
```

## 4. Subpath Exports by Consumer Role

Organize `package.json` exports by what each audience needs, not by internal file structure.

```
@taucad/kernels                -- createKernelClient, presets, types (consumer)
@taucad/kernels/kernels        -- replicad(), openscad() factories (consumer)
@taucad/kernels/middleware     -- defineMiddleware(), cache factories (author + consumer)
@taucad/kernels/bundler        -- defineBundler(), esbuild() factory (author + consumer)
@taucad/kernels/transport      -- KernelTransport, createWorkerTransport (advanced)
@taucad/kernels/testing        -- test utilities (testing)
```

## 5. Subscribe-Anytime Events

Use `.on(event, handler)` returning an unsubscribe function. Events should be subscribable at any point in the lifecycle.

```typescript
const off = client.on('progress', (phase) => console.log(phase));
// Later:
off();
```

**Why**: Works naturally with React's `useEffect` cleanup, avoids config-time binding, and follows the EventEmitter pattern without inheriting `EventEmitter`.

## 6. Plugin Factories Return Plain Objects

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

## 7. Lazy Initialization for Expensive Resources

Defer Worker creation, WASM loading, and network connections until first use. The factory call itself should be instant.

```typescript
const client = createKernelClient({ ... }); // instant, no Worker created
await client.connect({ fileSystem });        // Worker created here
await client.render(file, params);           // auto-connects if needed
```

## 8. High-Level Wrappers with Low-Level Escape Hatches

Expose a simple high-level API for 90% of users. Export the lower-level primitives for advanced use cases.

```typescript
// High-level (most users)
import { createKernelClient } from '@taucad/kernels';

// Low-level (custom transport authors)
import { createWorkerTransport } from '@taucad/kernels/transport';
```

## 9. No Optional Interface Methods

All methods on a contract interface should be required. If a method is optional, the framework must handle the missing case, which adds complexity. Instead, require all methods and let the framework build higher-level operations from the primitives.

```typescript
// Good: all required, framework builds ensureDirectoryExists internally
type KernelFileSystem = {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  // ... all required
};

// Avoid: optional methods that need fallback logic everywhere
type KernelFileSystem = {
  readFile(path: string): Promise<string>;
  mkdir?(path: string): Promise<void>;        // optional = complexity
  ensureDirectoryExists?(path: string): void; // maybe exists, maybe not
};
```

## 10. TypeScript-First Design

- Export types separately using `export type`
- Use comprehensive generics for plugin context types
- Prefer `type` over `interface` (project convention)
- Use discriminated unions for message protocols

## 11. JSDoc Standards

Every public export must include:

- A description (1-2 sentences explaining purpose)
- `@param` with description for each parameter
- `@returns` with description
- `@example` for factory functions and key utilities
- `@internal` for framework-only APIs
- `@deprecated` with migration path when deprecating

## 12. Environment-Aware Conditional Exports

Use `package.json` export conditions for environment-specific code:

```json
{
  "exports": {
    ".": {
      "import": { "types": "./dist/esm/index.d.ts", "default": "./dist/esm/index.js" },
      "require": { "types": "./dist/cjs/index.d.cts", "default": "./dist/cjs/index.cjs" }
    }
  }
}
```

## 13. Presets for Zero-Config

Provide preset configurations that cover common use cases. Let advanced users compose their own.

```typescript
import { createKernelClient, presets } from '@taucad/kernels';

const client = createKernelClient(presets.all());
```

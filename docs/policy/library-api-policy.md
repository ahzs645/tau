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
  async onInitialize(options, runtime) { ... },
  async onCreateGeometry(input, runtime, ctx) { ... },
});
```

**Why**: `defineX` is a well-known pattern (Vite's `defineConfig`, Nuxt's `defineNuxtConfig`) that signals "this is a configuration/plugin definition" and enables full type inference on the generic context parameter.

## 3. Flat Options with Sensible Defaults

Prefer flat option objects over deeply nested configuration. Use optional fields with defaults, not required nested objects.

```typescript
// Good: flat, obvious defaults
replicad({ wasm: 'single-exceptions', linearTolerance: 0.1 })

// Avoid: deeply nested, hard to read
replicad({ options: { exceptions: { enabled: true }, mesh: { tolerances: { linear: 0.1 } } } })
```

## 4. Parameter Design

Maximum **3 positional parameters**. Prefer fewer. Each positional parameter must represent a **distinct architectural concern**, not just a different piece of data.

### When to use 1, 2, or 3 parameters

**1 param (options object)** -- Default for factory functions, configuration, and any function where all arguments describe the same concern (operation data, config, etc.). Self-documenting at call sites, trivially extensible.

```typescript
// Good: single object -- self-documenting, easy to extend
createKernelClient({ kernels: [replicad()], transport: workerTransport })
render({ file, parameters, tessellation })

// Avoid: positional args for same-concern data
render(file, parameters, tessellation)
```

**2 params (primary + config)** -- When there is one clear "subject" and a bag of optional configuration. The first param answers "what", the second answers "how".

```typescript
// Good: clear subject + optional config
exposeFileSystem(fileSystem, options?)
on(event, handler)
fromFsLike(fsLike, rootPath?)
```

**3 params (distinct architectural concerns)** -- Only when each parameter represents a genuinely different concern in a consistent interface contract. All methods on the same interface must use the same positional convention.

```typescript
// Good: each param is a different architectural layer
createGeometry(input, runtime, context)
//              ^       ^        ^
//              |       |        └─ kernel state ("mine")
//              |       └────────── framework services ("theirs")
//              └────────────────── operation data ("what")

// Good: standard middleware/interceptor pattern
wrapCreateGeometry(input, handler, runtime)
//                  ^       ^        ^
//                  |       |        └─ middleware context
//                  |       └────────── next-in-chain function
//                  └────────────────── operation data

// Bad: all three are the same concern (operation input data)
createGeometry(file, parameters, tessellation?)
// Should be: createGeometry({ file, parameters, tessellation? })
```

**4+ params -- Never.** Refactor to an object pattern.

### Smell tests

Three signals that indicate a parameter design violation:

**1. Placeholder params.** If a developer writes underscored params (`_runtime, _ctx`) to skip past positions and reach the arg they need, the API has a positional problem. The arg they need should be accessible without dead code.

```typescript
// BAD: developer must write _runtime, _ctx just to reach nativeHandle
async exportGeometry({ fileType, tessellation }, _runtime, _ctx, nativeHandle) {
  // Only uses fileType, tessellation, and nativeHandle

// GOOD: nativeHandle is in the input object, no placeholders needed
async exportGeometry({ fileType, tessellation, nativeHandle }, _runtime, _ctx) {
  // Everything the developer needs is in the first param
```

**2. Same-concern params.** If all parameters answer the same question ("what should this operation do?"), they belong in one object regardless of count. Three "input data" params is worse than one input object -- even though it's within max-3.

```typescript
// BAD: all three are operation input data
createGeometry(file, parameters, tessellation?)

// GOOD: single input object
createGeometry({ file, parameters, tessellation? })
```

**3. Inconsistent destructuring.** If you destructure the first param but pass others through as-is at the same conceptual level, the grouping is wrong. When params at the same level are split across positions, they should be merged.

### Consistency principle

Within a contract interface (`KernelDefinition`, `BundlerDefinition`, middleware hooks), every method must follow the same positional pattern. A developer who learns `createGeometry(input, runtime, context)` should be able to predict the shape of `getParameters(input, runtime, context)` without reading docs. This consistency builds muscle memory and reduces cognitive load across all Tau packages.

### Rationale: why (input, runtime, context) is 3 params, not 2

The `context` and `runtime` parameters represent different ownership boundaries:

- **`runtime`** is "theirs" -- framework-provided services (filesystem, logger, tracer, bundler). The kernel author consumes these but doesn't own or create them.
- **`context`** is "mine" -- the kernel's own state, created during `initialize` and threaded through every subsequent call. The kernel author owns and mutates this.

Merging them into a single object would conflate ownership, require making `KernelRuntime` generic over every kernel's context type, and remove the visual signal at the call site that distinguishes framework services from kernel state. The 3-param pattern is also consistent with the middleware `(input, handler, runtime)` pattern -- a standard composition model used by Express, Koa, and gRPC interceptors.

**Why**: Parameter conventions are enforced by `max-params: 3` in ESLint. The same-concern smell tests require semantic understanding and are enforced through code review and agentic documentation.

## 5. Naming Conventions

Names should describe **what** the code does, not **how** the framework routes it internally. A consumer reading `client.render()` understands the action; `client.renderEntry()` leaks an internal dispatch layer.

### Principles

**Describe the action, not the architecture.** Method names should tell the consumer what happens, not how the framework routes the call.

```typescript
// Good: describes the action
client.render({ file, parameters })
worker.initialize(input)

// Avoid: leaks internal dispatch architecture
worker.renderEntry(input)
worker.initializeEntry(input)
```

**Describe the concept, not the container.** Type names should say what the object *is*, not where it lives in an array.

```typescript
// Good: says what the object represents
type KernelRegistration = { id: string; extensions: string[]; moduleUrl: string };

// Avoid: says where it lives (an "entry" in a list)
type KernelWorkerEntry = { id: string; extensions: string[]; kernelModuleUrl: string };
```

**No abbreviations in public API.** Use full words for exported symbols and parameters. Internal code follows the same principle for readability, with narrow exceptions for universally understood abbreviations (`id`, `url`, `fs`).

```typescript
// Good
tessellation, context, module, buffer, path

// Avoid
tess, ctx, mod, buf, p
```

**Avoid overloading terms.** If a word is already used for one concept, don't reuse it for another. For example, "entry" was previously overloaded as both "item in a registration list" (`MiddlewareEntry`) and "method entry point" (`renderEntry`), which motivated the rename to `MiddlewareRegistration` and `render()`.

### Consistent prefixes by role

Each naming prefix signals a specific role:

| Prefix | Role | Examples |
|---|---|---|
| `create*` | Factory function | `createKernelClient`, `createBridgePort` |
| `define*` | Plugin definition | `defineKernel`, `defineMiddleware`, `defineBundler` |
| `is*` | Type guard | `isGeometryFile`, `isKernelPlugin` |
| `from*` | Conversion constructor | `fromNodeFS`, `fromMemoryFS`, `fromFsLike` |
| `on*` | Framework hook / event callback | `onInitialize`, `onLog`, `onProgress` |

### Callback and hook naming

Always use the `on*` prefix for callbacks and framework hooks. Never use `*Callback` suffixes or bare verbs.

```typescript
// Good: on* prefix for callbacks
client.on('progress', handler)
{ onLog: (entry) => console.log(entry) }

// Good: on* prefix for framework hooks (subclass overrides)
protected abstract onInitialize(input, runtime): Promise<Context>;
protected abstract onCreateGeometry(input, runtime): Promise<Result>;

// Avoid: bare verbs or *Callback suffix
{ print: (msg) => console.log(msg) }
{ logCallback: (entry) => console.log(entry) }
```

**Why**: Consistent naming prefixes let developers predict API shape without reading docs. When every factory starts with `create*`, every type guard starts with `is*`, and every hook starts with `on*`, the API becomes self-documenting.

## 6. Subpath Exports by Consumer Role

Organize `package.json` exports by what each audience needs, not by internal file structure.

```text
@taucad/kernels                -- createKernelClient, presets, types (consumer)
@taucad/kernels/kernels        -- replicad(), openscad() factories (consumer)
@taucad/kernels/middleware     -- defineMiddleware(), cache factories (author + consumer)
@taucad/kernels/bundler        -- defineBundler(), esbuild() factory (author + consumer)
@taucad/kernels/transport      -- KernelTransport, createWorkerTransport (advanced)
@taucad/kernels/testing        -- test utilities (testing)
```

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
import { createKernelClient } from '@taucad/kernels';

// Low-level (custom transport authors)
import { createWorkerTransport } from '@taucad/kernels/transport';
```

## 11. No Optional Interface Methods

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

## 12. TypeScript-First Design

- Export types separately using `export type`
- Use comprehensive generics for plugin context types
- Prefer `type` over `interface` (project convention)
- Use discriminated unions for message protocols

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
      "import": { "types": "./dist/esm/index.d.ts", "default": "./dist/esm/index.js" },
      "require": { "types": "./dist/cjs/index.d.cts", "default": "./dist/cjs/index.cjs" }
    }
  }
}
```

## 15. Presets for Zero-Config

Provide preset configurations that cover common use cases. Let advanced users compose their own.

```typescript
import { createKernelClient, presets } from '@taucad/kernels';

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

## 17. Resource Cleanup Conventions

Use a **layered vocabulary** where each term maps to a specific resource scope. The terminology aligns with TC39 Explicit Resource Management, Web APIs, and the Monaco/Three.js ecosystems already used in this project.

### Vocabulary

| Term | Scope | Web/TC39 alignment | Example |
|------|-------|---------------------|---------|
| `dispose()` | General resource release on an object | TC39 `Symbol.dispose`, Monaco `IDisposable`, Three.js | `bridge.dispose()`, `collector.dispose()` |
| `close()` | Connections, transports, streams | `WebSocket.close()`, `MessagePort.close()`, `IDBDatabase.close()` | `transport.close()`, `port.close()` |
| `terminate()` | Workers and processes | `Worker.terminate()` | `client.terminate()`, `worker.terminate()` |
| `stop()` | Running computations, actors | XState `actor.stop()`, AI SDK `chat.stop()` | `actor.stop()` |
| Return `() => void` | Subscriptions and one-time registrations | React `useEffect` cleanup, RxJS `unsubscribe` | `client.on('progress', handler)` returns `() => void` |

**`dispose` is the default.** When none of the specific terms (`close`, `terminate`, `stop`) apply, use `dispose`.

### Choosing the right term

Use this decision tree:

1. **Is the resource a connection, transport, or stream?** → `close()`
2. **Is the resource a Worker or subprocess?** → `terminate()`
3. **Is the resource a running computation or actor?** → `stop()`
4. **Is the resource an event subscription?** → return `() => void` (see Section 7)
5. **Everything else** → `dispose()`

### Patterns

**Objects that own resources** — add a `dispose()` method:

```typescript
// Factory returning a handle with dispose
function createFileSystemBridge(worker: Worker): BridgeHandle {
  const channel = new MessageChannel();
  worker.postMessage({ type: 'bridge', port: channel.port1 }, [channel.port1]);
  return {
    port: channel.port2,
    dispose() {
      channel.port2.close();
    },
  };
}
```

**Listener registrations** — return a bare cleanup function:

```typescript
// exposeFileSystem returns () => void, not { dispose }
function exposeFileSystem(handlers: FileSystemHandlers): () => void {
  self.addEventListener('message', handler);
  return () => {
    self.removeEventListener('message', handler);
  };
}
```

**Orchestration methods** that tear down multiple sub-resources use `dispose()` as the method name and call the appropriate term on each sub-resource:

```typescript
// Good: orchestration method is named dispose, calls correct term on each sub-resource
public async dispose(): Promise<void> {
  this.telemetryCollector?.dispose();  // dispose sub-resource
  this.fileSystem?.dispose();          // dispose sub-resource
  this.transport?.close();             // close connection
  await this.onDispose();              // framework hook
}
```

### Framework lifecycle hooks

Lifecycle hooks called by the framework follow the `on*` prefix convention (Section 5). The cleanup hook is `onDispose`, not `cleanup`:

```typescript
// Good: follows on* convention
type KernelDefinition = {
  onInitialize(input, runtime): Promise<Context>;
  onCreateGeometry(input, runtime, context): Promise<Result>;
  onDispose?(context): Promise<void>;
};

// Good: protected hook for subclasses
protected async onDispose(): Promise<void> {
  // Override in subclass for custom cleanup
}

// Avoid: breaks on* convention
type KernelDefinition = {
  cleanup?(context): Promise<void>;  // should be onDispose
};
```

### Naming stored cleanup references

When storing a cleanup function in state (e.g., XState machine context, React refs), use the noun form matching the resource:

```typescript
// Good: name describes the resource, not the action
type MachineContext = {
  bridge?: BridgeHandle;       // has .dispose()
  worker?: Worker;             // has .terminate()
  subscriptions: (() => void)[]; // array of unsubscribe functions
};

// Good: destructure and store the handle
const bridge = createFileSystemBridge(worker);
context.bridge = bridge;
// later: context.bridge.dispose();

// Avoid: storing bare functions with action-verb names
type MachineContext = {
  bridgeDispose?: () => void;    // loses the resource identity
  eventCleanups: (() => void)[]; // vague, mixes concerns
};
```

When multiple unrelated cleanup functions must be stored together, use `subscriptions` (for event/subscription cleanups) or keep the full handle objects and call their cleanup methods individually.

### The `cleanup` term

**Do not use `cleanup` as a method name for resource release.** It is not aligned with any standard (TC39, Web APIs, Monaco, Three.js) and creates ambiguity with `dispose`.

Permitted uses of `cleanup`:
- **Domain-specific maintenance** that is not lifecycle teardown: `cleanupOldCacheEntries()`, `cleanupStaleSessions()`. These are operational housekeeping, not resource disposal.
- **Internal implementation detail** inside a function body (local variable name in a `finally` block) where no public API is exposed.

Migrate existing `cleanup` methods:
- `KernelDefinition.cleanup?()` → `KernelDefinition.onDispose?()`
- `BundlerDefinition.cleanup?()` → `BundlerDefinition.onDispose?()`
- `KernelWorker.cleanup()` → `KernelWorker.dispose()`
- `KernelWorker.onCleanup()` → `KernelWorker.onDispose()`
- `KernelWorkerClient.cleanup()` → `KernelWorkerClient.dispose()`
- `ErrorTrap.cleanup` → `ErrorTrap.dispose`
- `EngineConnection.cleanup()` → `EngineConnection.dispose()`

### Async dispose

When disposal requires async work (closing WebSocket, flushing buffers, WASM teardown), use an async `dispose()` method. Prefer `Promise<void>` return type over `Symbol.asyncDispose` until the TC39 proposal reaches broader runtime support:

```typescript
// Good: async dispose for resources requiring teardown
public async dispose(): Promise<void> {
  await this.flushBuffers();
  this.websocket.close();
  this.removeAllListeners();
}

// Future: when Symbol.asyncDispose is widely supported
async [Symbol.asyncDispose](): Promise<void> {
  await this.dispose();
}
```

### Anti-patterns

```typescript
// Bad: cleanup as method name (use dispose)
public async cleanup(): Promise<void> { ... }

// Bad: destroy as method name (use dispose or terminate)
public destroy(): void { ... }

// Bad: teardown as method name (use dispose)
public teardown(): void { ... }

// Bad: release as method name (use dispose, unless it's releaseLock on streams)
public release(): void { ... }

// Bad: storing bare cleanup functions with verb names
context.bridgeDispose?.();

// Bad: mixing dispose and cleanup on the same object
class Worker {
  dispose(): void { ... }   // which one releases resources?
  cleanup(): void { ... }   // confusing
}
```

### Summary table

| Situation | Name | Returns |
|-----------|------|---------|
| Release an object's resources | `dispose()` | `void` or `Promise<void>` |
| Close a connection/transport/stream | `close()` | `void` |
| Stop a worker/process | `terminate()` | `void` |
| Stop a computation/actor | `stop()` | `void` |
| Event subscription | `on(event, handler)` | `() => void` |
| One-time listener setup | `exposeX()` / `listenX()` | `() => void` |
| Framework lifecycle hook | `onDispose()` | `Promise<void>` |
| Domain housekeeping (not lifecycle) | descriptive verb, e.g. `cleanupStaleEntries()` | varies |

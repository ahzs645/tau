# RPC & Filesystem Bridge Policy

Internal reference for the MessagePort bridge architecture used to connect filesystem implementations to kernel workers across thread boundaries.

## Architectural Overview

The kernel package has two distinct communication systems, each purpose-built for its domain:

```
┌─────────────────────────────────────────────────────────────────┐
│ KernelTransport                                                 │
│ Typed protocol messages: render, export, cancel, fileChanged    │
│ Discriminated unions, requestId correlation, fire-and-forget    │
│ Implementations: Worker, InProcess, (future: WebSocket, HTTP)   │
├─────────────────────────────────────────────────────────────────┤
│ Bridge RPC                                                      │
│ Generic method calls: { id, method, args } → { id, result }     │
│ Serves any object's methods over MessagePort                    │
│ Always request/response, structured error propagation           │
│ Primary use: filesystem access across thread boundaries         │
└─────────────────────────────────────────────────────────────────┘
```

**Why two systems?** They solve different problems. KernelTransport carries complex, typed protocol messages with many fields, fire-and-forget commands, and transport-agnostic design (WebSocket, HTTP, FFI). The Bridge carries simple method calls and is always MessagePort-based, always request/response. Merging them would either over-complicate the bridge or under-type the transport.

## Three-Layer Filesystem Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ Layer 1: KernelFileSystemBase (11 primitives)                 │
│         + KernelFileSystem (Base + enhanced helpers)           │
│ createKernelFileSystem(base) adds default helpers             │
├───────────────────────────────────────────────────────────────┤
│ Layer 2: Constructors (from* factories)                       │
│ Create KernelFileSystemBase from various sources:             │
│ fromNodeFS, fromMemoryFS, fromFsLike                          │
├───────────────────────────────────────────────────────────────┤
│ Layer 3: Bridge RPC (MessagePort transport)                   │
│ Serve/consume any object across thread boundaries:            │
│ createBridgeServer, createBridgePort, createBridgeCall        │
│ createBridgeProxy<T>(port) (generic Proxy-based RPC)          │
│ catchMessages(port) (initialization buffering)                │
│ extractTransferables(value) (zero-copy binary transfer)       │
│ exposeFileSystem, createFileSystemBridge (high-level wrappers)│
└───────────────────────────────────────────────────────────────┘
```

### Layer 1: KernelFileSystem

The contract interface is split into two types:

**`KernelFileSystemBase`** -- the 11 Node.js `fs.promises`-compatible primitives that filesystem backends must implement:

```typescript
type KernelFileSystemBase = {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
};
```

**`KernelFileSystem`** -- extends Base with higher-level helpers that have default implementations built from the primitives:

```typescript
type KernelFileSystem = KernelFileSystemBase & {
  readFiles(paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  readdirContents(dirPath: string): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  readdirStat(dirPath: string): Promise<FileStatEntry[]>;
  ensureDir(path: string): Promise<void>;
};
```

**`createKernelFileSystem(base)`** wraps a `KernelFileSystemBase` with default implementations for the enhanced methods. Backends may supply optimized overrides:

```typescript
const fs = createKernelFileSystem(base); // defaults: readFiles = Promise.all(paths.map(readFile)), etc.
const fs = createKernelFileSystem({ ...base, readFiles: optimizedBatchRead }); // override
```

**Design decisions:**

- **Type split keeps the interface clean.** Filesystem backends implement only the 11 primitives (`KernelFileSystemBase`). The wrapper adds the helpers, so consumers always get the full `KernelFileSystem` with zero optional methods.
- **Simplified stat return.** Returns `FileStat = { type: 'file' | 'dir'; size; mtimeMs }` (from `@taucad/types`) instead of a full Node.js `Stats` object. This avoids serialization complexity across MessagePort while providing the metadata kernels actually need. `FileStatEntry` extends `FileStat` with `path` and `name` for directory listing results. `NativeStats` and `toFileStat()` (from `@taucad/types/constants`) handle the conversion from Node.js-style `isDirectory()` methods.
- **`lstat` mirrors `stat`.** Required by `isomorphic-git`. Implementations without symlink support (ZenFS, in-memory) delegate `lstat` to `stat`.
- **`exists` is explicit.** While `stat` + catch achieves the same result, `exists` is a common enough operation that an explicit method reduces boilerplate and improves readability.
- **Enhanced method naming uses fs-style abbreviations.** `readdir` + `Contents` = `readdirContents`, `readdir` + `Stat` = `readdirStat`, `ensure` + `Dir` = `ensureDir`. Consistent with the existing `readdir`, `mkdir` primitives.

### Layer 2: Constructors

Factory functions that create `KernelFileSystemBase` from various sources. Each normalizes a different source API into the 11-primitive contract.

| Constructor | Source | Use Case |
|---|---|---|
| `fromNodeFS(basePath)` | Node.js `fs.promises` | CLI tools, benchmarks, SSR, tests |
| `fromMemoryFS(files?)` | In-memory Map | Inline code rendering, unit tests |
| `fromFsLike(fsLike, rootPath?)` | Any `{ promises: ... }` object | ZenFS, BrowserFS, memfs, or any fs.promises-compatible API |

**Naming convention:** All constructors use the `from*` prefix per the library API policy. The name describes *what the source is*, not *what library it comes from*.

#### `fromNodeFS` vs `fromFsLike`: why both exist

These serve different environments with different constraints:

- **`fromNodeFS(basePath)`** handles `require('node:fs/promises')` internally via dynamic require, preventing bundlers from including Node.js builtins in browser builds. It uses `path.resolve()` for OS-aware path resolution. This is genuinely Node.js-specific.

- **`fromFsLike(fsLike, rootPath?)`** accepts any object with a `promises` namespace matching the `FsLike` shape. This covers ZenFS, BrowserFS, memfs, polyfills, and any future fs-compatible library. The caller provides the fs object; the constructor just normalizes return types (Buffer → Uint8Array, stat → simplified shape).

They cannot be collapsed because `fromNodeFS` must do a dynamic `require()` internally to avoid bundler issues, while `fromFsLike` must accept the fs object as a parameter because the caller controls which fs instance to use.

### Layer 3: Bridge RPC

Generic MessagePort-based RPC primitives for serving any object's methods across thread boundaries.

#### Protocol

```
Client                          Server
  │                               │
  │  { id: 1, method, args }  ──► │  dispatch handlers[method](...args)
  │                               │
  │  ◄── { id: 1, result }       │  success
  │  ◄── { id: 1, error }        │  failure (BridgeError)
```

Every request carries a monotonically increasing `id`. The server dispatches by method name, calls the function, and responds with `{ id, result }` or `{ id, error }`. Errors are serialized as `BridgeError` objects preserving name, stack, errno code, and metadata.

#### Primitives

| Function | Level | Purpose |
|---|---|---|
| `createBridgeServer(handlers, port)` | Low | Serve an object's methods over a MessagePort |
| `createBridgePort(handlers)` | Low | Convenience: createBridgeServer + MessageChannel |
| `createBridgeCall(port)` | Low | Generic RPC client: `{ call, dispose }` |
| `createBridgeProxy<T>(port)` | Low | Generic `Proxy`-based RPC client for any protocol type |
| `catchMessages(port)` | Low | Buffer incoming messages during initialization, replay on demand |
| `extractTransferables(value)` | Low | Walk nested values and collect `ArrayBuffer` transferables (de-duplicated) |
| `createKernelFileSystem(base)` | Mid | Wrap `KernelFileSystemBase` with default enhanced method implementations |
| `exposeFileSystem(handlers, options?)` | High | Worker-side: listen for incoming bridge ports |
| `createFileSystemBridge(worker, options?)` | High | Main-thread: create channel + transfer port to worker |

**Naming split:** Generic bridge primitives use the `Bridge` prefix. Filesystem-typed functions use the `FileSystem` prefix. This distinction is intentional: `createBridgeServer` serves *any* object (generic `<T extends Record<string, unknown>>`), while `createBridgeProxy<KernelFileSystemBase>` returns a typed filesystem proxy.

#### High-Level Wrappers: expose/bridge pair

`exposeFileSystem` and `createFileSystemBridge` form a matched pair for zero-config worker setup:

```typescript
// Worker side (file-manager.worker.ts):
exposeFileSystem(fileManager);

// Main thread (kernel.machine.ts):
const port = createFileSystemBridge(fileManagerWorker);
await client.connect({ port });
```

The main thread creates a `MessageChannel`, transfers `port1` to the target worker, and returns `port2`. After setup, the kernel worker and filesystem worker communicate directly -- the main thread is not in the hot path.

## Connection Modes

The `KernelClient.connect()` method accepts two shapes, representing different abstraction levels:

```typescript
type ConnectOptions =
  | { fileSystem: KernelFileSystem }  // main-thread relay
  | { port: MessagePort };            // direct bridge
```

### Main-thread relay: `{ fileSystem }`

The client creates a `MessageChannel` internally, serves the filesystem via `createBridgeServer` on `port1`, and transfers `port2` to the kernel worker. Simple but adds one hop: kernel worker → main thread → filesystem implementation.

```typescript
const client = createKernelClient({ kernels: [replicad()], fileSystem: fromMemoryFS(files) });
```

### Direct bridge: `{ port }`

The caller creates the bridge externally (via `createFileSystemBridge`) and passes the pre-existing port. This enables worker-to-worker communication without the main thread in the hot path.

```typescript
const port = createFileSystemBridge(fileManagerWorker);
await client.connect({ port });
```

**When to use which:**

| Mode | Latency | Setup | Use Case |
|---|---|---|---|
| `{ fileSystem }` | +1 hop (main thread relay) | Zero config | CLI, tests, benchmarks, inline code |
| `{ port }` | Direct worker-to-worker | Manual bridge setup | Browser app with dedicated FS worker |

## Subpath Export Structure

```
@taucad/kernels              → fromNodeFS, fromMemoryFS, fromFsLike (constructors)
@taucad/kernels/filesystem   → exposeFileSystem, createFileSystemBridge (high-level)
                               createKernelFileSystem (wrapper)
                               createBridgeServer, createBridgePort, createBridgeCall (low-level)
                               createBridgeProxy, catchMessages, extractTransferables (low-level)
```

The main entry exports constructors because they're the most common consumer need. The `/filesystem` subpath exports bridge primitives for app integrators who need custom worker topologies.

## ZenFS Decoupling

The kernels package must be completely decoupled from ZenFS. The package provides a `node:fs`-compatible interface (`KernelFileSystem`) and constructors that normalize various fs implementations into that interface. No ZenFS types, imports, or naming should appear in the public API.

**Current state:** Completed. `fromZenFS` and `ZenFSLike` have been renamed to `fromFsLike` and `FsLike` respectively. The function accepts *any* object with a `promises` namespace -- not just ZenFS. The dead `fromProxy` code from the Comlink era has been removed.

**Exception:** Test utilities (`kernel-testing.utils.ts`) may import ZenFS directly as a concrete implementation for testing. This is acceptable because test utilities are not consumer-facing API.

**Rationale:** A developer using a different browser filesystem (e.g., BrowserFS, memfs, lightning-fs) can pass it to `fromFsLike()` without confusion about library-specific naming.

## Architectural Invariants

1. **KernelFileSystem is the only filesystem dependency in the framework.** Kernels, bundlers, and middleware never see MessagePort, Bridge, or constructor details. They receive `KernelFileSystem` via `KernelRuntime.fileSystem`.

2. **Bridge primitives are generic.** `createBridgeServer<T>`, `createBridgePort<T>`, `createBridgeCall`, and `createBridgeProxy<T>` work with any object, not just filesystems. This enables the app to serve a `FileManager` (which has methods beyond `KernelFileSystem`) through the same bridge infrastructure. `createBridgeProxy<T>(port)` eliminates the need for hand-written per-method stubs by using JavaScript's `Proxy` to auto-dispatch.

3. **Constructors normalize, not extend.** Each `from*` function converts a source API to exactly the `KernelFileSystemBase` interface -- the 11 primitives, no extra methods, no source-specific behavior leaking through.

4. **Zero-copy binary transfer.** `extractTransferables` scans values for `ArrayBuffer` instances and includes them in the `postMessage` transfer list. This avoids expensive structured-clone copies for large file content (CAD files can be tens of MB).

5. **Initialization safety.** `catchMessages(port)` buffers incoming messages until the server is ready, then replays them. This prevents lost requests during worker initialization.

4. **One serialization point per browser tab.** In the browser, all filesystem mutations flow through a single file-manager worker with a serialization queue. The bridge primitives enable multiple consumers (kernel workers, git, main thread) to connect to this single worker. This prevents the ZenFS TOCTOU race condition documented in `zen-fs/core#256`.

5. **Errors propagate with full context.** `BridgeError` preserves the worker-side error's name, stack trace, errno code, and metadata. The consumer-side proxy reconstructs a proper `Error` object, so `catch` blocks and error boundaries work naturally.

## Naming Rationale

### Why `createBridgeServer` not `createFileSystemServer`

The function is generic (`<T extends Record<string, unknown>>`), not `KernelFileSystem`. Naming it `createFileSystemServer` would be misleading when it's used to serve a `FileManager` with 20+ methods. The name should describe what the function does, not just its most common use case (library API policy Section 5: "Describe the action, not the architecture").

### Why `exposeFileSystem` keeps the `FileSystem` prefix

`exposeFileSystem` is the worker-side counterpart to `createFileSystemBridge`. Together they form a named pair. While `exposeFileSystem` is generic (`<T extends Record<string, unknown>>`), its documented purpose and primary use case is filesystem exposure. The pair naming provides better discoverability than generic alternatives like `exposeBridgeService`.

## Open Questions

### Should `@taucad/kernels/filesystem` split into two subpaths?

Currently, `/filesystem` exports both filesystem-typed APIs (`createFileSystemBridge`) and generic bridge primitives (`createBridgeServer`, `createBridgeProxy`, `createBridgeCall`). A potential split:

```
@taucad/kernels/filesystem   → filesystem-typed exports only
@taucad/kernels/bridge       → generic bridge primitives
```

**Current recommendation:** Keep them together. The bridge exists primarily for filesystem communication within Tau. A separate `/bridge` subpath adds complexity without clear consumer benefit. Revisit if the bridge primitives gain non-filesystem consumers.

### Should `fromFsLike` accept Node.js `fs` directly?

Node.js `fs` has a `.promises` namespace matching `FsLike`. In theory, `fromFsLike(require('fs'))` would work. However, `fromNodeFS` adds `path.resolve()` for OS-aware path resolution, which `fromFsLike` does not (it uses simple string concatenation). Recommend keeping both: `fromNodeFS` for Node.js environments, `fromFsLike` for browser/polyfill environments.

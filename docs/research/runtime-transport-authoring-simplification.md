---
title: 'Runtime Transport Authoring Simplification'
description: 'Two-pronged refactor of the v6 transport authoring surface: split client + host into sibling files to break the Rolldown chunk-emit cycle, and collapse the in-process transport stub host into a first-class "passthrough" authoring shape.'
status: active
created: '2026-05-01'
updated: '2026-05-01'
category: architecture
related:
  - docs/research/runtime-transport-architecture-v6.md
  - docs/policy/library-api-policy.md
---

# Runtime Transport Authoring Simplification

How to remove two pieces of accumulated friction in the v6 transport layer without changing its consumer-facing semantics: a 4-link Rolldown chunk-emit cycle that hangs `pnpm nx build ui`, and an in-process transport whose `host()` surface is a 50-line no-op stub that exists only to satisfy an authoring contract.

## Executive Summary

The v6 architecture co-located each transport's `client()` and `host()` factories in a single source file (`web-worker-transport.ts`, `node-worker-transport.ts`, `in-process-transport.ts`). Two follow-on problems surfaced once the runtime started shipping default worker entries:

1. **Chunk-emit cycle**: `web-worker-transport.ts` declares `DEFAULT_WEB_WORKER_URL = new URL('../worker/web.js', import.meta.url)`. The build-time plugin emits a chunk for `worker/web.ts` from inside the transport file's `transform()`. The emitted chunk's static or dynamic graph reaches back into `web-worker-transport.ts`, deadlocking Rolldown's `emitFile()`.
2. **Authoring asymmetry as duplication**: `inProcessTransport.host()` is a contract-stub — every method is a no-op — because the in-process client already wires both sides inside its own `open()`. Roughly 50 lines plus a `channel-server-stub.ts` helper exist solely to satisfy the `defineRuntimeTransport({ client, host })` shape.

Both are solvable inside the v6 blueprint without weakening type safety or breaking consumer call sites.

**Recommendations** (numbered for cross-reference):

| #   | Status   | Action                                                                                                               | Priority | Effort  | Impact                                                                      |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------- | --------------------------------------------------------------------------- |
| R1  | RESOLVED | Split `web-worker-transport.ts` into `web-worker-client.ts` + `web-worker-host.ts` + thin transport composition file | P0       | Med     | Unblocks `pnpm nx build ui`; eliminates structural cycle source             |
| R2  | RESOLVED | Mirror R1 for `node-worker-transport.ts`                                                                             | P0       | Low     | Same fix shape; prevents recurrence the moment Node CLI builds use chunking |
| R3  | RESOLVED | Add `definePassthroughTransport({ id, client })` author API; collapse in-process transport's stub host               | P1       | Low     | Removes ~80 lines of stub plumbing; clarifies authoring contract            |
| R4  | RESOLVED | Delete `apps/ui/app/constants/web.ts` and the `url: new URL('web.ts', ...)` override                                 | P0       | Trivial | Removes one (the most direct) leg of the cycle and dead code                |
| R5  | RESOLVED | Delete `_internal/channel-server-stub.ts` once R3 lands                                                              | P2       | Trivial | Reflects that the only consumer was the in-process stub                     |

### Realised line counts (post-implementation)

| File                                               | Before | After | Delta                                                    |
| -------------------------------------------------- | ------ | ----- | -------------------------------------------------------- |
| `transport/in-process-transport.ts`                | 353    | 268   | −85                                                      |
| `transport/web-worker-transport.ts` (composition)  | ~410   | 78    | −332                                                     |
| `transport/web-worker-host.ts` (new)               | —      | 164   | +164                                                     |
| `transport/web-worker-client.ts` (new)             | —      | 270   | +270                                                     |
| `transport/node-worker-transport.ts` (composition) | ~382   | 79    | −303                                                     |
| `transport/node-worker-host.ts` (new)              | —      | 152   | +152                                                     |
| `transport/node-worker-client.ts` (new)            | —      | 270   | +270                                                     |
| `transport/define-runtime-transport.ts`            | ~125   | 220   | +95 (adds `definePassthroughTransport` overloads + impl) |
| `transport/_internal/channel-server-stub.ts`       | 44     | —     | −44                                                      |
| `transport/in-process-transport-host-stub.test.ts` | ~99    | —     | −99 (replaced by `host-throws.test.ts`, ~31 LOC)         |

The composition files (`web-worker-transport.ts`, `node-worker-transport.ts`) are now ~80 lines each and contain only `defineRuntimeTransport({ ... })` plus type re-exports — the chunk-emit literal lives exclusively inside the matching `*-client.ts`. Each topology gains a third sibling (`*-host.ts`) that the corresponding `worker/{web,node}.ts` entry can static-import without re-entering the chunk-emitter file.

The in-process transport keeps its `client()` body (the actual same-isolate dispatcher) and replaces the entire former `host()` block with a synthesised throwing closure courtesy of `definePassthroughTransport`. Companion test `in-process-transport-host-throws.test.ts` pins the runtime contract; the conformance suite asserts the same on the cross-cutting slice.

## Problem Statement

### Problem 1 — `pnpm nx build ui` deadlocks

After commit `60b9a5dd1` broadened `tsModuleUrlBuildPlugin`'s regex and added an `await context.resolve()` fallback, `pnpm nx build ui` hangs at:

```
[ts-mod-url] emitFile seq=18 ts=/Users/.../packages/runtime/src/worker/web.ts
                              (no matching `emitted seq=18` line ever follows)
```

`emitFile()` for `worker/web.ts` never returns. All other emits (kernels, middleware, transcoders) return in 0 ms. The hang is specific to chunks whose graph reaches back into the transform that emitted them.

### Problem 2 — `inProcessTransport.host()` is a contract-only stub

`packages/runtime/src/transport/in-process-transport.ts:254-336` documents itself plainly:

> Contract-stub host for the in-process transport (R15). In-process is single-isolate: the client side already spins up `KernelRuntimeWorker` directly inside `client().open()` via an internal `MessageChannel`, so there is no separate host runtime to bootstrap. This `host()` exists purely to satisfy the `RuntimeTransport` contract.

Every method is a no-op (`createNoopChannelServerHandle`, identity encoders, etc.). The same file imports `_internal/channel-server-stub.ts` (44 lines) which has exactly one consumer: this stub host. Authors reading the code reasonably ask "why is this here?" because nothing answers it except a JSDoc disclaimer.

## Methodology

- Read the full transport directory (`packages/runtime/src/transport/`), the `define-runtime-transport.ts` factory, and `runtime-transport.types.ts`.
- Reproduced the build hang with verbose `tsModuleUrlBuildPlugin` instrumentation; confirmed the deadlock signature is a Rolldown NAPI `emitFile()` blocking on chunk-graph planning.
- Traced every value-import edge from `worker/web.ts`'s static graph and from `web-worker-transport.ts`'s static graph. **No source-level static cycle exists in the runtime package after the dynamic-import workaround.** The cycle is at the build-graph layer (chunk planning) and is amplified by `apps/ui/app/constants/web.ts` (a custom worker entry) which still statically imports the transport.
- Cross-referenced [`runtime-transport-architecture-v6.md`](./runtime-transport-architecture-v6.md) §"Eigenquestions Resolved" and §"Findings Carried Forward" to ensure proposed changes are compatible with the v6 blueprint (specifically the four strict rules: capability hiding, phantom-generic propagation, Zod-schema-authored protocol, `defineRuntimeTransport` as the only `defineX` that doubles as plugin factory).

## Findings

### Finding 1 — The cycle is at the build-graph layer, not the source layer

There is no `import` statement chain from `packages/runtime/src/worker/web.ts` back to `packages/runtime/src/transport/web-worker-transport.ts`. The only references to `webWorkerTransport` in non-test runtime files are:

| File                                                     | Reference shape                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/runtime/src/transport/web-worker-transport.ts` | self (`export const webWorkerTransport = ...`)                                     |
| `packages/runtime/src/transport/web.ts`                  | barrel (`export { webWorkerTransport } from '#transport/web-worker-transport.js'`) |
| `packages/runtime/src/worker/web.ts`                     | dynamic (`await import('#transport/web-worker-transport.js')`)                     |
| test files                                               | irrelevant for build                                                               |

The cycle that hangs `emitFile()` runs through Rolldown's emit pipeline, not through static imports:

```
web-worker-transport.ts.transform()
  └─ DEFAULT_WEB_WORKER_URL = new URL('../worker/web.js', import.meta.url)
     └─ tsModuleUrlBuildPlugin matches
        └─ this.emitFile({ type: 'chunk', id: 'worker/web.ts' })
           └─ Rolldown begins processing the new chunk
              └─ chunk source: const { webWorkerTransport } = await import('#transport/web-worker-transport.js')
                 └─ Rolldown must resolve + plan a chunk for the dynamic-import target
                    └─ target = web-worker-transport.ts (the file currently in transform()!)
                       └─ wait for transform() to finalize ─┐
                                                            │
                       ◄──────────────────────────────────── DEADLOCK
```

The dynamic `await import()` in `worker/web.ts` does not break this cycle. Rolldown still has to resolve the import target and plan a separate chunk during the parent emit. When the target is the file currently inside `transform()`, the plan cannot complete and `emitFile()` cannot return.

### Finding 2 — A second cycle path exists via the app's custom worker entry

`apps/ui/app/constants/web.ts` (38 lines) is a custom worker entry the user wrote when the runtime did not yet bundle a default URL. It is referenced from `apps/ui/app/constants/kernel-worker.constants.ts:58`:

```typescript
url: new URL('web.ts', import.meta.url),
```

The custom entry **statically** imports `webWorkerTransport`:

```typescript
import { webWorkerTransport } from '@taucad/runtime/transport/web';
```

So `apps/ui/app/constants/web.ts`'s chunk graph contains `web-worker-transport.ts` directly. Even after the runtime-side cycle is broken, this app-side static import re-creates the same hazard. With `DEFAULT_WEB_WORKER_URL` now defaulted inside the transport client, the custom entry is also redundant.

### Finding 3 — Splitting client + host into sibling files structurally eliminates the cycle

The principle: **a file that emits a chunk via `new URL(..., import.meta.url)` must not be reachable from the emitted chunk's transitive graph.**

Today `web-worker-transport.ts` does both jobs:

1. Holds the `host()` factory consumed by `worker/web.ts`.
2. Holds `DEFAULT_WEB_WORKER_URL` (the chunk emitter).

Separating them into sibling files lets `worker/web.ts` static-import only the host file, while the chunk-emitter file lives outside the worker chunk's transitive graph:

```
worker/web.ts            ← chunk being emitted
   └─ static import: web-worker-host.ts                 (host factory, NO chunk emit)
                                                           │
web-worker-client.ts     ← chunk emitter (DEFAULT_WEB_WORKER_URL lives here)
   └─ static import: web-worker-host.ts (for type re-use only, optional)

web-worker-transport.ts  ← thin composition: defineRuntimeTransport({ id, client, host })
   └─ import: web-worker-client.ts
   └─ import: web-worker-host.ts
```

Neither `worker/web.ts` nor `web-worker-host.ts` has a path back to `web-worker-client.ts`. The cycle is structurally impossible.

### Finding 4 — Type safety is preserved by funneling through `defineRuntimeTransport`

The phantom-generic carriers documented in v6 §"Generic Type Inference Pipeline" (`Protocol`, `BindingsExtra`, `Id`, `ClientOptions`, `HostOptions`) all live on the `RuntimeTransportPlugin<…>` returned by `defineRuntimeTransport`. As long as the final composition file passes both factories into the same `defineRuntimeTransport(...)` call, TypeScript will:

- Verify the `Id` literal matches between client and host (both must satisfy `RuntimeTransportClient<P, BE, Id>` / `RuntimeTransportHost<P, BE, Id>` for the same `Id`).
- Verify the `BindingsExtra` shape produced by `host.adoptInitialize()` matches the bindings the client's `RuntimeTransportClient<…, BE, …>` advertises through its phantom carrier.
- Infer `ClientOptions` from `clientOptionsSchema` and `HostOptions` from `hostOptionsSchema` (both schemas continue to live as siblings — see file plan in §Recommendations).

No type information is lost by the file split because the phantom-bearing object (the `RuntimeTransportPlugin` instance) is still constructed in one place.

### Finding 5 — In-process is structurally a "passthrough", not a wire transport

Re-reading `inProcessTransport.client()` reveals it is doing the host's job inline:

```typescript
const channelPair = new MessageChannel();
const clientPort = wrapMessagePort(channelPair.port1, …);
const hostPort = wrapMessagePort(channelPair.port2, …);
…
const worker = new kernelWorkerModule.KernelRuntimeWorker();
createWorkerDispatcher(worker, hostPort, { inlineFileSystem, encodeGeometry, encodeFile });
```

The "host" is dispatched inline by the client's `open()`. There is no wire to bridge — the `MessageChannel` is a same-isolate loopback used purely so the channel protocol stays uniform with cross-isolate transports.

Consequently `inProcessTransport.host()` has nothing to do:

- `open()` returns a no-op channel server stub.
- `adoptInitialize()` returns identity bindings (the `publish()` helpers do nothing useful because the dispatcher is already wired).
- `encodeGeometry` / `encodeFile` return inline copies that no one reads.

This is not "future-proofing" — it is duplication of an authoring shape that the transport does not need. The right fix is to give the author API a second factory shape that names this case explicitly.

### Finding 6 — The "passthrough" shape can be added without weakening anything

Today's `defineRuntimeTransport` requires `host` always. A complementary `definePassthroughTransport` author entry could express same-isolate transports cleanly:

```typescript
// Today:
defineRuntimeTransport({
  id: 'in-process',
  clientOptionsSchema,
  hostOptionsSchema, // unused — host is a stub
  client(opts) {
    /* spins up dispatcher inline */
  },
  host(_opts) {
    /* 50 lines of no-ops */
  },
});

// Proposed:
definePassthroughTransport({
  id: 'in-process',
  clientOptionsSchema,
  client(opts) {
    /* spins up dispatcher inline (unchanged) */
  },
});
```

What this loses:

- **Authoring symmetry** — `defineRuntimeTransport` is no longer the single entry for transport authors. There are now two: the wire-bridging shape (web-worker, node-worker, electron-utility) and the passthrough shape (in-process and any future same-isolate transport).

What this gains:

- **No stub host code path** in the runtime package (deletes ~50 lines from `in-process-transport.ts` plus all of `_internal/channel-server-stub.ts`).
- **Explicit semantics** — readers see "passthrough" and immediately understand there is no wire crossing.
- **Stronger TypeScript guidance** — `definePassthroughTransport` cannot be called with a `host` factory; misuse fails at compile time.
- **Zero consumer-facing change** — the returned `RuntimeTransportPlugin` still satisfies `RuntimeTransport*` types because `definePassthroughTransport` synthesises a typed `host()` internally (one that throws a clear `passthrough transport: host() not callable on this transport` error if anyone reaches for it). This preserves the v6 blueprint's promise that "every transport plugin is a paired-factory object" — the pair is still there, but one half is autogenerated and labelled.

The trade-off is mild: authors of cross-isolate transports keep using `defineRuntimeTransport`; authors of same-isolate transports get a more honest shape. The author-API surface grows by one symbol.

## Recommendations

### R1 — Split `web-worker-transport.ts` into client + host + composition

**Target file layout** (`packages/runtime/src/transport/`):

```
web-worker-host.ts              ← host() factory only;  NO new URL literals
web-worker-client.ts            ← client() factory + DEFAULT_WEB_WORKER_URL
web-worker-transport.ts         ← composes both via defineRuntimeTransport
web-worker-transport.schemas.ts ← unchanged; both client + host import schemas from here
web-worker-transport.types.ts   ← (NEW, optional) shared types like WebWorkerLike
web.ts                          ← unchanged barrel; re-exports webWorkerTransport
```

`web-worker-host.ts` (~150 lines, extracted from current `web-worker-transport.ts:309-399`):

```typescript
import { defineRuntimeTransport } from '#transport/define-runtime-transport.js';
import type { z } from 'zod';
import { webWorkerHostOptionsSchema } from '#transport/web-worker-transport.schemas.js';
import type { RuntimeTransportHost, … } from '#transport/runtime-transport.types.js';
import { collectWireTransferables } from '#transport/_internal/wire-transferables.js';
import { createWorkerDispatcher } from '#transport/_internal/runtime-worker-dispatcher.js';
import { acquireWebWorkerSelfPort } from '#transport/_internal/web-worker-self-port.js';
import { installWorkerCrashTrap } from '#transport/_internal/worker-crash-trap.js';
import { adoptHostAbort } from '#transport/_internal/abort-channel.js';
import { buildHelloPayload } from '#transport/_internal/transport-hello.js';
import { createWorkerHostBindings } from '#transport/_internal/worker-host-bindings.js';
import { fromMemoryFs } from '#filesystem/runtime-filesystem.js';

export const webWorkerId = 'web-worker' as const;
export type WebWorkerHostOptions = z.input<typeof webWorkerHostOptionsSchema>;

export const webWorkerHost = (
  options: WebWorkerHostOptions,
): RuntimeTransportHost<RuntimeProtocol, Readonly<Record<never, never>>, typeof webWorkerId> => {
  // unchanged body of the previous host() factory
  …
};
```

`web-worker-client.ts` (~200 lines, extracted from `web-worker-transport.ts:171-307` plus `DEFAULT_WEB_WORKER_URL`):

```typescript
import { webWorkerId } from '#transport/web-worker-host.ts';   // type-only is fine
import { webWorkerClientOptionsSchema } from '#transport/web-worker-transport.schemas.js';
…

const DEFAULT_WEB_WORKER_URL = new URL('../worker/web.js', import.meta.url);
//                                       ↑ chunk-emitter literal lives here
//                                         worker/web.ts does NOT import this file

export type WebWorkerClientOptions = z.input<typeof webWorkerClientOptionsSchema>;

export const webWorkerClient = (
  options: WebWorkerClientOptions,
): RuntimeTransportClient<RuntimeProtocol, Readonly<Record<never, never>>, typeof webWorkerId> => {
  // unchanged body of the previous client() factory
  …
};
```

`web-worker-transport.ts` shrinks to a thin composition (~30 lines):

```typescript
import { defineRuntimeTransport } from '#transport/define-runtime-transport.js';
import { webWorkerClientOptionsSchema, webWorkerHostOptionsSchema } from '#transport/web-worker-transport.schemas.js';
import { webWorkerClient, webWorkerId } from '#transport/web-worker-client.js';
import { webWorkerHost } from '#transport/web-worker-host.js';

/**
 * Bundled web-worker transport. Composes the client + host factories
 * defined in their respective sibling files. Living in its own file
 * (rather than co-located with one factory) so that consumers and the
 * default worker entry never co-import the chunk-emitting client file.
 *
 * @public
 */
export const webWorkerTransport = defineRuntimeTransport({
  id: webWorkerId,
  clientOptionsSchema: webWorkerClientOptionsSchema,
  hostOptionsSchema: webWorkerHostOptionsSchema,
  client: webWorkerClient,
  host: webWorkerHost,
});

export type { WebWorkerLike } from '#transport/web-worker-client.js';
```

`worker/web.ts` becomes its current shape but with **static** imports (no `await import()` workaround needed):

```typescript
import '#framework/worker-preload-polyfill.js';
import { KernelRuntimeWorker } from '#framework/kernel-runtime-worker.js';
import { webWorkerHost } from '#transport/web-worker-host.js';

const worker = new KernelRuntimeWorker();
await webWorkerHost({ worker }).open();
```

The chunk graph for `worker/web.ts` now contains: polyfill + kernel-runtime-worker + `web-worker-host.ts`. None of those reach `web-worker-client.ts` — the chunk emitter. **Cycle structurally impossible.**

### R2 — Apply the same split to `node-worker-transport.ts`

Mirror R1: extract `node-worker-host.ts`, `node-worker-client.ts`, keep a thin `node-worker-transport.ts` composition file, and have `worker/node.ts` static-import only the host.

This is preventative — `node-worker-transport.ts` does not yet hang because Node CLI builds either skip emit-via-chunk pipelines or use a different bundler today, but the structural hazard is identical and will surface the moment a Node build adopts the same plugin.

### R3 — Add `definePassthroughTransport` author API; collapse the in-process stub host

`define-runtime-transport.ts` adds a fourth overload (or a sibling export) that accepts only `{ id, clientOptionsSchema?, client }`:

```typescript
/**
 * Define a same-isolate transport. The author supplies only the
 * `client(...)` factory; the framework synthesises a typed `host(...)`
 * factory that throws if invoked, because there is no wire-host
 * runtime to bootstrap. Returns the same {@link RuntimeTransportPlugin}
 * shape as {@link defineRuntimeTransport} so consumer call sites are
 * unchanged.
 *
 * @public
 */
export function definePassthroughTransport<
  const Id extends string,
  ClientOptionsSchema extends z.ZodType,
  Protocol extends RpcProtocol = RuntimeProtocol,
>(definition: {
  readonly id: Id;
  readonly protocol?: Protocol;
  readonly clientOptionsSchema: ClientOptionsSchema;
  readonly client: (
    options: z.input<ClientOptionsSchema>,
  ) => RuntimeTransportClient<Protocol, Readonly<Record<never, never>>, Id>;
}): RuntimeTransportPlugin<
  Protocol,
  Readonly<Record<never, never>>,
  Id,
  z.input<ClientOptionsSchema>,
  Readonly<Record<never, never>>
>;
```

Implementation synthesises a `host()` that throws a labelled error and a `hostOptionsSchema` of `z.object({}).strict()` (or omits the schema entirely):

```typescript
export function definePassthroughTransport(definition: any): any {
  return {
    id: definition.id,
    client: definition.client,
    host(): never {
      throw new Error(
        `${definition.id}: passthrough transport — host() is not callable. ` +
          `client() owns the entire pipeline; no wire host to bootstrap.`,
      );
    },
  };
}
```

`in-process-transport.ts` becomes ~150 lines (down from 353):

```typescript
export const inProcessTransport = definePassthroughTransport({
  id: 'in-process',
  clientOptionsSchema: inProcessClientOptionsSchema,
  client(options) {
    // unchanged body; client already wires the dispatcher inline
    …
  },
});
```

The deleted code: the entire `host()` block (lines 254-336), the `inProcessHostOptionsSchema` import, and the import of `_internal/channel-server-stub.ts`.

### R4 — Delete the redundant custom worker entry

In `apps/ui/app/constants/kernel-worker.constants.ts`, drop:

```typescript
url: new URL('web.ts', import.meta.url),
```

Then delete `apps/ui/app/constants/web.ts`. The transport will default to the bundled `@taucad/runtime/worker/web` entry via `DEFAULT_WEB_WORKER_URL` (per R1, that literal continues to live inside the runtime package — but in `web-worker-client.ts`, not `web-worker-transport.ts`).

This is the lowest-effort change in the set and should land first to remove the most direct cycle path while R1-R3 land.

### R5 — Delete `_internal/channel-server-stub.ts`

After R3 lands, the only consumer is gone. Delete the file and any associated tests; the `ChannelServerHandle` type continues to be supplied by `@taucad/rpc` for real wire-bridging hosts.

## Trade-offs

| Concern                             | Status quo                                                        | After R1-R5                                                                       |
| ----------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| File count for web-worker transport | 2 (`web-worker-transport.ts` + `web-worker-transport.schemas.ts`) | 4 (host, client, transport composition, schemas)                                  |
| Stub-code maintenance               | ~80 lines of stub host + helper                                   | 0                                                                                 |
| Author API entry points             | 1 (`defineRuntimeTransport`)                                      | 2 (`defineRuntimeTransport`, `definePassthroughTransport`)                        |
| Type safety between client + host   | Co-located in one file                                            | Funneled through `defineRuntimeTransport(...)` call — same end-to-end inference   |
| Cycle hazard                        | Present (causes `pnpm nx build ui` hang)                          | Structurally impossible                                                           |
| Consumer-facing API                 | `webWorkerTransport.client(...)` / `.host(...)`                   | Unchanged                                                                         |
| Worker entry static-import safety   | Forced to use `await import(...)` workaround (insufficient)       | Plain `import { webWorkerHost } from '@taucad/runtime/transport/web-worker-host'` |

The file-count growth is real but each file has one clear job and follows the v6 blueprint's "thin composition over fat module" principle. The author-API growth (one new symbol) is the cost of giving same-isolate transports an honest shape.

## Code Examples

### Type-safety verification: `defineRuntimeTransport` enforces client/host parity

Even after the split, attempting to mix mismatched factories fails at compile time:

```typescript
// hypothetical mistake: web client + node host
defineRuntimeTransport({
  id: 'web-worker',
  clientOptionsSchema: webWorkerClientOptionsSchema,
  hostOptionsSchema: webWorkerHostOptionsSchema,
  client: webWorkerClient, // RuntimeTransportClient<…, …, 'web-worker'>
  host: nodeWorkerHost, // RuntimeTransportHost<…, …, 'node-worker'>
  //    ^^^^^^^^^^^^^^^^
  //    Type 'RuntimeTransportHost<…, "node-worker">' is not assignable
  //    to type 'RuntimeTransportHost<…, "web-worker">'.
});
```

The `Id` phantom is `const`-inferred from `definition.id`; both `client` and `host` are required to project the same `Id`. The same enforcement applies to `BindingsExtra`.

### Passthrough misuse fails clearly

```typescript
const client = createRuntimeClient({
  kernels: [replicad()],
  transport: inProcessTransport.client({ fileSystem: fromMemoryFs() }),
});

// Author tries to spin up an "in-process host" because a wire transport's API made it look possible:
const host = inProcessTransport.host({});
//                              ^^^^^^^^
//   throws at runtime: "in-process: passthrough transport — host() is not callable.
//                       client() owns the entire pipeline; no wire host to bootstrap."
```

If a stronger compile-time guarantee is desired, the synthesised `host` field can be typed as `never`:

```typescript
type PassthroughTransportPlugin<…> = Omit<RuntimeTransportPlugin<…>, 'host'> & {
  readonly host: never;
};
```

Trade-off: this would diverge the plugin shape from `RuntimeTransportPlugin` and require `RuntimeClient` to be generic over both shapes. Recommend keeping the runtime-error variant unless a real consumer-side need surfaces.

## Diagrams

### Before R1 — chunk-emit cycle

```
┌─────────────────────────────────────────────────────────────────┐
│  packages/runtime/src/transport/web-worker-transport.ts         │
│                                                                 │
│  (1) DEFAULT_WEB_WORKER_URL = new URL('../worker/web.js', …)    │
│      ↓ tsModuleUrlBuildPlugin                                   │
│  (2) emitFile({ id: 'worker/web.ts' })                          │
│      ↓ Rolldown processes new chunk                             │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  packages/runtime/src/worker/web.ts                              │
│                                                                 │
│  (3) await import('#transport/web-worker-transport.js')          │
│      ↓ Rolldown resolves dynamic-import target                  │
│  (4) target = web-worker-transport.ts ← currently transforming! │
│      ↓ wait for transform()                                     │
└─────── DEADLOCK (transform waits on emitFile waits on plan) ────┘
```

### After R1 — structural break

```
┌──────────────────────────────────────────┐    ┌─────────────────────────────┐
│  web-worker-client.ts (chunk emitter)    │    │  web-worker-host.ts         │
│  • DEFAULT_WEB_WORKER_URL = new URL(…)   │    │  • webWorkerHost(opts)      │
│  • webWorkerClient(opts)                 │    │                             │
└──────────────────────────────────────────┘    └─────────────────────────────┘
                  │                                          ▲
                  │ both imported by                          │ statically imported by
                  ▼                                          │
┌──────────────────────────────────────────┐    ┌─────────────────────────────┐
│  web-worker-transport.ts (composition)   │    │  worker/web.ts (entry)       │
│  defineRuntimeTransport({                │    │  import { webWorkerHost }   │
│    id, client: webWorkerClient,          │    │  await webWorkerHost(…)     │
│    host: webWorkerHost,                  │    │                             │
│  })                                      │    │  no path to client file     │
└──────────────────────────────────────────┘    └─────────────────────────────┘
```

`worker/web.ts` reaches only `web-worker-host.ts`. `web-worker-host.ts` does not import `web-worker-client.ts`. The chunk emitter (`web-worker-client.ts`) is structurally outside the emitted chunk's transitive graph.

## V6 Blueprint Compatibility

This proposal preserves all four strict rules of [`runtime-transport-architecture-v6.md`](./runtime-transport-architecture-v6.md) §"Executive Summary":

| Rule                                                             | Preserved by                                                                                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Each transport maximises its own performance                  | Unchanged. Splitting source files does not move capability negotiation onto the public surface.                                                                         |
| 2. Phantom generics propagate end-to-end                         | Preserved. The `RuntimeTransportPlugin` is still constructed in one `defineRuntimeTransport(...)` (or `definePassthroughTransport(...)`) call where all phantoms unify. |
| 3. Wire protocol authored as Zod schemas                         | Unchanged. Schemas continue to live in `*-transport.schemas.ts` and are imported by both client + host factories.                                                       |
| 4. `defineRuntimeTransport` is the only `defineX` plugin factory | Slightly relaxed: a sibling `definePassthroughTransport` is added for same-isolate transports. The cross-isolate factory is still the canonical path.                   |

Files added/removed map onto v6 §"Files to Add" and §"Files to Delete" as a delta:

```
+ packages/runtime/src/transport/web-worker-host.ts
+ packages/runtime/src/transport/web-worker-client.ts
+ packages/runtime/src/transport/node-worker-host.ts
+ packages/runtime/src/transport/node-worker-client.ts
+ packages/runtime/src/transport/define-passthrough-transport.ts (or new export from define-runtime-transport.ts)

~ packages/runtime/src/transport/web-worker-transport.ts        (shrunk to composition)
~ packages/runtime/src/transport/node-worker-transport.ts       (shrunk to composition)
~ packages/runtime/src/transport/in-process-transport.ts        (host stub removed)
~ packages/runtime/src/worker/web.ts                            (static import restored)
~ packages/runtime/src/worker/node.ts                           (static import restored)

- packages/runtime/src/transport/_internal/channel-server-stub.ts
- apps/ui/app/constants/web.ts
```

## Open Questions

| #   | Question                                                                                                                                       | Recommendation                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Should `definePassthroughTransport` synthesise `host` as `never`-typed (compile-time block) or runtime-throwing only?                          | Runtime-throwing only initially; revisit if a consumer ever calls `passthrough.host(...)` by accident.                                                                                                                  |
| Q2  | Should `web-worker-host.ts` be a public subpath (`@taucad/runtime/transport/web-worker-host`)?                                                 | Yes — needed for custom worker entries that compose `webWorkerHost` + `KernelRuntimeWorker` directly. The current `worker-internals` subpath already exposes `KernelRuntimeWorker`; expose `webWorkerHost` analogously. |
| Q3  | Could the cycle also be solved by moving emit out of `transform` into `buildStart`?                                                            | Possibly, but that re-architects `tsModuleUrlBuildPlugin` and shifts complexity; R1 is the smaller and more local fix.                                                                                                  |
| Q4  | Does the `defineRuntimeTransport` factory need a fourth overload to accept `client` + `host` as already-bound functions (vs inline factories)? | No — the current overloads already accept any callable matching the factory signature. The split files export bound function values; the composition file just passes them in.                                          |

## References

- [`runtime-transport-architecture-v6.md`](./runtime-transport-architecture-v6.md) — v6 blueprint that this proposal extends without breaking.
- [`runtime-transport-implementation-blueprint-v4.md`](./runtime-transport-implementation-blueprint-v4.md) — historical context for the `defineRuntimeTransport` shape.
- [`generic-inference-pipeline.md`](./generic-inference-pipeline.md) — phantom-carrier patterns the split must preserve.
- [`library-api-policy.md`](../policy/library-api-policy.md) §6 (Subpath Exports), §10 (High-Level Wrappers + Low-Level Escape Hatches), §22 Antipattern 5 (no wire facts on cross-layer types) — all four rules continue to hold.

## Appendix — Build-time evidence

Sample from instrumented `tsModuleUrlBuildPlugin` showing the deadlock signature:

```
[ts-mod-url] start    seq=18 id=…/web-worker-transport.ts
[ts-mod-url] matches  seq=18 count=3 specs=["../worker/web.js","../worker/web.js","./custom-worker.ts"]
[ts-mod-url] fast     seq=18 spec=../worker/web.js -> …/worker/web.ts
[ts-mod-url] fast     seq=18 spec=../worker/web.js -> …/worker/web.ts
[ts-mod-url] resolve> seq=18.1 spec=./custom-worker.ts importer=…/web-worker-transport.ts
[ts-mod-url] resolve< seq=18.1 elapsed=1961ms id=<none>
[ts-mod-url] resolved seq=18 elapsed=1961ms ts-matches=2
[ts-mod-url] emitFile seq=18 ts=…/packages/runtime/src/worker/web.ts
                                                                    ← never returns; build hangs here
```

Other emits in the same run return synchronously in 0–1 ms (kernels, middleware, transcoders), confirming the deadlock is specific to chunks whose graph reaches back into the transform that emitted them.

Process sampling at the hang point shows main thread blocked in `rolldown-binding.darwin-arm64.node` and tokio worker threads parked on condition variables — a classic NAPI/Rust ↔ JS round-trip deadlock.

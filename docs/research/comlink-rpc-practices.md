---
title: 'Comlink RPC Best Practices & Bridge Implementation Comparison'
description: 'Comparison of Comlink RPC patterns with our runtime-filesystem-bridge; thenable prevention, error serialization, cleanup gaps.'
status: active
created: '2026-03-04'
updated: '2026-03-05'
category: comparison
related:
  - docs/policy/rpc-policy.md
---

# Comlink RPC Best Practices & Bridge Implementation Comparison

## 1. Thenable Prevention on Proxies

### The Problem

JavaScript's Promise resolution mechanism checks if a resolved value has a `.then` method. A catch-all Proxy `get` trap returns a function for _any_ property — including `then` — making the Proxy look like a thenable. When `resolve(proxy)` is called, the engine invokes `proxy.then(resolve, reject)`, which in an RPC proxy sends the `resolve`/`reject` **functions** over the MessagePort. Functions are not structured-clonable, causing a `DataCloneError` and a permanently pending Promise.

This is the exact bug we encountered: `readBackendFileTree` would call `getReadiedWorker()`, the Promise would resolve with the bridge proxy, but the `await` continuation never ran because `Promise.resolve(proxy)` triggered `proxy.then(...)` which silently failed.

### Comlink's Approach

Comlink uses a path-based proxy (each property access appends to a path array). The `then` trap has two behaviors:

```javascript
// Root proxy (path.length === 0): make it non-thenable
if (prop === 'then') {
  if (path.length === 0) {
    return { then: () => proxy };
  }
  // Non-root: forward as a real GET then bind the result
  const r = requestResponseMessage(ep, { type: 'GET', path }).then(fromWireValue);
  return r.then.bind(r);
}
```

- **Root proxy**: Returns `{ then: () => proxy }` — a thenable that resolves to the proxy itself, preventing infinite recursion.
- **Non-root proxy**: Fetches the remote property and returns a proper `.then` binding, so `await proxy.nested.value` resolves to the remote value.

### Our Approach

We return `undefined` for `then`, which is simpler and sufficient for our flat (non-nested) proxy:

```typescript
if (method === 'then') {
  return undefined;
}
```

This correctly prevents thenable behavior. Since our proxy doesn't support nested path-based access, we don't need the non-root branch.

### Verdict

**Our approach is correct** for our use case. Comlink's approach supports `await proxy.prop` (remote property fetching), which we don't need since every proxy method is an explicit async call.

---

## 2. Transferable Detection

### Comlink's Approach

Comlink uses an **explicit opt-in** model with `transfer()`:

```javascript
const transferCache = new WeakMap();
export function transfer(obj, transfers) {
  transferCache.set(obj, transfers);
  return obj;
}
```

The caller must explicitly mark which transferables accompany a value:

```javascript
await proxy.processBuffer(Comlink.transfer(buffer, [buffer]));
```

During serialization, `transferCache.get(value)` retrieves the transfer list. This is precise but requires caller discipline.

### Our Approach

We use **automatic detection** via `extractTransferables()`:

```typescript
export function extractTransferables(value: unknown): Transferable[] {
  const seen = new Set<ArrayBuffer>();
  function walk(v: unknown): void {
    if (v instanceof ArrayBuffer) {
      seen.add(v);
    } else if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer) {
      seen.add(v.buffer);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v !== null && typeof v === 'object') {
      for (const prop of Object.values(v)) walk(prop);
    }
  }
  walk(value);
  return [...seen];
}
```

This recursively walks values and collects `ArrayBuffer` instances. It handles:

- Standalone `ArrayBuffer` instances
- Typed arrays (`Uint8Array`, etc.) via `.buffer`
- Nested objects and arrays
- Deduplication via `Set`

### Transferables Not Detected

Our walker only finds `ArrayBuffer`. Other transferable types are not detected:

| Type              | Transferable? | Detected? |     Used in our code?     |
| ----------------- | :-----------: | :-------: | :-----------------------: |
| `ArrayBuffer`     |      Yes      |    Yes    |            Yes            |
| `MessagePort`     |      Yes      |    No     | No (transferred manually) |
| `ImageBitmap`     |      Yes      |    No     |            No             |
| `OffscreenCanvas` |      Yes      |    No     |            No             |
| `ReadableStream`  |      Yes      |    No     |            No             |
| `WritableStream`  |      Yes      |    No     |            No             |
| `TransformStream` |      Yes      |    No     |            No             |

### Verdict

**Our approach is sufficient** for our filesystem bridge, which exclusively deals with `Uint8Array`/`ArrayBuffer` data. Comlink's explicit model is more general but adds API friction. If we ever need to transfer `MessagePort` or streams, we should either extend `extractTransferables` or add an explicit transfer mechanism.

---

## 3. Error Serialization

### Comlink's Approach

Comlink wraps thrown values with a `throwMarker` symbol and uses a transfer handler:

```javascript
serialize({ value }) {
  if (value instanceof Error) {
    return [{ isError: true, value: { message, name, stack } }, []];
  }
  return [{ isError: false, value }, []];  // Non-Error throws
}

deserialize(serialized) {
  if (serialized.isError) {
    throw Object.assign(new Error(serialized.value.message), serialized.value);
  }
  throw serialized.value;  // Re-throw the raw value
}
```

Key behaviors:

- **Error instances**: `message`, `name`, `stack` are preserved.
- **Non-Error throws** (strings, objects, numbers): The raw value is structured-cloned and re-thrown as-is.
- **Unserializable returns**: If `postMessage` fails, Comlink sends `TypeError("Unserializable return value")` — a proper error, not silent data loss.

### Our Approach

```typescript
const bridgeError: BridgeError = {
  message: error instanceof Error ? error.message : String(error),
  name: error instanceof Error ? error.constructor.name : 'Error',
  stack: error instanceof Error ? error.stack : undefined,
  code: (error as NodeJS.ErrnoException).code,
  metadata: (error as Record<string, unknown>)['metadata'],
};
```

Key behaviors:

- **Error instances**: `message`, `name`, `stack`, `code`, `metadata` are preserved.
- **Non-Error throws**: Stringified into `message`; original value is lost.
- **Unserializable returns**: We send `{ id, result: undefined }` — **silent data loss**.

### Our Advantages

- We preserve `code` (Node.js errno codes like `ENOENT`) and `metadata`, which are critical for filesystem error handling.

### Verdict

Our error serialization is **better for filesystem errors** (preserving `code` and `metadata`) but has a gap for unserializable return values (see Gaps section).

---

## 4. Cleanup and Disposal

### Comlink's Approach

Comlink has three cleanup mechanisms:

1. **Explicit release** via `proxy[releaseProxy]()`:
   - Sends a `RELEASE` message to the server
   - Server removes its listener, closes the endpoint, and calls optional `[finalizer]()`
   - Client marks proxy as released; further use throws `"Proxy has been released"`
   - Clears pending listeners

2. **GC-based release** via `FinalizationRegistry`:
   - Each proxy is registered with a `FinalizationRegistry`
   - Reference count tracks how many proxies share an endpoint
   - When last proxy is GC'd, endpoint is released automatically
   - Prevents leaks when callers forget to release

3. **Released proxy guard**:
   - A boolean `isProxyReleased` flag is checked in every trap
   - Throws immediately if the proxy has been released

### Our Approach

We have explicit disposal only:

```typescript
dispose() {
  port.onmessage = null;
  for (const [, entry] of pending) {
    safeDispose(() => entry.reject(new Error('Bridge proxy closed')));
  }
  pending.clear();
  safeDispose(() => port.close());
}
```

- Removes the message handler
- Rejects all pending calls
- Clears the pending map
- Closes the port

### What We're Missing

1. **No `FinalizationRegistry`**: If `dispose()` is never called (e.g., component unmount bug, exception in cleanup path), the proxy leaks indefinitely. The `safeDispose` utility mitigates some failure paths, but cannot handle the case where disposal code is never reached.

2. **No released-proxy guard**: After `dispose()`, calling methods on the proxy will attempt to `postMessage` on a closed port, throwing a browser-level error rather than a clear domain error.

3. **No server-side cleanup notification**: Our server (`createBridgeServer`) never learns that the client has disconnected. The `onmessage` handler stays attached until the port is GC'd.

### Verdict

**Gap identified**. We should add a released-proxy guard and consider `FinalizationRegistry` for defense-in-depth. Server-side cleanup notification is low priority since our server lifecycle is tied to the worker lifecycle.

---

## 5. Message Protocol

### Comlink's Approach

Comlink uses a rich protocol with multiple message types:

| Type        | Purpose                        |
| ----------- | ------------------------------ |
| `GET`       | Read a property by path        |
| `SET`       | Write a property by path       |
| `APPLY`     | Call a function with arguments |
| `CONSTRUCT` | `new` a constructor            |
| `ENDPOINT`  | Create a new dedicated channel |
| `RELEASE`   | Release resources              |

Request IDs are UUID strings (`"a1b2-c3d4-e5f6-g7h8"`).

### Our Approach

We use a simpler, flat protocol:

```typescript
type BridgeRequest = { id: number; method: string; args: unknown[] };
type BridgeResponse = { id: number; result?: unknown; error?: BridgeError };
```

- Single message type: method call with args
- Integer IDs (monotonically increasing)
- No property access, no assignment, no constructors

### Verdict

**Our approach is appropriate** for our use case. We only need RPC method calls, not property access or constructors. Integer IDs are more efficient than UUIDs and perfectly adequate for a 1:1 port connection.

---

## 6. Special Proxy Traps

### Comlink's Approach

| Trap / Property     | Handling                                                    |
| ------------------- | ----------------------------------------------------------- |
| `then`              | Non-thenable at root; bound `.then` for non-root            |
| `bind`              | Ignored; returns parent proxy                               |
| `apply`             | Sends `APPLY` message                                       |
| `construct`         | Sends `CONSTRUCT` message                                   |
| `set`               | Sends `SET` message (returns Promise, not boolean)          |
| `Symbol(...)` paths | Stringified; symbols not properly supported across boundary |

### Our Approach

| Trap / Property   | Handling                                   |
| ----------------- | ------------------------------------------ |
| `then`            | Returns `undefined`                        |
| `dispose`         | Returns the dispose function               |
| All other strings | Returns async bridge-call function         |
| Symbols           | Not handled (returns bridge-call function) |

### What We're Missing

- **`toJSON`**: `JSON.stringify(proxy)` would try to call `proxy.toJSON()` which sends a bridge message. Should return `undefined` to prevent accidental serialization attempts.
- **`Symbol.toPrimitive`**: Type coercion (`+proxy`, `${proxy}`) would send a bridge message with a symbol method name. Should return `undefined`.
- **`Symbol.toStringTag`**: `Object.prototype.toString.call(proxy)` would send a bridge message. Should return a descriptive string like `'BridgeProxy'`.
- **`Symbol.iterator`**: `for...of` on the proxy would send a bridge message. Should return `undefined`.
- **`@@asyncIterator`**: Same issue for `for await...of`.

### Verdict

**Minor gap**. The missing traps only matter if the proxy is used in contexts that trigger these checks (serialization, coercion, iteration). Adding guards for `toJSON` and common symbols would be defensive best practice.

---

## 7. Callback Support (Functions Across Boundary)

### Comlink's Approach

Comlink supports passing functions (callbacks) across the boundary via `proxy()`:

```javascript
// Marks an object for proxying instead of cloning
export function proxy(obj) {
  return Object.assign(obj, { [proxyMarker]: true });
}
```

When a `proxy()`-marked value is serialized:

1. A new `MessageChannel` is created
2. The object is `expose()`-d on one port
3. The other port is transferred to the remote side
4. The remote wraps it with `wrap()`, creating a live proxy

This enables patterns like:

```javascript
await remoteWorker.subscribe(
  Comlink.proxy((data) => {
    console.log('Got data:', data);
  }),
);
```

### Our Approach

We do not support passing functions across the boundary. Any function in `args` causes a `DataCloneError`. We exclusively use the request/response pattern.

### Verdict

**Acceptable trade-off**. Our bridge is purpose-built for filesystem operations which are all request/response. If we need event streams or callbacks, we should use separate `MessageChannel`s rather than tunneling functions. Our `createBridgePort` and `createFileSystemBridge` already support creating additional channels.

---

## 8. Endpoint Abstraction

### Comlink's Approach

Comlink abstracts over multiple environments with an `Endpoint` interface:

```typescript
interface Endpoint extends EventSource {
  postMessage(message: any, transfer?: Transferable[]): void;
  start?: () => void;
}
```

Built-in adapters: `windowEndpoint` (cross-origin iframes), `nodeEndpoint` (Node.js workers).

### Our Approach

We use `MessagePort` directly with no abstraction layer. The only endpoint adapter is `createFileSystemBridge` which creates a `MessageChannel` and transfers a port to a worker.

### Verdict

**Sufficient for now**. We only communicate between workers and the main thread via `MessagePort`. If we need cross-origin iframe communication, we could add an endpoint abstraction. The `createBridgeServer`/`createBridgeCall` functions already operate on `MessagePort` which is the most common case.

---

## 9. Clone Failure Handling

### Comlink's Approach

When `postMessage` fails (non-clonable return value), Comlink sends a proper error:

```javascript
.catch((error) => {
  const [wireValue, transferables] = toWireValue({
    value: new TypeError("Unserializable return value"),
    [throwMarker]: 0,
  });
  ep.postMessage({ ...wireValue, id }, transferables);
});
```

The caller receives a `TypeError` and can handle it appropriately.

### Our Approach

```typescript
try {
  port.postMessage(response, transferables);
} catch (postError) {
  console.error(`[BridgeServer] postMessage failed for method '${method}':`, postError);
  const cloneSafe = structuredClone({
    id,
    result: undefined,
  }) satisfies BridgeResponse;
  port.postMessage(cloneSafe);
}
```

We log the error and send `{ id, result: undefined }`. The caller gets `undefined` with no indication that something went wrong.

### Verdict

**Gap identified**. This is a silent data loss bug. We should send an error response instead of `undefined`.

---

## 10. Pending Timer Cleanup

### Comlink's Approach

Comlink uses UUID-based request IDs with no timeouts. Pending promises live until a response arrives or the proxy is released. The `FinalizationRegistry` ensures eventual cleanup.

### Our Approach

We use per-call `setTimeout` (30 seconds). On timeout, the pending entry is removed and the Promise is rejected. On disposal, all pending entries are rejected but **timeouts are not cleared** — they fire as no-ops.

### Verdict

**Minor inefficiency**. The uncancelled timers don't leak (they become no-ops) but clearing them on disposal would be cleaner. Consider storing timer IDs in the pending map entries.

---

## Summary Comparison Table

| Area                   | Comlink                         | Our Bridge                | Status       |
| ---------------------- | ------------------------------- | ------------------------- | ------------ |
| Thenable prevention    | `{ then: () => proxy }`         | `return undefined`        | Equivalent   |
| Transferables          | Explicit `transfer()`           | Auto-detect `ArrayBuffer` | Sufficient   |
| Error serialization    | `message`, `name`, `stack`      | + `code`, `metadata`      | Better       |
| Non-Error throws       | Preserved as-is                 | Stringified               | Minor gap    |
| Clone failure handling | Sends `TypeError`               | Sends `undefined`         | **Gap**      |
| Released proxy guard   | Throws on use after release     | No guard                  | **Gap**      |
| GC-based cleanup       | `FinalizationRegistry`          | Not implemented           | Minor gap    |
| Server-side cleanup    | `RELEASE` message + `finalizer` | Not implemented           | Low priority |
| Protocol richness      | GET/SET/APPLY/CONSTRUCT         | Method calls only         | Sufficient   |
| Callback support       | Via `proxy()` + MessageChannel  | Not supported             | Acceptable   |
| Special proxy traps    | `then`, `bind`                  | `then`, `dispose`         | Minor gap    |
| Symbol properties      | Stringified (broken)            | Not handled               | Minor gap    |
| Timeout mechanism      | None (relies on GC)             | 30s per call              | Better       |
| Endpoint abstraction   | Worker/MessagePort/Window/Node  | MessagePort only          | Sufficient   |
| Origin validation      | Configurable allowlist          | Not needed (MessagePort)  | N/A          |

---

## Gaps to Address

### Priority 1: Clone Failure Should Send Error

**File**: `packages/runtime/src/framework/runtime-filesystem-bridge.ts` line ~108

Currently sends `{ id, result: undefined }` when `postMessage` fails. Should send an error response so the caller knows something went wrong.

```typescript
// Current (data loss):
const cloneSafe = structuredClone({ id, result: undefined });
port.postMessage(cloneSafe);

// Fixed:
port.postMessage({
  id,
  error: {
    message: `Return value for '${method}' could not be cloned`,
    name: 'TypeError',
  },
} satisfies BridgeResponse);
```

### Priority 2: Released Proxy Guard

**File**: `packages/runtime/src/framework/runtime-filesystem-bridge.ts` `createBridgeProxy`

After `dispose()`, all method calls should throw immediately rather than attempting to use a closed port.

```typescript
let isDisposed = false;
// In dispose(): isDisposed = true;
// In get trap: if (isDisposed) throw new Error('Bridge proxy has been disposed');
```

### Priority 3: Defensive Symbol/toJSON Traps

**File**: `packages/runtime/src/framework/runtime-filesystem-bridge.ts` `createBridgeProxy`

Add guards for common non-method property accesses that shouldn't trigger bridge calls:

```typescript
if (method === 'then' || method === 'toJSON') return undefined;
if (typeof method === 'symbol') return undefined;
```

### Priority 4: Clear Timeouts on Dispose

**File**: `packages/runtime/src/framework/runtime-filesystem-bridge.ts` `createBridgeCall`

Store timer IDs alongside pending entries and clear them during disposal to avoid unnecessary timer callbacks.

### Priority 5: FinalizationRegistry (Defense-in-Depth)

Consider adding `FinalizationRegistry`-based cleanup as a fallback for cases where `dispose()` is never called. Lower priority since our XState machine lifecycle already manages disposal via `destroyWorker` exit actions.

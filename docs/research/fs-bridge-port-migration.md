---
title: 'Filesystem bridge port migration'
description: 'Unified bridge surface: FileSystemBridge (wrapped Port) for createFileSystemBridge + createBridgeProxy, BridgePort raw MessagePort for createBridgePort; opaque fromChannelFs inlines transferable wiring.'
status: active
created: '2026-05-01'
updated: '2026-05-02'
category: migration
related:
  - docs/policy/rpc-policy.md
  - docs/policy/library-api-policy.md
  - docs/research/runtime-filesystem-target-architecture.md
---

# Filesystem bridge port migration

This document captures the **`Port.onMessage`** class of failures for filesystem bridging and the architectural shape Tau uses so the error is prevented by types and naming, without a second similarly named public factory.

## Executive Summary

RPC clients (**`createBridgeProxy`**, **`createBridgeCall`**) require **`Port<unknown>`** from **`@taucad/rpc`**, typically produced by **`wrapMessagePort`** on DOM **`MessagePort`s**. Passing a bare **`MessagePort`** crashes synchronously with **`TypeError: t.onMessage is not a function`** because **`Port.onMessage`** is not **`MessagePort.addEventListener`**.

Tau exposes:

- **`createFileSystemBridge(worker)`** → **`FileSystemBridge`**: **`port`** is already wrapped (**`wrapMessagePort`**) for same-isolate clients such as **`createBridgeProxy`**.
- **`createBridgePort(handlers)`** → **`BridgePort`**: **`port`** is the raw transferable client **`MessagePort`** for **`postMessage(..., [port])`** into a callee worker (**`exposeFileSystem`** listens on the server side).

Forwarding a bridge into a kernel worker without a local proxy no longer has a second public helper: **`fromChannelFs(worker)`** uses **`channelHandleFromWorker`** in **`transport/_internal`**, which opens the same **`MessageChannel`**, posts **`filesystemBridgeConnectMessageType`**, and keeps **`dispose`** on the retained **`MessagePort`**. Transport authors rarely need that code path replicated in app code — use **`fromChannelFs`** or the transport plugin.

Naming follows **`library-api-policy` §5**: one action per **`create*`** helper, no architecture-leaking “transferable/local” duplication on the surface.

## Problem statement

**Symptom:** **`createBridgeProxy`** (or **`createBridgeCall`**) invoked with **`MessagePort`** instead of **`Port`**.

Historical root cause: a shared handle type (**`BridgeHandle`** or equivalent) blurred “local RPC client port” vs “structured-clone transfer port”. TypeScript permitted invalid composition.

Mitigation hierarchy:

1. **Types:** **`createBridgeProxy`** parameter is **`Port<unknown>`** — **`MessagePort`** is structurally incompatible.
2. **API:** **`createFileSystemBridge`** returns **`FileSystemBridge.port: Port<unknown>`** so **`createBridgeProxy(bridge.port)`** is idiomatic without manual wrap.
3. **Internal forwarding:** Raw **`MessagePort`** only appears on **`BridgePort`** and on opaque **`RuntimeFileSystemHandle`** channel arms assembled inside **`packages/runtime`**.

## Helper matrix

| Helper                               | Returned type           | `port`                                              | Typical consumer                                              |
| ------------------------------------ | ----------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| **`createFileSystemBridge(worker)`** | **`FileSystemBridge`**  | **`Port`** (wrapped)                                | **`createBridgeProxy`** / **`createBridgeCall`** same isolate |
| **`createBridgePort(handlers)`**     | **`BridgePort`**        | **`MessagePort`**                                   | **`worker.postMessage(..., [port])`**                         |
| **`fromChannelFs(worker)`** (opaque) | **`RuntimeFileSystem`** | Internal **`MessagePort`** closed over by transport | **`webWorkerTransport.client({ fileSystem })`**               |

Disconnect envelope **`{ type: 'disconnect' }`** is still **`postMessage`**-d from the owning isolate’s **`MessagePort`** inside **`dispose`**, regardless of whether the **`Port`** facade wraps it.

## Policy cross-links

- **`docs/policy/rpc-policy.md`** — Layer 3 bridge table (**`BridgePort`** / **`FileSystemBridge`**).
- **`docs/policy/library-api-policy.md`** — action-oriented naming for **`create*`** factories.

---
title: 'RPC WebSocket Best Practices & Gap Analysis'
description: 'Best practices for guaranteeing RPC WebSocket reliability in agentic coding platforms, gap analysis against Tau current implementation, and prioritized remediation plan.'
status: active
created: '2026-03-18'
updated: '2026-03-18'
category: audit
related:
  - docs/policy/rpc-policy.md
  - docs/architecture/runtime-topology.md
  - docs/policy/vision-policy.md
  - docs/research/agentic-realtime-transport.md
  - docs/research/socketio-production-resilience.md
  - docs/research/websocket-resilience.md
---

# RPC WebSocket Best Practices & Gap Analysis

Synthesized best practices for guaranteeing that server-to-client RPC "just works" in agentic coding platforms, mapped against Tau's current implementation to identify all gaps that must be closed for world-class UX during multi-hour AI-assisted CAD sessions.

## Executive Summary

Industry analysis of seven leading platforms (Cursor, Lovable, Replit, OpenAI Codex, Claude, v0, bolt.new), Socket.IO production patterns, and 32 WebSocket failure modes reveals that Tau's RPC implementation has strong foundations but critical gaps in three areas: **security** (production auth race condition, missing room authorization), **infrastructure resilience** (Fly.io shutdown config, Redis adapter choice), and **operational observability** (zero metrics). The most impactful architectural pattern from industry is the **decoupled generation model** (Lovable, v0) where LLM generation publishes to a durable intermediary and client connections are replaceable — but this applies to SSE streaming, not the Socket.IO RPC channel which has a fundamentally different request/response pattern. For Socket.IO RPC specifically, the path to "just works" is: fix the auth/authorization gaps, migrate to the Redis Streams adapter, add `emitWithAck` with retry, tune heartbeat and deployment configuration, and add observability.

## Problem Statement

WebSocket delivery failure entirely blocks Tau's chat service — the AI agent cannot execute tool calls (read files, write files, fetch geometry, take screenshots) without a working Socket.IO connection to the browser. Sessions spanning hours for complex CAD design iterations are common per the vision policy. This research synthesizes best practices from industry leaders and identifies every gap between current state and world-class reliability.

## Methodology

Four parallel research streams:

1. **Platform analysis** — Reverse-engineering and documentation review of Cursor, Lovable, Replit, OpenAI Codex, Claude, v0, bolt.new transport architectures
2. **Socket.IO production patterns** — Official docs, engineering blogs, and production postmortems for Socket.IO v4 at scale
3. **Failure mode taxonomy** — 32 WebSocket failure modes across network, browser, infrastructure, and application layers with industry case studies (Discord, Figma, Notion, Slack)
4. **Implementation audit** — Line-by-line review of Tau's RPC gateway, service, client, Redis adapter, and deployment config

Supporting research documents: `agentic-realtime-transport.md`, `socketio-production-resilience.md`, `websocket-resilience.md`.

---

## Findings

### Finding 1: Industry Transport Convergence

Every browser-based agentic platform uses **SSE for AI streaming** and reserves WebSocket for multiplayer/shell scenarios. Tau's architecture already follows this split — SSE for agent response streaming (`chat.controller.ts`), Socket.IO WebSocket for bidirectional RPC. This is architecturally sound.

| Platform | AI Streaming                 | Bidirectional Channel       | Binary Data             |
| -------- | ---------------------------- | --------------------------- | ----------------------- |
| Cursor   | gRPC/Connect (native client) | gRPC bidirectional          | Binary protobuf         |
| Lovable  | SSE                          | WebSocket (multiplayer)     | N/A                     |
| Replit   | HTTP                         | WebSocket (Goval, protobuf) | Binary protobuf         |
| v0       | SSE (Vercel AI SDK)          | N/A                         | N/A                     |
| bolt.new | SSE (Vercel AI SDK)          | N/A (local WASM)            | N/A                     |
| **Tau**  | **SSE**                      | **Socket.IO (RPC)**         | **Binary GLB (2-10MB)** |

Tau's unique requirement is **server-initiated RPC with binary responses** (GLB geometry). No other platform has this exact pattern — most platforms only stream text from server to client. This makes Socket.IO the correct transport choice for Tau's RPC channel.

### Finding 2: Critical Security Gaps

**2a. Production auth race condition (Critical)**

In production, authentication runs inside `handleConnection` (async), but `@SubscribeMessage` handlers are registered synchronously by NestJS. A client can emit `join` before `handleConnection`'s `await auth.api.getSession()` resolves, joining a chat room without authentication. Dev mode correctly uses `io.use()` middleware that blocks connection until auth succeeds.

**2b. No room-level authorization (Critical)**

`handleJoinMessage` accepts any `chatId` without verifying the authenticated user owns that chat. Any authenticated user can join any room by guessing chat IDs, then receive and respond to RPC requests intended for another user.

### Finding 3: Redis Adapter Must Change

Tau uses `@socket.io/redis-adapter` (PUB/SUB). This has two significant limitations:

1. **No Connection State Recovery** — PUB/SUB is fire-and-forget; missed packets during disconnection are lost
2. **Redis disconnection loses messages** — if Redis temporarily goes down, events published during that window are lost forever

The `@socket.io/redis-streams-adapter` handles both: it resumes streams from the last read position during Redis blips, and supports CSR for room/state restoration on reconnection.

While CSR has limited value for request/response RPC (it replays fire-and-forget events, not in-flight `emitWithAck` calls), the Redis disconnection resilience alone justifies migration.

### Finding 4: Fly.io Deployment Config is Insufficient

Current `fly.prod.toml` is missing critical configuration:

| Missing Config       | Impact                                                                   | Recommended Value                              |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| `kill_timeout`       | 5s default — active WebSocket connections get 5s to drain during deploys | `30` (seconds)                                 |
| `[checks]`           | No health checks — Fly.io can't detect WebSocket subsystem failures      | HTTP health check on `/health`                 |
| `auto_stop_machines` | `'stop'` kills active WebSocket connections during scale-down            | `'suspend'` or increase `min_machines_running` |
| VM memory            | 1GB with 50MB WebSocket buffers + LangGraph state is tight               | `2gb`                                          |
| `kill_signal`        | Default `SIGINT` — should match NestJS graceful shutdown                 | `SIGTERM`                                      |

### Finding 5: Missing `emitWithAck` Retry Pattern

The server-side `ChatRpcService.sendRpcRequest` sends an RPC via `socket.emit('rpc_request', request)` with a manual timeout. If the client disconnects and reconnects during the RPC, the original request is lost. Industry best practice is `emitWithAck` with timeout and retry:

```typescript
const response = await socket.timeout(10_000).emitWithAck('rpc_request', request);
```

Socket.IO's `emitWithAck` automatically resolves or rejects, eliminating the manual `pendingRequests` Map and timeout management. The retry loop should wait for reconnection before retrying.

### Finding 6: Client Silently Drops Unknown RPC Requests

When the client receives an RPC request for a `chatId` it has no handler for, it logs a warning and returns without responding. The server waits the full 60-second timeout. The client should send an error response immediately:

```typescript
this.sendRpcResponse({
  type: 'rpc_response',
  requestId: request.requestId,
  toolCallId: request.toolCallId,
  result: undefined,
  error: `No handler registered for chat ${chatId}`,
});
```

### Finding 7: No Observability

Zero metrics for: active WebSocket connections, RPC latency, RPC timeout rate, reconnection frequency, room occupancy, or pending request queue depth. For a production system where RPC failure blocks the entire chat, these are essential for diagnosing issues before users report them.

### Finding 8: SSE Response Missing Cache Headers

`chat.controller.ts` sets `content-type: text/event-stream` and `x-accel-buffering: no` but is missing `Cache-Control: no-cache, no-store` and `Connection: keep-alive`. Intermediate proxies (Fly.io, CDN) may buffer SSE chunks, adding latency to agent responses.

### Finding 9: `client.join()` Promise Ignored

`handleJoinMessage` calls `void client.join(chatId)`. With the Redis adapter, `join()` returns a Promise that updates Redis pub/sub state across instances. If this fails (Redis timeout), the socket is registered in `connections` but not in the Socket.IO room — RPC requests emitted to the room won't reach the client.

### Finding 10: Heartbeat Configuration Uses Defaults

Socket.IO defaults: `pingInterval: 25_000`, `pingTimeout: 60_000`. Total worst-case dead connection detection: 85 seconds. For an RPC system where the AI agent is blocked waiting for a response, reducing `pingTimeout` to `30_000` (55s total) improves detection time by 30 seconds.

Per `runtime-topology.md`, WASM execution runs in a dedicated Web Worker — the main thread (where Socket.IO lives) is never blocked. The default `pingInterval` of 25s keeps connections alive through Cloudflare's 100s idle timeout and Fly.io's thresholds. No increase needed.

### Finding 11: Decoupled Generation Pattern (Industry Best Practice, Deferred)

The most robust architecture from industry (Lovable, v0/Vercel AI SDK) separates LLM generation from client connection — the generator publishes to Redis Streams, and client connections are replaceable SSE consumers. Generation continues regardless of client state.

This pattern applies to **SSE streaming** (Tau's agent response stream), not to **Socket.IO RPC** (bidirectional request/response). For RPC, the server _needs_ the client's response — there's no "generate independently." However, the SSE stream from `chat.controller.ts` could benefit from this pattern in the future to survive page refreshes during generation.

### Finding 12: Background Tab Behavior is Safe

Per the WebSocket resilience research, browsers do **not** throttle WebSocket connections or their message handlers when tabs go to background. WebSocket I/O events fire immediately regardless of tab visibility. What is throttled is `setTimeout`/`setInterval` (affecting heartbeat timer detection).

Tau's client already implements `visibilitychange` and `online` event handlers for reconnection, which is the correct mitigation. Socket.IO ≥4.7.5 added synchronous heartbeat checks before sending messages, providing additional safety.

### Finding 13: Redis Adapter Has No Error Handling

`RedisIoAdapter.connectToRedis()` creates pub/sub clients with no error event handlers. If Redis disconnects later, the adapter silently loses cross-instance broadcast capability with no monitoring, logging, or health signal.

---

## Gap Analysis

### Best Practices vs Current State

| #   | Best Practice                                                    | Current State                                               | Gap Severity |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------- | ------------ |
| G1  | Auth via Socket.IO middleware (blocks connection until verified) | Dev: middleware ✅ / Prod: async `handleConnection` ❌      | **Critical** |
| G2  | Room-level authorization (verify user owns chatId)               | No authorization check                                      | **Critical** |
| G3  | `emitWithAck` with timeout and retry for server-to-client RPC    | Manual `emit` + `pendingRequests` Map + setTimeout          | **High**     |
| G4  | Redis Streams adapter for disconnection resilience               | PUB/SUB adapter (lossy during Redis blips)                  | **High**     |
| G5  | Deployment graceful shutdown (kill_timeout, health checks)       | 5s default, no health checks, 1GB RAM                       | **High**     |
| G6  | Observability metrics (connections, RPC latency, timeouts)       | Zero metrics                                                | **High**     |
| G7  | Await `client.join()` and handle errors                          | `void client.join()` (fire-and-forget)                      | **Medium**   |
| G8  | Reduce `pingTimeout` for faster dead connection detection        | Default 60s (85s total detection)                           | **Medium**   |
| G9  | Client responds immediately for unknown RPC requests             | Silently drops (60s server timeout)                         | **Medium**   |
| G10 | SSE `Cache-Control` headers to prevent proxy buffering           | Missing `no-cache`, `no-store`, `keep-alive`                | **Medium**   |
| G11 | Redis adapter error handling and health monitoring               | No error handlers on pub/sub clients                        | **Medium**   |
| G12 | Connection State Recovery for room restoration                   | Not enabled (requires Redis Streams adapter)                | **Low**      |
| G13 | Rate limiting on Socket.IO events                                | None                                                        | **Low**      |
| G14 | `emitWithAck` for production `join` handler                      | Returns value from `@SubscribeMessage` (NestJS auto-ack) ✅ | None         |
| G15 | `visibilitychange` / `online` reconnection handlers              | Implemented ✅                                              | None         |
| G16 | WebSocket-only transport (no polling fallback)                   | Implemented ✅                                              | None         |
| G17 | `reconnectionAttempts: Infinity` with backoff                    | Implemented ✅                                              | None         |

---

## Recommendations

| #   | Action                                                                                           | Priority | Effort | Impact                                                 |
| --- | ------------------------------------------------------------------------------------------------ | -------- | ------ | ------------------------------------------------------ |
| R1  | Move production auth to Socket.IO middleware in `afterInit` (matching dev mode pattern)          | P0       | Low    | Critical — closes auth race condition                  |
| R2  | Add chat ownership verification in `handleJoinMessage` (query DB or verify via token claims)     | P0       | Medium | Critical — prevents cross-user RPC injection           |
| R3  | Migrate from `@socket.io/redis-adapter` to `@socket.io/redis-streams-adapter`                    | P1       | Medium | High — Redis disconnection resilience + CSR support    |
| R4  | Update `fly.prod.toml`: `kill_timeout: 30`, health checks, `memory: 2gb`, `kill_signal: SIGTERM` | P1       | Low    | High — prevents data loss during deployments           |
| R5  | Refactor `sendRpcRequest` to use `emitWithAck` with timeout and retry                            | P1       | Medium | High — eliminates manual pending request management    |
| R6  | Add Prometheus metrics via `socket.io-prometheus-metrics`                                        | P1       | Low    | Medium — enables proactive monitoring                  |
| R7  | Client: send error response for unknown chat RPC requests                                        | P1       | Low    | Medium — eliminates 60s server-side timeout waste      |
| R8  | Reduce `pingTimeout` to `30_000` (55s total detection vs 85s)                                    | P2       | Low    | Medium — 30s faster dead connection detection          |
| R9  | Await `client.join()` Promise and handle errors                                                  | P2       | Low    | Medium — prevents silent room join failures            |
| R10 | Add `Cache-Control: no-cache, no-store` and `Connection: keep-alive` to SSE responses            | P2       | Low    | Low — prevents proxy buffering                         |
| R11 | Add error event handlers on Redis pub/sub clients with health signaling                          | P2       | Low    | Medium — detects Redis connectivity issues             |
| R12 | Enable Connection State Recovery after Redis Streams adapter migration                           | P2       | Low    | Medium — smoother reconnections                        |
| R13 | Evaluate decoupled generation pattern for SSE agent streaming (Redis Streams + resumable)        | P3       | High   | High — agent continues on disconnect, survives refresh |

## Trade-offs

### `emitWithAck` Refactor vs Current Manual Pattern

| Dimension            | Current (manual pending map)                 | `emitWithAck`                             |
| -------------------- | -------------------------------------------- | ----------------------------------------- |
| Code complexity      | Higher — manual Map, timeouts, cleanup       | Lower — built-in promise resolution       |
| Multi-tab support    | Custom `getConnectedSocket` picks one socket | Must target specific socket               |
| Retry on reconnect   | Not implemented                              | Natural fit (wait for reconnect, retry)   |
| Zod validation       | Applied to response in `handleRpcResponse`   | Still needed (wraps around `emitWithAck`) |
| Redis adapter compat | Room-based routing works                     | Must use `.timeout()` with adapter        |

The refactor is straightforward but touches the core RPC execution path. Comprehensive tests exist in `chat-rpc.service.test.ts` to validate the migration.

### Redis Streams Adapter Migration Risk

| Factor                    | Assessment                                                           |
| ------------------------- | -------------------------------------------------------------------- |
| API compatibility         | Drop-in replacement for most use cases                               |
| `fetchSockets()`          | Known to be slow across multiple servers (avoid in hot paths)        |
| Redis version requirement | Requires Redis 6.2+ (Streams support)                                |
| CSR interaction           | Room restoration works; in-flight RPC still requires app-level retry |
| Rollback                  | Can revert to PUB/SUB adapter with config change                     |

### Decoupled Generation: When to Pursue

The decoupled generation pattern (R13) is the most architecturally significant change. It's the pattern that makes Lovable's "generation survives page refresh" possible. For Tau, this would mean:

- Agent tool calls continue executing even if the browser disconnects
- The SSE stream can be resumed from any point via `Last-Event-ID`
- Users can close and reopen the tab without losing in-progress generation

This requires Redis Streams infrastructure (R3 is a prerequisite) and changes to `chat.controller.ts` streaming. It does not affect the Socket.IO RPC channel — RPC inherently requires a live client connection (you can't fetch geometry from a closed browser).

## References

- `docs/research/agentic-realtime-transport.md` — Platform-by-platform transport analysis
- `docs/research/socketio-production-resilience.md` — Socket.IO v4 production configuration
- `docs/research/websocket-resilience.md` — 32 failure modes and mitigation patterns
- `docs/policy/rpc-policy.md` — RPC & Filesystem Bridge Policy
- `docs/architecture/runtime-topology.md` — Kernel worker threading model
- `docs/policy/vision-policy.md` — Tau's strategic vision (multi-hour sessions, Phase 1 MCAD)

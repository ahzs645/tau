---
title: 'Socket.IO Production Resilience for RPC'
description: 'Research into Socket.IO v4 best practices for production-grade server-to-client RPC, covering connection recovery, Redis adapters, transport, heartbeats, load balancers, observability, and binary payloads.'
status: draft
created: '2026-03-18'
updated: '2026-03-18'
category: reference
related:
  - docs/policy/rpc-policy.md
---

# Socket.IO Production Resilience for RPC

Research into Socket.IO v4 configuration and architecture for a system where an AI agent on the server makes RPC calls to a browser client, and connection failure blocks the entire AI workflow.

## Executive Summary

Socket.IO v4 provides the primitives needed for reliable server-to-client RPC (`emitWithAck`, Connection State Recovery, Redis Streams adapter), but production resilience requires careful configuration across multiple layers: transport, heartbeats, load balancer timeouts, Redis adapter choice, and application-level retry/fallback. The standard Redis PUB/SUB adapter does **not** support Connection State Recovery — the Redis Streams adapter is required. For RPC patterns specifically, CSR has limited value because it recovers fire-and-forget events, not in-flight request/response pairs. Application-level timeout and retry logic around `emitWithAck` is the primary reliability mechanism.

## Table of Contents

- [1. Connection State Recovery (CSR)](#1-connection-state-recovery-csr)
- [2. Redis Adapter Selection](#2-redis-adapter-selection)
- [3. Transport Configuration](#3-transport-configuration)
- [4. Heartbeat and Keepalive](#4-heartbeat-and-keepalive)
- [5. Load Balancer and Proxy Considerations](#5-load-balancer-and-proxy-considerations)
- [6. Connection Monitoring and Observability](#6-connection-monitoring-and-observability)
- [7. Graceful Degradation](#7-graceful-degradation)
- [8. Multi-Instance Scaling](#8-multi-instance-scaling)
- [9. Binary Payload Handling](#9-binary-payload-handling)
- [10. Authentication and Session Management](#10-authentication-and-session-management)

---

## 1. Connection State Recovery (CSR)

### How It Works

CSR was introduced in Socket.IO v4.6.0 (February 2023). When enabled, the server stores the socket's `id`, rooms, and `data` attribute on unexpected disconnection. Each emitted packet includes an offset. On reconnection, the client sends its session ID and last processed offset, and the server replays missed packets.

```
Client disconnects → server stores {id, rooms, data, packets} for maxDisconnectionDuration
Client reconnects  → sends {privateSessionId, lastOffset}
Server             → replays missed packets, restores rooms
socket.recovered   → true on both sides
```

**Critical requirement**: the server must have sent at least one event to initialize the offset on the client side. Without an offset, recovery cannot be triggered even if packets were missed.

### Configuration

```typescript
const io = new Server(httpServer, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true, // skip auth middleware on recovery (already authenticated)
  },
});
```

### Adapter Compatibility

| Adapter                              | CSR Support                                                 |
| ------------------------------------ | ----------------------------------------------------------- |
| Built-in (in-memory)                 | YES                                                         |
| `@socket.io/redis-adapter` (PUB/SUB) | **NO** — PUB/SUB is fire-and-forget, cannot persist packets |
| `@socket.io/redis-streams-adapter`   | YES                                                         |
| `@socket.io/mongo-adapter` (≥0.3.0)  | YES                                                         |
| `@socket.io/postgres-adapter`        | WIP                                                         |

### CSR for RPC Patterns: Limited Value

CSR is designed for **fire-and-forget event recovery** — replaying missed `emit()` calls after reconnection. For request/response RPC (`emitWithAck`), CSR has limited applicability:

1. **In-flight RPC**: If the client disconnects while an RPC is in progress, the server-side `emitWithAck` promise rejects with a timeout error. CSR does not replay the RPC request or its response. The AI agent must retry the RPC call.
2. **Missed events**: CSR can recover one-way notifications (e.g., "render complete") sent while the client was disconnected. This has some value for keeping state synchronized, but the core RPC reliability comes from `emitWithAck` + timeout + retry.
3. **Session restoration**: CSR preserves `socket.id`, rooms, and `socket.data` across reconnections. This is useful for maintaining room membership (e.g., the client stays in its project room) without re-joining.

**Recommendation**: Enable CSR for room restoration and state synchronization benefits, but do not rely on it as the primary RPC reliability mechanism. Application-level retry logic around `emitWithAck` is required regardless.

---

## 2. Redis Adapter Selection

### `@socket.io/redis-adapter` (PUB/SUB)

The standard adapter uses Redis PUB/SUB for cross-instance message broadcast. Two Redis connections are required: one for subscribing (blocking) and one for publishing.

**Limitations:**

- **No CSR support** — PUB/SUB is fire-and-forget; messages sent while a subscriber is disconnected are lost
- **Redis disconnection loses messages** — if the Redis server temporarily goes down, any events published during that window are lost forever
- **Broadcast to all instances** — every message goes to every instance, regardless of whether that instance has relevant clients; inefficient at scale
- **`redis` npm package issues** — the standard `redis` package has known issues restoring subscriptions after reconnection; `ioredis` is recommended

**Sharded variant** (Redis 7.0+): `createShardedAdapter` uses sharded PUB/SUB for better scalability. The `subscriptionMode: 'dynamic'` option creates per-room channels to avoid broadcasting to instances without relevant subscribers.

### `@socket.io/redis-streams-adapter`

Uses Redis Streams instead of PUB/SUB. The critical difference: **handles temporary Redis disconnections without packet loss** by resuming the stream from the last read position.

**Advantages:**

- Full CSR support
- Resilient to temporary Redis disconnections
- Supports all Socket.IO features (socket management, inter-server communication, broadcast with ack, CSR)
- Compatible with Valkey (Redis fork)

**Configuration options:**

| Option          | Default     | Purpose                                     |
| --------------- | ----------- | ------------------------------------------- |
| `streamName`    | `socket.io` | Redis stream name                           |
| `streamCount`   | `1`         | Number of streams for horizontal scaling    |
| `maxLen`        | `10_000`    | Maximum stream size (approximate trimming)  |
| `readCount`     | `100`       | Elements fetched per XREAD call             |
| `blockTimeInMs` | `5_000`     | XREAD timeout                               |
| `onlyPlaintext` | `false`     | Set `true` if no binary data (optimization) |

**Known issue**: `fetchSockets()` is extremely slow when multiple servers are connected (GitHub issue #31). Avoid `fetchSockets()` in hot paths; use room-based addressing instead.

### Recommendation

| Scenario                           | Adapter                                |
| ---------------------------------- | -------------------------------------- |
| Single instance, development       | Built-in (no adapter)                  |
| Multi-instance, CSR needed         | **Redis Streams adapter**              |
| Multi-instance, no CSR, Redis 7.0+ | Sharded Redis adapter (`dynamic` mode) |
| Multi-instance, no CSR, Redis <7.0 | Standard Redis adapter with `ioredis`  |

For Tau's use case (multi-instance with RPC), **the Redis Streams adapter is recommended** for its Redis disconnection resilience, even though CSR has limited RPC value. The stream-based approach means packets are not lost during Redis blips.

**Current state**: Tau uses `@socket.io/redis-adapter` (PUB/SUB). Migration to `@socket.io/redis-streams-adapter` would improve resilience.

---

## 3. Transport Configuration

### WebSocket-Only vs Polling Fallback

Tau currently uses `transports: ['websocket']` (WebSocket-only). This is the correct choice for an RPC system.

| Factor                       | WebSocket-only                                       | Polling + WebSocket                             |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| Latency                      | Lower (no polling overhead, 40-60% reduction in RTT) | Higher initial connection                       |
| Sticky sessions              | **Not required**                                     | Required (polling sends multiple HTTP requests) |
| Load balancer config         | Simpler                                              | Must configure session affinity                 |
| Firewall/proxy compatibility | May be blocked by some corporate proxies             | Better compatibility                            |
| Connection establishment     | Single upgrade request                               | Multiple HTTP requests then upgrade             |

**Trade-off**: WebSocket-only eliminates the sticky session requirement (major operational simplification) but fails entirely if WebSocket is blocked. For a developer tool where users control their network environment, WebSocket-only is appropriate. Corporate proxy environments may need a fallback strategy (see [Section 7](#7-graceful-degradation)).

### `perMessageDeflate`

Disabled by default since Socket.IO 2.4.0 due to significant CPU and memory overhead. The compression runs per-message, which is expensive for high-frequency small messages.

**Recommendation**: Keep disabled. For large binary payloads (GLB geometry), the data is already compressed or the overhead of per-message deflate is not worth the CPU cost on the server. If bandwidth is a concern, compress at the application level before sending.

### `maxHttpBufferSize`

Controls the maximum message size before the connection is closed (DoS protection). Default: 1 MB (changed in recent versions; was 100 MB in v2).

Tau currently sets `maxHttpBufferSize: 50e6` (50 MB) to accommodate GLB geometry from the `fetchGeometry` RPC.

**Analysis of current setting:**

| Consideration   | Assessment                                                                           |
| --------------- | ------------------------------------------------------------------------------------ |
| 50 MB limit     | Appropriate for 2-10 MB GLB payloads with headroom                                   |
| DoS risk        | Moderate — a malicious client could send 50 MB payloads; mitigated by authentication |
| Memory pressure | Single 50 MB message allocates that much memory; acceptable for low-concurrency RPC  |

**Recommendation**: Keep 50 MB. Consider implementing application-level chunking for payloads >10 MB in the future (see [Section 9](#9-binary-payload-handling)).

---

## 4. Heartbeat and Keepalive

### Socket.IO Defaults (v4)

| Parameter      | Default         | Purpose                                  |
| -------------- | --------------- | ---------------------------------------- |
| `pingInterval` | 25,000 ms (25s) | How often the server sends PING          |
| `pingTimeout`  | 60,000 ms (60s) | How long to wait for PONG before closing |

The server sends a PING every `pingInterval`. If no PONG is received within `pingTimeout`, the connection is considered dead. Total worst-case detection time: `pingInterval + pingTimeout` = 85 seconds.

### The Critical Rule

**`pingInterval` must be shorter than the load balancer's idle connection timeout.** If the load balancer closes the connection before a PING is sent, the connection dies silently without Socket.IO detecting it.

### Browser Timer Throttling

When a browser tab goes to the background or the device sleeps, browsers throttle `setTimeout` timers. This affects Socket.IO's heartbeat detection:

1. The PONG response timer doesn't fire on time
2. The connection appears alive when it's actually stale
3. Messages may be sent over an expired connection before reconnection triggers

**Mitigation (Socket.IO ≥4.7.5)**: PR #5134 added a synchronous heartbeat check before sending messages. If the heartbeat has expired, the socket is closed and a new connection is created before sending. This prevents message loss but doesn't eliminate delayed disconnection detection.

**Additional mitigation**: Listen for `visibilitychange` events on the client and trigger an immediate connectivity check when the tab becomes visible:

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && socket.connected) {
    socket.volatile.emit('ping-check');
  }
});
```

### Recommended Configuration for Long-Running AI Sessions

```typescript
const io = new Server(httpServer, {
  pingInterval: 25_000, // 25s — well within Cloudflare's 100s and Fly.io's thresholds
  pingTimeout: 30_000, // 30s — reduced from 60s default for faster dead connection detection
  // Total detection time: 55s worst case
});
```

Reducing `pingTimeout` from 60s to 30s improves dead connection detection from 85s to 55s. For an RPC system where the AI agent is blocked waiting for a response, faster detection means faster retry.

---

## 5. Load Balancer and Proxy Considerations

### Timeout Matrix

| Provider                   | Idle Timeout          | Configurable?              | Notes                                                 |
| -------------------------- | --------------------- | -------------------------- | ----------------------------------------------------- |
| **Cloudflare** (client→CF) | 100s (non-Enterprise) | No                         | WebSocket connections closed after 100s of no traffic |
| **Cloudflare** (CF→origin) | 900s proxy idle       | No                         |                                                       |
| **Cloudflare** Proxy Read  | 120s                  | Enterprise only            |                                                       |
| **AWS ALB**                | 60s default           | Yes (up to 4000s)          | Set via `idle_timeout.timeout_seconds`                |
| **Fly.io**                 | ~120-300s (varies)    | No explicit control        | Relies on application-level pings                     |
| **Nginx**                  | 60s default           | Yes (`proxy_read_timeout`) |                                                       |

### Key Configuration Rules

1. **Cloudflare**: With a 100s idle timeout, Socket.IO's default `pingInterval` of 25s keeps the connection alive (ping every 25s < 100s timeout). No change needed.

2. **AWS ALB**: Default 60s timeout is tight. Either increase ALB timeout to 300s, or ensure `pingInterval` < 60s (default 25s is fine). Enable sticky sessions only if using polling transport.

3. **Fly.io**: No explicit WebSocket timeout configuration. Connections can be interrupted during deployments and by network conditions. Fly.io recommends implementing ping mechanisms and reconnection logic. The `fly.toml` must have correct `internal_port` and protocol handlers.

### Common Misconfigurations That Cause Silent Disconnections

| Misconfiguration                               | Symptom                                 | Fix                                           |
| ---------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| `pingInterval` > load balancer idle timeout    | Random disconnections with no error     | Reduce `pingInterval` below LB timeout        |
| Missing sticky sessions with polling transport | HTTP 400 "Session ID unknown"           | Use WebSocket-only OR enable sticky sessions  |
| Cloudflare "Always Use HTTPS" without WSS      | Connection refused                      | Use `wss://` on client                        |
| AWS ALB idle timeout too low (60s)             | 504 Gateway Timeout during long RPC     | Increase ALB timeout to 300s                  |
| Fly.io deployment without drain                | Active connections killed during deploy | Use rolling deployments with connection drain |

---

## 6. Connection Monitoring and Observability

### Metrics to Track

| Metric                          | Why                                    | How                                                              |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| Active connections              | Capacity planning, leak detection      | `socket.io-prometheus-metrics`: `socket_io_connected` gauge      |
| Connect/disconnect rate         | Detect connection instability          | `socket_io_connect_total`, `socket_io_disconnect_total` counters |
| Events sent/received per second | Throughput monitoring                  | `socket_io_events_sent_total`, `socket_io_events_received_total` |
| Bytes transferred               | Bandwidth monitoring, detect anomalies | `socket_io_transmit_bytes`, `socket_io_recieve_bytes`            |
| RPC latency (p50, p95, p99)     | Performance monitoring                 | Custom: measure time from `emitWithAck` call to response         |
| RPC timeout rate                | Reliability indicator                  | Custom: count `emitWithAck` timeout errors                       |
| Reconnection rate               | Network stability indicator            | Custom: count `socket.recovered` true/false on connect           |
| Error rate                      | Failure detection                      | `socket_io_errors_total`                                         |

### Zombie Connection Detection

A "zombie" connection is one that appears connected but is not responsive (client tab frozen, device asleep with throttled timers, network silently dropped).

**Detection strategies:**

1. **Heartbeat mechanism** (built-in): Socket.IO's PING/PONG detects zombies within `pingInterval + pingTimeout` (default 85s). Reduce `pingTimeout` for faster detection.

2. **Application-level liveness**: For RPC-critical connections, implement a lightweight application-level ping:

```typescript
// Server-side: periodic liveness check for active RPC sessions
const checkLiveness = async (socket: Socket) => {
  try {
    await socket.timeout(5_000).emitWithAck('liveness-check');
  } catch {
    logger.warn(`Zombie connection detected: ${socket.id}`);
    socket.disconnect(true);
  }
};
```

3. **Last activity timestamp**: Track the last successful RPC response time per socket. Alert if no activity for an unexpected duration.

### Observability Libraries

| Library                        | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `socket.io-prometheus-metrics` | Prometheus metrics for connections, events, bytes      |
| `@socket.io/admin-ui`          | Real-time web dashboard for connections, rooms, events |
| OpenTelemetry instrumentation  | Distributed tracing across RPC calls                   |

---

## 7. Graceful Degradation

### What Happens When WebSocket Fails

With `transports: ['websocket']` (Tau's current config), if WebSocket upgrade fails (blocked by proxy, firewall, corporate network), the connection fails entirely. There is no automatic fallback.

### Fallback Strategies

**Option A: Allow polling fallback (not recommended for RPC)**

```typescript
const io = new Server(httpServer, {
  transports: ['polling', 'websocket'], // polling first for reliability
});
```

Downsides: requires sticky sessions, higher latency, more complex load balancer config. For RPC, the latency penalty of polling makes it a poor choice.

**Option B: HTTP fallback for critical RPC (recommended)**

When the WebSocket connection is down and the AI agent needs to make an RPC call, fall back to an HTTP endpoint that performs the same operation:

```
Normal flow:  AI Agent → Socket.IO emitWithAck → Browser → response
Fallback:     AI Agent → HTTP POST /api/rpc → queued → Browser polls/reconnects → response
```

This requires the RPC operations to be expressible as HTTP requests that can be queued and delivered when the client reconnects. For `fetchGeometry`, this could mean:

- The AI agent queues the request
- The client reconnects and polls for pending requests
- The client responds via HTTP POST

**Option C: Client-side offline queue**

Libraries like `queued-socket.io` buffer outgoing messages when disconnected and replay them on reconnection. This is useful for client-to-server messages but does not help with server-to-client RPC (the AI agent is the caller).

### Recommendation for Tau's RPC System

The AI agent should implement a retry loop with exponential backoff:

```typescript
const callClientRpc = async (
  socket: Socket,
  event: string,
  data: unknown,
  options?: {
    maxRetries?: number;
    baseTimeout?: number;
  },
) => {
  const { maxRetries = 3, baseTimeout = 10_000 } = options ?? {};

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const timeout = baseTimeout * Math.pow(1.5, attempt);
      return await socket.timeout(timeout).emitWithAck(event, data);
    } catch (error) {
      if (attempt === maxRetries) throw error;
      // Wait for reconnection if disconnected
      if (!socket.connected) {
        await once(socket, 'connect', { timeout: 30_000 });
      }
    }
  }
};
```

If all retries fail, the AI agent should surface the error to the user: "Cannot communicate with your browser. Please refresh the page."

---

## 8. Multi-Instance Scaling

### Sticky Sessions vs Redis Adapter

| Transport           | Sticky Sessions Needed? | Why                                                        |
| ------------------- | ----------------------- | ---------------------------------------------------------- |
| WebSocket-only      | **No**                  | Single TCP connection, always hits same server             |
| Polling + WebSocket | **Yes**                 | Multiple HTTP requests in one session must hit same server |

Since Tau uses WebSocket-only transport, sticky sessions are not required for connection stability. However, with a Redis adapter, **the adapter handles cross-instance communication** — a message emitted on instance A reaches clients on instance B via Redis.

### Room-Based Routing Across Instances

When the AI agent on instance A needs to call an RPC on a client connected to instance B:

```
AI Agent (Instance A) → socket.to(socketId).timeout(5000).emitWithAck(event, data)
                       ↓
                    Redis adapter broadcasts to all instances
                       ↓
Instance B receives → delivers to client → client responds
                       ↓
                    Response flows back through Redis to Instance A
```

**Critical constraint**: `emitWithAck` with `io.to(socketId)` **requires** a `.timeout()` call. Without it, acknowledgements return empty arrays.

### Instance Failure During RPC

If the instance handling an in-flight RPC goes down:

1. The AI agent's `emitWithAck` promise is lost (process died)
2. The client's socket disconnects, triggering reconnection
3. The client reconnects to a different instance
4. The AI agent's LangGraph state should detect the interrupted tool call and retry

**Mitigation**: The AI agent framework (LangGraph) should persist tool call state. If an RPC was in-flight when the instance died, the agent resumes and retries on the new instance.

### `fetchSockets()` Performance

Avoid `fetchSockets()` across the cluster — it's known to be extremely slow with the Redis Streams adapter when multiple servers are connected. Instead:

- Use room-based addressing: `io.to(roomId).emit()`
- Store socket-to-user mappings in Redis directly
- Use `socket.data` for per-connection metadata

---

## 9. Binary Payload Handling

### Current Setup

Tau sets `maxHttpBufferSize: 50e6` (50 MB) to accommodate GLB geometry from `fetchGeometry` RPC calls. Payloads are 2-10 MB typically.

### How Socket.IO Handles Binary

Socket.IO sends binary data (Buffer, ArrayBuffer, Blob) as separate WebSocket frames: a text frame with metadata followed by one or more binary frames. Each buffer in the payload gets its own frame.

### Chunking Strategies

For 2-10 MB payloads, chunking is **not necessary**. Socket.IO handles this size well in a single message. Chunking becomes important above ~50 MB or on unreliable networks.

If chunking is needed in the future:

| Chunk Size    | Trade-off                                     |
| ------------- | --------------------------------------------- |
| 10 KB         | Very safe, but high overhead from many frames |
| 64 KB         | Good balance for unreliable networks          |
| 256 KB - 1 MB | Good for stable connections (WebSocket-only)  |

### Compression

| Strategy                      | When to Use                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `perMessageDeflate`           | Not recommended — high CPU/memory overhead                                                      |
| Application-level gzip/brotli | Before sending, if bandwidth-constrained                                                        |
| GLB is already compressed     | glTF binary format uses internal compression; additional compression yields diminishing returns |
| `msgpack` parser              | 20-50% size reduction for JSON-heavy mixed payloads, but adds complexity                        |

### Performance Optimizations

1. **Install `ws` native add-ons**: `bufferutil` and `utf-8-validate` improve WebSocket frame processing performance. Prebuilt binaries available for common platforms.

```bash
pnpm install -d bufferutil utf-8-validate
```

2. **`onlyPlaintext` optimization** (Redis Streams adapter): If a namespace only sends JSON (no binary), set `onlyPlaintext: true` to avoid binary serialization overhead in the adapter. Not applicable for `fetchGeometry` which returns binary.

3. **Discard initial HTTP request**: Free memory by clearing the reference to the initial HTTP request:

```typescript
io.engine.on('connection', (rawSocket) => {
  rawSocket.request = null;
});
```

---

## 10. Authentication and Session Management

### Token Refresh During Long-Lived Connections

Socket.IO connections for AI sessions can last 10-60+ minutes. JWT tokens typically expire in 15-60 minutes. Strategy:

**Option A: Dynamic auth callback (recommended)**

```typescript
// Client-side: auth callback fetches fresh token on every reconnection
const socket = io(url, {
  auth: (cb) => {
    const token = getAccessToken(); // reads from auth store
    cb({ token });
  },
});
```

The `auth` callback is invoked on every connection attempt (including reconnections), ensuring a fresh token is always sent.

**Option B: Mid-connection token refresh**

```typescript
// Client-side: refresh token and reconnect
socket.auth = { token: newToken };
socket.disconnect().connect();
```

This causes a brief disconnection. For RPC-critical connections, prefer Option A which handles it transparently on reconnection.

### Server-Side Auth Middleware

```typescript
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    const session = await validateToken(token);
    socket.data.userId = session.userId;
    socket.data.projectId = session.projectId;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});
```

### CSR and Authentication

When CSR is enabled with `skipMiddlewares: true`, recovered connections skip the auth middleware. This is generally safe because:

1. CSR recovery window is short (2 minutes)
2. The original connection was authenticated
3. The session ID is private and cryptographically random

If token validation on every reconnection is required (e.g., user was banned), set `skipMiddlewares: false` and ensure the auth middleware is fast.

### Re-Authentication on Reconnect

Socket.IO's reconnection logic automatically calls the `auth` callback (if provided) on each reconnection attempt. Handle auth failures in the `connect_error` handler:

```typescript
socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') {
    // Redirect to login or refresh token
    refreshAuthToken().then(() => {
      socket.connect();
    });
  }
});
```

---

## Recommendations

| #   | Action                                                                        | Priority | Effort | Impact                                                 |
| --- | ----------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------ |
| R1  | Migrate from `@socket.io/redis-adapter` to `@socket.io/redis-streams-adapter` | P1       | Medium | High — Redis disconnection resilience, CSR support     |
| R2  | Add `emitWithAck` timeout + retry wrapper for all server-to-client RPCs       | P0       | Low    | Critical — prevents AI agent from hanging indefinitely |
| R3  | Reduce `pingTimeout` from default 60s to 30s                                  | P1       | Low    | Medium — faster dead connection detection              |
| R4  | Enable Connection State Recovery for room/state restoration                   | P2       | Low    | Medium — smoother reconnections                        |
| R5  | Add Prometheus metrics (`socket.io-prometheus-metrics`)                       | P2       | Low    | Medium — observability                                 |
| R6  | Install `bufferutil` + `utf-8-validate` native add-ons                        | P2       | Low    | Low — marginal performance improvement                 |
| R7  | Implement application-level liveness check for active AI sessions             | P2       | Medium | Medium — faster zombie detection                       |
| R8  | Add `visibilitychange` handler on client for tab-wake reconnection            | P2       | Low    | Low — edge case improvement                            |
| R9  | Implement dynamic `auth` callback for token refresh on reconnect              | P1       | Low    | High — prevents auth failures on long sessions         |
| R10 | Document load balancer timeout requirements for deployment platforms          | P2       | Low    | Medium — prevents misconfiguration                     |

## References

- [Socket.IO v4 Connection State Recovery](https://socket.io/docs/v4/connection-state-recovery)
- [Socket.IO Redis Streams Adapter](https://socket.io/docs/v4/redis-streams-adapter)
- [Socket.IO Performance Tuning](https://socket.io/docs/v4/performance-tuning)
- [Socket.IO Server Options (pingTimeout, pingInterval)](https://socket.io/docs/v4/server-options/)
- [Socket.IO Using Multiple Nodes](https://socket.io/docs/v4/using-multiple-nodes)
- [Socket.IO Emitting Events (emitWithAck)](https://socket.io/docs/v4/emitting-events)
- [Socket.IO Troubleshooting Connection Issues](https://socket.io/docs/v4/troubleshooting-connection-issues)
- [Heartbeat detection delayed when timers throttled — Issue #5135](https://github.com/socketio/socket.io/issues/5135)
- [fetchSockets() slow with multiple servers — redis-streams-adapter Issue #31](https://github.com/socketio/socket.io-redis-streams-adapter/issues/31)
- [emitWithAck requires timeout for proper ack handling — Issue #4577](https://github.com/socketio/socket.io/issues/4577)
- [Cloudflare WebSocket docs](https://developers.cloudflare.com/network/websockets)
- [Cloudflare Connection Limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits)
- [Fly.io Socket.IO configuration](https://community.fly.io/t/socket-io-connection-being-canceled-on-fly-io/23416)
- [Weam: Socket.IO at Scale for AI Conversations](https://weam.ai/blog/errors/socket-io-at-scale-how-weam-handles-thousands-of-concurrent-ai-conversations/)
- [Scaling to 1M WebSocket Connections](https://arizawan.com/2025/02/how-we-scaled-1-million-websocket-connections-real-world-engineering-insights/)
- [WebSockets in Production Without Tearing Your Hair Out](https://thedanieldallas.com/thoughts/websockets-in-production)

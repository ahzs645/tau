---
title: 'WebSocket Resilience for Long-Lived Sessions'
description: 'Comprehensive taxonomy of WebSocket failure modes and resilience patterns for multi-hour Code CAD editor sessions with AI agent RPC.'
status: draft
created: '2026-03-18'
updated: '2026-03-18'
category: reference
related:
  - docs/policy/rpc-policy.md
  - docs/research/comlink-rpc-practices.md
---

# WebSocket Resilience for Long-Lived Sessions

Failure mode taxonomy and mitigation patterns for WebSocket connections spanning multi-hour Code CAD editor sessions where an AI agent communicates with the browser via Socket.IO RPC.

## Executive Summary

WebSocket connections face at least 30 distinct failure modes across network, browser, infrastructure, and application layers. The most dangerous failures are _silent_ — NAT table expiry, proxy timeouts, and background tab throttling can kill connections without triggering close events. For Tau's multi-hour CAD sessions, the critical mitigations are: dual-layer heartbeats (protocol + application), exponential backoff with jitter on reconnect, server-side session persistence with sequence-numbered event replay, and client-side offline queuing for in-flight RPC requests. Industry evidence from Discord, Figma, Slack, and Notion confirms these patterns at scale.

## Table of Contents

- [1. Network-Level Failures](#1-network-level-failures)
- [2. Browser-Level Issues](#2-browser-level-issues)
- [3. Infrastructure Failures](#3-infrastructure-failures)
- [4. Application-Level Failures](#4-application-level-failures)
- [5. Resilience Patterns from Industry](#5-resilience-patterns-from-industry)
- [6. Alternative Transports](#6-alternative-transports)
- [7. Industry Case Studies](#7-industry-case-studies)
- [Recommendations](#recommendations)
- [References](#references)

## Problem Statement

Tau's AI agent communicates with the browser via WebSocket RPC (Socket.IO) during design iterations that span hours. Current implementation uses Socket.IO with Redis adapter for horizontal scaling, raw WebSocket for Zoo kernel proxy, and `transports: ['websocket']` (no polling fallback). The connection must survive network transitions, browser background states, server deployments, and infrastructure failures without losing RPC state or user work.

## 1. Network-Level Failures

### Finding 1: TCP Connection Termination Modes

TCP connections end via three mechanisms with different observability:

| Mode        | Mechanism                           | Detection Time                   | WebSocket Close Event?   |
| ----------- | ----------------------------------- | -------------------------------- | ------------------------ |
| **FIN**     | Graceful 4-way handshake            | Immediate                        | Yes (code 1000/1001)     |
| **RST**     | Abrupt reset packet                 | Immediate                        | Yes (code 1006 abnormal) |
| **Timeout** | No packets, connection assumed dead | 2+ hours (TCP keepalive default) | No — silent death        |

The timeout case is the most dangerous for long-lived sessions. Without application-level heartbeats, a connection can appear alive for hours while actually being dead. The OS-level TCP keepalive defaults to 7200 seconds (2 hours) on Linux, and intermediate proxies often terminate before this threshold is reached.

### Finding 2: NAT Table Expiry

NAT gateways silently drop connection mappings after an idle period:

| Environment             | Idle Timeout                  | Consequence                     |
| ----------------------- | ----------------------------- | ------------------------------- |
| Home routers            | 5–30 minutes (varies wildly)  | Silent drop, RST on next packet |
| AWS NAT Gateway         | 350 seconds (~6 min)          | Silent drop                     |
| GCP Cloud NAT           | 1200 seconds (20 min) default | Configurable up to 7440s        |
| Azure NAT Gateway       | 4 minutes default             | Configurable up to 120 min      |
| Mobile carriers (4G/5G) | 30 seconds – 5 minutes        | Aggressive, varies by carrier   |
| Corporate firewalls     | 5–15 minutes typical          | Often non-configurable          |

When a NAT mapping expires, the NAT no longer recognizes the connection. The next packet from the client receives a TCP RST because the NAT has no entry. The server side sees nothing — the connection appears alive until it tries to send data and TCP eventually times out.

**Mitigation:** Application-level heartbeats at 25-second intervals (under the most aggressive NAT timeout). This keeps the NAT mapping alive by ensuring regular bidirectional traffic.

### Finding 3: DNS Changes During Long Sessions

DNS TTLs can expire and records can change during multi-hour sessions. This does not affect existing TCP connections (they use IP addresses after resolution), but it affects reconnection: the client may reconnect to a different server or fail to resolve the hostname entirely if DNS propagation is in progress.

**Mitigation:** Cache the resolved IP for reconnection attempts within a window (e.g., 5 minutes), then fall back to fresh DNS resolution. Socket.IO's reconnection logic handles this implicitly since each reconnection attempt performs fresh DNS resolution.

### Finding 4: VPN Reconnection

VPN reconnection causes a complete IP address change at the OS level. All TCP connections are torn down. WebSocket connections receive a close event (or error event if the VPN drops abruptly). IKEv2/IPSec with MOBIKE extensions and WireGuard handle IP changes more gracefully at the VPN layer, but the TCP connections above the VPN tunnel still break.

**Mitigation:** Automatic reconnection with session resume. The typical disruption window is 1–3 seconds.

### Finding 5: WiFi Roaming and Mobile Network Handoff

| Scenario                 | Behavior                                                                | Typical Disruption |
| ------------------------ | ----------------------------------------------------------------------- | ------------------ |
| WiFi → same-SSID AP      | IP may or may not change; TCP connection may survive if IP is preserved | 0–5 seconds        |
| WiFi → different network | IP changes, all TCP connections die                                     | 2–10 seconds       |
| WiFi → cellular          | Interface change, IP change, all TCP connections die                    | 3–15 seconds       |
| 4G → 5G (same carrier)   | Usually transparent at TCP level                                        | 0–2 seconds        |
| Cellular → WiFi          | Interface change, IP change                                             | 2–10 seconds       |

Standard WebSocket implementations have no mechanism for seamless network switching. The `onclose` event may not fire immediately — heartbeat monitoring is required to detect the loss promptly.

**Mitigation:** Combine `navigator.onLine`, `navigator.connection` (Network Information API), and the Page Visibility API with heartbeat miss detection to trigger fast reconnection. QUIC/HTTP3 (underlying WebTransport) supports connection migration across IP changes, but this is not yet available for WebSocket.

### Finding 6: ISP Transparent Proxy Interference

ISP-level proxies can interfere with WebSocket connections in several ways:

- **HTTP-only proxies** may not support the WebSocket upgrade handshake
- **DPI (Deep Packet Inspection)** systems may reset connections that don't match expected HTTP patterns
- **Caching proxies** may buffer or delay WebSocket frames
- **TLS interception** (MITM) may break the upgrade handshake if not configured for WebSocket

Using `wss://` (WebSocket over TLS) mitigates most ISP interference because the proxy cannot inspect or modify encrypted traffic. This is why Socket.IO's polling fallback exists — in environments where WebSocket upgrade is blocked, long-polling still works over standard HTTPS.

**Mitigation:** Always use `wss://` in production. Consider enabling Socket.IO's polling transport as a fallback for hostile network environments.

## 2. Browser-Level Issues

### Finding 7: Background Tab Throttling

Browser behavior when a tab is backgrounded varies significantly:

| Browser     | Timer Throttling                                                               | WebSocket Impact                                                                    | Tab Discard                                       |
| ----------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Chrome**  | 1s min after 10s bg; 1 min after 5 min bg ("intensive throttling", Chrome 88+) | WebSocket connections **exempt** from throttling                                    | Memory Saver discards inactive tabs (Chrome 108+) |
| **Firefox** | 1s min for inactive tabs; 15 min on Android                                    | WebSocket connections exempt; known bug where throttling persists after tab restore | Tab Unloading under memory pressure               |
| **Safari**  | Aggressive tab purging                                                         | Purged tabs lose all state including WebSocket                                      | Tab Purging removes long-inactive tabs entirely   |

The WebSocket connection itself is not throttled (tabs with active WebSocket or WebRTC connections remain unthrottled). However, JavaScript timers used for heartbeat intervals, reconnection delays, and UI updates _are_ throttled. This means:

- `setInterval` for heartbeat sending may fire only once per minute in a background tab
- Heartbeat timeout detection may be delayed by up to 60 seconds
- Reconnection backoff timers lose precision

**Mitigation:** Use Web Workers for heartbeat timing (Workers run on separate threads outside throttling constraints). Detect background state via `document.visibilityState` and adjust heartbeat expectations. When the tab returns to foreground, immediately verify connection health rather than waiting for the next heartbeat cycle.

### Finding 8: Tab Discarding and Memory Pressure

Chrome's Memory Saver mode (and similar features in other browsers) can discard background tabs to free memory. When a tab is discarded:

- No `beforeunload` or `unload` event fires
- All JavaScript state is lost, including WebSocket connections
- When the user returns, the tab reloads from scratch
- Scroll position and form data are preserved, but application state is not

A discarded tab frees up to ~450MB per 10 background tabs. Sites cannot prevent discarding, but the Page Lifecycle API provides some signals.

**Mitigation:** Persist critical application state (open files, editor cursor position, unsaved changes) to IndexedDB periodically and on `visibilitychange` events. On reload, restore state from IndexedDB and reconnect. The `document.wasDiscarded` property (Chrome 96+) indicates whether the page was discarded.

### Finding 9: Service Worker Interference

Service Workers can intercept network requests but **cannot intercept WebSocket connections**. The WebSocket handshake (`fetch` event with `Upgrade` header) is not interceptable by Service Workers. However, Service Workers can indirectly cause issues:

- A buggy Service Worker update cycle can cause page reloads
- Service Worker storage quota pressure can affect IndexedDB (shared quota)
- Background sync events can compete for network resources

**Mitigation:** No direct WebSocket mitigation needed. Ensure Service Worker lifecycle is clean and doesn't trigger unexpected page reloads.

### Finding 10: Web Worker Communication During Throttling

If WebSocket connections are managed within a Web Worker (recommended for throttling resistance), the main thread ↔ Worker `postMessage` communication is still subject to throttling in background tabs. Messages are queued but delivery timing is degraded.

**Mitigation:** Use `SharedWorker` to maintain a single WebSocket connection across multiple tabs. This reduces connection count, prevents duplicate connections, and the SharedWorker's timing is not subject to per-tab throttling. When data arrives, the SharedWorker can notify all connected tabs.

## 3. Infrastructure Failures

### Finding 11: Load Balancer Connection Draining

During rolling deployments, load balancers must drain existing connections from old instances before terminating them. WebSocket connections are long-lived and stateful, making draining more complex than stateless HTTP:

| Phase          | Action                                       | Duration                 |
| -------------- | -------------------------------------------- | ------------------------ |
| Mark unhealthy | Stop routing new connections to old instance | Immediate                |
| Drain          | Allow existing connections to complete       | Configurable (30s–3600s) |
| Force close    | Terminate remaining connections              | After drain timeout      |

For multi-hour CAD sessions, setting a drain timeout of 3600 seconds (1 hour) is impractical. Instead, the server should actively notify clients to reconnect to a healthy instance.

**Mitigation:** Implement a server-initiated "please reconnect" message (Socket.IO's `server.close()` sends disconnect events). The client reconnects with session resume. Kubernetes: use `preStop` hooks to send reconnect signals before SIGTERM, set `terminationGracePeriodSeconds` to 90–120s, and use `maxUnavailable: 0` in rolling updates.

### Finding 12: Server Rolling Deploys

During a blue-green or rolling deployment:

1. New instances start and pass health checks
2. Load balancer shifts traffic to new instances
3. Old instances receive SIGTERM
4. Old instances have `terminationGracePeriodSeconds` to drain

WebSocket connections on old instances must be gracefully migrated. A three-phase shutdown protocol is recommended: stop accepting new connections → notify existing clients with WebSocket close frame (code 1012 "Service Restart") → await drain → exit.

**Mitigation:** For Tau's NestJS API, implement `onApplicationShutdown` to broadcast a custom "reconnect" event via Socket.IO before closing. Set `kill_timeout` (Fly.io) or `terminationGracePeriodSeconds` (K8s) to at least 90 seconds to accommodate in-flight LLM responses.

### Finding 13: Redis Pub/Sub Connection Loss

The Socket.IO Redis adapter uses two Redis connections (pub and sub). The subscription client has known reconnection issues:

- Redis client v4.0.x: `subClient` enters "connect" state but never becomes "ready" after proxy-mediated disconnection
- Standard Redis Pub/Sub adapter does **not** support Socket.IO's connection state recovery feature
- When Redis crashes, room memberships are lost entirely — clients must rejoin rooms on reconnect

Tau's `RedisIoAdapter` uses `createDuplicateClient()` for pub/sub connections. If either connection drops, inter-instance message routing fails silently.

**Mitigation:** Use `ioredis` instead of `redis` for better reconnection handling. Consider the Redis Streams adapter (`@socket.io/redis-streams-adapter`) which supports connection state recovery. Implement Redis connection health monitoring with alerts. Add error listeners on both pub and sub clients with automatic reconnection.

### Finding 14: CDN/Proxy WebSocket Timeout Settings

Proxies enforce timeout settings that silently kill idle WebSocket connections:

| Proxy            | Default Timeout          | Configurable?               | Notes                                         |
| ---------------- | ------------------------ | --------------------------- | --------------------------------------------- |
| **Nginx**        | 60s `proxy_read_timeout` | Yes                         | Application-level, not TCP keepalive          |
| **Cloudflare**   | 100s inactivity          | No (without support ticket) | "Websocket handoff" available on request      |
| **HAProxy**      | `timeout tunnel`         | Yes                         | Use 1h+ for WebSocket                         |
| **AWS ALB**      | 60s idle timeout         | Yes (up to 4000s)           | Connection-level setting                      |
| **Fly.io Proxy** | Configurable             | Yes                         | Stable for public routes; 6PN mesh has issues |

Nginx's `proxy_read_timeout` is the most common source of production WebSocket disconnections. It operates at the application data level — TCP keepalive packets do not prevent Nginx from terminating the connection. The timeout resets only when application data frames are sent.

**Mitigation:** Configure `proxy_read_timeout 7d` (or higher) for WebSocket routes. Send application-level heartbeats at intervals shorter than the shortest proxy timeout in the path. For Cloudflare, heartbeats must be under 100 seconds.

### Finding 15: TLS Certificate Rotation

TLS certificate rotation does not break existing WebSocket connections (the TLS session is already established). However, connections established during the rotation window may fail if the server briefly serves a mismatched certificate. New connections after rotation use the new certificate transparently.

**Mitigation:** No action needed for existing connections. Ensure certificate rotation is atomic (symlink swap + reload, not in-place replacement). Monitor certificate expiry and rotate well before expiration.

### Finding 16: Fly.io Machine Migration

Fly.io migrates machines between physical hosts by stopping the old machine, forking its volume, and starting a new machine on the destination host. The new machine retains the same Machine ID but gets a different 6PN address. All active connections are severed during migration.

Additionally, Fly.io's 6PN private mesh network has documented instability with long-lived WebSocket connections, dropping connections every 4–36 seconds via internal WireGuard + `.internal` addresses. Connections through Fly Proxy (public HTTPS) are stable.

**Mitigation:** Use Fly Proxy (public routes) for WebSocket connections, not 6PN mesh. Implement client-side reconnection for machine migration events. Run multiple machines so migrations don't cause downtime.

## 4. Application-Level Failures

### Finding 17: Message Ordering Guarantees

WebSocket guarantees in-order delivery within a single connection (TCP provides this). However, ordering breaks across reconnections: messages sent by the server after the client disconnects are lost, and messages queued on the client during disconnection arrive in a batch after reconnection, potentially interleaving with server messages.

**Mitigation:** Assign monotonically increasing sequence numbers to all messages. On reconnection, the client sends its last-seen sequence number; the server replays missed events from that point. This is the pattern Discord uses (`s` field in gateway events) and Socket.IO v4.6+ supports natively via connection state recovery.

### Finding 18: Duplicate Message Detection

After reconnection, the server may replay messages the client already received (if the client's last-seen sequence number is slightly stale). Additionally, network retransmission at the TCP level can theoretically deliver duplicate WebSocket frames (extremely rare but possible with proxy-mediated connections).

**Mitigation:** Assign unique IDs to each message. The client maintains a set of recently processed message IDs (bounded, e.g., last 1000) and silently drops duplicates. For RPC responses specifically, the request correlation ID serves as a natural deduplication key.

### Finding 19: Idempotency Patterns for RPC

When a WebSocket connection drops during an RPC call, the client cannot know whether the server received and processed the request. Blindly retrying may cause duplicate side effects (e.g., creating a resource twice).

The WS-Kit framework defines a structured approach:

1. **Default behavior:** Pending RPC promises reject immediately with `WsDisconnectedError` on disconnect — no automatic retry of non-idempotent operations
2. **Opt-in idempotent retry:** Operations marked with `idempotencyKey` are automatically resent if reconnection occurs within a configurable window (e.g., 5 seconds)
3. **Server-side response cache:** The server caches results keyed by `(user, rpcType, idempotencyKey)` with TTL, returning cached results for duplicate requests
4. **Client-side deduplication:** Single-flight coalescing prevents double-click and race condition issues

**Relevance to Tau:** AI chat RPC operations (tool calls, code generation) should be classified:

| Operation         | Idempotent?   | Safe to retry?                               |
| ----------------- | ------------- | -------------------------------------------- |
| Render CAD model  | Yes           | Yes — same code produces same geometry       |
| Export geometry   | Yes           | Yes — deterministic                          |
| Send chat message | No            | No — would duplicate in conversation         |
| File write        | Conditionally | Yes, if content is identical (PUT semantics) |
| Tool execution    | Varies        | Depends on tool — classify per-tool          |

### Finding 20: Request/Response Correlation During Reconnection

When a WebSocket connection drops, in-flight RPC requests have no response channel. The correlation between request ID and pending Promise is lost if the client reconnects on a new socket.

**Mitigation:** Maintain a pending request map (`Map<requestId, { resolve, reject, timestamp }>`) that survives reconnection. On reconnect:

1. Reject requests older than a threshold (e.g., 30 seconds) with `TimeoutError`
2. Optionally resend idempotent requests on the new connection
3. For non-idempotent requests, reject with `DisconnectedError` and let the caller decide

### Finding 21: State Synchronization After Reconnection

After reconnection, the client and server may have divergent state. The server may have processed events during the disconnection window that the client missed.

**Mitigation strategies (increasing complexity):**

| Strategy                          | Complexity | Data Loss Risk        | Bandwidth |
| --------------------------------- | ---------- | --------------------- | --------- |
| Full state resync                 | Low        | None                  | High      |
| Event replay from sequence number | Medium     | None if within buffer | Low       |
| Delta/diff sync (CRDT-based)      | High       | None                  | Minimal   |

For Tau's use case (AI chat + CAD render state), event replay from sequence number is the best trade-off. The server maintains a bounded event buffer (e.g., last 1000 events or last 5 minutes). If the client's sequence number is within the buffer, events are replayed. If the gap is too large, fall back to full state resync.

### Finding 22: Large Payload Handling

WebSocket supports binary frames for arbitrary data. Tau uses up to 50MB payloads (`maxHttpBufferSize: 50e6`) for GLB geometry via `fetchGeometry` RPC. Large payload considerations:

- **Backpressure:** The standard WebSocket API offers no mechanism to apply backpressure to received messages. `WebSocketStream` (Chrome only) integrates streams API with backpressure, but is not cross-browser.
- **Buffer bloat:** `send()` returns non-blocking. If the sender writes faster than the network drains, the send buffer grows unboundedly. On Node.js `ws`, `send()` returns a boolean indicating buffer status; listen for `'drain'` event.
- **Memory:** Each buffered message is held in memory. A 50MB GLB queued during a slow connection consumes 50MB of server memory per client.

**Mitigation:** For large payloads, implement flow control: check `bufferedAmount` before sending, chunk large binaries into segments with reassembly on the receiver, and apply per-client rate limiting. Consider streaming large geometry via a separate HTTP endpoint (GET with `Range` headers) rather than over WebSocket.

## 5. Resilience Patterns from Industry

### Finding 23: Dual-Layer Heartbeat

Two heartbeat mechanisms serve complementary purposes:

| Layer           | Mechanism                                            | Detects                                                    | Proxy-safe?                              |
| --------------- | ---------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| **Protocol**    | WebSocket ping/pong frames (RFC 6455 opcode 0x9/0xA) | Dead TCP connections, broken pipes                         | No — some proxies strip or don't forward |
| **Application** | Regular data frames (e.g., `{ type: "ping" }`)       | Application-level hangs, proxy timeouts, semantic liveness | Yes — treated as normal data             |

**Recommended configuration:** Server sends ping every 25 seconds (under the most aggressive NAT/proxy timeout). Client must respond within 10 seconds or the server considers the connection dead. Socket.IO implements this natively via `pingInterval` (default 25000ms) and `pingTimeout` (default 20000ms).

### Finding 24: Exponential Backoff with Jitter

Reconnection delay formula:

```
delay = min(maxDelay, baseDelay * 2^attempt) * jitter
```

Where `jitter = random(0.5, 1.5)` (equal jitter) or `jitter = random(0, 1)` (full jitter).

| Parameter     | Recommended Value     | Rationale                                        |
| ------------- | --------------------- | ------------------------------------------------ |
| `baseDelay`   | 500ms                 | Fast first retry for transient glitches          |
| `maxDelay`    | 30 seconds            | Don't wait too long                              |
| `maxAttempts` | Unlimited             | Multi-hour sessions must always reconnect        |
| `jitter`      | Full (uniform random) | Lowest aggregate load on server                  |
| `resetAfter`  | 60s stable connection | Reset backoff counter after sustained connection |

**Jitter is mandatory.** Without jitter, if a server restart disconnects 10,000 clients simultaneously, they all retry at the same intervals, creating a thundering herd that can crash the recovering server.

Socket.IO implements reconnection with backoff natively (`reconnectionDelay`, `reconnectionDelayMax`, `randomizationFactor`).

### Finding 25: Circuit Breaker for WebSocket

Apply the circuit breaker pattern to prevent reconnection storms:

```
CLOSED (normal) → failure threshold exceeded → OPEN (fast-fail)
OPEN → cooldown expires → HALF-OPEN (probe)
HALF-OPEN → probe succeeds → CLOSED
HALF-OPEN → probe fails → OPEN (extended cooldown)
```

**When to trip the circuit:** After N consecutive failed reconnection attempts (e.g., 10), or when the server returns a specific "overloaded" close code. While open, the client shows a persistent "connection lost" UI and does not attempt reconnection. In half-open state, a single probe connection tests server health.

### Finding 26: Connection Quality Scoring

Track connection quality metrics to adapt behavior:

| Metric               | Measurement                       | Adaptation                               |
| -------------------- | --------------------------------- | ---------------------------------------- |
| Heartbeat RTT        | Measure ping-pong round trip      | Increase timeout if RTT > 500ms (mobile) |
| Disconnect frequency | Count disconnects per hour        | Show warning if > 3/hour                 |
| Message loss rate    | Sequence gaps detected            | Trigger full resync if > 1%              |
| Reconnection time    | Time from disconnect to reconnect | Adjust backoff parameters                |

Use P95 heartbeat RTT to set adaptive timeouts: `timeout = max(10s, 3 × P95_RTT)`. This prevents false disconnects on high-latency mobile networks while maintaining fast detection on stable connections.

### Finding 27: Client-Side Offline Queue

Buffer operations during disconnection for replay on reconnection:

```
┌──────────────────────────────────────────┐
│ Client Offline Queue                      │
├──────────────────────────────────────────┤
│ 1. User types code (editor state local)  │
│ 2. User requests render → queued         │
│ 3. User sends chat message → queued      │
│ 4. Connection restored                   │
│ 5. Replay queue in order                 │
│ 6. Server processes, responds            │
└──────────────────────────────────────────┘
```

**Queue constraints:**

- Bounded size (e.g., 100 items or 10MB) to prevent memory exhaustion
- TTL per item (e.g., 5 minutes) — stale requests should not be replayed
- Deduplication — if the user triggers the same action twice while offline, only send once
- Ordering — replay in original order

`reconnecting-websocket` supports `maxEnqueuedMessages` for this purpose. For Tau, the queue should distinguish between idempotent operations (safe to replay) and non-idempotent operations (reject with user notification).

### Finding 28: Server-Side Session Persistence

The server must maintain session state across client reconnections:

| State                      | Storage                     | TTL              |
| -------------------------- | --------------------------- | ---------------- |
| Session ID → user mapping  | Redis                       | Session lifetime |
| Event buffer (for replay)  | Redis Streams or in-memory  | 5–10 minutes     |
| Room memberships           | Redis (lost on crash) or DB | Session lifetime |
| In-flight RPC state        | In-memory (per-instance)    | 30 seconds       |
| Idempotency response cache | Redis                       | 5 minutes        |

Socket.IO's connection state recovery (`@socket.io/redis-streams-adapter`) stores session state and missed packets in Redis Streams, enabling transparent reconnection without application-level replay logic. However, this adds Redis Streams infrastructure and is limited to the configured recovery window.

## 6. Alternative Transports

### Finding 29: Transport Comparison

| Transport             | Direction                                     | Auto-Reconnect | Browser Support           | Proxy Compatibility      | Production Ready |
| --------------------- | --------------------------------------------- | -------------- | ------------------------- | ------------------------ | ---------------- |
| **WebSocket**         | Bidirectional                                 | No (manual)    | 99%+                      | Requires upgrade support | Yes              |
| **SSE**               | Server → Client only                          | Yes (native)   | 98%+                      | Standard HTTP            | Yes              |
| **WebTransport**      | Bidirectional + datagrams                     | No             | ~81% (Safari very recent) | Requires HTTP/3          | No — 2027+       |
| **gRPC-Web**          | Bidirectional (server stream only in browser) | No             | Via library               | Requires Envoy proxy     | Niche            |
| **HTTP Long-Polling** | Pseudo-bidirectional                          | Yes            | 100%                      | Universal                | Yes (fallback)   |

### Finding 30: WebTransport (HTTP/3) Assessment

WebTransport offers compelling features for Tau's use case: multiple independent streams (no head-of-line blocking), connection migration across network changes (IP mobility), and unreliable datagram mode. However:

- Server infrastructure is extremely limited compared to WebSocket
- Safari support landed very recently (Safari 26.4+)
- CDN support is experimental only
- Still in W3C Working Draft status
- Not selected for Interop 2025 focus areas

**Verdict:** Not ready for production use in 2026. Monitor for 2027+. WebSocket remains the correct choice today.

### Finding 31: SSE + HTTP POST Hybrid

For scenarios where true bidirectional communication isn't needed on every message, an SSE + HTTP POST hybrid provides advantages:

- SSE has **native auto-reconnection** with `Last-Event-ID` replay
- HTTP POST requests benefit from standard retry/timeout/middleware infrastructure
- No special proxy configuration needed (standard HTTP)
- Covers ~80% of real-time use cases that traditionally use WebSocket

**Relevance to Tau:** Not ideal. Tau's AI chat RPC is genuinely bidirectional (streaming responses, tool call results, cancel signals). However, SSE could serve as a fallback transport for the server→client direction if WebSocket fails.

### Finding 32: Polling Fallback

Socket.IO supports automatic fallback to HTTP long-polling when WebSocket upgrade fails. Tau currently disables this (`transports: ['websocket']`).

**Trade-off:**

| Aspect        | WebSocket-only                      | WebSocket + Polling fallback               |
| ------------- | ----------------------------------- | ------------------------------------------ |
| Latency       | Low (~2ms overhead)                 | Higher for polling (100ms+ per poll cycle) |
| Compatibility | Fails behind some corporate proxies | Works everywhere                           |
| Server load   | 1 connection per client             | N requests per client (polling)            |
| Complexity    | Simple                              | Socket.IO handles transparently            |

For a CAD editor with multi-hour sessions, the small subset of users behind hostile proxies may benefit from polling fallback. The performance penalty is acceptable for chat RPC (not for high-frequency geometry streaming).

**Recommendation:** Consider enabling polling as a fallback (`transports: ['websocket', 'polling']`) for the chat RPC path only. Keep WebSocket-only for Zoo kernel proxy.

## 7. Industry Case Studies

### Discord

Discord's WebSocket gateway serves millions of concurrent connections:

- **Session resume:** Clients store `session_id`, `resume_gateway_url`, and last sequence number (`s`). On reconnect, the client sends these to resume the session and replay missed events. Sequence numbers track event ordering.
- **Compression:** zlib compression reduces traffic 2-10x. Explored Zstandard (zstd) but found zlib still outperforms for their payload shapes.
- **Server-initiated reconnect:** The gateway sends a Reconnect opcode that can arrive at any time, even before the initial Hello message, to gracefully migrate clients during deploys.
- **Encoding parity:** Resume must use the same version and encoding parameters as the initial connection to avoid elevated disconnect rates.

### Figma

Figma's real-time collaboration uses LiveGraph (GraphQL subscriptions over WebSocket):

- **Optimistic local apply:** Changes apply locally before server confirmation, keeping the UI responsive on unreliable networks.
- **Postmortem evidence (April 2020):** A cascading failure in their real-time infrastructure caused service disruption. Key lesson: WebSocket-heavy architectures need circuit breakers to prevent reconnection storms from overwhelming a recovering server.

### Notion

Notion's offline support architecture is relevant for resilience:

- **Transaction model:** Local optimistic apply → server validate → sync to subscribers. This means the application remains functional during disconnection.
- **SQLite offline cache:** Evolved from a simple cache into a persistent storage layer with a "forest of offline page trees" tracking multiple reasons a page stays offline.
- **CRDT for conflict resolution:** Rich-text conflicts during offline editing are resolved via CRDT data structures.

### Slack and Netflix

Both manage millions of concurrent WebSocket connections. Key shared patterns:

- **Per-connection resource awareness:** Each WebSocket connection consumes memory and file descriptors. Horizontal scaling is more complex than stateless architectures.
- **Connection multiplexing:** Share connections across features where possible.
- **Graceful degradation:** When WebSocket infrastructure is under stress, degrade to reduced update frequency rather than disconnecting clients.

## Recommendations

| #   | Action                                                                                                                | Priority | Effort | Impact                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------------------------- |
| R1  | Implement dual heartbeat (Socket.IO `pingInterval: 25000` + application-level health check)                           | P0       | Low    | High — prevents silent connection death from NAT/proxy    |
| R2  | Add client-side offline queue for RPC requests with bounded size, TTL, and idempotency classification                 | P0       | Medium | High — prevents lost user actions during disconnection    |
| R3  | Implement sequence-numbered event replay on reconnection (Socket.IO connection state recovery or custom)              | P0       | Medium | High — prevents state divergence after reconnect          |
| R4  | Move heartbeat timer to Web Worker to survive background tab throttling                                               | P1       | Low    | Medium — prevents false disconnects in background tabs    |
| R5  | Persist editor state to IndexedDB on `visibilitychange` for tab discard survival                                      | P1       | Low    | Medium — prevents work loss on tab discard                |
| R6  | Add exponential backoff with full jitter to reconnection (Socket.IO defaults are reasonable but verify configuration) | P1       | Low    | Medium — prevents thundering herd on server recovery      |
| R7  | Implement server-side graceful shutdown: broadcast reconnect event before SIGTERM, set drain timeout to 90s+          | P1       | Medium | Medium — zero-downtime deploys                            |
| R8  | Add Redis pub/sub health monitoring and error listeners on both pub and sub clients                                   | P1       | Low    | Medium — prevents silent inter-instance routing failure   |
| R9  | Classify all RPC operations as idempotent/non-idempotent and implement appropriate retry policies                     | P2       | Medium | Medium — prevents duplicate side effects                  |
| R10 | Consider enabling polling fallback for chat RPC in hostile network environments                                       | P2       | Low    | Low — serves small user subset behind restrictive proxies |
| R11 | Evaluate `SharedWorker` for WebSocket connection management across multiple editor tabs                               | P2       | Medium | Low — reduces connection count for multi-tab users        |
| R12 | Implement connection quality scoring with adaptive timeout adjustment                                                 | P3       | Medium | Low — improves experience on mobile/unstable networks     |
| R13 | Monitor WebTransport (HTTP/3) maturity for future migration (2027+ timeline)                                          | P3       | Low    | Future — connection migration and multiplexed streams     |

## References

- [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455)
- [Socket.IO Connection State Recovery](https://socket.io/docs/v4/connection-state-recovery)
- [Socket.IO Redis Adapter](https://socket.io/docs/v4/redis-adapter)
- [Discord: How Discord Reduced WebSocket Traffic by 40%](https://discord.com/blog/how-discord-reduced-websocket-traffic-by-40-percent)
- [Discord Gateway Documentation](https://github.com/discord/discord-api-docs/blob/main/docs/topics/Gateway.md)
- [Figma Postmortem: Service Disruption April 2020](https://www.figma.com/blog/postmortem-service-disruption-april-29-2020/)
- [Figma: LiveGraph Real-Time Data Fetching](https://www.figma.com/blog/livegraph-real-time-data-fetching-at-figma/)
- [Notion: How We Made Notion Available Offline](https://www.notion.com/blog/how-we-made-notion-available-offline)
- [Chrome: Background Tabs Throttling](https://developer.chrome.com/blog/background_tabs)
- [Chrome: Memory and Energy Saver Modes](https://developer.chrome.com/blog/memory-and-energy-saver-mode/)
- [Chrome: Tab Discarding](https://developer.chrome.com/blog/tab-discarding)
- [WebSocketStream API](https://developer.chrome.com/docs/capabilities/web-apis/websocketstream)
- [Fly.io Machine Migration](https://fly.io/docs/reference/machine-migration/)
- [WS-Kit ADR-013: RPC Reconnect & Idempotency Policy](https://kriasoft.com/ws-kit/adr/013-rpc-reconnect-idempotency)
- [GCP Cloud NAT Timeout Configuration](https://oneuptime.com/blog/post/2026-02-17-how-to-configure-cloud-nat-timeout-values-for-long-lived-tcp-connections-in-gcp/view)
- [Reverse Proxy WebSocket Pitfalls](https://zylos.ai/research/2026-03-07-reverse-proxy-websocket-pitfalls-connection-leak-patterns)
- [WebTransport Browser Support](https://caniuse.com/webtransport)
- [Graceful Shutdown Patterns for Long-Lived Services](https://zylos.ai/research/2026-02-25-graceful-shutdown-long-lived-services)
- Related: `docs/policy/rpc-policy.md`
- Related: `docs/research/comlink-rpc-practices.md`

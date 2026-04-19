---
title: 'Agentic Platform Real-Time Transport Research'
description: 'Comparative analysis of how leading agentic coding platforms handle persistent connections, streaming, reconnection, and message delivery for AI agent ↔ client communication.'
status: active
created: '2026-03-18'
updated: '2026-03-18'
category: comparison
related:
  - docs/policy/rpc-policy.md
---

# Agentic Platform Real-Time Transport Research

Comparative analysis of real-time transport protocols, reconnection strategies, and delivery guarantees across seven leading agentic coding platforms — synthesized into actionable patterns for Tau's AI agent ↔ client communication layer.

## Executive Summary

Every major agentic coding platform converges on one of two transport protocols: **gRPC/Connect over HTTP/2** for native IDE clients, or **SSE over HTTP/1.1** for browser-based interfaces. WebSocket appears primarily in multiplayer/shell scenarios rather than AI streaming. The most critical gap across the industry is **reconnection and stream resumability** — most platforms (including the major CLI coding agents and OpenAI Codex) still treat disconnections as fatal. The emerging best practice is a **decoupled generation architecture** where LLM output publishes to a durable intermediary (Redis Streams) and client connections are replaceable, enabling resumable streams that survive network drops, page refreshes, and device switches.

## Table of Contents

- [Platform Analysis](#platform-analysis)
  - [Cursor](#1-cursor)
  - [Lovable](#2-lovable)
  - [Replit](#3-replit)
  - [OpenAI Codex](#4-openai-codex)
  - [Claude (Anthropic)](#5-claude-anthropic)
  - [v0 by Vercel](#6-v0-by-vercel)
  - [bolt.new (StackBlitz)](#7-boltnew-stackblitz)
- [Cross-Platform Comparison](#cross-platform-comparison)
- [Synthesized Patterns](#synthesized-patterns)
- [Recommendations](#recommendations)

## Problem Statement

Tau needs reliable real-time communication between the AI agent backend and the browser-based CAD editor. Current options include WebSocket, SSE, WebTransport, and gRPC-Web. This research investigates how production-grade agentic platforms solve the same problem — particularly for long-running agent sessions, connection recovery, and delivery guarantees.

## Methodology

Analysis based on: reverse-engineering reports (Cursor gRPC interception), official engineering blogs (Replit, Vercel), open-source codebases (bolt.new, OpenAI Codex CLI), API documentation (OpenAI, Anthropic), GitHub issue trackers (CLI coding agents, Codex), SDK source code (Vercel AI SDK), and third-party architectural analyses.

---

## Platform Analysis

### 1. Cursor

**Transport**: gRPC with Connect Protocol over HTTP/2, binary protobuf encoding.

Cursor uses ConnectRPC (a gRPC-Web variant) as its primary transport between the Electron IDE and backend inference servers. Reverse engineering reveals the protocol uses binary protobuf with an envelope format of `[type:1][len:4BE][payload]` and `Content-Type: application/connect+proto`. Key gRPC services include:

| Service                                  | Purpose                             |
| ---------------------------------------- | ----------------------------------- |
| `AiService/RunSSE`                       | AI conversation streaming channel   |
| `StreamCpp`                              | Code completion streaming           |
| `BidiService/BidiAppend`                 | Bidirectional user message exchange |
| `ChatService/StreamUnifiedChatWithTools` | Unified agent chat with tool use    |

**Streaming trick**: Cursor sets `Content-Type: text/event-stream` on binary protobuf streams. This is not true SSE — it's a technique to bypass proxy buffering (Nginx, CDNs) that would otherwise hold binary HTTP/2 responses. The content is still binary protobuf, not text SSE events.

**Context synchronization**: A "low-latency sync engine" passes encrypted context (via Merkle trees on source code embeddings) to inference servers without storing source on the backend. This runs at 1M+ TPS peak, serving billions of completions daily.

**Long-running agents**: Cursor's long-running agent preview supports sessions lasting 25-36 hours, running in isolated cloud environments via their Anyrun orchestrator service (Firecracker VMs on AWS EC2). Up to 8 parallel agents use Git worktree isolation. Tool call limit is 25 per turn, generation speed reaches ~250 tokens/second.

**Reconnection**: No public documentation on reconnection strategies. Users report issues with terminal session timeouts during long-running background commands, and a feature request exists for automatic session resumption via `.cursor/chat_id` files. The long-running agent architecture likely decouples agent execution from the IDE connection — the agent continues in the cloud regardless of IDE state.

**Gaps**: Background tab handling remains problematic (repeated terminal reads every ~3 seconds consuming cache tokens). No documented message delivery guarantees.

---

### 2. Lovable

**Transport**: SSE for AI streaming, WebSocket for multiplayer collaboration.

Lovable uses Server-Sent Events for ChatGPT-style AI response streaming to the browser. For real-time multiplayer collaboration (introduced in Lovable 2.0), the platform uses WebSocket connections for low-latency cross-user synchronization.

**Infrastructure scale**: Lovable routes 1.8+ billion tokens per minute across multiple LLM providers, using a multi-provider load balancing system with fallback chains.

**Provider affinity**: Consecutive requests for the same project are routed to the same provider to preserve prompt caching — a critical optimization that reduces costs and latency for iterative coding sessions.

**Connection recovery pattern**: Lovable's architecture follows the **decoupled generation pattern** (documented by Upstash). Three components:

1. **Stream Generator** — Independent API that generates LLM output and publishes chunks to Redis. Never connects directly to the client. Generation continues even if all clients disconnect.
2. **Stream Consumer** — A replaceable API route that reads cached chunks from Redis and delivers unseen content to the client. If the client reconnects, a new consumer picks up where the old one left off.
3. **Client** — Triggers generation but maintains only a replaceable connection. Can reconnect, switch devices, or refresh without interrupting generation.

This separation means streams survive laptop closures, network outages, page refreshes, and crashes. Clients reconnect mid-generation without losing progress.

**Reconnection**: SSE's built-in `Last-Event-ID` header enables automatic resume. The Redis-backed stream stores all chunks with monotonic IDs, so consumers can resume from any point.

---

### 3. Replit

**Transport**: WebSocket (Goval protocol, protobuf-encoded) for IDE ↔ container communication, HTTP for control plane.

Replit's real-time architecture is the most mature and well-documented of the platforms studied. The core protocol is **Goval** — a protobuf-based WebSocket protocol connecting the workspace IDE to Linux containers.

**Architecture layers**:

| Component  | Role                                                        |
| ---------- | ----------------------------------------------------------- |
| **Crosis** | Official JavaScript WebSocket client for the Goval protocol |
| **Eval**   | Reverse WebSocket proxy between clients and container VMs   |
| **Conman** | Container manager running Repls on GCE VMs                  |
| **pid1**   | In-container process manager forwarding Goval messages      |
| **Lore**   | Metadata service directing clients to the correct cluster   |

**Eval service (key innovation)**: Replit introduced Eval as a dedicated reverse WebSocket proxy, decoupling proxying from container management. Key benefits:

- **Fault isolation**: If the proxy VM dies, containers are unaffected (and vice versa)
- **Independent autoscaling**: Proxy and container VMs scale on different metrics
- **Grace period on updates**: Eval VMs wait 30+ hours for connections to drain before shutdown, preventing disruption during rollouts
- **Retry during setup**: Eval can retry failed connections to Conman during initial connection establishment
- **Reduced disconnect events**: Conman updates now cause one disconnect (target VM) instead of two (proxy + target)

**Shell2 (performance)**: Replit's shell service achieves 200× performance over its predecessor by eliminating protocol introspection and using raw byte-for-byte copying. Follows the "zero-overhead principle."

**Agent session persistence**: Replit Agent supports 200+ minute autonomous sessions via:

- **Automatic checkpoints** at key milestones, capturing: all files, database state, agent memory, conversation context, and environment configuration
- **Bidirectional checkpoint navigation** — roll back or forward through history
- **Bottomless Storage** with Copy-on-Write — instant filesystem snapshots
- **State serialization** of agent processes to Repl storage, enabling recovery even after OOM crashes (documented: agent processes were OOM-killed ~hourly during development, but state serialization prevented data loss)

**Rate limiting**: Distributed WebSocket rate limiting via Redis to track concurrent connections across servers.

**Reconnection**: The Eval architecture handles reconnection during connection setup (retry to Conman). For established connections, the checkpoint-and-restore model provides session-level recovery rather than connection-level recovery — if a connection drops, the agent's state is preserved and can be resumed.

---

### 4. OpenAI Codex

**Transport**: Two modes — HTTP SSE (Responses API streaming) and WebSocket (Responses API WebSocket mode + Realtime API).

OpenAI offers two distinct transport modes for agent communication:

**SSE Mode (standard)**: The Responses API streams via standard SSE with `stream: true`. Each response is a sequence of server-sent events (`response.created`, `response.output_item.added`, `response.output_text.delta`, `response.completed`). Used for typical request/response AI interactions.

**WebSocket Mode (agentic)**: A persistent WebSocket connection to `/v1/responses` designed for long-running, tool-call-heavy workflows. Key features:

| Feature         | Detail                                                               |
| --------------- | -------------------------------------------------------------------- |
| Continuation    | `previous_response_id` chains responses without resending context    |
| In-memory cache | Connection-local cache of most recent response for fast continuation |
| Performance     | ~40% faster end-to-end for workflows with 20+ tool calls             |
| Privacy         | Compatible with `store=false` and Zero Data Retention                |

**Realtime API**: Separate WebSocket endpoint (`wss://api.openai.com/v1/realtime`) for voice/multimodal interactions. Uses bidirectional JSON-serialized events with Bearer token auth in headers.

**Codex CLI issues (critical gaps)**: The open-source Codex CLI has documented architectural problems with WebSocket reliability:

1. **Slow client disconnection**: Bounded 128-message outbound queue causes proactive disconnection without backpressure signals
2. **Hard task termination**: WebSocket teardown uses force-abort, bypassing close frame handling
3. **Zero reconnection logic**: Any send failure breaks the realtime conversation permanently — no retry, no reconnect
4. **Improper cleanup**: Stream drops abort pump tasks without sending WebSocket close frames, causing TCP resets
5. **TOCTOU race**: Connection can close between `is_closed` check and actual send

**SDK support**: TypeScript SDK provides `client.responses.connect()` for establishing persistent WebSocket connections. Python SDK has `ResponsesWebSocketSession` for pinning runs to a WebSocket-capable provider.

---

### 5. Claude (Anthropic)

**Transport**: SSE for API streaming, HTTP for the web interface.

Claude's API uses Server-Sent Events for streaming responses. When `"stream": true` is set, the API sends incremental SSE events: `message_start`, `content_block_start`, `content_block_delta` (with text chunks), `content_block_stop`, `message_stop`. The SDKs (TypeScript, Python, etc.) provide high-level streaming methods that parse SSE automatically.

**SSE event types**: Claude defines specific event types including `ping` (keepalive), with the server expected to send heartbeat comments (`:ping`) during generation to maintain connection liveness.

**Web interface**: The Claude web app renders streaming responses in real-time. On disconnection, partial responses are typically preserved up to the last received token. However, the generation is not resumable — a new request must be made.

**CLI coding-agent reliability gaps (industry-wide)**: Production CLI coding agents that consume Anthropic's SSE API exhibit a consistent set of reliability problems documented across multiple GitHub issue trackers:

| Issue                   | Impact                                        | Frequency             |
| ----------------------- | --------------------------------------------- | --------------------- |
| No streaming timeout    | Indefinite hangs when TCP silently dies       | 2.4-15% of prompts    |
| No heartbeat monitoring | Client doesn't detect absent `:ping` comments | Every hang            |
| No reconnection logic   | ECONNRESET kills session with no retry        | Intermittent          |
| Abort/restart semantics | Cancelling re-queued prompts confuses users   | User-facing confusion |
| Remote control drops    | Mobile/remote sessions drop without recovery  | Long sessions         |

**99.36% uptime** over 90 days prior to the March 2026 global outage (which affected frontend/auth, not core API).

**What's missing**: No resume tokens, no connection-local state caching, no automatic reconnection with exponential backoff, no stream-level delivery guarantees. Generation-side progress is lost on disconnect.

---

### 6. v0 by Vercel

**Transport**: SSE via the Vercel AI SDK (`streamText`).

v0 uses Server-Sent Events through the Vercel AI SDK for all AI code generation streaming. The API endpoint (`POST https://api.v0.dev/v1/chat/completions`) follows the OpenAI Chat Completions format with SSE streaming.

**LLM Suspense (unique innovation)**: v0 manipulates the streaming output in real-time as it flows to the client:

- **Find-and-replace during streaming**: Corrects incorrect imports, fixes broken patterns
- **URL substitution**: Replaces long URLs with short tokens to reduce token overhead, then reverses on the client
- **Deterministic autofixers**: Run in parallel with generation to catch and fix errors
- **Model-driven autofixers**: Use a secondary model to validate and repair output

This achieves "double-digit improvement" in success rates compared to raw LLM output.

**Backpressure handling**: Next.js implements lazy streaming with proper backpressure — streams stop pushing data when the client can't keep up (critical for preventing memory overflow during long generations). When the browser aborts the connection, streaming stops immediately.

**Vercel AI SDK stream resumption**: The SDK's `useChat` hook supports a `resume: true` option that:

1. Stores active stream IDs per chat in a persistence layer
2. On component mount, makes a GET request to `/api/chat/[id]/stream` to reconnect
3. Uses Redis to store stream chunks and a `resumable-stream` package for pub/sub

**Critical limitation**: Stream resumption is **incompatible with abort**. Enabling `resume: true` disables `stop()` functionality — you cannot have both. Tab closure or page refresh triggers abort signals that break the resumption mechanism.

---

### 7. bolt.new (StackBlitz)

**Transport**: SSE via Vercel AI SDK for LLM streaming; WebContainer (in-browser WASM) for code execution.

bolt.new's architecture is unique because code execution happens entirely in the browser via StackBlitz WebContainers — a WebAssembly-based Node.js runtime. The LLM streaming uses SSE through the Vercel AI SDK's `streamText` function.

**Execution model**: The LLM generates atomic file operations (create, update, delete) that are streamed to the in-browser WebContainer. The WebContainer provides a complete Node.js environment (filesystem, package manager, terminal, HTTP server) with zero server-side execution. This means:

- **No execution-side connection to maintain**: Code runs locally in the browser
- **Instant boot**: No container warm-up or server provisioning
- **Offline-capable**: Once loaded, the WebContainer runs without a network connection

**AI streaming**: Uses standard Vercel AI SDK SSE patterns — `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Each chunk is `data: {JSON}\n\n`.

**Connection drop impact**: If the SSE connection drops mid-generation:

- Already-received file operations have been applied to the WebContainer
- The partial state is usable (files created so far are on the in-browser filesystem)
- Generation must be re-triggered from the user — no automatic resume
- The WebContainer state is unaffected since it's local

**Limitations**: Token overhead, finite context windows, and no persistent project memory across sessions. Not designed for multi-hour sessions.

---

## Cross-Platform Comparison

### Transport Protocol Matrix

| Platform         | AI Streaming                                   | Multiplayer/Shell           | Encoding        | Client Type       |
| ---------------- | ---------------------------------------------- | --------------------------- | --------------- | ----------------- |
| **Cursor**       | gRPC/Connect (binary protobuf over pseudo-SSE) | N/A (desktop)               | Binary protobuf | Electron (native) |
| **Lovable**      | SSE                                            | WebSocket                   | JSON            | Browser           |
| **Replit**       | HTTP (control plane)                           | WebSocket (Goval, protobuf) | Binary protobuf | Browser           |
| **OpenAI Codex** | SSE or WebSocket (mode selection)              | N/A                         | JSON            | CLI / SDK         |
| **Claude**       | SSE                                            | N/A                         | JSON            | Browser / CLI     |
| **v0**           | SSE (Vercel AI SDK)                            | N/A                         | JSON            | Browser           |
| **bolt.new**     | SSE (Vercel AI SDK)                            | N/A (local WASM)            | JSON            | Browser           |

### Reconnection Capability Matrix

| Platform         | Auto-Reconnect            | Stream Resume                    | State Recovery                    | Survives Refresh            |
| ---------------- | ------------------------- | -------------------------------- | --------------------------------- | --------------------------- |
| **Cursor**       | Unknown                   | Unknown (likely via cloud agent) | Git worktree isolation            | Long-running agents: yes    |
| **Lovable**      | Yes (SSE + Redis)         | Yes (resumable streams)          | Yes (server-side generation)      | Yes                         |
| **Replit**       | Eval retries on setup     | No (checkpoint-based)            | Yes (full checkpoint restore)     | Yes (checkpoint)            |
| **OpenAI Codex** | No (fatal disconnect)     | Partial (`previous_response_id`) | In-memory only                    | No                          |
| **Claude**       | No                        | No                               | No                                | No (partial text preserved) |
| **v0**           | Optional (`resume: true`) | Yes (Redis-backed)               | Per-chat stream storage           | Yes (but loses abort)       |
| **bolt.new**     | No                        | No                               | Local WebContainer state survives | Partial (local state OK)    |

### Long Session Support

| Platform         | Max Session                       | Background Tab                | Strategy                                   |
| ---------------- | --------------------------------- | ----------------------------- | ------------------------------------------ |
| **Cursor**       | 25-36 hours (long-running agents) | Problematic (token waste)     | Cloud-decoupled agent execution            |
| **Lovable**      | Session-bounded                   | Server continues generation   | Decoupled generation + Redis               |
| **Replit**       | 200+ minutes autonomous           | Agent runs server-side        | Checkpoints + state serialization          |
| **OpenAI Codex** | Connection-bounded                | N/A (CLI)                     | WebSocket mode with `previous_response_id` |
| **Claude**       | Connection-bounded                | Session timeout kills it      | None                                       |
| **v0**           | Request-bounded                   | Backpressure-managed          | Lazy streaming                             |
| **bolt.new**     | Session-bounded                   | WebContainer persists locally | In-browser execution                       |

---

## Synthesized Patterns

### Pattern 1: Decoupled Generation (Lovable, Upstash, v0)

The most robust architecture separates three concerns:

```
┌──────────────┐     ┌───────────────┐     ┌────────────┐
│ LLM Generator│────►│ Redis Streams │◄────│ Consumer   │
│ (independent)│     │ (durable)     │     │ (replaceable)│
└──────────────┘     └───────────────┘     └──────┬─────┘
                                                  │ SSE
                                                  ▼
                                           ┌────────────┐
                                           │ Client     │
                                           │ (reconnectable)│
                                           └────────────┘
```

The generator publishes to Redis Streams independently. The consumer is stateless and replaceable — if the client disconnects, a new consumer reads from the last acknowledged position. Generation never stops due to client issues.

**Implementation details**:

- Each token gets a monotonically-increasing Redis Stream ID
- Client tracks `lastEventId` in memory or localStorage
- On reconnect, the consumer calls `XREAD` from the last known ID
- SSE's native `Last-Event-ID` header automates this for HTTP
- A separate Redis pub/sub channel handles stop signals (the client that presses "stop" may not be the one that started the stream)

### Pattern 2: Reverse Proxy with Grace Periods (Replit)

For persistent WebSocket connections (non-SSE scenarios like shells and terminals):

```
Client ◄──► Eval (proxy, 30h+ grace) ◄──► Conman (container)
```

The proxy layer (Eval) has an extremely long grace period (30+ hours), ensuring it outlives most sessions. Container-side updates cause a single reconnection event (container restart) rather than cascading disconnections (proxy + container). The proxy handles:

- Connection retry during setup phase
- Independent autoscaling from container VMs
- Fault isolation between proxy and execution layers

### Pattern 3: Checkpoint-Based Recovery (Replit)

For long-running autonomous agents, connection-level recovery is insufficient. Instead, persist the entire execution state:

- All workspace files (Copy-on-Write snapshots)
- Database state
- Agent memory and conversation context
- Environment configuration

On any failure (network, OOM, crash), restore from the nearest checkpoint rather than trying to maintain a persistent connection. This is more robust than connection keepalive for multi-hour sessions.

### Pattern 4: gRPC/Connect for Native Clients (Cursor)

When the client is a native application (Electron/desktop), gRPC with Connect Protocol provides:

- Binary protobuf for compact encoding
- HTTP/2 multiplexing for parallel streams
- Bidirectional streaming for interactive tool use
- Strong typing via `.proto` schemas
- The `text/event-stream` Content-Type trick bypasses proxy buffering

This is unsuitable for pure browser clients (no gRPC-Web support without a proxy).

### Pattern 5: Dual-Layer Heartbeats

Best-practice heartbeat detection uses two layers:

1. **Protocol-level**: WebSocket PING/PONG (RFC 6455) or SSE `:ping` comments — detects dead TCP connections
2. **Application-level**: Regular `{"type":"ping"}` data frames — confirms application-layer responsiveness through all proxies

Recommended intervals: 30-second heartbeat with 10-second pong deadline. TCP's default 2-hour keepalive is insufficient for interactive sessions.

### Pattern 6: Idempotent At-Least-Once Delivery

Exactly-once delivery is theoretically impossible across network boundaries. Production systems converge on:

- **At-least-once delivery**: Every message eventually arrives, potentially duplicated
- **Idempotent receivers**: Deduplication via idempotency keys prevents duplicate effects
- **Ordered delivery**: Messages arrive in publish order within a stream

For AI agent actions (file writes, tool executions), idempotency is critical — a duplicate "create file" must not create two files.

---

## Recommendations

| #   | Action                                                                                                                                 | Priority | Effort | Impact                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------- |
| R1  | Adopt the decoupled generation pattern: LLM generates to Redis Streams, client connections are replaceable SSE consumers               | P0       | Medium | High — eliminates lost generations on disconnect                          |
| R2  | Use SSE for AI streaming to the browser (not WebSocket) — simpler, HTTP-native, built-in `Last-Event-ID` reconnection, CDN-friendly    | P0       | Low    | High — matches industry consensus                                         |
| R3  | Implement dual-layer heartbeats (SSE `:ping` comments + application-level health checks at 30s intervals)                              | P1       | Low    | Medium — detects dead connections within seconds                          |
| R4  | Add monotonic stream IDs to every chunk, store in Redis Streams, support resume via `Last-Event-ID` on reconnect                       | P1       | Medium | High — enables true stream resumability                                   |
| R5  | Implement exponential backoff with jitter for client-side reconnection (initial: 1s, factor: 2×, max: 60s, jitter: ±25%)               | P1       | Low    | Medium — prevents thundering herd                                         |
| R6  | Design agent execution to be connection-independent: agent runs server-side, persists state to durable storage, client is a view layer | P0       | High   | Critical — enables long-running agents, background tabs, device switching |
| R7  | Add idempotency keys to all agent actions (file writes, tool executions) for at-least-once delivery safety                             | P2       | Medium | Medium — prevents duplicate side effects                                  |
| R8  | Evaluate checkpoint-based recovery for multi-hour agent sessions (snapshot workspace + agent state at milestones)                      | P2       | High   | High — enables Replit-style session resilience                            |

## Trade-offs

### SSE vs WebSocket for AI Streaming

| Dimension       | SSE                              | WebSocket                    |
| --------------- | -------------------------------- | ---------------------------- |
| Direction       | Server → Client (unidirectional) | Bidirectional                |
| Protocol        | HTTP/1.1 (or HTTP/2)             | Custom upgrade               |
| CDN/Proxy       | Works through CDNs natively      | Requires sticky sessions     |
| Reconnection    | Built-in (`Last-Event-ID`)       | Manual implementation        |
| Browser support | `EventSource` API                | `WebSocket` API              |
| Binary data     | Text only (base64 overhead)      | Native binary frames         |
| Multiplexing    | Multiple streams via HTTP/2      | One connection = one channel |
| Complexity      | Lower                            | Higher                       |

**Verdict**: SSE is the clear winner for AI streaming (unidirectional text). WebSocket is needed only for bidirectional channels (multiplayer editing, shell I/O, real-time collaboration).

### Redis Streams vs Direct Connection

| Dimension         | Redis Streams (Decoupled) | Direct SSE (Coupled)      |
| ----------------- | ------------------------- | ------------------------- |
| Resumability      | Full (any point resume)   | None (lost on disconnect) |
| Multi-device      | Supported                 | Not supported             |
| Latency           | +1-2ms (Redis hop)        | Minimal                   |
| Complexity        | Higher (3 components)     | Lower (1 connection)      |
| Cost              | Redis infrastructure      | None                      |
| Generation safety | Continues on disconnect   | Stops on disconnect       |

**Verdict**: For a production agentic platform, the Redis-backed decoupled pattern is worth the added complexity. The latency overhead is negligible compared to LLM generation time.

## References

- [Cursor gRPC reverse engineering](https://rce.moe/2026/01/31/cursor-reverse-notes-1/) — TLS MITM interception of Cursor's Connect Protocol
- [cursor-tap](https://github.com/burpheart/cursor-tap) — Cursor traffic analysis tool
- [cursor-grpc](https://github.com/Jordan-Jarvis/cursor-grpc) — Extracted .proto files from Cursor
- [Replit Eval blog post](https://blog.replit.com/eval) — Reverse WebSocket proxy architecture
- [Replit Shell2](https://blog.replit.com/shell2) — 200× faster shell architecture
- [Replit Snapshot Engine](https://blog.replit.com/inside-replits-snapshot-engine) — Checkpoint-based state recovery
- [Replit Decision-Time Guidance](https://blog.replit.com/decision-time-guidance) — Long agent session reliability
- [OpenAI Codex WebSocket issues](https://github.com/openai/codex/issues/13949) — Fatal disconnect handling bugs
- [OpenAI Responses WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode/) — Persistent connection API
- [How v0 became an effective coding agent](https://vercel.com/blog/how-we-made-v0-an-effective-coding-agent) — LLM Suspense architecture
- [Vercel AI SDK resumable streams](https://sdk.vercel.ai/docs/ai-sdk-ui/chatbot-resume-streams) — Redis-backed stream resume
- [Resumable LLM Streams (Upstash)](https://upstash.com/blog/resumable-llm-streams) — Decoupled generation pattern
- [ai-resumable-stream](https://github.com/zirkelc/ai-resumable-stream) — TypeScript implementation
- [Lovable LLM load balancing](https://lovable.dev/blog/designing-llm-provider-load-balancing-for-agent-workflows) — Multi-provider routing
- [Lovable token routing](https://lovable.dev/blog/routing-billions-of-tokens-per-minute) — 1.8B+ tokens/min infrastructure
- [Ably resumable sessions](https://ably.com/docs/ai-transport/sessions-identity/resuming-sessions) — Resume token patterns
- [WebSocket reliability for multi-agent systems](https://zylos.ai/research/2026-02-23-websocket-reliability-multi-agent-systems) — Heartbeat and recovery patterns
- [Webhook delivery guarantees](https://zylos.ai/research/2026-02-26-webhook-reliability-delivery-guarantees) — At-least-once with idempotency

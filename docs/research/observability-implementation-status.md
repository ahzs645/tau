---
title: 'Observability Implementation Status'
description: 'Comprehensive audit of implemented observability features against the target architecture, accounting for infrastructure changes since the original design'
status: active
created: '2026-03-19'
updated: '2026-03-19'
category: audit
related:
  - docs/research/observability-architecture.md
  - docs/research/grafana-observability-gaps.md
  - docs/research/socketio-production-resilience.md
  - docs/research/rpc-best-practices.md
---

# Observability Implementation Status

Audit of Tau's observability stack against the target architecture defined in `docs/research/observability-architecture.md`, updated to reflect infrastructure changes made since that document was written — notably the migration from Redis Pub/Sub to Redis Streams, the expansion of LLM providers and CAD kernels, and the introduction of LangGraph middleware-based telemetry.

## Executive Summary

The observability stack is substantially implemented. Of 14 recommendations in the original architecture doc, 8 are fully complete, 4 are partially complete, and 2 remain unstarted. The original architecture doc is now out of date in several areas: Redis moved from Pub/Sub to Streams (invalidating `redis.pubsub.messages` metrics), the LLM provider set expanded from 4 to 7, CAD kernels grew from 5 to 7, and GenAI metrics are now recorded via LangGraph middleware rather than manual instrumentation. One metric (`sse.events`) remains unrecorded, and client-side instrumentation code for 4 new telemetry events has not been wired in the UI.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Infrastructure Changes Since Architecture Doc](#infrastructure-changes-since-architecture-doc)
- [Implementation Status: OTEL Foundation](#implementation-status-otel-foundation)
- [Implementation Status: Custom Metrics](#implementation-status-custom-metrics)
- [Implementation Status: Grafana Dashboards](#implementation-status-grafana-dashboards)
- [Implementation Status: Alerting](#implementation-status-alerting)
- [Implementation Status: Instrumentation](#implementation-status-instrumentation)
- [Implementation Status: Client Telemetry](#implementation-status-client-telemetry)
- [Architecture Doc Recommendation Scorecard](#architecture-doc-recommendation-scorecard)
- [Gaps Doc Finding Scorecard](#gaps-doc-finding-scorecard)
- [Remaining Gaps](#remaining-gaps)
- [Recommendations](#recommendations)
- [References](#references)

## Problem Statement

Two research documents define the observability target: `observability-architecture.md` (target architecture with 14 recommendations) and `grafana-observability-gaps.md` (audit with 10 findings and 13 recommendations). Since these were written, significant infrastructure changes occurred. This audit reconciles the target with reality, identifies which items are obsolete, which are complete, and what remains.

## Methodology

1. Read both source documents and extracted all recommendations and findings
2. Explored all telemetry-related source files across `packages/telemetry/`, `apps/api/app/telemetry/`, and `apps/api/app/api/`
3. Traced every metric from definition → registration → recording → dashboard visualization
4. Compared infrastructure assumptions in the architecture doc against current implementation
5. Verified dashboard configurations, alert rules, datasource provisioning, and OTEL collector pipelines

---

## Infrastructure Changes Since Architecture Doc

The original architecture doc assumed an infrastructure state that has since evolved. These changes affect which metrics and monitoring approaches are relevant.

### Finding 1: Redis migrated from Pub/Sub to Streams

| Aspect                    | Architecture Doc (Old)               | Current Implementation                         |
| ------------------------- | ------------------------------------ | ---------------------------------------------- |
| Socket.IO adapter         | `@socket.io/redis-adapter` (Pub/Sub) | `@socket.io/redis-streams-adapter`             |
| Redis operations          | PUBLISH / SUBSCRIBE                  | XADD / XREAD / XREADGROUP                      |
| Connection model          | Two clients (pub + sub)              | One client per adapter                         |
| Packet durability         | Fire-and-forget                      | Resume from last read position                 |
| Connection State Recovery | Not available                        | Enabled (2 min window)                         |
| Stream config             | N/A                                  | `streamName: 'tau:socketio'`, `maxLen: 10_000` |

**Impact on observability**: The architecture doc recommended `redis.pubsub.messages` (counter by channel/direction) and a "Redis pub/sub message rate" dashboard panel. These are now obsolete. Relevant Redis Streams metrics would instead be stream length (`XLEN`), consumer group lag, and pending entry count — but these are better queried directly via the Redis datasource plugin than custom application metrics.

**Evidence**: `apps/api/app/api/websocket/redis-io.adapter.ts` imports `createAdapter` from `@socket.io/redis-streams-adapter`. Both dev (`dev-websocket.service.ts`) and prod (`redis-io.adapter.ts`) use Streams.

### Finding 2: LLM provider set expanded

| Architecture Doc                     | Current                                                                |
| ------------------------------------ | ---------------------------------------------------------------------- |
| OpenAI, Anthropic, Vertex AI, Ollama | OpenAI, Anthropic, Vertex AI, Ollama, Together AI, Cerebras, SambaNova |

**Impact on observability**: The `gen_ai.request.model` attribute captures the model name; `gen_ai.provider.name` is used by the architecture doc but is not currently an attribute key in `packages/telemetry/src/attributes.ts`. Provider-level breakdown in dashboards depends on parsing model names or adding a provider attribute.

### Finding 3: CAD kernel set expanded

| Architecture Doc                         | Current                                                          |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Replicad, JSCAD, Manifold, OpenSCAD, KCL | Replicad, JSCAD, Manifold, OpenSCAD, KCL (Zoo), OpenCASCADE, Tau |

**Impact on observability**: Kernel metrics are client-reported with a `kernel.status` attribute. The `kernel.name` attribute recommended by the architecture doc is not in the current attribute set — kernel identity is embedded in the ingest payload but not propagated as an OTEL attribute on server-side metrics.

### Finding 4: LangGraph agent uses middleware for telemetry

The architecture doc assumed manual instrumentation around LLM calls. The current implementation uses a middleware chain on the LangGraph agent (`chat.service.ts`), which is a cleaner pattern:

| Middleware                        | Metrics Recorded                                                        |
| --------------------------------- | ----------------------------------------------------------------------- |
| `createToolMetricsMiddleware`     | `gen_ai.tool.invocations` (success/error)                               |
| `createLlmTimingMiddleware`       | `gen_ai.client.operation.duration`, `gen_ai.client.time_to_first_token` |
| `createAgentIterationsMiddleware` | `gen_ai.agent.iterations`                                               |
| `createUsageTrackingMiddleware`   | `gen_ai.client.token.usage`, `gen_ai.client.cost`                       |

### Finding 5: PostgresSaver checkpointer added

The LangGraph agent uses `PostgresSaver` from `@langchain/langgraph-checkpoint-postgres` with a dedicated `langgraph` schema. The architecture doc did not account for checkpointer metrics (save/load latency, checkpoint size). This is auto-instrumented at the `pg` driver level via `@opentelemetry/instrumentation-pg`.

### Finding 6: Dev WebSocket architecture diverged from doc

The architecture doc describes a single server topology. In development, a standalone Socket.IO server runs on `PORT+1` via `DevWebSocketService` because vite-plugin-node does not support WebSockets. Both dev and prod attempt Redis Streams adapter connection (dev falls back to in-memory).

### Finding 7: Staging environment has no observability

`fly.staging.toml` has no `[[http_service.checks]]` (no health probes), no `[metrics]` section (no Prometheus endpoint), and no OTEL configuration. Staging is effectively blind.

---

## Implementation Status: OTEL Foundation

### SDK Bootstrap

| Component                                  | Status   | Evidence                                                                                                              |
| ------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `NodeSDK` initialization                   | DONE     | `apps/api/app/telemetry/otel.ts`                                                                                      |
| Resource attributes                        | DONE     | `service.name`, `service.version`, `deployment.environment`, `cloud.provider`, `cloud.region`, `host.id`, `host.name` |
| `PrometheusExporter`                       | DONE     | Port 9464 (configurable via `OTEL_METRICS_PORT`)                                                                      |
| `OTLPTraceExporter` (conditional)          | DONE     | Active when `OTEL_EXPORTER_OTLP_ENDPOINT` is set                                                                      |
| `OTLPLogExporter` (conditional)            | DONE     | Active when OTLP endpoint is set                                                                                      |
| Auto-instrumentations                      | DONE     | fs, dns, net, fastify disabled; all others active                                                                     |
| `@fastify/otel`                            | DONE     | Registered in `main.ts`; deprecated `instrumentation-fastify` disabled                                                |
| `@opentelemetry/instrumentation-socket.io` | DONE     | Active via auto-instrumentations (not disabled)                                                                       |
| `@opentelemetry/instrumentation-pino`      | DONE     | Active via auto-instrumentations; Pino configured as NestJS logger                                                    |
| `@pyroscope/nodejs` (conditional)          | DONE     | Active when `PYROSCOPE_SERVER_ADDRESS` is set                                                                         |
| OTEL SDK loaded via `--require`            | NOT DONE | SDK imported directly in app bootstrap; may miss early module patches                                                 |
| gzip compression                           | PARTIAL  | Set in `fly.prod.toml` env (`OTEL_EXPORTER_OTLP_COMPRESSION=gzip`); not in `otel.ts` code                             |

### Structured Logging

| Component               | Status | Evidence                                                                          |
| ----------------------- | ------ | --------------------------------------------------------------------------------- |
| Pino as NestJS logger   | DONE   | `nestjs-pino` in `logger.module.ts`, `app.useLogger()` in `main.ts`               |
| Trace context injection | DONE   | `@opentelemetry/instrumentation-pino` active (auto-injects `trace_id`, `span_id`) |
| `pino-pretty` for dev   | DONE   | Configured in `logger-factory.ts`                                                 |
| Header redaction        | DONE   | Authorization and cookie headers redacted                                         |
| `LOG_LEVEL` env var     | DONE   | Configurable per environment                                                      |

### Health Endpoints

| Component                       | Status | Evidence                                       |
| ------------------------------- | ------ | ---------------------------------------------- |
| `@nestjs/terminus`              | DONE   | `apps/api/app/api/health/health.controller.ts` |
| `/health/live` (liveness)       | DONE   | Heap memory check only                         |
| `/health/ready` (readiness)     | DONE   | Redis PING + DB connectivity + heap            |
| `/health/startup` (startup)     | DONE   | Uptime check                                   |
| Fly.io config → `/health/ready` | DONE   | `fly.prod.toml`                                |

---

## Implementation Status: Custom Metrics

### Server-Side Metrics (20 defined, 19 recorded)

| Metric                   | OTEL Name                           | Type          | Recorded         | Recording Site                           |
| ------------------------ | ----------------------------------- | ------------- | ---------------- | ---------------------------------------- |
| `rpcCallDuration`        | `rpc.server.call.duration`          | histogram     | YES              | `ChatRpcService.recordRpcDuration()`     |
| `rpcActiveCalls`         | `rpc.server.active_calls`           | upDownCounter | YES              | `ChatRpcService` (+1/-1 around RPC)      |
| `wsActiveConnections`    | `ws.connections.active`             | upDownCounter | YES              | `ChatRpcGateway.bindConnectionMetrics()` |
| `wsDisconnections`       | `ws.disconnections`                 | counter       | YES              | `ChatRpcGateway.bindConnectionMetrics()` |
| `genAiTokenUsage`        | `gen_ai.client.token.usage`         | histogram     | YES              | `createUsageTrackingMiddleware`          |
| `genAiOperationDuration` | `gen_ai.client.operation.duration`  | histogram     | YES              | `createLlmTimingMiddleware`              |
| `genAiTimeToFirstToken`  | `gen_ai.client.time_to_first_token` | histogram     | YES              | `createLlmTimingMiddleware`              |
| `genAiCost`              | `gen_ai.client.cost`                | counter       | YES              | `createUsageTrackingMiddleware`          |
| `genAiToolInvocations`   | `gen_ai.tool.invocations`           | counter       | YES              | `createToolMetricsMiddleware`            |
| `genAiAgentIterations`   | `gen_ai.agent.iterations`           | histogram     | YES              | `createAgentIterationsMiddleware`        |
| `redisConnectionState`   | `redis.connection.state`            | gauge         | YES              | `RedisService` (connect/error/close)     |
| `sseActiveConnections`   | `sse.connections.active`            | upDownCounter | YES              | `ChatController` (stream start/finally)  |
| `sseEvents`              | `sse.events`                        | counter       | **NOT RECORDED** | No recording site exists                 |

### Client-Reported Metrics (7 defined, 7 have server-side recording)

| Metric                       | OTEL Name                         | Server Records | Client Sends        |
| ---------------------------- | --------------------------------- | -------------- | ------------------- |
| `kernelExecutionDuration`    | `kernel.execution.duration`       | YES            | YES                 |
| `kernelExecutions`           | `kernel.executions`               | YES            | YES                 |
| `kernelExportDuration`       | `kernel.geometry.export.duration` | YES            | YES                 |
| `wsReconnectionDuration`     | `ws.reconnection.duration`        | YES            | NO — no client code |
| `editorLoadDuration`         | `editor.load.duration`            | YES            | NO — no client code |
| `wasmModuleLoadDuration`     | `wasm.module.load.duration`       | YES            | NO — no client code |
| `indexeddbOperationDuration` | `indexeddb.operation.duration`    | YES            | NO — no client code |

### Architecture Doc Metrics Not Implemented (Assessed)

| Metric                           | Architecture Doc             | Status   | Assessment                                                                       |
| -------------------------------- | ---------------------------- | -------- | -------------------------------------------------------------------------------- |
| `ws.connections.total`           | Counter by close reason      | REPLACED | `ws.disconnections` counter with `ws.close.reason` attribute serves this purpose |
| `ws.message.size`                | Histogram of payload sizes   | NOT DONE | Useful for capacity planning but low priority                                    |
| `redis.pubsub.messages`          | Counter by channel/direction | OBSOLETE | Redis moved to Streams; no longer applicable                                     |
| `redis.connection.state`         | Gauge                        | DONE     | Implemented                                                                      |
| `kernel.geometry.vertices`       | Histogram                    | NOT DONE | Requires client-side geometry introspection                                      |
| `kernel.wasm.memory`             | Gauge                        | NOT DONE | Requires client-side WASM heap reporting                                         |
| `file.operation.duration`        | Histogram                    | NOT DONE | Client-side file ops run in IndexedDB via FS worker                              |
| `file.operation.total`           | Counter                      | NOT DONE | Same — client-side only                                                          |
| `file.operation.size`            | Histogram                    | NOT DONE | Same — client-side only                                                          |
| `db.query.duration`              | Histogram                    | AUTO     | Auto-instrumented by `@opentelemetry/instrumentation-pg`                         |
| `gen_ai.provider.name` attribute | Attribute on GenAI metrics   | NOT DONE | Only `gen_ai.request.model` is recorded; no provider dimension                   |

---

## Implementation Status: Grafana Dashboards

### Dashboard Inventory

| Dashboard       | Template Variables      | Loki Panels | Tempo Panels  | Status |
| --------------- | ----------------------- | ----------- | ------------- | ------ |
| System Overview | `$service`, `$instance` | Error Logs  | Recent Traces | DONE   |
| API Overview    | `$service`, `$instance` | Error Logs  | —             | DONE   |
| WebSocket/RPC   | `$service`, `$instance` | —           | —             | DONE   |
| AI Agent        | `$service`, `$instance` | —           | —             | DONE   |
| CAD Kernel      | `$service`, `$instance` | —           | —             | DONE   |
| Infrastructure  | `$service`, `$instance` | —           | —             | DONE   |
| SLO/Executive   | `$service`, `$instance` | —           | —             | DONE   |
| Profiling       | `$service`              | —           | —             | DONE   |

### Dashboard Features

| Feature                              | Status   | Evidence                                                                  |
| ------------------------------------ | -------- | ------------------------------------------------------------------------- |
| Template variables on all dashboards | DONE     | `$service` and `$instance` (profiling has `$service` only)                |
| Loki log panels                      | PARTIAL  | System Overview and API Overview only; other dashboards lack log panels   |
| Tempo trace panels                   | PARTIAL  | System Overview only; no trace panels on AI Agent or WebSocket dashboards |
| Error budget panels                  | DONE     | SLO/Executive has API + RPC error budget remaining (timeseries)           |
| Burn rate panels                     | DONE     | SLO/Executive has API Burn Rate 1h (stat)                                 |
| Profiling flame graphs               | DONE     | CPU + Heap via Pyroscope datasource                                       |
| Redis deep-dive dashboard            | NOT DONE | Datasource provisioned, plugin installed, no dashboard                    |
| PostgreSQL deep-dive dashboard       | NOT DONE | Datasource provisioned, plugin installed, no dashboard                    |

### Datasource Provisioning

| Datasource | Provisioned | Used in Dashboards | Plugin Installed           |
| ---------- | ----------- | ------------------ | -------------------------- |
| Prometheus | YES         | All 8 dashboards   | Built-in                   |
| Loki       | YES         | 2 dashboards       | Built-in                   |
| Tempo      | YES         | 1 dashboard        | Built-in                   |
| Pyroscope  | YES         | 1 dashboard        | Built-in                   |
| Redis      | YES         | None               | YES (`GF_INSTALL_PLUGINS`) |
| PostgreSQL | YES         | None               | YES (`GF_INSTALL_PLUGINS`) |

---

## Implementation Status: Alerting

| Alert                           | Metric                                           | Status                | Issue                                                                                                                                           |
| ------------------------------- | ------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis Connection Lost (P0)      | `redis_connection_state`                         | FUNCTIONAL            | —                                                                                                                                               |
| RPC Failure Rate (P1)           | `rpc_server_call_duration_seconds_count`         | FUNCTIONAL            | —                                                                                                                                               |
| WebSocket Disconnect Storm (P1) | `ws_disconnections_total`                        | FUNCTIONAL            | —                                                                                                                                               |
| LLM Error Rate (P1)             | `gen_ai_client_operation_duration_seconds_count` | LIKELY NON-FUNCTIONAL | `llm-timing.middleware.ts` only records duration on success; if the LLM call throws, `.record()` is never reached, so `error_type` is never set |
| High 5xx Rate (P1)              | `http_server_duration_seconds_count`             | FUNCTIONAL            | Metric names fixed to match `@fastify/otel` output                                                                                              |

---

## Implementation Status: Instrumentation

### `@Span()` Decorator Usage

| Service                    | Method                                                  | Status                                                |
| -------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `CodeCompletionService`    | `complete()`                                            | DONE                                                  |
| `FileEditService`          | `applyFileEdit()`                                       | DONE                                                  |
| `PrivacyService`           | `getPrivacyPreferences()`, `updatePrivacyPreferences()` | DONE                                                  |
| `KernelsGateway`           | `handleZooProxy()`                                      | DONE                                                  |
| `ModelService`             | `buildModel()`                                          | DONE                                                  |
| `AuthModule` / Better Auth | —                                                       | NOT DONE                                              |
| `CheckpointerService`      | —                                                       | NOT DONE (auto-instrumented via `instrumentation-pg`) |
| `ChatService`              | —                                                       | NOT DONE (covered by middleware)                      |

### `TracerService` Usage

| Feature                  | Status                 | Evidence                                                         |
| ------------------------ | ---------------------- | ---------------------------------------------------------------- |
| `@Span()` decorator      | DONE (5 services)      | Method-level spans on 6 methods                                  |
| `withSpan()`             | NOT USED IN PRODUCTION | Only in tests                                                    |
| `injectTraceContext()`   | DONE                   | Injects W3C trace context into Socket.IO RPC payloads            |
| `withExtractedContext()` | NOT USED IN PRODUCTION | Only in tests; no server-side extraction of client trace context |

### W3C Trace Context Propagation

| Direction                 | Status                                                                       |
| ------------------------- | ---------------------------------------------------------------------------- |
| Server → Client (inject)  | DONE — `ChatRpcService` injects `traceparent` into RPC payloads              |
| Client → Server (extract) | NOT DONE — `withExtractedContext()` exists but is never called in production |

---

## Implementation Status: Client Telemetry

### Ingest Schema

| Entry Name               | Server Schema | Server Recording | Client Instrumentation |
| ------------------------ | ------------- | ---------------- | ---------------------- |
| `KERNEL_CREATE_GEOMETRY` | DONE          | DONE             | DONE (existing)        |
| `KERNEL_EXPORT_GEOMETRY` | DONE          | DONE             | DONE (existing)        |
| `WEBSOCKET_RECONNECTION` | DONE          | DONE             | NOT DONE               |
| `EDITOR_LOAD`            | DONE          | DONE             | NOT DONE               |
| `WASM_MODULE_LOAD`       | DONE          | DONE             | NOT DONE               |
| `INDEXEDDB_OPERATION`    | DONE          | DONE             | NOT DONE               |

The server-side pipeline (schema → validation → metric recording) is complete for all 6 event types. However, 4 of the 6 have no client-side code in `apps/ui/` sending events to `POST /v1/telemetry/ingest`.

---

## Architecture Doc Recommendation Scorecard

| #   | Recommendation                      | Status     | Notes                                                                                    |
| --- | ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| R1  | Grafana Cloud / OTLP endpoint       | DONE       | Local dev via `grafana/otel-lgtm`; prod via Fly.io env vars                              |
| R2  | OTEL SDK + auto-instrumentations    | DONE       | `otel.ts` with `NodeSDK`, auto-instrumentations, conditional exporters                   |
| R3  | Pino structured logging             | DONE       | `nestjs-pino`, `@opentelemetry/instrumentation-pino`, `pino-pretty`                      |
| R4  | Custom metrics catalog              | PARTIAL    | 19/20 recorded; `sse.events` unrecorded; file/vertex/WASM-memory metrics not implemented |
| R5  | RED-method dashboards per component | DONE       | 8 dashboards covering all major components                                               |
| R6  | Grafana Alerting rules              | PARTIAL    | 5 alerts; LLM error rate alert likely non-functional                                     |
| R7  | Fly.io Prometheus federation        | NOT DONE   | No built-in machine metrics (CPU, memory, network)                                       |
| R8  | GenAI token/cost metrics            | DONE       | Via `createUsageTrackingMiddleware`                                                      |
| R9  | Tail sampling (gateway collector)   | NOT NEEDED | P3 — not yet at scale requiring this                                                     |
| R10 | Socket.IO OTEL instrumentation      | DONE       | Via auto-instrumentations                                                                |
| R11 | `@nestjs/terminus` health probes    | DONE       | Liveness/readiness/startup with Redis + DB checks                                        |
| R12 | `@fastify/otel`                     | DONE       | Registered in `main.ts`; deprecated instrumentation disabled                             |
| R13 | W3C trace context in Socket.IO      | PARTIAL    | Injection done; extraction not used in production                                        |
| R14 | `TracerService` + `@Span()`         | PARTIAL    | Module exists; `@Span()` on 5 services; `withSpan()` unused in prod                      |

---

## Gaps Doc Finding Scorecard

| #   | Finding                             | Status             | Notes                                                                                                                                        |
| --- | ----------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 5 metrics not recorded              | RESOLVED (4/5)     | `genAiOperationDuration`, `genAiTimeToFirstToken`, `genAiAgentIterations`, `sseActiveConnections` now recorded; `sseEvents` still unrecorded |
| F2  | Dashboard coverage gaps             | MOSTLY RESOLVED    | All major components have dashboards; Redis/PostgreSQL deep-dive dashboards still missing                                                    |
| F3  | Alert metric name mismatches        | RESOLVED           | Fixed to match `@fastify/otel` output                                                                                                        |
| F4  | Uninstrumented services             | MOSTLY RESOLVED    | 5 services now have `@Span()`; Auth module still uninstrumented                                                                              |
| F5  | Unused datasources (Loki, Tempo)    | MOSTLY RESOLVED    | Both used in dashboards; Redis and PostgreSQL datasources still unused                                                                       |
| F6  | No template variables               | RESOLVED           | All dashboards have `$service` and `$instance`                                                                                               |
| F7  | Missing trace correlation           | PARTIALLY RESOLVED | Tempo trace panel exists in System Overview; no exemplar configuration on histograms                                                         |
| F8  | No continuous profiling             | RESOLVED           | `@pyroscope/nodejs` installed, datasource provisioned, profiling dashboard created                                                           |
| F9  | No SLO error budget tracking        | PARTIALLY RESOLVED | Manual error budget panels via PromQL; Grafana SLO App not installed                                                                         |
| F10 | Client-side observability blindspot | PARTIALLY RESOLVED | Schema + server recording done for 4 new events; no client-side instrumentation code                                                         |

---

## Remaining Gaps

### Priority 1 — Should Fix

| #   | Gap                                                         | Impact                                                                             | Effort                                                                                                  |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| G1  | `sse.events` metric never recorded                          | SSE event rate dashboard panel shows no data                                       | Low — add `.add(1)` calls in `ChatController` and SSE stream transforms                                 |
| G2  | LLM error rate alert non-functional                         | Failed LLM calls are invisible to alerting                                         | Low — record `genAiOperationDuration` with `error_type` attribute in `llm-timing.middleware` catch path |
| G3  | Client-side instrumentation for 4 new event types not wired | WebSocket reconnection, editor load, WASM load, and IndexedDB metrics show no data | Medium — instrument sites in `apps/ui/` to POST to `/v1/telemetry/ingest`                               |
| G4  | Staging environment has no observability                    | Staging failures are invisible                                                     | Low — add health checks and metrics port to `fly.staging.toml`                                          |

### Priority 2 — Should Build

| #   | Gap                                           | Impact                                                                                                                        | Effort                                                                      |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| G5  | Redis deep-dive dashboard                     | Stream length, consumer lag, memory, slow log, client list not visible despite datasource being provisioned                   | Medium — build dashboard using Redis datasource                             |
| G6  | PostgreSQL deep-dive dashboard                | `pg_stat_statements` slow query analysis, connection pool stats, table sizes not visible despite datasource being provisioned | Medium — build dashboard using PostgreSQL datasource                        |
| G7  | `gen_ai.provider.name` attribute not recorded | Cannot break down AI metrics by provider (only by model name)                                                                 | Low — add `GEN_AI_PROVIDER_NAME` to attribute keys and record in middleware |
| G8  | Histogram exemplar configuration              | Cannot click from a metric spike directly to a correlated trace                                                               | Medium — configure exemplars on PrometheusExporter                          |

### Priority 3 — Future

| #   | Gap                                             | Impact                                                                                              | Effort                                                                           |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| G9  | Grafana SLO App not installed                   | Error budgets are manual PromQL; no auto-generated recording rules or multi-window burn-rate alerts | Low-Medium — install app, define SLOs                                            |
| G10 | W3C trace context extraction unused             | Client→server trace continuity broken; traces are one-way (server→client only)                      | Low — call `withExtractedContext()` in gateway when client returns RPC responses |
| G11 | `TracerService.withSpan()` unused in production | Manual spans around complex business logic not utilized                                             | Low per site — add to critical code paths as needed                              |
| G12 | Fly.io Prometheus federation                    | No built-in machine metrics (CPU, memory, network from Fly.io)                                      | Medium — configure federation scraping                                           |
| G13 | File operation metrics not in registry          | No visibility into FS read/write/delete latency                                                     | Medium — requires client-side IndexedDB/FS worker instrumentation                |
| G14 | OTEL SDK loaded via import, not `--require`     | Auto-instrumentations may miss modules loaded before SDK init                                       | Low — change to `NODE_OPTIONS="--require"` in production                         |
| G15 | Grafana Faro (client-side RUM)                  | No Web Vitals, JS error tracking, or real user monitoring                                           | High — full SDK integration into React app                                       |

---

## Recommendations

| #   | Action                                                                                                                                           | Priority | Effort | Impact | Addresses   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------ | ----------- |
| R1  | Record `sse.events` metric in `ChatController` SSE stream                                                                                        | P1       | Low    | Medium | G1          |
| R2  | Fix LLM error rate alert by recording `genAiOperationDuration` with `error_type` on failure                                                      | P1       | Low    | High   | G2          |
| R3  | Wire client-side instrumentation for 4 new telemetry events in `apps/ui/`                                                                        | P1       | Medium | High   | G3          |
| R4  | Add health checks and metrics port to `fly.staging.toml`                                                                                         | P1       | Low    | Medium | G4          |
| R5  | Build Redis deep-dive dashboard using Redis datasource plugin                                                                                    | P2       | Medium | Medium | G5          |
| R6  | Build PostgreSQL deep-dive dashboard using PostgreSQL datasource plugin                                                                          | P2       | Medium | Medium | G6          |
| R7  | Add `gen_ai.provider.name` attribute to GenAI metrics                                                                                            | P2       | Low    | Medium | G7          |
| R8  | Configure histogram exemplars for metric→trace correlation                                                                                       | P2       | Medium | Medium | G8          |
| R9  | Install Grafana SLO App for managed error budgets and burn-rate alerts                                                                           | P3       | Low    | Medium | G9          |
| R10 | Wire W3C trace context extraction in RPC gateway for full round-trip tracing                                                                     | P3       | Low    | Medium | G10         |
| R11 | Update `observability-architecture.md` to reflect infrastructure changes (Redis Streams, expanded providers/kernels, middleware-based telemetry) | P2       | Medium | High   | Finding 1–6 |

## References

- Target architecture: `docs/research/observability-architecture.md`
- Gap audit: `docs/research/grafana-observability-gaps.md`
- Telemetry package: `packages/telemetry/src/registry.ts`
- OTEL bootstrap: `apps/api/app/telemetry/otel.ts`
- Metrics service: `apps/api/app/telemetry/metrics.ts`
- Dashboard configs: `infra/grafana/dashboards/*.json`
- Alert rules: `infra/grafana/alerts/alerts.yaml`
- Redis Streams adapter: `apps/api/app/api/websocket/redis-io.adapter.ts`
- LangGraph middleware: `apps/api/app/api/chat/middleware/`
- Fly.io prod config: `apps/api/fly.prod.toml`
- Fly.io staging config: `apps/api/fly.staging.toml`

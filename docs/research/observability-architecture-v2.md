---
title: 'Observability Architecture v2'
description: 'Current state of Tau observability — metrics catalog, tracing strategy, dashboard inventory, alerting, and infrastructure parity after the Gaps Remediation v2 implementation'
status: active
created: '2026-03-19'
updated: '2026-03-19'
category: architecture
related:
  - docs/research/observability-implementation-status.md
  - docs/research/observability-architecture.md
  - docs/research/grafana-observability-gaps.md
  - docs/research/rpc-best-practices.md
---

# Observability Architecture v2

Current-state reference for Tau's observability stack after the Gaps Remediation v2 implementation. Supersedes `observability-architecture.md` (v1).

## Executive Summary

Tau's observability stack is fully implemented across metrics, tracing, logging, profiling, and alerting. The API exposes 21 canonical metrics via `PrometheusExporter` on port 9464, auto-instrumentation covers HTTP/PostgreSQL/Socket.IO spans, LangGraph middleware captures GenAI-specific telemetry (tokens, cost, TTFT, iterations), and 10 Grafana dashboards provide full visibility. Manual tracing uses the `@Span()` decorator only — `withSpan()` has been removed. Staging has full observability parity with production.

## Table of Contents

- [Infrastructure Overview](#infrastructure-overview)
- [OTEL SDK Configuration](#otel-sdk-configuration)
- [Metrics Catalog](#metrics-catalog)
- [Tracing Strategy](#tracing-strategy)
- [Logging](#logging)
- [Grafana Dashboards](#grafana-dashboards)
- [Alerting](#alerting)
- [Continuous Profiling](#continuous-profiling)
- [Client Telemetry](#client-telemetry)
- [Deployment Parity](#deployment-parity)

## Infrastructure Overview

| Component          | Technology                                                             | Role                                        |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------- |
| API Server         | NestJS + Fastify                                                       | Application backend                         |
| Database           | PostgreSQL (Drizzle ORM)                                               | Persistent storage, LangGraph checkpointing |
| Cache/Streams      | Redis (ioredis) + Redis Streams                                        | WebSocket adapter, session state            |
| LLM Providers      | OpenAI, Anthropic, Vertex AI, Together AI, Cerebras, SambaNova, Ollama | 7 providers                                 |
| CAD Kernels        | Replicad, JSCAD, Manifold, OpenSCAD, KCL, OpenCASCADE, Tau             | 7 kernels                                   |
| Telemetry          | OTEL SDK (NodeSDK)                                                     | Metrics, traces, logs                       |
| Metrics Export     | PrometheusExporter → Prometheus                                        | Port 9464                                   |
| Traces/Logs Export | OTLP/HTTP → Grafana Cloud (prod) / grafana/otel-lgtm (dev)             | gRPC + HTTP                                 |
| Dashboards         | Grafana                                                                | 10 dashboards, 5 alert rules                |
| Profiling          | Pyroscope (optional)                                                   | CPU + heap flame graphs                     |

### Local Dev Stack

Docker Compose (`infra/docker-compose.yml`) runs `grafana/otel-lgtm` which bundles Prometheus, Loki, Tempo, and Grafana on port 6100. Plugins `redis-datasource` and `grafana-postgresql-datasource` are installed via `GF_INSTALL_PLUGINS`.

### Production

- API on Fly.io (`fly.prod.toml`) with `[metrics]` block exposing port 9464
- OTLP/HTTP traces + logs to Grafana Cloud
- Pyroscope profiling when `PYROSCOPE_SERVER_ADDRESS` is set

## OTEL SDK Configuration

**File**: `apps/api/app/telemetry/otel.ts`

The SDK initializes before application code:

- **Production**: Via `NODE_OPTIONS="--import ./dist/telemetry/otel.js"` in the Dockerfile
- **Development**: Via side-effect import at the top of `main.ts`

Configuration:

- `PrometheusExporter` on port 9464 (configurable via `OTEL_METRICS_PORT`)
- `OTLPTraceExporter` + `OTLPLogExporter` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- Exemplars enabled via `OTEL_METRICS_EXEMPLAR_FILTER=trace_based`
- Auto-instrumentations: all Node.js instrumentations enabled except `fs`, `dns`, `net`, `fastify` (Fastify uses `@fastify/otel` instead)

## Metrics Catalog

All 21 metrics are defined in `packages/telemetry/src/registry.ts` (`TauMetrics`) and instantiated in `apps/api/app/telemetry/metrics.ts` (`MetricsService`).

### Server Metrics (meter: `tau-api`)

| Metric                              | Type          | Unit         | Recorded By                                     |
| ----------------------------------- | ------------- | ------------ | ----------------------------------------------- |
| `rpc.server.call.duration`          | Histogram     | s            | `ChatRpcService.recordRpcDuration()`            |
| `rpc.server.active_calls`           | UpDownCounter | {call}       | `ChatRpcService.executeRpc()`                   |
| `ws.connections.active`             | UpDownCounter | {connection} | `ChatRpcGateway.bindConnectionMetrics()`        |
| `ws.disconnections`                 | Counter       | {connection} | `ChatRpcGateway.bindConnectionMetrics()`        |
| `ws.message.size`                   | Histogram     | By           | `ChatRpcService.executeRpc()`                   |
| `gen_ai.client.token.usage`         | Histogram     | {token}      | `usage-tracking.middleware.ts`                  |
| `gen_ai.client.operation.duration`  | Histogram     | s            | `llm-timing.middleware.ts`                      |
| `gen_ai.client.time_to_first_token` | Histogram     | s            | `llm-timing.middleware.ts`                      |
| `gen_ai.client.cost`                | Counter       | USD          | `usage-tracking.middleware.ts`                  |
| `gen_ai.tool.invocations`           | Counter       | {invocation} | `tool-metrics.middleware.ts`                    |
| `gen_ai.agent.iterations`           | Histogram     | {iteration}  | `agent-iterations.middleware.ts`                |
| `redis.connection.state`            | Gauge         | -            | `RedisHealthIndicator`                          |
| `sse.connections.active`            | UpDownCounter | {connection} | `ChatController.streamAgentResponse()`          |
| `sse.events`                        | Counter       | {event}      | `ChatController.createSseEventCountTransform()` |

### Client-Reported Metrics (meter: `tau-client`)

| Metric                            | Type      | Unit        |
| --------------------------------- | --------- | ----------- |
| `kernel.execution.duration`       | Histogram | s           |
| `kernel.executions`               | Counter   | {execution} |
| `kernel.geometry.export.duration` | Histogram | s           |
| `ws.reconnection.duration`        | Histogram | s           |
| `editor.load.duration`            | Histogram | s           |
| `wasm.module.load.duration`       | Histogram | s           |
| `indexeddb.operation.duration`    | Histogram | s           |

### Key Attributes

| Attribute                                 | Recorded On                                 |
| ----------------------------------------- | ------------------------------------------- |
| `gen_ai.request.model`                    | All GenAI metrics                           |
| `gen_ai.provider.name`                    | Token usage, operation duration, TTFT, cost |
| `gen_ai.token.type`                       | Token usage (input/output)                  |
| `gen_ai.tool.name` / `gen_ai.tool.status` | Tool invocations                            |
| `rpc.method` / `rpc.status`               | RPC duration, active calls, message size    |
| `error.type`                              | Operation duration (on LLM errors)          |
| `ws.direction`                            | Message size (in/out)                       |
| `sse.event.type`                          | SSE events                                  |
| `ws.close.reason`                         | WS disconnections                           |

## Tracing Strategy

### Auto-Instrumentation

The OTEL NodeSDK auto-instruments:

- HTTP (Fastify via `@fastify/otel`)
- PostgreSQL (`@opentelemetry/instrumentation-pg`)
- Socket.IO (`@opentelemetry/instrumentation-socket.io`)
- Generic Node.js (HTTP client, etc.)

### Manual Instrumentation

**`@Span()` decorator** is the only manual tracing API. It wraps methods in OTEL spans with automatic status and exception recording. Used on 5 services, 6 methods.

`withSpan()`, `startSpan()`, and `withExtractedContext()` have been **removed** from `TracerService`. They were redundant with auto-instrumentation and unsuitable for streaming workloads.

### Distributed Trace Context

- **Server → Client**: `injectTraceContext()` embeds W3C `traceparent` in RPC request payloads
- **Client → Server**: Client echoes `traceContext` back in RPC response payloads
- Both `RpcRequest` and `RpcResponse` types include optional `traceContext: Record<string, string>`

### Exemplars

Histogram exemplars are enabled via `OTEL_METRICS_EXEMPLAR_FILTER=trace_based`, linking metric data points to trace IDs for drill-down in Grafana.

## Logging

Pino structured logging with `nestjs-pino`. The `@opentelemetry/instrumentation-pino` auto-instrumentation injects `trace_id` and `span_id` into every log line.

Logs are exported via OTLP to Loki (dev: `grafana/otel-lgtm`, prod: Grafana Cloud).

## Grafana Dashboards

10 dashboards provisioned via `infra/grafana/dashboards/`. All dashboards include:

- Template variables: `$service`, `$instance`
- Error Logs panel (Loki)
- Recent Traces panel (Tempo)

| Dashboard       | File                   | Key Panels                                                                  |
| --------------- | ---------------------- | --------------------------------------------------------------------------- |
| System Overview | `system-overview.json` | Request rate, error rate, latency, LLM p95, active WS/SSE                   |
| API Overview    | `api-overview.json`    | HTTP rate/latency/errors by route                                           |
| WebSocket/RPC   | `websocket-rpc.json`   | Active connections, RPC rate/latency by method, message size                |
| AI Agent        | `ai-agent.json`        | Token usage, cost, TTFT, tool invocations, iterations, provider breakdown   |
| CAD Kernel      | `cad-kernel.json`      | Execution rate/latency/errors by kernel                                     |
| Infrastructure  | `infrastructure.json`  | Redis connection, SSE active/events, Fly.io machine metrics (collapsed row) |
| SLO/Executive   | `slo-executive.json`   | Error budget (API + RPC), burn rates (1h, 6h, 24h)                          |
| Profiling       | `profiling.json`       | CPU profile + heap allocations (Pyroscope)                                  |
| Redis           | `redis.json`           | INFO stats, memory, ops/sec, stream length, slowlog                         |
| PostgreSQL      | `postgresql.json`      | Active connections, DB size, cache hit ratio, table sizes, index usage      |

## Alerting

5 alert rules defined in `infra/grafana/alerts/alerts.yaml`:

| Alert                       | Condition                                             |
| --------------------------- | ----------------------------------------------------- |
| `high-5xx-rate`             | 5xx rate > 5% for 5m                                  |
| `high-latency-p95`          | HTTP p95 > 5s for 5m                                  |
| `redis-disconnected`        | Redis connection state = 0 for 1m                     |
| `llm-error-rate`            | LLM operation duration with `error.type` > 10% for 5m |
| `websocket-mass-disconnect` | WS disconnections > 50/min for 2m                     |

The `llm-error-rate` alert is now functional — `llm-timing.middleware.ts` records `genAiOperationDuration` with `error.type` attribute on LLM call failures.

## Continuous Profiling

Pyroscope integration in `otel.ts`. When `PYROSCOPE_SERVER_ADDRESS` is set:

- CPU profiling via `@pyroscope/nodejs`
- Heap allocation profiling
- Tags: `region`, `version`
- Visualized in the Profiling dashboard

## Client Telemetry

Client-reported metrics are ingested via `TelemetryController` (`POST /v1/telemetry/ingest`). The schema supports:

- `KERNEL_EXECUTION` / `GEOMETRY_EXPORT` — CAD kernel performance
- `WEBSOCKET_RECONNECTION` — WS reconnection latency
- `EDITOR_LOAD` — Editor initialization time
- `WASM_MODULE_LOAD` — WASM download + instantiation
- `INDEXEDDB_OPERATION` — IndexedDB operation latency

Client-side RPC trace propagation echoes W3C trace context from RPC requests back in responses.

## Deployment Parity

Both `fly.prod.toml` and `fly.staging.toml` are configured identically for observability:

| Feature                 | Production                | Staging                   |
| ----------------------- | ------------------------- | ------------------------- |
| Health checks           | `/health/ready` every 10s | `/health/ready` every 10s |
| Metrics port            | 9464                      | 9464                      |
| OTEL compression        | gzip                      | gzip                      |
| kill_signal/timeout     | SIGTERM / 30s             | SIGTERM / 30s             |
| `NODE_OPTIONS --import` | Dockerfile                | Dockerfile                |

## References

- Supersedes: `docs/research/observability-architecture.md` (v1)
- Audit: `docs/research/observability-implementation-status.md`
- Gaps: `docs/research/grafana-observability-gaps.md` (superseded)
- RPC: `docs/research/rpc-best-practices.md`

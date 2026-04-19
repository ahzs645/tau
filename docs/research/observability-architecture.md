---
title: 'Observability Architecture for Agentic CAD Platform'
description: 'Research into monitoring topology, OTEL architecture, structured logging, error tracking, custom metrics, and Grafana dashboards for Tau'
status: superseded
superseded_by: docs/research/observability-architecture-v2.md
created: '2026-03-18'
updated: '2026-03-19'
category: architecture
related:
  - docs/policy/vision-policy.md
  - docs/research/socketio-production-resilience.md
  - docs/research/rpc-best-practices.md
---

# Observability Architecture for Agentic CAD Platform

Research into the full observability stack for Tau: monitoring topology for agentic coding platforms, OTEL Collector architecture on Fly.io, structured logging with trace correlation, error tracking, custom metrics design, and Grafana dashboard layout.

## Executive Summary

Modern agentic coding platforms require observability beyond standard HTTP monitoring — they need real-time tracking of WebSocket health, AI agent execution, RPC latency, kernel performance, and file operation throughput. The recommended architecture for Tau is: (1) direct OTLP export from the NestJS API to Grafana Cloud (no sidecar collector), (2) Pino structured logging with automatic trace context injection via `@opentelemetry/instrumentation-pino`, (3) OTEL-native error tracking via the Exceptions Connector or Highlight.io, (4) custom metrics following GenAI semantic conventions, (5) RED-method Grafana dashboards per component (REST, WebSocket, SSE, Redis, AI Agent), (6) `@nestjs/terminus` health probes separating liveness from readiness with Redis/DB dependency checks, and (7) W3C trace context propagation across Socket.IO for end-to-end RPC tracing.

## Table of Contents

- [1. Monitoring Topology for Agentic Coding Platforms](#1-monitoring-topology-for-agentic-coding-platforms)
- [2. OTEL Collector Architecture](#2-otel-collector-architecture)
- [3. Structured Logging Best Practices](#3-structured-logging-best-practices)
- [4. Error Tracking and Alerting](#4-error-tracking-and-alerting)
- [5. Custom Metrics Design](#5-custom-metrics-design)
- [6. Grafana Dashboard Design](#6-grafana-dashboard-design)
- [7. Health Endpoint Architecture](#7-health-endpoint-architecture)
- [8. NestJS Instrumentation Patterns](#8-nestjs-instrumentation-patterns)
- [Recommendations](#recommendations)

## Problem Statement

Tau is an AI-native CAD platform with a complex runtime topology: NestJS API (Fastify) serving REST + WebSocket (Socket.IO) + SSE, backed by PostgreSQL, Redis, and multiple LLM providers (OpenAI, Anthropic, Vertex AI, Ollama). The CAD runtime executes user code across multiple kernels (Replicad, JSCAD, Manifold, OpenSCAD, KCL). There is currently no observability infrastructure — no metrics, no distributed tracing, no structured logging pipeline, and no alerting. This research establishes the target architecture.

## Methodology

Web research across official OpenTelemetry documentation, Grafana Cloud docs, Fly.io deployment guides, OTEL semantic conventions (including GenAI), and analysis of monitoring approaches used by agentic coding platforms (Cursor, Replit, Lovable, v0, Bolt). Comparison of open-source observability backends (SigNoz, Grafana stack, Uptrace, Highlight.io). Review of production configurations for OTEL Collector processors, Pino/NestJS integration, and WebSocket instrumentation.

---

## 1. Monitoring Topology for Agentic Coding Platforms

### Finding 1: Agentic platforms require fundamentally different SLIs than traditional web apps

Traditional web application monitoring focuses on HTTP request latency and error rates. Agentic coding platforms like Cursor, Replit, and Bolt have unique characteristics that demand additional signal dimensions:

| Dimension               | Traditional Web App    | Agentic Coding Platform                                               |
| ----------------------- | ---------------------- | --------------------------------------------------------------------- |
| **Primary transport**   | HTTP request/response  | WebSocket + SSE (long-lived)                                          |
| **Latency sensitivity** | Sub-second page loads  | Sub-100ms for editor operations, multi-minute for AI generations      |
| **State management**    | Stateless REST         | Stateful sessions (open files, kernel state, chat history)            |
| **Compute profile**     | Database queries       | LLM API calls + CAD kernel execution                                  |
| **Failure modes**       | 5xx errors             | WebSocket disconnects, LLM timeouts, kernel crashes, token exhaustion |
| **Cost dimension**      | Infra cost per request | LLM token cost per generation                                         |

### Finding 2: Industry-standard observability tools for agentic platforms

- **Agentlytics** — unified analytics dashboard across 16+ editors; tracks sessions, costs, models, and tool usage. Runs locally, no data egress.
- **AgentProbe** — TypeScript library for passive observability; parses agent transcripts, normalizes events across platforms (Cursor, CLI coding agents).
- **Cursor Enterprise APIs** — AI Code Tracking API (tracks lines added/deleted by AI vs human), Analytics API (active users, model usage), Admin API (usage data, spending). Rate limited at 20-100 req/min.
- **VS Code Copilot** — uses OpenTelemetry GenAI semantic conventions for monitoring agent usage with hierarchical span trees capturing tool execution, LLM calls, and token usage.

### Finding 3: Recommended SLOs and SLIs for Tau

| SLI                                 | Measurement                                    | Target SLO | Rationale                                                           |
| ----------------------------------- | ---------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| **RPC round-trip latency (p99)**    | Histogram of WebSocket RPC call duration       | < 200ms    | Editor responsiveness; users perceive lag above 200ms               |
| **WebSocket availability**          | % of time WS connections are healthy           | 99.9%      | Core transport for real-time features                               |
| **AI response time-to-first-token** | Time from chat send to first SSE chunk         | < 2s (p95) | User expectation for AI responsiveness                              |
| **AI generation success rate**      | % of chat requests that complete without error | > 98%      | LLM API reliability + prompt quality                                |
| **Kernel execution success rate**   | % of code evaluations that return geometry     | > 95%      | User code may be invalid; track platform-caused failures separately |
| **Kernel execution latency (p95)**  | Time from code submission to geometry return   | < 5s       | CAD operations are computationally heavy                            |
| **File operation latency (p99)**    | FS read/write/list operations                  | < 100ms    | IndexedDB-backed; should be fast                                    |
| **API error rate (5xx)**            | % of HTTP responses with 5xx status            | < 0.1%     | Standard reliability target                                         |
| **Redis connection availability**   | % of time Redis pub/sub is connected           | 99.95%     | Critical for multi-instance coordination                            |

---

## 2. OTEL Collector Architecture

### Finding 4: Direct OTLP export is the recommended topology for Fly.io

Fly.io Machines are lightweight VMs with outbound internet access by default. The platform does not natively support sidecar containers in the Kubernetes sense (though multi-container Machines exist). The recommended topology is **direct export from the application SDK to an external OTLP endpoint**.

```
┌─────────────────────────────────────────────────────────┐
│                     Fly.io Region                       │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Machine 1   │  │  Machine 2   │  │  Machine N   │  │
│  │              │  │              │  │              │  │
│  │  NestJS API  │  │  NestJS API  │  │  NestJS API  │  │
│  │  + OTEL SDK  │  │  + OTEL SDK  │  │  + OTEL SDK  │  │
│  │      │       │  │      │       │  │      │       │  │
│  └──────┼───────┘  └──────┼───────┘  └──────┼───────┘  │
│         │                 │                 │           │
└─────────┼─────────────────┼─────────────────┼───────────┘
          │                 │                 │
          └────────┬────────┘                 │
                   │    OTLP/HTTP             │
                   ▼                          ▼
          ┌────────────────────────────────────────┐
          │         Grafana Cloud OTLP             │
          │    otlp-gateway-<region>.grafana.net    │
          │                                        │
          │  ┌──────────┐ ┌──────┐ ┌───────────┐  │
          │  │ Tempo    │ │ Mimir │ │   Loki    │  │
          │  │ (traces) │ │(metr.)│ │  (logs)   │  │
          │  └──────────┘ └──────┘ └───────────┘  │
          └────────────────────────────────────────┘
```

### Finding 5: Sidecar vs direct export trade-offs

| Approach               | Pros                                                                                       | Cons                                                                            | When to use                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Direct OTLP export** | Simplest deployment; no extra processes; lower memory overhead; works natively with Fly.io | No local buffering/retry beyond SDK; no local processing (sampling, enrichment) | Small-medium deployments; Fly.io; when using a managed OTLP backend    |
| **Sidecar collector**  | Local buffering and retry; tail sampling; data enrichment; credential isolation            | Resource overhead per instance; operational complexity; not natural on Fly.io   | Kubernetes; high-volume deployments; when tail sampling is required    |
| **Gateway collector**  | Centralized processing; single point for sampling policies; credential management          | Single point of failure (mitigated by HA); added network hop                    | Multi-region deployments; when tail sampling across services is needed |

**Recommendation for Tau**: Start with direct OTLP export to Grafana Cloud. The OTEL SDK provides built-in batching, retry, and compression. If tail sampling becomes necessary (to reduce trace volume/cost), deploy a single gateway collector on a dedicated Fly.io Machine.

### Finding 6: OTEL SDK configuration for production

Key SDK batch export settings to tune:

| Parameter                        | Default       | Recommended   | Rationale                                               |
| -------------------------------- | ------------- | ------------- | ------------------------------------------------------- |
| `OTEL_BSP_SCHEDULE_DELAY`        | 5000ms        | 5000ms        | Batch flush interval; default is fine for production    |
| `OTEL_BSP_MAX_QUEUE_SIZE`        | 2048          | 2048          | Max spans queued; increase if dropping spans            |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | 512           | 512           | Spans per export; keep reasonable for HTTP payload size |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | none          | gzip          | Reduces bandwidth by 60-80%                             |
| `OTEL_EXPORTER_OTLP_PROTOCOL`    | http/protobuf | http/protobuf | More efficient than JSON; widely supported              |

Resource attributes to set from Fly.io environment:

```typescript
resource: new Resource({
  'service.name': 'tau-api',
  'service.version': process.env.FLY_IMAGE_REF,
  'deployment.environment': process.env.FLY_APP_NAME?.includes('staging') ? 'staging' : 'production',
  'cloud.provider': 'fly.io',
  'cloud.region': process.env.FLY_REGION,
  'host.id': process.env.FLY_MACHINE_ID,
  'host.name': process.env.FLY_ALLOC_ID,
});
```

---

## 3. Structured Logging Best Practices

### Finding 7: Pino is the recommended logger for NestJS + OpenTelemetry

Pino is the fastest Node.js logger (5-10x faster than Winston) and has first-class OpenTelemetry integration via `@opentelemetry/instrumentation-pino`.

**Required packages:**

| Package                               | Purpose                                               |
| ------------------------------------- | ----------------------------------------------------- |
| `pino`                                | Core structured logger                                |
| `pino-pretty`                         | Dev-only human-readable formatting                    |
| `@opentelemetry/instrumentation-pino` | Auto-injects trace_id, span_id into log records       |
| `pino-opentelemetry-transport`        | Sends logs to OTEL Collector via OTLP                 |
| `nestjs-pino`                         | NestJS module that replaces the default LoggerService |

### Finding 8: Trace context injection is automatic with OTEL instrumentation

When `@opentelemetry/instrumentation-pino` is registered, every log record emitted within an active span automatically includes:

```json
{
  "level": 30,
  "time": 1710749823000,
  "msg": "RPC call completed",
  "trace_id": "abc123def456...",
  "span_id": "789ghi012...",
  "trace_flags": "01",
  "rpc.method": "evaluateCode",
  "rpc.duration_ms": 142
}
```

This enables clicking from a log line in Grafana Loki directly to the corresponding trace in Tempo.

### Finding 9: Log level strategy for production

| Level        | When to use                          | Examples                                               | Volume target              |
| ------------ | ------------------------------------ | ------------------------------------------------------ | -------------------------- |
| `fatal` (60) | Process is about to crash            | Uncaught exception, OOM, port bind failure             | Near zero                  |
| `error` (50) | Operation failed, requires attention | LLM API 5xx, Redis connection lost, kernel crash       | < 0.1% of requests         |
| `warn` (40)  | Degraded but recoverable             | LLM retry, WebSocket reconnect, rate limit approaching | < 1% of requests           |
| `info` (30)  | Significant business events          | User session start, AI generation complete, file saved | Bounded by user activity   |
| `debug` (20) | Detailed operational data            | RPC payload, kernel stdin/stdout, cache hit/miss       | **Disabled in production** |
| `trace` (10) | Fine-grained debugging               | Function entry/exit, intermediate state                | **Never in production**    |

**Production default**: `info`. Use `LOG_LEVEL` env var to dynamically lower to `debug` per-machine for incident investigation without redeployment.

### Finding 10: Critical initialization order for NestJS

The OpenTelemetry SDK **must** initialize before NestJS bootstraps. This is because auto-instrumentation patches modules at require/import time.

```typescript
// tracing.ts — imported FIRST via NODE_OPTIONS="--require ./tracing.js"
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 30_000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();
```

Load via: `NODE_OPTIONS="--require ./dist/tracing.js" node dist/main.js`

---

## 4. Error Tracking and Alerting

### Finding 11: Open-source error tracking alternatives to Sentry with OTEL integration

| Platform                      | OTEL Native                                    | Self-Hosted               | Key Differentiator                                            | License                   |
| ----------------------------- | ---------------------------------------------- | ------------------------- | ------------------------------------------------------------- | ------------------------- |
| **Highlight.io**              | Yes — accepts OTLP at `otel.highlight.io:4318` | Yes (Docker)              | Session replay + error tracking + logging; full-stack         | Apache 2.0                |
| **SigNoz**                    | Yes — built on OTEL Collector                  | Yes (Docker/K8s)          | Unified traces/metrics/logs with ClickHouse; PromQL + SQL     | MIT (AGPL for enterprise) |
| **GlitchTip**                 | Partial — Sentry SDK compatible                | Yes (Docker)              | Lightweight Sentry alternative; performance monitoring        | MIT                       |
| **Uptrace**                   | Yes — OTEL backend                             | Yes (Docker)              | Cost-efficient; distributed tracing focused                   | BSL 1.1                   |
| **OTEL Exceptions Connector** | Native                                         | N/A (Collector component) | Extracts exception events from spans → structured log records | Apache 2.0                |

**Recommendation**: Use the OTEL Exceptions Connector in the Collector pipeline (or in-SDK exception recording) combined with Grafana Cloud for visualization. This avoids introducing another platform. If session replay or richer error grouping is needed later, Highlight.io is the strongest OTEL-native option.

### Finding 12: Exception recording in OpenTelemetry spans

The OTEL SDK automatically records exceptions as span events with semantic attributes:

```typescript
span.recordException(error); // adds event with:
// exception.type: "HttpException"
// exception.message: "Service unavailable"
// exception.stacktrace: "Error: Service unavailable\n    at ..."
```

These exception events can be:

1. Extracted by the Exceptions Connector into log records for alerting
2. Queried in Grafana Tempo as span events
3. Used to generate error rate metrics via the Span Metrics Connector

### Finding 13: Alerting architecture for critical metrics

| Alert                          | Signal Source                                 | Condition                        | Severity | Channel           |
| ------------------------------ | --------------------------------------------- | -------------------------------- | -------- | ----------------- |
| **RPC failure rate spike**     | `rpc.server.call.duration` with error status  | > 5% error rate over 5min window | P1       | Slack + PagerDuty |
| **WebSocket disconnect storm** | Custom `ws.disconnections` counter            | > 10 disconnects/min per machine | P1       | Slack             |
| **Redis connection lost**      | `db.client.connection.count` gauge (Redis)    | Drops to 0                       | P0       | Slack + PagerDuty |
| **LLM API error rate**         | `gen_ai.client.operation.duration` with error | > 10% error rate over 5min       | P1       | Slack             |
| **LLM latency degradation**    | `gen_ai.client.operation.duration` p95        | > 30s for 10min                  | P2       | Slack             |
| **High error rate (5xx)**      | `http.server.request.duration` with 5xx       | > 1% over 5min                   | P1       | Slack + PagerDuty |
| **Machine memory pressure**    | Fly.io built-in metrics                       | > 90% RSS for 5min               | P2       | Slack             |
| **Kernel crash rate**          | Custom `kernel.execution.errors` counter      | > 5% failure rate                | P2       | Slack             |

Grafana Alerting (built into Grafana Cloud) can evaluate these conditions against Mimir (metrics) and Loki (logs) data sources.

---

## 5. Custom Metrics Design

### Finding 14: Metric instrument types and when to use each

| Instrument                     | Use Case                                | Example                                              |
| ------------------------------ | --------------------------------------- | ---------------------------------------------------- |
| **Counter**                    | Monotonically increasing totals         | Total RPC calls, total errors, total tokens consumed |
| **Histogram**                  | Distribution of values (latency, sizes) | RPC latency, AI response time, file sizes            |
| **UpDownCounter**              | Values that go up and down              | Active WebSocket connections, queued kernel jobs     |
| **Gauge** (via async callback) | Point-in-time snapshots                 | Memory usage, Redis pool size, active sessions       |

### Finding 15: Complete custom metrics catalog for Tau

#### A. WebSocket / RPC Metrics

| Metric Name                | Type          | Unit         | Attributes                               | Description                                       |
| -------------------------- | ------------- | ------------ | ---------------------------------------- | ------------------------------------------------- |
| `rpc.server.call.duration` | Histogram     | s            | `rpc.method`, `rpc.status`, `error.type` | RPC round-trip latency (OTEL semantic convention) |
| `rpc.server.active_calls`  | UpDownCounter | {call}       | `rpc.method`                             | Currently in-flight RPC calls                     |
| `ws.connections.active`    | UpDownCounter | {connection} | `ws.transport` (polling/websocket)       | Active WebSocket connections                      |
| `ws.connections.total`     | Counter       | {connection} | `ws.transport`, `ws.close_reason`        | Total connections (tracks disconnects by reason)  |
| `ws.message.size`          | Histogram     | By           | `ws.direction` (in/out), `rpc.method`    | Payload sizes for capacity planning               |

#### B. AI / LLM Metrics (GenAI Semantic Conventions)

| Metric Name                         | Type      | Unit         | Attributes                                                                                                  | Description                                                    |
| ----------------------------------- | --------- | ------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `gen_ai.client.token.usage`         | Histogram | {token}      | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.token.type` (input/output) | Token consumption per request                                  |
| `gen_ai.client.operation.duration`  | Histogram | s            | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.finish_reasons`   | End-to-end LLM call latency                                    |
| `gen_ai.client.time_to_first_token` | Histogram | s            | `gen_ai.provider.name`, `gen_ai.request.model`                                                              | Streaming responsiveness                                       |
| `gen_ai.client.cost`                | Counter   | USD          | `gen_ai.provider.name`, `gen_ai.request.model`                                                              | Estimated cost per call (computed from token counts × pricing) |
| `gen_ai.tool.invocations`           | Counter   | {invocation} | `gen_ai.tool.name`, `gen_ai.tool.status`                                                                    | Tool use frequency and success rate                            |
| `gen_ai.agent.iterations`           | Histogram | {iteration}  | `gen_ai.request.model`                                                                                      | Agent loop iterations per user request                         |

Recommended histogram bucket boundaries for token usage: `[1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576]`

#### C. CAD Kernel Metrics

| Metric Name                       | Type      | Unit        | Attributes                                                                                    | Description                     |
| --------------------------------- | --------- | ----------- | --------------------------------------------------------------------------------------------- | ------------------------------- |
| `kernel.execution.duration`       | Histogram | s           | `kernel.name` (replicad/jscad/manifold/openscad/kcl), `kernel.status` (success/error/timeout) | Code evaluation time            |
| `kernel.execution.total`          | Counter   | {execution} | `kernel.name`, `kernel.status`                                                                | Total kernel invocations        |
| `kernel.geometry.vertices`        | Histogram | {vertex}    | `kernel.name`                                                                                 | Output geometry complexity      |
| `kernel.geometry.export.duration` | Histogram | s           | `kernel.name`, `export.format` (gltf/step/stl)                                                | Geometry export/conversion time |
| `kernel.wasm.memory`              | Gauge     | By          | `kernel.name`                                                                                 | WASM heap usage                 |

#### D. File Operation Metrics

| Metric Name               | Type      | Unit        | Attributes                                                     | Description                    |
| ------------------------- | --------- | ----------- | -------------------------------------------------------------- | ------------------------------ |
| `file.operation.duration` | Histogram | s           | `file.operation` (read/write/delete/list/mkdir), `file.status` | FS operation latency           |
| `file.operation.total`    | Counter   | {operation} | `file.operation`, `file.status`                                | Total FS operations            |
| `file.operation.size`     | Histogram | By          | `file.operation`                                               | Payload sizes for reads/writes |

#### E. Infrastructure Metrics

| Metric Name              | Type          | Unit         | Attributes                                             | Description                                           |
| ------------------------ | ------------- | ------------ | ------------------------------------------------------ | ----------------------------------------------------- |
| `redis.pubsub.messages`  | Counter       | {message}    | `redis.channel`, `redis.direction` (publish/subscribe) | Pub/sub message throughput                            |
| `redis.connection.state` | Gauge         | —            | `redis.role` (primary/subscriber)                      | Connection health (1=connected, 0=disconnected)       |
| `db.query.duration`      | Histogram     | s            | `db.operation`, `db.table`                             | Database query latency (auto-instrumented by Drizzle) |
| `sse.connections.active` | UpDownCounter | {connection} | `sse.route`                                            | Active SSE streams                                    |
| `sse.events.total`       | Counter       | {event}      | `sse.route`, `sse.event_type`                          | SSE events emitted                                    |

### Finding 16: Attribute cardinality management

High cardinality attributes (user IDs, file paths, trace IDs) should **never** be used as metric attributes — they cause metric explosion. Use them only in spans and logs. Metric attributes should be bounded enums:

| Safe (bounded)                          | Unsafe (unbounded)                 |
| --------------------------------------- | ---------------------------------- |
| `rpc.method` (known set of ~20 methods) | `user.id`                          |
| `kernel.name` (5 kernels)               | `file.path`                        |
| `gen_ai.provider.name` (4 providers)    | `gen_ai.request.id`                |
| `http.route` (known set of routes)      | `http.url` (includes query params) |

---

## 6. Grafana Dashboard Design

### Finding 17: RED method applied to each Tau component

The RED method (Rate, Errors, Duration) provides a user-centric view of service health. Apply it to each component:

#### Dashboard 1: API Overview (REST)

| Panel                 | PromQL                                                                                                                                                          | Visualization    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Request Rate          | `sum(rate(http_server_request_duration_seconds_count[5m])) by (http_route)`                                                                                     | Time series      |
| Error Rate (%)        | `sum(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m])) / sum(rate(http_server_request_duration_seconds_count[5m])) * 100` | Stat + threshold |
| Latency (p50/p95/p99) | `histogram_quantile(0.99, sum(rate(http_server_request_duration_seconds_bucket[5m])) by (le, http_route))`                                                      | Time series      |
| Active requests       | `sum(http_server_active_requests)`                                                                                                                              | Gauge            |
| Error log stream      | Loki query: `{service_name="tau-api"} \| level="error"`                                                                                                         | Logs panel       |

#### Dashboard 2: WebSocket / RPC

| Panel                        | Metric                                                          | Visualization     |
| ---------------------------- | --------------------------------------------------------------- | ----------------- |
| Active connections           | `ws_connections_active`                                         | Stat (big number) |
| Connection rate              | `rate(ws_connections_total[5m])`                                | Time series       |
| Disconnection rate by reason | `rate(ws_connections_total{ws_close_reason!=""}[5m])` by reason | Stacked bar       |
| RPC call rate by method      | `rate(rpc_server_call_duration_seconds_count[5m])` by method    | Time series       |
| RPC error rate by method     | Error ratio per method                                          | Heatmap           |
| RPC latency (p50/p95/p99)    | `histogram_quantile(...)` on `rpc_server_call_duration_seconds` | Time series       |
| Payload size distribution    | `rpc_message_size_bytes` histogram                              | Heatmap           |

#### Dashboard 3: AI Agent

| Panel                         | Metric                                                                | Visualization       |
| ----------------------------- | --------------------------------------------------------------------- | ------------------- |
| Token usage (input/output)    | `sum(rate(gen_ai_client_token_usage_sum[5m])) by (token_type, model)` | Stacked time series |
| Estimated cost ($/hr)         | `sum(rate(gen_ai_client_cost_total[1h]))`                             | Stat                |
| Time-to-first-token (p50/p95) | `histogram_quantile(...)` on `gen_ai_client_time_to_first_token`      | Time series         |
| Generation duration (p50/p95) | `histogram_quantile(...)` on `gen_ai_client_operation_duration`       | Time series         |
| Error rate by provider        | Error ratio on `gen_ai_client_operation_duration` by provider         | Stat with threshold |
| Tool invocation breakdown     | `rate(gen_ai_tool_invocations_total[5m])` by tool name                | Bar chart           |
| Agent iterations per request  | `histogram_quantile(0.95, ...)` on `gen_ai_agent_iterations`          | Stat                |
| Model usage distribution      | Token count by model                                                  | Pie chart           |

#### Dashboard 4: CAD Kernel

| Panel                       | Metric                                                               | Visualization       |
| --------------------------- | -------------------------------------------------------------------- | ------------------- |
| Execution rate by kernel    | `rate(kernel_execution_total[5m])` by kernel                         | Stacked time series |
| Execution latency by kernel | `histogram_quantile(0.95, ...)` on `kernel_execution_duration`       | Time series         |
| Error rate by kernel        | Error ratio per kernel                                               | Stat with threshold |
| Geometry complexity         | `histogram_quantile(0.50, ...)` on `kernel_geometry_vertices`        | Time series         |
| Export duration by format   | `histogram_quantile(0.95, ...)` on `kernel_geometry_export_duration` | Bar chart           |
| WASM memory usage           | `kernel_wasm_memory_bytes`                                           | Time series         |

#### Dashboard 5: Infrastructure

| Panel                      | Metric                                                 | Visualization          |
| -------------------------- | ------------------------------------------------------ | ---------------------- |
| Redis connection state     | `redis_connection_state`                               | Status map (green/red) |
| Redis pub/sub message rate | `rate(redis_pubsub_messages_total[5m])` by channel     | Time series            |
| Database query latency     | `histogram_quantile(0.95, ...)` on `db_query_duration` | Time series            |
| SSE active streams         | `sse_connections_active`                               | Stat                   |
| SSE event rate             | `rate(sse_events_total[5m])` by event type             | Time series            |
| Node.js event loop lag     | `nodejs_eventloop_lag_seconds` (auto-instrumented)     | Time series            |
| Process memory (RSS)       | `process_resident_memory_bytes`                        | Time series            |
| Fly.io machine health      | Fly.io federation metrics                              | Status map             |

### Finding 18: Dashboard layout architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Grafana Dashboard Hierarchy           │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │          Executive / SLO Dashboard               │    │
│  │  (SLO burn rates, error budgets, cost summary)  │    │
│  └──────────┬──────────┬──────────┬────────────────┘    │
│             │          │          │                      │
│  ┌──────────▼───┐ ┌────▼─────┐ ┌─▼──────────────┐      │
│  │  API (REST)  │ │ WebSocket│ │   AI Agent      │      │
│  │  RED Metrics │ │ RPC RED  │ │ Tokens/Cost/    │      │
│  │              │ │ + Health │ │ Latency/Tools   │      │
│  └──────────────┘ └──────────┘ └─────────────────┘      │
│                                                         │
│  ┌──────────────┐ ┌──────────┐ ┌─────────────────┐     │
│  │  CAD Kernel  │ │  Infra   │ │    Traces /     │     │
│  │  Exec Time / │ │ Redis/DB │ │    Errors       │     │
│  │  Error Rate  │ │ SSE/EL   │ │   (Tempo+Loki)  │     │
│  └──────────────┘ └──────────┘ └─────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

---

## 7. Health Endpoint Architecture

### Finding 19: Health probes must separate liveness from readiness

Production container orchestrators (Kubernetes, Fly.io, Nomad) require three distinct health endpoints:

| Probe         | Endpoint              | What to check                            | Failure action            |
| ------------- | --------------------- | ---------------------------------------- | ------------------------- |
| **Startup**   | `GET /health/startup` | App bootstrap complete                   | Block other probes        |
| **Liveness**  | `GET /health/live`    | Core process alive, heap under limit     | Restart container         |
| **Readiness** | `GET /health/ready`   | Redis connected, DB reachable, memory ok | Remove from load balancer |

**Critical rule**: Never check external dependencies in liveness probes. If Redis is down, restarting the app creates cascading failures. Dependencies belong in readiness only.

Tau's current `GET /health` endpoint returns `{ status: 'ok' }` with no dependency checks. The Fly.io health check at `path = "/health"` functions as a combined liveness + readiness probe, which is fragile.

**Recommended response schema:**

```typescript
interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number;
  timestamp: string;
  checks: Record<
    string,
    {
      status: 'up' | 'down' | 'degraded';
      responseTime?: number;
      details?: Record<string, unknown>;
    }
  >;
}
```

**Implementation**: `@nestjs/terminus` v11.1.1 (1.5M weekly downloads) is the standard NestJS health check library. It provides `HealthCheckService`, `MemoryHealthIndicator`, and integrates with custom indicators for Redis PING, PostgreSQL connectivity, and disk storage.

### Finding 20: Fly.io health check alignment

Fly.io `[[http_service.checks]]` maps to readiness semantics — failures remove the machine from the load balancer. Update the Fly.io config to point to `/health/ready`:

```toml
[[http_service.checks]]
  interval = "10s"
  timeout = "2s"
  grace_period = "30s"
  method = "GET"
  path = "/health/ready"
```

The readiness check should verify: Redis PING (< 500ms), PostgreSQL `SELECT 1` (< 300ms), and heap memory < 80% of VM limit.

---

## 8. NestJS Instrumentation Patterns

### Finding 21: `@fastify/otel` replaces deprecated Fastify instrumentation

`@opentelemetry/instrumentation-fastify` reached end-of-life in June 2025. The official replacement is `@fastify/otel` v0.17.1, registered directly on the Fastify instance before routes:

```typescript
import FastifyOtelInstrumentation from '@fastify/otel';

const fastifyOtel = new FastifyOtelInstrumentation();
fastifyOtel.setTracerProvider(provider);

const fastifyInstance = app.getHttpAdapter().getInstance();
await fastifyInstance.register(fastifyOtel.plugin());
```

Disable the deprecated package in auto-instrumentations: `'@opentelemetry/instrumentation-fastify': { enabled: false }`.

### Finding 22: PostgreSQL/Drizzle auto-instrumentation is transparent

`@opentelemetry/instrumentation-pg` v0.65.0 auto-instruments at the `pg` driver level, which Drizzle ORM uses underneath. No Drizzle-specific instrumentation needed — all queries produce `pg.query` spans with `db.statement`, `db.system`, `db.name`, and connection pool wait times via `pg-pool.connect` spans. Enable `enhancedDatabaseReporting: true` to capture query parameters (redact PII).

### Finding 23: Socket.IO OTEL instrumentation has known NestJS compatibility issue

`@opentelemetry/instrumentation-socket.io` v0.60.0 patches `on` and `emit` but not `addListener`/`removeListener` used by RxJS `fromEvent` (issue #3070). This affects NestJS's `@platform-socket.io` integration. Workaround: ensure events are handled via Socket.IO's native `on`/`emit` (which Tau already does in `chat-rpc.gateway.ts`), not RxJS subscriptions.

### Finding 24: W3C trace context propagation across Socket.IO for RPC tracing

For end-to-end distributed traces spanning server → WebSocket → client → server, inject/extract W3C `traceparent` headers in Socket.IO event payloads:

```typescript
import { propagation, context, ROOT_CONTEXT } from '@opentelemetry/api';

const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);
socket.emit('rpc_request', { ...rpcRequest, traceContext: carrier });

const extractedContext = propagation.extract(ROOT_CONTEXT, payload.traceContext);
context.with(extractedContext, () => {
  // Client-side spans become children of server-side RPC span
});
```

This enables tracing an AI agent tool call through the server, across the WebSocket, into the client RPC handler, and back — a single trace for the full RPC lifecycle.

### Finding 25: Custom `@Span()` decorator and `TracerService` for manual instrumentation

For code paths not auto-instrumented (kernel execution, file operations, custom business logic), a `TracerService` injectable and `@Span()` method decorator provide ergonomic manual span creation:

```typescript
@Injectable()
export class TracerService {
  private readonly tracer = trace.getTracer('tau-api');

  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const span = this.tracer.startSpan(name, { attributes });
    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
```

Register as a `@Global()` module so any service can inject it for custom span creation around tool execution, kernel invocation, or AI agent steps.

---

## Recommendations

| #   | Action                                                                                                                                    | Priority | Effort | Impact |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Set up Grafana Cloud free tier with OTLP endpoint; configure `OTEL_EXPORTER_OTLP_ENDPOINT` and auth token as Fly.io secrets               | P0       | Low    | High   |
| R2  | Install OTEL SDK + auto-instrumentations in `apps/api`; create `tracing.ts` bootstrap file loaded via `NODE_OPTIONS --require`            | P0       | Medium | High   |
| R3  | Replace NestJS default logger with Pino via `nestjs-pino`; register `@opentelemetry/instrumentation-pino` for trace correlation           | P0       | Medium | High   |
| R4  | Define custom metrics for RPC, WebSocket, AI, and Kernel using `@opentelemetry/api` meter; follow the catalog in Finding 15               | P1       | Medium | High   |
| R5  | Create Grafana dashboards per component (REST, WebSocket/RPC, AI Agent, Kernel, Infrastructure) using RED method                          | P1       | Medium | High   |
| R6  | Configure Grafana Alerting rules for the critical alerts in Finding 13 (Redis down, RPC error spike, WS disconnect storm)                 | P1       | Low    | High   |
| R7  | Add Fly.io Prometheus federation scraping to capture built-in machine metrics (CPU, memory, network)                                      | P2       | Low    | Medium |
| R8  | Implement `gen_ai.client.token.usage` and `gen_ai.client.cost` metrics in the LangGraph agent for cost visibility                         | P1       | Low    | High   |
| R9  | Evaluate tail sampling via gateway collector when trace volume exceeds Grafana Cloud free tier limits                                     | P3       | Medium | Medium |
| R10 | Add `@opentelemetry/instrumentation-socket.io` for automatic WebSocket span creation                                                      | P1       | Low    | Medium |
| R11 | Replace basic `/health` with `@nestjs/terminus` liveness/readiness/startup probes; add Redis PING and DB connectivity checks to readiness | P0       | Low    | High   |
| R12 | Register `@fastify/otel` and disable deprecated `@opentelemetry/instrumentation-fastify` in auto-instrumentations                         | P0       | Low    | Medium |
| R13 | Inject W3C trace context (`traceparent`) into Socket.IO RPC payloads for end-to-end distributed tracing across WebSocket                  | P1       | Low    | High   |
| R14 | Create global `TracerService` module with `@Span()` decorator for manual instrumentation of kernel execution and tool calls               | P1       | Medium | Medium |

## Trade-offs

### Observability Backend: Grafana Cloud vs Self-Hosted

| Dimension              | Grafana Cloud (Free Tier)                        | Self-Hosted SigNoz                  | Self-Hosted Grafana Stack         |
| ---------------------- | ------------------------------------------------ | ----------------------------------- | --------------------------------- |
| **Setup effort**       | Minutes (managed)                                | Hours (Docker Compose)              | Hours (Prometheus + Loki + Tempo) |
| **Cost (small scale)** | Free: 50GB logs, 50GB traces, 10K metrics series | Free (self-hosted)                  | Free (self-hosted)                |
| **Cost (growth)**      | Pay-as-you-go; can get expensive                 | Infra cost only                     | Infra cost only                   |
| **Operational burden** | None                                             | Moderate (ClickHouse, upgrades)     | High (3 separate systems)         |
| **OTLP native**        | Yes                                              | Yes                                 | Yes (via Alloy/Collector)         |
| **Alerting**           | Built-in                                         | Built-in                            | Built-in                          |
| **Recommendation**     | **Start here**                                   | Migrate if cost becomes prohibitive | Not recommended (complexity)      |

### Direct Export vs Collector

| Dimension                 | Direct OTLP Export                  | Gateway Collector                 |
| ------------------------- | ----------------------------------- | --------------------------------- |
| **Simplicity**            | No extra infrastructure             | Requires a dedicated Machine      |
| **Tail sampling**         | Not possible                        | Possible                          |
| **Buffering**             | SDK-level only (limited)            | Disk-backed queues available      |
| **Credential management** | Each Machine needs OTLP credentials | Only Collector needs credentials  |
| **Recommendation**        | **Start here**                      | Add later if tail sampling needed |

## Code Examples

### OTEL SDK Bootstrap (`tracing.ts`)

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { Resource } from '@opentelemetry/resources';

const resource = new Resource({
  'service.name': 'tau-api',
  'service.version': process.env.FLY_IMAGE_REF ?? 'dev',
  'deployment.environment': process.env.NODE_ENV ?? 'development',
  'cloud.region': process.env.FLY_REGION ?? 'local',
  'host.id': process.env.FLY_MACHINE_ID ?? 'local',
});

const sdk = new NodeSDK({
  resource,
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 30_000,
  }),
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown());
```

### Custom Metrics Registration

```typescript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('tau-api');

export const rpcDuration = meter.createHistogram('rpc.server.call.duration', {
  description: 'RPC round-trip latency',
  unit: 's',
});

export const wsActiveConnections = meter.createUpDownCounter('ws.connections.active', {
  description: 'Active WebSocket connections',
  unit: '{connection}',
});

export const genAiTokenUsage = meter.createHistogram('gen_ai.client.token.usage', {
  description: 'LLM token consumption per request',
  unit: '{token}',
  advice: {
    explicitBucketBoundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576],
  },
});

export const kernelExecutionDuration = meter.createHistogram('kernel.execution.duration', {
  description: 'CAD kernel code evaluation time',
  unit: 's',
});
```

### Pino + NestJS Integration

```typescript
import { LoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        serializers: {
          req: (req) => ({
            method: req.method,
            url: req.url,
            remoteAddress: req.remoteAddress,
          }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      },
    }),
  ],
})
export class AppModule {}
```

## References

- [OpenTelemetry GenAI Semantic Conventions — Metrics](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics)
- [OpenTelemetry RPC Semantic Conventions — Metrics](https://opentelemetry.io/docs/specs/semconv/rpc/rpc-metrics)
- [OpenTelemetry Collector Deployment Patterns](https://opentelemetry.io/docs/collector/deployment/)
- [Grafana Cloud OTLP Endpoint](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp)
- [Fly.io OpenTelemetry Setup](https://oneuptime.com/blog/post/2026-02-06-opentelemetry-fly-io-applications/view)
- [Highlight.io OpenTelemetry Native](https://highlight.io/blog/opentelemetry)
- [SigNoz OpenTelemetry NestJS Guide](https://signoz.io/blog/opentelemetry-nestjs)
- [`@opentelemetry/instrumentation-pino`](https://www.npmjs.com/package/@opentelemetry/instrumentation-pino)
- [`@opentelemetry/instrumentation-socket.io`](https://www.npmjs.com/package/@opentelemetry/instrumentation-socket.io)
- [RED Method (Rate, Errors, Duration)](https://compilenrun.com/docs/observability/grafana/grafana-monitoring-patterns/red-method-rate-errors-duration)
- [Fly.io Monitoring](https://fly.io/docs/monitoring/)
- [Fly.io Metrics Federation via SigNoz](https://signoz.io/docs/metrics-management/fly-metrics/)
- [OpenTelemetry for AI Agents — Zylos Research](https://zylos.ai/research/2026-02-28-opentelemetry-ai-agent-observability)

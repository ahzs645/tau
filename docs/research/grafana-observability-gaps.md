---
title: 'Grafana Observability Gaps and Plugin Opportunities'
description: 'Comprehensive audit of Tau observability coverage, identifying gaps in metrics, dashboards, and traces, with Grafana plugin recommendations'
status: superseded
superseded_by: docs/research/observability-implementation-status.md
created: '2026-03-19'
updated: '2026-03-19'
category: audit
related:
  - docs/research/observability-architecture.md
  - docs/research/rpc-best-practices.md
  - docs/research/socketio-production-resilience.md
---

# Grafana Observability Gaps and Plugin Opportunities

Systematic audit of Tau's observability stack — all infrastructure components, telemetry coverage, dashboard completeness, and Grafana plugin ecosystem — to identify gaps and recommend improvements for comprehensive system understanding.

## Executive Summary

Tau's observability stack covers the core request path (HTTP, RPC, AI, kernel) with 16 canonical metrics and 7 Grafana dashboards. However, the audit reveals significant gaps: 5 of 16 defined metrics are never recorded, Loki and Tempo datasources are provisioned but unused in dashboards, alert metric names don't match OTEL Prometheus exporter output, several API services lack any instrumentation, and the `@Span()` decorator sees zero production usage. Grafana plugins — particularly the SLO app, Tempo service graph, Pyroscope profiling, and GenAI observability via OpenLIT — can close these gaps without custom development.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: Metric Recording Gaps](#finding-1-metric-recording-gaps)
- [Finding 2: Dashboard Coverage Gaps](#finding-2-dashboard-coverage-gaps)
- [Finding 3: Alert Rule Metric Name Mismatches](#finding-3-alert-rule-metric-name-mismatches)
- [Finding 4: Uninstrumented API Services](#finding-4-uninstrumented-api-services)
- [Finding 5: Unused Datasources (Loki, Tempo)](#finding-5-unused-datasources-loki-tempo)
- [Finding 6: No Template Variables](#finding-6-no-template-variables)
- [Finding 7: Missing Trace Correlation](#finding-7-missing-trace-correlation)
- [Finding 8: No Continuous Profiling](#finding-8-no-continuous-profiling)
- [Finding 9: No SLO Error Budget Tracking](#finding-9-no-slo-error-budget-tracking)
- [Finding 10: Client-Side Observability Blindspot](#finding-10-client-side-observability-blindspot)
- [Grafana Plugin Recommendations](#grafana-plugin-recommendations)
- [Recommendations](#recommendations)
- [References](#references)

## Problem Statement

Tau operates as an agentic CAD platform with multiple interacting subsystems: REST API, WebSocket/RPC, LangGraph AI agent, CAD kernel execution, PostgreSQL, Redis, and SSE streaming. The current Grafana deployment provides 7 dashboards and 5 alert rules, but the relationship between defined metrics, recorded metrics, and visualized metrics has never been systematically audited. This investigation answers: what is not being observed, and what Grafana ecosystem tools can close those gaps?

## Methodology

1. Read all 7 Grafana dashboard JSON files and provisioning configs in `infra/grafana/`
2. Read the canonical metric registry in `packages/telemetry/src/registry.ts`
3. Traced every metric recording site in `apps/api/` via source analysis
4. Cross-referenced dashboard PromQL queries against OTEL Prometheus naming conventions
5. Audited all NestJS modules for tracing/metrics instrumentation
6. Reviewed alert rules for metric name correctness
7. Researched Grafana plugin ecosystem for relevant additions

## Finding 1: Metric Recording Gaps

5 of 16 canonical metrics defined in `@taucad/telemetry` are never recorded anywhere in the API.

| Metric                   | OTEL Name                           | Type          | Status       |
| ------------------------ | ----------------------------------- | ------------- | ------------ |
| `genAiOperationDuration` | `gen_ai.client.operation.duration`  | histogram     | NOT RECORDED |
| `genAiTimeToFirstToken`  | `gen_ai.client.time_to_first_token` | histogram     | NOT RECORDED |
| `genAiAgentIterations`   | `gen_ai.agent.iterations`           | histogram     | NOT RECORDED |
| `sseActiveConnections`   | `sse.connections.active`            | upDownCounter | NOT RECORDED |
| `sseEvents`              | `sse.events`                        | counter       | NOT RECORDED |

**Impact**: The AI Agent dashboard shows "No data" for LLM p95 latency in the System Overview. Agent iteration count (a key signal for runaway loops or cost spikes) is invisible. SSE connection tracking in dashboards shows stale or zero values.

**Evidence**: `genAiOperationDuration` is dashboarded in the AI Agent panel "Operation Duration (p50/p95)" and in System Overview "LLM p95", but the `usage-tracking.middleware.ts` only records `genAiTokenUsage` and `genAiCost` — not operation duration. The `gen_ai.client.time_to_first_token` metric has custom histogram buckets defined (`[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`) but no recording code exists.

## Finding 2: Dashboard Coverage Gaps

Components with dashboards vs. components without:

| Component              | Has Dashboard                 | Has Metrics                   | Gap                                                                                   |
| ---------------------- | ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| REST API               | Yes (API Overview)            | Yes                           | —                                                                                     |
| WebSocket/RPC          | Yes                           | Yes                           | Connection Rate panel queries `ws_disconnections_total` but labels as "connections/s" |
| AI Agent               | Yes                           | Partial                       | Duration/TTFT/iterations not recorded (Finding 1)                                     |
| CAD Kernel             | Yes                           | Yes                           | Client-reported only; no server-side validation                                       |
| PostgreSQL             | Partial (Infrastructure)      | Via OTEL auto-instrumentation | No slow query analysis, no connection pool stats                                      |
| Redis                  | Partial (Infrastructure)      | `redis_connection_state` only | No command latency breakdown, no memory usage, no key eviction                        |
| SSE                    | Referenced in System Overview | NOT RECORDED                  | Dashboard shows stale data                                                            |
| Authentication         | No                            | No                            | No login rate, failure rate, or session metrics                                       |
| Code Completion        | No                            | No                            | No latency, error rate, or usage metrics                                              |
| File Edit              | No                            | No                            | No operation count or latency                                                         |
| Zoo Kernel Proxy       | No                            | No                            | No connection, latency, or error metrics                                              |
| LangGraph Checkpointer | No                            | No                            | No checkpoint save/load latency                                                       |

## Finding 3: Alert Rule Metric Name Mismatches

Alert rules in `infra/grafana/alerts/alerts.yaml` use metric names that likely don't match OTEL Prometheus exporter output.

| Alert            | Alert Uses                                       | Expected Prometheus Name                            | Match?                                    |
| ---------------- | ------------------------------------------------ | --------------------------------------------------- | ----------------------------------------- |
| RPC Failure Rate | `rpc_server_call_duration_seconds_count`         | `rpc_server_call_duration_seconds_count`            | Likely YES                                |
| High 5xx Rate    | `http_server_request_duration_seconds_count`     | `http_server_duration_seconds_count` (Fastify OTEL) | NO                                        |
| High 5xx Rate    | `http_response_status_code`                      | `http_status_code` (Fastify OTEL)                   | NO                                        |
| LLM Error Rate   | `gen_ai_client_operation_duration_seconds_count` | `gen_ai_client_operation_duration_seconds_count`    | YES (but metric not recorded — Finding 1) |

**Impact**: The "High 5xx Rate" and "LLM Error Rate" alerts may silently fail to fire. The `@fastify/otel` plugin uses `http_server_duration` as the metric name, not `http_server_request_duration`. The LLM error rate alert depends on a metric that is never recorded.

## Finding 4: Uninstrumented API Services

NestJS modules with zero observability instrumentation:

| Module                 | Service(s)                   | Risk                                                                            |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| `CodeCompletionModule` | `CodeCompletionService`      | No latency, error rate, or usage visibility for code completion requests        |
| `FileEditModule`       | `FileEditService`            | No visibility into file edit operations triggered by the AI agent               |
| `PrivacyModule`        | `PrivacyService`             | No tracking of data deletion/export requests                                    |
| `KernelsModule`        | `KernelsGateway` (Zoo proxy) | Raw WebSocket proxy with no connection count, error, or latency tracking        |
| `ModelModule`          | `ModelService`               | No visibility into model selection or configuration lookups                     |
| `AuthModule`           | Better Auth internal         | No custom metrics for login failures, session creation rate, or rate-limit hits |

**Additional gap**: The `@Span()` decorator is defined in `TracerService` and unit-tested, but has zero production usage. Manual `TracerService.withSpan()` is only used for Socket.IO trace context propagation.

## Finding 5: Unused Datasources (Loki, Tempo)

Three datasources are provisioned in `infra/grafana/provisioning/datasources/datasources.yaml`:

| Datasource | Provisioned                   | Used in Dashboards | Used in Alerts |
| ---------- | ----------------------------- | ------------------ | -------------- |
| Prometheus | Yes (default)                 | Yes (all 7)        | Yes (all 5)    |
| Loki       | Yes                           | NO                 | NO             |
| Tempo      | Yes (with correlation config) | NO                 | NO             |

Tempo is configured with `tracesToLogsV2`, `tracesToMetrics`, and `lokiSearch` for cross-signal correlation — but no dashboard uses these capabilities. The OTEL collector exports traces to Tempo and logs to Loki, meaning the data exists but is never visualized.

## Finding 6: No Template Variables

None of the 7 dashboards define template variables. All queries hardcode `service_name="tau-api"`.

**Impact**: When Tau scales to multiple service instances (Fly.io machines), multiple environments (staging/production), or adds new services, every dashboard query must be manually edited. Standard practice is to define `$service`, `$environment`, and `$instance` variables.

## Finding 7: Missing Trace Correlation

The OTEL SDK exports traces to Tempo and logs to Loki, and Tempo's datasource is configured with `tracesToLogsV2` correlation. However:

- No dashboard panel displays traces or uses the Tempo datasource
- No "Explore" links from metric panels to correlated traces
- No exemplar configuration on Prometheus histograms to link metrics → traces
- `TracerService.injectTraceContext()` propagates trace context over Socket.IO, but the end-to-end trace is never visualized

This means the trace data flowing into Tempo is effectively invisible to operators.

## Finding 8: No Continuous Profiling

The OTEL collector config (`otelcol-config.yaml`) exports profiles to Pyroscope on port 4040, and the `grafana/otel-lgtm` image includes Pyroscope. However:

- No `@pyroscope/nodejs` SDK is installed in the API
- No profiling datasource is provisioned in Grafana
- No dashboard visualizes CPU or heap profiles
- V8 heap metrics (`v8js_memory_heap_used`, `v8js_memory_heap_limit`) are shown but actual heap snapshots and CPU flame graphs are unavailable

For a Node.js app doing CPU-intensive WASM operations (kernel execution proxying) and streaming LLM responses, continuous profiling would identify bottlenecks invisible to metrics alone.

## Finding 9: No SLO Error Budget Tracking

The SLO/Executive dashboard shows point-in-time gauges (API Availability %, RPC Success Rate %, API Latency SLO), but does not track:

- Error budget remaining over time
- Burn rate (how fast the error budget is being consumed)
- Burn rate alerts (fast-burn for paging, slow-burn for tickets)
- Historical SLO compliance trends

Grafana's SLO plugin (`grafana-slo-app`) automates all of this — generating recording rules, dashboards, and multi-window burn-rate alerts from SLO definitions.

## Finding 10: Client-Side Observability Blindspot

Client telemetry is limited to kernel execution metrics POSTed to `/v1/telemetry/ingest`. Missing client signals:

| Signal                                   | Status            |
| ---------------------------------------- | ----------------- |
| Kernel execution duration                | Ingested via POST |
| Kernel export duration                   | Ingested via POST |
| WebSocket reconnection count             | Not tracked       |
| RPC request latency (client perspective) | Not tracked       |
| File system operation latency            | Not tracked       |
| Editor load time / TTI                   | Not tracked       |
| WASM module load time                    | Not tracked       |
| IndexedDB operation latency              | Not tracked       |

## Grafana Plugin Recommendations

Plugins and tools that address the identified gaps, ranked by impact and effort.

### Tier 1: High Impact, Low Effort

| Plugin/Tool                             | Type               | Addresses                                                                                                                                                                          | Effort                                                      |
| --------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Grafana SLO App** (`grafana-slo-app`) | App plugin         | Finding 9 — auto-generates error budget dashboards, burn-rate recording rules, and multi-window alerts from SLO definitions                                                        | Low — define SLOs via UI or API, plugin handles the rest    |
| **Tempo Service Graph** (built-in)      | Datasource feature | Finding 5, 7 — enable `metrics_generator` in Tempo config to auto-generate service dependency graph from traces; visualizes service-to-service latency, error rates, request rates | Low — config change in Tempo + add Node Graph panel         |
| **Tempo Trace Panels** (built-in)       | Panel              | Finding 5, 7 — add trace search and trace detail panels to dashboards; link from metric panels via exemplars or drilldown links                                                    | Low — add panels using Tempo datasource already provisioned |
| **Loki Log Panels** (built-in)          | Panel              | Finding 5 — add log panels with LogQL queries filtered by service, level, trace ID; correlate with metrics side-by-side                                                            | Low — add panels using Loki datasource already provisioned  |

### Tier 2: High Impact, Medium Effort

| Plugin/Tool                                      | Type                | Addresses                                                                                                                                                            | Effort                                                                                                                           |
| ------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **OpenLIT SDK** (`openlit`)                      | Instrumentation SDK | Finding 1 — auto-instruments LangChain/LLM calls with OTEL-native traces and metrics including operation duration, TTFT, token usage; replaces manual recording gaps | Medium — add Python SDK or use Node.js OTEL instrumentations; requires validating metric name alignment with existing dashboards |
| **Pyroscope Node.js SDK** (`@pyroscope/nodejs`)  | Instrumentation SDK | Finding 8 — continuous CPU and heap profiling with flame graph visualization in Grafana; identifies hot paths in WASM kernel execution and LLM streaming             | Medium — install SDK, add Pyroscope datasource, create profiling dashboard                                                       |
| **Redis Datasource Plugin** (`redis-datasource`) | Datasource          | Finding 2 — direct Redis introspection: `INFO`, `SLOWLOG`, memory usage, key counts, client lists; no need to instrument Redis commands in app code                  | Medium — install plugin, configure Redis connection, build Redis dashboard                                                       |
| **Node Graph Panel** (built-in)                  | Panel               | Finding 7 — visualize LangGraph agent execution as a directed graph; show tool call chains, iteration paths, and decision points                                     | Medium — requires shaping trace span data into node/edge format                                                                  |
| **Diagram Panel** (`jdbranham-diagram-panel`)    | Panel               | Finding 2 — Mermaid.js diagrams with metric-driven coloring; visualize system architecture with live health indicators                                               | Medium — define Mermaid diagrams, bind to metric queries                                                                         |

### Tier 3: Medium Impact, Medium-High Effort

| Plugin/Tool                                                 | Type       | Addresses                                                                                                                | Effort                                                               |
| ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **PostgreSQL Datasource** (`grafana-postgresql-datasource`) | Datasource | Finding 2 — query `pg_stat_statements` directly for slow query analysis, connection pool stats, table sizes, index usage | Medium — install plugin, create queries against postgres stats views |
| **Treemap Panel** (`marcusolsson-treemap-panel`)            | Panel      | New — hierarchical visualization of token usage by model, tool invocations by category, or cost breakdown                | Low-Medium — shape existing metrics into hierarchical format         |
| **Flow Panel** (`andrewbmchugh-flow-panel`)                 | Panel      | New — SVG-based system topology diagram with live metric overlays; alternative to Mermaid for more visual layouts        | Medium — create SVG, define YAML metric mappings                     |
| **Novatec Service Dependency Graph** (`novatec-sdg-panel`)  | Panel      | Finding 7 — auto-discovered service dependency visualization with latency/error/request rate per edge                    | Medium — requires consistent span naming and service attributes      |

### Tier 4: Strategic / Future

| Plugin/Tool                        | Type          | Addresses                                                                                                                                       | Effort                                                                   |
| ---------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Grafana Cloud AI Observability** | Cloud feature | Finding 1, 2 — managed GenAI monitoring with pre-built dashboards for token analytics, cost tracking, hallucination detection, model comparison | High — requires Grafana Cloud subscription; evaluate ROI vs. self-hosted |
| **Grafana Faro Web SDK**           | Client SDK    | Finding 10 — real user monitoring (RUM) for the React frontend: page load, Web Vitals, JS errors, custom events                                 | High — integrate SDK into React app, configure Faro backend              |
| **Grafana k6**                     | Load testing  | New — load testing with Grafana-native result visualization; validate SLOs under stress                                                         | Medium — write test scripts, integrate into CI                           |

## Recommendations

| #   | Action                                                                                                                                           | Priority | Effort     | Impact | Addresses    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------- | ------ | ------------ |
| R1  | Record the 5 unrecorded metrics (`genAiOperationDuration`, `genAiTimeToFirstToken`, `genAiAgentIterations`, `sseActiveConnections`, `sseEvents`) | P0       | Low        | High   | Finding 1    |
| R2  | Fix alert rule metric names to match OTEL Prometheus exporter output (`http_server_duration`, `http_status_code`)                                | P0       | Low        | High   | Finding 3    |
| R3  | Add template variables (`$service`, `$environment`) to all dashboards                                                                            | P1       | Low        | Medium | Finding 6    |
| R4  | Add Loki log panels to System Overview and API Overview dashboards                                                                               | P1       | Low        | High   | Finding 5    |
| R5  | Add Tempo trace panels with metric-to-trace drilldown links                                                                                      | P1       | Low-Medium | High   | Finding 5, 7 |
| R6  | Enable Tempo service graph metrics generator for auto-topology                                                                                   | P1       | Low        | High   | Finding 7    |
| R7  | Install Grafana SLO App and define SLOs for API availability, RPC success rate, and API latency                                                  | P1       | Low        | High   | Finding 9    |
| R8  | Instrument uninstrumented services with `@Span()` decorator (CodeCompletion, FileEdit, KernelsGateway)                                           | P1       | Medium     | Medium | Finding 4    |
| R9  | Install `@pyroscope/nodejs` and add Pyroscope datasource + flame graph dashboard                                                                 | P2       | Medium     | Medium | Finding 8    |
| R10 | Install Redis datasource plugin and build Redis deep-dive dashboard                                                                              | P2       | Medium     | Medium | Finding 2    |
| R11 | Install PostgreSQL datasource plugin for `pg_stat_statements` slow query dashboard                                                               | P2       | Medium     | Medium | Finding 2    |
| R12 | Fix WebSocket/RPC "Connection Rate" panel to use correct metric or rename                                                                        | P2       | Low        | Low    | Finding 2    |
| R13 | Evaluate Grafana Faro for client-side RUM (editor load time, WASM init, IndexedDB)                                                               | P3       | High       | High   | Finding 10   |

## References

- Existing architecture: `docs/research/observability-architecture.md`
- Telemetry package: `packages/telemetry/src/registry.ts`
- Dashboard configs: `infra/grafana/dashboards/*.json`
- Alert rules: `infra/grafana/alerts/alerts.yaml`
- OTEL bootstrap: `apps/api/app/telemetry/otel.ts`
- [Grafana SLO App](https://grafana.com/docs/plugins/grafana-slo-app/latest)
- [Tempo Service Graphs](https://grafana.com/docs/tempo/latest/metrics-generator/service_graphs/)
- [Grafana Pyroscope Node.js](https://grafana.com/docs/pyroscope/latest/configure-client/language-sdks/nodejs)
- [Redis Datasource Plugin](https://grafana.com/grafana/plugins/redis-datasource)
- [OpenLIT GenAI Observability](https://openlit.io/)
- [Grafana Faro Web SDK](https://grafana.com/docs/grafana-cloud/monitor-applications/frontend-observability/)
- [Grafana Node Graph Panel](https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/)

---
title: 'Observability Metrics Audit'
description: 'Systematic audit of all LGTM telemetry identifying configuration and implementation anomalies with remediation steps'
status: active
created: '2026-03-20'
updated: '2026-03-20'
category: audit
related:
  - docs/research/observability-architecture.md
  - docs/research/observability-implementation-status.md
---

# Observability Metrics Audit

Systematic audit of all Prometheus metrics, Tempo traces, and Loki logs from the local LGTM stack to identify configuration issues, implementation bugs, and missing instrumentation.

## Executive Summary

The local LGTM stack is operational with 104 Prometheus metrics across 15 groups. However, the audit uncovered 12 actionable issues ranging from high-cardinality noise from Prometheus scrape self-instrumentation (86% of HTTP traces are scrape noise), missing metric labels that break OTEL GenAI conventions, phantom metrics referenced by dashboards, and 22 emitted metrics with no dashboard representation. The most impactful finding is that the Prometheus metrics endpoint generates more HTTP requests than all application traffic combined, polluting both metrics and traces.

## Methodology

1. Queried Prometheus `/api/v1/label/__name__/values` for full metric inventory (104 metrics)
2. Queried each metric's label values and current state via instant queries
3. Inspected histogram bucket distributions for sanity
4. Queried Tempo traces via `docker exec` (ports 3200/3100 not host-forwarded)
5. Queried Loki for ERROR and WARN logs
6. Cross-referenced all 10 Grafana dashboard JSON files against Prometheus metric names
7. Compared emitted metrics against dashboard references to find gaps

## Findings

### Finding 1: Prometheus scrape endpoint pollutes `http_server_duration` and Tempo traces

The OTEL HTTP auto-instrumentation instruments the Prometheus metrics endpoint (`:9464`) as HTTP server requests. This creates a dominant noise source:

| Source                   | Count | % of total |
| ------------------------ | ----- | ---------- |
| GET `:9464` (scrape)     | 485   | 86.1%      |
| All app routes (`:4000`) | 78    | 13.9%      |

The scrape endpoint also generates 155 of 200 sampled traces (78%), all named "GET" with no route. Application traces for `POST /v1/chat` and RPC operations are drowned out.

**Evidence**: `http_server_duration_count{net_host_port="9464"} = 485`, zero `POST /v1/chat` traces visible in default Tempo search.

**Remediation**: Configure the `@opentelemetry/instrumentation-http` module to ignore the metrics endpoint using the `ignoreIncomingRequestHook` option in `apps/api/app/telemetry/otel.ts`:

```typescript
new HttpInstrumentation({
  ignoreIncomingRequestHook: (request) => request.headers.host?.includes(':9464') ?? false,
});
```

### Finding 2: 59 ECONNREFUSED errors to Ollama (127.0.0.1:11434)

The API continuously polls the Ollama health endpoint at startup/runtime even when Ollama isn't running:

```
http_client_request_duration_count{
  error_type="connect ECONNREFUSED 127.0.0.1:11434",
  server_address="127.0.0.1",
  server_port="11434"
} = 59
```

Each failed connection creates an error-type metric series and an error trace span, adding noise to HTTP client metrics and error tracking.

**Remediation**: Add a configuration flag (e.g., `OLLAMA_ENABLED=false`) to disable Ollama health polling when the service isn't deployed. Alternatively, implement a circuit breaker that backs off after initial connection failure.

### Finding 3: Two HTTP client metric families with inconsistent semantic conventions

Two distinct HTTP client metric families are being emitted simultaneously:

| Metric                         | Convention         | Labels                                                                             | Source                 |
| ------------------------------ | ------------------ | ---------------------------------------------------------------------------------- | ---------------------- |
| `http_client_duration`         | Old semconv        | `http_flavor`, `net_peer_name`, `http_method`, `http_status_code`                  | Morph LLM proxy        |
| `http_client_request_duration` | New stable semconv | `http_request_method`, `server_address`, `http_response_status_code`, `url_scheme` | All other HTTP clients |

Neither metric family is referenced by any dashboard, making all outbound HTTP latency invisible to operators.

**Remediation**: Set the `OTEL_SEMCONV_STABILITY_OPT_IN=http` environment variable to unify on stable semantic conventions. Add HTTP client duration panels to `api-overview.json` or `system-overview.json`.

### Finding 4: `db_client_connection_pool_name` reports `unknown_host:unknown_port/unknown_database`

The PostgreSQL connection pool instrumentation fails to resolve actual connection details:

```
db_client_connection_count{
  db_client_connection_pool_name="unknown_host:unknown_port/unknown_database",
  db_client_connection_state="idle"
} = 0
```

Both `idle` and `used` states report 0, and `db_client_connection_pending_requests` also reports 0 with the unknown pool name. The `db_client_operation_duration` metric works correctly with proper `db_namespace: tau_dev` and `server_address: localhost`.

**Remediation**: The `@opentelemetry/instrumentation-pg` auto-instrumentation likely needs connection attributes passed via `enhancedDatabaseReporting` or a newer instrumentation version that resolves pool metadata from the pg client config.

### Finding 5: `db_operation_name` has trailing newline causing series split

A single `SELECT` operation is split across two series due to a trailing newline in the label value:

```
db_client_operation_duration_count{db_operation_name="SELECT"} = 1
db_client_operation_duration_count{db_operation_name="SELECT\n"} = 1
```

This creates metric cardinality waste and breaks aggregation queries.

**Remediation**: The `@opentelemetry/instrumentation-pg` extracts the operation name from the first word of the SQL statement. A query with a leading newline (e.g., template literal formatting) produces `"SELECT\n"`. Fix the source query to avoid leading/trailing whitespace, or configure a metric view to normalize the attribute value.

### Finding 6: `gen_ai_agent_iterations` is missing all dimensional labels

The metric has zero attributes — no `gen_ai_operation_name`, `gen_ai_request_model`, or `gen_ai_provider_name`:

```
gen_ai_agent_iterations_count{} = 1
```

This makes it impossible to break down iteration counts by model, provider, or operation, limiting its diagnostic value.

**Remediation**: Update `createAgentIterationsMiddleware` to accept model context and include standard GenAI attributes when recording:

```typescript
const createAgentIterationsMiddleware = (metricsService: MetricsService): AgentMiddleware =>
  createMiddleware({
    name: 'AgentIterations',
    contextSchema: z.object({
      modelId: z.string(),
      modelService: z.custom<ModelService>(),
    }),
    stateSchema: z.object({
      _iterationCount: z.number().default(0),
    }),
    afterModel(state) {
      return { _iterationCount: state._iterationCount + 1 };
    },
    afterAgent(state, runtime) {
      if (state._iterationCount > 0) {
        const { modelId, modelService } = runtime.context;
        const otelProviderName = modelService.getOtelProviderName(modelId);
        metricsService.genAiAgentIterations.record(state._iterationCount, {
          [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
          [AttributeKey.GEN_AI_REQUEST_MODEL]: modelId,
          ...(otelProviderName ? { [AttributeKey.GEN_AI_PROVIDER_NAME]: otelProviderName } : {}),
        });
      }
    },
  });
```

### Finding 7: `gen_ai_response_model` attribute never populated

The `gen_ai_response_model` label has zero values across all GenAI metrics despite code in both `llm-timing.middleware.ts` and `usage-tracking.middleware.ts` that attempts to extract it from `response_metadata.model_name`:

```typescript
const responseModel = lastMessage.response_metadata.model_name;
```

The attribute key is registered in `@taucad/telemetry` (`GEN_AI_RESPONSE_MODEL`), but Prometheus confirms no series ever has this label. The likely cause is that Anthropic's LangChain integration uses a different key in `response_metadata` (e.g., `model` instead of `model_name`).

**Remediation**: Inspect the actual `response_metadata` structure from the Anthropic provider by logging it during a chat request. Common alternatives include `response_metadata.model`, `response_metadata.modelId`, or nested under `response_metadata.usage.model`. Update the middleware to use the correct key.

### Finding 8: `gen_ai_client_token_usage` records normalized (post-cache-subtraction) input tokens

Input token sum = 9 across 7 LLM calls (avg 1.3 tokens/call). This is the **normalized** value after subtracting cache read/write tokens from raw input tokens — correct for billing but misleading for the OTEL GenAI histogram metric.

The OTEL GenAI semantic conventions expect raw token counts in `gen_ai.client.token.usage`, not provider-specific normalized values. With Anthropic prompt caching, nearly all input tokens are cache reads, so the "normalized" input count approaches zero.

**Remediation**: Record **raw** `usage.input_tokens` in the OTEL histogram metric, and record normalized tokens separately in the stream writer for billing purposes. Alternatively, add cache token breakdown attributes so operators can derive both views:

```typescript
metricsService.genAiTokenUsage.record(usage.input_tokens, {
  // raw, not normalized
  ...metricAttributes,
  [AttributeKey.GEN_AI_TOKEN_TYPE]: GenAiTokenType.INPUT,
});
```

### Finding 9: 22 emitted app metrics have no dashboard representation

The following metrics are emitted by the API but appear in zero Grafana dashboard panels:

| Category            | Metrics                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **GenAI**           | `gen_ai_client_time_to_first_token`, `gen_ai_agent_iterations`                                                      |
| **HTTP Client**     | `http_client_duration`, `http_client_request_duration`                                                              |
| **Node.js Runtime** | `nodejs_eventloop_delay_{max,mean,min,p50,p90,p99,stddev}`, `nodejs_eventloop_time`, `nodejs_eventloop_utilization` |
| **V8**              | `v8js_gc_duration`, `v8js_memory_heap_space_{available,physical}_size`                                              |
| **WebSocket**       | `ws_connections_active`, `ws_message_size`                                                                          |
| **SSE**             | `sse_connections_active`                                                                                            |
| **RPC**             | `rpc_server_active_calls`                                                                                           |
| **Database**        | `db_client_connection_count`, `db_client_connection_pending_requests`                                               |

**Remediation**: Add dashboard panels for these metrics. Suggested dashboard assignments:

- `ai-agent.json`: TTFT histogram, agent iterations by model
- `api-overview.json`: HTTP client outbound latency, event loop utilization
- `infrastructure.json`: Node.js event loop delays, V8 GC duration, heap space breakdown
- `websocket-rpc.json`: Active WS/SSE connections, active RPC calls, message sizes
- `postgresql.json`: Connection pool utilization, pending requests

### Finding 10: Dashboards reference 6 non-existent metrics

| Dashboard             | Missing Metric                    | Reason                                                                  |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `cad-kernel.json`     | `kernel_geometry_export_duration` | Metric not implemented; the kernel export feature may not emit this yet |
| `infrastructure.json` | `fly_instance_memory_mem_total`   | Fly.io infrastructure metrics; only available in production             |
| `infrastructure.json` | `fly_instance_net_recv_bytes`     | Fly.io infrastructure metrics; only available in production             |
| `infrastructure.json` | `fly_instance_net_sent_bytes`     | Fly.io infrastructure metrics; only available in production             |
| `postgresql.json`     | `pg_total`                        | PostgreSQL native metrics not scraped; needs `postgres_exporter`        |
| `postgresql.json`     | `blks_hit`                        | PostgreSQL native metrics not scraped; needs `postgres_exporter`        |

**Remediation**: For `kernel_geometry_export_duration`, implement the metric in the kernel export code path. For Fly.io metrics, add "no data" panel messages for local environments. For PostgreSQL native metrics, either add `postgres_exporter` to the LGTM stack or replace panels with `db_client_operation_duration` queries.

### Finding 11: Loki and Tempo ports not host-forwarded

Loki (3100) and Tempo (3200) run inside the `otel-lgtm` container but are not exposed as host ports. They are accessible through Grafana's datasource proxy but not directly via `curl` from the host. This limits debugging and API scripting.

**Remediation**: Add port forwards to `docker-compose.yml`:

```yaml
ports:
  - '6100:3000' # Grafana UI
  - '4317:4317' # OTLP gRPC
  - '4318:4318' # OTLP HTTP
  - '9090:9090' # Prometheus
  - '3100:3100' # Loki
  - '3200:3200' # Tempo
```

### Finding 12: `http_server_duration` unit is milliseconds

The raw Prometheus metric declares `# UNIT http_server_duration ms`. Dashboard queries and SLO alert thresholds must account for this unit. The SLO executive dashboard uses `http_server_duration_bucket` for p99 calculations — these thresholds must use millisecond values (e.g., `le="500"` for 500ms, not `le="0.5"`).

Current bucket boundaries (from Prometheus export): `0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000`.

**Remediation**: Audit all dashboard `histogram_quantile` queries to ensure they display results in the correct unit (ms). Verify SLO threshold panels use ms-based comparisons.

## Recommendations

| #   | Action                                                                          | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Ignore metrics endpoint in HTTP instrumentation (F1, F13)                       | P0       | Low    | High   |
| R2  | Add missing dashboard panels for 22 un-visualized metrics (F9)                  | P1       | Medium | High   |
| R3  | Add `gen_ai_response_model` attribute — debug actual response_metadata key (F7) | P1       | Low    | Medium |
| R4  | Add dimensional labels to `gen_ai_agent_iterations` (F6)                        | P1       | Low    | Medium |
| R5  | Record raw input tokens in OTEL histogram, not normalized (F8)                  | P1       | Low    | Medium |
| R6  | Unify HTTP client semconv via `OTEL_SEMCONV_STABILITY_OPT_IN` (F3)              | P1       | Low    | Low    |
| R7  | Make Ollama health check conditional on `OLLAMA_ENABLED` (F2)                   | P2       | Low    | Low    |
| R8  | Fix `db_operation_name` trailing newline (F5)                                   | P2       | Low    | Low    |
| R9  | Resolve `db_client_connection_pool_name` unknown values (F4)                    | P2       | Medium | Low    |
| R10 | Forward Loki/Tempo ports in docker-compose (F11)                                | P2       | Low    | Low    |
| R11 | Handle missing production-only metrics in dashboards (F10)                      | P2       | Low    | Low    |
| R12 | Verify `http_server_duration` unit handling in dashboards (F12)                 | P2       | Low    | Low    |

## Appendix: Full Metric Inventory

104 metrics across 15 groups as of 2026-03-20:

| Group         | Count | Metrics                                                                                                                                                                                                                        |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db_client`   | 5     | `connection_count`, `connection_pending_requests`, `operation_duration_{bucket,count,sum}`                                                                                                                                     |
| `gen_ai`      | 14    | `agent_iterations_{bucket,count,sum}`, `client_cost_total`, `client_operation_duration_{bucket,count,sum}`, `client_time_to_first_token_{bucket,count,sum}`, `client_token_usage_{bucket,count,sum}`, `tool_invocations_total` |
| `http_client` | 6     | `duration_{bucket,count,sum}`, `request_duration_{bucket,count,sum}`                                                                                                                                                           |
| `http_server` | 3     | `duration_{bucket,count,sum}`                                                                                                                                                                                                  |
| `kernel`      | 4     | `execution_duration_{bucket,count,sum}`, `executions_total`                                                                                                                                                                    |
| `nodejs`      | 9     | `eventloop_delay_{max,mean,min,p50,p90,p99,stddev}`, `eventloop_time_total`, `eventloop_utilization`                                                                                                                           |
| `otelcol`     | 25    | Collector internal metrics                                                                                                                                                                                                     |
| `redis`       | 1     | `connection_state`                                                                                                                                                                                                             |
| `rpc_server`  | 4     | `active_calls`, `call_duration_{bucket,count,sum}`                                                                                                                                                                             |
| `sse`         | 2     | `connections_active`, `events_total`                                                                                                                                                                                           |
| `traces`      | 12    | Span metrics (auto-generated from Tempo)                                                                                                                                                                                       |
| `v8js`        | 7     | `gc_duration_{bucket,count,sum}`, `memory_heap_{limit,used}`, `memory_heap_space_{available,physical}_size`                                                                                                                    |
| `ws`          | 5     | `connections_active`, `disconnections_total`, `message_size_{bucket,count,sum}`                                                                                                                                                |
| Other         | 7     | `promhttp_*`, `scrape_*`, `target_info`, `up`                                                                                                                                                                                  |

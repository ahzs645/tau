---
title: 'Production Observability Readiness'
description: 'Assessment of Tau observability stack readiness for production and staging on Fly.io with Grafana Cloud, identifying gaps and remediation steps'
status: active
created: '2026-03-20'
updated: '2026-03-20'
category: audit
related:
  - docs/research/observability-implementation-status.md
  - docs/research/observability-architecture-v2.md
---

# Production Observability Readiness

Assessment of whether the Tau observability stack is production-ready on Fly.io with Grafana Cloud, covering all three signal types (metrics, traces, logs), datasource wiring, dashboard deployment, alerting, and external service integration (Supabase PostgreSQL, Redis).

## Executive Summary

The application-level instrumentation is solid: canonical metric registry, OTEL SDK with auto-instrumentations, custom dashboards-as-code, alert rules-as-code, and a sync script. However, **none of the three OTEL signals (metrics, traces, logs) currently reach Grafana Cloud in production**. Fly.io scrapes Prometheus metrics into its own managed VictoriaMetrics, but this data is isolated from Grafana Cloud unless explicitly bridged. Traces and logs require OTLP secrets that have not been set. Supabase PostgreSQL metrics are available via API but not scraped. The remediation is primarily configuration — no new application code is needed.

## Problem Statement

Tau deploys to Fly.io (staging: `tau-api-staging`, production: `tau-api`) and uses Grafana Cloud for dashboards, alerting, and observability visualization. The local development stack (`grafana/otel-lgtm` via Docker Compose) provides full LGTM parity, but the production deployment has never been validated end-to-end. This investigation determines what works, what doesn't, and the specific steps to achieve production-grade observability.

## Methodology

1. Reviewed Fly.io official documentation for metrics, logs, managed Grafana, and authentication
2. Reviewed Grafana Cloud OTLP endpoint documentation for all signal types
3. Reviewed Supabase metrics API documentation
4. Audited all IaC config files: `fly.prod.toml`, `fly.staging.toml`, `Dockerfile`, `docker-compose.yml`, `otel.ts`, datasource provisioning YAML, dashboard JSONs, alert JSONs, and the sync script
5. Cross-referenced datasource UIDs across all dashboard and alert files

## Findings

### Finding 1: Fly.io provides metrics-only managed observability

Fly.io's managed observability stack consists of:

| Component                         | Capability                                                  | Limitation                                                                               |
| --------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| VictoriaMetrics                   | Prometheus-compatible metric storage                        | No trace or log storage; query-only via API, no remote write                             |
| Managed Grafana (fly-metrics.net) | Pre-built dashboards for Fly built-in metrics               | OSS edition — no alerting, limited plugin support, can't reliably add custom datasources |
| Built-in metrics                  | ~50 automatic `fly_*` metrics (edge, app, instance, volume) | Not queryable from external Grafana without explicit datasource setup                    |
| Custom metrics scrape             | Scrapes app `[metrics]` endpoint every 15s                  | Data stays in Fly's VictoriaMetrics, not forwarded to external systems                   |
| Log Shipper                       | Vector-based log export via NATS stream                     | Requires deploying a separate Fly app (`fly-log-shipper`)                                |

Fly.io does **not** provide managed trace storage, managed log storage (queryable), or OTLP ingestion. For traces and logs, apps must export directly to an external backend.

### Finding 2: Grafana Cloud is the correct target — not fly-metrics.net

Tau's requirements exceed what fly-metrics.net provides:

| Requirement                            | fly-metrics.net      | Grafana Cloud         |
| -------------------------------------- | -------------------- | --------------------- |
| Custom dashboards (10+)                | Possible but fragile | Full API provisioning |
| Alert rules with `for` duration        | Not supported (OSS)  | Full Grafana Alerting |
| Traces (Tempo)                         | Not available        | Native OTLP ingestion |
| Logs (Loki)                            | Not available        | Native OTLP ingestion |
| Custom datasources (PostgreSQL, Redis) | Limited / unreliable | Full plugin support   |
| Profiles (Pyroscope)                   | Not available        | Available             |
| IaC dashboard/alert sync               | No API access        | Full HTTP API         |

**Verdict**: Grafana Cloud is the correct choice. fly-metrics.net should be treated as a secondary quick-look tool for Fly built-in infrastructure metrics only.

### Finding 3: Three signal types have different production paths

| Signal      | Local dev path                                                  | Production path                          | Current status                              |
| ----------- | --------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| **Metrics** | OTEL Collector scrapes `host.docker.internal:9464` → Prometheus | Fly.io scrapes `:9464` → VictoriaMetrics | Scraped but **isolated** from Grafana Cloud |
| **Traces**  | App → OTLP/HTTP → otel-lgtm Tempo                               | App → OTLP/HTTP → Grafana Cloud Tempo    | **Not configured** (no OTLP secrets)        |
| **Logs**    | App → OTLP/HTTP → otel-lgtm Loki                                | App → OTLP/HTTP → Grafana Cloud Loki     | **Not configured** (no OTLP secrets)        |

### Finding 4: Metrics require bridging from Fly.io to Grafana Cloud

Fly.io exposes a Prometheus-compatible query API:

```
https://api.fly.io/prometheus/<org-slug>/api/v1/query
Authorization: Bearer <fly-token>   (or FlyV1 <token>)
```

This can be added as a Prometheus datasource in Grafana Cloud. The alternative — adding an OTLP periodic metric exporter to the app — would create duplicate metric ingestion (Fly scrapes + OTLP push) and increase Grafana Cloud costs.

**Recommended approach**: Add Fly.io Prometheus as a Grafana Cloud datasource. This is zero-code, zero-cost (no additional ingestion), and queries the same data Fly.io already stores.

### Finding 5: Datasource UID alignment is critical

All 10 dashboard JSONs and 2 alert JSONs reference datasource UIDs. These must match exactly in Grafana Cloud:

| UID          | Type             | Used by                       | Required in Grafana Cloud              |
| ------------ | ---------------- | ----------------------------- | -------------------------------------- |
| `prometheus` | Prometheus       | All 10 dashboards, all alerts | Fly.io VictoriaMetrics endpoint        |
| `loki`       | Loki             | 9 dashboards                  | Grafana Cloud Loki (auto-provisioned)  |
| `tempo`      | Tempo            | 9 dashboards                  | Grafana Cloud Tempo (auto-provisioned) |
| `pyroscope`  | Pyroscope        | 1 dashboard                   | Grafana Cloud Profiles (if enabled)    |
| `redis`      | redis-datasource | 1 dashboard (7 panels)        | Production Redis connection string     |
| `postgresql` | postgresql       | 1 dashboard (7 panels)        | Supabase connection string             |

Grafana Cloud auto-provisions Loki, Tempo, and Prometheus datasources, but their UIDs typically follow the pattern `grafanacloud-<stack>-<type>` (e.g., `grafanacloud-tau-prom`). If the UIDs don't match, **every panel in every dashboard will show "datasource not found"**.

**Two options**:

1. Rename Grafana Cloud datasource UIDs to match (`prometheus`, `loki`, `tempo`) — possible via API
2. Update all dashboard JSONs to use Grafana Cloud's UIDs — larger change

Option 1 is recommended: set UIDs explicitly when creating datasources via the API.

### Finding 6: Supabase PostgreSQL metrics are available but not integrated

Supabase exposes ~200 PostgreSQL metrics via a Prometheus-compatible endpoint:

```
https://<project-ref>.supabase.co/customer/v1/privileged/metrics
Authorization: Basic <base64(service_role:secret_key)>
```

These include `pg_stat_activity_count`, `pg_stat_database_*`, connection pool stats, WAL stats, and more. Supabase also publishes a pre-built Grafana dashboard for import.

Currently, the Tau PostgreSQL dashboard (`postgresql.json`) uses the Grafana PostgreSQL datasource for direct SQL queries against the database (connections, cache hit ratio, table sizes). It does **not** use Supabase's Prometheus metrics.

**Integration options**:

1. Add Supabase metrics endpoint as a second Prometheus datasource in Grafana Cloud (scrape via Grafana Alloy or Grafana Agent)
2. Import Supabase's pre-built dashboard alongside the existing custom one

### Finding 7: Fly Log Shipper covers platform-level logs the app can't capture

The app's OTEL log exporter handles application logs (NestJS logger output). However, Fly.io platform events — machine starts/stops, health check failures, OOM kills, deployment events — are only available via Fly's internal NATS log stream.

The Fly Log Shipper (`ghcr.io/superfly/fly-log-shipper`) is a lightweight Vector-based app that subscribes to this stream and forwards to Loki (or other sinks). It runs as a separate Fly app and requires a readonly Fly token.

### Finding 8: Current IaC configuration has addressable gaps

| Config file                  | What's correct                                                     | What's missing                           |
| ---------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `fly.prod.toml`              | `[metrics]` port/path, `OTEL_METRICS_PORT`, compression            | `OTEL_EXPORTER_OTLP_ENDPOINT` in `[env]` |
| `fly.staging.toml`           | Same as prod                                                       | Same gap                                 |
| `Dockerfile`                 | `NODE_OPTIONS="--import .../otel.js"`, `EXPOSE 9464`               | Nothing missing                          |
| `otel.ts`                    | Conditional OTLP export, PrometheusExporter, auto-instrumentations | No trace sampling for production         |
| `deploy.yml`                 | Correct config file selection per environment                      | No post-deploy dashboard sync step       |
| `sync-grafana-dashboards.sh` | Idempotent, handles folders/dashboards/alerts                      | No datasource provisioning               |

### Finding 9: Production trace sampling is not configured

All traces are currently exported without sampling. In production, this will generate high trace volume and cost. Grafana Cloud charges $0.50/GB for trace ingestion.

The OTEL SDK supports environment-variable-driven sampling:

```
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

This samples 10% of root traces while preserving complete child spans for sampled traces. This can be added to `fly.toml` `[env]` as a non-secret configuration.

## What we're doing well

| Area                      | Evidence                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Canonical metric registry | `packages/telemetry/src/registry.ts` — all metrics defined once with JSDoc             |
| OTEL SDK initialization   | `otel.ts` — loaded via `NODE_OPTIONS` before any app code, conditional export          |
| Auto-instrumentation      | PostgreSQL, Redis, HTTP, gRPC spans via `getNodeAutoInstrumentations()`                |
| Custom business metrics   | GenAI token usage, operation duration, TTFT, agent iterations, SSE/WS gauges           |
| Dashboards-as-code        | 10 dashboard JSONs covering all subsystems                                             |
| Alerts-as-code            | 5 alert rules across 2 groups (critical + warning)                                     |
| Idempotent sync script    | `sync-grafana-dashboards.sh` handles create/update with error reporting                |
| Local dev parity          | `grafana/otel-lgtm` Docker stack with file-provisioned datasources, dashboards, alerts |
| Health probes             | `/health/ready` checks Redis + PostgreSQL + memory                                     |
| Resource enrichment       | Fly.io region, machine ID, alloc ID, image ref in OTEL resource attributes             |

## What's missing for production readiness

### Category 1: IaC-addressable (code changes in repo)

| #   | Gap                                     | Fix                                                                            | Files                               |
| --- | --------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| G1  | OTLP endpoint not in fly.toml           | Add `OTEL_EXPORTER_OTLP_ENDPOINT` to `[env]` in both fly.toml files            | `fly.prod.toml`, `fly.staging.toml` |
| G2  | No trace sampling                       | Add `OTEL_TRACES_SAMPLER` + `OTEL_TRACES_SAMPLER_ARG` to `[env]`               | `fly.prod.toml`, `fly.staging.toml` |
| G3  | Dashboard sync not in CI                | Add post-deploy step in `deploy.yml` to run `pnpm grafana:sync`                | `.github/workflows/deploy.yml`      |
| G4  | Sync script can't provision datasources | Extend script with `ensure_datasource()` function using Grafana API            | `sync-grafana-dashboards.sh`        |
| G5  | No Fly Log Shipper config               | Create `infra/fly-log-shipper/fly.toml` for platform log export                | New file                            |
| G6  | No secrets checklist                    | Create `infra/fly-secrets.md` documenting all required secrets per environment | New file                            |

### Category 2: One-time manual setup

| #   | Gap                           | Action                                                                              | Dependency                          |
| --- | ----------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| M1  | OTLP auth headers not set     | `fly secrets set OTEL_EXPORTER_OTLP_HEADERS=...` for both apps                      | Grafana Cloud OTLP token            |
| M2  | Grafana Cloud datasource UIDs | Create/rename datasources to match `prometheus`, `loki`, `tempo` UIDs               | Grafana Cloud admin access          |
| M3  | Fly.io Prometheus datasource  | Add `https://api.fly.io/prometheus/<org>` as Prometheus datasource in Grafana Cloud | Fly readonly token                  |
| M4  | PostgreSQL datasource         | Add Supabase connection in Grafana Cloud with UID `postgresql`                      | Supabase connection string          |
| M5  | Redis datasource              | Install redis-datasource plugin + add connection with UID `redis`                   | Production Redis URL                |
| M6  | GitHub environment secrets    | Add `GRAFANA_URL` + `GRAFANA_API_KEY` to staging + production environments          | Grafana Cloud service account token |
| M7  | Fly Log Shipper deployment    | Deploy log shipper app with Loki sink secrets                                       | Grafana Cloud Loki credentials      |
| M8  | Supabase metrics scrape       | Configure Grafana Cloud scrape job or Alloy for Supabase Prometheus endpoint        | Supabase service role key           |

## Recommendations

| #   | Action                                                       | Priority | Effort | Impact                                     |
| --- | ------------------------------------------------------------ | -------- | ------ | ------------------------------------------ |
| R1  | Add OTLP endpoint + sampling to fly.toml `[env]` (G1, G2)    | P0       | Low    | Unblocks traces + logs with one secret     |
| R2  | Set OTLP auth header Fly secrets (M1)                        | P0       | Low    | Enables all three signals to Grafana Cloud |
| R3  | Create Grafana Cloud datasources with matching UIDs (M2, M3) | P0       | Medium | Makes all dashboards functional            |
| R4  | Add CI dashboard sync step (G3)                              | P1       | Low    | Automates dashboard deployment             |
| R5  | Add PostgreSQL + Redis datasources (M4, M5)                  | P1       | Low    | Enables DB + Redis dashboards              |
| R6  | Add GitHub environment secrets (M6)                          | P1       | Low    | Required for R4                            |
| R7  | Create secrets checklist doc (G6)                            | P1       | Low    | Prevents knowledge loss                    |
| R8  | Extend sync script with datasource provisioning (G4)         | P2       | Medium | Full IaC datasource management             |
| R9  | Deploy Fly Log Shipper (G5, M7)                              | P2       | Medium | Captures platform-level logs               |
| R10 | Integrate Supabase Prometheus metrics (M8)                   | P3       | Medium | Deep DB observability                      |

## Deployment sequence

The recommended order to achieve production observability:

```
1. IaC changes (G1, G2, G6)          ← commit to repo
2. Set Fly secrets (M1)               ← one-time CLI commands
3. Create Grafana Cloud datasources   ← one-time API/UI setup (M2, M3, M4, M5)
4. Run sync script                    ← pnpm grafana:sync
5. Add CI sync step (G3, M6)          ← commit to repo
6. Verify all dashboards + alerts     ← manual validation
7. Deploy Fly Log Shipper (G5, M7)    ← optional, adds platform logs
8. Integrate Supabase metrics (M8)    ← optional, adds deep DB stats
```

Steps 1-4 are sufficient for a production-ready baseline covering all application metrics, traces, and logs.

## Appendix A: Fly.io built-in metrics available in Grafana Cloud

Once the Fly.io Prometheus datasource is configured (M3), these additional metrics become queryable alongside custom app metrics:

| Category         | Key metrics                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Edge proxy       | `fly_edge_http_responses_count`, `fly_edge_http_response_time_seconds`, `fly_edge_tls_handshake_time_seconds` |
| App proxy        | `fly_app_concurrency`, `fly_app_http_responses_count`, `fly_app_http_response_time_seconds`                   |
| Instance         | `fly_instance_up`, `fly_instance_load_average`, `fly_instance_cpu`, `fly_instance_memory_*`                   |
| Instance exit    | `fly_instance_exit_code`, `fly_instance_exit_oom`                                                             |
| Networking       | `fly_instance_net_recv_bytes`, `fly_instance_net_sent_bytes`                                                  |
| Disk             | `fly_instance_disk_*`, `fly_instance_filesystem_*`                                                            |
| File descriptors | `fly_instance_filefd_allocated`, `fly_instance_filefd_maximum`                                                |

These metrics carry standard labels: `app`, `region`, `host`, `instance`.

## Appendix B: Datasource provisioning API calls

For reference, the Grafana Cloud datasource creation API:

```bash
# Create Prometheus datasource pointing to Fly.io VictoriaMetrics
curl -X POST "${GRAFANA_URL}/api/datasources" \
  -H "Authorization: Bearer ${GRAFANA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Prometheus",
    "type": "prometheus",
    "uid": "prometheus",
    "access": "proxy",
    "url": "https://api.fly.io/prometheus/<org-slug>",
    "jsonData": {
      "httpHeaderName1": "Authorization"
    },
    "secureJsonData": {
      "httpHeaderValue1": "FlyV1 <readonly-token>"
    }
  }'
```

The same pattern applies for PostgreSQL (`grafana-postgresql-datasource`), Redis (`redis-datasource`), and other datasources.

## References

- [Fly.io Metrics Documentation](https://fly.io/docs/metrics-and-logs/metrics/)
- [Fly.io Log Export Documentation](https://fly.io/docs/monitoring/exporting-logs/)
- [Grafana Cloud OTLP Endpoint](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/)
- [Supabase Metrics API](https://supabase.com/docs/guides/telemetry/metrics)
- [Supabase Grafana Integration](https://supabase.com/docs/guides/telemetry/metrics/grafana-cloud)
- Related: `docs/research/observability-implementation-status.md`
- Related: `docs/research/observability-architecture-v2.md`

/**
 * OpenTelemetry SDK initialization.
 *
 * This module MUST be imported before any other application code to ensure
 * auto-instrumentations can patch modules as they load. It is imported
 * as a side-effect at the top of main.ts.
 *
 * Metrics: Exposed via PrometheusExporter on a separate port (default 9464),
 * scraped by Fly.io's managed VictoriaMetrics.
 *
 * Traces + Logs: Exported via OTLP/HTTP to Grafana Cloud (prod) or
 * grafana/otel-lgtm (local dev).
 */
/* oxlint-disable typescript-eslint/dot-notation, typescript-eslint/no-unnecessary-condition -- process.env index access required by TS4111 (verbatimModuleSyntax) */
import process from 'node:process';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const metricsPort = Number(process.env['OTEL_METRICS_PORT']) || 9464;

/* eslint-disable @typescript-eslint/naming-convention -- OTEL semantic convention attribute names use dot-notation */
const resource = resourceFromAttributes({
  'service.name': 'tau-api',
  'service.version': process.env['FLY_IMAGE_REF'] ?? 'dev',
  'deployment.environment': process.env['NODE_ENV'] ?? 'development',
  'cloud.provider': process.env['FLY_REGION'] ? 'fly.io' : 'local',
  'cloud.region': process.env['FLY_REGION'] ?? 'local',
  'host.id': process.env['FLY_MACHINE_ID'] ?? 'local',
  'host.name': process.env['FLY_ALLOC_ID'] ?? 'local',
});
/* eslint-enable @typescript-eslint/naming-convention -- end OTEL attribute names block */

const otlpEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

const hasOtlpEndpoint = Boolean(otlpEndpoint);

const sdk = new NodeSDK({
  resource,

  traceExporter: hasOtlpEndpoint ? new OTLPTraceExporter() : undefined,

  metricReader: new PrometheusExporter({ port: metricsPort }),

  logRecordProcessor: hasOtlpEndpoint ? new BatchLogRecordProcessor(new OTLPLogExporter()) : undefined,

  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-fastify': { enabled: false },
    }),
  ],
});

sdk.start();

export { sdk };

/* oxlint-disable new-cap -- NestJS decorators use PascalCase */
/* eslint-disable @typescript-eslint/member-ordering -- metrics grouped by domain, not by visibility */
/**
 * OTEL Metrics Catalog for Tau API.
 *
 * All metric definitions are derived from the canonical `TauMetrics` registry
 * in `@taucad/telemetry`, ensuring names, units, descriptions, and bucket
 * boundaries are always in sync across the stack.
 */
import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { TauMetrics } from '@taucad/telemetry';

@Injectable()
export class MetricsService {
  private readonly meter = metrics.getMeter('tau-api');
  private readonly clientMeter = metrics.getMeter('tau-client');

  // WebSocket / RPC
  public readonly rpcCallDuration = this.meter.createHistogram(TauMetrics.rpcCallDuration.name, {
    description: TauMetrics.rpcCallDuration.description,
    unit: TauMetrics.rpcCallDuration.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.rpcCallDuration.buckets] },
  });

  public readonly rpcActiveCalls = this.meter.createUpDownCounter(TauMetrics.rpcActiveCalls.name, {
    description: TauMetrics.rpcActiveCalls.description,
    unit: TauMetrics.rpcActiveCalls.unit,
  });

  public readonly wsActiveConnections = this.meter.createUpDownCounter(TauMetrics.wsActiveConnections.name, {
    description: TauMetrics.wsActiveConnections.description,
    unit: TauMetrics.wsActiveConnections.unit,
  });

  public readonly wsDisconnections = this.meter.createCounter(TauMetrics.wsDisconnections.name, {
    description: TauMetrics.wsDisconnections.description,
    unit: TauMetrics.wsDisconnections.unit,
  });

  public readonly wsMessageSize = this.meter.createHistogram(TauMetrics.wsMessageSize.name, {
    description: TauMetrics.wsMessageSize.description,
    unit: TauMetrics.wsMessageSize.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.wsMessageSize.buckets] },
  });

  // AI / LLM (GenAI semantic conventions)
  public readonly genAiTokenUsage = this.meter.createHistogram(TauMetrics.genAiTokenUsage.name, {
    description: TauMetrics.genAiTokenUsage.description,
    unit: TauMetrics.genAiTokenUsage.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.genAiTokenUsage.buckets] },
  });

  public readonly genAiOperationDuration = this.meter.createHistogram(TauMetrics.genAiOperationDuration.name, {
    description: TauMetrics.genAiOperationDuration.description,
    unit: TauMetrics.genAiOperationDuration.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.genAiOperationDuration.buckets] },
  });

  public readonly genAiTimeToFirstToken = this.meter.createHistogram(TauMetrics.genAiTimeToFirstToken.name, {
    description: TauMetrics.genAiTimeToFirstToken.description,
    unit: TauMetrics.genAiTimeToFirstToken.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.genAiTimeToFirstToken.buckets] },
  });

  public readonly genAiCost = this.meter.createCounter(TauMetrics.genAiCost.name, {
    description: TauMetrics.genAiCost.description,
    unit: TauMetrics.genAiCost.unit,
  });

  public readonly genAiToolInvocations = this.meter.createCounter(TauMetrics.genAiToolInvocations.name, {
    description: TauMetrics.genAiToolInvocations.description,
    unit: TauMetrics.genAiToolInvocations.unit,
  });

  public readonly genAiAgentIterations = this.meter.createHistogram(TauMetrics.genAiAgentIterations.name, {
    description: TauMetrics.genAiAgentIterations.description,
    unit: TauMetrics.genAiAgentIterations.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.genAiAgentIterations.buckets] },
  });

  // Infrastructure
  public readonly redisConnectionState = this.meter.createGauge(TauMetrics.redisConnectionState.name, {
    description: TauMetrics.redisConnectionState.description,
  });

  public readonly sseActiveConnections = this.meter.createUpDownCounter(TauMetrics.sseActiveConnections.name, {
    description: TauMetrics.sseActiveConnections.description,
    unit: TauMetrics.sseActiveConnections.unit,
  });

  public readonly sseEvents = this.meter.createCounter(TauMetrics.sseEvents.name, {
    description: TauMetrics.sseEvents.description,
    unit: TauMetrics.sseEvents.unit,
  });

  // Client-reported metrics (ingested via TelemetryController)
  public readonly kernelExecutionDuration = this.clientMeter.createHistogram(TauMetrics.kernelExecutionDuration.name, {
    description: TauMetrics.kernelExecutionDuration.description,
    unit: TauMetrics.kernelExecutionDuration.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.kernelExecutionDuration.buckets] },
  });

  public readonly kernelExecutions = this.clientMeter.createCounter(TauMetrics.kernelExecutions.name, {
    description: TauMetrics.kernelExecutions.description,
    unit: TauMetrics.kernelExecutions.unit,
  });

  public readonly kernelExportDuration = this.clientMeter.createHistogram(TauMetrics.kernelExportDuration.name, {
    description: TauMetrics.kernelExportDuration.description,
    unit: TauMetrics.kernelExportDuration.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.kernelExportDuration.buckets] },
  });

  // Client-reported: extended telemetry
  public readonly wsReconnectionDuration = this.clientMeter.createHistogram(TauMetrics.wsReconnectionDuration.name, {
    description: TauMetrics.wsReconnectionDuration.description,
    unit: TauMetrics.wsReconnectionDuration.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.wsReconnectionDuration.buckets] },
  });

  public readonly editorLoadDuration = this.clientMeter.createHistogram(TauMetrics.editorLoadDuration.name, {
    description: TauMetrics.editorLoadDuration.description,
    unit: TauMetrics.editorLoadDuration.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.editorLoadDuration.buckets] },
  });

  public readonly wasmModuleLoadDuration = this.clientMeter.createHistogram(TauMetrics.wasmModuleLoadDuration.name, {
    description: TauMetrics.wasmModuleLoadDuration.description,
    unit: TauMetrics.wasmModuleLoadDuration.unit,
    advice: { explicitBucketBoundaries: [...TauMetrics.wasmModuleLoadDuration.buckets] },
  });

  public readonly indexeddbOperationDuration = this.clientMeter.createHistogram(
    TauMetrics.indexeddbOperationDuration.name,
    {
      description: TauMetrics.indexeddbOperationDuration.description,
      unit: TauMetrics.indexeddbOperationDuration.unit,
      advice: { explicitBucketBoundaries: [...TauMetrics.indexeddbOperationDuration.buckets] },
    },
  );
}

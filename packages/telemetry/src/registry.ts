/* eslint-disable @typescript-eslint/naming-convention -- OTEL attribute names use dot-notation */
import { z } from 'zod';
import { defineCounter, defineHistogram, defineGauge, defineUpDownCounter } from '#define-metric.js';

/**
 * Canonical metric registry for Tau.
 *
 * All 16 metrics with OTEL-compliant names. Renames from legacy:
 * - `ws.connections.total` -> `ws.disconnections` (counters must not use `.total`)
 * - `sse.events.total` -> `sse.events` (counters must not use `.total`)
 * - `kernel.execution.total` -> `kernel.executions` (counters must be pluralized, no `.total`)
 *
 * @public
 */
export const TauMetrics = {
  // --- WebSocket / RPC ---

  rpcCallDuration: defineHistogram({
    name: 'rpc.server.call.duration',
    unit: 's',
    description: 'RPC round-trip latency',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    attributes: z.object({
      'rpc.method': z.string().optional(),
      'rpc.status': z.string().optional(),
    }),
  }),

  rpcActiveCalls: defineUpDownCounter({
    name: 'rpc.server.active_calls',
    unit: '{call}',
    description: 'Currently in-flight RPC calls',
    attributes: z.object({
      'rpc.method': z.string().optional(),
    }),
  }),

  wsActiveConnections: defineUpDownCounter({
    name: 'ws.connections.active',
    unit: '{connection}',
    description: 'Active WebSocket connections',
    attributes: z.object({}),
  }),

  wsDisconnections: defineCounter({
    name: 'ws.disconnections',
    unit: '{connection}',
    description: 'Total WebSocket disconnections by reason',
    attributes: z.object({
      'ws.close.reason': z.string().optional(),
    }),
  }),

  // --- AI / LLM (GenAI semantic conventions) ---

  genAiTokenUsage: defineHistogram({
    name: 'gen_ai.client.token.usage',
    unit: '{token}',
    description: 'LLM token consumption per request',
    buckets: [1, 4, 16, 64, 256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864],
    attributes: z.object({
      'gen_ai.request.model': z.string().optional(),
      'gen_ai.token.type': z.string().optional(),
    }),
  }),

  genAiOperationDuration: defineHistogram({
    name: 'gen_ai.client.operation.duration',
    unit: 's',
    description: 'End-to-end LLM call latency',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    attributes: z.object({
      'gen_ai.request.model': z.string().optional(),
    }),
  }),

  genAiTimeToFirstToken: defineHistogram({
    name: 'gen_ai.client.time_to_first_token',
    unit: 's',
    description: 'Streaming responsiveness (time to first SSE chunk)',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    attributes: z.object({
      'gen_ai.request.model': z.string().optional(),
    }),
  }),

  genAiCost: defineCounter({
    name: 'gen_ai.client.cost',
    unit: 'USD',
    description: 'Estimated cost per LLM call',
    attributes: z.object({
      'gen_ai.request.model': z.string().optional(),
    }),
  }),

  genAiToolInvocations: defineCounter({
    name: 'gen_ai.tool.invocations',
    unit: '{invocation}',
    description: 'Tool use frequency and success rate',
    attributes: z.object({
      'gen_ai.tool.name': z.string().optional(),
      'gen_ai.tool.status': z.string().optional(),
    }),
  }),

  genAiAgentIterations: defineHistogram({
    name: 'gen_ai.agent.iterations',
    unit: '{iteration}',
    description: 'Agent loop iterations per user request',
    buckets: [1, 2, 3, 5, 8, 13, 21, 34, 55],
    attributes: z.object({}),
  }),

  // --- Infrastructure ---

  redisConnectionState: defineGauge({
    name: 'redis.connection.state',
    unit: '',
    description: 'Redis connection health (1=connected, 0=disconnected)',
    attributes: z.object({
      'redis.role': z.string().optional(),
    }),
  }),

  sseActiveConnections: defineUpDownCounter({
    name: 'sse.connections.active',
    unit: '{connection}',
    description: 'Active SSE streams',
    attributes: z.object({}),
  }),

  sseEvents: defineCounter({
    name: 'sse.events',
    unit: '{event}',
    description: 'SSE events emitted',
    attributes: z.object({
      'sse.event.type': z.string().optional(),
    }),
  }),

  // --- Client-reported (ingested via TelemetryController) ---

  kernelExecutionDuration: defineHistogram({
    name: 'kernel.execution.duration',
    unit: 's',
    description: 'CAD kernel code evaluation time (reported by client)',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    attributes: z.object({
      'kernel.status': z.string().optional(),
    }),
  }),

  kernelExecutions: defineCounter({
    name: 'kernel.executions',
    unit: '{execution}',
    description: 'Total kernel invocations (reported by client)',
    attributes: z.object({
      'kernel.status': z.string().optional(),
    }),
  }),

  kernelExportDuration: defineHistogram({
    name: 'kernel.geometry.export.duration',
    unit: 's',
    description: 'Geometry export/conversion time (reported by client)',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    attributes: z.object({
      'kernel.status': z.string().optional(),
      'export.format': z.string().optional(),
    }),
  }),
} as const;

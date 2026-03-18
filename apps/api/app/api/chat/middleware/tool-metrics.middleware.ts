/* eslint-disable @typescript-eslint/naming-convention -- OTEL semantic convention attribute names use dot-notation */
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { AttributeKey, GenAiToolStatus } from '@taucad/telemetry';
import type { MetricsService } from '#telemetry/metrics.js';

/**
 * Create a middleware that tracks tool invocation metrics.
 *
 * Uses the `wrapToolCall` hook to count every tool invocation,
 * recording success/failure status and tool name as OTEL attributes.
 */
export const createToolMetricsMiddleware = (metricsService: MetricsService): AgentMiddleware =>
  createMiddleware({
    name: 'ToolMetrics',

    async wrapToolCall(request, handler) {
      const toolName = request.toolCall.name;

      try {
        const result = await handler(request);
        metricsService.genAiToolInvocations.add(1, {
          [AttributeKey.GEN_AI_TOOL_NAME]: toolName,
          [AttributeKey.GEN_AI_TOOL_STATUS]: GenAiToolStatus.SUCCESS,
        });
        return result;
      } catch (error) {
        metricsService.genAiToolInvocations.add(1, {
          [AttributeKey.GEN_AI_TOOL_NAME]: toolName,
          [AttributeKey.GEN_AI_TOOL_STATUS]: GenAiToolStatus.ERROR,
        });
        throw error;
      }
    },
  });

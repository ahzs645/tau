import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AttributeKey } from '@taucad/telemetry';
import type { MetricsService } from '#telemetry/metrics.js';
import type { ModelService } from '#api/models/model.service.js';

/**
 * LangChain callback handler that measures true time-to-first-token (TTFT).
 *
 * Unlike the afterModel middleware hook (which fires after the full response),
 * this handler uses handleLLMNewToken which fires per streaming token — giving
 * us the actual first-token latency. Callbacks are non-blocking and don't
 * interfere with the SSE streaming pipeline.
 */
export class TtftCallbackHandler extends BaseCallbackHandler {
  public override get name(): string {
    return 'TtftCallbackHandler';
  }

  private readonly startTimes = new Map<string, number>();
  private readonly recorded = new Set<string>();

  public constructor(
    private readonly metricsService: MetricsService,
    private readonly modelService: ModelService,
    private readonly modelId: string,
  ) {
    super();
  }

  public override handleChatModelStart(_llm: unknown, _messages: unknown[][], runId: string): void {
    this.startTimes.set(runId, performance.now());
  }

  // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain callback API uses this name
  public override handleLLMNewToken(_token: string, _index: unknown, runId: string): void {
    if (this.recorded.has(runId)) {
      return;
    }

    const startTime = this.startTimes.get(runId);
    if (startTime === undefined) {
      return;
    }

    this.recorded.add(runId);

    const ttftSeconds = (performance.now() - startTime) / 1000;
    const otelProviderName = this.modelService.getOtelProviderName(this.modelId);

    this.metricsService.genAiTimeToFirstToken.record(ttftSeconds, {
      [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
      [AttributeKey.GEN_AI_REQUEST_MODEL]: this.modelId,
      ...(otelProviderName ? { [AttributeKey.GEN_AI_PROVIDER_NAME]: otelProviderName } : {}),
    });
  }
}

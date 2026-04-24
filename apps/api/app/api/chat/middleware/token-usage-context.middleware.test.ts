// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ModelService } from '#api/models/model.service.js';
import { createTokenUsageContextMiddleware } from '#api/chat/middleware/token-usage-context.middleware.js';
import { resolveMiddlewareHook } from '#testing/middleware-testing.utils.js';

// =============================================================================
// When the model API supplies per-turn token counts (`AIMessage.usage_metadata`),
// inject a deterministic `<system-reminder>` HumanMessage carrying
// `used X / total Y / remaining Z` so the agent can self-throttle as it
// approaches the context window.
//
// Cache-safety: middleware must not mutate inputs (prepend-only, new
// instances); for identical inputs the produced byte stream must be
// deterministic so prompt caches keep hitting.
// =============================================================================

/* eslint-disable @typescript-eslint/naming-convention -- LangChain API uses snake_case */
function aiMessageWithUsage(input: number, output: number): AIMessage {
  return new AIMessage({
    content: 'reply',
    response_metadata: { model: 'm' },
    usage_metadata: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
    },
  });
}
/* eslint-enable @typescript-eslint/naming-convention -- end */

function buildModelService(contextWindow: number | undefined = 200_000): ModelService {
  const service = mock<ModelService>();
  service.getContextWindow.mockReturnValue(contextWindow);
  return service;
}

function buildModelServiceWithoutContextWindow(): ModelService {
  const service = mock<ModelService>();
  service.getContextWindow.mockReturnValue(undefined);
  return service;
}

type RequestShape = {
  systemMessage: SystemMessage;
  messages: BaseMessage[];
  state: Record<string, unknown>;
  runtime: { context: { modelId: string; modelService: ModelService } };
};

async function invoke(messages: BaseMessage[], modelService: ModelService): Promise<RequestShape> {
  const middleware = createTokenUsageContextMiddleware();
  const wrapModelCall = resolveMiddlewareHook(middleware.wrapModelCall);
  const handler = vi.fn().mockResolvedValue({ content: 'response' });

  await wrapModelCall(
    {
      systemMessage: new SystemMessage('static'),
      messages,
      state: {},
      runtime: { context: { modelId: 'm', modelService } },
    },
    handler,
  );

  /* oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- vi.fn mock.calls is typed as any[][] */
  return handler.mock.calls[0]![0] as RequestShape;
}

describe('createTokenUsageContextMiddleware', () => {
  it('does NOT inject a token-usage reminder on turn 1 (no AIMessage with usage_metadata yet)', async () => {
    const modelService = buildModelService();
    const initial: BaseMessage[] = [new HumanMessage('first user message')];

    const passed = await invoke(initial, modelService);

    expect(passed.messages).toEqual(initial);
  });

  it('does NOT inject when no AIMessage carries usage_metadata', async () => {
    const modelService = buildModelService();
    const messages: BaseMessage[] = [new HumanMessage('q'), new AIMessage('a (no usage)'), new HumanMessage('q2')];

    const passed = await invoke(messages, modelService);

    expect(passed.messages).toEqual(messages);
  });

  it('injects a deterministic <system-reminder> from turn 2 onwards using the most recent usage_metadata', async () => {
    const modelService = buildModelService(200_000);
    const messages: BaseMessage[] = [
      new HumanMessage('first'),
      aiMessageWithUsage(10_000, 500),
      new HumanMessage('second'),
    ];

    const passed = await invoke(messages, modelService);

    expect(passed.messages).toHaveLength(messages.length + 1);
    const first = passed.messages[0]!;
    expect(first).toBeInstanceOf(HumanMessage);
    const text = first.content as string;
    expect(text.startsWith('<system-reminder>')).toBe(true);
    expect(text.trimEnd().endsWith('</system-reminder>')).toBe(true);
    expect(text).toContain('Token usage');
    expect(text).toContain('10500');
    expect(text).toContain('200000');
    expect(text).toContain('189500');
  });

  it('uses the most recent AIMessage with usage_metadata when several are present', async () => {
    const modelService = buildModelService(100_000);
    const messages: BaseMessage[] = [
      new HumanMessage('first'),
      aiMessageWithUsage(1000, 100),
      new HumanMessage('second'),
      aiMessageWithUsage(50_000, 1000),
      new HumanMessage('third'),
    ];

    const passed = await invoke(messages, modelService);

    const text = passed.messages[0]!.content as string;
    expect(text).toContain('51000');
    expect(text).toContain('49000');
  });

  it('CS1: does not mutate the input messages array or any message instance', async () => {
    const modelService = buildModelService();
    const ai = aiMessageWithUsage(100, 50);
    const user = new HumanMessage('q');
    const messages: BaseMessage[] = [user, ai];
    const snapshot = [...messages];

    await invoke(messages, modelService);

    expect(messages).toEqual(snapshot);
    expect(messages[0]).toBe(user);
    expect(messages[1]).toBe(ai);
  });

  it('CS3: produces byte-identical output for byte-identical input', async () => {
    const modelService = buildModelService(50_000);
    const build = (): BaseMessage[] => [
      new HumanMessage('hello'),
      aiMessageWithUsage(123, 45),
      new HumanMessage('again'),
    ];

    const a = await invoke(build(), modelService);
    const b = await invoke(build(), modelService);

    expect(a.messages[0]!.content).toBe(b.messages[0]!.content);
  });

  it('falls back gracefully when modelService.getContextWindow returns undefined (omits remaining)', async () => {
    const modelService = buildModelServiceWithoutContextWindow();
    const messages: BaseMessage[] = [
      new HumanMessage('first'),
      aiMessageWithUsage(2000, 100),
      new HumanMessage('second'),
    ];

    const passed = await invoke(messages, modelService);

    const text = passed.messages[0]!.content as string;
    expect(text).toContain('2100');
    expect(text).not.toContain('remaining');
  });

  it('does not modify the SystemMessage', async () => {
    const modelService = buildModelService();
    const messages: BaseMessage[] = [new HumanMessage('first'), aiMessageWithUsage(10, 5), new HumanMessage('second')];

    const passed = await invoke(messages, modelService);

    expect(passed.systemMessage.content).toBe('static');
  });
});

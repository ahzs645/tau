import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { toBaseMessages } from '@ai-sdk/langchain';
import { describe, it, expect, vi } from 'vitest';
import { uiMessagesSchema } from '@taucad/chat';
import type { MyUIMessage } from '@taucad/chat';
import { messageContentSanitizerMiddleware } from '#api/chat/middleware/message-content-sanitizer.middleware.js';
import { invokeWrapModelCall } from '#testing/middleware-testing.utils.js';

/**
 * End-to-end regression for an interrupted-tool conversation: walks the
 * server pipeline (DTO Zod parse + healing -> @ai-sdk/langchain conversion ->
 * messageContentSanitizerMiddleware) without booting Nest. Mirrors the
 * legacy interrupted-tool-call payload shape (partial tool input + error text).
 */
describe('interrupted-tool-call round-trip', () => {
  const buildLegacyAppendixPayload = (): MyUIMessage[] => [
    {
      id: 'u_initial',
      role: 'user',
      parts: [{ type: 'text', text: 'Open main.ts and continue.' }],
    },
    {
      id: 'a_interrupted',
      role: 'assistant',
      parts: [
        // Legacy persisted shape captured in the appendix:
        // - input present but missing required `targetFile`
        // - errorText sans `toolName`
        // - rawInput absent
        {
          type: 'tool-read_file',
          toolCallId: 'call_legacy_read',
          state: 'output-error',
          input: { limit: 15 },
          errorText: JSON.stringify({
            errorCode: 'USER_INTERRUPTED',
            message: 'Interrupted by user.',
            toolCallId: 'call_legacy_read',
          }),
        } as unknown as MyUIMessage['parts'][number],
      ],
    },
    {
      id: 'u_followup',
      role: 'user',
      parts: [{ type: 'text', text: 'continue' }],
    },
  ];

  it('should accept the legacy appendix payload via uiMessagesSchema and demote partial input to rawInput', () => {
    const result = uiMessagesSchema.safeParse(buildLegacyAppendixPayload());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Schema rejected legacy payload: ${result.error.message}`);
    }

    const assistantMessage = result.data[1];
    if (!assistantMessage) {
      throw new Error('expected assistant message in parsed result');
    }
    const toolPart = assistantMessage.parts[0];
    if (toolPart?.type !== 'tool-read_file' || toolPart.state !== 'output-error') {
      throw new Error('expected tool-read_file output-error part');
    }

    expect(toolPart.input).toBeUndefined();
    expect((toolPart as { rawInput?: unknown }).rawInput).toEqual({ limit: 15 });
  });

  it('should carry the demoted rawInput through to the AIMessage tool_call.args', async () => {
    const parsed = uiMessagesSchema.parse(buildLegacyAppendixPayload());
    const baseMessages = await toBaseMessages(parsed);

    const aiMessage = baseMessages.find(
      (message): message is AIMessage => AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0,
    );
    if (!aiMessage) {
      throw new Error('expected an AIMessage with tool_calls in the converted base messages');
    }
    expect(aiMessage.tool_calls).toBeDefined();
    const toolCall = aiMessage.tool_calls?.[0];
    if (!toolCall) {
      throw new Error('expected at least one tool_call');
    }
    expect(toolCall.id).toBe('call_legacy_read');
    expect(toolCall.name).toBe('read_file');
    expect(toolCall.args).toEqual({ limit: 15 });
  });

  it('should produce a tool_call paired with a tool_result so no orphan synthesis is needed', async () => {
    const parsed = uiMessagesSchema.parse(buildLegacyAppendixPayload());
    const baseMessages = await toBaseMessages(parsed);
    const handler = vi.fn().mockResolvedValue({ content: 'response' });

    await invokeWrapModelCall(messageContentSanitizerMiddleware, { messages: baseMessages }, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];

    const aiMessage = request.messages.find(
      (message): message is AIMessage => AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0,
    );
    if (!aiMessage) {
      throw new Error('expected an AIMessage with tool_calls in the sanitized stream');
    }
    const toolCallId = aiMessage.tool_calls?.[0]?.id;
    expect(toolCallId).toBe('call_legacy_read');

    const pairedToolMessages = request.messages.filter(
      (message): message is ToolMessage => ToolMessage.isInstance(message) && message.tool_call_id === toolCallId,
    );
    expect(pairedToolMessages).toHaveLength(1);

    const [tool] = pairedToolMessages;
    if (!tool) {
      throw new Error('expected a paired ToolMessage');
    }
    const content = JSON.parse(tool.content as string) as { errorCode: string };
    expect(content.errorCode).toBe('USER_INTERRUPTED');
  });

  it('should round-trip a modern finalizer payload (rawInput, toolName-bearing errorText)', async () => {
    const modernPayload: MyUIMessage[] = [
      { id: 'u_initial', role: 'user', parts: [{ type: 'text', text: 'Open main.ts.' }] },
      {
        id: 'a_modern_interrupt',
        role: 'assistant',
        parts: [
          {
            type: 'tool-read_file',
            toolCallId: 'call_modern',
            state: 'output-error',
            input: undefined,
            rawInput: { limit: 15 },
            errorText: JSON.stringify({
              errorCode: 'USER_INTERRUPTED',
              message: 'Interrupted by user.',
              toolName: 'read_file',
              toolCallId: 'call_modern',
            }),
          } as unknown as MyUIMessage['parts'][number],
        ],
      },
      { id: 'u_followup', role: 'user', parts: [{ type: 'text', text: 'continue' }] },
    ];
    const parsed = uiMessagesSchema.parse(modernPayload);
    const baseMessages = await toBaseMessages(parsed);
    const handler = vi.fn().mockResolvedValue({ content: 'response' });

    await invokeWrapModelCall(messageContentSanitizerMiddleware, { messages: baseMessages }, handler);

    const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
    const aiMessage = request.messages.find(
      (message): message is AIMessage => AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0,
    );
    if (!aiMessage) {
      throw new Error('expected modern AIMessage with tool_calls');
    }
    expect(aiMessage.tool_calls?.[0]).toMatchObject({
      id: 'call_modern',
      name: 'read_file',
      args: { limit: 15 },
    });
    const tool = request.messages.find(
      (message): message is ToolMessage => ToolMessage.isInstance(message) && message.tool_call_id === 'call_modern',
    );
    if (!tool) {
      throw new Error('expected paired ToolMessage for modern payload');
    }
    const content = JSON.parse(tool.content as string) as {
      errorCode: string;
      toolName: string;
    };
    expect(content.errorCode).toBe('USER_INTERRUPTED');
    expect(content.toolName).toBe('read_file');
  });
});

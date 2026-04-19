import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { ToolMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { rpcName } from '@taucad/chat/constants';
import type { ChatRpcService } from '#api/chat/chat-rpc.service.js';

const transcriptContextSchema = z.object({
  chatId: z.string(),
});

/**
 * Appends a single JSONL line to the transcript file via the appendFile RPC.
 * Fire-and-forget: errors are swallowed to avoid disrupting the agent loop.
 */
export async function appendTranscriptLine(
  chatRpcService: ChatRpcService,
  chatId: string,
  line: Record<string, unknown>,
): Promise<void> {
  try {
    await chatRpcService.sendRpcRequest({
      chatId,
      toolCallId: 'transcript',
      rpcName: rpcName.appendFile,
      args: {
        targetFile: `.tau/transcripts/${chatId}.jsonl`,
        content: JSON.stringify(line) + '\n',
      },
    });
  } catch {
    // Non-blocking: transcript failures must not disrupt the agent loop
  }
}

/**
 * Appends multiple JSONL lines to the transcript file in a single appendFile RPC.
 * Fire-and-forget: errors are swallowed to avoid disrupting the agent loop.
 */
async function appendTranscriptLines(
  chatRpcService: ChatRpcService,
  chatId: string,
  lines: Array<Record<string, unknown>>,
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  try {
    await chatRpcService.sendRpcRequest({
      chatId,
      toolCallId: 'transcript',
      rpcName: rpcName.appendFile,
      args: {
        targetFile: `.tau/transcripts/${chatId}.jsonl`,
        content: lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      },
    });
  } catch {
    // Non-blocking: transcript failures must not disrupt the agent loop
  }
}

/**
 * Content block from an AI message with structured content.
 * LangChain uses `type: 'reasoning'` with a `reasoning` field for extended thinking,
 * and `type: 'text'` with a `text` field for regular content.
 */
type ContentBlock = {
  type: string;
  text?: string;
  reasoning?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

/**
 * Appends transcript lines for an assistant message. When content is a string,
 * writes one line. When it's an array of content blocks, coalesces adjacent
 * same-type blocks and writes all lines in a single batched RPC.
 *
 * Coalescing is critical for streaming thinking models (GPT-5, Claude): they
 * produce one content block per streaming chunk, which without coalescing would
 * create thousands of concurrent RPCs per model response.
 *
 * Dropped from transcript (per context-engineering-policy):
 * - `signature` fields (opaque binary, not greppable)
 * - `tool_use` blocks (captured separately by wrapToolCall)
 */
function appendAssistantContent(chatRpcService: ChatRpcService, chatId: string, content: BaseMessage['content']): void {
  const timestamp = new Date().toISOString();

  if (typeof content === 'string') {
    void appendTranscriptLine(chatRpcService, chatId, {
      role: 'assistant',
      content,
      timestamp,
    });
    return;
  }

  const lines: Array<Record<string, unknown>> = [];

  for (const block of content as ContentBlock[]) {
    if (block.type === 'reasoning' && block.reasoning) {
      const previous = lines.at(-1);
      if (previous?.['type'] === 'thinking') {
        // oxlint-disable-next-line eslint/operator-assignment -- Explicit form required to satisfy restrict-plus-operands (content is unknown)
        previous['content'] = (previous['content'] as string) + block.reasoning;
      } else {
        lines.push({ role: 'assistant', type: 'thinking', content: block.reasoning, timestamp });
      }
    } else if (block.type === 'text' && block.text) {
      const previous = lines.at(-1);
      if (previous && !previous['type']) {
        // oxlint-disable-next-line eslint/operator-assignment -- Explicit form required to satisfy restrict-plus-operands (content is unknown)
        previous['content'] = (previous['content'] as string) + block.text;
      } else {
        lines.push({ role: 'assistant', content: block.text, timestamp });
      }
    }
    // Tool_use blocks are skipped — captured by wrapToolCall
  }

  if (lines.length > 0) {
    void appendTranscriptLines(chatRpcService, chatId, lines);
  }
}

function messageContent(message: BaseMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

/**
 * Creates middleware that appends conversation events as JSONL to
 * `.tau/transcripts/{chatId}.jsonl` using the appendFile RPC.
 *
 * Records user messages (beforeModel), assistant responses (afterModel),
 * and tool results (wrapToolCall). All writes are fire-and-forget to
 * prevent transcript errors from disrupting the agent loop.
 *
 * Schema per line:
 * - `{ role: "user", content, timestamp }` — full user message text
 * - `{ role: "assistant", content, timestamp }` — full assistant text response
 * - `{ role: "assistant", type: "thinking", content, timestamp }` — thinking block
 * - `{ role: "tool", toolName, toolCallId, contentLength, timestamp }` — metadata only
 */
export const createTranscriptMiddleware = (chatRpcService: ChatRpcService): AgentMiddleware => {
  let userMessageLogged = false;

  return createMiddleware({
    name: 'Transcript',
    contextSchema: transcriptContextSchema,

    beforeModel(state, runtime) {
      if (userMessageLogged) {
        return;
      }

      const { context } = runtime;
      const { chatId } = context;

      /* oxlint-disable-next-line @typescript-eslint/no-unsafe-call -- LangChain state.messages is typed as any */
      const messages = state.messages as BaseMessage[];
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message instanceof HumanMessage) {
          userMessageLogged = true;
          void appendTranscriptLine(chatRpcService, chatId, {
            role: 'user',
            content: messageContent(message),
            timestamp: new Date().toISOString(),
          });
          break;
        }
      }
    },

    afterModel(state, runtime) {
      const { context } = runtime;
      const { chatId } = context;

      /* oxlint-disable-next-line @typescript-eslint/no-unsafe-call -- LangChain state.messages is typed as any */
      const lastMessage = state.messages.at(-1) as BaseMessage | undefined;

      if (!lastMessage) {
        return;
      }

      appendAssistantContent(chatRpcService, chatId, lastMessage.content);
    },

    async wrapToolCall(request, handler) {
      const result = await handler(request);
      const { context } = request.runtime;
      const { chatId } = context;

      if (result instanceof ToolMessage) {
        const contentLength =
          typeof result.content === 'string' ? result.content.length : JSON.stringify(result.content).length;

        void appendTranscriptLine(chatRpcService, chatId, {
          role: 'tool',
          toolName: result.name ?? 'unknown',
          toolCallId: result.tool_call_id,
          contentLength,
          timestamp: new Date().toISOString(),
        });
      }

      return result;
    },
  });
};

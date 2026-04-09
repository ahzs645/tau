import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { Environment } from '#config/environment.config.js';

/**
 * Statistics from a compaction operation.
 */
export type CompactionStats = {
  tokensBeforeCompaction: number;
  tokensAfterCompaction: number;
  compressionRatio: number;
  messagesEvicted: number;
};

/**
 * NestJS injectable service for context compaction.
 * Currently backed by the Morph Compact API for verbatim compression.
 */
@Injectable()
export class CompactionService {
  private readonly logger = new Logger(CompactionService.name);
  private readonly apiKey: string;
  private get apiUrl() {
    return 'https://api.morphllm.com/v1/chat/completions';
  }

  public constructor(private readonly configService: ConfigService<Environment, true>) {
    const morphApiKey = this.configService.get<string>('MORPH_API_KEY', { infer: true });
    if (!morphApiKey) {
      throw new Error('MORPH_API_KEY is required for context compaction functionality');
    }
    this.apiKey = morphApiKey;
  }

  /**
   * Compact messages using Morph's verbatim compaction API.
   * Morph preserves exact content (no paraphrasing) while removing redundant context.
   */
  public async compact(options: {
    messages: BaseMessage[];
    query: string;
    keepContextTags?: string[];
  }): Promise<{ compactedMessages: BaseMessage[]; stats: CompactionStats }> {
    const { messages, query, keepContextTags = [] } = options;

    const morphMessages = this.toMorphFormat(messages, keepContextTags);
    const inputTokenEstimate = this.estimateTokens(morphMessages);

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header name
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'morph-compactor',
        messages: [...morphMessages, { role: 'user', content: query }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Morph API error: ${response.status} ${errorText}`);
      throw new Error(`Morph compaction failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const compactedContent = data.choices[0]?.message.content ?? '';
    const compactedMessages = this.parseCompactedOutput(compactedContent);
    const outputTokenEstimate = this.estimateTokens(
      compactedMessages.map((m) => ({
        role: m instanceof HumanMessage ? 'user' : m instanceof AIMessage ? 'assistant' : 'system',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    );

    const stats: CompactionStats = {
      tokensBeforeCompaction: inputTokenEstimate,
      tokensAfterCompaction: outputTokenEstimate,
      compressionRatio: inputTokenEstimate > 0 ? outputTokenEstimate / inputTokenEstimate : 1,
      messagesEvicted: messages.length - compactedMessages.length,
    };

    this.logger.log(
      `Compacted ${messages.length} messages → ${compactedMessages.length} ` +
        `(${stats.tokensBeforeCompaction} → ${stats.tokensAfterCompaction} tokens, ` +
        `${((1 - stats.compressionRatio) * 100).toFixed(1)}% reduction)`,
    );

    return { compactedMessages, stats };
  }

  private toMorphFormat(messages: BaseMessage[], keepContextTags: string[]): Array<{ role: string; content: string }> {
    return messages.map((message) => {
      let content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

      for (const tag of keepContextTags) {
        if (content.includes(tag)) {
          content = `<keepContext>${content}</keepContext>`;
          break;
        }
      }

      if (message instanceof SystemMessage) {
        return { role: 'system', content };
      }
      if (message instanceof HumanMessage) {
        return { role: 'user', content };
      }
      if (message instanceof ToolMessage) {
        return { role: 'tool', content };
      }
      return { role: 'assistant', content };
    });
  }

  private parseCompactedOutput(content: string): BaseMessage[] {
    // Morph returns compacted content as a single assistant message
    // containing the compressed conversation context
    if (!content.trim()) {
      return [];
    }

    return [new HumanMessage(`[Compacted conversation history]\n${content}`)];
  }

  private estimateTokens(messages: Array<{ role: string; content: string }>): number {
    let totalChars = 0;
    for (const message of messages) {
      totalChars += message.content.length;
    }

    // ~4 characters per token is a conservative estimate
    return Math.ceil(totalChars / 4);
  }
}

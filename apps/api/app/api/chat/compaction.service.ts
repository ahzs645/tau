import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { Environment } from '#config/environment.config.js';
import { formatCompactSummary } from '#api/chat/utils/format-compact-summary.js';
import { isImageBlock, countImageBlocks } from '#api/chat/utils/image-block.utils.js';

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

    const compactionPrompt = `${query}

Respond with TEXT ONLY. Your response must be an <analysis> block followed by a <summary> block.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis, chronologically examine each message, identify user requests, decisions, code patterns, errors, and user feedback. Then produce the structured summary inside <summary> tags.

<summary> sections:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages (verbatim quotes of key requests)
7. Pending Tasks
8. Current Work
9. Optional Next Step — ensure this step is DIRECTLY in line with the user's most recent explicit requests

Use verbatim quotes from the conversation where possible to anchor context.`;

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header name
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'morph-compactor',
        messages: [...morphMessages, { role: 'user', content: compactionPrompt }],
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

    const rawContent = data.choices[0]?.message.content ?? '';
    const compactedContent = formatCompactSummary(rawContent);
    const evictedImageCount = countImageBlocks(messages);
    const compactedMessages = this.parseCompactedOutput(compactedContent, evictedImageCount);
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
      let content: string;

      if (typeof message.content === 'string') {
        content = message.content;
      } else if (Array.isArray(message.content)) {
        const parts: string[] = [];
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (isImageBlock(block)) {
            parts.push('[image]');
          } else {
            const text = (block['text'] ?? block['reasoning'] ?? '') as string;
            if (text) {
              parts.push(text);
            }
          }
        }
        content = parts.join('\n');
      } else {
        content = JSON.stringify(message.content);
      }

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

  private parseCompactedOutput(content: string, evictedImageCount: number): BaseMessage[] {
    if (!content.trim()) {
      return [];
    }

    const imageNote = evictedImageCount > 0 ? ` — ${evictedImageCount} image(s) from prior context omitted` : '';
    return [new HumanMessage(`[Compacted conversation history${imageNote}]\n${content}`)];
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { CompactionService } from '#api/chat/compaction.service.js';

describe('CompactionService', () => {
  let service: CompactionService;
  let moduleRef: TestingModule | undefined;
  const originalFetch = globalThis.fetch;
  const createService = async (morphApiKey: string | undefined): Promise<CompactionService> => {
    moduleRef = await Test.createTestingModule({
      providers: [
        CompactionService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockReturnValue(morphApiKey),
          },
        },
      ],
    }).compile();

    return moduleRef.get<CompactionService>(CompactionService);
  };

  beforeEach(async () => {
    service = await createService('test-key');
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined;
    }
  });

  it('should throw when MORPH_API_KEY is missing', async () => {
    await expect(createService(undefined)).rejects.toThrow(
      'MORPH_API_KEY is required for context compaction functionality',
    );
  });

  it('should call Morph API with correct parameters', async () => {
    const mockResponse = {
      choices: [{ message: { content: 'Compacted summary of conversation.' } }],
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Morph API response uses snake_case
      usage: { prompt_tokens: 500, completion_tokens: 50 },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const messages = [new HumanMessage('Hello'), new AIMessage('Hi there!')];

    await service.compact({ messages, query: 'What did we discuss?' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.morphllm.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
        headers: expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header name
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });

  it('should parse compacted messages correctly', async () => {
    const compactedContent = 'The user greeted, the assistant responded warmly.';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: compactedContent } }],
      }),
    });

    const { compactedMessages } = await service.compact({
      messages: [new HumanMessage('Hello'), new AIMessage('Hi')],
      query: 'Summary',
    });

    expect(compactedMessages).toHaveLength(1);
    expect(compactedMessages[0]).toBeInstanceOf(HumanMessage);
    expect(compactedMessages[0]!.content).toContain(compactedContent);
  });

  it('should handle API errors gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(
      service.compact({
        messages: [new HumanMessage('test')],
        query: 'test',
      }),
    ).rejects.toThrow('Morph compaction failed: 500');
  });

  it('should calculate compression stats', async () => {
    const longContent = 'A'.repeat(4000);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Short summary.' } }],
      }),
    });

    const { stats } = await service.compact({
      messages: [new HumanMessage(longContent), new AIMessage(longContent)],
      query: 'Summarize',
    });

    expect(stats.tokensBeforeCompaction).toBeGreaterThan(stats.tokensAfterCompaction);
    expect(stats.compressionRatio).toBeLessThan(1);
    expect(stats.compressionRatio).toBeGreaterThan(0);
  });

  it('should return empty messages for empty compacted output', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '' } }],
      }),
    });

    const { compactedMessages } = await service.compact({
      messages: [new HumanMessage('test')],
      query: 'test',
    });

    expect(compactedMessages).toHaveLength(0);
  });
});

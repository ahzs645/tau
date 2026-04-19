/* eslint-disable @typescript-eslint/naming-convention -- LangChain content blocks use snake_case (image_url) */
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

  // ===================================================================
  // R3: Strip images before Morph (toMorphFormat)
  // ===================================================================

  it('should replace image_url blocks with [image] marker in Morph payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Summary.' } }],
      }),
    });

    await service.compact({
      messages: [
        new HumanMessage([
          { type: 'text', text: 'Look at this design:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(500_000) } },
        ]),
      ],
      query: 'Summarize',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(fetchCall[1].body as string) as { messages: Array<{ role: string; content: string }> };
    const userMessage = body.messages.find((m) => m.role === 'user' && !m.content.includes('Respond with TEXT ONLY'));
    expect(userMessage).toBeDefined();
    expect(userMessage!.content).toContain('[image]');
    expect(userMessage!.content).toContain('Look at this design:');
    expect(userMessage!.content).not.toContain('base64');
  });

  it('should replace file parts with image mediaType with [image] marker', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Summary.' } }],
      }),
    });

    await service.compact({
      messages: [new HumanMessage([{ type: 'file', mediaType: 'image/jpeg', data: 'A'.repeat(500_000) }])],
      query: 'Summarize',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(fetchCall[1].body as string) as { messages: Array<{ role: string; content: string }> };
    const userMessage = body.messages.find((m) => m.role === 'user' && !m.content.includes('Respond with TEXT ONLY'));
    expect(userMessage).toBeDefined();
    expect(userMessage!.content).toContain('[image]');
    expect(userMessage!.content).not.toContain('base64');
  });

  it('should preserve text and reasoning blocks when stripping images for Morph', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Summary.' } }],
      }),
    });

    await service.compact({
      messages: [
        new AIMessage([
          { type: 'reasoning', reasoning: 'Thinking about design' },
          { type: 'text', text: 'Here is my analysis' },
        ]),
      ],
      query: 'Summarize',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(fetchCall[1].body as string) as { messages: Array<{ role: string; content: string }> };
    const assistantMessage = body.messages.find((m) => m.role === 'assistant');
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage!.content).toContain('Thinking about design');
    expect(assistantMessage!.content).toContain('Here is my analysis');
  });

  it('should handle messages with only image content for Morph', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Summary.' } }],
      }),
    });

    await service.compact({
      messages: [new HumanMessage([{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }])],
      query: 'Summarize',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(fetchCall[1].body as string) as { messages: Array<{ role: string; content: string }> };
    const userMessage = body.messages.find((m) => m.role === 'user' && !m.content.includes('Respond with TEXT ONLY'));
    expect(userMessage).toBeDefined();
    expect(userMessage!.content).toBe('[image]');
  });

  // ===================================================================
  // R7: Image markers in compacted summary
  // ===================================================================

  it('should include image count in compacted summary when images were evicted', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'User showed a design and asked for feedback.' } }],
      }),
    });

    const { compactedMessages } = await service.compact({
      messages: [
        new HumanMessage([
          { type: 'text', text: 'Look at this:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ]),
        new AIMessage('Nice design!'),
        new HumanMessage([{ type: 'file', mediaType: 'image/jpeg', data: 'def' }]),
      ],
      query: 'Summarize',
    });

    expect(compactedMessages).toHaveLength(1);
    const content = compactedMessages[0]!.content as string;
    expect(content).toContain('2 image(s)');
    expect(content).toContain('omitted');
  });

  it('should show zero image count when no images were evicted', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'User discussed text-only topics.' } }],
      }),
    });

    const { compactedMessages } = await service.compact({
      messages: [new HumanMessage('Hello'), new AIMessage('Hi there!')],
      query: 'Summarize',
    });

    expect(compactedMessages).toHaveLength(1);
    const content = compactedMessages[0]!.content as string;
    expect(content).toContain('[Compacted conversation history]');
    expect(content).not.toContain('image(s)');
  });

  it('should count images across all evicted messages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'User shared multiple images.' } }],
      }),
    });

    const { compactedMessages } = await service.compact({
      messages: [
        new HumanMessage([
          { type: 'image_url', image_url: { url: 'data:image/png;base64,a' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,b' } },
        ]),
        new AIMessage('Two images received'),
        new HumanMessage([{ type: 'image_url', image_url: { url: 'data:image/png;base64,c' } }]),
      ],
      query: 'Summarize',
    });

    expect(compactedMessages).toHaveLength(1);
    const content = compactedMessages[0]!.content as string;
    expect(content).toContain('3 image(s)');
  });

  // ===================================================================
  // R15: Structured summary schema and drift prevention
  // ===================================================================

  it('should include structured summary schema in compaction prompt', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Summary.' } }],
      }),
    });

    await service.compact({
      messages: [new HumanMessage('Hello'), new AIMessage('Hi')],
      query: 'What did we discuss?',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(fetchCall[1].body as string) as { messages: Array<{ role: string; content: string }> };
    const lastMessage = body.messages.at(-1)!;
    expect(lastMessage.content).toContain('Primary Request');
    expect(lastMessage.content).toContain('Key Technical Concepts');
    expect(lastMessage.content).toContain('Pending Tasks');
    expect(lastMessage.content).toContain('Current Work');
  });

  it('should include drift-prevention guard in compaction prompt', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Summary.' } }],
      }),
    });

    await service.compact({
      messages: [new HumanMessage('Hello'), new AIMessage('Hi')],
      query: 'What did we discuss?',
    });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(fetchCall[1].body as string) as { messages: Array<{ role: string; content: string }> };
    const lastMessage = body.messages.at(-1)!;
    expect(lastMessage.content).toMatch(/directly in line with.*user.*explicit/i);
  });
});

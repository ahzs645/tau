import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { createAgent } from 'langchain';
import { ChatService } from '#api/chat/chat.service.js';
import { ModelService } from '#api/models/model.service.js';
import { ToolService } from '#api/tools/tool.service.js';
import { CheckpointerService } from '#api/chat/checkpointer.service.js';
import { CompactionService } from '#api/chat/compaction.service.js';
import { TauRpcBackendFactory } from '#api/chat/tau-rpc-backend.js';
import { ChatRpcService } from '#api/chat/chat-rpc.service.js';
import { MetricsService } from '#telemetry/metrics.js';
import { newlineTrimmerMiddleware } from '#api/chat/middleware/newline-trimmer.middleware.js';
import { latexDelimiterMiddleware } from '#api/chat/middleware/latex-delimiter.middleware.js';

// Mock other dependencies
vi.mock('ai', () => ({
  streamText: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn(() => 'mocked-model'),
}));

vi.mock('langchain', () => ({
  createAgent: vi.fn(() => ({})),
  createMiddleware: vi.fn((config: unknown) => config),
}));

vi.mock('#api/chat/prompts/cad-agent.prompt.js', () => ({
  getCadSystemPrompt: vi.fn().mockResolvedValue({ static: 'static prompt', dynamic: 'dynamic prompt' }),
}));

vi.mock('#api/chat/utils/create-cached-system-message.js', () => ({
  createCachedSystemMessage: vi.fn((options: unknown) => options),
}));

describe('ChatService', () => {
  let service: ChatService;
  let module: TestingModule;

  const mockCheckpointer = { id: 'mock-checkpointer' };

  const mockCheckpointerService = {
    getCheckpointer: vi.fn(() => mockCheckpointer),
  };

  const mockModelService = {
    buildModel: vi.fn(() => ({ model: 'mock-model' })),
    getContextWindow: vi.fn(() => 200_000),
    getProviderId: vi.fn(() => 'openai'),
    getKnowledgeCutoff: vi.fn(() => '2025-08'),
  };

  const mockToolService = {
    getTools: vi.fn(() => ({
      tools: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Tool name uses snake_case
        test_model: { name: 'test_model' },
      },
    })),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const mockChatRpcService = { sendRpcRequest: vi.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: CheckpointerService, useValue: mockCheckpointerService },
        { provide: ModelService, useValue: mockModelService },
        { provide: ToolService, useValue: mockToolService },
        { provide: MetricsService, useValue: new MetricsService() },
        { provide: CompactionService, useValue: { compact: vi.fn() } },
        { provide: TauRpcBackendFactory, useValue: { create: vi.fn() } },
        { provide: ChatRpcService, useValue: mockChatRpcService },
      ],
    }).compile();

    service = moduleRef.get<ChatService>(ChatService);
    module = moduleRef;
  });

  afterEach(async () => {
    await module.close();
  });

  describe('createAgent', () => {
    it('should get checkpointer from CheckpointerService', async () => {
      // Act
      await service.createAgent({
        chatId: 'test-chat-1',
        modelId: 'model-1',
        kernel: 'openscad',
        tools: { choice: 'auto' },
      });

      // Assert
      expect(mockCheckpointerService.getCheckpointer).toHaveBeenCalledTimes(1);
    });

    it('should reuse the same checkpointer across multiple agent creations', async () => {
      // Act - create multiple agents (simulating multiple chat requests)
      await service.createAgent({
        chatId: 'test-chat-1',
        modelId: 'model-1',
        kernel: 'openscad',
        tools: { choice: 'auto' },
      });
      await service.createAgent({
        chatId: 'test-chat-1',
        modelId: 'model-2',
        kernel: 'replicad',
        tools: { choice: 'auto' },
      });
      await service.createAgent({
        chatId: 'test-chat-1',
        modelId: 'model-3',
        kernel: 'jscad',
        tools: { choice: 'auto' },
      });

      // Assert - checkpointer retrieved each time (but same instance from service)
      expect(mockCheckpointerService.getCheckpointer).toHaveBeenCalledTimes(3);
    });

    it('should handle concurrent agent creation', async () => {
      // Act - simulate multiple concurrent chat requests
      await Promise.all([
        service.createAgent({
          chatId: 'test-chat-1',
          modelId: 'model-1',
          kernel: 'openscad',
          tools: { choice: 'auto' },
        }),
        service.createAgent({
          chatId: 'test-chat-1',
          modelId: 'model-2',
          kernel: 'replicad',
          tools: { choice: 'auto' },
        }),
        service.createAgent({ chatId: 'test-chat-1', modelId: 'model-3', kernel: 'jscad', tools: { choice: 'auto' } }),
        service.createAgent({
          chatId: 'test-chat-1',
          modelId: 'model-4',
          kernel: 'openscad',
          tools: { choice: 'auto' },
        }),
        service.createAgent({
          chatId: 'test-chat-1',
          modelId: 'model-5',
          kernel: 'replicad',
          tools: { choice: 'auto' },
        }),
      ]);

      // Assert
      expect(mockCheckpointerService.getCheckpointer).toHaveBeenCalledTimes(5);
    });

    it('should build model with provided modelId', async () => {
      // Act
      await service.createAgent({
        chatId: 'test-chat-1',
        modelId: 'claude-3-opus',
        kernel: 'openscad',
        tools: { choice: 'auto' },
      });

      // Assert
      expect(mockModelService.buildModel).toHaveBeenCalledWith('claude-3-opus');
    });

    it('should get tools with provided tool selection', async () => {
      // Act
      await service.createAgent({
        chatId: 'test-chat-1',
        modelId: 'model-1',
        kernel: 'openscad',
        tools: { choice: 'auto' },
      });

      // Assert
      expect(mockToolService.getTools).toHaveBeenCalledWith('auto');
    });

    it('should include latex delimiter normalization middleware for checkpointed state', async () => {
      await service.createAgent({
        chatId: 'test-chat-1',
        modelId: 'model-1',
        kernel: 'openscad',
        tools: { choice: 'auto' },
      });

      const createAgentMock = vi.mocked(createAgent);
      const firstCall = createAgentMock.mock.calls[0]?.[0];
      const middleware = firstCall?.middleware;

      expect(middleware).toBeDefined();
      expect(middleware).toContain(newlineTrimmerMiddleware);
      expect(middleware).toContain(latexDelimiterMiddleware);

      const newlineMiddlewareIndex = middleware?.indexOf(newlineTrimmerMiddleware) ?? -1;
      const latexMiddlewareIndex = middleware?.indexOf(latexDelimiterMiddleware) ?? -1;
      expect(newlineMiddlewareIndex).toBeGreaterThanOrEqual(0);
      expect(latexMiddlewareIndex).toBeGreaterThan(newlineMiddlewareIndex);
    });
  });
});

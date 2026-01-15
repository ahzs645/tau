import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DeepMockProxy } from 'vitest-mock-extended';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { StreamTextResult as StreamTextResultType, ToolSet } from 'ai';
import type { ChatUsageTokens, MyUIMessage } from '@taucad/chat';
import { ChatController } from '#api/chat/chat.controller.js';
import { ChatService } from '#api/chat/chat.service.js';
import { ChatToolsService } from '#api/chat/chat-tools.service.js';
import { ModelService } from '#api/models/model.service.js';
import { FileEditService } from '#api/file-edit/file-edit.service.js';
import { AnalysisService } from '#api/analysis/analysis.service.js';
import { AuthGuard } from '#auth/auth.guard.js';

// Mock the @ai-sdk/langchain module
vi.mock('@ai-sdk/langchain', () => ({
  toBaseMessages: vi.fn(async () => [{ content: 'test message' }]),
  // eslint-disable-next-line @typescript-eslint/naming-convention -- AI SDK naming
  toUIMessageStream: vi.fn(
    () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
  ),
}));

// Mock the ai module - use importOriginal to keep other exports
vi.mock('ai', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Import original module
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    convertToModelMessages: vi.fn(async () => [{ role: 'user', content: 'test' }]),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- AI SDK naming
    createUIMessageStreamResponse: vi.fn(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200 },
        ),
    ),
  };
});

/**
 * Type for the streamText return value used in name/commit generators.
 * We use the actual return type from the AI SDK to ensure type safety.
 */
type StreamTextResult = StreamTextResultType<ToolSet, never>;

// Helper to create mock MyUIMessage
function createMockUserMessage(model: string): MyUIMessage {
  return {
    id: 'msg_1',
    role: 'user',
    parts: [{ type: 'text', text: 'Hello' }],
    metadata: { model, kernel: 'openscad' },
  } as const satisfies MyUIMessage;
}

// Helper to create mock agent with graph property
function createMockAgent(): {
  graph: {
    stream: ReturnType<typeof vi.fn>;
  };
} {
  const mockStream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  return {
    graph: {
      stream: vi.fn().mockResolvedValue(mockStream),
    },
  };
}

/**
 * Creates a deep mock of the streamText return type.
 * Uses vitest-mock-extended for proper type safety.
 *
 * The controller uses: result.toUIMessageStream().pipeThrough(new JsonToSseTransformStream())
 * which then returns a stream that has .pipeThrough(new TextEncoderStream())
 */
function createMockStreamResult(): DeepMockProxy<StreamTextResult> {
  const mockResult = mockDeep<StreamTextResult>();

  // Create the mock stream chain that the controller expects
  // The controller calls: toUIMessageStream().pipeThrough(...).pipeThrough(...)
  const mockUiMessageStream = mockDeep<ReturnType<StreamTextResult['toUIMessageStream']>>();
  const mockFinalStream = mockDeep<ReadableStream<Uint8Array>>();
  const mockIntermediateStream = mockDeep<ReadableStream>();
  mockIntermediateStream.pipeThrough.mockReturnValue(mockFinalStream);
  mockUiMessageStream.pipeThrough.mockReturnValue(mockIntermediateStream);
  mockResult.toUIMessageStream.mockReturnValue(mockUiMessageStream);

  return mockResult;
}

/**
 * Creates a deep mock of FastifyReply with pre-configured chainable methods.
 * Uses vitest-mock-extended for proper type safety.
 */
function createMockResponse(): DeepMockProxy<FastifyReply> {
  const mockReply = mockDeep<FastifyReply>();

  // Configure chainable methods to return the mock itself
  mockReply.header.mockReturnThis();
  mockReply.send.mockReturnThis();

  return mockReply;
}

/**
 * Creates a deep mock of FastifyRequest with required properties for controller tests.
 * Uses vitest-mock-extended for proper type safety.
 */
function createMockRequest(): DeepMockProxy<FastifyRequest> {
  const mockRequest = mockDeep<FastifyRequest>();

  // Configure the raw.destroyed property (used for abort handling)
  mockRequest.raw.destroyed = false;

  return mockRequest;
}

describe('ChatController', () => {
  let controller: ChatController;
  let chatService: ChatService;
  let module: TestingModule;
  let mockAgent: ReturnType<typeof createMockAgent>;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    mockAgent = createMockAgent();

    const mockChatService = {
      createAgent: vi.fn().mockResolvedValue(mockAgent),
      getBuildNameGenerator: vi.fn(),
      getCommitMessageGenerator: vi.fn(),
    };

    const mockModelService = {
      normalizeUsageTokens: vi.fn().mockImplementation((_modelId, usage) => usage as ChatUsageTokens),
      getModelCost: vi.fn().mockReturnValue({
        inputTokensCost: 0,
        outputTokensCost: 0,
        cachedReadTokensCost: 0,
        cachedWriteTokensCost: 0,
        totalCost: 0,
      }),
    };

    const mockChatToolsService = {};

    const mockFileEditService = {};

    const mockAnalysisService = {};

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        {
          provide: ChatService,
          useValue: mockChatService,
        },
        {
          provide: ChatToolsService,
          useValue: mockChatToolsService,
        },
        {
          provide: ModelService,
          useValue: mockModelService,
        },
        {
          provide: FileEditService,
          useValue: mockFileEditService,
        },
        {
          provide: AnalysisService,
          useValue: mockAnalysisService,
        },
        Reflector,
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<ChatController>(ChatController);
    chatService = moduleRef.get<ChatService>(ChatService);
    module = moduleRef;
  });

  afterEach(async () => {
    await module.close();
  });

  describe('createChat - Agent Execution', () => {
    it('should execute agent with correct parameters', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_123',
        messages: [createMockUserMessage('test-model')],
      };

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(chatService.createAgent).toHaveBeenCalledWith('test-model', 'auto', 'openscad');
      expect(mockAgent.graph.stream).toHaveBeenCalledTimes(1);

      // Verify stream was called with messages and correct config
      const [streamArgs, streamConfig] = mockAgent.graph.stream.mock.calls[0] as [
        { messages: unknown[] },
        { configurable: { thread_id: string } },
      ];
      expect(streamArgs).toHaveProperty('messages');
      expect(Array.isArray(streamArgs.messages)).toBe(true);
      expect(streamConfig.configurable.thread_id).toBe('chat_123');

      expect(mockResponse.send).toHaveBeenCalled();
    });

    it('should use custom tool choice when provided', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_tool_choice',
        messages: [
          {
            id: 'msg_1',
            role: 'user' as const,
            parts: [{ type: 'text' as const, text: 'Hello' }],
            metadata: { model: 'test-model', kernel: 'openscad' as const, toolChoice: 'none' as const },
          },
        ],
      };

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(chatService.createAgent).toHaveBeenCalledWith('test-model', 'none', 'openscad');
    });
  });

  describe('createChat - Name Generator Bypass', () => {
    it('should use name generator when modelId is name-generator', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_name_gen',
        messages: [createMockUserMessage('name-generator')],
      };

      const mockStreamResult = createMockStreamResult();
      vi.mocked(chatService.getBuildNameGenerator).mockReturnValue(mockStreamResult);

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(chatService.getBuildNameGenerator).toHaveBeenCalled();
      expect(chatService.createAgent).not.toHaveBeenCalled();
      expect(mockResponse.send).toHaveBeenCalled();
    });

    it('should use commit message generator when modelId is commit-name-generator', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_commit_gen',
        messages: [createMockUserMessage('commit-name-generator')],
      };

      const mockStreamResult = createMockStreamResult();
      vi.mocked(chatService.getCommitMessageGenerator).mockReturnValue(mockStreamResult);

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(chatService.getCommitMessageGenerator).toHaveBeenCalled();
      expect(chatService.createAgent).not.toHaveBeenCalled();
      expect(mockResponse.send).toHaveBeenCalled();
    });
  });

  describe('createChat - Error Handling', () => {
    it('should throw error when last message is not a user message', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const assistantMessage: MyUIMessage = {
        id: 'msg_1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello' }],
      };
      const body = {
        id: 'chat_no_user',
        messages: [assistantMessage],
      };

      // Act & Assert
      await expect(controller.createChat(body, mockResponse, mockRequest)).rejects.toThrow(
        'Last message is not a user message',
      );
    });

    it('should throw error when message model is missing', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const userMessageWithoutModel: MyUIMessage = {
        id: 'msg_1',
        role: 'user',
        parts: [{ type: 'text' as const, text: 'Hello' }],
        metadata: {}, // No model specified
      };
      const body = {
        id: 'chat_no_model',
        messages: [userMessageWithoutModel],
      };

      // Act & Assert
      await expect(controller.createChat(body, mockResponse, mockRequest)).rejects.toThrow('Message model is required');
    });
  });

  describe('createChat - Response Headers', () => {
    it('should set correct SSE headers for agent execution', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_headers',
        messages: [createMockUserMessage('test-model')],
      };

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(mockResponse.header).toHaveBeenCalledWith('content-type', 'text/event-stream');
      expect(mockResponse.header).toHaveBeenCalledWith('x-vercel-ai-ui-message-stream', 'v1');
      expect(mockResponse.header).toHaveBeenCalledWith('x-accel-buffering', 'no');
    });
  });

  describe('createChat - Adapter Integration', () => {
    it('should use toUIMessageStream to convert agent stream', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_adapter',
        messages: [createMockUserMessage('test-model')],
      };

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      // The agent.graph.stream should have been called
      expect(mockAgent.graph.stream).toHaveBeenCalled();
      // Response should have been sent
      expect(mockResponse.send).toHaveBeenCalled();
    });
  });
});

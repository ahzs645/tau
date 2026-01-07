import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { DeepMockProxy } from 'vitest-mock-extended';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Command } from '@langchain/langgraph';
import type { StateSnapshot } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import type { StreamTextResult as StreamTextResultType, ToolSet } from 'ai';
import type { MyUIMessage } from '@taucad/chat';
import { ChatController } from '#api/chat/chat.controller.js';
import { ChatService } from '#api/chat/chat.service.js';
import { ToolService } from '#api/tools/tool.service.js';
import { AuthGuard } from '#auth/auth.guard.js';
// Import mocked modules to access mock functions
import { tryExtractLastToolResult } from '#api/chat/utils/extract-tool-result.js';
import { LangGraphAdapter } from '#api/chat/utils/langgraph-adapter.js';

// Mock the extract-tool-result module
vi.mock('#api/chat/utils/extract-tool-result.js', () => ({
  tryExtractLastToolResult: vi.fn(),
}));

// Mock the convert-messages module
vi.mock('#api/chat/utils/convert-messages.js', () => ({
  sanitizeMessagesForConversion: vi.fn((messages: MyUIMessage[]) => messages),
  convertAiSdkMessagesToLangchainMessages: vi.fn(() => [new HumanMessage('test message')]),
}));

// Mock the langgraph-adapter module
vi.mock('#api/chat/utils/langgraph-adapter.js', () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention -- LangGraphAdapter is a class
  LangGraphAdapter: {
    toDataStream: vi.fn(() => ({
      pipeThrough: vi.fn(() => ({
        pipeThrough: vi.fn(() => 'mocked-stream'),
      })),
    })),
  },
}));

/**
 * Type for the streamText return value used in name/commit generators.
 * We use the actual return type from the AI SDK to ensure type safety.
 */
type StreamTextResult = StreamTextResultType<ToolSet, unknown>;

// Helper to create mock MyUIMessage
function createMockUserMessage(model: string): MyUIMessage {
  return {
    id: 'msg_1',
    role: 'user',
    parts: [{ type: 'text', text: 'Hello' }],
    metadata: { model, kernel: 'openscad' },
  } as const satisfies MyUIMessage;
}

// Helper to create mock graph
function createMockGraph(stateOverride?: Partial<StateSnapshot>): {
  getState: ReturnType<typeof vi.fn>;
  streamEvents: ReturnType<typeof vi.fn>;
} {
  const mockEventStream = {
    async *[Symbol.asyncIterator]() {
      yield { event: 'test' };
    },
  };

  return {
    getState: vi.fn().mockResolvedValue({
      values: {},
      next: [],
      tasks: [],
      ...stateOverride,
    }),
    streamEvents: vi.fn().mockReturnValue(mockEventStream),
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
  let mockGraph: ReturnType<typeof createMockGraph>;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    mockGraph = createMockGraph();

    const mockChatService = {
      createGraph: vi.fn().mockResolvedValue(mockGraph),
      getBuildNameGenerator: vi.fn(),
      getCommitMessageGenerator: vi.fn(),
      getCallbacks: vi.fn().mockReturnValue({}),
    };

    const mockToolService = {
      getToolParsers: vi.fn().mockReturnValue({}),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        {
          provide: ChatService,
          useValue: mockChatService,
        },
        {
          provide: ToolService,
          useValue: mockToolService,
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

  describe('createChat - Thread Resume Logic', () => {
    it('should execute normally for new thread when next is empty', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_123',
        messages: [createMockUserMessage('test-model')],
      };

      // Graph state with empty next array (not interrupted)
      mockGraph.getState.mockResolvedValue({
        values: {},
        next: [],
        tasks: [],
      });

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(chatService.createGraph).toHaveBeenCalledWith('test-model', 'auto', 'openscad');
      expect(mockGraph.getState).toHaveBeenCalled();
      expect(mockGraph.streamEvents).toHaveBeenCalledTimes(1);

      // Verify streamEvents was called with messages (not a Command)
      const [firstArg, secondArg] = mockGraph.streamEvents.mock.calls[0] as [
        { messages: unknown[] },
        { configurable: { thread_id: string } },
      ];
      expect(firstArg).toHaveProperty('messages');
      expect(Array.isArray(firstArg.messages)).toBe(true);
      expect(firstArg).not.toBeInstanceOf(Command);
      expect(secondArg.configurable.thread_id).toBe('chat_123');

      expect(mockResponse.send).toHaveBeenCalled();
    });

    it('should resume with Command when interrupted with valid tool result', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_456',
        messages: [createMockUserMessage('test-model')],
      };

      // Graph state with non-empty next array (interrupted)
      mockGraph.getState.mockResolvedValue({
        values: {},
        next: ['cad_expert'],
        tasks: [],
      });

      // Mock tool result extraction to return a valid result
      const mockToolResult = { codeErrors: [], kernelErrors: undefined };
      vi.mocked(tryExtractLastToolResult).mockReturnValue(mockToolResult);

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(mockGraph.getState).toHaveBeenCalled();
      expect(tryExtractLastToolResult).toHaveBeenCalled();

      // Should be called with a Command containing the tool result
      const streamEventsCall = mockGraph.streamEvents.mock.calls[0];
      expect(streamEventsCall).toBeDefined();
      const [commandArg] = streamEventsCall as [Command, unknown];
      expect(commandArg).toBeInstanceOf(Command);

      expect(mockResponse.send).toHaveBeenCalled();
    });

    it('should fallback to normal execution when interrupted but no tool result found', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_789',
        messages: [createMockUserMessage('test-model')],
      };

      // Graph state with non-empty next array (appears interrupted)
      mockGraph.getState.mockResolvedValue({
        values: {},
        next: ['cad_expert'],
        tasks: [],
      });

      // Mock tool result extraction to return undefined (no valid tool result)
      vi.mocked(tryExtractLastToolResult).mockReturnValue(undefined);

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(mockGraph.getState).toHaveBeenCalled();
      expect(tryExtractLastToolResult).toHaveBeenCalled();

      // Should fallback to normal execution with messages, NOT Command
      expect(mockGraph.streamEvents).toHaveBeenCalledTimes(1);

      // Verify streamEvents was called with messages (not a Command)
      const [firstArg, secondArg] = mockGraph.streamEvents.mock.calls[0] as [
        { messages: unknown[] },
        { configurable: { thread_id: string } },
      ];
      expect(firstArg).toHaveProperty('messages');
      expect(Array.isArray(firstArg.messages)).toBe(true);
      expect(firstArg).not.toBeInstanceOf(Command);
      expect(secondArg.configurable.thread_id).toBe('chat_789');

      expect(mockResponse.send).toHaveBeenCalled();
    });

    it('should handle getState failure gracefully and proceed with normal execution', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_error',
        messages: [createMockUserMessage('test-model')],
      };

      // Mock getState to throw an error
      mockGraph.getState.mockRejectedValue(new Error('Database connection failed'));

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(mockGraph.getState).toHaveBeenCalled();

      // Should still proceed with normal execution despite getState failure
      expect(mockGraph.streamEvents).toHaveBeenCalledTimes(1);

      const [firstArg, secondArg] = mockGraph.streamEvents.mock.calls[0] as [
        { messages: unknown[] },
        { configurable: { thread_id: string } },
      ];
      expect(firstArg).toHaveProperty('messages');
      expect(Array.isArray(firstArg.messages)).toBe(true);
      expect(secondArg.configurable.thread_id).toBe('chat_error');

      expect(mockResponse.send).toHaveBeenCalled();
    });

    it('should execute normally when currentState is undefined', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_new',
        messages: [createMockUserMessage('test-model')],
      };

      // Graph state returns undefined (brand new thread)
      mockGraph.getState.mockResolvedValue(undefined);

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(mockGraph.streamEvents).toHaveBeenCalledTimes(1);

      const [firstArg, secondArg] = mockGraph.streamEvents.mock.calls[0] as [
        { messages: unknown[] },
        { configurable: { thread_id: string } },
      ];
      expect(firstArg).toHaveProperty('messages');
      expect(Array.isArray(firstArg.messages)).toBe(true);
      expect(secondArg.configurable.thread_id).toBe('chat_new');

      expect(mockResponse.send).toHaveBeenCalled();
    });

    it('should execute normally when currentState.next is undefined', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_no_next',
        messages: [createMockUserMessage('test-model')],
      };

      // Graph state has no next property
      mockGraph.getState.mockResolvedValue({
        values: {},
        tasks: [],
      });

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(mockGraph.streamEvents).toHaveBeenCalledTimes(1);

      const [firstArg, secondArg] = mockGraph.streamEvents.mock.calls[0] as [
        { messages: unknown[] },
        { configurable: { thread_id: string } },
      ];
      expect(firstArg).toHaveProperty('messages');
      expect(Array.isArray(firstArg.messages)).toBe(true);
      expect(secondArg.configurable.thread_id).toBe('chat_no_next');

      expect(mockResponse.send).toHaveBeenCalled();
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
      expect(chatService.createGraph).not.toHaveBeenCalled();
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
      expect(chatService.createGraph).not.toHaveBeenCalled();
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
        parts: [{ type: 'text', text: 'Hello' }],
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
    it('should set correct SSE headers for graph execution', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_headers',
        messages: [createMockUserMessage('test-model')],
      };

      mockGraph.getState.mockResolvedValue({ values: {}, next: [], tasks: [] });

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(mockResponse.header).toHaveBeenCalledWith('content-type', 'text/event-stream');
      expect(mockResponse.header).toHaveBeenCalledWith('x-vercel-ai-ui-message-stream', 'v1');
      expect(mockResponse.header).toHaveBeenCalledWith('x-accel-buffering', 'no');
    });
  });

  describe('createChat - LangGraphAdapter Integration', () => {
    it('should call LangGraphAdapter.toDataStream with correct parameters', async () => {
      // Arrange
      const mockResponse = createMockResponse();
      const mockRequest = createMockRequest();
      const body = {
        id: 'chat_adapter',
        messages: [createMockUserMessage('test-model')],
      };

      mockGraph.getState.mockResolvedValue({ values: {}, next: [], tasks: [] });

      // Act
      await controller.createChat(body, mockResponse, mockRequest);

      // Assert
      expect(LangGraphAdapter.toDataStream).toHaveBeenCalled();
      const toDataStreamCalls = vi.mocked(LangGraphAdapter.toDataStream).mock.calls;
      expect(toDataStreamCalls).toHaveLength(1);
      const [, options] = toDataStreamCalls[0] as [unknown, { modelId: string }];
      expect(options.modelId).toBe('test-model');
    });
  });
});

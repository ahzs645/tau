import { Body, Controller, Logger, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { toBaseMessages, toUIMessageStream } from '@ai-sdk/langchain';
import { convertToModelMessages, createUIMessageStreamResponse } from 'ai';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ToolSelection } from '@taucad/chat';
import { ChatService } from '#api/chat/chat.service.js';
import { ChatRpcService } from '#api/chat/chat-rpc.service.js';
import { ModelService } from '#api/models/model.service.js';
import { FileEditService } from '#api/file-edit/file-edit.service.js';
import { AnalysisService } from '#api/analysis/analysis.service.js';
import { AuthGuard } from '#auth/auth.guard.js';
import { CreateChatDto } from '#api/chat/chat.dto.js';
import { sendSimpleModelStream } from '#api/chat/utils/simple-model-stream.js';
import { injectSnapshotContext } from '#api/chat/utils/inject-snapshot-context.js';
import { createStaticToolTransform } from '#api/chat/utils/static-tool-transform.js';
import { createErrorTransform } from '#api/chat/utils/error-transform.js';
import { createToolOutputTransform } from '#api/chat/utils/tool-output-transform.js';
import { ChatExceptionFilter } from '#api/chat/chat-exception.filter.js';

@UseFilters(ChatExceptionFilter)
@UseGuards(AuthGuard)
@Controller({ path: 'chat', version: '1' })
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  public constructor(
    private readonly chatService: ChatService,
    private readonly chatRpcService: ChatRpcService,
    private readonly modelService: ModelService,
    private readonly fileEditService: FileEditService,
    private readonly analysisService: AnalysisService,
  ) {}

  @Post()
  public async createChat(
    @Body() body: CreateChatDto,
    @Res() response: FastifyReply,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    this.logger.debug(`Creating chat: ${body.id}`);

    const lastHumanMessage = body.messages.findLast((message) => message.role === 'user');
    let modelId: string;
    let selectedToolChoice: ToolSelection = 'auto';

    if (lastHumanMessage?.role === 'user') {
      const messageModel = lastHumanMessage.metadata?.model;

      if (!messageModel) {
        throw new Error('Message model is required');
      }

      modelId = messageModel;

      const messageToolChoice = lastHumanMessage.metadata?.toolChoice;

      if (messageToolChoice) {
        selectedToolChoice = messageToolChoice;
      }
    } else {
      throw new Error('Last message is not a user message');
    }

    // Handle simple model streams (name generator, commit generator)
    // These use AI SDK's streamText, so they need ModelMessage[] from convertToModelMessages
    if (modelId === 'name-generator') {
      const modelMessages = await convertToModelMessages(body.messages);
      const result = this.chatService.getBuildNameGenerator(modelMessages);
      return sendSimpleModelStream(response, result);
    }

    if (modelId === 'commit-name-generator') {
      const modelMessages = await convertToModelMessages(body.messages);
      const result = this.chatService.getCommitMessageGenerator(modelMessages);
      return sendSimpleModelStream(response, result);
    }

    // Extract kernel from request body (default to openscad if not provided)
    const selectedKernel = lastHumanMessage.metadata?.kernel ?? 'openscad';

    // Extract snapshot from metadata and inject into last message content
    const snapshot = lastHumanMessage.metadata?.snapshot;

    // Inject snapshot context into messages if available
    const messagesWithContext = snapshot ? injectSnapshotContext(body.messages, snapshot) : body.messages;

    if (snapshot) {
      const contextTypes = [
        snapshot.fileTree ? 'fileTree' : undefined,
        snapshot.activeFile ? 'activeFile' : undefined,
        snapshot.openFiles ? 'openFiles' : undefined,
      ]
        .filter(Boolean)
        .join(', ');
      this.logger.debug(`Injecting snapshot context into last message: ${contextTypes}`);
    }

    // Convert UI messages to LangChain messages using the built-in adapter
    const langchainMessages = await toBaseMessages(messagesWithContext);

    // Get the agent from the service
    const agent = await this.chatService.createAgent(modelId, selectedToolChoice, selectedKernel);

    // Abort the request if the client disconnects
    const abortController = new AbortController();
    const { socket } = request.raw;

    const handleSocketClose = (): void => {
      if (request.raw.destroyed) {
        abortController.abort();
      }
    };

    socket.on('close', handleSocketClose);

    // Clean up the listener when the response finishes to prevent memory leaks
    // With HTTP keep-alive, the same socket is reused across multiple requests,
    // so we must remove the listener to avoid accumulation
    const cleanupSocketListener = (): void => {
      socket.off('close', handleSocketClose);
    };

    response.raw.on('finish', cleanupSocketListener);
    response.raw.on('error', cleanupSocketListener);

    this.logger.debug(`Starting execution for thread: ${body.id}`);
    const stream = await agent.graph.stream(
      { messages: langchainMessages },
      {
        configurable: {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangGraph API requires snake_case
          thread_id: body.id,
          // Pass services for tools to use
          chatRpcService: this.chatRpcService,
          fileEditService: this.fileEditService,
          analysisService: this.analysisService,
        },
        signal: abortController.signal,
        // Include 'custom' to receive usage data from usageTrackingMiddleware
        streamMode: ['values', 'messages', 'custom'],
        // Pass context for middleware (usage tracking, tool error handling)
        context: {
          modelId,
          modelService: this.modelService,
          logger: this.logger,
        },
        recursionLimit: 200,
      },
    );

    // Set SSE headers
    void response.header('content-type', 'text/event-stream');
    void response.header('x-vercel-ai-ui-message-stream', 'v1');
    void response.header('x-accel-buffering', 'no');

    // Convert the LangGraph stream to UI message stream
    // The toUIMessageStream adapter marks all tools as dynamic and stringifies tool outputs,
    // so we pipe through transforms to:
    // 1) mark known tools as static
    // 2) parse tool output JSON strings into objects
    // 3) normalize error chunks
    const uiMessageStream = toUIMessageStream(stream)
      .pipeThrough(createStaticToolTransform())
      .pipeThrough(createToolOutputTransform())
      .pipeThrough(createErrorTransform());

    const uiMessageStreamResponse = createUIMessageStreamResponse({
      stream: uiMessageStream,
    });

    // Get the body from the response and pipe it
    const responseBody = uiMessageStreamResponse.body;
    if (responseBody) {
      return response.send(responseBody);
    }

    throw new Error('Failed to create UI message stream response');
  }
}

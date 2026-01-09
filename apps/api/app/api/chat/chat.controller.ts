import { Body, Controller, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { convertToModelMessages, JsonToSseTransformStream } from 'ai';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Command } from '@langchain/langgraph';
import type { StateSnapshot } from '@langchain/langgraph';
import type { IterableReadableStream } from '@langchain/core/utils/stream';
import type { StreamEvent } from '@langchain/core/tracers/log_stream';
import type { ToolSelection } from '@taucad/chat';
import { tryExtractAllToolResults } from '#api/chat/utils/extract-tool-result.js';
import { ToolService, toolChoiceFromToolName } from '#api/tools/tool.service.js';
import { ChatService } from '#api/chat/chat.service.js';
import { LangGraphAdapter } from '#api/chat/utils/langgraph-adapter.js';
import {
  convertAiSdkMessagesToLangchainMessages,
  sanitizeMessagesForConversion,
} from '#api/chat/utils/convert-messages.js';
import { AuthGuard } from '#auth/auth.guard.js';
import { CreateChatDto } from '#api/chat/chat.dto.js';
import { sendSimpleModelStream } from '#api/chat/utils/simple-model-stream.js';
import { injectSnapshotContext } from '#api/chat/utils/inject-snapshot-context.js';

@UseGuards(AuthGuard)
@Controller({ path: 'chat', version: '1' })
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  public constructor(
    private readonly chatService: ChatService,
    private readonly toolService: ToolService,
  ) {}

  @Post()
  // eslint-disable-next-line complexity -- Complex chat flow with multiple model types and state management
  public async createChat(
    @Body() body: CreateChatDto,
    @Res() response: FastifyReply,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    this.logger.debug(`Creating chat: ${body.id}`);
    // Sanitize messages to handle partial tool calls before conversion
    const sanitizedMessages = sanitizeMessagesForConversion(body.messages, this.logger);
    const coreMessages = convertToModelMessages(sanitizedMessages);
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

    if (modelId === 'name-generator') {
      const result = this.chatService.getBuildNameGenerator(coreMessages);
      return sendSimpleModelStream(response, result);
    }

    if (modelId === 'commit-name-generator') {
      const result = this.chatService.getCommitMessageGenerator(coreMessages);
      return sendSimpleModelStream(response, result);
    }

    // Extract kernel from request body (default to openscad if not provided)
    const selectedKernel = lastHumanMessage.metadata?.kernel ?? 'openscad';

    // Extract snapshot from metadata and inject into last message content
    const snapshot = lastHumanMessage.metadata?.snapshot;

    // Inject snapshot context into messages if available
    const messagesWithContext = snapshot ? injectSnapshotContext(sanitizedMessages, snapshot) : sanitizedMessages;

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

    const coreMessagesWithContext = convertToModelMessages(messagesWithContext);
    const langchainMessages = convertAiSdkMessagesToLangchainMessages(messagesWithContext, coreMessagesWithContext);
    const graph = await this.chatService.createGraph(modelId, selectedToolChoice, selectedKernel);

    // Configuration for the graph execution
    const config = {
      streamMode: 'values',
      version: 'v2',
      configurable: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangGraph API requires snake_case
        thread_id: body.id, // Enable persistence using conversation ID as thread ID
      },
    } as const;

    // Check if this thread is in an interrupted state
    let currentState: StateSnapshot | undefined;
    try {
      currentState = await graph.getState(config);
    } catch {
      // If we can't get state, assume it's a new conversation
      // and no-op
    }

    // Abort the request if the client disconnects
    const abortController = new AbortController();
    request.raw.socket.on('close', () => {
      if (request.raw.destroyed) {
        abortController.abort();
      }
    });

    let eventStream: IterableReadableStream<StreamEvent>;

    // Check if we're resuming from an interrupt
    if (currentState?.next && currentState.next.length > 0) {
      // Thread appears interrupted - try to extract ALL tool results for resume
      // This supports the "all-or-nothing" batch pattern for multiple tool calls

      const toolResults = tryExtractAllToolResults(langchainMessages);

      if (toolResults === undefined || toolResults.length === 0) {
        // No valid tool results - likely a retry after successful processing
        // Fall back to normal execution - LangGraph handles message deduplication
        this.logger.debug(
          `Thread ${body.id} appears interrupted but no tool results found. ` +
            `Falling back to normal execution (likely a retry after successful processing).`,
        );
        eventStream = graph.streamEvents(
          { messages: langchainMessages },
          { ...config, signal: abortController.signal },
        );
      } else {
        // Valid tool results found - resume the graph with all results
        this.logger.debug(`Resuming interrupted thread: ${body.id}`);

        // Pass array of all tool results to resume
        // Each result contains: { toolCallId, toolName, result }
        const resumeValues: unknown[] = toolResults.map((toolResult) => toolResult.result);
        eventStream = graph.streamEvents(new Command({ resume: resumeValues }), {
          ...config,
          signal: abortController.signal,
        });
      }
    } else {
      this.logger.debug(`Starting normal execution for thread: ${body.id}`);
      eventStream = graph.streamEvents(
        {
          messages: langchainMessages,
        },
        {
          ...config,
          signal: abortController.signal,
        },
      );
    }

    // Use the LangGraphAdapter to handle the response
    const result = LangGraphAdapter.toDataStream(eventStream, {
      modelId,
      toolTypeMap: toolChoiceFromToolName,
      parseToolResults: this.toolService.getToolParsers(),
      callbacks: this.chatService.getCallbacks(),
    });

    const sseStream = result.pipeThrough(new JsonToSseTransformStream());

    void response.header('content-type', 'text/event-stream');
    void response.header('x-vercel-ai-ui-message-stream', 'v1');
    void response.header('x-accel-buffering', 'no');

    return response.send(sseStream.pipeThrough(new TextEncoderStream()));
  }
}

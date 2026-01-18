import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { generatePrefixedId } from '@taucad/utils/id';
import { idPrefix } from '@taucad/types/constants';
import { toolSchemasRegistry } from '@taucad/chat';
import type {
  ToolSchemasRegistry,
  ClientToolInput,
  ClientToolOutput,
  ToolCallRequest,
  ToolCallResult,
  ToolExecutionError,
  ToolValidationError,
} from '@taucad/chat';

/** Timeout for tool execution in milliseconds (60 seconds) */
const toolExecutionTimeoutMs = 60_000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  toolName: keyof ToolSchemasRegistry;
  toolCallId: string;
  chatId: string;
};

/**
 * Service for managing Socket.IO-based tool execution.
 * Handles:
 * - Socket.IO rooms for routing tool requests to clients
 * - Sending tool call requests to clients in specific chat rooms
 * - Receiving and routing tool call results
 * - Timeout handling with structured error responses
 * - Zod-based validation of tool results
 *
 * Architecture:
 * - One Socket.IO connection per browser tab (managed by client singleton)
 * - Socket can join multiple chat rooms simultaneously
 * - Tool requests are emitted directly to the socket in the room
 */
@Injectable()
export class ChatToolsService {
  private readonly logger = new Logger(ChatToolsService.name);

  /** Active Socket.IO connections by chatId (for direct emission) */
  private readonly connections = new Map<string, Socket>();

  /** Pending tool call requests by requestId */
  private readonly pendingRequests = new Map<string, PendingRequest>();

  /**
   * Register a Socket.IO connection for a chat room.
   * Multiple sockets can join the same room (e.g., multiple tabs).
   * The socket should already be joined to the room via Socket.IO.
   */
  public registerConnection(chatId: string, socket: Socket): void {
    // Store the socket for direct emission (last one wins for this chatId)
    // In practice, with room-based routing, we'll use this for direct sends
    this.connections.set(chatId, socket);

    this.logger.debug(`Registered connection for chat ${chatId} (socket: ${socket.id})`);
  }

  /**
   * Unregister a Socket.IO connection for a chat room.
   * Called when client leaves a room or disconnects.
   */
  public unregisterConnection(chatId: string, socket: Socket): void {
    // Only remove if this socket is the registered one for this chat
    if (this.connections.get(chatId) === socket) {
      this.connections.delete(chatId);
      this.logger.debug(`Unregistered connection for chat ${chatId}`);

      // Reject any pending requests for this chat
      this.rejectPendingRequestsForChat(chatId, 'CLIENT_DISCONNECTED');
    }
  }

  /**
   * Handle socket disconnection - clean up all rooms the socket was in.
   */
  public handleSocketDisconnect(socket: Socket): void {
    // Find and remove all chat registrations for this socket
    for (const [chatId, registeredSocket] of this.connections) {
      if (registeredSocket === socket) {
        this.connections.delete(chatId);
        this.logger.debug(`Cleaned up chat ${chatId} on socket disconnect`);

        // Reject pending requests for this chat
        this.rejectPendingRequestsForChat(chatId, 'CLIENT_DISCONNECTED');
      }
    }
  }

  /**
   * Send a tool call request to the client and wait for the result.
   * Returns a Promise that resolves with the validated tool result or a ToolExecutionError/ToolValidationError.
   *
   * Type-safe: The tool name determines the expected input and output types.
   * Both input args and output results are validated against their Zod schemas.
   *
   * @template T - The client tool name (must be a key in ToolSchemasRegistry)
   * @param chatId - The chat room ID
   * @param toolCallId - The tool call ID for tracking
   * @param toolName - The name of the tool to execute
   * @param args - The input arguments (type-checked against tool's input schema)
   * @returns The validated output (type-checked against tool's output schema) or an error object
   */
  public async sendToolCallRequest<T extends keyof ToolSchemasRegistry>(
    chatId: string,
    toolCallId: string,
    toolName: T,
    args: ClientToolInput<T>,
  ): Promise<ClientToolOutput<T> | ToolExecutionError | ToolValidationError> {
    const socket = this.connections.get(chatId);

    if (!socket?.connected) {
      throw new Error(
        'CLIENT_DISCONNECTED: No WebSocket connection to the browser. The user has likely closed or navigated away from the page. ' +
          'DO NOT RETRY this or any other tool - inform the user that you cannot proceed because they are no longer connected.',
      );
    }

    // Validate input args against the tool's input schema
    const inputValidation = this.validateToolInput(toolName, toolCallId, args);
    if (!inputValidation.success) {
      this.logger.warn(`Input validation failed for ${toolName}:`, inputValidation.error.validationErrors);
      return inputValidation.error;
    }

    const requestId = generatePrefixedId(idPrefix.request);

    return new Promise((resolve) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);

        if (pending) {
          this.pendingRequests.delete(requestId);
          const timeoutError: ToolExecutionError = {
            errorCode: 'TOOL_EXECUTION_TIMEOUT',
            message: `Tool execution timed out after ${toolExecutionTimeoutMs / 1000} seconds. The client may be disconnected or unresponsive.`,
            toolName: pending.toolName,
            toolCallId: pending.toolCallId,
          };
          this.logger.warn(`Tool call ${requestId} timed out for chat ${chatId}`);
          resolve(timeoutError); // Resolve with error object so LLM can reason about it
        }
      }, toolExecutionTimeoutMs);

      // Store pending request
      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- Not used, we always resolve with errors
        reject() {},
        timeoutId,
        toolName,
        toolCallId,
        chatId,
      });

      // Send request to client via Socket.IO emit
      const request: ToolCallRequest = {
        type: 'tool_call_request',
        chatId,
        requestId,
        toolCallId,
        toolName,
        args: inputValidation.data,
      };

      socket.emit('tool_call_request', request);
      this.logger.debug(`Sent tool call request ${requestId} for ${toolName} to chat ${chatId}`);
    });
  }

  /**
   * Check if a client is connected for a chat.
   */
  public isConnected(chatId: string): boolean {
    const socket = this.connections.get(chatId);
    return socket?.connected ?? false;
  }

  /**
   * Handle a tool call result from a client.
   * Called by the gateway when receiving a tool_call_result event.
   */
  public handleToolCallResult(message: ToolCallResult): void {
    const { requestId, result, error: clientError } = message;
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      this.logger.warn(`Received result for unknown request ${requestId}`);
      return;
    }

    // Clean up
    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);

    if (clientError) {
      // Client reported an error during execution (client is still connected)
      const errorResult: ToolExecutionError = {
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: clientError,
        toolName: pending.toolName,
        toolCallId: pending.toolCallId,
      };
      pending.resolve(errorResult);
      return;
    }

    // Validate the result against the tool's output schema
    const validated = this.validateToolResult(pending.toolName, pending.toolCallId, result);

    if (validated.success) {
      pending.resolve(validated.data);
    } else {
      // Return validation error to LLM so it can understand what went wrong
      pending.resolve(validated.error);
    }

    this.logger.debug(`Resolved tool call ${requestId} for ${pending.toolName}`);
  }

  /**
   * Validate tool input against its Zod schema.
   * Returns the validated data if successful, or a ToolValidationError if validation fails.
   */
  private validateToolInput<T extends keyof ToolSchemasRegistry>(
    toolName: T,
    toolCallId: string,
    input: unknown,
  ): { success: true; data: ClientToolInput<T> } | { success: false; error: ToolValidationError } {
    const schemas = toolSchemasRegistry[toolName];
    const parseResult = schemas.inputSchema.safeParse(input);

    if (parseResult.success) {
      return { success: true, data: parseResult.data as ClientToolInput<T> };
    }

    // Build validation error for LLM
    const validationError: ToolValidationError = {
      errorCode: 'TOOL_INPUT_VALIDATION_FAILED',
      message: `Tool "${toolName}" received invalid input. The provided arguments don't match the expected schema.`,
      toolName,
      toolCallId,
      validationErrors: parseResult.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
      rawOutput: input,
    };

    return { success: false, error: validationError };
  }

  /**
   * Validate tool result against its Zod schema.
   * Returns the validated data if successful, or a ToolValidationError if validation fails.
   */
  private validateToolResult(
    toolName: keyof ToolSchemasRegistry,
    toolCallId: string,
    result: unknown,
  ): { success: true; data: unknown } | { success: false; error: ToolValidationError } {
    const schemas = toolSchemasRegistry[toolName];
    const parseResult = schemas.outputSchema.safeParse(result);

    if (parseResult.success) {
      return { success: true, data: parseResult.data };
    }

    // Build validation error for LLM
    const validationError: ToolValidationError = {
      errorCode: 'TOOL_OUTPUT_VALIDATION_FAILED',
      message: `Tool "${toolName}" returned invalid output. The client may have returned malformed data.`,
      toolName,
      toolCallId,
      validationErrors: parseResult.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
      rawOutput: result,
    };

    this.logger.warn(`Tool validation failed for ${toolName}:`, validationError.validationErrors);

    return { success: false, error: validationError };
  }

  /**
   * Resolve all pending requests for a chat with an error (e.g., when client disconnects).
   */
  private rejectPendingRequestsForChat(
    chatId: string,
    errorType: 'CLIENT_DISCONNECTED' | 'TOOL_EXECUTION_TIMEOUT',
  ): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.chatId === chatId) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(requestId);

        const errorMessage =
          errorType === 'CLIENT_DISCONNECTED'
            ? 'WebSocket client disconnected before tool execution completed.'
            : `Tool execution timed out after ${toolExecutionTimeoutMs / 1000} seconds.`;

        const disconnectError: ToolExecutionError = {
          errorCode: errorType,
          message: errorMessage,
          toolName: pending.toolName,
          toolCallId: pending.toolCallId,
        };

        // Resolve with error object so LLM can reason about it
        pending.resolve(disconnectError);
        this.logger.debug(`Resolved pending request ${requestId} with ${errorType}`);
      }
    }
  }
}

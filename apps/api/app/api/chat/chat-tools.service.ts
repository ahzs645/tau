import { Injectable, Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { generatePrefixedId } from '@taucad/utils/id';
import { idPrefix } from '@taucad/types/constants';
import type {
  ToolCallRequest,
  ToolCallResult,
  ToolExecutionError,
  WsConnectMessage,
  ClientToServerMessage,
  ClientToolName,
} from '@taucad/chat';
import { wsCloseCode } from '@taucad/chat/constants';

/** Timeout for tool execution in milliseconds (60 seconds) */
const toolExecutionTimeoutMs = 60_000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  toolName: ClientToolName;
  toolCallId: string;
  chatId: string;
};

/**
 * Service for managing WebSocket-based tool execution.
 * Handles:
 * - WebSocket connections per chatId (one connection per chat, last wins)
 * - Sending tool call requests to clients
 * - Receiving and routing tool call results
 * - Timeout handling with structured error responses
 */
@Injectable()
export class ChatToolsService {
  private readonly logger = new Logger(ChatToolsService.name);

  /** Active WebSocket connections by chatId */
  private readonly connections = new Map<string, WebSocket>();

  /** Pending tool call requests by requestId */
  private readonly pendingRequests = new Map<string, PendingRequest>();

  /**
   * Register a WebSocket connection for a chat.
   * If a connection already exists for this chatId, it will be closed.
   */
  public registerConnection(chatId: string, socket: WebSocket): void {
    const existing = this.connections.get(chatId);

    if (existing && existing.readyState === 1) {
      // WebSocket.OPEN = 1
      this.logger.debug(`Closing existing connection for chat ${chatId} (superseded)`);
      existing.close(wsCloseCode.superseded, 'Superseded by new connection');
    }

    this.connections.set(chatId, socket);
    this.logger.debug(`Registered connection for chat ${chatId}`);

    // Clean up on close
    socket.on('close', () => {
      // Only remove if this is still the active connection
      if (this.connections.get(chatId) === socket) {
        this.connections.delete(chatId);
        this.logger.debug(`Connection closed for chat ${chatId}`);

        // Reject any pending requests for this chat
        this.rejectPendingRequestsForChat(chatId, 'CLIENT_DISCONNECTED');
      }
    });
  }

  /**
   * Unregister a WebSocket connection for a chat.
   */
  public unregisterConnection(chatId: string, socket: WebSocket): void {
    // Only unregister if this is the active connection
    if (this.connections.get(chatId) === socket) {
      this.connections.delete(chatId);
      this.logger.debug(`Unregistered connection for chat ${chatId}`);
    }
  }

  /**
   * Handle an incoming message from a WebSocket client.
   */
  public handleMessage(socket: WebSocket, data: string): void {
    try {
      const message = JSON.parse(data) as ClientToServerMessage;

      switch (message.type) {
        case 'connect': {
          this.handleConnectMessage(socket, message);
          break;
        }

        case 'tool_call_result': {
          this.handleToolCallResult(message);
          break;
        }

        default: {
          this.logger.warn(`Unknown message type: ${(message as { type: string }).type}`);
        }
      }
    } catch (parseError) {
      this.logger.error(`Failed to parse WebSocket message: ${String(parseError)}`);
    }
  }

  /**
   * Send a tool call request to the client and wait for the result.
   * Returns a Promise that resolves with the tool result or rejects on timeout/error.
   */
  public async sendToolCallRequest(
    chatId: string,
    toolCallId: string,
    toolName: ClientToolName,
    args: unknown,
  ): Promise<unknown> {
    const socket = this.connections.get(chatId);

    if (!socket || socket.readyState !== 1) {
      // WebSocket.OPEN = 1
      const noConnectionError: ToolExecutionError = {
        errorCode: 'NO_CLIENT_CONNECTION',
        message: `No WebSocket client connected for chat ${chatId}. The user may have closed the browser tab.`,
        toolName,
        toolCallId,
      };
      this.logger.warn(`No connection for chat ${chatId}, returning error to LLM`);
      return noConnectionError;
    }

    const requestId = generatePrefixedId(idPrefix.request);

    return new Promise((resolve, reject) => {
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
        resolve,
        reject,
        timeoutId,
        toolName,
        toolCallId,
        chatId,
      });

      // Send request to client
      const request: ToolCallRequest = {
        type: 'tool_call_request',
        requestId,
        toolCallId,
        toolName,
        args,
      };

      socket.send(JSON.stringify(request));
      this.logger.debug(`Sent tool call request ${requestId} for ${toolName} to chat ${chatId}`);
    });
  }

  /**
   * Check if a client is connected for a chat.
   */
  public isConnected(chatId: string): boolean {
    const socket = this.connections.get(chatId);
    return socket !== undefined && socket.readyState === 1; // WebSocket.OPEN = 1
  }

  /**
   * Handle a connect message from a client.
   */
  private handleConnectMessage(socket: WebSocket, message: WsConnectMessage): void {
    const { chatId } = message;
    this.registerConnection(chatId, socket);

    // Send acknowledgment
    socket.send(JSON.stringify({ type: 'connected', chatId }));
  }

  /**
   * Handle a tool call result from a client.
   */
  private handleToolCallResult(message: ToolCallResult): void {
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
      // Client reported an error - resolve with error object for LLM
      const errorResult: ToolExecutionError = {
        errorCode: 'CLIENT_DISCONNECTED', // Use a generic error type
        message: clientError,
        toolName: pending.toolName,
        toolCallId: pending.toolCallId,
      };
      pending.resolve(errorResult);
    } else {
      pending.resolve(result);
    }

    this.logger.debug(`Resolved tool call ${requestId} for ${pending.toolName}`);
  }

  /**
   * Reject all pending requests for a chat (e.g., when client disconnects).
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

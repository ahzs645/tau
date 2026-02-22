import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { generatePrefixedId } from '@taucad/utils/id';
import { idPrefix } from '@taucad/types/constants';
import { rpcSchemasRegistry } from '@taucad/chat';
import type {
  RpcSchemasRegistry,
  RpcInput,
  RpcResult,
  RpcRequest,
  RpcResponse,
  RpcExecutionError,
  RpcValidationError,
} from '@taucad/chat';

/** Timeout for RPC execution in milliseconds (60 seconds) */
export const rpcExecutionTimeoutMs = 60_000;

/** Delay before clearing the aborted-chat entry after an abort signal fires (milliseconds).
 *  Catches straggler RPCs that start after abort but before LangGraph fully stops. */
export const abortCleanupDelayMs = 5000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  rpcName: keyof RpcSchemasRegistry;
  chatId: string;
};

/**
 * Service for managing Socket.IO-based RPC execution.
 * Handles:
 * - Socket.IO rooms for routing RPC requests to clients
 * - Sending RPC requests to clients in specific chat rooms
 * - Receiving and routing RPC responses
 * - Timeout handling with structured error responses
 * - Zod-based validation of RPC results
 *
 * Architecture:
 * - One Socket.IO connection per browser tab (managed by client singleton)
 * - Socket can join multiple chat rooms simultaneously
 * - RPC requests are emitted directly to the socket in the room
 */
@Injectable()
export class ChatRpcService implements OnModuleDestroy {
  private readonly logger = new Logger(ChatRpcService.name);

  /** Active Socket.IO connections by chatId (supports multiple tabs per chat) */
  private readonly connections = new Map<string, Set<Socket>>();

  /** Pending RPC requests by requestId */
  private readonly pendingRequests = new Map<string, PendingRequest>();

  /** Track aborted chats to reject new RPCs after abort */
  private readonly abortedChats = new Set<string>();

  /** Cleanup timers for aborted chats, keyed by chatId. Tracked so stale timers
   *  from a previous abort can be cancelled when a new signal is registered. */
  private readonly abortCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Register a Socket.IO connection for a chat room.
   * Multiple sockets can join the same room (e.g., multiple tabs).
   * The socket should already be joined to the room via Socket.IO.
   */
  public registerConnection(chatId: string, socket: Socket): void {
    let socketSet = this.connections.get(chatId);

    if (!socketSet) {
      socketSet = new Set<Socket>();
      this.connections.set(chatId, socketSet);
    }

    socketSet.add(socket);

    this.logger.debug(
      `Registered connection for chat ${chatId} (socket: ${socket.id}, total sockets: ${socketSet.size})`,
    );
  }

  /**
   * Unregister a Socket.IO connection for a chat room.
   * Called when client leaves a room or disconnects.
   */
  public unregisterConnection(chatId: string, socket: Socket): void {
    const socketSet = this.connections.get(chatId);

    if (!socketSet) {
      return;
    }

    socketSet.delete(socket);
    this.logger.debug(
      `Unregistered connection for chat ${chatId} (socket: ${socket.id}, remaining sockets: ${socketSet.size})`,
    );

    // Only clean up the map entry and reject pending requests when no sockets remain
    if (socketSet.size === 0) {
      this.connections.delete(chatId);
      this.logger.debug(`All connections removed for chat ${chatId}`);
      this.rejectPendingRequestsForChat(chatId, 'CLIENT_DISCONNECTED');
    }
  }

  /**
   * Handle socket disconnection - clean up all rooms the socket was in.
   */
  public handleSocketDisconnect(socket: Socket): void {
    // Collect chat IDs to delete after iteration to avoid modifying map during iteration
    const chatIdsToDelete: string[] = [];

    // Find and remove this socket from all chat registrations
    for (const [chatId, socketSet] of this.connections) {
      if (socketSet.has(socket)) {
        socketSet.delete(socket);
        this.logger.debug(
          `Cleaned up socket ${socket.id} from chat ${chatId} on disconnect (remaining sockets: ${socketSet.size})`,
        );

        // Mark for deletion if no sockets remain for this chat
        if (socketSet.size === 0) {
          chatIdsToDelete.push(chatId);
        }
      }
    }

    // Clean up empty chat registrations after iteration completes
    for (const chatId of chatIdsToDelete) {
      this.connections.delete(chatId);
      this.logger.debug(`All connections removed for chat ${chatId} on socket disconnect`);
      this.rejectPendingRequestsForChat(chatId, 'CLIENT_DISCONNECTED');
    }
  }

  /**
   * Register an AbortSignal for a chat request. When the signal fires:
   * 1. All pending RPC requests for this chat are immediately rejected
   * 2. Any new sendRpcRequest calls for this chat return an error immediately
   *
   * This ensures that when the client disconnects or aborts a request,
   * in-flight RPC calls are rejected promptly rather than waiting for
   * the 60s timeout. The registration is automatically cleaned up
   * after the signal fires.
   *
   * Zero tool changes needed — tools keep calling sendRpcRequest as before.
   */
  public registerAbortSignal(chatId: string, signal: AbortSignal): void {
    // Cancel any stale cleanup timer from a previous abort so it cannot
    // prematurely clear the abort entry for the new request.
    this.cancelAbortCleanupTimer(chatId);

    // Clear any stale abort entry from a previous request on this chat.
    this.abortedChats.delete(chatId);

    if (signal.aborted) {
      this.abortedChats.add(chatId);
      this.rejectPendingRequestsForChat(chatId, 'CLIENT_DISCONNECTED');
      this.scheduleAbortCleanup(chatId);
      return;
    }

    const onAbort = (): void => {
      this.abortedChats.add(chatId);
      this.rejectPendingRequestsForChat(chatId, 'CLIENT_DISCONNECTED');
      signal.removeEventListener('abort', onAbort);
      this.scheduleAbortCleanup(chatId);
    };

    signal.addEventListener('abort', onAbort);
  }

  /**
   * Clean up all pending requests and timeouts on module destroy.
   * Called during graceful shutdown to prevent timeouts from running
   * and potentially accessing destroyed resources.
   */
  public onModuleDestroy(): void {
    this.logger.log('Cleaning up pending RPC requests on shutdown...');

    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);

      const shutdownError: RpcExecutionError = {
        errorCode: 'CLIENT_DISCONNECTED',
        message: 'Server is shutting down. RPC request cancelled.',
        rpcName: pending.rpcName,
      };

      pending.resolve(shutdownError);
      this.logger.debug(`Cancelled pending request ${requestId} on shutdown`);
    }

    this.pendingRequests.clear();
    this.connections.clear();

    for (const timerId of this.abortCleanupTimers.values()) {
      clearTimeout(timerId);
    }

    this.abortCleanupTimers.clear();
    this.abortedChats.clear();

    this.logger.log('RPC service cleanup complete');
  }

  /**
   * Send an RPC request to the client and wait for the result.
   * Returns a Promise that resolves with the validated result or an RpcExecutionError/RpcValidationError.
   *
   * Type-safe: The RPC name determines the expected input and result types.
   * Both input args and results are validated against their Zod schemas.
   *
   * Note: This service returns RPC-layer errors, not tool-layer errors.
   * The tool layer should convert RPC errors to tool errors using rpcErrorToToolError().
   *
   * @template T - The RPC name (must be a key in RpcSchemasRegistry)
   * @param chatId - The chat room ID
   * @param toolCallId - The tool call ID (passed through to RpcRequest for client tracking)
   * @param rpcName - The name of the RPC operation to execute
   * @param args - The input arguments (type-checked against RPC's input schema)
   * @returns The validated result (type-checked against RPC's result schema) or an RPC error object
   */
  public async sendRpcRequest<T extends keyof RpcSchemasRegistry>(
    chatId: string,
    toolCallId: string,
    rpcName: T,
    args: RpcInput<T>,
  ): Promise<RpcResult<T> | RpcExecutionError | RpcValidationError> {
    // Reject immediately if this chat's request was already aborted
    if (this.abortedChats.has(chatId)) {
      const abortedError: RpcExecutionError = {
        errorCode: 'CLIENT_DISCONNECTED',
        message: 'Chat request was cancelled.',
        rpcName,
      };
      return abortedError;
    }

    const socketSet = this.connections.get(chatId);

    // Find the first connected socket from the set
    const socket = socketSet ? this.getConnectedSocket(socketSet) : undefined;

    if (!socket) {
      const noConnectionError: RpcExecutionError = {
        errorCode: 'NO_CONNECTION',
        message: 'No WebSocket connection to the browser. The user has likely closed or navigated away from the page.',
        rpcName,
      };
      return noConnectionError;
    }

    // Validate input args against the RPC's input schema
    const inputValidation = this.validateRpcInput(rpcName, args);
    if (!inputValidation.success) {
      this.logger.warn(`Input validation failed for ${rpcName}:`, inputValidation.error.validationErrors);
      return inputValidation.error;
    }

    const requestId = generatePrefixedId(idPrefix.request);

    return new Promise((resolve) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);

        if (pending) {
          this.pendingRequests.delete(requestId);
          const timeoutError: RpcExecutionError = {
            errorCode: 'TIMEOUT',
            message: `RPC execution timed out after ${rpcExecutionTimeoutMs / 1000} seconds. The client may be disconnected or unresponsive.`,
            rpcName: pending.rpcName,
          };
          this.logger.warn(`RPC call ${requestId} timed out for chat ${chatId}`);
          resolve(timeoutError);
        }
      }, rpcExecutionTimeoutMs);

      // Store pending request
      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        timeoutId,
        rpcName,
        chatId,
      });

      // Send request to client via Socket.IO emit
      const request: RpcRequest = {
        type: 'rpc_request',
        chatId,
        requestId,
        toolCallId,
        rpcName,
        args: inputValidation.data,
      };

      socket.emit('rpc_request', request);
      this.logger.debug(`Sent RPC request ${requestId} for ${rpcName} to chat ${chatId}`);
    });
  }

  /**
   * Check if a client is connected for a chat.
   */
  public isConnected(chatId: string): boolean {
    const socketSet = this.connections.get(chatId);
    return socketSet ? this.getConnectedSocket(socketSet) !== undefined : false;
  }

  /**
   * Handle an RPC response from a client.
   * Called by the gateway when receiving an rpc_response event.
   */
  public handleRpcResponse(message: RpcResponse): void {
    const { requestId, result, error: clientError } = message;
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      this.logger.warn(`Received response for unknown request ${requestId}`);
      return;
    }

    // Clean up
    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);

    if (clientError) {
      // Client reported an error during execution (client is still connected)
      const errorResult: RpcExecutionError = {
        errorCode: 'UNHANDLED_CLIENT_ERROR',
        message: clientError,
        rpcName: pending.rpcName,
      };
      pending.resolve(errorResult);
      return;
    }

    // Validate the result against the RPC's result schema
    const validated = this.validateRpcResult(pending.rpcName, result);

    if (validated.success) {
      pending.resolve(validated.data);
    } else {
      // Return validation error so caller can handle it
      pending.resolve(validated.error);
    }

    this.logger.debug(`Resolved RPC call ${requestId} for ${pending.rpcName}`);
  }

  /**
   * Get the first connected socket from a set of sockets.
   * Returns undefined if no sockets are connected.
   *
   * Note: We intentionally return only ONE socket for RPC requests because:
   * 1. RPC requests expect exactly one response - the pendingRequests map tracks
   *    a single promise per requestId. Broadcasting to all sockets would cause
   *    multiple responses, with only the first being processed.
   * 2. Tool execution should happen once, not duplicated across every open tab.
   *
   * Multi-tab support provides connection resilience (chat stays connected as long
   * as any tab is open) and proper disconnect handling (pending requests are only
   * rejected when the last socket disconnects). For real-time updates across all
   * tabs, a separate broadcast mechanism would be needed.
   */
  private getConnectedSocket(socketSet: Set<Socket>): Socket | undefined {
    for (const socket of socketSet) {
      if (socket.connected) {
        return socket;
      }
    }

    return undefined;
  }

  /**
   * Validate RPC input against its Zod schema.
   * Returns the validated data if successful, or an RpcValidationError if validation fails.
   */
  private validateRpcInput<T extends keyof RpcSchemasRegistry>(
    rpcName: T,
    input: unknown,
  ): { success: true; data: RpcInput<T> } | { success: false; error: RpcValidationError } {
    const schemas = rpcSchemasRegistry[rpcName];
    const parseResult = schemas.inputSchema.safeParse(input);

    if (parseResult.success) {
      return { success: true, data: parseResult.data as RpcInput<T> };
    }

    // Build validation error
    const validationError: RpcValidationError = {
      errorCode: 'INPUT_VALIDATION_FAILED',
      message: `RPC "${rpcName}" received invalid input. The provided arguments don't match the expected schema.`,
      rpcName,
      validationErrors: parseResult.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
      rawOutput: input,
    };

    return { success: false, error: validationError };
  }

  /**
   * Validate RPC result against its Zod schema.
   * Returns the validated data if successful, or an RpcValidationError if validation fails.
   */
  private validateRpcResult(
    rpcName: keyof RpcSchemasRegistry,
    result: unknown,
  ): { success: true; data: unknown } | { success: false; error: RpcValidationError } {
    const schemas = rpcSchemasRegistry[rpcName];
    const parseResult = schemas.resultSchema.safeParse(result);

    if (parseResult.success) {
      return { success: true, data: parseResult.data };
    }

    // Build validation error
    const validationError: RpcValidationError = {
      errorCode: 'OUTPUT_VALIDATION_FAILED',
      message: `RPC "${rpcName}" returned invalid result. The client may have returned malformed data.`,
      rpcName,
      validationErrors: parseResult.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
      rawOutput: result,
    };

    this.logger.warn(`RPC validation failed for ${rpcName}:`, validationError.validationErrors);

    return { success: false, error: validationError };
  }

  /**
   * Resolve all pending requests for a chat with an error (e.g., when client disconnects).
   */
  private rejectPendingRequestsForChat(chatId: string, errorType: 'CLIENT_DISCONNECTED' | 'TIMEOUT'): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.chatId === chatId) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(requestId);

        const errorMessage =
          errorType === 'CLIENT_DISCONNECTED'
            ? 'WebSocket client disconnected before RPC execution completed.'
            : `RPC execution timed out after ${rpcExecutionTimeoutMs / 1000} seconds.`;

        const disconnectError: RpcExecutionError = {
          errorCode: errorType,
          message: errorMessage,
          rpcName: pending.rpcName,
        };

        pending.resolve(disconnectError);
        this.logger.debug(`Resolved pending request ${requestId} with ${errorType}`);
      }
    }
  }

  /**
   * Schedule cleanup of the aborted chat entry after a short delay.
   * The delay catches RPCs that start after abort fires but before
   * LangGraph fully stops. The timer is tracked so it can be cancelled
   * if a new signal is registered for the same chatId.
   */
  private scheduleAbortCleanup(chatId: string): void {
    const timerId = setTimeout(() => {
      this.abortedChats.delete(chatId);
      this.abortCleanupTimers.delete(chatId);
    }, abortCleanupDelayMs);
    this.abortCleanupTimers.set(chatId, timerId);
  }

  /**
   * Cancel a pending abort cleanup timer for a chatId, if one exists.
   */
  private cancelAbortCleanupTimer(chatId: string): void {
    const existingTimer = this.abortCleanupTimers.get(chatId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.abortCleanupTimers.delete(chatId);
    }
  }
}

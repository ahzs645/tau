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
import { AttributeKey } from '@taucad/telemetry';
import { MetricsService } from '#telemetry/metrics.js';
import { injectTraceContext } from '#telemetry/tracer.service.js';

/** Timeout for RPC execution in milliseconds (60 seconds) */
export const rpcExecutionTimeoutMs = 60_000;

/** Delay before clearing the aborted-chat entry after an abort signal fires (milliseconds).
 *  Catches straggler RPCs that start after abort but before LangGraph fully stops. */
export const abortCleanupDelayMs = 5000;

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

  /** Chat ownership: maps chatId to the userId that first joined the room.
   *  Prevents other authenticated users from joining another user's chat. */
  private readonly chatOwners = new Map<string, string>();

  /** Track aborted chats to reject new RPCs after abort */
  private readonly abortedChats = new Set<string>();

  /** Cleanup timers for aborted chats, keyed by chatId. Tracked so stale timers
   *  from a previous abort can be cancelled when a new signal is registered. */
  private readonly abortCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Track active abort signal listeners per chatId for cleanup on re-registration */
  private readonly activeAbortListeners = new Map<string, { signal: AbortSignal; listener: () => void }>();

  public constructor(private readonly metrics: MetricsService) {}

  /**
   * Register a Socket.IO connection for a chat room.
   * Multiple sockets can join the same room (e.g., multiple tabs) from the same user.
   * Returns false if a different user already owns this chatId.
   */
  public registerConnection(chatId: string, socket: Socket, userId: string): boolean {
    const existingOwner = this.chatOwners.get(chatId);
    if (existingOwner && existingOwner !== userId) {
      this.logger.warn(`Ownership check failed for chat ${chatId}: user ${userId} denied, owned by ${existingOwner}`);
      return false;
    }

    if (!existingOwner) {
      this.chatOwners.set(chatId, userId);
    }

    let socketSet = this.connections.get(chatId);

    if (!socketSet) {
      socketSet = new Set<Socket>();
      this.connections.set(chatId, socketSet);
    }

    socketSet.add(socket);

    this.logger.debug(
      `Registered connection for chat ${chatId} (socket: ${socket.id}, user: ${userId}, total sockets: ${socketSet.size})`,
    );
    return true;
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

    if (socketSet.size === 0) {
      this.connections.delete(chatId);
      this.chatOwners.delete(chatId);
      this.logger.debug(`All connections removed for chat ${chatId}`);
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

    for (const chatId of chatIdsToDelete) {
      this.connections.delete(chatId);
      this.chatOwners.delete(chatId);
      this.logger.debug(`All connections removed for chat ${chatId} on socket disconnect`);
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
    // Remove listener from any previously registered signal for this chatId
    const existing = this.activeAbortListeners.get(chatId);
    if (existing) {
      existing.signal.removeEventListener('abort', existing.listener);
      this.activeAbortListeners.delete(chatId);
    }

    // Cancel any stale cleanup timer from a previous abort so it cannot
    // prematurely clear the abort entry for the new request.
    this.cancelAbortCleanupTimer(chatId);

    // Clear any stale abort entry from a previous request on this chat.
    this.abortedChats.delete(chatId);

    if (signal.aborted) {
      this.abortedChats.add(chatId);
      this.scheduleAbortCleanup(chatId);
      return;
    }

    const onAbort = (): void => {
      this.abortedChats.add(chatId);
      signal.removeEventListener('abort', onAbort);
      this.activeAbortListeners.delete(chatId);
      this.scheduleAbortCleanup(chatId);
    };

    signal.addEventListener('abort', onAbort);
    this.activeAbortListeners.set(chatId, { signal, listener: onAbort });
  }

  /**
   * Clean up all pending requests and timeouts on module destroy.
   * Called during graceful shutdown to prevent timeouts from running
   * and potentially accessing destroyed resources.
   */
  public onModuleDestroy(): void {
    this.logger.log('Cleaning up RPC service on shutdown...');

    this.connections.clear();
    this.chatOwners.clear();

    for (const timerId of this.abortCleanupTimers.values()) {
      clearTimeout(timerId);
    }

    this.abortCleanupTimers.clear();
    this.abortedChats.clear();

    for (const { signal, listener } of this.activeAbortListeners.values()) {
      signal.removeEventListener('abort', listener);
    }
    this.activeAbortListeners.clear();

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
   * @param request - The RPC request object
   * @param request.chatId - The chat room ID
   * @param request.toolCallId - The tool call ID (passed through to RpcRequest for client tracking)
   * @param request.rpcName - The name of the RPC operation to execute
   * @param request.args - The input arguments (type-checked against RPC's input schema)
   * @returns The validated result (type-checked against RPC's result schema) or an RPC error object
   */
  public async sendRpcRequest<T extends keyof RpcSchemasRegistry>(request: {
    chatId: string;
    toolCallId: string;
    rpcName: T;
    args: RpcInput<T>;
  }): Promise<RpcResult<T> | RpcExecutionError | RpcValidationError> {
    const { chatId, toolCallId, rpcName, args } = request;

    if (this.abortedChats.has(chatId)) {
      return { errorCode: 'CLIENT_DISCONNECTED', message: 'Chat request was cancelled.', rpcName };
    }

    const socketSet = this.connections.get(chatId);
    const socket = socketSet ? this.getConnectedSocket(socketSet) : undefined;

    if (!socket) {
      return {
        errorCode: 'NO_CONNECTION',
        message: 'No WebSocket connection to the browser. The user has likely closed or navigated away from the page.',
        rpcName,
      };
    }

    const inputValidation = this.validateRpcInput(rpcName, args);
    if (!inputValidation.success) {
      this.logger.warn(`Input validation failed for ${rpcName}:`, inputValidation.error.validationErrors);
      return inputValidation.error;
    }

    const requestId = generatePrefixedId(idPrefix.request);
    const traceContext = injectTraceContext();
    const rpcRequest: RpcRequest = {
      type: 'rpc_request',
      chatId,
      requestId,
      toolCallId,
      rpcName,
      args: inputValidation.data,
      ...(Object.keys(traceContext).length > 0 ? { traceContext } : {}),
    };

    this.logger.debug(`Sending RPC request ${requestId} for ${rpcName} to chat ${chatId}`);

    const startTime = performance.now();
    this.metrics.rpcActiveCalls.add(1, { [AttributeKey.RPC_METHOD]: rpcName });

    const outboundSize = estimateJsonSize(rpcRequest);
    this.metrics.wsMessageSize.record(outboundSize, {
      [AttributeKey.WS_DIRECTION]: 'out',
      [AttributeKey.RPC_METHOD]: rpcName,
    });

    try {
      /* oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- emitWithAck returns untyped ack */
      const response: RpcResponse = await socket.timeout(rpcExecutionTimeoutMs).emitWithAck('rpc_request', rpcRequest);

      const inboundSize = estimateJsonSize(response);
      this.metrics.wsMessageSize.record(inboundSize, {
        [AttributeKey.WS_DIRECTION]: 'in',
        [AttributeKey.RPC_METHOD]: rpcName,
      });

      if (response.error) {
        this.recordRpcDuration(startTime, rpcName, { status: 'error' });
        return { errorCode: 'UNHANDLED_CLIENT_ERROR', message: response.error, rpcName };
      }

      const validated = this.validateRpcResult(rpcName, response.result);

      if (validated.success) {
        this.recordRpcDuration(startTime, rpcName, { status: 'ok' });
        this.logger.debug(`Resolved RPC call ${requestId} for ${rpcName}`);
        return validated.data as RpcResult<T>;
      }

      this.recordRpcDuration(startTime, rpcName, { status: 'error' });
      return validated.error;
    } catch {
      const errorCode = socket.connected ? 'TIMEOUT' : 'CLIENT_DISCONNECTED';
      const message = socket.connected
        ? `RPC execution timed out after ${rpcExecutionTimeoutMs / 1000} seconds. The client may be disconnected or unresponsive.`
        : 'WebSocket client disconnected before RPC execution completed.';

      this.recordRpcDuration(startTime, rpcName, { status: 'error', errorType: errorCode });
      this.logger.warn(`RPC call ${requestId} failed for chat ${chatId}: ${errorCode}`);
      return { errorCode, message, rpcName };
    }
  }

  /**
   * Check if a client is connected for a chat.
   */
  public isConnected(chatId: string): boolean {
    const socketSet = this.connections.get(chatId);
    return socketSet ? this.getConnectedSocket(socketSet) !== undefined : false;
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

  private recordRpcDuration(
    startTime: number,
    rpcMethod: string,
    options: { status: string; errorType?: string },
  ): void {
    const durationSeconds = (performance.now() - startTime) / 1000;
    const attributes: Record<string, string> = {
      [AttributeKey.RPC_METHOD]: rpcMethod,
      [AttributeKey.RPC_STATUS]: options.status,
    };
    if (options.errorType) {
      attributes[AttributeKey.ERROR_TYPE] = options.errorType;
    }
    this.metrics.rpcCallDuration.record(durationSeconds, attributes);
    this.metrics.rpcActiveCalls.add(-1, { [AttributeKey.RPC_METHOD]: rpcMethod });
  }

  /**
   * Schedule cleanup of the aborted chat entry after a short delay.
   * The delay catches RPCs that start after abort fires but before
   * LangGraph fully stops. The timer is tracked so it can be cancelled
   * if a new signal is registered for the same chatId.
   */
  private scheduleAbortCleanup(chatId: string): void {
    this.cancelAbortCleanupTimer(chatId);
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

const estimateJsonSize = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
};

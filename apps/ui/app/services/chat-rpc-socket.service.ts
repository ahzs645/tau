/**
 * Chat RPC Socket Service
 *
 * Singleton service that manages a single Socket.IO connection for chat RPC execution.
 * This service lives outside of React's lifecycle to avoid connection churn from
 * React Strict Mode and effect re-runs.
 *
 * Features:
 * - Single connection per browser tab (singleton pattern)
 * - Room-based routing for multiple chats
 * - Automatic reconnection with exponential backoff
 * - Status subscription for React components
 */
import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import type { RpcRequest, RpcResponse } from '@taucad/chat';
import { ENV } from '#environment.config.js';

/** Connection status for UI display */
export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'error'
  | 'unauthenticated';

/** Handler for incoming RPC requests */
export type RpcRequestHandler = (request: RpcRequest) => Promise<RpcResponse>;

/** Listener for connection status changes */
export type StatusListener = (status: ConnectionStatus, error?: string) => void;

/** Socket.IO URL for chat RPC */
const socketUrl = `${ENV.TAU_WEBSOCKET_URL}/v1/chat/rpc`;

/**
 * Singleton service for managing Socket.IO chat RPC connection.
 *
 * Maintains a single Socket.IO connection per browser tab that can be joined
 * to multiple chat rooms simultaneously. RPC requests are routed to the
 * appropriate handler based on the chatId in the request.
 *
 * Usage:
 * 1. Get instance: ChatRpcSocketService.getInstance()
 * 2. Connect: service.connect()
 * 3. Join chat: service.joinChat(chatId, onRpcRequest)
 * 4. Leave chat: service.leaveChat(chatId)
 * 5. Subscribe to status: service.subscribe(listener)
 */
export class ChatRpcSocketService {
  private static instance: ChatRpcSocketService | undefined;

  /**
   * Get the singleton instance of the service.
   */
  // eslint-disable-next-line @typescript-eslint/member-ordering -- Singleton pattern requires instance field before getInstance
  public static getInstance(): ChatRpcSocketService {
    ChatRpcSocketService.instance ??= new ChatRpcSocketService();

    return ChatRpcSocketService.instance;
  }

  private socket: Socket | undefined;
  private status: ConnectionStatus = 'disconnected';
  private error: string | undefined;

  /** Map of chatId to RPC request handler - supports multiple active chats */
  private readonly chatHandlers = new Map<string, RpcRequestHandler>();

  /** Set of status change listeners */
  private readonly statusListeners = new Set<StatusListener>();

  /** Event handler references for cleanup */
  private handleVisibilityChange: (() => void) | undefined;
  private handleOnline: (() => void) | undefined;

  /** Whether connection was rejected due to authentication failure - prevents reconnection attempts */
  private isAuthenticationFailure = false;

  /** Private constructor to enforce singleton pattern */
  private constructor() {
    // Singleton - use getInstance()
  }

  /**
   * Connect to the Socket.IO server.
   * Safe to call multiple times - will only connect if not already connected.
   */
  public connect(): void {
    if (this.socket?.connected) {
      return;
    }

    // Reset auth failure flag for new connection attempt (e.g., after user logs in)
    this.isAuthenticationFailure = false;

    // If we have an existing socket that's not connected, clean it up
    if (this.socket) {
      this.socket.disconnect();
      this.socket = undefined;
    }

    this.setStatus('connecting');

    this.socket = io(socketUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
      timeout: 20_000,
      withCredentials: true,
    });

    this.setupEventListeners();
    this.setupVisibilityHandlers();
  }

  /**
   * Disconnect from the Socket.IO server.
   */
  public disconnect(): void {
    this.cleanupVisibilityHandlers();

    if (this.socket) {
      this.socket.disconnect();
      this.socket = undefined;
    }

    this.chatHandlers.clear();
    this.setStatus('disconnected');
  }

  /**
   * Join a chat room and register a handler for RPC requests.
   * Multiple chats can be joined simultaneously.
   */
  public joinChat(chatId: string, onRpcRequest: RpcRequestHandler): void {
    // Store/update the handler for this chat
    this.chatHandlers.set(chatId, onRpcRequest);

    // If connected, join the room immediately
    if (this.socket?.connected) {
      this.socket.emit('join', { chatId });
    }
    // If not connected yet, the room will be joined when connection establishes
  }

  /**
   * Leave a chat room and unregister its handler.
   */
  public leaveChat(chatId: string): void {
    // Remove handler
    this.chatHandlers.delete(chatId);

    // Leave the room on the server
    if (this.socket?.connected) {
      this.socket.emit('leave', { chatId });
    }
  }

  /**
   * Get all active chat IDs.
   */
  public getActiveChatIds(): string[] {
    return [...this.chatHandlers.keys()];
  }

  /**
   * Check if a specific chat is active.
   */
  public isChatActive(chatId: string): boolean {
    return this.chatHandlers.has(chatId);
  }

  /**
   * Send an RPC response back to the server.
   */
  public sendRpcResponse(response: RpcResponse): void {
    if (!this.socket?.connected) {
      console.error('[ChatRpcSocket] Cannot send response - not connected');
      return;
    }

    this.socket.emit('rpc_response', response);
  }

  /**
   * Subscribe to connection status changes.
   * Returns an unsubscribe function.
   */
  public subscribe(listener: StatusListener): () => void {
    this.statusListeners.add(listener);

    // Immediately notify with current status
    listener(this.status, this.error);

    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Get the current connection status.
   */
  public getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Get the current error message, if any.
   */
  public getError(): string | undefined {
    return this.error;
  }

  /**
   * Check if connected.
   */
  public isConnected(): boolean {
    return this.status === 'connected';
  }

  /**
   * Manually trigger reconnection.
   */
  public reconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket.connect();
    }
  }

  /**
   * Set up Socket.IO event listeners.
   */
  private setupEventListeners(): void {
    const { socket } = this;
    if (!socket) {
      return;
    }

    socket.on('connect', () => {
      this.setStatus('connected');

      // Rejoin all active chat rooms
      for (const chatId of this.chatHandlers.keys()) {
        socket.emit('join', { chatId });
      }
    });

    socket.on('disconnect', (reason) => {
      // Don't update status or reconnect if this was an auth failure - already handled by error event
      if (this.isAuthenticationFailure) {
        return;
      }

      // Map disconnect reasons to user-friendly error messages
      const errorMessages: Record<string, string> = {
        'io server disconnect': 'Server closed connection',
        'io client disconnect': 'Disconnected by client',
        'transport close': 'Connection lost',
        'ping timeout': 'Connection timed out',
        'transport error': 'Transport error',
      };

      const errorMessage = errorMessages[reason];
      if (errorMessage) {
        this.setStatus('disconnected', errorMessage);
      } else {
        this.setStatus('disconnected');
      }

      // Socket.IO disables auto-reconnection for 'io server disconnect'
      // We need to manually reconnect after a delay
      if (reason === 'io server disconnect') {
        console.warn('[ChatRpcSocket] Server disconnected, manually reconnecting...');
        setTimeout(() => {
          if (this.socket && !this.socket.connected) {
            this.socket.connect();
          }
        }, 1000);
      }
    });

    socket.on('connect_error', (connectError) => {
      this.setStatus('error', connectError.message);
    });

    // Socket.IO manager events for reconnection
    socket.io.on('reconnect_attempt', () => {
      this.setStatus('reconnecting');
    });

    socket.io.on('reconnect_error', (reconnectError) => {
      console.warn('[ChatRpcSocket] Reconnection error:', reconnectError.message);
    });

    socket.io.on('reconnect', () => {
      this.setStatus('connected');

      // Rejoin all active chat rooms after reconnection
      for (const chatId of this.chatHandlers.keys()) {
        socket.emit('join', { chatId });
      }
    });

    socket.io.on('reconnect_failed', () => {
      this.setStatus('error', 'Failed to reconnect');
    });

    // Handle incoming RPC requests
    socket.on('rpc_request', (request: RpcRequest) => {
      void this.handleRpcRequest(request);
    });

    // Handle server errors
    socket.on('error', (serverError: { code: string; message: string }) => {
      // Check for authentication-related errors
      if (serverError.code === 'UNAUTHENTICATED' || serverError.code === 'AUTH_ERROR') {
        this.isAuthenticationFailure = true;
        this.setStatus('unauthenticated');

        // Disconnect to stop the Manager's reconnection loop
        // This sets skipReconnect = true in the Manager
        socket.disconnect();
        return;
      }

      this.setError(serverError.message);
    });
  }

  /**
   * Set up visibility and network status handlers.
   * Stores handler references for proper cleanup.
   */
  private setupVisibilityHandlers(): void {
    // Clean up existing listeners first to prevent stacking
    this.cleanupVisibilityHandlers();

    this.handleVisibilityChange = (): void => {
      // Don't attempt reconnection if auth failed
      if (this.isAuthenticationFailure) {
        return;
      }

      if (document.visibilityState === 'visible' && this.socket && !this.socket.connected) {
        this.socket.connect();
      }
    };

    this.handleOnline = (): void => {
      // Don't attempt reconnection if auth failed
      if (this.isAuthenticationFailure) {
        return;
      }

      if (this.socket && !this.socket.connected) {
        this.socket.connect();
      }
    };

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    globalThis.addEventListener('online', this.handleOnline);
  }

  /**
   * Clean up visibility and network status handlers.
   */
  private cleanupVisibilityHandlers(): void {
    if (this.handleVisibilityChange) {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      this.handleVisibilityChange = undefined;
    }

    if (this.handleOnline) {
      globalThis.removeEventListener('online', this.handleOnline);
      this.handleOnline = undefined;
    }
  }

  /**
   * Handle an incoming RPC request.
   * Routes to the appropriate handler based on chatId.
   */
  private async handleRpcRequest(request: RpcRequest): Promise<void> {
    const { chatId } = request;
    const handler = this.chatHandlers.get(chatId);

    if (!handler) {
      console.warn(`[ChatRpcSocket] Received RPC request for unknown chat: ${chatId}`);
      return;
    }

    try {
      const response = await handler(request);
      this.sendRpcResponse(response);
    } catch (execError) {
      // Send error response
      this.sendRpcResponse({
        type: 'rpc_response',
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        result: undefined,
        error: execError instanceof Error ? execError.message : 'Unknown error',
      });
    }
  }

  /**
   * Update status and notify listeners.
   */
  private setStatus(status: ConnectionStatus, errorMessage?: string): void {
    this.status = status;

    if (errorMessage !== undefined) {
      this.error = errorMessage;
    } else if (status === 'connected') {
      // Clear error on successful connection
      this.error = undefined;
    }

    // Notify all listeners
    for (const listener of this.statusListeners) {
      listener(this.status, this.error);
    }
  }

  /**
   * Set error without changing status.
   */
  private setError(errorMessage: string): void {
    this.error = errorMessage;

    // Notify all listeners
    for (const listener of this.statusListeners) {
      listener(this.status, this.error);
    }
  }
}

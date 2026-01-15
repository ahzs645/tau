/**
 * Chat Tools Socket Service
 *
 * Singleton service that manages a single Socket.IO connection for chat tool execution.
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
import type { ToolCallRequest, ToolCallResult } from '@taucad/chat';
import { ENV } from '#environment.config.js';

/** Connection status for UI display */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';

/** Handler for incoming tool call requests */
export type ToolRequestHandler = (request: ToolCallRequest) => Promise<ToolCallResult>;

/** Listener for connection status changes */
export type StatusListener = (status: ConnectionStatus, error?: string) => void;

/** Socket.IO URL for chat tools */
const socketUrl = `${ENV.TAU_WEBSOCKET_URL}/v1/chat/tools`;

/**
 * Singleton service for managing Socket.IO chat tools connection.
 *
 * Maintains a single Socket.IO connection per browser tab that can be joined
 * to multiple chat rooms simultaneously. Tool requests are routed to the
 * appropriate handler based on the chatId in the request.
 *
 * Usage:
 * 1. Get instance: ChatToolsSocketService.getInstance()
 * 2. Connect: service.connect()
 * 3. Join chat: service.joinChat(chatId, onToolRequest)
 * 4. Leave chat: service.leaveChat(chatId)
 * 5. Subscribe to status: service.subscribe(listener)
 */
export class ChatToolsSocketService {
  private static instance: ChatToolsSocketService | undefined;

  /**
   * Get the singleton instance of the service.
   */
  // eslint-disable-next-line @typescript-eslint/member-ordering -- Singleton pattern requires instance field before getInstance
  public static getInstance(): ChatToolsSocketService {
    ChatToolsSocketService.instance ??= new ChatToolsSocketService();

    return ChatToolsSocketService.instance;
  }

  private socket: Socket | undefined;
  private status: ConnectionStatus = 'disconnected';
  private error: string | undefined;

  /** Map of chatId to tool request handler - supports multiple active chats */
  private readonly chatHandlers = new Map<string, ToolRequestHandler>();

  /** Set of status change listeners */
  private readonly statusListeners = new Set<StatusListener>();

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
    if (this.socket) {
      this.socket.disconnect();
      this.socket = undefined;
    }

    this.chatHandlers.clear();
    this.setStatus('disconnected');
  }

  /**
   * Join a chat room and register a handler for tool requests.
   * Multiple chats can be joined simultaneously.
   */
  public joinChat(chatId: string, onToolRequest: ToolRequestHandler): void {
    // Store/update the handler for this chat
    this.chatHandlers.set(chatId, onToolRequest);

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
   * Send a tool call result back to the server.
   */
  public sendToolCallResult(result: ToolCallResult): void {
    if (!this.socket?.connected) {
      console.error('[ChatToolsSocket] Cannot send result - not connected');
      return;
    }

    this.socket.emit('tool_call_result', result);
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
      this.setStatus('disconnected');

      if (reason === 'io server disconnect') {
        this.setError('Server closed connection');
      }
    });

    socket.on('connect_error', (connectError) => {
      this.setStatus('error', connectError.message);
    });

    // Socket.IO manager events for reconnection
    socket.io.on('reconnect_attempt', () => {
      this.setStatus('reconnecting');
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

    // Handle incoming tool call requests
    socket.on('tool_call_request', (request: ToolCallRequest) => {
      void this.handleToolCallRequest(request);
    });

    // Handle server errors
    socket.on('error', (serverError: { code: string; message: string }) => {
      this.setError(serverError.message);
    });
  }

  /**
   * Set up visibility and network status handlers.
   */
  private setupVisibilityHandlers(): void {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible' && this.socket && !this.socket.connected) {
        this.socket.connect();
      }
    };

    const handleOnline = (): void => {
      if (this.socket && !this.socket.connected) {
        this.socket.connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    globalThis.addEventListener('online', handleOnline);
  }

  /**
   * Handle an incoming tool call request.
   * Routes to the appropriate handler based on chatId.
   */
  private async handleToolCallRequest(request: ToolCallRequest): Promise<void> {
    const { chatId } = request;
    const handler = this.chatHandlers.get(chatId);

    if (!handler) {
      console.warn(`[ChatToolsSocket] Received tool request for unknown chat: ${chatId}`);
      return;
    }

    try {
      const result = await handler(request);
      this.sendToolCallResult(result);
    } catch (execError) {
      // Send error result
      this.sendToolCallResult({
        type: 'tool_call_result',
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

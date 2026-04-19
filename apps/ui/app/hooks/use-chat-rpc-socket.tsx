/**
 * Chat RPC Socket React Integration
 *
 * Provides React hooks and context for the ChatRpcSocketService singleton.
 * The service manages a single Socket.IO connection outside of React's lifecycle,
 * while these hooks provide reactive state updates for React components.
 *
 * Key exports:
 * - ChatRpcSocketProvider: Wrap your app to initialize the socket connection
 * - useChatRpcSocket: Access the service instance
 * - useChatRpcConnection: Join a chat and get connection status
 */
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef } from 'react';

import type { RpcRequest, RpcResponse } from '@taucad/chat';
import { rpcNames } from '@taucad/chat/constants';
import { ChatRpcSocketService } from '#services/chat-rpc-socket.service.js';
import type { ConnectionStatus, RpcRequestHandler } from '#services/chat-rpc-socket.service.js';
import { createRpcHandlers } from '#hooks/rpc-handlers.js';
import type { RpcHandlerDependencies, RpcCallInput } from '#hooks/rpc-handlers.js';
import { useProject, useMainGraphics } from '#hooks/use-project.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useImageQuality } from '#hooks/use-image-quality.js';

// -----------------------------------------------------------------------------
// Context
// -----------------------------------------------------------------------------

const ChatRpcSocketContext = createContext<ChatRpcSocketService | undefined>(undefined);

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

type ChatRpcSocketProviderProps = {
  readonly children: ReactNode;
};

/**
 * Provider that initializes the Socket.IO connection at app startup.
 * Should be placed near the root of your app.
 */
export function ChatRpcSocketProvider({ children }: ChatRpcSocketProviderProps): React.JSX.Element {
  const service = useMemo(() => ChatRpcSocketService.getInstance(), []);

  useEffect(() => {
    // Connect on mount - the service handles idempotent connection
    service.connect();

    // Note: We intentionally don't disconnect on unmount.
    // The singleton connection should persist for the app's lifetime.
  }, [service]);

  return <ChatRpcSocketContext.Provider value={service}>{children}</ChatRpcSocketContext.Provider>;
}

// -----------------------------------------------------------------------------
// Hooks
// -----------------------------------------------------------------------------

/**
 * Get the ChatRpcSocketService instance.
 * Must be used within a ChatRpcSocketProvider.
 */
export function useChatRpcSocket(): ChatRpcSocketService {
  const service = useContext(ChatRpcSocketContext);

  if (!service) {
    throw new Error('useChatRpcSocket must be used within a ChatRpcSocketProvider');
  }

  return service;
}

/**
 * Subscribe to connection status changes.
 * Returns the current status and error state.
 */
export function useChatRpcStatus(): { status: ConnectionStatus; error: string | undefined } {
  const service = useChatRpcSocket();
  const [status, setStatus] = useState<ConnectionStatus>(service.getStatus());
  const [error, setError] = useState<string | undefined>(service.getError());

  useEffect(() => {
    const unsubscribe = service.subscribe((newStatus, newError) => {
      setStatus(newStatus);
      setError(newError);
    });

    return unsubscribe;
  }, [service]);

  return { status, error };
}

// -----------------------------------------------------------------------------
// Chat Connection Hook (Main API)
// -----------------------------------------------------------------------------

type UseChatRpcConnectionOptions = {
  /** The chat ID to connect for */
  chatId: string | undefined;
  /** Whether the connection is enabled */
  enabled?: boolean;
};

type UseChatRpcConnectionReturn = {
  /** Current connection status */
  status: ConnectionStatus;
  /** Whether connected (shortcut for status === 'connected') */
  isConnected: boolean;
  /** Any error message */
  error: string | undefined;
  /** Manually trigger reconnection */
  reconnect: () => void;
};

/**
 * Join a chat room and handle RPC requests.
 *
 * This hook:
 * 1. Joins the chat room when enabled and chatId is provided
 * 2. Sets up RPC request handling using the current project context
 * 3. Leaves the chat room on cleanup or when disabled
 * 4. Provides reactive connection status updates
 */
export function useChatRpcConnection(options: UseChatRpcConnectionOptions): UseChatRpcConnectionReturn {
  const { chatId, enabled = true } = options;

  const service = useChatRpcSocket();
  const { status, error } = useChatRpcStatus();

  // Get dependencies for RPC handlers
  const { projectRef } = useProject();
  const mainGraphicsRef = useMainGraphics();
  const fileManager = useFileManager();
  const { treeService } = fileManager;
  const { quality: screenshotQuality } = useImageQuality();

  // Store dependencies in a ref so handler always uses current values
  // without causing effect re-runs when deps change
  const depsRef = useRef<RpcHandlerDependencies | undefined>(undefined);
  depsRef.current = {
    fileManager,
    graphicsRef: mainGraphicsRef,
    projectRef,
    treeService,
    screenshotQuality,
  };

  // Create stable RPC request handler that reads deps from ref
  const handleRpcRequest: RpcRequestHandler = useCallback(async (request: RpcRequest): Promise<RpcResponse> => {
    const deps = depsRef.current;
    if (!deps) {
      return {
        type: 'rpc_response',
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        result: undefined,
        error: 'RPC handler not initialized',
      };
    }

    const { requestId, toolCallId, rpcName: currentRpcName, args } = request;

    // Verify this is a valid RPC operation
    const isValidRpc = rpcNames.includes(currentRpcName);
    if (!isValidRpc) {
      console.warn(`[ChatRpcSocket] Received request for unknown RPC: ${currentRpcName}`);
      return {
        type: 'rpc_response',
        requestId,
        toolCallId,
        result: undefined,
        error: `Unknown RPC: ${currentRpcName}`,
      };
    }

    // After validation, we can safely construct the typed RPC call.
    // The server has validated the args against the schema before sending.
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Boundary assertion after runtime validation
    const rpcCall = {
      toolCallId,
      rpcName: currentRpcName,
      args,
    } as RpcCallInput;

    try {
      const handlers = createRpcHandlers(deps);

      const result = await handlers.executeRpcCall(rpcCall);

      return {
        type: 'rpc_response',
        requestId,
        toolCallId,
        result,
      };
    } catch (execError) {
      return {
        type: 'rpc_response',
        requestId,
        toolCallId,
        result: undefined,
        error: execError instanceof Error ? execError.message : 'Unknown error',
      };
    }
  }, []); // No dependencies - reads from ref

  // Join/leave chat room based on enabled and chatId
  // Only re-runs when chatId or enabled changes, NOT when deps change
  useEffect(() => {
    if (!enabled || !chatId) {
      return;
    }

    // Join the chat room with our handler
    service.joinChat(chatId, handleRpcRequest);

    // Leave on cleanup
    return () => {
      service.leaveChat(chatId);
    };
  }, [enabled, chatId, service, handleRpcRequest]);

  const reconnect = useCallback(() => {
    service.reconnect();
  }, [service]);

  return {
    status,
    isConnected: status === 'connected',
    error,
    reconnect,
  };
}

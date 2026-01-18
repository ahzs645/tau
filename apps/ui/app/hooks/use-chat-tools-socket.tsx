/**
 * Chat Tools Socket React Integration
 *
 * Provides React hooks and context for the ChatToolsSocketService singleton.
 * The service manages a single Socket.IO connection outside of React's lifecycle,
 * while these hooks provide reactive state updates for React components.
 *
 * Key exports:
 * - ChatToolsSocketProvider: Wrap your app to initialize the socket connection
 * - useChatToolsSocket: Access the service instance
 * - useChatToolsConnection: Join a chat and get connection status
 */
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useSelector } from '@xstate/react';
import type { ToolCallRequest, ToolCallResult } from '@taucad/chat';
import { clientToolNames } from '@taucad/chat/constants';
import { ChatToolsSocketService } from '#services/chat-tools-socket.service.js';
import type { ConnectionStatus, ToolRequestHandler } from '#services/chat-tools-socket.service.js';
import { createToolHandlers } from '#hooks/tool-handlers.js';
import type { ToolHandlerDependencies } from '#hooks/tool-handlers.js';
import { useBuild } from '#hooks/use-build.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useImageQuality } from '#hooks/use-image-quality.js';

// -----------------------------------------------------------------------------
// Context
// -----------------------------------------------------------------------------

const ChatToolsSocketContext = createContext<ChatToolsSocketService | undefined>(undefined);

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

type ChatToolsSocketProviderProps = {
  readonly children: ReactNode;
};

/**
 * Provider that initializes the Socket.IO connection at app startup.
 * Should be placed near the root of your app.
 */
export function ChatToolsSocketProvider({ children }: ChatToolsSocketProviderProps): React.JSX.Element {
  const service = useMemo(() => ChatToolsSocketService.getInstance(), []);

  useEffect(() => {
    // Connect on mount - the service handles idempotent connection
    service.connect();

    // Note: We intentionally don't disconnect on unmount.
    // The singleton connection should persist for the app's lifetime.
  }, [service]);

  return <ChatToolsSocketContext.Provider value={service}>{children}</ChatToolsSocketContext.Provider>;
}

// -----------------------------------------------------------------------------
// Hooks
// -----------------------------------------------------------------------------

/**
 * Get the ChatToolsSocketService instance.
 * Must be used within a ChatToolsSocketProvider.
 */
export function useChatToolsSocket(): ChatToolsSocketService {
  const service = useContext(ChatToolsSocketContext);

  if (!service) {
    throw new Error('useChatToolsSocket must be used within a ChatToolsSocketProvider');
  }

  return service;
}

/**
 * Subscribe to connection status changes.
 * Returns the current status and error state.
 */
export function useChatToolsStatus(): { status: ConnectionStatus; error: string | undefined } {
  const service = useChatToolsSocket();
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

type UseChatToolsConnectionOptions = {
  /** The chat ID to connect for */
  chatId: string | undefined;
  /** Whether the connection is enabled */
  enabled?: boolean;
};

type UseChatToolsConnectionReturn = {
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
 * Join a chat room and handle tool call requests.
 *
 * This hook:
 * 1. Joins the chat room when enabled and chatId is provided
 * 2. Sets up tool request handling using the current build context
 * 3. Leaves the chat room on cleanup or when disabled
 * 4. Provides reactive connection status updates
 */
export function useChatToolsConnection(options: UseChatToolsConnectionOptions): UseChatToolsConnectionReturn {
  const { chatId, enabled = true } = options;

  const service = useChatToolsSocket();
  const { status, error } = useChatToolsStatus();

  // Get dependencies for tool handlers
  const { graphicsRef: graphicsActor, cadRef: cadActor } = useBuild();
  const fileManager = useFileManager();
  const { fileManagerRef } = fileManager;
  const fileTree = useSelector(fileManagerRef, (state) => state.context.fileTree);
  const { quality: screenshotQuality } = useImageQuality();

  // Store dependencies in a ref so handler always uses current values
  // without causing effect re-runs when deps change
  const depsRef = useRef<ToolHandlerDependencies | undefined>(undefined);
  depsRef.current = {
    fileManager,
    fileManagerRef,
    graphicsRef: graphicsActor,
    cadRef: cadActor,
    fileTree,
    screenshotQuality,
  };

  // Create stable tool request handler that reads deps from ref
  const handleToolRequest: ToolRequestHandler = useCallback(
    async (request: ToolCallRequest): Promise<ToolCallResult> => {
      const deps = depsRef.current;
      if (!deps) {
        return {
          type: 'tool_call_result',
          requestId: request.requestId,
          toolCallId: request.toolCallId,
          result: undefined,
          error: 'Tool handler not initialized',
        };
      }

      const { requestId, toolCallId, toolName: currentToolName, args } = request;

      // Verify this is a client-side tool
      const isClientTool = clientToolNames.includes(currentToolName);
      if (!isClientTool) {
        console.warn(`[ChatToolsSocket] Received request for non-client tool: ${currentToolName}`);
        return {
          type: 'tool_call_result',
          requestId,
          toolCallId,
          result: undefined,
          error: `Unknown tool: ${currentToolName}`,
        };
      }

      try {
        const handlers = createToolHandlers(deps);

        const result = await handlers.executeToolCall({
          toolCallId,
          toolName: currentToolName,
          args,
        });

        return {
          type: 'tool_call_result',
          requestId,
          toolCallId,
          result,
        };
      } catch (execError) {
        return {
          type: 'tool_call_result',
          requestId,
          toolCallId,
          result: undefined,
          error: execError instanceof Error ? execError.message : 'Unknown error',
        };
      }
    },
    [],
  ); // No dependencies - reads from ref

  // Join/leave chat room based on enabled and chatId
  // Only re-runs when chatId or enabled changes, NOT when deps change
  useEffect(() => {
    if (!enabled || !chatId) {
      return;
    }

    // Join the chat room with our handler
    service.joinChat(chatId, handleToolRequest);

    // Leave on cleanup
    return () => {
      service.leaveChat(chatId);
    };
  }, [enabled, chatId, service, handleToolRequest]);

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

/**
 * WebSocket Hook for Client-Side Tool Execution
 *
 * Manages a WebSocket connection to the backend for executing tools.
 * The backend sends tool call requests, and this hook executes them
 * using the extracted tool handlers.
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { useSelector } from '@xstate/react';
import type { ToolCallRequest, ToolCallResult, WsConnectMessage, ServerToClientMessage } from '@taucad/chat';
import { clientToolNames, wsCloseCode } from '@taucad/chat/constants';
import { ENV } from '#environment.config.js';
import { createToolHandlers } from '#hooks/tool-handlers.js';
import type { ToolHandlerDependencies } from '#hooks/tool-handlers.js';
import { useBuild } from '#hooks/use-build.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { useImageQuality } from '#hooks/use-image-quality.js';

export type UseChatToolsWebSocketOptions = {
  /** The chat ID to connect for */
  chatId: string | undefined;
  /** Whether the hook is enabled */
  enabled?: boolean;
};

export type UseChatToolsWebSocketReturn = {
  /** Whether the WebSocket is connected */
  isConnected: boolean;
  /** Whether the WebSocket is currently connecting */
  isConnecting: boolean;
  /** Any error that occurred */
  error: string | undefined;
  /** Manually reconnect */
  reconnect: () => void;
};

/**
 * Hook for managing WebSocket-based tool execution.
 *
 * Connects to the backend WebSocket when a chatId is provided,
 * receives tool call requests, executes them using the tool handlers,
 * and sends the results back.
 */
export function useChatToolsWebSocket(options: UseChatToolsWebSocketOptions): UseChatToolsWebSocketReturn {
  const { chatId, enabled = true } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Get dependencies for tool handlers
  const { graphicsRef: graphicsActor, cadRef: cadActor, getMainFilename, buildId } = useBuild();
  const fileManager = useFileManager();
  const { fileManagerRef } = fileManager;
  const fileTree = useSelector(fileManagerRef, (state) => state.context.fileTree);
  const { quality: screenshotQuality } = useImageQuality();

  // Create stable dependencies object
  const depsRef = useRef<ToolHandlerDependencies | undefined>(undefined);
  depsRef.current = {
    buildId,
    fileManager,
    fileManagerRef,
    graphicsRef: graphicsActor,
    cadRef: cadActor,
    fileTree,
    getMainFilename,
    screenshotQuality,
  };

  // Handle incoming tool call request
  const handleToolCallRequest = useCallback(async (request: ToolCallRequest) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.error('[ChatToolsWS] Cannot handle request - socket not open');
      return;
    }

    const { requestId, toolCallId, toolName: currentToolName, args } = request;

    // Verify this is a client-side tool
    const isClientTool = clientToolNames.includes(currentToolName);
    if (!isClientTool) {
      console.warn(`[ChatToolsWS] Received request for non-client tool: ${currentToolName}`);
      return;
    }

    try {
      // Create handlers with current dependencies
      if (!depsRef.current) {
        throw new Error('Tool handler dependencies not initialized');
      }

      const handlers = createToolHandlers(depsRef.current);

      // Execute the tool
      const result = await handlers.executeToolCall({
        toolCallId,
        toolName: currentToolName,
        args,
      });

      // Send result back
      const response: ToolCallResult = {
        type: 'tool_call_result',
        requestId,
        toolCallId,
        result,
      };

      socket.send(JSON.stringify(response));
    } catch (execError) {
      // Send error result
      const response: ToolCallResult = {
        type: 'tool_call_result',
        requestId,
        toolCallId,
        result: undefined,
        error: execError instanceof Error ? execError.message : 'Unknown error',
      };

      socket.send(JSON.stringify(response));
    }
  }, []);

  // Handle incoming WebSocket message
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data as string) as ServerToClientMessage;

        switch (message.type) {
          case 'connected': {
            console.log(`[ChatToolsWS] Connected for chat ${message.chatId}`);
            setIsConnected(true);
            setIsConnecting(false);
            setError(undefined);
            break;
          }

          case 'tool_call_request': {
            void handleToolCallRequest(message);
            break;
          }

          case 'error': {
            console.error(`[ChatToolsWS] Server error: ${message.code} - ${message.message}`);
            setError(message.message);
            break;
          }

          default: {
            console.warn('[ChatToolsWS] Unknown message type:', message);
          }
        }
      } catch (parseError) {
        console.error('[ChatToolsWS] Failed to parse message:', parseError);
      }
    },
    [handleToolCallRequest],
  );

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (!chatId || !enabled) {
      return;
    }

    // Close existing connection
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = undefined;
    }

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }

    setIsConnecting(true);
    setError(undefined);

    const wsUrl = `${ENV.TAU_WEBSOCKET_URL}/v1/chat/tools`;
    console.log(`[ChatToolsWS] Connecting to ${wsUrl}`);

    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.addEventListener('open', () => {
      console.log('[ChatToolsWS] WebSocket opened, sending connect message');

      // Send connect message with chatId
      const connectMessage: WsConnectMessage = {
        type: 'connect',
        chatId,
      };
      socket.send(JSON.stringify(connectMessage));
    });

    socket.addEventListener('message', handleMessage);

    socket.addEventListener('error', (wsError) => {
      console.error('[ChatToolsWS] WebSocket error:', wsError);
      setError('WebSocket connection error');
    });

    socket.addEventListener('close', (event) => {
      console.log(`[ChatToolsWS] WebSocket closed: ${event.code} - ${event.reason}`);
      setIsConnected(false);
      setIsConnecting(false);

      // Handle specific close codes
      if (event.code === wsCloseCode.unauthenticated) {
        setError('Authentication required');
        return;
      }

      if (event.code === wsCloseCode.superseded) {
        // Connection was superseded by another tab, don't reconnect
        console.log('[ChatToolsWS] Connection superseded by another tab');
        return;
      }

      // Reconnect after a delay for unexpected closes
      if (chatId && event.code !== wsCloseCode.sessionEnded) {
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('[ChatToolsWS] Attempting to reconnect...');
          connect();
        }, 3000);
      }
    });
  }, [chatId, enabled, handleMessage]);

  // Disconnect function
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }

    if (socketRef.current) {
      // Use numeric close code directly (4003 = sessionEnded)
      socketRef.current.close(4003, 'Session ended');
      socketRef.current = undefined;
    }

    setIsConnected(false);
    setIsConnecting(false);
  }, []);

  // Connect when chatId changes
  useEffect(() => {
    if (chatId && enabled) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [chatId, enabled, connect, disconnect]);

  // Manual reconnect function
  const reconnect = useCallback(() => {
    disconnect();
    connect();
  }, [disconnect, connect]);

  return {
    isConnected,
    isConnecting,
    error,
    reconnect,
  };
}

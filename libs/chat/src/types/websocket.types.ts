import type { ClientToolName } from '#types/tool.types.js';
import type { wsCloseCode } from '#constants/websocket.constants.js';

export type WsCloseCode = (typeof wsCloseCode)[keyof typeof wsCloseCode];

/**
 * Server -> Client: Request to execute a tool on the client.
 */
export type ToolCallRequest = {
  type: 'tool_call_request';
  /** Unique ID for this request (used to match response) */
  requestId: string;
  /** The tool call ID from the LLM */
  toolCallId: string;
  /** The name of the tool to execute */
  toolName: ClientToolName;
  /** The arguments for the tool */
  args: unknown;
};

/**
 * Client -> Server: Result of a tool execution.
 */
export type ToolCallResult = {
  type: 'tool_call_result';
  /** The request ID this result corresponds to */
  requestId: string;
  /** The tool call ID from the original request */
  toolCallId: string;
  /** The result of the tool execution */
  result: unknown;
  /** Error message if the tool execution failed */
  error?: string;
};

/**
 * Client -> Server: Register connection for a specific chat.
 */
export type WsConnectMessage = {
  type: 'connect';
  /** The chat ID to associate with this connection */
  chatId: string;
};

/**
 * Server -> Client: Acknowledgment of successful connection registration.
 */
export type WsConnectedMessage = {
  type: 'connected';
  /** The chat ID that was registered */
  chatId: string;
};

/**
 * Server -> Client: Error message.
 */
export type WsErrorMessage = {
  type: 'error';
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
};

/**
 * All possible messages from server to client.
 */
export type ServerToClientMessage = ToolCallRequest | WsConnectedMessage | WsErrorMessage;

/**
 * All possible messages from client to server.
 */
export type ClientToServerMessage = ToolCallResult | WsConnectMessage;

/**
 * Structured error returned to LLM when tool execution times out.
 */
export type ToolTimeoutError = {
  errorCode: 'TOOL_EXECUTION_TIMEOUT';
  message: string;
  toolName: string;
  toolCallId: string;
};

/**
 * Structured error returned to LLM when client disconnects during tool execution.
 */
export type ToolDisconnectedError = {
  errorCode: 'CLIENT_DISCONNECTED';
  message: string;
  toolName: string;
  toolCallId: string;
};

/**
 * Structured error returned to LLM when no client is connected.
 */
export type ToolNoConnectionError = {
  errorCode: 'NO_CLIENT_CONNECTION';
  message: string;
  toolName: string;
  toolCallId: string;
};

/**
 * All possible structured tool errors.
 */
export type ToolExecutionError = ToolTimeoutError | ToolDisconnectedError | ToolNoConnectionError;

/**
 * WebSocket Transport Types
 *
 * This file contains types for WebSocket message transport only.
 * Tool-specific types are in tool.types.ts.
 * RPC protocol types are in rpc.types.ts.
 */
import type { RpcName } from '#types/rpc.types.js';
import type { wsCloseCode } from '#constants/websocket.constants.js';

/** @public */
export type WsCloseCode = (typeof wsCloseCode)[keyof typeof wsCloseCode];

/**
 * Server -> Client: Request to execute an RPC operation on the client.
 * @public
 */
export type RpcRequest = {
  type: 'rpc_request';
  /** The chat ID this request is for */
  chatId: string;
  /** Unique ID for this request (used to match response) */
  requestId: string;
  /** The tool call ID from the LLM */
  toolCallId: string;
  /** The name of the RPC operation to execute */
  rpcName: RpcName;
  /** The arguments for the RPC operation */
  args: unknown;
  /** W3C trace context for distributed tracing propagation */
  traceContext?: Record<string, string>;
};

/**
 * Client -> Server: Result of an RPC operation execution.
 * @public
 */
export type RpcResponse = {
  type: 'rpc_response';
  /** The request ID this response corresponds to */
  requestId: string;
  /** The tool call ID from the original request */
  toolCallId: string;
  /** The result of the RPC operation */
  result: unknown;
  /** Error message if the RPC operation failed (infrastructure error) */
  error?: string;
  /** W3C trace context echoed back from client for distributed tracing */
  traceContext?: Record<string, string>;
};

/**
 * Client -> Server: Register connection for a specific chat.
 * @public
 */
export type WsConnectMessage = {
  type: 'connect';
  /** The chat ID to associate with this connection */
  chatId: string;
};

/**
 * Server -> Client: Acknowledgment of successful connection registration.
 * @public
 */
export type WsConnectedMessage = {
  type: 'connected';
  /** The chat ID that was registered */
  chatId: string;
};

/**
 * Server -> Client: Error message.
 * @public
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
 * @public
 */
export type ServerToClientMessage = RpcRequest | WsConnectedMessage | WsErrorMessage;

/**
 * All possible messages from client to server.
 * @public
 */
export type ClientToServerMessage = RpcResponse | WsConnectMessage;

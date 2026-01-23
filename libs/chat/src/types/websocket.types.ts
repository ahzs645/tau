/**
 * WebSocket Transport Types
 *
 * This file contains types for WebSocket message transport only.
 * Tool-specific types are in tool.types.ts.
 * RPC protocol types are in rpc.types.ts.
 */
import type { RpcName } from '#types/rpc.types.js';
import type { wsCloseCode } from '#constants/websocket.constants.js';

export type WsCloseCode = (typeof wsCloseCode)[keyof typeof wsCloseCode];

/**
 * Server -> Client: Request to execute an RPC operation on the client.
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
};

/**
 * Client -> Server: Result of an RPC operation execution.
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
export type ServerToClientMessage = RpcRequest | WsConnectedMessage | WsErrorMessage;

/**
 * All possible messages from client to server.
 */
export type ClientToServerMessage = RpcResponse | WsConnectMessage;

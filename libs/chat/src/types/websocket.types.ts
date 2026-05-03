/**
 * WebSocket Transport Types
 *
 * This file contains types for WebSocket message transport only.
 * Tool-specific types are in tool.types.ts.
 * RPC protocol types are in rpc.types.ts.
 */
import type { RpcName } from '#types/rpc.types.js';
import type { RpcInput, RpcResult } from '#schemas/rpc.schema.js';
import type { wsCloseCode } from '#constants/websocket.constants.js';

/** @public */
export type WsCloseCode = (typeof wsCloseCode)[keyof typeof wsCloseCode];

/**
 * Server → client RPC request, discriminated by `rpcName` so `args` narrows with the method
 * (mirrors `RpcCall` plus transport metadata).
 * @public
 */
export type RpcRequest = {
  [K in RpcName]: {
    type: 'rpc_request';
    /** The chat ID this request is for */
    chatId: string;
    /** Unique ID for this request (used to match response) */
    requestId: string;
    /** The tool call ID from the LLM */
    toolCallId: string;
    /** The name of the RPC operation to execute */
    rpcName: K;
    /** The arguments for the RPC operation */
    args: RpcInput<K>;
    /** W3C trace context for distributed tracing propagation */
    traceContext?: Record<string, string>;
  };
}[RpcName];

/**
 * Builds a correlated success ack for the wire after handler execution.
 *
 * `RpcResponse` discriminates `result` on `rpcName`, but TypeScript does not prove that a
 * `RpcResult<RpcName>` value matches `request.rpcName` when both originate from one dispatch — this
 * helper is the single sanctioned narrowing point at the browser/WS boundary.
 *
 * @public
 */
export function rpcWireSuccessResponse(request: RpcRequest, result: RpcResult<RpcName>): RpcResponse {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- correlated rpcName ↔ result; see JSDoc
  return {
    type: 'rpc_response',
    rpcName: request.rpcName,
    requestId: request.requestId,
    toolCallId: request.toolCallId,
    result,
  } as RpcResponse;
}

/**
 * Client -> Server: Result of an RPC operation execution (success path).
 * Discriminated on `rpcName` so payloads narrow with the mirrored request.
 * @public
 */
export type RpcResponseSuccess<T extends RpcName> = {
  type: 'rpc_response';
  rpcName: T;
  /** The request ID this response corresponds to */
  requestId: string;
  /** The tool call ID from the original request */
  toolCallId: string;
  /** The result of the RPC operation */
  result: RpcResult<T>;
  /** W3C trace context echoed back from client for distributed tracing */
  traceContext?: Record<string, string>;
};

/**
 * Client -> Server: Result of an RPC operation execution (client-side failure path).
 * @public
 */
export type RpcResponseError<T extends RpcName> = {
  type: 'rpc_response';
  rpcName: T;
  requestId: string;
  toolCallId: string;
  result: undefined;
  /** Error message if the RPC operation failed before producing a structured result */
  error: string;
  traceContext?: Record<string, string>;
};

/**
 * Client -> Server: Result of an RPC operation execution for one method.
 * @public
 */
export type RpcResponseFor<T extends RpcName> = RpcResponseSuccess<T> | RpcResponseError<T>;

/**
 * Client -> Server: Result of an RPC operation execution (all methods).
 * @public
 */
export type RpcResponse = { [K in RpcName]: RpcResponseFor<K> }[RpcName];

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

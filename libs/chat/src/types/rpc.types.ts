import type { RpcClientError } from '#schemas/rpc.schema.js';
import type { rpcExecutionErrorCode, rpcName } from '#constants/rpc.constants.js';
import { rpcExecutionErrorCodes } from '#constants/rpc.constants.js';

// =============================================================================
// RPC Name Types
// =============================================================================

/**
 * RPC operation names.
 * These are the names of remote procedure calls that the server can invoke on the client.
 */
export type RpcName = (typeof rpcName)[keyof typeof rpcName];

// =============================================================================
// RPC Execution Error Types
// =============================================================================

/**
 * Error codes for RPC infrastructure failures.
 * These are distinct from client errors (RpcClientError with success: false).
 * Derived from rpcExecutionErrorCode constants.
 */
export type RpcExecutionErrorCode = (typeof rpcExecutionErrorCode)[keyof typeof rpcExecutionErrorCode];

/**
 * Base RPC execution error for infrastructure failures.
 * Returned by ChatRpcService when RPC execution fails due to
 * connection issues, timeouts, or validation errors.
 */
export type RpcExecutionError = {
  errorCode: RpcExecutionErrorCode;
  message: string;
  rpcName: string;
};

/**
 * RPC validation error with detailed validation information.
 * Returned when input or output validation fails.
 */
export type RpcValidationError = {
  errorCode: typeof rpcExecutionErrorCode.inputValidationFailed | typeof rpcExecutionErrorCode.outputValidationFailed;
  message: string;
  rpcName: string;
  validationErrors: Array<{ path: string; message: string }>;
  rawOutput?: unknown;
};

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard for RPC execution errors (infrastructure failures).
 * Use this to check if an RPC result is an infrastructure error
 * before checking for client errors (isRpcClientError).
 *
 * @example
 * ```typescript
 * const result = await chatRpcService.sendRpcRequest(...);
 *
 * if (isRpcExecutionError(result)) {
 *   // Infrastructure error (timeout, disconnect, validation)
 *   return rpcErrorToToolError(result, toolName, toolCallId);
 * }
 *
 * if (isRpcClientError(result)) {
 *   // Client error (file not found, permission denied)
 *   return createToolError(result.message);
 * }
 *
 * // Success - result is narrowed to success type
 * const content = result.content;
 * ```
 */
export function isRpcExecutionError(result: unknown): result is RpcExecutionError {
  return (
    typeof result === 'object' &&
    result !== null &&
    'errorCode' in result &&
    typeof (result as { errorCode: unknown }).errorCode === 'string' &&
    rpcExecutionErrorCodes.includes((result as { errorCode: string }).errorCode as RpcExecutionErrorCode)
  );
}

/**
 * Type guard for RPC client errors (success: false).
 * Use this to discriminate between success and error results
 * after checking for infrastructure errors (isRpcExecutionError).
 *
 * RPC client errors are structured business-level errors returned by the
 * client (e.g., FILE_NOT_FOUND, PERMISSION_DENIED), as opposed to
 * infrastructure errors (timeout, disconnect) which are RpcExecutionErrors.
 *
 * @example
 * ```typescript
 * const result = await chatRpcService.sendRpcRequest(...);
 *
 * if (isRpcExecutionError(result)) {
 *   // Infrastructure error (timeout, disconnect)
 *   return rpcErrorToToolError(result, toolName, toolCallId);
 * }
 *
 * if (isRpcClientError(result)) {
 *   // Client error (file not found, permission denied)
 *   return createToolError(result.message);
 * }
 *
 * // Success - result is narrowed to success type
 * const content = result.content;
 * ```
 */
export function isRpcClientError(result: { success: boolean }): result is RpcClientError {
  return !result.success;
}

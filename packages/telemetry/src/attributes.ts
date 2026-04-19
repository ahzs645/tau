/* eslint-disable @typescript-eslint/naming-convention -- OTEL constant enum objects use UPPER_SNAKE_CASE */
/**
 * Well-known attribute keys used in OTEL metric recording.
 * Keys follow OTEL semantic conventions (dot-separated, lowercase).
 * @public
 */
export const AttributeKey = {
  KERNEL_STATUS: 'kernel.status',
  EXPORT_FORMAT: 'export.format',
  RPC_METHOD: 'rpc.method',
  RPC_STATUS: 'rpc.status',
  WS_CLOSE_REASON: 'ws.close.reason',
  GEN_AI_TOOL_NAME: 'gen_ai.tool.name',
  GEN_AI_TOOL_STATUS: 'gen_ai.tool.status',
  GEN_AI_TOKEN_TYPE: 'gen_ai.token.type',
  GEN_AI_REQUEST_MODEL: 'gen_ai.request.model',
  REDIS_ROLE: 'redis.role',
  SSE_EVENT_TYPE: 'sse.event.type',
  ERROR_TYPE: 'error.type',
  WS_RECONNECTION_ATTEMPT: 'ws.reconnection.attempt',
  EDITOR_KERNEL: 'editor.kernel',
  WASM_MODULE: 'wasm.module',
  INDEXEDDB_OPERATION: 'indexeddb.operation',
  INDEXEDDB_STORE: 'indexeddb.store',
  GEN_AI_PROVIDER_NAME: 'gen_ai.provider.name',
  GEN_AI_OPERATION_NAME: 'gen_ai.operation.name',
  GEN_AI_RESPONSE_MODEL: 'gen_ai.response.model',
  WS_DIRECTION: 'ws.direction',
} as const;

/**
 * Status values for kernel execution metrics.
 * @public
 */
export const KernelStatus = {
  SUCCESS: 'success',
  ERROR: 'error',
} as const;

/**
 * Status values for GenAI tool invocations.
 * @public
 */
export const GenAiToolStatus = {
  SUCCESS: 'success',
  ERROR: 'error',
} as const;

/**
 * Token type values for GenAI token usage metrics.
 * @public
 */
export const GenAiTokenType = {
  INPUT: 'input',
  OUTPUT: 'output',
} as const;

/**
 * RPC call status values.
 * @public
 */
export const RpcStatus = {
  OK: 'ok',
  ERROR: 'error',
} as const;

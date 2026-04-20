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
  GEN_AI_SAFEGUARD_PATTERN: 'gen_ai.agent.safeguard.pattern',
  GEN_AI_SAFEGUARD_ACTION: 'gen_ai.agent.safeguard.action',
  GEN_AI_SAFEGUARD_HELPED: 'gen_ai.agent.safeguard.helped',
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
 * Action values for GenAI agent safeguard interventions.
 *
 * - `nudge`: A `<system-reminder>` HumanMessage was appended to state.messages
 *   to redirect the agent away from a detected anti-pattern.
 * - `terminate`: The model call was short-circuited with a synthetic AIMessage
 *   that has no `tool_calls`, ending the agent loop.
 * @public
 */
export const GenAiSafeguardAction = {
  NUDGE: 'nudge',
  TERMINATE: 'terminate',
} as const;

/**
 * Whether the agent changed its behavior on the turn following a safeguard
 * nudge.
 * - `true`: the agent's next tool call differed from the offending signature
 *   (or it produced no tool calls at all)
 * - `false`: the agent repeated the offending tool call signature anyway
 * @public
 */
export const GenAiSafeguardHelped = {
  TRUE: 'true',
  FALSE: 'false',
} as const;

/**
 * RPC call status values.
 * @public
 */
export const RpcStatus = {
  OK: 'ok',
  ERROR: 'error',
} as const;

/**
 * RPC Schemas for Client-Side Operations
 *
 * This file defines discriminated result types for RPC operations executed
 * via WebSocket between the backend and frontend. Each RPC operation returns
 * a discriminated union with `success: true` for success cases and
 * `success: false` with error details for failures.
 *
 * The rpcSchemasRegistry is used by ChatRpcService for validating inputs and results.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';
import { rpcName } from '#constants/rpc.constants.js';
import { diffStatsWithContentSchema } from '#schemas/tools/diff.schema.js';
import { kernelIssueSchema } from '#schemas/tools/issue.schema.js';
import { observationSchema } from '#schemas/tools/test-model.tool.schema.js';

// =============================================================================
// RPC Error Types
// =============================================================================

/**
 * Error codes for business-level RPC failures.
 * These are distinct from infrastructure errors (timeout, disconnect) which
 * are handled by ToolExecutionError.
 */
export const rpcClientErrorCodeSchema = zod.enum([
  'FILE_NOT_FOUND',
  'PERMISSION_DENIED',
  'IO_ERROR',
  'PARSE_ERROR',
  'UNKNOWN',
]);

/**
 * Base error schema for all RPC failures.
 * Used as the error variant in discriminated unions.
 */
export const rpcClientErrorSchema = zod.object({
  success: zod.literal(false),
  errorCode: rpcClientErrorCodeSchema,
  message: zod.string(),
});

// =============================================================================
// RPC Definition Helper
// =============================================================================

/**
 * Helper to define RPC schemas with reduced boilerplate.
 *
 * Takes an input schema and a success data schema (without `success: true`),
 * and automatically:
 * - Adds `success: true` to create the full success schema
 * - Creates a discriminated union result schema with error handling
 *
 * @example
 * ```typescript
 * const readFileRpc = defineRpc({
 *   input: zod.object({ targetFile: zod.string() }),
 *   success: zod.object({ content: zod.string(), totalLines: zod.number() }),
 * });
 *
 * // Use: readFileRpc.inputSchema, readFileRpc.successSchema, readFileRpc.resultSchema
 * // Types: z.infer<typeof readFileRpc.inputSchema>, etc.
 * ```
 */
function defineRpc<Input extends zod.ZodRawShape, Success extends zod.ZodRawShape>(config: {
  input: zod.ZodObject<Input>;
  success: zod.ZodObject<Success>;
}) {
  const successSchema = config.success.extend({ success: zod.literal(true) });
  const resultSchema = zod.discriminatedUnion('success', [successSchema, rpcClientErrorSchema]);

  return {
    inputSchema: config.input,
    successSchema,
    resultSchema,
  };
}

// =============================================================================
// RPC Definitions
// =============================================================================

const readFileRpc = defineRpc({
  input: zod.object({
    targetFile: zod.string(),
    offset: zod.number().optional(),
    limit: zod.number().optional(),
  }),
  success: zod.object({
    content: zod.string(),
    totalLines: zod.number(),
    startLine: zod.number().optional(),
  }),
});

const createFileRpc = defineRpc({
  input: zod.object({
    targetFile: zod.string(),
    content: zod.string(),
  }),
  success: zod.object({
    message: zod.string().optional(),
    diffStats: diffStatsWithContentSchema,
  }),
});

const deleteFileRpc = defineRpc({
  input: zod.object({
    targetFile: zod.string(),
  }),
  success: zod.object({
    message: zod.string(),
  }),
});

const directoryEntrySchema = zod.object({
  name: zod.string(),
  type: zod.enum(['file', 'dir']),
  size: zod.number(),
});

const listDirectoryRpc = defineRpc({
  input: zod.object({
    path: zod.string(),
  }),
  success: zod.object({
    entries: zod.array(directoryEntrySchema),
    path: zod.string(),
  }),
});

const grepMatchSchema = zod.object({
  file: zod.string(),
  line: zod.number(),
  content: zod.string(),
});

const grepRpc = defineRpc({
  input: zod.object({
    pattern: zod.string(),
    path: zod.string().optional(),
    glob: zod.string().optional(),
    caseSensitive: zod.boolean().optional(),
  }),
  success: zod.object({
    matches: zod.array(grepMatchSchema),
    totalMatches: zod.number(),
    truncated: zod.boolean().optional(),
  }),
});

const globSearchRpc = defineRpc({
  input: zod.object({
    pattern: zod.string(),
    path: zod.string().optional(),
  }),
  success: zod.object({
    files: zod.array(zod.string()),
    totalFiles: zod.number(),
  }),
});

const getKernelResultRpc = defineRpc({
  input: zod.object({
    targetFile: zod.string(),
  }),
  success: zod.object({
    status: zod.enum(['ready', 'error', 'pending']),
    kernelIssues: zod.array(kernelIssueSchema).optional(),
  }),
});

const captureObservationsRpc = defineRpc({
  input: zod.object({}),
  success: zod.object({
    observations: zod.array(observationSchema),
  }),
});

// =============================================================================
// Exported Schemas (for backwards compatibility)
// =============================================================================

export const readFileRpcInputSchema = readFileRpc.inputSchema;
export const readFileRpcSuccessSchema = readFileRpc.successSchema;
export const readFileRpcResultSchema = readFileRpc.resultSchema;

export const createFileRpcInputSchema = createFileRpc.inputSchema;
export const createFileRpcSuccessSchema = createFileRpc.successSchema;
export const createFileRpcResultSchema = createFileRpc.resultSchema;

export const deleteFileRpcInputSchema = deleteFileRpc.inputSchema;
export const deleteFileRpcSuccessSchema = deleteFileRpc.successSchema;
export const deleteFileRpcResultSchema = deleteFileRpc.resultSchema;

export const listDirectoryRpcInputSchema = listDirectoryRpc.inputSchema;
export const listDirectoryRpcSuccessSchema = listDirectoryRpc.successSchema;
export const listDirectoryRpcResultSchema = listDirectoryRpc.resultSchema;

export const grepRpcInputSchema = grepRpc.inputSchema;
export const grepRpcSuccessSchema = grepRpc.successSchema;
export const grepRpcResultSchema = grepRpc.resultSchema;

export const globSearchRpcInputSchema = globSearchRpc.inputSchema;
export const globSearchRpcSuccessSchema = globSearchRpc.successSchema;
export const globSearchRpcResultSchema = globSearchRpc.resultSchema;

export const getKernelResultRpcInputSchema = getKernelResultRpc.inputSchema;
export const getKernelResultRpcSuccessSchema = getKernelResultRpc.successSchema;
export const getKernelResultRpcResultSchema = getKernelResultRpc.resultSchema;

export const captureObservationsRpcInputSchema = captureObservationsRpc.inputSchema;
export const captureObservationsRpcSuccessSchema = captureObservationsRpc.successSchema;
export const captureObservationsRpcResultSchema = captureObservationsRpc.resultSchema;

// =============================================================================
// RPC Schemas Registry
// =============================================================================

type RpcSchemaEntry<Input = unknown, Result = unknown> = {
  inputSchema: zod.ZodType<Input>;
  resultSchema: zod.ZodType<Result>;
};

/**
 * Type representing the RPC schemas registry.
 * Used for type inference in sendRpcRequest.
 */
export type RpcSchemasRegistry = {
  [rpcName.readFile]: RpcSchemaEntry<ReadFileRpcInput, ReadFileRpcResult>;
  [rpcName.createFile]: RpcSchemaEntry<CreateFileRpcInput, CreateFileRpcResult>;
  [rpcName.deleteFile]: RpcSchemaEntry<DeleteFileRpcInput, DeleteFileRpcResult>;
  [rpcName.listDirectory]: RpcSchemaEntry<ListDirectoryRpcInput, ListDirectoryRpcResult>;
  [rpcName.grep]: RpcSchemaEntry<GrepRpcInput, GrepRpcResult>;
  [rpcName.globSearch]: RpcSchemaEntry<GlobSearchRpcInput, GlobSearchRpcResult>;
  [rpcName.getKernelResult]: RpcSchemaEntry<GetKernelResultRpcInput, GetKernelResultRpcResult>;
  [rpcName.captureObservations]: RpcSchemaEntry<CaptureObservationsRpcInput, CaptureObservationsRpcResult>;
};

/**
 * Runtime registry mapping RPC names to their Zod schemas.
 * Used by ChatRpcService for validating WebSocket RPC inputs/results.
 */
export const rpcSchemasRegistry: RpcSchemasRegistry = {
  [rpcName.readFile]: {
    inputSchema: readFileRpcInputSchema,
    resultSchema: readFileRpcResultSchema,
  },
  [rpcName.createFile]: {
    inputSchema: createFileRpcInputSchema,
    resultSchema: createFileRpcResultSchema,
  },
  [rpcName.deleteFile]: {
    inputSchema: deleteFileRpcInputSchema,
    resultSchema: deleteFileRpcResultSchema,
  },
  [rpcName.listDirectory]: {
    inputSchema: listDirectoryRpcInputSchema,
    resultSchema: listDirectoryRpcResultSchema,
  },
  [rpcName.grep]: {
    inputSchema: grepRpcInputSchema,
    resultSchema: grepRpcResultSchema,
  },
  [rpcName.globSearch]: {
    inputSchema: globSearchRpcInputSchema,
    resultSchema: globSearchRpcResultSchema,
  },
  [rpcName.getKernelResult]: {
    inputSchema: getKernelResultRpcInputSchema,
    resultSchema: getKernelResultRpcResultSchema,
  },
  [rpcName.captureObservations]: {
    inputSchema: captureObservationsRpcInputSchema,
    resultSchema: captureObservationsRpcResultSchema,
  },
};

// =============================================================================
// Helper Types
// =============================================================================

/**
 * Extract input type for a given RPC name.
 */
export type RpcInput<T extends keyof RpcSchemasRegistry> = z.infer<RpcSchemasRegistry[T]['inputSchema']>;

/**
 * Extract result type for a given RPC name.
 */
export type RpcResult<T extends keyof RpcSchemasRegistry> = z.infer<RpcSchemasRegistry[T]['resultSchema']>;

// =============================================================================
// Inferred Types
// =============================================================================

export type RpcClientErrorCode = z.infer<typeof rpcClientErrorCodeSchema>;
export type RpcClientError = z.infer<typeof rpcClientErrorSchema>;

export type ReadFileRpcInput = z.infer<typeof readFileRpcInputSchema>;
export type ReadFileRpcSuccess = z.infer<typeof readFileRpcSuccessSchema>;
export type ReadFileRpcResult = z.infer<typeof readFileRpcResultSchema>;

export type CreateFileRpcInput = z.infer<typeof createFileRpcInputSchema>;
export type CreateFileRpcSuccess = z.infer<typeof createFileRpcSuccessSchema>;
export type CreateFileRpcResult = z.infer<typeof createFileRpcResultSchema>;

export type DeleteFileRpcInput = z.infer<typeof deleteFileRpcInputSchema>;
export type DeleteFileRpcSuccess = z.infer<typeof deleteFileRpcSuccessSchema>;
export type DeleteFileRpcResult = z.infer<typeof deleteFileRpcResultSchema>;

export type ListDirectoryRpcInput = z.infer<typeof listDirectoryRpcInputSchema>;
export type ListDirectoryRpcSuccess = z.infer<typeof listDirectoryRpcSuccessSchema>;
export type ListDirectoryRpcResult = z.infer<typeof listDirectoryRpcResultSchema>;

export type GrepRpcInput = z.infer<typeof grepRpcInputSchema>;
export type GrepRpcSuccess = z.infer<typeof grepRpcSuccessSchema>;
export type GrepRpcResult = z.infer<typeof grepRpcResultSchema>;

export type GlobSearchRpcInput = z.infer<typeof globSearchRpcInputSchema>;
export type GlobSearchRpcSuccess = z.infer<typeof globSearchRpcSuccessSchema>;
export type GlobSearchRpcResult = z.infer<typeof globSearchRpcResultSchema>;

export type GetKernelResultRpcInput = z.infer<typeof getKernelResultRpcInputSchema>;
export type GetKernelResultRpcSuccess = z.infer<typeof getKernelResultRpcSuccessSchema>;
export type GetKernelResultRpcResult = z.infer<typeof getKernelResultRpcResultSchema>;

export type CaptureObservationsRpcInput = z.infer<typeof captureObservationsRpcInputSchema>;
export type CaptureObservationsRpcSuccess = z.infer<typeof captureObservationsRpcSuccessSchema>;
export type CaptureObservationsRpcResult = z.infer<typeof captureObservationsRpcResultSchema>;

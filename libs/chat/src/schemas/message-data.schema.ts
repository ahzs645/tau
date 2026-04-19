// oxlint-disable-next-line eslint-plugin-import/no-named-as-default -- standard zod default import
import z from 'zod';

/**
 * Schema for per-turn usage data.
 * @public
 */
export const usageDataSchema = z.object({
  type: z.literal('usage'),
  id: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  inputTokensCost: z.number(),
  outputTokensCost: z.number(),
  cacheReadTokensCost: z.number(),
  cacheWriteTokensCost: z.number(),
  totalCost: z.number(),
});

/** @public */
export type UsageData = z.infer<typeof usageDataSchema>;

/**
 * Schema for context compaction event data.
 * Emitted when the compaction middleware compresses conversation history.
 * @public
 */
export const contextCompactionDataSchema = z.object({
  type: z.literal('context-compaction'),
  id: z.string(),
  tokensBeforeCompaction: z.number(),
  tokensAfterCompaction: z.number(),
  compressionRatio: z.number(),
  messagesEvicted: z.number(),
  transcriptFilePath: z.string().nullable(),
});

/** @public */
export type ContextCompactionData = z.infer<typeof contextCompactionDataSchema>;

/**
 * Schema for context usage data.
 * Emitted as a transient data part to surface live context window utilization.
 * @public
 */
export const contextUsageDataSchema = z.object({
  type: z.literal('context-usage'),
  id: z.string(),
  totalInputTokens: z.number(),
  contextWindow: z.number(),
  percentUsed: z.number(),
  modelId: z.string(),
});

/** @public */
export type ContextUsageData = z.infer<typeof contextUsageDataSchema>;

/**
 * Schema for custom data parts in UI messages.
 * @public
 */
export const dataPartSchema = z.object({
  usage: usageDataSchema,
  'context-compaction': contextCompactionDataSchema,
  'context-usage': contextUsageDataSchema,
});

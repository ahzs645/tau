import z from 'zod';

/**
 * Schema for per-turn usage data.
 */
export const usageDataSchema = z.object({
  id: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedReadTokens: z.number(),
  cachedWriteTokens: z.number(),
  inputTokensCost: z.number(),
  outputTokensCost: z.number(),
  cachedReadTokensCost: z.number(),
  cachedWriteTokensCost: z.number(),
  totalCost: z.number(),
});

export type UsageData = z.infer<typeof usageDataSchema>;

/**
 * Schema for custom data parts in UI messages.
 *
 * IMPORTANT: The explicit type annotation is required to ensure proper type resolution
 * during `tsc --build` with project references. Without it, `z.infer` in declaration
 * files may not fully resolve, causing `DataUIPart<MyDataPart>` to widen from
 * `{ type: 'data-test'; ... }` to `{ type: 'data-${string}'; ... }`, breaking
 * exhaustive switch statements in components like `chat-message.tsx`.
 */
export const dataPartSchema: z.ZodType<{
  usage: UsageData;
}> = z.object({
  usage: usageDataSchema,
});

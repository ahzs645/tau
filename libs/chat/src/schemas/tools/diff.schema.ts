import { z } from 'zod';

/**
 * Diff statistics for file operations.
 * Contains line counts and full content for diff visualization.
 */
export type DiffStatsWithContent = {
  linesAdded: number;
  linesRemoved: number;
  originalContent: string;
  modifiedContent: string;
};

export const diffStatsWithContentSchema: z.ZodType<DiffStatsWithContent> = z.object({
  linesAdded: z.number().describe('Number of lines added'),
  linesRemoved: z.number().describe('Number of lines removed'),
  originalContent: z.string().describe('Original file content before changes'),
  modifiedContent: z.string().describe('Modified file content after changes'),
});

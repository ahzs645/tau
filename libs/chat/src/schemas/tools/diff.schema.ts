import { z } from 'zod';

/**
 * Diff statistics for file operations.
 * Contains line counts and full content for diff visualization.
 */
export type DiffStats = {
  linesAdded: number;
  linesRemoved: number;
  originalContent: string;
  modifiedContent: string;
};

export const diffStatsSchema: z.ZodType<DiffStats> = z.object({
  linesAdded: z.number().describe('Number of lines added'),
  linesRemoved: z.number().describe('Number of lines removed'),
  originalContent: z.string().describe('Original file content before changes'),
  modifiedContent: z.string().describe('Modified file content after changes'),
});

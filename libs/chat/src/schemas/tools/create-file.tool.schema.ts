import { z } from 'zod';
import { diffStatsWithContentSchema } from '#schemas/tools/diff.schema.js';

export const createFileInputSchema = z.object({
  targetFile: z.string().describe('The path of the file to create, relative to the project root.'),
  content: z.string().describe('The content to write to the new file.'),
});

export const createFileOutputSchema = z.object({
  message: z.string().optional().describe('Additional information about the operation.'),
  diffStats: diffStatsWithContentSchema.describe('Statistics and content diff for the changes made'),
});

export type CreateFileInput = z.infer<typeof createFileInputSchema>;
export type CreateFileOutput = z.infer<typeof createFileOutputSchema>;

import { z } from 'zod';
import { diffStatsSchema } from '#schemas/tools/diff.schema.js';

export const fileEditInputSchema = z.object({
  targetFile: z.string().describe('The target file to modify.'),
  codeEdit: z.string().describe('Specify ONLY the precise lines of code that you wish to edit...'),
});

export const fileEditOutputSchema = z.object({
  success: z.boolean().describe('Whether the file edit was successfully applied'),
  diffStats: diffStatsSchema.describe('Statistics and content diff for the changes made'),
});

export type FileEditInput = z.infer<typeof fileEditInputSchema>;
export type FileEditOutput = z.infer<typeof fileEditOutputSchema>;

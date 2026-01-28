import { z } from 'zod';
import { diffStatsWithContentSchema } from '#schemas/tools/diff.schema.js';

export const editFileInputSchema = z.object({
  targetFile: z.string().describe('The target file to modify.'),
  codeEdit: z.string().describe('Specify ONLY the precise lines of code that you wish to edit'),
});

export const editFileOutputSchema = z.object({
  diffStats: diffStatsWithContentSchema.describe('Statistics and content diff for the changes made'),
});

export type EditFileInput = z.infer<typeof editFileInputSchema>;
export type EditFileOutput = z.infer<typeof editFileOutputSchema>;

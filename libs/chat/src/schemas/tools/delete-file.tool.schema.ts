import { z } from 'zod';

/** @public */
export const deleteFileInputSchema = z.object({
  targetFile: z.string().describe('The path of the file to delete, relative to the project root.'),
});

/** @public */
export const deleteFileOutputSchema = z.object({
  message: z.string().describe('Information about the operation.'),
});

/** @public */
export type DeleteFileInput = z.infer<typeof deleteFileInputSchema>;
/** @public */
export type DeleteFileOutput = z.infer<typeof deleteFileOutputSchema>;

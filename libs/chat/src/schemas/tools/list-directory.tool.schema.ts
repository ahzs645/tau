import { z } from 'zod';

export const listDirectoryInputSchema = z.object({
  path: z
    .string()
    .describe('The path of the directory to list, relative to the project root. Use empty string for root.'),
});

const directoryEntrySchema = z.object({
  name: z.string().describe('The name of the file or directory.'),
  type: z.enum(['file', 'dir']).describe('Whether this entry is a file or directory.'),
  size: z.number().describe('The size in bytes (for files) or number of entries (for directories).'),
});

export const listDirectoryOutputSchema = z.object({
  entries: z.array(directoryEntrySchema).describe('The list of files and directories in the specified path.'),
  path: z.string().describe('The resolved path that was listed.'),
});

export type ListDirectoryInput = z.infer<typeof listDirectoryInputSchema>;
export type ListDirectoryOutput = z.infer<typeof listDirectoryOutputSchema>;
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

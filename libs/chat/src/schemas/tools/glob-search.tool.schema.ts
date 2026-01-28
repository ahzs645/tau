import { z } from 'zod';

export const globSearchInputSchema = z.object({
  pattern: z.string().describe('The glob pattern to match files against (e.g., "**/*.ts", "lib/**/*.scad").'),
  path: z.string().optional().describe('The base directory to search from. Defaults to project root.'),
});

export const globSearchOutputSchema = z.object({
  files: z.array(z.string()).describe('The list of file paths matching the glob pattern.'),
  totalFiles: z.number().describe('The total number of files found.'),
});

export type GlobSearchInput = z.infer<typeof globSearchInputSchema>;
export type GlobSearchOutput = z.infer<typeof globSearchOutputSchema>;

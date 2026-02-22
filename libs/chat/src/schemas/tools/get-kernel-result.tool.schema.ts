import type { KernelIssue } from '@taucad/kernels';
import { z } from 'zod';
import { kernelIssueSchema } from '#schemas/tools/issue.schema.js';

export const getKernelResultInputSchema = z.object({
  targetFile: z.string().describe('The file to check kernel results for, relative to the project root.'),
});

export const getKernelResultOutputSchema = z.object({
  status: z.enum(['ready', 'error', 'pending']).describe('The current status of the kernel.'),
  kernelIssues: z.array(kernelIssueSchema).optional().describe('Any kernel issues encountered during compilation.'),
});

export type GetKernelResultInput = z.infer<typeof getKernelResultInputSchema>;

// Explicitly defined to avoid TS2742 with tsgo compiler
export type GetKernelResultOutput = {
  status: 'ready' | 'error' | 'pending';
  kernelIssues?: KernelIssue[];
};

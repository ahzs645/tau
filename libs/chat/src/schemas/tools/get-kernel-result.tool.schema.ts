import type { KernelError } from '@taucad/types';
import { z } from 'zod';
import { kernelErrorSchema } from '#schemas/tools/error.schema.js';

export const getKernelResultInputSchema = z.object({
  targetFile: z.string().optional().describe('Optional file to check. If omitted, checks the current/main file.'),
});

export const getKernelResultOutputSchema = z.object({
  status: z.enum(['ready', 'error', 'pending']).describe('The current status of the kernel.'),
  kernelErrors: z.array(kernelErrorSchema).optional().describe('Any kernel errors encountered during compilation.'),
  message: z.string().optional().describe('Additional status message.'),
});

export type GetKernelResultInput = z.infer<typeof getKernelResultInputSchema>;

// Explicitly defined to avoid TS2742 with tsgo compiler
export type GetKernelResultOutput = {
  status: 'ready' | 'error' | 'pending';
  kernelErrors?: KernelError[];
  message?: string;
};

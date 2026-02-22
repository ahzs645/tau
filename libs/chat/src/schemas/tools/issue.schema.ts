/**
 * Shared error schemas used across multiple tool definitions.
 * These schemas are registered with unique IDs in Zod's registry.
 */
import type { CodeIssue } from '@taucad/types';
import type { KernelIssue } from '@taucad/kernels';
import { z } from 'zod';

export const codeIssueSchema: z.ZodType<CodeIssue> = z
  .object({
    message: z.string(),
    startLineNumber: z.number(),
    endLineNumber: z.number(),
    startColumn: z.number(),
    endColumn: z.number(),
  })
  .meta({ id: 'CodeIssue' });

export const errorLocationSchema = z.object({
  fileName: z.string(),
  startLineNumber: z.number(),
  startColumn: z.number(),
  endLineNumber: z.number().optional(),
  endColumn: z.number().optional(),
});

export const kernelIssueSchema: z.ZodType<KernelIssue> = z
  .object({
    message: z.string(),
    location: errorLocationSchema.optional(),
    stack: z.string().optional(),
    stackFrames: z
      .array(
        z.object({
          fileName: z.string().optional(),
          functionName: z.string().optional(),
          lineNumber: z.number().optional(),
          columnNumber: z.number().optional(),
          source: z.string().optional(),
        }),
      )
      .optional(),
    severity: z.enum(['error', 'warning', 'info']),
    type: z.enum(['compilation', 'runtime', 'kernel', 'connection', 'unknown']).optional(),
  })
  .meta({ id: 'KernelIssue' });

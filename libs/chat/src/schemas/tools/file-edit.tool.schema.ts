import type { CodeError, KernelError } from '@taucad/types';
import { z } from 'zod';

const codeErrorSchema: z.ZodType<CodeError> = z
  .object({
    message: z.string(),
    startLineNumber: z.number(),
    endLineNumber: z.number(),
    startColumn: z.number(),
    endColumn: z.number(),
  })
  .meta({ id: 'CodeError' });

const errorLocationSchema = z.object({
  fileName: z.string(),
  startLineNumber: z.number(),
  startColumn: z.number(),
  endLineNumber: z.number().optional(),
  endColumn: z.number().optional(),
});

const kernelErrorSchema: z.ZodType<KernelError> = z
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
    type: z.enum(['compilation', 'runtime', 'kernel', 'unknown']).optional(),
  })
  .meta({ id: 'KernelError' });

export const fileEditInputSchema = z.object({
  targetFile: z.string().describe('The target file to modify.'),
  codeEdit: z.string().describe('Specify ONLY the precise lines of code that you wish to edit...'),
});

export const fileEditOutputSchema = z.object({
  codeErrors: z.array(codeErrorSchema),
  kernelErrors: z.array(kernelErrorSchema).optional(),
});

export type FileEditInput = z.infer<typeof fileEditInputSchema>;
export type FileEditOutput = z.infer<typeof fileEditOutputSchema>;

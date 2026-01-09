import { z } from 'zod';

export const reasoningInputSchema = z.object({
  thinking: z.string().describe('Your detailed reasoning and thought process for solving the current problem.'),
});

export const reasoningOutputSchema = z.object({
  acknowledged: z.boolean().describe('Whether the reasoning was acknowledged.'),
});

export type ReasoningInput = z.infer<typeof reasoningInputSchema>;
export type ReasoningOutput = z.infer<typeof reasoningOutputSchema>;

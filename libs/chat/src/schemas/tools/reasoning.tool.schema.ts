import { z } from 'zod';

export const reasoningInputSchema = z.object({
  thinking: z.string().describe('Your detailed reasoning and thought process for solving the current problem.'),
});

// Output is a simple string to avoid LangChain's stringification of plain objects.
// LangChain's _formatToolOutput passes strings through as-is, but JSON.stringify's plain objects.
export const reasoningOutputSchema = z.string();

export type ReasoningInput = z.infer<typeof reasoningInputSchema>;
export type ReasoningOutput = z.infer<typeof reasoningOutputSchema>;

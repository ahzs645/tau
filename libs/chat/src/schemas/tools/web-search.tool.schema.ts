import { z } from 'zod';

/** @public */
export const webSearchInputSchema = z.object({
  query: z.string().describe('The search query'),
});

/** @public */
export const webSearchOutputSchema = z.array(
  z.object({
    title: z.string(),
    url: z.string(),
    content: z.string(),
  }),
);

/** @public */
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
/** @public */
export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;

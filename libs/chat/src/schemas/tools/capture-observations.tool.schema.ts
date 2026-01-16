import { z } from 'zod';
import { observationSchema } from '#schemas/tools/test-model.tool.schema.js';

/**
 * Input schema for capture_observations tool.
 * This tool captures screenshots from all 6 orthographic views.
 */
export const captureObservationsInputSchema = z.object({});

/**
 * Output schema for capture_observations tool.
 * Returns an array of observations (screenshots with metadata).
 */
export const captureObservationsOutputSchema = z.object({
  observations: z.array(observationSchema).describe('Array of captured screenshots from orthographic views'),
});

export type CaptureObservationsInput = z.infer<typeof captureObservationsInputSchema>;
export type CaptureObservationsOutput = z.infer<typeof captureObservationsOutputSchema>;

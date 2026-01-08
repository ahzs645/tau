import { z } from 'zod';

// View sides enum for orthographic views
export const viewSideSchema = z.enum(['front', 'back', 'right', 'left', 'top', 'bottom']);
export type ViewSide = z.infer<typeof viewSideSchema>;

// Observation schema - each image capture is an "observation"
// Uses prefixed ID from libs/utils/src/id.utils.ts with 'obs' prefix
export const observationSchema = z.object({
  id: z.string(), // Example: 'obs_abc123...' generated via generatePrefixedId('obs')
  side: viewSideSchema,
  src: z.string(),
});
export type Observation = z.infer<typeof observationSchema>;

export const imageAnalysisInputSchema = z.object({
  requirements: z.array(z.string()),
});

// Discriminated union for requirement results
export const requirementPassedSchema = z.object({
  status: z.literal('passed'),
  requirement: z.string(),
});

export const requirementFailedSchema = z.object({
  status: z.literal('failed'),
  requirement: z.string(),
  reason: z.string(),
  suggestion: z.string(),
});

export const requirementIndeterminateSchema = z.object({
  status: z.literal('indeterminate'),
  requirement: z.string(),
  reason: z.string(),
});

export const requirementResultSchema = z.discriminatedUnion('status', [
  requirementPassedSchema,
  requirementFailedSchema,
  requirementIndeterminateSchema,
]);

// Observation result - results for a single observation/view
export const observationResultSchema = z.object({
  id: z.string(), // Same ID from input observation
  side: viewSideSchema,
  results: z.array(requirementResultSchema),
});
export type ObservationResult = z.infer<typeof observationResultSchema>;

// Evaluation criteria - transparency for UI display
export const evaluationCriteriaSchema = z.object({
  totalObservations: z.number(),
});
export type EvaluationCriteria = z.infer<typeof evaluationCriteriaSchema>;

// Updated output schema with observation-based results
export const imageAnalysisOutputSchema = z.object({
  observations: z.array(observationSchema), // Array of observations with IDs
  observationResults: z.array(observationResultSchema), // Results per observation
  aggregatedResults: z.array(requirementResultSchema), // Aggregated across all observations
  evaluationCriteria: evaluationCriteriaSchema, // Transparency for UI display
});

// Types
export type ImageAnalysisInput = z.infer<typeof imageAnalysisInputSchema>;
export type RequirementPassed = z.infer<typeof requirementPassedSchema>;
export type RequirementFailed = z.infer<typeof requirementFailedSchema>;
export type RequirementIndeterminate = z.infer<typeof requirementIndeterminateSchema>;
export type RequirementResult = z.infer<typeof requirementResultSchema>;
export type ImageAnalysisOutput = z.infer<typeof imageAnalysisOutputSchema>;

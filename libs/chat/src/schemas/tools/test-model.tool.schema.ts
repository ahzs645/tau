import { z } from 'zod';
import { diffStatsWithContentSchema } from '#schemas/tools/diff.schema.js';

// =============================================================================
// View and Observation Schemas (internal use for capturing screenshots)
// =============================================================================

/**
 * View sides enum for orthographic views.
 * Used internally for capturing model screenshots.
 */
export const viewSideSchema = z.enum(['front', 'back', 'right', 'left', 'top', 'bottom']);
export type ViewSide = z.infer<typeof viewSideSchema>;

/**
 * Observation schema - each image capture is an "observation".
 * Used internally by the test runner.
 */
export const observationSchema = z.object({
  id: z.string(),
  side: viewSideSchema,
  src: z.string(),
});
export type Observation = z.infer<typeof observationSchema>;

// =============================================================================
// Test Requirement Schemas (for test.json file)
// =============================================================================

/**
 * Base test requirement with common fields.
 */
const baseTestRequirementSchema = z.object({
  id: z.string().describe('Unique identifier for the requirement (e.g., "req_sphere")'),
  description: z.string().describe('Human-readable description of what to test'),
});

/**
 * Visual test requirement - verified by LLM analyzing model screenshots.
 */
export const visualTestRequirementSchema = baseTestRequirementSchema.extend({
  type: z.literal('visual'),
});
export type VisualTestRequirement = z.infer<typeof visualTestRequirementSchema>;

/**
 * Measurement test requirement - verified by deterministic measurements (future).
 * Extensible schema for bounding box, volume, surface area, etc.
 */
export const measurementTestRequirementSchema = baseTestRequirementSchema.extend({
  type: z.literal('measurement'),
  check: z.enum(['boundingBox', 'volume', 'surfaceArea', 'manifold', 'centerOfMass']),
  expected: z.record(z.string(), z.unknown()).optional().describe('Expected values for the measurement'),
  tolerance: z.number().optional().describe('Acceptable tolerance for the measurement'),
});
export type MeasurementTestRequirement = z.infer<typeof measurementTestRequirementSchema>;

/**
 * Union of all test requirement types.
 */
export const testRequirementSchema = z.discriminatedUnion('type', [
  visualTestRequirementSchema,
  measurementTestRequirementSchema,
]);
export type TestRequirement = z.infer<typeof testRequirementSchema>;

/**
 * Test file schema (test.json structure).
 */
export const testFileSchema = z.object({
  requirements: z.array(testRequirementSchema),
});
export type TestFile = z.infer<typeof testFileSchema>;

// =============================================================================
// Test Model Tool Schemas (input/output for test_model tool)
// =============================================================================

/**
 * Input schema for test_model tool.
 * No input required - reads requirements from test.json.
 */
export const testModelInputSchema = z.object({});
export type TestModelInput = z.infer<typeof testModelInputSchema>;

/**
 * Test failure result - failures include detailed feedback for the LLM.
 */
export const testFailureSchema = z.object({
  id: z.string().describe('ID of the failed requirement'),
  requirement: z.string().describe('Description of the requirement that failed'),
  reason: z.string().describe('Why the test failed'),
  suggestion: z.string().describe('Actionable suggestion to fix the issue'),
});
export type TestFailure = z.infer<typeof testFailureSchema>;

/**
 * Test pass result - passes are simpler, just id and description.
 */
export const testPassSchema = z.object({
  id: z.string().describe('ID of the passed requirement'),
  requirement: z.string().describe('Description of the requirement that passed'),
});
export type TestPass = z.infer<typeof testPassSchema>;

/**
 * Output schema for test_model tool.
 * Includes both failures (with detailed feedback) and passes (for UI display).
 */
export const testModelOutputSchema = z.object({
  failures: z.array(testFailureSchema).describe('Array of failed tests with actionable feedback'),
  passes: z.array(testPassSchema).describe('Array of passed tests'),
  passed: z.number().describe('Number of tests that passed'),
  total: z.number().describe('Total number of tests run'),
});
export type TestModelOutput = z.infer<typeof testModelOutputSchema>;

// =============================================================================
// Edit Tests Tool Schemas (input/output for edit_tests tool)
// =============================================================================

/**
 * Input schema for edit_tests tool.
 * Uses the same pattern as edit_file for consistency.
 */
export const editTestsInputSchema = z.object({
  codeEdit: z.string().describe('The edit to apply to test.json using // ... existing code ... pattern'),
});
export type EditTestsInput = z.infer<typeof editTestsInputSchema>;

/**
 * Output schema for edit_tests tool.
 * Mirrors edit_file output for consistent UX.
 */
export const editTestsOutputSchema = z.object({
  diffStats: diffStatsWithContentSchema.describe('Statistics and content diff for the changes made'),
});
export type EditTestsOutput = z.infer<typeof editTestsOutputSchema>;

import { z } from 'zod';

// =============================================================================
// Test Requirement Schemas (for test.json file)
// =============================================================================

const baseTestRequirementSchema = z.object({
  id: z.string().describe('Unique identifier for the requirement (e.g., "req_sphere")'),
  description: z.string().describe('Human-readable description of what to test'),
});

const axesSchema = z.object({ x: z.number(), y: z.number(), z: z.number() }).partial();

/**
 * Expected value schema for bounding box checks.
 * @public
 */
export const boundingBoxExpectedSchema = z.object({
  size: axesSchema.optional().describe('Expected bounding box dimensions in mm (specify any subset of axes)'),
  center: axesSchema.optional().describe('Expected bounding box center position (specify any subset of axes)'),
});
/** @public */
export type BoundingBoxExpected = z.infer<typeof boundingBoxExpectedSchema>;

/**
 * Measurement test requirement -- verified by deterministic geometry analysis.
 * Supports: boundingBox, meshCount, vertexCount, connectedComponents, watertight.
 * @public
 */
export const measurementTestRequirementSchema = baseTestRequirementSchema.extend({
  type: z.literal('measurement'),
  check: z.enum(['boundingBox', 'meshCount', 'vertexCount', 'connectedComponents', 'watertight']),
  expected: z.record(z.string(), z.unknown()).optional().describe('Expected values for the measurement'),
  tolerance: z.number().optional().describe('Acceptable tolerance for the measurement (default: 0.1)'),
});
/** @public */
export type MeasurementTestRequirement = z.infer<typeof measurementTestRequirementSchema>;

/**
 * Test requirement schema (only measurement type is supported).
 * @public
 */
export const testRequirementSchema = measurementTestRequirementSchema;
/** @public */
export type TestRequirement = z.infer<typeof testRequirementSchema>;

/**
 * Per-file entry inside a `test.json` map. Holds the requirements that will be
 * evaluated against THAT file's compiled geometry.
 * @public
 */
export const testFileEntrySchema = z.object({
  requirements: z.array(testRequirementSchema),
});
/** @public */
export type TestFileEntry = z.infer<typeof testFileEntrySchema>;

/**
 * Test file schema -- a `test.json` is a map keyed by source file path so the
 * agent can attach independent measurement requirements to each compilation
 * unit and test multiple files concurrently.
 * @public
 */
export const testFileSchema = z.record(z.string(), testFileEntrySchema);
/** @public */
export type TestFile = z.infer<typeof testFileSchema>;

// =============================================================================
// Test Result Schemas (output from test runner)
// =============================================================================

/**
 * Test failure result -- failures include detailed feedback for the LLM and
 * are tagged with the source file whose geometry failed the requirement.
 * @public
 */
export const testFailureSchema = z.object({
  id: z.string().describe('ID of the failed requirement'),
  requirement: z.string().describe('Description of the requirement that failed'),
  reason: z.string().describe('Why the test failed'),
  suggestion: z.string().describe('Actionable suggestion to fix the issue'),
  targetFile: z.string().describe('Source file whose geometry produced this failure'),
});
/** @public */
export type TestFailure = z.infer<typeof testFailureSchema>;

/**
 * Test pass result -- passes are simpler, just id/description/targetFile.
 * @public
 */
export const testPassSchema = z.object({
  id: z.string().describe('ID of the passed requirement'),
  requirement: z.string().describe('Description of the requirement that passed'),
  targetFile: z.string().describe('Source file whose geometry satisfied this requirement'),
});
/** @public */
export type TestPass = z.infer<typeof testPassSchema>;

/**
 * Output schema for test_model tool.
 * Includes both failures (with detailed feedback) and passes (for UI display).
 * `geometryArtifactPaths` maps each tested source file to the captured GLB
 * artifact written for that compilation unit.
 * @public
 */
export const testModelOutputSchema = z.object({
  failures: z.array(testFailureSchema).describe('Array of failed tests with actionable feedback'),
  passes: z.array(testPassSchema).describe('Array of passed tests'),
  passed: z.number().describe('Number of tests that passed'),
  total: z.number().describe('Total number of tests run'),
  geometryArtifactPaths: z
    .record(z.string(), z.string())
    .optional()
    .describe('Map of source file path → captured GLB artifact path'),
});
/** @public */
export type TestModelOutput = z.infer<typeof testModelOutputSchema>;

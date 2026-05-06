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
 *
 * The agent-facing check vocabulary is intentionally narrow. Each of the
 * three checks answers a question none of the others can:
 *  - `boundingBox`   — overall extents and centre (mm)
 *  - `connectedComponents` — number of spatially-disjoint chunks (each glTF
 *    primitive is split into connected sub-meshes via welded vertices, then
 *    clustered via sub-mesh AABB overlap with a tunable `tolerance`)
 *  - `watertight`    — the part is a closed manifold (3D-printable)
 *
 * Raw mesh statistics (`meshCount`, `vertexCount`) remain available to
 * kernel authors via the in-package Vitest harness but are not exposed
 * to the LLM (see `docs/research/mesh-continuity-test-semantics.md`).
 * @public
 */
export const measurementTestRequirementSchema = baseTestRequirementSchema.extend({
  type: z.literal('measurement'),
  check: z.enum(['boundingBox', 'connectedComponents', 'watertight']),
  expected: z.record(z.string(), z.unknown()).optional().describe('Expected values for the measurement'),
  tolerance: z
    .number()
    .optional()
    .describe(
      'Tolerance for the check. For boundingBox: per-axis dimensional slack in mm (default 0.1). For connectedComponents: maximum AABB gap in mm that still counts as connected — raise this when intentional small gaps between touching parts must collapse into one cluster (default 0.1). Ignored for watertight.',
    ),
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
// Structured test failure payloads (geometry measurement checks)
// =============================================================================

const aabbSchema = z.object({
  min: z.tuple([z.number(), z.number(), z.number()]),
  max: z.tuple([z.number(), z.number(), z.number()]),
});

const primitiveRecordSchema = z.object({
  name: z.string(),
  color: z.string().optional(),
  vertices: z.number(),
  aabb: aabbSchema,
});

const clusterReportSchema = z.object({
  label: z.string(),
  primitives: z.array(primitiveRecordSchema),
  aabb: aabbSchema,
  centroid: z.tuple([z.number(), z.number(), z.number()]),
  totalVertices: z.number(),
});

const clusterGapSchema = z.object({
  fromLabel: z.string(),
  toLabel: z.string(),
  axis: z.enum(['x', 'y', 'z']),
  gapMm: z.number(),
  fromPrimitive: z.string(),
  toPrimitive: z.string(),
});

const boundingBoxAxisExtremumSchema = z.object({
  name: z.string(),
  aabb: aabbSchema,
  value: z.number(),
});

const boundingBoxAxisFailureSchema = z.object({
  axis: z.enum(['x', 'y', 'z']),
  field: z.enum(['size', 'center']),
  expected: z.number(),
  actual: z.number(),
  tolerance: z.number(),
  minExtremum: boundingBoxAxisExtremumSchema.optional(),
  maxExtremum: boundingBoxAxisExtremumSchema.optional(),
});

const watertightPrimitiveBreakdownSchema = z.object({
  name: z.string(),
  boundaryEdges: z.number(),
  loopCentroid: z.tuple([z.number(), z.number(), z.number()]),
});

/**
 * Optional structured geometry payload serialised alongside reason/suggestion.
 * @public
 */
export const testFailurePayloadSchema = z.discriminatedUnion('check', [
  z.object({
    check: z.literal('boundingBox'),
    axisFailures: z.array(boundingBoxAxisFailureSchema),
  }),
  z.object({
    check: z.literal('connectedComponents'),
    expected: z.number(),
    got: z.number(),
    toleranceMm: z.number(),
    clusters: z.array(clusterReportSchema),
    gaps: z.array(clusterGapSchema),
  }),
  z.object({
    check: z.literal('watertight'),
    irregularEdges: z.number(),
    openBoundaryEdges: z.number(),
    irregularEdgeFraction: z.number(),
    perPrimitive: z.array(watertightPrimitiveBreakdownSchema),
  }),
]);
/** @public */
export type TestFailurePayload = z.infer<typeof testFailurePayloadSchema>;

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
  failure: testFailurePayloadSchema
    .optional()
    .describe('Structured geometry diagnostics for UI / programmatic consumers'),
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
 * artifact written for that geometry unit.
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

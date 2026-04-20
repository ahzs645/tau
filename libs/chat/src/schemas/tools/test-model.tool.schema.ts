import { z } from 'zod';
import { diffStatsWithContentSchema } from '#schemas/tools/diff.schema.js';

// =============================================================================
// View and Observation Schemas (internal use for capturing screenshots)
// =============================================================================

/**
 * View sides enum for orthographic views.
 * Used internally for capturing model screenshots.
 * @public
 */
export const viewSideSchema = z.enum(['front', 'back', 'right', 'left', 'top', 'bottom', 'composite']);
/** @public */
export type ViewSide = z.infer<typeof viewSideSchema>;

/**
 * Observation schema - each image capture is an "observation".
 * Used internally by the test runner.
 * @public
 */
export const observationSchema = z.object({
  id: z.string(),
  side: viewSideSchema,
  src: z.string(),
});
/** @public */
export type Observation = z.infer<typeof observationSchema>;

// =============================================================================
// Test Model Tool Schemas (input/output for test_model tool)
// =============================================================================

/**
 * Input schema for test_model tool.
 * No input required - reads requirements from test.json.
 * @public
 */
export const testModelInputSchema = z.object({});
/** @public */
export type TestModelInput = z.infer<typeof testModelInputSchema>;

// =============================================================================
// Edit Tests Tool Schemas (input/output for edit_tests tool)
// =============================================================================

/**
 * Input schema for edit_tests tool.
 * Uses the same pattern as edit_file for consistency.
 * @public
 */
export const editTestsInputSchema = z.object({
  codeEdit: z
    .string()
    .describe(
      'The edit to apply to test.json using // ... existing code ... pattern. test.json is a per-file map keyed by source file path (e.g. "main.ts", "lib/pen.ts") whose values are { "requirements": [...] }. Add or update top-level keys to introduce new files; do not delete sibling files\' requirements. A top-level "requirements" array (without a file-path key) is rejected by post-write validation.',
    ),
});
/** @public */
export type EditTestsInput = z.infer<typeof editTestsInputSchema>;

/**
 * Output schema for edit_tests tool.
 * Mirrors edit_file output for consistent UX.
 * @public
 */
export const editTestsOutputSchema = z.object({
  diffStats: diffStatsWithContentSchema.describe('Statistics and content diff for the changes made'),
});
/** @public */
export type EditTestsOutput = z.infer<typeof editTestsOutputSchema>;

/**
 * Geometry analysis utilities for validating GLB output from CAD kernels.
 *
 * @module
 */
export type { GeometryStats, CheckResult } from '#geometry/types.js';
export { analyzeGlb } from '#geometry/analyze-glb.js';
export { evaluateRequirement } from '#geometry/evaluate-requirement.js';
export { countConnectedComponents } from '#geometry/connected-components.js';
export { isWatertight } from '#geometry/watertight.js';

/**
 * Statistics about a parsed GLB geometry.
 *
 * `connectedComponents` is exposed as a tolerance-parameterised getter so
 * callers can probe spatial connectivity at multiple gap thresholds (mm)
 * without re-parsing the GLB. Implementations are expected to memoise per
 * `toleranceMm` value.
 *
 * `vertexCount` and `meshCount` are kept on the type for internal diagnostic
 * use (and for the kernel-author Vitest harness in
 * `kernel-geometry-testing.utils.ts`); they are no longer exposed via the
 * agent-facing requirement schema.
 *
 * @public
 */
export type GeometryStats = {
  vertexCount: number;
  meshCount: number;
  /**
   * Returns the number of spatially-disjoint chunks across all glTF
   * primitives, treating two primitives as connected when their axis-aligned
   * bounding boxes overlap within `toleranceMm` (millimetres). Tighten the
   * tolerance to detect visibly-disjoint clusters; loosen it to collapse
   * intentional small gaps between touching parts.
   */
  connectedComponents: (toleranceMm: number) => number;
  watertight: boolean;
  boundingBox?: {
    size: [number, number, number];
    center: [number, number, number];
  };
};

/**
 * Result of evaluating a single test requirement against geometry stats.
 * @public
 */
export type CheckResult = {
  passed: boolean;
  reason: string;
  suggestion: string;
};

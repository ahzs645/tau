/**
 * Axis-aligned bounding box in glTF document units (meters).
 * @public
 */
export type AabbMeters = {
  min: [number, number, number];
  max: [number, number, number];
};

/**
 * One TRIANGLES primitive with identity for spatial-test feedback.
 * @public
 */
export type PrimitiveRecord = {
  /** The glTF node / mesh name (from kernel ShapeConfig.name when present). */
  name: string;
  color?: string;
  vertices: number;
  aabb: AabbMeters;
};

/**
 * One spatial cluster from AABB overlap grouping.
 * @public
 */
export type ClusterReport = {
  label: string;
  primitives: PrimitiveRecord[];
  aabb: AabbMeters;
  centroid: [number, number, number];
  totalVertices: number;
};

/**
 * Smallest clearance between two clusters along the dominant separation axis.
 * @public
 */
export type ClusterGap = {
  fromLabel: string;
  toLabel: string;
  axis: 'x' | 'y' | 'z';
  /** Millimetres — clearance between the two named primitives' AABBs. */
  gapMm: number;
  fromPrimitive: string;
  toPrimitive: string;
};

/**
 * Structured payload when `connectedComponents` fails.
 * @public
 */
export type ConnectedComponentsFailure = {
  expected: number;
  got: number;
  toleranceMm: number;
  clusters: ClusterReport[];
  gaps: ClusterGap[];
};

/**
 * Dominant primitive on an axis extremum for `boundingBox` failures.
 * @public
 */
export type BoundingBoxAxisExtremum = {
  name: string;
  aabb: AabbMeters;
  value: number;
};

/**
 * One axis failure for `boundingBox` checks.
 * @public
 */
export type BoundingBoxAxisFailure = {
  axis: 'x' | 'y' | 'z';
  field: 'size' | 'center';
  expected: number;
  actual: number;
  tolerance: number;
  minExtremum?: BoundingBoxAxisExtremum;
  maxExtremum?: BoundingBoxAxisExtremum;
};

/**
 * Structured payload when `boundingBox` fails.
 * @public
 */
export type BoundingBoxFailure = {
  axisFailures: BoundingBoxAxisFailure[];
};

/**
 * Per-primitive watertight diagnostic (local tessellation only).
 * @public
 */
export type WatertightPrimitiveBreakdown = {
  name: string;
  boundaryEdges: number;
  loopCentroid: [number, number, number];
};

/**
 * Structured payload when `watertight` fails.
 * @public
 */
export type WatertightFailure = {
  /** Edges with incidence ≠ 2 (open or non-manifold). */
  irregularEdges: number;
  /** Edges shared by exactly one triangle (open boundary). */
  openBoundaryEdges: number;
  irregularEdgeFraction: number;
  perPrimitive: WatertightPrimitiveBreakdown[];
};

/**
 * Full connected-components analysis at one tolerance.
 * @public
 */
export type ConnectedComponentsResult = {
  count: number;
  clusters: ClusterReport[];
  gaps: ClusterGap[];
};

/**
 * Full watertight analysis (global + per-primitive breakdown).
 * @public
 */
export type WatertightResult = {
  watertight: boolean;
  irregularEdges: number;
  openBoundaryEdges: number;
  totalEdges: number;
  irregularEdgeFraction: number;
  perPrimitive: WatertightPrimitiveBreakdown[];
};

/**
 * Scene bounding box with per-primitive contributors (meters, glTF space).
 * @public
 */
export type BoundingBoxStats = {
  size: [number, number, number];
  center: [number, number, number];
  primitives: PrimitiveRecord[];
};

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
   * Returns the number of spatially-disjoint chunks. Each TRIANGLES primitive is
   * split into connected sub-meshes (welded vertex coincidence + triangle
   * adjacency), then sub-meshes are treated as connected when their AABBs
   * overlap within `toleranceMm` (millimetres). Tighten the tolerance to detect
   * visibly-disjoint clusters; loosen it to collapse intentional small gaps
   * between touching parts.
   */
  connectedComponents: (toleranceMm: number) => number;
  /**
   * Full cluster decomposition at `toleranceMm` (memoised per value).
   */
  analyseConnectedComponents: (toleranceMm: number) => ConnectedComponentsResult;
  watertight: boolean;
  analyseWatertight: () => WatertightResult;
  boundingBox?: BoundingBoxStats;
};

/**
 * Result of evaluating a single test requirement against geometry stats.
 * @public
 */
export type CheckResult =
  | { passed: true }
  | {
      passed: false;
      check: 'boundingBox';
      reason: string;
      suggestion: string;
      failure: BoundingBoxFailure;
    }
  | {
      passed: false;
      check: 'connectedComponents';
      reason: string;
      suggestion: string;
      failure: ConnectedComponentsFailure;
    }
  | {
      passed: false;
      check: 'watertight';
      reason: string;
      suggestion: string;
      failure: WatertightFailure;
    }
  | {
      passed: false;
      check: 'invalid';
      reason: string;
      suggestion: string;
    };

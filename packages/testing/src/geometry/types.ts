/**
 * Statistics about a parsed GLB geometry.
 * @public
 */
export type GeometryStats = {
  vertexCount: number;
  meshCount: number;
  connectedComponents: number;
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

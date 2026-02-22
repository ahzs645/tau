/** Unified PBR defaults for all CAD conversion pipelines. */
export const cadMaterialDefaults = {
  roughnessFactor: 0.35,
  metallicFactor: 0,
  baseColorFactor: [0.7, 0.7, 0.7, 1] as readonly [number, number, number, number],
} as const;

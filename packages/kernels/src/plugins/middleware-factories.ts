/**
 * Consumer-facing middleware plugin factory functions.
 * Each factory returns a MiddlewarePlugin registration object with resolved module URL.
 */

import type { MiddlewarePlugin } from '#plugins/plugin-types.js';

/**
 * Create a parameter cache middleware plugin registration.
 * Caches getParameters results to avoid redundant parameter parsing.
 *
 * @returns MiddlewarePlugin for parameter caching
 *
 * @example
 * ```typescript
 * parameterCache()
 * ```
 */
export function parameterCache(): MiddlewarePlugin {
  return {
    id: 'parameterCache',
    moduleUrl: new URL('../middleware/parameter-cache.middleware.js', import.meta.url).href,
  };
}

/**
 * Create a geometry cache middleware plugin registration.
 * Caches createGeometry results to avoid redundant kernel computations.
 *
 * @returns MiddlewarePlugin for geometry caching
 *
 * @example
 * ```typescript
 * geometryCache()
 * ```
 */
export function geometryCache(): MiddlewarePlugin {
  return {
    id: 'geometryCache',
    moduleUrl: new URL('../middleware/geometry-cache.middleware.js', import.meta.url).href,
  };
}

/**
 * Create a GLTF coordinate transform middleware plugin registration.
 * Transforms Y-up/meters coordinate system to Z-up/mm.
 *
 * @returns MiddlewarePlugin for GLTF coordinate transformation
 *
 * @example
 * ```typescript
 * gltfCoordinateTransform()
 * ```
 */
export function gltfCoordinateTransform(): MiddlewarePlugin {
  return {
    id: 'gltfCoordinateTransform',
    moduleUrl: new URL('../middleware/gltf-coordinate-transform.middleware.js', import.meta.url).href,
  };
}

/**
 * Create a GLTF edge detection middleware plugin registration.
 * Adds edge primitives for sharp edge rendering in the viewer.
 *
 * @returns MiddlewarePlugin for GLTF edge detection
 *
 * @example
 * ```typescript
 * gltfEdgeDetection()
 * ```
 */
export function gltfEdgeDetection(): MiddlewarePlugin {
  return {
    id: 'gltfEdgeDetection',
    moduleUrl: new URL('../middleware/gltf-edge-detection.middleware.js', import.meta.url).href,
  };
}

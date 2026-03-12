/**
 * Consumer-facing middleware plugin factory functions.
 * Each factory returns a MiddlewarePlugin registration object with resolved module URL.
 */

import { createMiddlewarePlugin } from '#plugins/plugin-helpers.js';

/**
 * Create a parameter cache middleware plugin registration.
 * Caches getParameters results to avoid redundant parameter parsing.
 * @public
 */
export const parameterCache = createMiddlewarePlugin({
  id: 'parameterCache',
  moduleUrl: new URL('../middleware/parameter-cache.middleware.js', import.meta.url).href,
});

/**
 * Create a geometry cache middleware plugin registration.
 * Caches createGeometry results to avoid redundant kernel computations.
 * @public
 */
export const geometryCache = createMiddlewarePlugin({
  id: 'geometryCache',
  moduleUrl: new URL('../middleware/geometry-cache.middleware.js', import.meta.url).href,
});

/**
 * Create a GLTF coordinate transform middleware plugin registration.
 * Transforms Y-up/meters coordinate system to Z-up/mm.
 * @public
 */
export const gltfCoordinateTransform = createMiddlewarePlugin({
  id: 'gltfCoordinateTransform',
  moduleUrl: new URL('../middleware/gltf-coordinate-transform.middleware.js', import.meta.url).href,
});

/**
 * Create a GLTF edge detection middleware plugin registration.
 * Adds edge primitives for sharp edge rendering in the viewer.
 * @public
 */
export const gltfEdgeDetection = createMiddlewarePlugin({
  id: 'gltfEdgeDetection',
  moduleUrl: new URL('../middleware/gltf-edge-detection.middleware.js', import.meta.url).href,
});

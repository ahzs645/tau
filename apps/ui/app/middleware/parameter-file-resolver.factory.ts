import { createMiddlewarePlugin } from '@taucad/runtime';

/**
 * Create a parameter file resolver middleware plugin registration.
 * Reads per-geometry-unit parameter files from `.tau/parameters/<entry>.json` during
 * `createGeometry` and merges the active group's values into the input parameters.
 */
export const parameterFileResolver = createMiddlewarePlugin<{
  parametersDir?: string;
}>({
  id: 'parameterFileResolver',
  moduleUrl: new URL('parameter-file-resolver.middleware.js', import.meta.url).href,
});

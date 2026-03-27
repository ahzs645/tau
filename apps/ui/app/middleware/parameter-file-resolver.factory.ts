import { createMiddlewarePlugin } from '@taucad/runtime';

/**
 * Create a parameter file resolver middleware plugin registration.
 * Reads `.tau/parameters.json` during `createGeometry` and merges
 * the active set's values into the input parameters.
 */
export const parameterFileResolver = createMiddlewarePlugin<{
  parametersFile?: string;
}>({
  id: 'parameterFileResolver',
  moduleUrl: new URL('parameter-file-resolver.middleware.js', import.meta.url).href,
});

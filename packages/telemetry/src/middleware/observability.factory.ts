import { createMiddlewarePlugin } from '@taucad/runtime';

/**
 * Create an observability middleware plugin registration.
 * Collects kernel execution metrics and optionally reports them
 * directly from the worker to the telemetry ingest API.
 *
 * @param options - Optional configuration
 * @param options.reportUrl - URL of the telemetry ingest endpoint.
 *   When set, metrics are POSTed directly from the worker thread.
 * @public
 */
export const observability = createMiddlewarePlugin<{ reportUrl?: string }>({
  id: 'observability',
  moduleUrl: new URL('observability.middleware.js', import.meta.url).href,
});

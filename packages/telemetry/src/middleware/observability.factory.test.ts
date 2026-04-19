import { describe, it, expect } from 'vitest';
import { observability } from '#middleware/observability.factory.js';

describe('observability factory', () => {
  it('should return a MiddlewarePlugin with id "observability"', () => {
    const plugin = observability();
    expect(plugin.id).toBe('observability');
  });

  it('should resolve moduleUrl relative to factory location', () => {
    const plugin = observability();
    expect(plugin.moduleUrl).toContain('observability.middleware.js');
  });

  it('should pass reportUrl option through to plugin options', () => {
    const plugin = observability({ reportUrl: 'https://api.test/ingest' });
    expect(plugin.options).toEqual({ reportUrl: 'https://api.test/ingest' });
  });

  it('should work without options (reportUrl defaults to undefined)', () => {
    const plugin = observability();
    expect(plugin.options).toBeUndefined();
  });
});

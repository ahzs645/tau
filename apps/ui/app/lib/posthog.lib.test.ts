import { describe, expect, it } from 'vitest';
import { posthogConfig } from '#lib/posthog.lib.js';

describe('posthogConfig', () => {
  it('should enable deferred extension initialization', () => {
    expect(posthogConfig.options.__preview_deferred_init_extensions).toBe(true);
  });

  it('should set cookieless_mode to on_reject', () => {
    expect(posthogConfig.options.cookieless_mode).toBe('on_reject');
  });

  it('should use api proxy path as api_host', () => {
    expect(posthogConfig.options.api_host).toBe('/api/ph');
  });

  it('should use 2025-11-30 defaults', () => {
    expect(posthogConfig.options.defaults).toBe('2025-11-30');
  });

  it('should disable session recording at init', () => {
    expect(posthogConfig.options.disable_session_recording).toBe(true);
  });
});

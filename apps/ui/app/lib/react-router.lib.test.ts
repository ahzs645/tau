import { describe, it, expect } from 'vitest';
import { throwRedirectIfSubdomain } from '#lib/react-router.lib.js';

describe('redirectIfSubdomain', () => {
  it('should throw a redirect when subdomain matches', () => {
    const request = new Request('https://www.tau.new/some/path?query=1');

    expect(() => {
      throwRedirectIfSubdomain(request, 'www');
    }).toThrow();
  });

  it('should not throw when subdomain does not match', () => {
    const request = new Request('https://tau.new/some/path');

    expect(() => {
      throwRedirectIfSubdomain(request, 'www');
    }).not.toThrow();
  });

  it('should redirect to apex domain with correct path and query', () => {
    const request = new Request('https://www.tau.new/some/path?query=1');

    try {
      throwRedirectIfSubdomain(request, 'www');
    } catch (error) {
      const response = error as Response;
      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe('https://tau.new/some/path?query=1');
    }
  });

  it('should use 301 status code by default', () => {
    const request = new Request('https://www.example.com/');

    try {
      throwRedirectIfSubdomain(request, 'www');
    } catch (error) {
      const response = error as Response;
      expect(response.status).toBe(301);
    }
  });

  it('should use custom status code when provided', () => {
    const request = new Request('https://www.example.com/');

    try {
      throwRedirectIfSubdomain(request, 'www', 302);
    } catch (error) {
      const response = error as Response;
      expect(response.status).toBe(302);
    }
  });

  it('should handle multi-level subdomains correctly', () => {
    const request = new Request('https://www.sub.example.com/path');

    try {
      throwRedirectIfSubdomain(request, 'www');
    } catch (error) {
      const response = error as Response;
      expect(response.headers.get('Location')).toBe('https://sub.example.com/path');
    }
  });

  it('should not redirect when a different subdomain is specified', () => {
    const request = new Request('https://www.example.com/');

    expect(() => {
      throwRedirectIfSubdomain(request, 'api');
    }).not.toThrow();
  });

  it('should redirect other subdomains when specified', () => {
    const request = new Request('https://api.example.com/v1/users');

    try {
      throwRedirectIfSubdomain(request, 'api');
    } catch (error) {
      const response = error as Response;
      expect(response.headers.get('Location')).toBe('https://example.com/v1/users');
    }
  });
});

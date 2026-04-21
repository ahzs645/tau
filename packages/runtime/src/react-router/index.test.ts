import { describe, it, expect } from 'vitest';
import { applyHandleRequestHeaders } from '#react-router/index.js';

describe('applyHandleRequestHeaders', () => {
  it('should set all three COI headers on the React Router responseHeaders instance', () => {
    const responseHeaders = new Headers();
    applyHandleRequestHeaders(responseHeaders);
    expect(responseHeaders.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(responseHeaders.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(responseHeaders.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('should preserve pre-existing unrelated headers', () => {
    const responseHeaders = new Headers({ 'Content-Type': 'text/html' });
    applyHandleRequestHeaders(responseHeaders);
    expect(responseHeaders.get('Content-Type')).toBe('text/html');
    expect(responseHeaders.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });
});

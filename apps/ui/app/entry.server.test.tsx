import type { AppLoadContext, EntryContext } from 'react-router';
import { describe, it, expect } from 'vitest';

import handleRequest from './entry.server.js';

const entryContext = {} as unknown as EntryContext;
const loadContext = {} as unknown as AppLoadContext;

describe('entry.server handleRequest', () => {
  it('should apply cross-origin isolation headers to the response (HEAD path)', async () => {
    const request = new Request('https://tau.example/', { method: 'HEAD' });
    const responseHeaders = new Headers();
    const response = await handleRequest(request, 200, responseHeaders, entryContext, loadContext);
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('should mutate the supplied responseHeaders instance with COI headers', async () => {
    const request = new Request('https://tau.example/', { method: 'HEAD' });
    const responseHeaders = new Headers();
    await handleRequest(request, 200, responseHeaders, entryContext, loadContext);
    expect(responseHeaders.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(responseHeaders.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(responseHeaders.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });
});

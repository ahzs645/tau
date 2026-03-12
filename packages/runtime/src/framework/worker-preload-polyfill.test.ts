import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type DocumentStub = {
  getElementsByTagName: () => unknown[];
  querySelector: () => unknown;
  createElement: () => {
    rel: string;
    as: string;
    crossOrigin: string;
    href: string;
    setAttribute: () => void;
    addEventListener: () => void;
  };
  head: { appendChild: () => void };
};

function getDocumentStub(): DocumentStub {
  return (globalThis as Record<string, unknown>)['document'] as DocumentStub;
}

describe('worker-preload-polyfill', () => {
  let originalDocument: unknown;

  beforeEach(() => {
    originalDocument = (globalThis as Record<string, unknown>)['document'];
    delete (globalThis as Record<string, unknown>)['document'];
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDocument === undefined) {
      delete (globalThis as Record<string, unknown>)['document'];
    } else {
      (globalThis as Record<string, unknown>)['document'] = originalDocument;
    }
  });

  it('should define globalThis.document when document is undefined', async () => {
    expect(typeof document).toBe('undefined');

    await import('#framework/worker-preload-polyfill.js');

    expect((globalThis as Record<string, unknown>)['document']).toBeDefined();
  });

  it('should provide createElement that returns a no-op element with expected properties', async () => {
    await import('#framework/worker-preload-polyfill.js');

    const stubDocument = getDocumentStub();
    const element = stubDocument.createElement();

    expect(element).toEqual(
      expect.objectContaining({
        rel: '',
        as: '',
        crossOrigin: '',
        href: '',
      }),
    );
    expect(typeof element.setAttribute).toBe('function');
    expect(typeof element.addEventListener).toBe('function');
  });

  it('should provide getElementsByTagName returning empty array', async () => {
    await import('#framework/worker-preload-polyfill.js');

    const stubDocument = getDocumentStub();
    expect(stubDocument.getElementsByTagName()).toEqual([]);
  });

  it('should provide querySelector returning null', async () => {
    await import('#framework/worker-preload-polyfill.js');

    const stubDocument = getDocumentStub();
    expect(stubDocument.querySelector()).toBeNull();
  });

  it('should provide head.appendChild as a no-op function', async () => {
    await import('#framework/worker-preload-polyfill.js');

    const stubDocument = getDocumentStub();
    expect(typeof stubDocument.head.appendChild).toBe('function');

    stubDocument.head.appendChild();
  });

  it('should not overwrite document when it already exists', async () => {
    const existingDocument = { existing: true };
    (globalThis as Record<string, unknown>)['document'] = existingDocument;

    await import('#framework/worker-preload-polyfill.js');

    expect((globalThis as Record<string, unknown>)['document']).toBe(existingDocument);
  });
});

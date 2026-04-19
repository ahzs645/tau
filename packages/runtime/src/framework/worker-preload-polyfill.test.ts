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

type WindowStub = {
  dispatchEvent: () => void;
  addEventListener: () => void;
  removeEventListener: () => void;
};

function getDocumentStub(): DocumentStub {
  return (globalThis as Record<string, unknown>)['document'] as DocumentStub;
}

function getWindowStub(): WindowStub {
  return (globalThis as Record<string, unknown>)['window'] as WindowStub;
}

describe('worker-preload-polyfill', () => {
  let originalDocument: unknown;
  let originalWindow: unknown;

  beforeEach(() => {
    originalDocument = (globalThis as Record<string, unknown>)['document'];
    originalWindow = (globalThis as Record<string, unknown>)['window'];
    delete (globalThis as Record<string, unknown>)['document'];
    delete (globalThis as Record<string, unknown>)['window'];
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDocument === undefined) {
      delete (globalThis as Record<string, unknown>)['document'];
    } else {
      (globalThis as Record<string, unknown>)['document'] = originalDocument;
    }
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>)['window'];
    } else {
      (globalThis as Record<string, unknown>)['window'] = originalWindow;
    }
  });

  // ---------------------------------------------------------------------------
  // document stub
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // window stub
  // ---------------------------------------------------------------------------

  it('should define globalThis.window when window is undefined', async () => {
    await import('#framework/worker-preload-polyfill.js');

    expect((globalThis as Record<string, unknown>)['window']).toBeDefined();
  });

  it('should provide dispatchEvent as a no-op function', async () => {
    await import('#framework/worker-preload-polyfill.js');

    const stubWindow = getWindowStub();
    expect(typeof stubWindow.dispatchEvent).toBe('function');
    expect(() => {
      stubWindow.dispatchEvent();
    }).not.toThrow();
  });

  it('should provide addEventListener as a no-op function', async () => {
    await import('#framework/worker-preload-polyfill.js');

    const stubWindow = getWindowStub();
    expect(typeof stubWindow.addEventListener).toBe('function');
    expect(() => {
      stubWindow.addEventListener();
    }).not.toThrow();
  });

  it('should provide removeEventListener as a no-op function', async () => {
    await import('#framework/worker-preload-polyfill.js');

    const stubWindow = getWindowStub();
    expect(typeof stubWindow.removeEventListener).toBe('function');
    expect(() => {
      stubWindow.removeEventListener();
    }).not.toThrow();
  });

  it('should not overwrite window when it already exists', async () => {
    const existingWindow = { existing: true };
    (globalThis as Record<string, unknown>)['window'] = existingWindow;

    await import('#framework/worker-preload-polyfill.js');

    expect((globalThis as Record<string, unknown>)['window']).toBe(existingWindow);
  });
});

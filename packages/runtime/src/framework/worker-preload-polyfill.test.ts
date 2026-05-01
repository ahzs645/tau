import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type DocumentStub = {
  getElementsByTagName: () => unknown[];
  querySelector: () => unknown;
  querySelectorAll: () => ArrayLike<unknown>;
  createElement: () => {
    rel: string;
    as: string;
    crossOrigin: string;
    href: string;
    setAttribute: () => void;
    addEventListener: () => void;
  };
  createTextNode: () => unknown;
  addEventListener: () => void;
  removeEventListener: () => void;
  head: { appendChild: () => void };
  body: unknown;
  visibilityState: string;
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

  /*
   * Vite v8's HMR client (`vite/dist/client/client.mjs:1058`) probes
   * `"document" in globalThis` and unconditionally calls every method
   * below when the probe succeeds — without per-method `typeof` guards.
   *
   * Our polyfill makes the probe succeed (so the modulepreload helper
   * stays happy), so we MUST stub every method the HMR client touches.
   * If any one is missing, the worker crashes with
   * `TypeError: document.X is not a function`, which manifests upstream
   * as a perpetually-hanging preview render (the kernel client never
   * receives a `worker-ready` message because the worker died on import).
   *
   * Audit source: `grep -oE "document\\.[a-zA-Z]+"` against the installed
   * `vite/dist/client/client.mjs`. Re-audit on every Vite upgrade.
   */
  it.each([
    ['querySelectorAll', 'function'],
    ['addEventListener', 'function'],
    ['removeEventListener', 'function'],
    ['createTextNode', 'function'],
    ['visibilityState', 'string'],
  ] as const)('should provide document.%s as %s for Vite HMR client', async (method, expectedType) => {
    await import('#framework/worker-preload-polyfill.js');

    const stubDocument = getDocumentStub() as unknown as Record<string, unknown>;
    expect(typeof stubDocument[method]).toBe(expectedType);
  });

  it('should provide a non-throwing document.body accessor for Vite HMR client', async () => {
    await import('#framework/worker-preload-polyfill.js');

    const stubDocument = getDocumentStub();
    expect(() => stubDocument.body).not.toThrow();
  });

  it('should not crash when Vite HMR client iterates document.querySelectorAll() result', async () => {
    await import('#framework/worker-preload-polyfill.js');

    const stubDocument = getDocumentStub();
    /*
     * Replicates `client.mjs:1058`:
     *   document.querySelectorAll("style[data-vite-dev-id]").forEach((el) => { ... })
     * The result must support `.forEach` to keep the HMR client alive.
     */
    expect(() => {
      const nodes = stubDocument.querySelectorAll();
      (nodes as unknown as { forEach: (cb: (el: unknown) => void) => void }).forEach(() => {});
    }).not.toThrow();
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

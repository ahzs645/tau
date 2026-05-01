/**
 * Minimal DOM stubs for Web Worker contexts.
 *
 * Two distinct bundler subsystems require these stubs:
 *
 * 1. **Vite's `__vitePreload` helper** wraps dynamic `import()` calls and
 *    injects `<link rel="modulepreload">` via `document` and dispatches
 *    `vite:preloadError` via `window.dispatchEvent()`.
 * 2. **Vite's HMR client** (`vite/dist/client/client.mjs`) probes
 *    `"document" in globalThis` and unconditionally calls every
 *    `document.X` it needs when the probe succeeds — without per-method
 *    `typeof` guards. Defining `globalThis.document` flips that probe
 *    to `true`, so the stub MUST cover every method the HMR client
 *    touches or the worker dies on import.
 *
 * The HMR-client crash is silent and manifests upstream as a
 * perpetually-hanging preview (the kernel client never gets the
 * `worker-ready` message). Audit Vite's `client.mjs` for `document.X`
 * accesses on every Vite upgrade and extend the stub accordingly. The
 * test file pins the contract.
 *
 * Environment detection (`getEnvironment()`) uses `WorkerGlobalScope` to
 * distinguish workers from browsers, so these stubs don't affect detection.
 *
 * This module MUST be the first static import in the worker entry point so that
 * stubs are in place before any bundler-injected preload code executes.
 */

// oxlint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op for DOM stub
const noop = (): void => {};

if (typeof document === 'undefined') {
  const noopElement = {
    rel: '',
    as: '',
    crossOrigin: '',
    href: '',
    setAttribute: noop,
    addEventListener: noop,
  };

  /*
   * Empty-array stand-in for `NodeList` / `HTMLCollection` results — Vite's
   * HMR client iterates results with `.forEach`, so a real Array suffices.
   */
  const emptyNodeList: never[] = [];

  Object.defineProperty(globalThis, 'document', {
    value: {
      // __vitePreload helper surface
      getElementsByTagName: () => emptyNodeList,
      querySelector: () => null,
      createElement: () => noopElement,
      head: { appendChild: noop },

      // Vite HMR client surface (vite/dist/client/client.mjs)
      querySelectorAll: () => emptyNodeList,
      addEventListener: noop,
      removeEventListener: noop,
      createTextNode: () => noopElement,
      body: null,
      visibilityState: 'visible',
    },
    writable: true,
    configurable: true,
  });
}

// oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- window can be undefined in browser/worker
if (globalThis.window === undefined) {
  Object.defineProperty(globalThis, 'window', {
    value: {
      dispatchEvent: noop,
      addEventListener: noop,
      removeEventListener: noop,
    },
    writable: true,
    configurable: true,
  });
}

export {};

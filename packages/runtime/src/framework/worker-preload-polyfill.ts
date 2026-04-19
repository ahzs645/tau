/**
 * Minimal DOM stubs for Web Worker contexts.
 *
 * Bundlers like Vite wrap dynamic `import()` calls with a modulepreload helper
 * (`__vitePreload`) that:
 * 1. Injects `<link rel="modulepreload">` via `document` (DOM API)
 * 2. Dispatches `vite:preloadError` via `window.dispatchEvent()` on failure
 *
 * Neither `document` nor `window` exist in Web Workers, so both helpers crash.
 * This polyfill provides no-op stubs for both so the preload helper executes
 * harmlessly. The actual dynamic `import()` still works normally.
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

  Object.defineProperty(globalThis, 'document', {
    value: {
      getElementsByTagName: () => [],
      querySelector: () => null,
      createElement: () => noopElement,
      head: { appendChild: noop },
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

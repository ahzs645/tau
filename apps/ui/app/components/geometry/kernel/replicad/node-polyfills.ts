/**
 * Polyfills for running replicad-opencascadejs in Node.js ESM environments.
 *
 * The Emscripten-compiled module uses CommonJS globals (__dirname, require)
 * that don't exist in ESM. This file must be imported BEFORE any
 * replicad-opencascadejs imports.
 *
 * Uses capability detection - only applies polyfills when needed.
 * @see https://github.com/nicolo-ribaudo/replicad-cli/blob/main/src/initOCSingle.js
 */

// Polyfill __dirname if undefined and import.meta.dirname is available
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- can be undefined in Node.js
if (globalThis.__dirname === undefined && import.meta.dirname !== undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Polyfill for Emscripten compatibility
  (globalThis as any).__dirname = import.meta.dirname;
}

// Polyfill require if undefined - use try/catch for capability detection
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- can be undefined in Node.js
if (globalThis.require === undefined) {
  try {
    // Try to create require using Node.js module API
    const { createRequire } = await import('node:module');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Polyfill for Emscripten compatibility
    (globalThis as any).require = createRequire(import.meta.url);
  } catch {
    // Not in Node.js, no polyfill needed (browser has different loading path)
  }
}

export {};

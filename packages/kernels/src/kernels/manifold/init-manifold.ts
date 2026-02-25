import { setWasmUrl } from 'manifold-3d/lib/wasm.js';

// WASM URL using universal pattern for browsers and bundlers.
// The WASM file is copied from node_modules via copy-files-from-to.
// @see https://web.dev/articles/bundling-non-js-resources#universal_pattern_for_browsers_and_bundlers
const manifoldWasmUrl = new URL('wasm/manifold.wasm', import.meta.url).href;

/**
 * Configure the Manifold WASM module URL before any initialization.
 * Must be called before importing `manifold-3d/manifoldCAD` (which triggers
 * a top-level `await getManifoldModule()` that uses this URL via `locateFile`).
 */
export function initManifoldWasm(): void {
  setWasmUrl(manifoldWasmUrl);
}

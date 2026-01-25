/* eslint-disable promise/prefer-await-to-then -- WASM loading doesn't support await */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- emscripten types are not available as a module
/// <reference types="emscripten" />

import opencascade from 'replicad-opencascadejs/src/replicad_single.js';
import type { OpenCascadeInstance } from 'replicad-opencascadejs/src/replicad_single.js';
import opencascadeWasmUrl from 'replicad-opencascadejs/src/replicad_single.wasm?url';
import opencascadeWithExceptions from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import type { OpenCascadeInstance as OpenCascadeInstanceWithExceptions } from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import opencascadeWithExceptionsWasmUrl from 'replicad-opencascadejs/src/replicad_with_exceptions.wasm?url';

// Export WASM URLs for cache key computation
// eslint-disable-next-line no-barrel-files/no-barrel-files, unicorn/prefer-export-from -- export for cache key computation
export { opencascadeWasmUrl };
// eslint-disable-next-line no-barrel-files/no-barrel-files, unicorn/prefer-export-from -- export for cache key computation
export { opencascadeWithExceptionsWasmUrl };

// Types for OpenCascade modules
type OpenCascadeModule = (options?: Partial<EmscriptenModule>) => Promise<OpenCascadeInstance>;
type OpenCascadeModuleWithExceptions = (
  options?: Partial<EmscriptenModule>,
) => Promise<OpenCascadeInstanceWithExceptions>;

/**
 * Optimized version of OpenCascade initialization with caching
 */
export async function initOpenCascade(): Promise<OpenCascadeInstance> {
  // Initialize with optimized settings
  const instance = await (opencascade as OpenCascadeModule)({
    locateFile: () => opencascadeWasmUrl,
    // Use a larger memory allocation for better performance
    // eslint-disable-next-line @typescript-eslint/naming-convention -- this is a valid property
    TOTAL_MEMORY: 256 * 1024 * 1024, // 256MB
    // Let the browser optimize WebAssembly compilation
    instantiateWasm(imports, successCallback) {
      if (typeof fetch === 'undefined') {
        return {}; // Skip streaming in environments without fetch
      }

      WebAssembly.instantiateStreaming(fetch(opencascadeWasmUrl, { cache: 'force-cache' }), imports)
        .then((output) => {
          successCallback(output.instance);
        })
        .catch(() => {
          // Fallback to traditional approach
          void fetch(opencascadeWasmUrl, { cache: 'force-cache' })
            .then(async (response) => response.arrayBuffer())
            .then(async (buffer) => WebAssembly.instantiate(buffer, imports))
            .then((output) => {
              successCallback(output.instance);
            });
        });
      return {}; // Return empty object to indicate we're handling instantiation
    },
  });

  return instance;
}

/**
 * Optimized version of OpenCascade initialization with exceptions and caching
 */
export async function initOpenCascadeWithExceptions(): Promise<OpenCascadeInstanceWithExceptions> {
  // Initialize with optimized settings
  const instance = await (opencascadeWithExceptions as OpenCascadeModuleWithExceptions)({
    locateFile: () => opencascadeWithExceptionsWasmUrl,
    // Use a larger memory allocation for better performance
    // eslint-disable-next-line @typescript-eslint/naming-convention -- this is a valid property
    TOTAL_MEMORY: 256 * 1024 * 1024, // 256MB
    // Let the browser optimize WebAssembly compilation
    instantiateWasm(imports, successCallback) {
      if (typeof fetch === 'undefined') {
        return {}; // Skip streaming in environments without fetch
      }

      WebAssembly.instantiateStreaming(fetch(opencascadeWithExceptionsWasmUrl, { cache: 'force-cache' }), imports)
        .then((output) => {
          successCallback(output.instance);
        })
        .catch(() => {
          // Fallback to traditional approach
          void fetch(opencascadeWithExceptionsWasmUrl, { cache: 'force-cache' })
            .then(async (response) => response.arrayBuffer())
            .then(async (buffer) => WebAssembly.instantiate(buffer, imports))
            .then((output) => {
              successCallback(output.instance);
            });
        });
      return {}; // Return empty object to indicate we're handling instantiation
    },
  });

  return instance;
}

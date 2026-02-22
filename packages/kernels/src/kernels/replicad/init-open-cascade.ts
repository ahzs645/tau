// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- emscripten types are not available as a module
/// <reference types="emscripten" />

import type { KernelSpanTracer } from '@taucad/types';
import opencascade from 'replicad-opencascadejs/src/replicad_single.js';
import type { OpenCascadeInstance } from 'replicad-opencascadejs/src/replicad_single.js';
import opencascadeWithExceptions from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import type { OpenCascadeInstance as OpenCascadeInstanceWithExceptions } from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import { compileWasmStreaming } from '#framework/wasm-loader.js';

// WASM URLs using universal pattern for browsers and bundlers
// WASM files are copied from node_modules via copy-files-from-to
// @see https://web.dev/articles/bundling-non-js-resources#universal_pattern_for_browsers_and_bundlers
export const opencascadeWasmUrl = new URL('wasm/replicad_single.wasm', import.meta.url).href;
export const opencascadeWithExceptionsWasmUrl = new URL('wasm/replicad_with_exceptions.wasm', import.meta.url).href;

// Types for OpenCascade modules
type OpenCascadeModule = (options?: Partial<EmscriptenModule>) => Promise<OpenCascadeInstance>;
type OpenCascadeModuleWithExceptions = (
  options?: Partial<EmscriptenModule>,
) => Promise<OpenCascadeInstanceWithExceptions>;

/**
 * Options for initializing OpenCascade.
 */
type InitOpenCascadeOptions = {
  /** Optional callback to handle stdout messages. Defaults to no-op (silences logs). */
  print?: (text: string) => void;
  /** Optional callback to handle stderr messages. Defaults to no-op (silences logs). */
  printErr?: (text: string) => void;
  /** Optional span tracer for hierarchy-aware telemetry */
  tracer?: KernelSpanTracer;
};

// Default no-op function to silence verbose OpenCascade logs
// eslint-disable-next-line @typescript-eslint/no-empty-function -- Intentional no-op to silence logs
const noop = (): void => {};

/**
 * Initialize OpenCascade with the single (non-exception) WASM module.
 * Uses streaming WASM compilation for better performance.
 * @param options - Optional callbacks for stdout/stderr. Defaults to silencing logs.
 * @see https://github.com/sgenoud/replicad-cli/blob/main/src/initOCSingle.js
 */
export async function initOpenCascade(options?: InitOpenCascadeOptions): Promise<OpenCascadeInstance> {
  const compiledModule = await compileWasmStreaming(opencascadeWasmUrl, options?.tracer);

  const instance = await (opencascade as OpenCascadeModule)({
    instantiateWasm(imports: WebAssembly.Imports, successCallback: (instance: WebAssembly.Instance) => void) {
      void (async () => {
        try {
          const wasmInstance = await WebAssembly.instantiate(compiledModule, imports);
          successCallback(wasmInstance);
        } catch (error: unknown) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      })();

      return {};
    },
    print: options?.print ?? noop,
    printErr: options?.printErr ?? noop,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- this is a valid property
    TOTAL_MEMORY: 256 * 1024 * 1024,
  });

  return instance;
}

/**
 * Initialize OpenCascade with exceptions support for detailed error information.
 * Uses streaming WASM compilation for better performance.
 * @param options - Optional callbacks for stdout/stderr. Defaults to silencing logs.
 * @see https://github.com/sgenoud/replicad-cli/blob/main/src/initOCSingle.js
 */
export async function initOpenCascadeWithExceptions(
  options?: InitOpenCascadeOptions,
): Promise<OpenCascadeInstanceWithExceptions> {
  const compiledModule = await compileWasmStreaming(opencascadeWithExceptionsWasmUrl, options?.tracer);

  const instance = await (opencascadeWithExceptions as OpenCascadeModuleWithExceptions)({
    instantiateWasm(imports: WebAssembly.Imports, successCallback: (instance: WebAssembly.Instance) => void) {
      void (async () => {
        try {
          const wasmInstance = await WebAssembly.instantiate(compiledModule, imports);
          successCallback(wasmInstance);
        } catch (error: unknown) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      })();

      return {};
    },
    print: options?.print ?? noop,
    printErr: options?.printErr ?? noop,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- this is a valid property
    TOTAL_MEMORY: 256 * 1024 * 1024,
  });

  return instance;
}

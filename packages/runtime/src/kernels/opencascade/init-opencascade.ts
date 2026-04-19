// oxlint-disable-next-line @typescript-eslint/triple-slash-reference -- required for emscripten ambient type declaration
/// <reference types="emscripten" />

import type { RuntimeSpanTracer } from '#types/runtime-tracer.types.js';
import { compileWasmStreaming } from '#framework/wasm-loader.js';

/**
 * The ES module namespace of the compiled opencascade.js WASM module.
 *
 * Contains the default export (factory function) that produces an
 * `OpenCascadeInstance` when awaited.
 *
 * @public
 */
// oxlint-disable-next-line @typescript-eslint/consistent-type-imports -- typeof import() is the only way to reference this module's namespace type
export type OpenCascadeModule = typeof import('#kernels/opencascade/wasm/opencascade_full.js');
// oxlint-disable-next-line no-barrel-files/no-barrel-files -- type re-export from WASM binding, not a barrel file
export type { OpenCascadeInstance } from '#kernels/opencascade/wasm/opencascade_full.js'; // eslint-disable-line import-x/no-extraneous-dependencies -- internal # imports resolve to self

/** Options for customizing OpenCASCADE WASM initialization behavior. */
type InitOpenCascadeOptions = {
  /** Handler for C++ `stdout` messages. Defaults to a no-op. */
  print?: (text: string) => void;
  /** Handler for C++ `stderr` messages. Defaults to a no-op. */
  printErr?: (text: string) => void;
  /** Optional span tracer for instrumenting compilation and instantiation steps. */
  tracer?: RuntimeSpanTracer;
};

const noop = (): void => {
  // Intentionally empty
};

/**
 * Initialize the OpenCASCADE WASM module by calling its Emscripten factory function.
 *
 * Compiles the WASM binary via streaming compilation, then invokes the factory
 * (`MODULARIZE` pattern) with a custom `instantiateWasm` hook that reuses the
 * pre-compiled `WebAssembly.Module` to avoid double compilation.
 *
 * @param wasmUrl - URL or path to the `.wasm` binary for streaming fetch.
 * @param moduleExports - The ES module namespace containing the Emscripten factory as `default`.
 * @param options - Optional callbacks for stdout/stderr and tracing instrumentation.
 * @returns The fully initialized OpenCASCADE instance with all OCCT bindings populated.
 * @public
 */
export async function initOpenCascade(
  wasmUrl: string,
  moduleExports: OpenCascadeModule,
  options?: InitOpenCascadeOptions,
): Promise<unknown> {
  const { tracer } = options ?? {};
  const compiledModule = await compileWasmStreaming(wasmUrl, tracer);

  const instantiateSpan = tracer?.startSpan('wasm.emscripten-init');
  const factory = moduleExports.default;
  const instance = await factory({
    instantiateWasm(imports: WebAssembly.Imports, successCallback: (instance: WebAssembly.Instance) => void) {
      const instSpan = tracer?.startSpan('wasm.instantiate');
      void (async () => {
        try {
          const wasmInstance = await WebAssembly.instantiate(compiledModule, imports);
          instSpan?.end();
          successCallback(wasmInstance);
        } catch (error) {
          instSpan?.end();
          throw error instanceof Error ? error : new Error(String(error));
        }
      })();

      return {};
    },
    print: options?.print ?? noop,
    printErr: options?.printErr ?? noop,
  });
  instantiateSpan?.end();

  return instance;
}

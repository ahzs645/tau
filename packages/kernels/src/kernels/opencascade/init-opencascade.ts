// oxlint-disable-next-line @typescript-eslint/triple-slash-reference -- required for emscripten ambient type declaration
/// <reference types="emscripten" />

// eslint-disable-next-line import-x/no-extraneous-dependencies -- internal # imports resolve to self
import type { OpenCascadeInstance } from '#kernels/opencascade/wasm/opencascade_full.js';
import type { KernelSpanTracer } from '#types/kernel-tracer.types.js';
import { compileWasmStreaming } from '#framework/wasm-loader.js';

/**
 *
 */
export type OpenCascadeModuleFactory = (options?: Partial<EmscriptenModule>) => Promise<OpenCascadeInstance>;

type InitOpenCascadeOptions = {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  tracer?: KernelSpanTracer;
};

const noop = (): void => {
  // Intentionally empty
};

/**
 *
 */
export async function initOpenCascade(
  wasmUrl: string,
  bindingsFactory: OpenCascadeModuleFactory,
  options?: InitOpenCascadeOptions,
): Promise<OpenCascadeInstance> {
  const { tracer } = options ?? {};
  const compiledModule = await compileWasmStreaming(wasmUrl, tracer);

  const instantiateSpan = tracer?.startSpan('wasm.emscripten-init');
  const instance = await bindingsFactory({
    instantiateWasm(imports: WebAssembly.Imports, successCallback: (instance: WebAssembly.Instance) => void) {
      const instSpan = tracer?.startSpan('wasm.instantiate');
      void (async () => {
        try {
          const wasmInstance = await WebAssembly.instantiate(compiledModule, imports);
          instSpan?.end();
          successCallback(wasmInstance);
        } catch (error: unknown) {
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

/**
 * Resolve a CJS default export that may be double-wrapped under dynamic import().
 *
 * @param imported - Value from dynamic import (may be function or { default: function })
 * @returns The unwrapped function or original value
 */
export function resolveCjsDefault<T>(imported: T): T {
  if (typeof imported === 'function') {
    return imported;
  }

  if (imported !== null && typeof imported === 'object' && 'default' in imported) {
    const nested = (imported as Record<string, unknown>)['default'];
    if (typeof nested === 'function') {
      return nested as T;
    }
  }

  return imported;
}

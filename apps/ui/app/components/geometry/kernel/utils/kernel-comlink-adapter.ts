/**
 * Comlink Adapter for KernelWorker
 *
 * Provides a Proxy wrapper that maps string method names to symbol-keyed methods,
 * enabling Comlink compatibility while keeping the KernelWorker class clean.
 *
 * Comlink can only serialize string method names via postMessage. Symbol properties
 * cannot be transferred (see https://github.com/GoogleChromeLabs/comlink/issues/349).
 * This adapter intercepts string method accesses and delegates to symbol-keyed methods.
 */

import * as kernelSymbols from '@taucad/types/symbols';
import type { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';

/**
 * Map of string method names to their corresponding symbol keys.
 * Used by the Proxy to translate Comlink's string-based calls to symbol-based implementations.
 */
const methodMapping: Record<string, symbol> = {
  initializeEntry: kernelSymbols.initializeEntry,
  cleanupEntry: kernelSymbols.cleanupEntry,
  canHandleEntry: kernelSymbols.canHandleEntry,
  getParametersEntry: kernelSymbols.getParametersEntry,
  createGeometryEntry: kernelSymbols.createGeometryEntry,
  exportGeometryEntry: kernelSymbols.exportGeometryEntry,
  getExportFormats: kernelSymbols.getExportFormats,
};

/**
 * Type that exposes string-named methods for Comlink usage.
 * Maps each symbol-keyed method to a string-named equivalent.
 */
export type ComlinkKernelWorker<T extends KernelWorker> = T & {
  initializeEntry: T[typeof kernelSymbols.initializeEntry];
  cleanupEntry: T[typeof kernelSymbols.cleanupEntry];
  canHandleEntry: T[typeof kernelSymbols.canHandleEntry];
  getParametersEntry: T[typeof kernelSymbols.getParametersEntry];
  createGeometryEntry: T[typeof kernelSymbols.createGeometryEntry];
  exportGeometryEntry: T[typeof kernelSymbols.exportGeometryEntry];
  getExportFormats: T[typeof kernelSymbols.getExportFormats];
};

/**
 * Wraps a KernelWorker to expose string-named methods for Comlink compatibility.
 *
 * Comlink can only serialize string method names, so this proxy intercepts
 * string property accesses and delegates to the corresponding symbol-keyed methods.
 *
 * @example
 * ```typescript
 * import { wrapForComlink } from '#components/geometry/kernel/utils/kernel-comlink-adapter.js';
 *
 * const worker = new OpenScadWorker();
 * const service = wrapForComlink(worker);
 * exposeWorker(service);
 *
 * export type OpenScadBuilderInterface = typeof service;
 * ```
 *
 * @param worker - The KernelWorker instance to wrap
 * @returns A proxied worker with string-named method accessors
 */
export function wrapForComlink<T extends KernelWorker>(worker: T): ComlinkKernelWorker<T> {
  return new Proxy(worker, {
    get(target, prop) {
      // If accessing a string name that maps to a symbol, use the symbol
      if (typeof prop === 'string') {
        const symbolKey = methodMapping[prop];
        if (symbolKey !== undefined) {
          const method = Reflect.get(target, symbolKey);
          // Bind the method to preserve `this` context
          return typeof method === 'function'
            ? (method.bind(target) as T[keyof T & symbol])
            : (method as T[keyof T & symbol]);
        }
      }

      // For all other properties, use default behavior
      return Reflect.get(target, prop);
    },
  }) as ComlinkKernelWorker<T>;
}

/**
 * Kernel Worker Symbols
 *
 * These symbols are used to key framework-only methods on KernelWorker.
 * Methods keyed by these symbols are hidden from kernel developer autocomplete,
 * but remain fully type-safe when accessed by framework code that imports them.
 *
 * @example
 * ```typescript
 * import * as kernelSymbols from '@taucad/types/symbols';
 *
 * // Framework code can call symbol-keyed methods
 * await worker[kernelSymbols.initializeEntry](...);
 * ```
 */

/** Symbol for the initializeEntry method - called by framework to initialize worker */
export const initializeEntry: unique symbol = Symbol('initializeEntry');

/** Symbol for the cleanupEntry method - called by framework to cleanup worker */
export const cleanupEntry: unique symbol = Symbol('cleanupEntry');

/** Symbol for the canHandleEntry method - called by framework to check file handling */
export const canHandleEntry: unique symbol = Symbol('canHandleEntry');

/** Symbol for the getParametersEntry method - called by framework to extract parameters */
export const getParametersEntry: unique symbol = Symbol('getParametersEntry');

/** Symbol for the createGeometryEntry method - called by framework to compute geometry */
export const createGeometryEntry: unique symbol = Symbol('createGeometryEntry');

/** Symbol for the exportGeometryEntry method - called by framework to export geometry */
export const exportGeometryEntry: unique symbol = Symbol('exportGeometryEntry');

/** Symbol for the getExportFormats method - called by framework to get export formats */
export const getExportFormats: unique symbol = Symbol('getExportFormats');

/** Symbol for the getMiddleware method - called internally and overridable by tests */
export const getMiddleware: unique symbol = Symbol('getMiddleware');

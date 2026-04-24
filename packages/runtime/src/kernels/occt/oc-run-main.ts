/**
 * Shared OCCT user-code runner.
 *
 * Invokes the user module's `default`/`main` export with the kernel-specific
 * first argument (the OC instance for OpenCascade, the registered `replicad`
 * module for Replicad), and converts any thrown error into a fully
 * source-mapped {@link KernelIssue} via {@link formatOcRuntimeError}.
 *
 * Encapsulates the "runMain with source map" pattern that previously lived
 * inside the Replicad kernel and was missing from the OpenCascade kernel.
 */

import { named } from '#framework/named.js';
import type { RuntimeModuleExports } from '#kernels/kernel-module-helpers.js';
import { formatOcRuntimeError } from '#kernels/occt/oc-error-formatter.js';
import type { OcErrorContext } from '#kernels/occt/oc-error-formatter.js';
import type { OcExceptionInstance } from '#kernels/occt/oc-exceptions.js';
import type { KernelIssue } from '#types/runtime.types.js';

/**
 * Result of running the user's `main` function via {@link runOcMain}.
 */
export type OcRunMainResult<T> = { success: true; value: T } | { success: false; issues: KernelIssue[] };

/**
 * Invoke `module.default` (or `module.main`) with the kernel-specific first
 * argument and the user's parameters. Errors are caught and routed through
 * {@link formatOcRuntimeError} so the resulting issue carries source-mapped
 * stack frames pointing back to the user's code.
 *
 * Returns `{ success: true, value: undefined }` when no `main`/`default`
 * export is present — callers decide whether that is an issue at the
 * application level (e.g. OpenCascade reports a "main not found" warning,
 * Replicad treats it as an empty render).
 */
export const runOcMain = named(
  'runOcMain',
  async function <T>(input: {
    module: RuntimeModuleExports;
    parameters: Record<string, unknown>;
    ocInstance: OcExceptionInstance;
    errorContext: OcErrorContext;
    /**
     * The first positional argument passed to `main(arg, parameters)` when the
     * user's main has arity >= 2. The OpenCascade kernel passes the OC instance;
     * the Replicad kernel passes the registered `replicad` module.
     */
    firstArg: unknown;
  }): Promise<OcRunMainResult<T>> {
    try {
      const main = input.module.default ?? input.module.main;
      if (typeof main !== 'function') {
        return { success: true, value: undefined as T };
      }

      const value = main.length >= 2 ? await main(input.firstArg, input.parameters) : await main(input.parameters);
      return { success: true, value: value as T };
    } catch (error) {
      return {
        success: false,
        issues: [formatOcRuntimeError(error, input.ocInstance, input.errorContext)],
      };
    }
  },
);

/**
 * OpenCASCADE Exception Handling Utilities
 *
 * Provides OC exception proxy wrapping, numeric exception decoding,
 * and human-readable message formatting for OpenCASCADE errors.
 *
 * Used by replicad.kernel.ts when withExceptions mode is enabled.
 */

import type { OpenCascadeInstance as OpenCascadeInstanceWithExceptions } from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import type { KernelIssue, KernelStackFrame, ErrorLocation } from '@taucad/types';

// =============================================================================
// OC Exception Error Class
// =============================================================================

/**
 * Error wrapping a numeric OpenCASCADE exception pointer.
 * Preserves the JS stack trace at the WASM call boundary so source maps
 * can map it back to user code.
 */
export class OcExceptionError extends Error {
  public readonly ocExceptionPointer: number;

  public constructor(pointer: number) {
    super(`OpenCASCADE exception (ptr: ${pointer})`);
    this.name = 'OcExceptionError';
    this.ocExceptionPointer = pointer;
  }
}

/**
 * Rethrow a numeric exception as an OcExceptionError.
 * This preserves the JS call stack at the point of the WASM call.
 */
function rethrowIfNumeric(error: unknown): never {
  if (typeof error === 'number') {
    throw new OcExceptionError(error);
  }

  throw error;
}

// =============================================================================
// OpenCASCADE Exception -> Human-Readable Message Mapping
// =============================================================================

const ocExceptionDescriptions: ReadonlyMap<string, string> = new Map([
  ['BRepSweep_Translation', 'Sweep/extrusion failed — the sweep distance may be zero or the profile is invalid'],
  ['BRepSweep', 'Sweep operation failed — check the profile and sweep parameters'],
  ['BOPAlgo_AlertBOPNotAllowed', 'Boolean operation is not allowed for the given shapes'],
  ['BOPAlgo', 'Boolean operation failed — shapes may be invalid or non-intersecting'],
  ['BRepBuilderAPI', 'Shape construction failed — check dimensions, points, or parameters'],
  ['BRepFilletAPI', 'Fillet/chamfer operation failed — radius may be too large for the edge'],
  ['ChFiDS', 'Fillet/chamfer data error — the edge geometry may be incompatible'],
  ['Standard_ConstructionError', 'Construction failed — input geometry is degenerate or invalid'],
  ['Standard_NullObject', 'Operation received an empty or null shape'],
  ['Standard_NullValue', 'A required value is zero or null'],
  ['Standard_DimensionMismatch', 'Dimension mismatch between inputs'],
  ['Standard_DimensionError', 'Dimension error in the operation'],
  ['Standard_OutOfRange', 'A parameter is outside the valid range'],
  ['Standard_RangeError', 'A value is outside its valid range'],
  ['Standard_TypeMismatch', 'Wrong shape type for this operation'],
  ['Standard_DomainError', 'Mathematical domain error — input is outside the valid domain'],
  ['Standard_DivideByZero', 'Division by zero'],
  ['Standard_Overflow', 'Numeric overflow — value is too large'],
  ['Standard_Underflow', 'Numeric underflow — value is too small'],
  ['Standard_NumericError', 'Numeric error in computation'],
  ['Standard_ImmutableObject', 'Cannot modify an immutable object'],
  ['Standard_NoSuchObject', 'The requested object does not exist'],
  ['Standard_NotImplemented', 'This operation is not implemented'],
  ['Standard_ProgramError', 'Internal program error in the geometry kernel'],
  ['Standard_OutOfMemory', 'Out of memory — the operation requires too many resources'],
  ['StdFail_NotDone', 'Operation did not complete — the algorithm failed to produce a result'],
  ['StdFail_InfiniteSolutions', 'Infinite solutions — the problem is under-constrained'],
  ['StdFail_Undefined', 'Result is undefined for the given input'],
  ['Geom_UndefinedDerivative', 'Curve/surface derivative is undefined at this point'],
  ['Geom_UndefinedValue', 'Curve/surface value is undefined at this point'],
  ['Standard_Failure', 'The geometry kernel encountered an error'],
]);

/**
 * Format an OpenCASCADE exception into a human-readable KernelError message.
 */
export function formatOcExceptionMessage(typeName: string, rawMessage: string): string {
  const candidates = [typeName, rawMessage].filter(Boolean);
  for (const candidate of candidates) {
    for (const [prefix, description] of ocExceptionDescriptions) {
      if (candidate.startsWith(prefix)) {
        const identifier = typeName || rawMessage;
        return `KernelError: ${description} (${identifier})`;
      }
    }
  }

  if (typeName && rawMessage) {
    return `KernelError: ${typeName}: ${rawMessage}`;
  }

  if (typeName || rawMessage) {
    return `KernelError: ${typeName || rawMessage}`;
  }

  return 'KernelError: Unknown kernel error';
}

// =============================================================================
// OC Instance Proxy Wrapping
// =============================================================================

/**
 * Check whether an object looks like an Emscripten-generated C++ wrapper instance.
 * These objects always have a `delete()` method for freeing WASM memory.
 */
function isEmscriptenObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'delete' in value &&
    typeof (value as Record<string, unknown>)['delete'] === 'function'
  );
}

/**
 * Wrap an OpenCASCADE WASM instance with a deep Proxy that intercepts all
 * function/constructor calls. When a call throws a numeric exception (Emscripten's
 * representation of a C++ exception), the Proxy catches it and re-throws an
 * OcExceptionError with the JS stack trace preserved from the call site.
 *
 * Uses a WeakMap cache to avoid re-wrapping the same object multiple times.
 */
export function wrapOcInstance<T extends Record<string, unknown>>(instance: T): T {
  const proxyCache = new WeakMap<Record<string, unknown>, Record<string, unknown>>();

  function wrapObject(target: Record<string, unknown>): Record<string, unknown> {
    const cached = proxyCache.get(target);
    if (cached) {
      return cached;
    }

    const proxy: Record<string, unknown> = new Proxy(target, {
      get(proxyTarget, property, receiver) {
        if (property === 'delete' || property === Symbol.toPrimitive || property === Symbol.toStringTag) {
          return Reflect.get(proxyTarget, property, receiver) as unknown;
        }

        const value: unknown = Reflect.get(proxyTarget, property, receiver);
        if (typeof value === 'function') {
          return wrapFunction(value as (...arguments_: unknown[]) => unknown);
        }

        return value;
      },
    });
    proxyCache.set(target, proxy);
    return proxy;
  }

  function maybeWrapResult(result: unknown): unknown {
    if (isEmscriptenObject(result)) {
      return wrapObject(result);
    }

    return result;
  }

  function wrapFunction(function_: (...arguments_: unknown[]) => unknown): (...arguments_: unknown[]) => unknown {
    return new Proxy(function_, {
      construct(target, arguments_: unknown[], newTarget: (...arguments_: unknown[]) => unknown) {
        try {
          const result: unknown = Reflect.construct(target, arguments_, newTarget);
          return maybeWrapResult(result) as Record<string, unknown>;
        } catch (error) {
          rethrowIfNumeric(error);
        }
      },
      apply(target, thisArgument: unknown, arguments_: unknown[]) {
        try {
          const result: unknown = Reflect.apply(target, thisArgument, arguments_);
          return maybeWrapResult(result);
        } catch (error) {
          rethrowIfNumeric(error);
        }
      },
    });
  }

  return wrapObject(instance) as T;
}

// =============================================================================
// OC Exception Decoding
// =============================================================================

/**
 * Extract the exception type name from an OpenCASCADE Standard_Failure object.
 */
function extractExceptionTypeName(
  errorData: ReturnType<OpenCascadeInstanceWithExceptions['OCJS']['getStandard_FailureData']>,
): string {
  try {
    // eslint-disable-next-line new-cap, @typescript-eslint/naming-convention -- C++ method with PascalCase convention
    const dynType = errorData.DynamicType() as unknown as { Name(): string; delete(): void };
    try {
      // eslint-disable-next-line new-cap -- C++ method Name() is PascalCase in OpenCASCADE
      return dynType.Name();
    } finally {
      dynType.delete();
    }
  } catch {
    return '';
  }
}

/**
 * Extract message, type name, and C++ stack from an OpenCASCADE Standard_Failure.
 * Frees WASM memory for the error data when done.
 */
function extractStandardFailureData(
  ocInstance: OpenCascadeInstanceWithExceptions,
  errorPointer: number,
): { message: string; typeName: string; cppStack: string } {
  const errorData = ocInstance.OCJS.getStandard_FailureData(errorPointer);
  try {
    // eslint-disable-next-line new-cap -- C++ method
    const errorMessage = errorData.GetMessageString();
    // eslint-disable-next-line new-cap -- C++ method
    const cppStack = errorData.GetStackString();
    const typeName = extractExceptionTypeName(errorData);
    return { message: errorMessage, typeName, cppStack };
  } finally {
    errorData.delete();
  }
}

/**
 * Decode an OpenCASCADE exception pointer into a human-readable message.
 * Returns the enriched message and optional C++ stack, or falls back to a generic message.
 */
export function decodeOcException(
  pointer: number,
  ocInstance: OpenCascadeInstanceWithExceptions | undefined,
): { message: string; cppStack?: string } {
  let message = `KernelError: Unknown kernel error (code ${pointer})`;
  let cppStack: string | undefined;

  if (!ocInstance) {
    return { message, cppStack };
  }

  try {
    const failureData = extractStandardFailureData(ocInstance, pointer);
    message = formatOcExceptionMessage(failureData.typeName, failureData.message);
    cppStack = failureData.cppStack || undefined;
  } catch {
    // Fall through to generic message
  }

  return { message, cppStack };
}

// =============================================================================
// Runtime Error Formatting
// =============================================================================

/**
 * Format a runtime error into a KernelIssue, with OC exception decoding when available.
 *
 * Handles:
 * - OcExceptionError: thrown by the OC proxy wrapper (has pointer + JS stack)
 * - bare number: direct Emscripten throw (JS stack is unwound)
 * - Error instances: standard JS errors with stack traces
 *
 * @param error - The error thrown during execution
 * @param ocInstance - The OC instance with exceptions support (undefined when not in withExceptions mode)
 * @param parseStackTrace - Function to parse error stack traces into structured frames
 * @param applySourceMaps - Function to apply source map resolution to stack frames
 * @param deriveLocation - Function to derive error location from stack frames
 */
export function formatRuntimeErrorWithOc(
  error: unknown,
  ocInstance: OpenCascadeInstanceWithExceptions | undefined,
  parseStackTrace: (error: unknown) => KernelStackFrame[],
  applySourceMaps: (frames: KernelStackFrame[]) => KernelStackFrame[],
  deriveLocation: (frames: KernelStackFrame[], sourceMap?: string) => ErrorLocation | undefined,
  sourceMap?: string,
): KernelIssue {
  if (error instanceof OcExceptionError) {
    const { message, cppStack } = decodeOcException(error.ocExceptionPointer, ocInstance);
    const stackFrames = applySourceMaps(parseStackTrace(error));
    const location = deriveLocation(stackFrames, sourceMap);
    return { message, location, type: 'kernel', severity: 'error', stack: cppStack, stackFrames };
  }

  if (typeof error === 'number') {
    const { message, cppStack } = decodeOcException(error, ocInstance);
    const syntheticError = new Error(message);
    const stackFrames = applySourceMaps(parseStackTrace(syntheticError));
    const location = deriveLocation(stackFrames, sourceMap);
    return { message, location, type: 'kernel', severity: 'error', stack: cppStack, stackFrames };
  }

  const stackFrames = applySourceMaps(parseStackTrace(error));
  const location = deriveLocation(stackFrames, sourceMap);
  return {
    message: error instanceof Error ? error.message : String(error),
    location,
    type: 'runtime',
    severity: 'error',
    stackFrames,
  };
}

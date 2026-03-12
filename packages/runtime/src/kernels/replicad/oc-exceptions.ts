/**
 * OpenCASCADE Exception Handling Utilities
 *
 * Provides exception decoding and human-readable message formatting for
 * OpenCASCADE errors thrown as native WASM exceptions (-fwasm-exceptions).
 *
 * With native WASM exceptions, C++ exceptions propagate as WebAssembly.Exception
 * objects with proper stack traces — no proxy wrapping needed.
 */

import type { OpenCascadeInstance } from 'replicad-opencascadejs/src/replicad_single.js';
import type { OpenCascadeInstance as OpenCascadeWithExceptions } from 'replicad-opencascadejs/src/replicad_with_exceptions.js';
import type { KernelIssue, KernelStackFrame, ErrorLocation } from '#types/kernel.types.js';
import { OcKernelError, formatOcExceptionMessage } from '#kernels/replicad/oc-kernel-error.js';

// =============================================================================
// Reusable WASM Type Guards
// =============================================================================

/** Emscripten wrapper object with WASM memory management via `delete()`. */
export type EmscriptenObject = Record<string, unknown> & { delete(): void };

/**
 * Emscripten 5.x CppException — Error subclass with an `excPtr` property
 * pointing to the C++ exception in WASM memory.
 */
export type CppException = Error & { excPtr: number };

/**
 * Extracted WASM exception info: the numeric pointer and, when available,
 * the original Error that preserves the JS call-site stack trace.
 */
export type WasmExceptionInfo = {
  pointer: number;
  sourceError: Error | undefined;
};

/**
 * Checks whether a value is an Emscripten wrapper object with a `delete()` method for WASM memory cleanup.
 *
 * @param value - The value to check
 * @returns `true` if the value is an Emscripten-allocated C++ object
 */
export function isEmscriptenObject(value: unknown): value is EmscriptenObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    'delete' in value &&
    typeof (value as Record<string, unknown>)['delete'] === 'function'
  );
}

/**
 * Checks whether an error is an Emscripten 5.x CppException with a WASM pointer.
 *
 * @param error - The error to check
 * @returns `true` if the error is a CppException with an `excPtr` property
 */
export function isCppException(error: unknown): error is CppException {
  return (
    error instanceof Error && 'excPtr' in error && typeof (error as Record<string, unknown>)['excPtr'] === 'number'
  );
}

/**
 * Executes a callback with a WASM object and guarantees `delete()` is called afterward.
 *
 * @template T - The WASM object type
 * @template R - The callback return type
 * @param object - The WASM-allocated object to use and then free
 * @param callback - The function to execute with the object
 * @returns The callback's return value
 */
export function withWasmObject<T extends { delete(): void }, R>(object: T, callback: (object: T) => R): R {
  try {
    return callback(object);
  } finally {
    object.delete();
  }
}

/**
 * Emscripten module with native WASM exception helpers (exported via
 * -sEXPORT_EXCEPTION_HANDLING_HELPERS). These aren't in the generated
 * .d.ts but exist at runtime.
 */
type EmscriptenExceptionHelpers = {
  getExceptionMessage(ex: WebAssembly.Exception): [string, string];
};

/**
 * Extracts a WASM exception pointer from any Emscripten throw form (bare number or CppException).
 *
 * @param error - The thrown value to inspect
 * @returns The exception pointer and source Error, or `undefined` if not a WASM exception
 */
export function extractWasmException(error: unknown): WasmExceptionInfo | undefined {
  if (typeof error === 'number') {
    return { pointer: error, sourceError: undefined };
  }

  if (isCppException(error)) {
    return { pointer: error.excPtr, sourceError: error };
  }

  return undefined;
}

/**
 * Check if an error is a native WebAssembly.Exception (from -fwasm-exceptions).
 *
 * @param error - the value to check
 * @returns whether the value is a WebAssembly.Exception instance
 */
function isWebAssemblyException(error: unknown): error is WebAssembly.Exception {
  return (
    typeof WebAssembly !== 'undefined' &&
    typeof WebAssembly.Exception === 'function' &&
    error instanceof WebAssembly.Exception
  );
}

/**
 * Decode a WebAssembly.Exception using the Emscripten helper `getExceptionMessage`.
 * Returns the formatted message, or undefined if decoding fails.
 *
 * @param error - the WebAssembly exception to decode
 * @param ocInstance - the Emscripten instance with exception helper methods
 * @returns the decoded message, or undefined if decoding fails
 */
function decodeWebAssemblyException(
  error: WebAssembly.Exception,
  ocInstance: Partial<EmscriptenExceptionHelpers>,
): { message: string } | undefined {
  if (typeof ocInstance.getExceptionMessage !== 'function') {
    return undefined;
  }

  try {
    const [typeName, rawMessage] = ocInstance.getExceptionMessage(error);
    return { message: formatOcExceptionMessage(typeName, rawMessage) };
  } catch {
    return undefined;
  }
}

// =============================================================================
// OC Exception Decoding
// =============================================================================

/**
 * Extract the exception type name from an OpenCASCADE Standard_Failure object.
 *
 * @param errorData - the Standard_Failure data from OpenCASCADE
 * @returns the exception type name, or empty string on failure
 */
function extractExceptionTypeName(
  errorData: ReturnType<OpenCascadeWithExceptions['OCJS']['getStandard_FailureData']>,
): string {
  try {
    // oxlint-disable-next-line new-cap, @typescript-eslint/consistent-type-assertions -- OpenCASCADE C++ bindings use PascalCase methods; WASM binding type mismatch
    const dynType = errorData.ExceptionType() as unknown as {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- C++ method with PascalCase convention
      Name(): string;
      delete(): void;
    };

    // oxlint-disable-next-line new-cap -- OpenCASCADE C++ bindings use PascalCase methods
    return withWasmObject(dynType, (dt) => dt.Name());
  } catch {
    return '';
  }
}

/**
 * Extract message, type name, and C++ stack from an OpenCASCADE Standard_Failure.
 * Frees WASM memory for the error data when done.
 *
 * @param ocInstance - the OpenCASCADE WASM instance
 * @param errorPointer - the pointer to the Standard_Failure in WASM memory
 * @returns the extracted message, type name, and C++ stack trace
 */
function extractStandardFailureData(
  ocInstance: OpenCascadeInstance,
  errorPointer: number,
): { message: string; typeName: string; cppStack: string } {
  const oc = ocInstance as OpenCascadeWithExceptions;
  return withWasmObject(oc.OCJS.getStandard_FailureData(errorPointer), (errorData) => {
    // oxlint-disable-next-line new-cap -- OpenCASCADE C++ bindings use PascalCase methods
    const errorMessage = errorData.GetMessageString();
    // oxlint-disable-next-line new-cap -- OpenCASCADE C++ bindings use PascalCase methods
    const cppStack = errorData.GetStackString();
    const typeName = extractExceptionTypeName(errorData);
    return { message: errorMessage, typeName, cppStack };
  });
}

/**
 * Decodes an OpenCASCADE exception pointer into a human-readable message.
 *
 * @param pointer - The WASM memory pointer to the Standard_Failure object
 * @param ocInstance - The OpenCascade instance for accessing exception data
 * @returns The decoded message and optional C++ stack trace
 */
export function decodeOcException(
  pointer: number,
  ocInstance: OpenCascadeInstance,
): { message: string; cppStack?: string } {
  let message = `KernelError: Unknown kernel error (code ${pointer})`;
  let cppStack: string | undefined;

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
 * Formats a runtime error into a KernelIssue with OpenCASCADE exception decoding and stack enrichment.
 *
 * @returns A structured KernelIssue with decoded message, location, and stack frames
 */
export function formatRuntimeErrorWithOc({
  error,
  ocInstance,
  parseStackTrace,
  applySourceMaps,
  deriveLocation,
  sourceMap,
}: {
  /** The error thrown during execution */
  error: unknown;
  /** The OC instance (may or may not have exception support depending on WASM build) */
  ocInstance: OpenCascadeInstance;
  /** Function to parse error stack traces into structured frames */
  parseStackTrace: (error: unknown) => KernelStackFrame[];
  /** Function to apply source map resolution to stack frames */
  applySourceMaps: (frames: KernelStackFrame[]) => KernelStackFrame[];
  /** Function to derive error location from stack frames */
  deriveLocation: (frames: KernelStackFrame[], sourceMap?: string) => ErrorLocation | undefined;
  /** Optional source map JSON string */
  sourceMap?: string;
}): KernelIssue {
  if (error instanceof OcKernelError) {
    const stackFrames = applySourceMaps(parseStackTrace(error));
    const location = deriveLocation(stackFrames, sourceMap);
    return {
      message: error.message,
      location,
      type: 'kernel',
      severity: 'error',
      stackFrames,
    };
  }

  if (isWebAssemblyException(error)) {
    const decoded = decodeWebAssemblyException(error, ocInstance as Partial<EmscriptenExceptionHelpers>);
    if (decoded) {
      const stackFrames = applySourceMaps(parseStackTrace(new Error(decoded.message)));
      const location = deriveLocation(stackFrames, sourceMap);
      return {
        message: decoded.message,
        location,
        type: 'kernel',
        severity: 'error',
        stackFrames,
      };
    }
  }

  const wasmException = extractWasmException(error);
  if (wasmException) {
    const { message, cppStack } = decodeOcException(wasmException.pointer, ocInstance);
    const errorForStack = wasmException.sourceError ?? new Error(message);
    const stackFrames = applySourceMaps(parseStackTrace(errorForStack));
    const location = deriveLocation(stackFrames, sourceMap);
    return {
      message,
      location,
      type: 'kernel',
      severity: 'error',
      stack: cppStack,
      stackFrames,
    };
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

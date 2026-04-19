import type { SourceRange } from '@taucad/kcl-wasm-lib/bindings/SourceRange';
import type { KclError as WasmKclError } from '@taucad/kcl-wasm-lib/bindings/KclError';
import type { KernelStackFrame } from '#types/runtime.types.js';
import { sourceRangeToLineColumn } from '#kernels/zoo/source-range-utils.js';

/**
 * File metadata from WASM KclError, mapping module IDs to type and path.
 */
export type WasmFileInfo = {
  type: string;
  value: string;
};

/**
 * Extended WASM KclError that includes the `filenames` mapping omitted from the generated type.
 */
export type ExtendedWasmKclError = WasmKclError & {
  filenames?: Record<string | number, WasmFileInfo>;
};

/**
 * Simplified error kinds that map to KernelIssue types for KCL execution failures.
 */
export type KclErrorKind =
  | 'lexical'
  | 'syntax'
  | 'semantic'
  | 'type'
  | 'engine'
  | 'runtime'
  | 'internal'
  | 'io'
  | 'unexpected'
  | 'auth'
  | 'export'
  | 'connection'
  | 'unknown';

/**
 * Base error class for KCL execution failures with kind, message, and source location.
 */
export class KclError extends Error {
  /**
   * Creates a KclError from a kind and message without requiring a full source range.
   *
   * @param input - the error kind and message
   * @returns a new KclError instance
   */
  public static simple(input: { kind: KclErrorKind; message: string }): KclError {
    return new KclError(input.kind, input.message, [0, 0, 0]);
  }

  public readonly kind: KclErrorKind;
  public readonly sourceRange: SourceRange;
  public readonly msg: string;

  /**
   * Creates a KCL error with a classification, message, and source location.
   *
   * @param kind - the error classification (e.g., 'syntax', 'runtime')
   * @param message - human-readable error description
   * @param sourceRange - character offsets and module ID locating the error
   */
  public constructor(kind: KclErrorKind, message: string, sourceRange: SourceRange) {
    super(`${kind}: ${message}`);
    this.kind = kind;
    this.msg = message;
    this.sourceRange = sourceRange;
  }
}

/**
 * KCL error for authentication failures, including optional HTTP status code.
 */
export class KclAuthError extends KclError {
  public readonly statusCode?: number;

  /**
   * Creates an auth error with optional HTTP status and source location.
   *
   * @param message - human-readable auth failure description
   * @param statusCode - optional HTTP status code from the API
   * @param sourceRange - optional source location that triggered the auth call
   */
  public constructor(message: string, statusCode?: number, sourceRange?: SourceRange) {
    const defaultSourceRange: SourceRange = [0, 0, 0];
    super('auth', message, sourceRange ?? defaultSourceRange);
    this.statusCode = statusCode;
  }
}

/**
 * KCL error for export failures, including the export format type that failed.
 */
export class KclExportError extends KclError {
  public readonly exportType?: string;

  /**
   * Creates an export error for a specific format failure.
   *
   * @param message - human-readable export failure description
   * @param exportType - the format that failed (e.g., 'step', 'gltf')
   * @param sourceRange - optional source location associated with the export
   */
  public constructor(message: string, exportType?: string, sourceRange?: SourceRange) {
    const defaultSourceRange: SourceRange = [0, 0, 0];
    super('export', message, sourceRange ?? defaultSourceRange);
    this.exportType = exportType;
  }
}

/**
 * KCL error for WebSocket/API connection failures and service unavailability.
 */
export class KclConnectionError extends KclError {
  /**
   * Creates an error indicating the Zoo API is unreachable or temporarily down.
   *
   * @param details - optional additional context about the failure
   * @returns a KclConnectionError with `isApiUnavailable` set to `true`
   */
  public static apiUnavailable(details?: string): KclConnectionError {
    const baseMessage =
      'The Zoo CAD API is currently unavailable. This could be due to network issues or the service being temporarily down.';
    const message = details ? `${baseMessage} Details: ${details}` : baseMessage;
    return new KclConnectionError(message, {
      isApiUnavailable: true,
      statusCode: 503,
    });
  }

  /**
   * Creates an error for WebSocket connection failures to the Zoo API.
   *
   * @param details - optional additional context about the failure
   * @returns a KclConnectionError with `isApiUnavailable` set to `true`
   */
  public static webSocketFailed(details?: string): KclConnectionError {
    const baseMessage = 'Failed to establish a connection to the Zoo CAD API.';
    const message = details ? `${baseMessage} ${details}` : baseMessage;
    return new KclConnectionError(message, { isApiUnavailable: true });
  }

  public readonly statusCode?: number;
  public readonly isApiUnavailable: boolean;

  /**
   * Creates a connection error with optional status code and availability flag.
   *
   * @param message - human-readable connection failure description
   */
  public constructor(message: string, options?: { statusCode?: number; isApiUnavailable?: boolean }) {
    const defaultSourceRange: SourceRange = [0, 0, 0];
    super('connection', message, defaultSourceRange);
    this.statusCode = options?.statusCode;
    this.isApiUnavailable = options?.isApiUnavailable ?? false;
  }
}

/**
 * KCL error that wraps the original WASM KclError and preserves its structure for stack traces.
 */
export class KclWasmError extends KclError {
  public readonly wasmError: WasmKclError;

  /**
   * Wraps a WASM KclError, preserving its original structure for stack trace generation.
   *
   * @param wasmError - the original WASM KclError to wrap
   */
  public constructor(wasmError: WasmKclError) {
    const { kind, details } = wasmError;
    const { msg, sourceRanges } = details;

    // Use the first source range if available, otherwise default
    const sourceRange: SourceRange = sourceRanges.length > 0 ? sourceRanges[0]! : [0, 0, 0];

    super(kind as KclErrorKind, msg, sourceRange);
    this.wasmError = wasmError;
  }

  /**
   * Creates stack frames from the WASM error backtrace for diagnostic display.
   *
   * @param code - the source code for resolving character offsets to line/column positions
   * @returns an array of stack frames with resolved file names and positions
   */
  public createStackFrames(code: string): KernelStackFrame[] {
    const extendedError = this.wasmError as ExtendedWasmKclError;
    const { backtrace } = extendedError.details;
    const { filenames } = extendedError;

    if (backtrace.length === 0) {
      return [];
    }

    return backtrace.map((item) => {
      const { fnName, sourceRange } = item;
      const [_startChar, _endChar, moduleId] = sourceRange;

      // Get filename from filenames object using moduleId
      let fileName: string | undefined;
      if (filenames?.[moduleId]) {
        const fileInfo = filenames[moduleId];
        fileName = fileInfo.value;
      }

      // Convert source range to line/column positions
      const position = sourceRangeToLineColumn(sourceRange, code);

      const stackFrame: KernelStackFrame = {
        functionName: fnName ?? undefined,
        fileName,
        lineNumber: position.line,
        columnNumber: position.column,
        context: 'user',
      };

      return stackFrame;
    });
  }
}

/**
 * Checks whether the given value is a {@link KclError} instance.
 *
 * @param error - the value to check
 * @returns whether the value is a KclError
 */
export const isKclError = (error: unknown): error is KclError => {
  return error instanceof KclError;
};

/**
 * Checks whether the given value matches the WASM KclError shape (has `kind` and `details`).
 *
 * @param error - the value to check
 * @returns whether the value has the WASM KclError shape
 */
export const isWasmKclError = (error: unknown): error is WasmKclError => {
  return (
    error !== null &&
    typeof error === 'object' &&
    'kind' in error &&
    'details' in error &&
    typeof (error as WasmKclError).kind === 'string' &&
    typeof (error as WasmKclError).details === 'object'
  );
};

/**
 * Checks whether the given value is a WASM execution result containing a nested KclError.
 *
 * @param error - the value to check
 * @returns whether the value is a WASM execution result with a nested error
 */
export const isWasmExecutionResultWithError = (
  error: unknown,
): error is {
  error: WasmKclError;
  filenames?: Record<string | number, WasmFileInfo>;
} => {
  return (
    error !== null &&
    typeof error === 'object' &&
    'error' in error &&
    isWasmKclError((error as { error: unknown }).error)
  );
};

/**
 * Extracts a WasmKclError from direct or nested WASM error formats, attaching filenames when present.
 *
 * @param error - the value to extract a WASM KCL error from
 * @returns the extracted WasmKclError, or undefined if not a recognized format
 */
export const extractWasmKclError = (error: unknown): WasmKclError | undefined => {
  // Direct WASM KclError
  if (isWasmKclError(error)) {
    return error;
  }

  // WASM execution result with nested error
  if (isWasmExecutionResultWithError(error)) {
    // Create an extended error that includes filenames from the root level
    const extendedError = error.error as ExtendedWasmKclError;
    extendedError.filenames = error.filenames;
    return extendedError;
  }

  return undefined;
};

/**
 * Extracts an error message and source location from a KCL execution error array.
 *
 * @param errors - the raw error array from WASM execution
 * @param code - the source code for resolving character offsets to positions
 * @param messagePrefix - prefix prepended to the extracted error message
 * @returns the formatted message and 1-based line / 0-based column of the first error
 */
export function extractExecutionError(
  errors: unknown[],
  code: string,
  messagePrefix: string,
): { message: string; startColumn: number; startLineNumber: number } {
  const firstError = errors[0];
  let errorMessage = messagePrefix;
  let startColumn = 0;
  let startLineNumber = 0;

  // Check if the error has the nested structure with source ranges
  const wasmError = extractWasmKclError(firstError);
  if (wasmError) {
    const { details } = wasmError;
    errorMessage = `${messagePrefix}: ${details.msg}`;

    // Extract source range if available
    if (details.sourceRanges.length > 0) {
      const sourceRange = details.sourceRanges[0]!;
      const position = sourceRangeToLineColumn(sourceRange, code);
      startColumn = position.column;
      startLineNumber = position.line;
    }
  } else {
    // Fallback to original error message extraction
    const errorMessages = errors.map((error) => {
      if (typeof error === 'string') {
        return error;
      }

      const errorObject = error as { message?: string; msg?: string };
      return errorObject.message ?? errorObject.msg ?? JSON.stringify(error);
    });
    errorMessage = `${messagePrefix}: ${errorMessages.join(', ')}`;
  }

  return { message: errorMessage, startColumn, startLineNumber };
}

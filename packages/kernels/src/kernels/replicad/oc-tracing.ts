/**
 * OpenCASCADE API Call Tracing & Exception Capture
 *
 * Instruments OC instance method/constructor calls via a recursive JavaScript Proxy.
 * Two modes:
 * - summary: accumulates per-class call counts and durations, emits a single
 *   `oc.summary` span at flush time. Low overhead (~2-5%).
 * - per-call: creates individual `oc.{ClassName}` spans for every call via
 *   the tracer. Higher overhead (~10-20%), used for deep profiling.
 *
 * Also catches WebAssembly.Exception at the proxy boundary, converting it to a
 * standard Error with the decoded OC message and the JS stack trace from the
 * call site (which includes user code frames).
 */

import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import type { KernelSpanTracer } from '#types/kernel-tracer.types.js';
import { formatOcExceptionMessage } from '#kernels/replicad/oc-exceptions.js';

/**
 * Error subclass thrown when a WebAssembly.Exception from OC is caught at the
 * tracing proxy boundary. Preserves the decoded OC message and the JS call
 * stack from the user code call site.
 */
export class OcKernelError extends Error {
  public override readonly name = 'OcKernelError';
  public readonly typeName: string;
  public readonly rawMessage: string;

  public constructor(typeName: string, rawMessage: string) {
    const formatted = formatOcExceptionMessage(typeName, rawMessage);
    super(formatted);
    this.typeName = typeName;
    this.rawMessage = rawMessage;
  }
}

/**
 * Configuration for OC API call tracing.
 */
export type OcTracingConfig = {
  mode: 'summary' | 'per-call';
};

/**
 * Accumulated statistics for a single OC class in summary mode.
 */
type ClassStats = {
  calls: number;
  totalMs: number;
};

/**
 * Handle for flushing accumulated summary data as a span.
 */
export type OcTracingSummary = {
  /** Emit a single `oc.summary` span with aggregated per-class statistics. */
  flush(): void;
};

/**
 * Result of wrapping an OC instance with tracing.
 */
export type OcTracingResult = {
  tracedInstance: OpenCascadeInstance;
  summary: OcTracingSummary;
};

/**
 * Wrap an OpenCASCADE instance with tracing instrumentation.
 *
 * The proxy intercepts property access to resolve class names, then wraps
 * function calls (constructors and methods) with timing instrumentation.
 *
 * @param oc - The OC instance (raw or already exception-wrapped)
 * @param tracer - KernelSpanTracer for creating spans
 * @param config - Tracing configuration (mode selection)
 * @returns The traced instance and a summary handle for flushing
 */
export function wrapOcWithTracing(
  oc: OpenCascadeInstance,
  tracer: KernelSpanTracer,
  config: OcTracingConfig,
): OcTracingResult {
  const stats = new Map<string, ClassStats>();

  type ExceptionDecoder = (ex: WebAssembly.Exception) => [string, string];
  const getExceptionMessage = (oc as unknown as Record<string, unknown>)['getExceptionMessage'] as
    | ExceptionDecoder
    | undefined;

  /**
   * If the error is a WebAssembly.Exception, decode it and rethrow as an
   * OcKernelError (Error subclass) so the JS stack trace is captured at
   * the proxy call site — which includes user code frames.
   */
  function rethrowIfWasmException(error: unknown): never {
    if (
      typeof getExceptionMessage === 'function' &&
      typeof WebAssembly !== 'undefined' &&
      typeof WebAssembly.Exception === 'function' &&
      error instanceof WebAssembly.Exception
    ) {
      try {
        const [typeName, rawMessage] = getExceptionMessage(error);
        throw new OcKernelError(typeName, rawMessage);
      } catch (decodeError: unknown) {
        if (decodeError instanceof OcKernelError) {
          throw decodeError;
        }
      }
    }

    throw error;
  }

  function recordSummaryCall(className: string, durationMs: number): void {
    const existing = stats.get(className);
    if (existing) {
      existing.calls++;
      existing.totalMs += durationMs;
    } else {
      stats.set(className, { calls: 1, totalMs: durationMs });
    }
  }

  function wrapFunctionForSummary(
    fn: (...args: unknown[]) => unknown,
    className: string,
  ): (...args: unknown[]) => unknown {
    return new Proxy(fn, {
      construct(target, args, newTarget) {
        const start = performance.now();
        try {
          const result: unknown = Reflect.construct(target, args, newTarget);
          recordSummaryCall(className, performance.now() - start);
          return result as Record<string, unknown>;
        } catch (error: unknown) {
          recordSummaryCall(className, performance.now() - start);
          rethrowIfWasmException(error);
        }
      },
      apply(target, thisArg, args) {
        const start = performance.now();
        try {
          const result: unknown = Reflect.apply(target, thisArg, args);
          recordSummaryCall(className, performance.now() - start);
          return result;
        } catch (error: unknown) {
          recordSummaryCall(className, performance.now() - start);
          rethrowIfWasmException(error);
        }
      },
    });
  }

  function wrapFunctionForPerCall(
    fn: (...args: unknown[]) => unknown,
    className: string,
  ): (...args: unknown[]) => unknown {
    return new Proxy(fn, {
      construct(target, args, newTarget) {
        const span = tracer.startSpan(`oc.${className}`, { method: 'constructor' });
        try {
          return Reflect.construct(target, args, newTarget) as Record<string, unknown>;
        } catch (error: unknown) {
          rethrowIfWasmException(error);
        } finally {
          span.end();
        }
      },
      apply(target, thisArg, args) {
        const span = tracer.startSpan(`oc.${className}`, { method: 'apply' });
        try {
          return Reflect.apply(target, thisArg, args);
        } catch (error: unknown) {
          rethrowIfWasmException(error);
        } finally {
          span.end();
        }
      },
    });
  }

  const wrapFunction = config.mode === 'summary' ? wrapFunctionForSummary : wrapFunctionForPerCall;

  const classProxyCache = new Map<string, unknown>();

  const tracedInstance: OpenCascadeInstance = new Proxy(oc, {
    get(target, property, receiver): unknown {
      if (typeof property === 'symbol') {
        return Reflect.get(target, property, receiver);
      }

      const cached = classProxyCache.get(property);
      if (cached !== undefined) {
        return cached;
      }

      const value: unknown = Reflect.get(target, property, receiver);

      if (typeof value === 'function') {
        const wrapped = wrapFunction(value as (...args: unknown[]) => unknown, property);
        classProxyCache.set(property, wrapped);
        return wrapped;
      }

      return value;
    },
  });

  const summary: OcTracingSummary = {
    flush() {
      if (stats.size === 0) {
        return;
      }

      const attributes: Record<string, string | number | boolean> = {};
      let totalCalls = 0;
      let totalMs = 0;

      for (const [className, classStats] of stats) {
        attributes[`${className}.calls`] = classStats.calls;
        attributes[`${className}.ms`] = Math.round(classStats.totalMs * 100) / 100;
        totalCalls += classStats.calls;
        totalMs += classStats.totalMs;
      }

      attributes['total.calls'] = totalCalls;
      attributes['total.ms'] = Math.round(totalMs * 100) / 100;
      attributes['classes'] = stats.size;

      const span = tracer.startSpan('oc.summary', attributes);
      span.end();

      stats.clear();
    },
  };

  return { tracedInstance, summary };
}

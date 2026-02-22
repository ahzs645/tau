/**
 * Kernel Tracer Types
 *
 * Lightweight tracing interface for kernel modules and middleware.
 * Creates hierarchical spans without requiring an OpenTelemetry SDK dependency.
 * Spans are collected by the framework and displayed in the Kernel Panel.
 */

/**
 * Handle returned by `KernelSpanTracer.startSpan()`.
 * Call `end()` when the traced operation completes.
 */
export type SpanHandle = {
  end(): void;
};

/**
 * Lightweight tracing interface exposed to kernel modules and middleware.
 * Creates hierarchical spans without requiring an OpenTelemetry SDK dependency.
 * Spans are collected by the framework and displayed in the Kernel Panel.
 */
export type KernelSpanTracer = {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): SpanHandle;
};

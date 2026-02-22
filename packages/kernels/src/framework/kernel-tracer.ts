import type { SpanHandle, KernelSpanTracer } from '@taucad/types';

type SpanAttributes = Record<string, string | number | boolean>;

/**
 * Lightweight span tracker for the kernel worker.
 *
 * Follows the OpenTelemetry span model (parent-child via explicit IDs)
 * without any SDK dependency. Emits `performance.measure()` calls enriched
 * with `spanId`/`parentSpanId` for hierarchy reconstruction and Chrome
 * DevTools Performance Extensibility API metadata for custom track display.
 *
 * All heavy lifting happens here on the worker side — the client simply
 * reads `detail.spanId` / `detail.parentSpanId` to build a tree.
 */
export class KernelTracer implements KernelSpanTracer {
  private nextId = 0;
  private activeSpanId: string | undefined;

  public startSpan(name: string, attributes?: SpanAttributes): SpanHandle {
    const id = String(this.nextId++);
    const parentId = this.activeSpanId;
    const markName = `tau:span:${id}`;
    performance.mark(markName);
    this.activeSpanId = id;

    return {
      end: () => {
        const detail: Record<string, unknown> = {
          spanId: id,
          parentSpanId: parentId,
          ...attributes,
          devtools: {
            dataType: 'track-entry' as const,
            track: 'Kernel Pipeline',
            trackGroup: 'Tau',
            properties: Object.entries(attributes ?? {}).map(([k, v]) => [k, String(v)]),
          },
        };

        performance.measure(name, { start: markName, detail });
        this.activeSpanId = parentId;
      },
    };
  }

  public reset(): void {
    this.nextId = 0;
    this.activeSpanId = undefined;
    performance.clearMarks();
    performance.clearMeasures();
  }
}

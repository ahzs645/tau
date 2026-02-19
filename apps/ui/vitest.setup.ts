/* eslint-disable @typescript-eslint/naming-convention -- CONSTANT_CASE is expected for environment variables */
// eslint-disable-next-line import-x/no-unassigned-import -- this is a side effect
import '@testing-library/jest-dom';

// Mock window.ENV for testing - required since the app uses window.ENV in browser environments
Object.defineProperty(globalThis, 'ENV', {
  writable: true,
  value: {
    TAU_API_URL: 'http://localhost:4000',
    TAU_FRONTEND_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  },
});

// Mock common browser APIs for testing
Object.defineProperty(globalThis, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {
      // No-op
    },
    removeListener() {
      // No-op
    },
    addEventListener() {
      // No-op
    },
    removeEventListener() {
      // No-op
    },
    dispatchEvent() {
      // No-op
    },
  }),
});

// Mock IntersectionObserver
globalThis.IntersectionObserver = class IntersectionObserver {
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/IntersectionObserver/root) */

  public get root() {
    return null;
  }

  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/IntersectionObserver/rootMargin) */
  public get rootMargin() {
    return '0px';
  }

  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/IntersectionObserver/thresholds) */
  public readonly thresholds: readonly number[] = [0];

  public observe() {
    // No-op
  }

  public unobserve() {
    // No-op
  }

  public disconnect() {
    // No-op
  }

  public takeRecords() {
    return [];
  }
};

// Mock ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
  public observe() {
    // No-op
  }

  public unobserve() {
    // No-op
  }

  public disconnect() {
    // No-op
  }
};

// Polyfill User Timing API Level 3 for jsdom.
// jsdom's performance.measure() doesn't support the options-object form
// (PerformanceMeasureOptions with { start, detail }), which causes
// "Invalid target origin '[object Object]'" errors. Replace with no-op stubs
// that return minimal PerformanceEntry-shaped objects.
const stubEntry = { name: '', startTime: 0, duration: 0, entryType: '', detail: undefined, toJSON: () => ({}) };
globalThis.performance.mark = (() => stubEntry) as typeof globalThis.performance.mark;
globalThis.performance.measure = (() => stubEntry) as typeof globalThis.performance.measure;

// PerformanceObserver is not available in jsdom -- stub it for telemetry code
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- jsdom doesn't provide PerformanceObserver despite type declarations
globalThis.PerformanceObserver ??= class PerformanceObserver {
  public observe() {
    // No-op
  }

  public disconnect() {
    // No-op
  }

  public takeRecords() {
    return [];
  }
} as unknown as typeof globalThis.PerformanceObserver;

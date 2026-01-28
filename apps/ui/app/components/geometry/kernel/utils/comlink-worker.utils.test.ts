// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Store original globalThis.self
const originalSelf = globalThis.self;

describe('comlink-worker.utils', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original self
    globalThis.self = originalSelf;
    vi.unstubAllGlobals();
  });

  describe('isWorkerContext', () => {
    it('should return false when not in any worker context', async () => {
      // In Node.js test environment without parentPort
      // @ts-expect-error -- Test utility to simulate non-worker context
      globalThis.self = undefined;

      const { isWorkerContext } = await import('./comlink-worker.utils.js');
      expect(isWorkerContext()).toBe(false);
    });

    it('should return true when in browser worker context', async () => {
      // Mock browser worker self
      // @ts-expect-error -- Test utility to mock browser worker self
      globalThis.self = {
        addEventListener: vi.fn(),
        postMessage: vi.fn(),
        removeEventListener: vi.fn(),
      };

      vi.resetModules();
      const { isWorkerContext } = await import('./comlink-worker.utils.js');
      expect(isWorkerContext()).toBe(true);
    });
  });

  describe('getWorkerEndpoint', () => {
    it('should throw error when not in any worker context', async () => {
      // @ts-expect-error -- Test utility to simulate non-worker context
      globalThis.self = undefined;

      const { getWorkerEndpoint } = await import('./comlink-worker.utils.js');
      expect(() => getWorkerEndpoint()).toThrow('getWorkerEndpoint() must be called from a worker context');
    });

    it('should return self when in browser worker context', async () => {
      const mockSelf = {
        addEventListener: vi.fn(),
        postMessage: vi.fn(),
        removeEventListener: vi.fn(),
      };
      // @ts-expect-error -- Test utility to mock browser worker self
      globalThis.self = mockSelf;

      vi.resetModules();
      const { getWorkerEndpoint } = await import('./comlink-worker.utils.js');
      const endpoint = getWorkerEndpoint();

      // Should return self as the endpoint
      expect(endpoint).toBe(mockSelf);
    });
  });

  describe('exposeWorker', () => {
    it('should return false and not expose when not in worker context', async () => {
      // @ts-expect-error -- Test utility to simulate non-worker context
      globalThis.self = undefined;

      const { exposeWorker } = await import('./comlink-worker.utils.js');
      const service = { doWork: () => 42 };

      const result = exposeWorker(service);
      expect(result).toBe(false);
    });

    it('should return true and expose when in browser worker context', async () => {
      const mockSelf = {
        addEventListener: vi.fn(),
        postMessage: vi.fn(),
        removeEventListener: vi.fn(),
      };
      // @ts-expect-error -- Test utility to mock browser worker self
      globalThis.self = mockSelf;

      vi.resetModules();
      const { exposeWorker } = await import('./comlink-worker.utils.js');
      const service = { doWork: () => 42 };

      const result = exposeWorker(service);
      expect(result).toBe(true);

      // Verify comlink's expose was called (addEventListener is called by comlink)
      expect(mockSelf.addEventListener).toHaveBeenCalled();
    });
  });
});

/**
 * Tests for Node.js worker_threads context.
 * These require mocking the worker_threads module which is complex due to dynamic require().
 * The core functionality is tested above - the Node.js worker detection is covered
 * by the production code path and integration tests.
 *
 * Key behaviors verified:
 * - Browser worker context detection works correctly
 * - Non-worker context returns false/throws appropriately
 * - exposeWorker guards the expose() call correctly
 */

/**
 * Integration tests for kernel-worker middleware execution.
 *
 * Tests the onion chain execution model using MockKernelWorker which uses
 * the real chain-building logic from KernelWorker to verify:
 * 1. Middleware executes in correct order
 * 2. Short-circuiting works correctly
 * 3. Short-circuited results still flow through upstream middleware
 * 4. State is maintained across the wrap hook execution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { ComputeGeometryResult, GeometryGltf } from '@taucad/types';
import { createKernelMiddleware } from '#components/geometry/kernel/utils/kernel-middleware.js';
import { MockKernelWorker } from '#components/geometry/kernel/utils/kernel-testing.utils.js';
import type { OnWorkerLog } from '#types/console.types.js';

describe('kernel-worker middleware onion chain', () => {
  const mockGltfContent = new Uint8Array([1, 2, 3, 4]);
  const successResult: ComputeGeometryResult = {
    success: true,
    data: [{ format: 'gltf', content: mockGltfContent }],
    issues: [],
  };

  let onLog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onLog = vi.fn();
  });

  /**
   * Helper to create a tracking middleware that records execution order.
   */
  function createTrackingMiddleware(name: string, executionOrder: string[]) {
    return createKernelMiddleware({
      name,
      async wrapComputeGeometry(request, handler) {
        executionOrder.push(`${name}-before`);
        const result = await handler(request);
        executionOrder.push(`${name}-after`);
        return result;
      },
    });
  }

  describe('execution order', () => {
    it('should execute middleware in onion order (first outer, last inner)', async () => {
      const executionOrder: string[] = [];

      const middleware1 = createTrackingMiddleware('M1', executionOrder);
      const middleware2 = createTrackingMiddleware('M2', executionOrder);
      const middleware3 = createTrackingMiddleware('M3', executionOrder);

      // Create worker with tracking middleware
      const worker = new MockKernelWorker({
        middleware: [middleware1, middleware2, middleware3],
        computeResult: successResult,
        onLog: onLog as OnWorkerLog,
      });

      // Spy on the internal computeGeometry to track when main is called
      const computeGeometrySpy = vi.spyOn(worker as never, 'computeGeometry').mockImplementation(async () => {
        executionOrder.push('main');
        return successResult;
      });

      await worker.runComputeGeometry();

      // Onion model: M1 wraps M2 wraps M3 wraps main
      // Before: outside-in (M1 -> M2 -> M3 -> main)
      // After: inside-out (M3 -> M2 -> M1)
      expect(executionOrder).toEqual([
        'M1-before',
        'M2-before',
        'M3-before',
        'main',
        'M3-after',
        'M2-after',
        'M1-after',
      ]);

      computeGeometrySpy.mockRestore();
    });

    it('should skip middleware without wrap hooks', async () => {
      const executionOrder: string[] = [];

      const middleware1 = createTrackingMiddleware('M1', executionOrder);

      // Middleware without wrap hook
      const middleware2 = createKernelMiddleware({
        name: 'NoHookMiddleware',
      });

      const middleware3 = createTrackingMiddleware('M3', executionOrder);

      const worker = new MockKernelWorker({
        middleware: [middleware1, middleware2, middleware3],
        computeResult: successResult,
        onLog: onLog as OnWorkerLog,
      });

      const computeGeometrySpy = vi.spyOn(worker as never, 'computeGeometry').mockImplementation(async () => {
        executionOrder.push('main');
        return successResult;
      });

      await worker.runComputeGeometry();

      // NoHookMiddleware is skipped
      expect(executionOrder).toEqual(['M1-before', 'M3-before', 'main', 'M3-after', 'M1-after']);

      computeGeometrySpy.mockRestore();
    });
  });

  describe('short-circuiting', () => {
    it('should allow middleware to short-circuit by not calling handler', async () => {
      const cachedResult: ComputeGeometryResult = {
        success: true,
        data: [{ format: 'gltf', content: new Uint8Array([9, 9, 9]) }],
        issues: [],
      };

      const executionOrder: string[] = [];

      // Cache middleware that short-circuits
      const cacheMiddleware = createKernelMiddleware({
        name: 'CacheMiddleware',
        async wrapComputeGeometry(_request, _handler) {
          executionOrder.push('cache-check');
          // Short-circuit - don't call handler
          return cachedResult;
        },
      });

      const worker = new MockKernelWorker({
        middleware: [cacheMiddleware],
        computeResult: successResult,
        onLog: onLog as OnWorkerLog,
      });

      const computeGeometrySpy = vi.spyOn(worker as never, 'computeGeometry').mockImplementation(async () => {
        executionOrder.push('main');
        return successResult;
      });

      const result = await worker.runComputeGeometry();

      expect(executionOrder).toEqual(['cache-check']);
      expect(computeGeometrySpy).not.toHaveBeenCalled();
      // Result contains geometry with hash added by kernel-worker
      expect(result.success).toBe(true);
      if (result.success) {
        const geometry = result.data[0];
        const cachedGeometry = cachedResult.data[0];

        if (geometry?.format === 'gltf' && cachedGeometry?.format === 'gltf') {
          expect(geometry.content).toEqual(cachedGeometry.content);
        }
      }

      computeGeometrySpy.mockRestore();
    });

    it('should allow upstream middleware to process short-circuited results', async () => {
      const cachedResult: ComputeGeometryResult = {
        success: true,
        data: [{ format: 'gltf', content: new Uint8Array([5, 6, 7]) }],
        issues: [],
      };

      const transformedContent = new Uint8Array([100, 100, 100]);
      const executionOrder: string[] = [];

      // Outer middleware (transform) - wraps everything
      const transformMiddleware = createKernelMiddleware({
        name: 'TransformMiddleware',
        async wrapComputeGeometry(request, handler) {
          executionOrder.push('transform-before');
          const result = await handler(request);
          executionOrder.push('transform-after');

          // Transform the result regardless of source
          if (result.success) {
            return {
              ...result,
              data: result.data.map(
                (_g): GeometryGltf => ({
                  format: 'gltf',
                  content: transformedContent,
                }),
              ),
            };
          }

          return result;
        },
      });

      // Inner middleware (cache) - short-circuits
      const cacheMiddleware = createKernelMiddleware({
        name: 'CacheMiddleware',
        async wrapComputeGeometry(_request, _handler) {
          executionOrder.push('cache-hit');
          // Short-circuit with cached result
          return cachedResult;
        },
      });

      // Order: [transform, cache] - transform is outermost
      const worker = new MockKernelWorker({
        middleware: [transformMiddleware, cacheMiddleware],
        computeResult: successResult,
        onLog: onLog as OnWorkerLog,
      });

      const computeGeometrySpy = vi.spyOn(worker as never, 'computeGeometry').mockImplementation(async () => {
        executionOrder.push('main');
        return successResult;
      });

      const result = await worker.runComputeGeometry();

      // Cache short-circuits, but transform still runs on return journey
      expect(executionOrder).toEqual(['transform-before', 'cache-hit', 'transform-after']);
      expect(computeGeometrySpy).not.toHaveBeenCalled();

      // Result should be transformed
      expect(result.success).toBe(true);

      if (result.success) {
        const geometry = result.data[0];

        expect(geometry?.format).toBe('gltf');

        if (geometry?.format === 'gltf') {
          expect(geometry.content).toBe(transformedContent);
        }
      }

      computeGeometrySpy.mockRestore();
    });
  });

  describe('state management', () => {
    it('should maintain state across wrap hook execution', async () => {
      const stateSchema = z.object({
        beforeValue: z.string(),
        afterValue: z.string(),
      });

      type TestState = z.infer<typeof stateSchema>;

      let capturedState: Partial<TestState> = {};

      const statefulMiddleware = createKernelMiddleware({
        name: 'StatefulMiddleware',
        stateSchema,
        async wrapComputeGeometry(request, handler) {
          // Update state before handler
          request.runtime.state.update({ beforeValue: 'set-before' });

          const result = await handler(request);

          // Update state after handler
          request.runtime.state.update({ afterValue: 'set-after' });

          // Capture final state for verification
          capturedState = {
            beforeValue: request.runtime.state.value.beforeValue,
            afterValue: request.runtime.state.value.afterValue,
          };

          return result;
        },
      });

      const worker = new MockKernelWorker({
        middleware: [statefulMiddleware],
        computeResult: successResult,
        onLog: onLog as OnWorkerLog,
      });

      await worker.runComputeGeometry();

      expect(capturedState.beforeValue).toBe('set-before');
      expect(capturedState.afterValue).toBe('set-after');
    });

    it('should provide separate state instances for each middleware', async () => {
      const stateSchema = z.object({
        value: z.string(),
      });

      const capturedStates: Record<string, string | undefined> = {};

      const middleware1 = createKernelMiddleware({
        name: 'Middleware1',
        stateSchema,
        async wrapComputeGeometry(request, handler) {
          request.runtime.state.update({ value: 'M1-value' });
          const result = await handler(request);
          capturedStates['m1'] = request.runtime.state.value.value;
          return result;
        },
      });

      const middleware2 = createKernelMiddleware({
        name: 'Middleware2',
        stateSchema,
        async wrapComputeGeometry(request, handler) {
          request.runtime.state.update({ value: 'M2-value' });
          const result = await handler(request);
          capturedStates['m2'] = request.runtime.state.value.value;
          return result;
        },
      });

      const worker = new MockKernelWorker({
        middleware: [middleware1, middleware2],
        computeResult: successResult,
        onLog: onLog as OnWorkerLog,
      });

      await worker.runComputeGeometry();

      // Each middleware has its own state
      expect(capturedStates['m1']).toBe('M1-value');
      expect(capturedStates['m2']).toBe('M2-value');
    });
  });

  describe('result transformation', () => {
    it('should allow multiple middleware to transform results', async () => {
      const middleware1 = createKernelMiddleware({
        name: 'AddSuffix1',
        async wrapComputeGeometry(request, handler) {
          const result = await handler(request);

          if (result.success) {
            // Add a suffix to the issues
            return {
              ...result,
              issues: [...result.issues, { message: 'M1-processed', severity: 'info' as const }],
            };
          }

          return result;
        },
      });

      const middleware2 = createKernelMiddleware({
        name: 'AddSuffix2',
        async wrapComputeGeometry(request, handler) {
          const result = await handler(request);

          if (result.success) {
            return {
              ...result,
              issues: [...result.issues, { message: 'M2-processed', severity: 'info' as const }],
            };
          }

          return result;
        },
      });

      const mainResult: ComputeGeometryResult = {
        success: true,
        data: [],
        issues: [{ message: 'main-issue', severity: 'warning' as const }],
      };

      const worker = new MockKernelWorker({
        middleware: [middleware1, middleware2],
        computeResult: mainResult,
        onLog: onLog as OnWorkerLog,
      });

      const result = await worker.runComputeGeometry();

      expect(result.success).toBe(true);

      // Issues should be accumulated in reverse order (innermost to outermost)
      // M2 runs after main, M1 runs after M2
      expect(result.issues).toHaveLength(3);
      expect(result.issues[0]?.message).toBe('main-issue');
      expect(result.issues[1]?.message).toBe('M2-processed');
      expect(result.issues[2]?.message).toBe('M1-processed');
    });
  });

  describe('error handling', () => {
    it('should propagate errors from main operation', async () => {
      const middleware = createKernelMiddleware({
        name: 'PassthroughMiddleware',
        async wrapComputeGeometry(request, handler) {
          return handler(request);
        },
      });

      const worker = new MockKernelWorker({
        middleware: [middleware],
        computeResult: successResult,
        onLog: onLog as OnWorkerLog,
      });

      vi.spyOn(worker as never, 'computeGeometry').mockRejectedValue(new Error('Main operation failed'));

      await expect(worker.runComputeGeometry()).rejects.toThrow('Main operation failed');
    });

    it('should propagate errors from middleware', async () => {
      const middleware = createKernelMiddleware({
        name: 'ErrorMiddleware',
        async wrapComputeGeometry(_request, _handler) {
          throw new Error('Middleware error');
        },
      });

      const worker = new MockKernelWorker({
        middleware: [middleware],
        computeResult: successResult,
        onLog: onLog as OnWorkerLog,
      });

      await expect(worker.runComputeGeometry()).rejects.toThrow('Middleware error');
    });
  });
});

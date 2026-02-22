/**
 * Unit tests for kernel middleware factory and helpers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Dependency, OnWorkerLog } from '@taucad/types';
import {
  createKernelMiddleware,
  createMiddlewareLogger,
  createMiddlewareState,
  createMiddlewareRuntime,
} from '#middleware/kernel-middleware.js';
import { createMockFilesystem } from '#testing/kernel-testing.utils.js';

// Mock dependencies for testing
const mockDependencies: readonly Dependency[] = [
  { type: 'file', path: 'test.kcl', contentHash: 'abc123' },
  { type: 'middleware', name: 'TestMiddleware', version: '1', index: 0, config: {} },
  { type: 'framework', name: 'tau', version: '0.0.1' },
];

describe('createKernelMiddleware', () => {
  it('should create a middleware with the provided name', () => {
    const middleware = createKernelMiddleware({
      name: 'TestMiddleware',
    });

    expect(middleware.name).toBe('TestMiddleware');
  });

  it('should create a middleware with wrap hooks', () => {
    const wrapCreateGeometry = vi.fn();
    const wrapExportGeometry = vi.fn();
    const wrapGetParameters = vi.fn();

    const middleware = createKernelMiddleware({
      name: 'TestMiddleware',
      wrapCreateGeometry,
      wrapExportGeometry,
      wrapGetParameters,
    });

    expect(middleware.wrapCreateGeometry).toBe(wrapCreateGeometry);
    expect(middleware.wrapExportGeometry).toBe(wrapExportGeometry);
    expect(middleware.wrapGetParameters).toBe(wrapGetParameters);
  });

  it('should create a middleware with a state schema', () => {
    const stateSchema = z.object({
      count: z.number(),
      message: z.string(),
    });

    const middleware = createKernelMiddleware({
      name: 'TestMiddleware',
      stateSchema,
    });

    expect(middleware.stateSchema).toBe(stateSchema);
  });

  it('should allow middleware without a state schema', () => {
    const middleware = createKernelMiddleware({
      name: 'NoStateMiddleware',
    });

    expect(middleware.stateSchema).toBeUndefined();
  });
});

describe('createMiddlewareLogger', () => {
  let onLog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onLog = vi.fn();
  });

  it('should create a logger that injects middleware name as component', () => {
    const logger = createMiddlewareLogger(onLog as OnWorkerLog, 'TestMiddleware');

    logger.log('Test message');

    expect(onLog).toHaveBeenCalledWith({
      level: 'info',
      message: 'Test message',
      origin: { component: 'TestMiddleware' },
      data: undefined,
    });
  });

  it('should log at debug level', () => {
    const logger = createMiddlewareLogger(onLog as OnWorkerLog, 'TestMiddleware');

    logger.debug('Debug message');

    expect(onLog).toHaveBeenCalledWith({
      level: 'debug',
      message: 'Debug message',
      origin: { component: 'TestMiddleware' },
      data: undefined,
    });
  });

  it('should log at trace level', () => {
    const logger = createMiddlewareLogger(onLog as OnWorkerLog, 'TestMiddleware');

    logger.trace('Trace message');

    expect(onLog).toHaveBeenCalledWith({
      level: 'trace',
      message: 'Trace message',
      origin: { component: 'TestMiddleware' },
      data: undefined,
    });
  });

  it('should log at warn level', () => {
    const logger = createMiddlewareLogger(onLog as OnWorkerLog, 'TestMiddleware');

    logger.warn('Warning message');

    expect(onLog).toHaveBeenCalledWith({
      level: 'warn',
      message: 'Warning message',
      origin: { component: 'TestMiddleware' },
      data: undefined,
    });
  });

  it('should log at error level', () => {
    const logger = createMiddlewareLogger(onLog as OnWorkerLog, 'TestMiddleware');

    logger.error('Error message');

    expect(onLog).toHaveBeenCalledWith({
      level: 'error',
      message: 'Error message',
      origin: { component: 'TestMiddleware' },
      data: undefined,
    });
  });

  it('should include additional data when provided', () => {
    const logger = createMiddlewareLogger(onLog as OnWorkerLog, 'TestMiddleware');

    logger.log('Message with data', { data: { key: 'value' } });

    expect(onLog).toHaveBeenCalledWith({
      level: 'info',
      message: 'Message with data',
      origin: { component: 'TestMiddleware' },
      data: { key: 'value' },
    });
  });
});

describe('createMiddlewareState', () => {
  it('should create a state with empty initial value', () => {
    const state = createMiddlewareState();

    expect(state.value).toEqual({});
  });

  it('should update state with partial data', () => {
    type TestState = { count: number; message: string };
    const state = createMiddlewareState<TestState>();

    state.update({ count: 5 });

    expect(state.value.count).toBe(5);
    expect(state.value.message).toBeUndefined();
  });

  it('should merge multiple updates', () => {
    type TestState = { count: number; message: string };
    const state = createMiddlewareState<TestState>();

    state.update({ count: 5 });
    state.update({ message: 'hello' });

    expect(state.value.count).toBe(5);
    expect(state.value.message).toBe('hello');
  });

  it('should overwrite existing values on update', () => {
    type TestState = { count: number };
    const state = createMiddlewareState<TestState>();

    state.update({ count: 5 });
    state.update({ count: 10 });

    expect(state.value.count).toBe(10);
  });

  it('should validate updates against schema if provided', () => {
    const schema = z.object({
      count: z.number(),
    });

    const state = createMiddlewareState<z.infer<typeof schema>>(schema);

    // Valid update should succeed
    expect(() => {
      state.update({ count: 5 });
    }).not.toThrow();
    expect(state.value.count).toBe(5);
  });

  it('should throw on invalid update when schema is provided', () => {
    const schema = z.object({
      count: z.number(),
    });

    const state = createMiddlewareState<z.infer<typeof schema>>(schema);

    // Invalid update should throw
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Testing invalid input
      const invalidValue: number = 'not a number' as any;
      state.update({ count: invalidValue });
    }).toThrow();
  });

  it('should handle nested objects with deepmerge', () => {
    type TestState = { nested: { a: number; b: number } };
    const state = createMiddlewareState<TestState>();

    state.update({ nested: { a: 1, b: 2 } });
    state.update({ nested: { a: 10, b: 2 } });

    expect(state.value.nested?.a).toBe(10);
    expect(state.value.nested?.b).toBe(2);
  });
});

describe('createMiddlewareRuntime', () => {
  const mockDependencyHash = 'a'.repeat(64);

  it('should create a runtime with logger, filesystem, state, dependencies, and hash', () => {
    const onLog = vi.fn();
    const filesystem = createMockFilesystem();

    const runtime = createMiddlewareRuntime({
      onLog: onLog as OnWorkerLog,
      middlewareName: 'TestMiddleware',
      filesystem,
      dependencies: mockDependencies,
      dependencyHash: mockDependencyHash,
    });

    expect(runtime.logger).toBeDefined();
    expect(runtime.filesystem).toBe(filesystem);
    expect(runtime.state).toBeDefined();
    expect(runtime.state.value).toEqual({});
    expect(runtime.dependencies).toBe(mockDependencies);
    expect(runtime.dependencyHash).toBe(mockDependencyHash);
  });

  it('should create a runtime with state schema validation', () => {
    const onLog = vi.fn();
    const filesystem = createMockFilesystem();
    const stateSchema = z.object({
      count: z.number(),
    });

    const runtime = createMiddlewareRuntime<z.infer<typeof stateSchema>>({
      onLog: onLog as OnWorkerLog,
      middlewareName: 'TestMiddleware',
      filesystem,
      dependencies: mockDependencies,
      dependencyHash: mockDependencyHash,
      stateSchema,
    });

    // Valid update should work
    expect(() => {
      runtime.state.update({ count: 5 });
    }).not.toThrow();
    expect(runtime.state.value.count).toBe(5);
  });

  it('should configure logger with middleware name', () => {
    const onLog = vi.fn();
    const filesystem = createMockFilesystem();

    const runtime = createMiddlewareRuntime({
      onLog: onLog as OnWorkerLog,
      middlewareName: 'MyMiddleware',
      filesystem,
      dependencies: mockDependencies,
      dependencyHash: mockDependencyHash,
    });

    runtime.logger.debug('Test');

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { component: 'MyMiddleware' },
      }),
    );
  });
});

describe('wrap hook behavior', () => {
  it('should allow wrap hooks to call handler and transform result', async () => {
    const middleware = createKernelMiddleware({
      name: 'TransformMiddleware',
      async wrapCreateGeometry(input, handler, _runtime) {
        const result = await handler(input);

        // Transform the result
        if (result.success) {
          return {
            ...result,
            data: result.data.map((g) => ({ ...g, transformed: true })),
          };
        }

        return result;
      },
    });

    const mockHandler = vi.fn().mockResolvedValue({
      success: true,
      data: [{ format: 'gltf', hash: 'a'.repeat(64), content: new Uint8Array() }],
      issues: [],
    });

    const runtime = createMiddlewareRuntime({
      onLog: vi.fn() as OnWorkerLog,
      middlewareName: 'Test',
      filesystem: createMockFilesystem(),
      dependencies: mockDependencies,
      dependencyHash: 'a'.repeat(64),
    });

    const result = await middleware.wrapCreateGeometry!(
      { filePath: '/builds/test/test.kcl', basePath: '/builds/test', parameters: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Mock handler for testing
      mockHandler as any,
      runtime,
    );

    expect(mockHandler).toHaveBeenCalled();
    expect(result.success).toBe(true);

    if (result.success) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Testing dynamic property
      expect((result.data[0] as any).transformed).toBe(true);
    }
  });

  it('should allow wrap hooks to short-circuit by not calling handler', async () => {
    const cachedResult = {
      success: true as const,
      data: [{ format: 'gltf' as const, hash: 'a'.repeat(64), content: new Uint8Array([1, 2, 3]) }],
      issues: [],
    };

    const middleware = createKernelMiddleware({
      name: 'CacheMiddleware',
      // Intentionally not calling handler to test short-circuit
      async wrapCreateGeometry(_input, _handler, _runtime) {
        // Short-circuit - don't call handler
        return cachedResult;
      },
    });

    const mockHandler = vi.fn();

    const input = { filePath: '/builds/test/test.kcl', basePath: '/builds/test', parameters: {} };
    const runtime = createMiddlewareRuntime({
      onLog: vi.fn() as OnWorkerLog,
      middlewareName: 'Test',
      filesystem: createMockFilesystem(),
      dependencies: mockDependencies,
      dependencyHash: 'a'.repeat(64),
    });

    const result = await middleware.wrapCreateGeometry!(
      input,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Mock handler for testing
      mockHandler as any,
      runtime,
    );

    // Handler should not have been called
    expect(mockHandler).not.toHaveBeenCalled();
    expect(result).toBe(cachedResult);
  });

  it('should allow wrap hooks to access and update state', async () => {
    const stateSchema = z.object({
      callCount: z.number(),
    });

    type TestState = z.infer<typeof stateSchema>;

    const middleware = createKernelMiddleware({
      name: 'StatefulMiddleware',
      stateSchema,
      async wrapCreateGeometry(input, handler, { state }) {
        // Update state before calling handler
        state.update({ callCount: 1 });

        const result = await handler(input);

        // Read state after handler
        const count = state.value.callCount ?? 0;
        state.update({ callCount: count + 1 });

        return result;
      },
    });

    const mockHandler = vi.fn().mockResolvedValue({
      success: true,
      data: [],
      issues: [],
    });

    const runtime = createMiddlewareRuntime<TestState>({
      onLog: vi.fn() as OnWorkerLog,
      middlewareName: 'Test',
      filesystem: createMockFilesystem(),
      dependencies: mockDependencies,
      dependencyHash: 'a'.repeat(64),
      stateSchema,
    });

    await middleware.wrapCreateGeometry!(
      { filePath: '/builds/test/test.kcl', basePath: '/builds/test', parameters: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Mock handler for testing
      mockHandler as any,
      runtime,
    );

    expect(runtime.state.value.callCount).toBe(2);
  });
});

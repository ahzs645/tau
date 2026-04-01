/* eslint-disable @typescript-eslint/naming-convention -- file naming */
/**
 * Tests for KernelWorker lifecycle, watch subscription, and cache invalidation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OnWorkerLog } from '@taucad/types';
import type { CreateGeometryResult } from '#types/runtime.types.js';
import type { KernelRuntime, CreateGeometryInput } from '#types/runtime-kernel.types.js';
import type { MockKernelWorkerOptions } from '#testing/kernel-testing.utils.js';
import { MockKernelWorker, createMockFileSystem, createGeometryFile } from '#testing/kernel-testing.utils.js';
import { defineMiddleware } from '#middleware/runtime-middleware.js';

// =============================================================================
// Test Helpers
// =============================================================================

async function flushMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    // oxlint-disable-next-line no-await-in-loop -- Intentionally draining microtask queue
    await Promise.resolve();
  }
}

const noopLog: OnWorkerLog = () => {
  /* No-op */
};

function createConfiguredWorker(overrides?: Partial<MockKernelWorkerOptions>) {
  const filesystem = createMockFileSystem();
  filesystem.mocks.readFiles.mockResolvedValue({
    '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
  });

  return new MockKernelWorker({
    middleware: [],
    onLog: noopLog,
    filesystem,
    ...overrides,
  });
}

class FailingKernelWorker extends MockKernelWorker {
  protected override async onCreateGeometry(
    _input: CreateGeometryInput,
    _runtime: KernelRuntime,
  ): Promise<CreateGeometryResult> {
    throw new Error('Build failed: syntax error');
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('KernelWorker lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Watch subscription on error path
  // ---------------------------------------------------------------------------

  describe('watch subscription on error', () => {
    it('should call updateWatchSet even when createGeometry fails', async () => {
      const filesystem = createMockFileSystem();
      filesystem.mocks.readFiles.mockResolvedValue({
        '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
      });

      const worker = new FailingKernelWorker({
        middleware: [],
        onLog: noopLog,
        filesystem,
      });

      const updateWatchSetSpy = vi.spyOn(worker, 'updateWatchSet');

      const renderComplete = new Promise<void>((resolve) => {
        worker.onStateChanged = (state) => {
          if (state === 'error' || state === 'idle') {
            resolve();
          }
        };
      });

      worker.handleSetFile(createGeometryFile('main.ts'), {});
      await renderComplete;

      expect(updateWatchSetSpy).toHaveBeenCalled();
    });

    it('should include entry file in watch set when build produces empty dependencies', () => {
      const worker = createConfiguredWorker();

      // @ts-expect-error - accessing private method for test verification
      worker.setBasePath(createGeometryFile('main.ts'));

      // @ts-expect-error - accessing private for test verification
      worker.bundleResultCache.set('/projects/test/main.ts', {
        code: '',
        dependencies: [],
        issues: [],
        success: false,
      });

      const spy = vi.spyOn(worker, 'updateWatchSet');

      // @ts-expect-error - accessing private for test verification
      worker._updateWatchSetFromCaches();

      expect(spy).toHaveBeenCalled();
      const watchedPaths = spy.mock.calls[0]![0];
      expect(watchedPaths).toContain('/projects/test/main.ts');
    });
  });

  // ---------------------------------------------------------------------------
  // Render generation and _renderInProgress correctness
  // ---------------------------------------------------------------------------

  describe('_renderInProgress correctness', () => {
    it('should not allow an older aborted render to clear isRendering while a newer render is active', async () => {
      vi.useFakeTimers();
      try {
        let resolveGateA!: () => void;
        const gateA = new Promise<void>((resolve) => {
          resolveGateA = resolve;
        });
        let resolveGateB!: () => void;
        const gateB = new Promise<void>((resolve) => {
          resolveGateB = resolve;
        });
        let createGeometryCallCount = 0;

        class GatedKernelWorker extends MockKernelWorker {
          protected override async onCreateGeometry(): Promise<CreateGeometryResult> {
            createGeometryCallCount++;
            // Render A blocks in createGeometry on first call; render B on second
            await (createGeometryCallCount === 1 ? gateA : gateB);
            return { success: true, data: [], issues: [] };
          }
        }

        const filesystem = createMockFileSystem();
        filesystem.mocks.readFiles.mockResolvedValue({
          '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
        });

        const worker = new GatedKernelWorker({
          middleware: [],
          onLog: noopLog,
          filesystem,
        });

        worker.onStateChanged = vi.fn();
        worker.onGeometryComputed = vi.fn();
        worker.onError = vi.fn();

        // Start render A — blocks in createGeometry
        worker.handleSetFile(createGeometryFile('main.ts'), {});
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();

        expect(worker.isRendering).toBe(true);

        // Start render B — also blocks in createGeometry (second call)
        worker.handleSetFile(createGeometryFile('main.ts'), {});
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();

        // Unblock render A — it will detect isAborted and its finally block runs.
        // The bug: A's finally unconditionally sets _renderInProgress = false,
        // even though B (the current render) is still active.
        resolveGateA();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();

        // B is still blocked in createGeometry, so isRendering must be true.
        expect(worker.isRendering).toBe(true);

        // Cleanup: unblock render B
        resolveGateB();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // bundleResultCache invalidation
  // ---------------------------------------------------------------------------

  describe('bundleResultCache invalidation', () => {
    it('should invalidate bundleResultCache entry when changed path matches the entry key directly', async () => {
      const worker = createConfiguredWorker();

      // @ts-expect-error - accessing private for test verification
      worker.bundleResultCache.set('/projects/test/main.ts', {
        code: '',
        dependencies: [],
        issues: [{ message: 'Unterminated regular expression', type: 'compilation', severity: 'error' }],
        success: false,
      });

      await worker.notifyFileChanged(['/projects/test/main.ts']);

      // @ts-expect-error - accessing private for test verification
      expect(worker.bundleResultCache.has('/projects/test/main.ts')).toBe(false);
    });

    it('should invalidate bundleResultCache via watch handler when changed path matches entry key', () => {
      const worker = createConfiguredWorker();

      // @ts-expect-error - accessing private method for test verification
      worker.setBasePath(createGeometryFile('main.ts'));

      // @ts-expect-error - accessing private for test verification
      worker.bundleResultCache.set('/projects/test/main.ts', {
        code: '',
        dependencies: [],
        issues: [{ message: 'Syntax error', type: 'compilation', severity: 'error' }],
        success: false,
      });

      let capturedWatchCallback: ((event: { type: string; path: string }) => void) | undefined;
      const mockWatch = vi
        .fn()
        .mockImplementation((_request: unknown, callback: (event: { type: string; path: string }) => void) => {
          capturedWatchCallback = callback;
          return () => {
            capturedWatchCallback = undefined;
          };
        });

      // @ts-expect-error - accessing private for test verification
      worker.fileSystem = { watch: mockWatch, dispose: vi.fn(), listen: vi.fn() };

      worker.updateWatchSet(['/projects/test/main.ts']);
      expect(capturedWatchCallback).toBeDefined();

      capturedWatchCallback!({ type: 'change', path: '/projects/test/main.ts' });

      // @ts-expect-error - accessing private for test verification
      expect(worker.bundleResultCache.has('/projects/test/main.ts')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // render() error cleanup
  // ---------------------------------------------------------------------------

  describe('render error cleanup', () => {
    it('should clear onProgress when render() throws', async () => {
      const filesystem = createMockFileSystem();
      filesystem.mocks.readFiles.mockResolvedValue({
        '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
      });

      const worker = new FailingKernelWorker({
        middleware: [],
        onLog: noopLog,
        filesystem,
      });

      const progressCallback = vi.fn();

      await expect(
        worker.render({
          file: createGeometryFile('main.ts'),
          parameters: {},
          onProgress: progressCallback,
        }),
      ).rejects.toThrow();

      // @ts-expect-error - accessing private for test verification
      expect(worker.onProgress).toBeUndefined();
    });

    it('should call _updateWatchSetFromCaches when render() throws', async () => {
      const filesystem = createMockFileSystem();
      filesystem.mocks.readFiles.mockResolvedValue({
        '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
      });

      const worker = new FailingKernelWorker({
        middleware: [],
        onLog: noopLog,
        filesystem,
      });

      const updateWatchSetSpy = vi.spyOn(worker, 'updateWatchSet');

      await expect(
        worker.render({
          file: createGeometryFile('main.ts'),
          parameters: {},
        }),
      ).rejects.toThrow();

      expect(updateWatchSetSpy).toHaveBeenCalled();
    });

    it('should clear onProgress when executeRender fails via handleSetFile', async () => {
      const filesystem = createMockFileSystem();
      filesystem.mocks.readFiles.mockResolvedValue({
        '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
      });

      const worker = new FailingKernelWorker({
        middleware: [],
        onLog: noopLog,
        filesystem,
      });

      worker.onProgressUpdate = vi.fn();

      const renderComplete = new Promise<void>((resolve) => {
        worker.onStateChanged = (state) => {
          if (state === 'error' || state === 'idle') {
            resolve();
          }
        };
      });

      worker.handleSetFile(createGeometryFile('main.ts'), {});
      await renderComplete;

      // @ts-expect-error - accessing private for test verification
      expect(worker.onProgress).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Bundler cache efficiency
  // ---------------------------------------------------------------------------

  describe('bundler cache efficiency', () => {
    it('should return cached dependencies from resolveDependencies when bundleResultCache has a hit', async () => {
      const worker = createConfiguredWorker();

      // @ts-expect-error - accessing private method for test verification
      worker.setBasePath(createGeometryFile('main.ts'));

      const expectedDependencies = ['/projects/test/main.ts', '/projects/test/lib/box.ts'];

      // Pre-populate the bundle cache with a known result
      // @ts-expect-error - accessing private for test verification
      worker.bundleResultCache.set('/projects/test/main.ts', {
        code: 'bundled-code',
        dependencies: expectedDependencies,
        issues: [],
        success: true,
      });

      const rawResolveDependenciesSpy = vi.fn().mockResolvedValue(['/projects/test/main.ts']);
      const mockBundlerDefinition = {
        name: 'MockBundler',
        version: '1.0.0',
        extensions: ['ts'],
        initialize: vi.fn(),
        detectImports: vi.fn(),
        bundle: vi.fn(),
        execute: vi.fn(),
        registerModule: vi.fn(),
        resolveDependencies: rawResolveDependenciesSpy,
      };

      // Inject mock bundler directly into loadedBundlers
      // @ts-expect-error - accessing protected for test verification
      worker.loadedBundlers.set('ts', { definition: mockBundlerDefinition, ctx: {} });

      // Clear any cached facade so it rebuilds with our mock bundler
      // @ts-expect-error - accessing private for test verification
      worker.cachedBundlerFacade = undefined;
      // @ts-expect-error - accessing private for test verification
      worker.cachedRuntime = undefined;

      // @ts-expect-error - accessing private for test verification
      const facade = worker.createBundlerFacade();
      const result = await facade.resolveDependencies('/projects/test/main.ts');

      // The facade should return the cached dependencies
      expect(result).toEqual(expectedDependencies);
      // The raw bundler's resolveDependencies should NOT have been called
      expect(rawResolveDependenciesSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Bundler invalidation on project switch
  // ---------------------------------------------------------------------------

  describe('bundler invalidation on project switch', () => {
    it('should invalidate cached bundler facade when basePath changes', () => {
      const worker = createConfiguredWorker();

      // @ts-expect-error - accessing private method for test verification
      worker.setBasePath(createGeometryFile('main.ts', '/projects/project-a'));

      // @ts-expect-error - accessing private for test verification
      const runtime1 = worker.createRuntime();
      const bundler1 = runtime1.bundler;

      // @ts-expect-error - accessing private method for test verification
      worker.setBasePath(createGeometryFile('main.ts', '/projects/project-b'));

      // @ts-expect-error - accessing private for test verification
      const runtime2 = worker.createRuntime();
      const bundler2 = runtime2.bundler;

      expect(bundler1).not.toBe(bundler2);
    });
  });

  // ---------------------------------------------------------------------------
  // registerWatchPath
  // ---------------------------------------------------------------------------

  describe('registerWatchPath', () => {
    it('should include middleware-registered paths in watch set', () => {
      const worker = createConfiguredWorker();

      // @ts-expect-error - accessing private method for test verification
      worker.setBasePath(createGeometryFile('main.ts'));

      // Simulate middleware registering a watch path
      // @ts-expect-error - accessing private for test verification
      worker.handleRegisterWatchPath('/projects/test/.tau/parameters.json', { debounceMs: 200 });

      const spy = vi.spyOn(worker, 'updateWatchSet');

      // @ts-expect-error - accessing private for test verification
      worker._updateWatchSetFromCaches();

      expect(spy).toHaveBeenCalled();
      const watchedPaths = spy.mock.calls[0]![0];
      expect(watchedPaths).toContain('/projects/test/.tau/parameters.json');
      expect(watchedPaths).toContain('/projects/test/main.ts');
    });

    it('should select shortest debounce tier when middleware-watched paths change', async () => {
      vi.useFakeTimers();
      try {
        const worker = createConfiguredWorker();

        // @ts-expect-error - accessing private method for test verification
        worker.setBasePath(createGeometryFile('main.ts'));

        worker.onStateChanged = vi.fn();
        worker.onGeometryComputed = vi.fn();

        // @ts-expect-error - accessing private for test verification
        worker.handleRegisterWatchPath('/projects/test/.tau/parameters.json', { debounceMs: 200 });

        // @ts-expect-error - accessing private for test verification
        worker.currentFile = createGeometryFile('main.ts');

        let capturedWatchCallback: ((event: { type: string; path: string }) => void) | undefined;
        const mockWatch = vi
          .fn()
          .mockImplementation((_request: unknown, callback: (event: { type: string; path: string }) => void) => {
            capturedWatchCallback = callback;
            return () => {
              capturedWatchCallback = undefined;
            };
          });

        // @ts-expect-error - accessing private for test verification
        worker.fileSystem = { watch: mockWatch, dispose: vi.fn(), listen: vi.fn() };

        worker.updateWatchSet(['/projects/test/main.ts', '/projects/test/.tau/parameters.json']);

        capturedWatchCallback!({ type: 'change', path: '/projects/test/.tau/parameters.json' });

        // Buffering should be emitted immediately
        expect(worker.onStateChanged).toHaveBeenCalledWith('buffering');

        // At 199ms, render should not have started (200ms debounce)
        await vi.advanceTimersByTimeAsync(199);
        expect(worker.onStateChanged).not.toHaveBeenCalledWith('rendering');

        // At 201ms, render should have been triggered
        await vi.advanceTimersByTimeAsync(2);
        expect(worker.onStateChanged).toHaveBeenCalledWith('rendering');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should use default fileChangeDebounceMs when non-middleware path changes', async () => {
      vi.useFakeTimers();
      try {
        const worker = createConfiguredWorker();

        // @ts-expect-error - accessing private method for test verification
        worker.setBasePath(createGeometryFile('main.ts'));

        worker.onStateChanged = vi.fn();
        worker.onGeometryComputed = vi.fn();

        // @ts-expect-error - accessing private for test verification
        worker.handleRegisterWatchPath('/projects/test/.tau/parameters.json', { debounceMs: 200 });

        // @ts-expect-error - accessing private for test verification
        worker.currentFile = createGeometryFile('main.ts');

        let capturedWatchCallback: ((event: { type: string; path: string }) => void) | undefined;
        const mockWatch = vi
          .fn()
          .mockImplementation((_request: unknown, callback: (event: { type: string; path: string }) => void) => {
            capturedWatchCallback = callback;
            return () => {
              capturedWatchCallback = undefined;
            };
          });

        // @ts-expect-error - accessing private for test verification
        worker.fileSystem = { watch: mockWatch, dispose: vi.fn(), listen: vi.fn() };

        worker.updateWatchSet(['/projects/test/main.ts', '/projects/test/.tau/parameters.json']);

        capturedWatchCallback!({ type: 'change', path: '/projects/test/main.ts' });

        // Buffering should be emitted immediately
        expect(worker.onStateChanged).toHaveBeenCalledWith('buffering');

        // At 100ms, render should not have started yet (200ms default debounce)
        await vi.advanceTimersByTimeAsync(100);
        expect(worker.onStateChanged).not.toHaveBeenCalledWith('rendering');

        // At 201ms, render should have been triggered
        await vi.advanceTimersByTimeAsync(101);
        expect(worker.onStateChanged).toHaveBeenCalledWith('rendering');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should update debounce value on re-registration (idempotent)', () => {
      const worker = createConfiguredWorker();

      // @ts-expect-error - accessing private for test verification
      worker.handleRegisterWatchPath('/projects/test/.tau/parameters.json', { debounceMs: 100 });

      expect(worker.getMiddlewareWatchPaths().get('/projects/test/.tau/parameters.json')).toBe(100);

      // @ts-expect-error - accessing private for test verification
      worker.handleRegisterWatchPath('/projects/test/.tau/parameters.json', { debounceMs: 200 });

      expect(worker.getMiddlewareWatchPaths().get('/projects/test/.tau/parameters.json')).toBe(200);
    });

    it('should clear middleware watch paths on cleanup', async () => {
      const worker = createConfiguredWorker();

      // @ts-expect-error - accessing private for test verification
      worker.handleRegisterWatchPath('/projects/test/.tau/parameters.json', { debounceMs: 200 });

      expect(worker.getMiddlewareWatchPaths().size).toBe(1);

      await worker.cleanup();

      expect(worker.getMiddlewareWatchPaths().size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Buffering state emission
  // ---------------------------------------------------------------------------

  describe('buffering state', () => {
    it('should not emit duplicate buffering on repeated scheduleRender calls', async () => {
      vi.useFakeTimers();
      try {
        const worker = createConfiguredWorker();

        // @ts-expect-error - accessing private method for test verification
        worker.setBasePath(createGeometryFile('main.ts'));

        worker.onStateChanged = vi.fn();
        worker.onGeometryComputed = vi.fn();

        // @ts-expect-error - accessing private for test verification
        worker.currentFile = createGeometryFile('main.ts');

        // Call scheduleRender 3x rapidly via handleSetParameters
        worker.handleSetParameters({ width: 1 });
        worker.handleSetParameters({ width: 2 });
        worker.handleSetParameters({ width: 3 });

        const bufferingCalls = (worker.onStateChanged as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([state]) => state === 'buffering',
        );
        expect(bufferingCalls).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should emit idle when render completes with no pending timer', async () => {
      const worker = createConfiguredWorker();

      const stateChanges: string[] = [];
      const renderComplete = new Promise<void>((resolve) => {
        worker.onStateChanged = (state) => {
          stateChanges.push(state);
          if (state === 'idle' || state === 'error') {
            resolve();
          }
        };
      });

      worker.handleSetFile(createGeometryFile('main.ts'));
      await renderComplete;

      expect(stateChanges).toContain('rendering');
      expect(stateChanges).toContain('idle');
    });

    it('should emit buffering instead of idle when render completes with pending timer', async () => {
      vi.useFakeTimers();
      try {
        let resolveGate!: () => void;
        const gate = new Promise<void>((resolve) => {
          resolveGate = resolve;
        });

        class GatedKernelWorker extends MockKernelWorker {
          protected override async onCreateGeometry(
            _input: CreateGeometryInput,
            _runtime: KernelRuntime,
          ): Promise<CreateGeometryResult> {
            await gate;
            return { success: true, data: [], issues: [] };
          }
        }

        const filesystem = createMockFileSystem();
        filesystem.mocks.readFiles.mockResolvedValue({
          '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
        });

        const worker = new GatedKernelWorker({
          middleware: [],
          onLog: noopLog,
          filesystem,
        });

        const stateChanges: string[] = [];
        worker.onStateChanged = (state) => {
          stateChanges.push(state);
        };
        worker.onGeometryComputed = vi.fn();

        worker.handleSetFile(createGeometryFile('main.ts'), {});

        // Simulate a watch event arriving during the render by directly
        // setting paramDebounceTimer (scheduleRender would normally do this)
        // @ts-expect-error - accessing private for test verification
        // oxlint-disable-next-line no-empty-function -- noop timer for test
        worker.paramDebounceTimer = setTimeout(() => {}, 500);

        resolveGate();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();

        expect(stateChanges).toContain('rendering');
        expect(stateChanges).toContain('buffering');
        expect(stateChanges).not.toContain('idle');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // handleSetFile with optional parameters
  // ---------------------------------------------------------------------------

  describe('handleSetFile optional parameters', () => {
    it('should default parameters to empty object when omitted', async () => {
      const worker = createConfiguredWorker();

      const renderComplete = new Promise<void>((resolve) => {
        worker.onStateChanged = (state) => {
          if (state === 'idle' || state === 'error') {
            resolve();
          }
        };
      });

      worker.handleSetFile(createGeometryFile('main.ts'));
      await renderComplete;

      // @ts-expect-error - accessing private for test verification
      expect(worker.currentParameters).toEqual({});
    });

    it('should use provided parameters when given', async () => {
      const worker = createConfiguredWorker();

      const renderComplete = new Promise<void>((resolve) => {
        worker.onStateChanged = (state) => {
          if (state === 'idle' || state === 'error') {
            resolve();
          }
        };
      });

      worker.handleSetFile(createGeometryFile('main.ts'), { width: 10 });
      await renderComplete;

      // @ts-expect-error - accessing private for test verification
      expect(worker.currentParameters).toEqual({ width: 10 });
    });
  });

  // ---------------------------------------------------------------------------
  // Immediate entry-file watch
  // ---------------------------------------------------------------------------

  describe('immediate entry-file watch', () => {
    it('should watch the entry file immediately on handleSetFile so edits during a long render are not missed', async () => {
      vi.useFakeTimers();
      try {
        let resolveGate!: () => void;
        const gate = new Promise<void>((resolve) => {
          resolveGate = resolve;
        });

        class GatedKernelWorker extends MockKernelWorker {
          protected override async onCreateGeometry(
            _input: CreateGeometryInput,
            _runtime: KernelRuntime,
          ): Promise<CreateGeometryResult> {
            await gate;
            return {
              success: true,
              data: [],
              issues: [],
            };
          }
        }

        const filesystem = createMockFileSystem();
        filesystem.mocks.readFiles.mockResolvedValue({
          '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
        });

        const worker = new GatedKernelWorker({
          middleware: [],
          onLog: noopLog,
          filesystem,
        });

        const updateWatchSetSpy = vi.spyOn(worker, 'updateWatchSet');
        worker.onStateChanged = vi.fn();
        worker.onGeometryComputed = vi.fn();

        // Starts executeRender via handleSetFile, which blocks in createGeometry
        worker.handleSetFile(createGeometryFile('main.ts'), {});

        // Should have called updateWatchSet immediately (Phase 1)
        // BEFORE createGeometry completes
        expect(updateWatchSetSpy).toHaveBeenCalled();
        const firstCallArgs = updateWatchSetSpy.mock.calls[0]![0];
        expect(firstCallArgs).toContain('/projects/test/main.ts');

        // Unblock the gate so the render completes
        resolveGate();
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // middleware getDependencies hook
  // ---------------------------------------------------------------------------

  describe('middleware getDependencies', () => {
    it('should include middleware dependency files in the dependency hash', async () => {
      const parameterFileContent = new Uint8Array([10, 20, 30]);

      const middlewareWithDeps = defineMiddleware({
        name: 'test-deps',
        getDependencies({ basePath }) {
          return [`${basePath}/.tau/parameters.json`];
        },
      });

      const filesystem = createMockFileSystem();
      filesystem.mocks.readFiles.mockResolvedValue({
        '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
      });
      filesystem.mocks.readFile.mockResolvedValue(parameterFileContent);

      const worker = createConfiguredWorker({
        middleware: [middlewareWithDeps],
        filesystem,
      });

      worker.onStateChanged = vi.fn();
      worker.onGeometryComputed = vi.fn();

      const result1 = await worker.runCreateGeometry('main.ts');
      expect(result1.success).toBe(true);
      const hash1 = result1.success ? result1.data[0]?.hash : undefined;

      // Change the parameter file content and invalidate caches
      // (simulates a watch-triggered file change between render cycles)
      filesystem.mocks.readFile.mockResolvedValue(new Uint8Array([99, 99, 99]));
      // @ts-expect-error - accessing private for test verification
      worker._invalidateCachesForPaths(['/projects/test/.tau/parameters.json']);
      // @ts-expect-error - accessing private for test verification
      worker.renderDependencyCache = undefined;

      const result2 = await worker.runCreateGeometry('main.ts');
      expect(result2.success).toBe(true);
      const hash2 = result2.success ? result2.data[0]?.hash : undefined;

      expect(hash1).toBeDefined();
      expect(hash2).toBeDefined();
      expect(hash1).not.toBe(hash2);
    });

    it('should produce identical hashes when middleware dependency file is unchanged', async () => {
      const parameterFileContent = new Uint8Array([10, 20, 30]);

      const middlewareWithDeps = defineMiddleware({
        name: 'test-deps',
        getDependencies({ basePath }) {
          return [`${basePath}/.tau/parameters.json`];
        },
      });

      const filesystem = createMockFileSystem();
      filesystem.mocks.readFiles.mockResolvedValue({
        '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
      });
      filesystem.mocks.readFile.mockResolvedValue(parameterFileContent);

      const worker = createConfiguredWorker({
        middleware: [middlewareWithDeps],
        filesystem,
      });

      worker.onStateChanged = vi.fn();
      worker.onGeometryComputed = vi.fn();

      const result1 = await worker.runCreateGeometry('main.ts');
      const hash1 = result1.success ? result1.data[0]?.hash : undefined;

      const result2 = await worker.runCreateGeometry('main.ts');
      const hash2 = result2.success ? result2.data[0]?.hash : undefined;

      expect(hash1).toBeDefined();
      expect(hash1).toBe(hash2);
    });

    it('should use sentinel hash when middleware dependency file is missing', async () => {
      const middlewareWithDeps = defineMiddleware({
        name: 'test-deps',
        getDependencies({ basePath }) {
          return [`${basePath}/.tau/missing.json`];
        },
      });

      const filesystem = createMockFileSystem();
      filesystem.mocks.readFiles.mockResolvedValue({
        '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
      });
      filesystem.mocks.readFile.mockRejectedValue(new Error('ENOENT'));

      const worker = createConfiguredWorker({
        middleware: [middlewareWithDeps],
        filesystem,
      });

      worker.onStateChanged = vi.fn();
      worker.onGeometryComputed = vi.fn();

      const result = await worker.runCreateGeometry('main.ts');
      expect(result.success).toBe(true);
    });

    it('should call getDependencies with correct input and resolved options', async () => {
      const getDependenciesSpy = vi.fn().mockReturnValue([]);

      const middlewareWithDeps = defineMiddleware({
        name: 'test-deps',
        getDependencies: getDependenciesSpy,
      });

      const filesystem = createMockFileSystem();
      filesystem.mocks.readFiles.mockResolvedValue({
        '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
      });

      const middlewareOptions = { parametersFile: '.tau/params.json' };
      const worker = createConfiguredWorker({
        middleware: [middlewareWithDeps],
        middlewareConfigs: [middlewareOptions],
        filesystem,
      });

      worker.onStateChanged = vi.fn();
      worker.onGeometryComputed = vi.fn();

      await worker.runCreateGeometry('main.ts');

      expect(getDependenciesSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/projects/test/main.ts',
          basePath: '/projects/test',
        }),
        middlewareOptions,
      );
    });

    it('should skip getDependencies for disabled middleware', async () => {
      const getDependenciesSpy = vi.fn().mockReturnValue([]);

      const middlewareWithDeps = defineMiddleware({
        name: 'test-deps',
        getDependencies: getDependenciesSpy,
      });

      const filesystem = createMockFileSystem();
      filesystem.mocks.readFiles.mockResolvedValue({
        '/projects/test/main.ts': new Uint8Array([1, 2, 3]),
      });

      const worker = createConfiguredWorker({
        middleware: [middlewareWithDeps],
        middlewareEnabled: [false],
        filesystem,
      });

      worker.onStateChanged = vi.fn();
      worker.onGeometryComputed = vi.fn();

      await worker.runCreateGeometry('main.ts');

      expect(getDependenciesSpy).not.toHaveBeenCalled();
    });
  });
});

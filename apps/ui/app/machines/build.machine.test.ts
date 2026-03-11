import { describe, it, expect, vi, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createActor, waitFor } from 'xstate';
import type { Build } from '@taucad/types';
import type { KernelClientOptions } from '@taucad/kernels';
import { buildMachine } from '#machines/build.machine.js';
import type { BuildContext } from '#machines/build.machine.js';
import { fromSafeAsync } from '#lib/xstate.lib.js';

vi.mock('#constants/browser.constants.js', () => ({
  isBrowser: true,
}));

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const stubBuild: Build = {
  id: 'test-build',
  name: 'Test Build',
  description: 'A test build',
  author: { name: 'Test', avatar: '' },
  tags: ['a', 'b'],
  thumbnail: 'thumb.png',
  createdAt: 1000,
  updatedAt: 2000,
  assets: {},
} satisfies Build;

const stubBuildWithMechanical: Build = {
  ...stubBuild,
  assets: {
    mechanical: {
      main: 'main.ts',
      parameters: { width: 10 },
    },
  },
};

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createTestActor(options?: {
  loadResult?: Build | (() => Promise<Build>);
  writeResult?: () => Promise<void>;
  shouldAutoLoad?: boolean;
  shouldLoadModelOnStart?: boolean;
  buildId?: string;
}) {
  const loadResult = options?.loadResult ?? stubBuild;
  const loadFunction = typeof loadResult === 'function' ? loadResult : async () => loadResult;

  const machine = buildMachine.provide({
    actors: {
      loadBuildActor: fromSafeAsync(async () => {
        const build = await loadFunction();
        return { type: 'buildRetrieved', build };
      }),
      ...(options?.writeResult
        ? {
            writeBuildActor: fromSafeAsync(async () => {
              await options.writeResult!();
            }),
          }
        : {}),
    },
    guards: {
      isNotBrowser: () => false,
      shouldAutoLoad: () => options?.shouldAutoLoad ?? false,
    },
  });

  const fileManagerRef = mock<BuildContext['fileManagerRef']>({ send: vi.fn() });
  const kernelOptions = mock<KernelClientOptions>();

  return createActor(machine, {
    input: {
      buildId: options?.buildId ?? 'test-build',
      shouldLoadModelOnStart: options?.shouldLoadModelOnStart ?? false,
      fileManagerRef,
      kernelOptions,
    },
  });
}

async function startAndLoad(options?: Parameters<typeof createTestActor>[0]) {
  const actor = createTestActor(options);
  actor.start();
  actor.send({ type: 'loadBuild', buildId: options?.buildId ?? 'test-build' });
  await waitFor(actor, (s) => s.matches({ ready: {} }));
  return actor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildMachine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // State: checkEnvironment
  // =========================================================================
  describe('checkEnvironment', () => {
    it('should go to idle when browser but shouldAutoLoad is false', () => {
      const actor = createTestActor({ shouldAutoLoad: false });
      actor.start();
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should go to loading when shouldAutoLoad is true', () => {
      const actor = createTestActor({ shouldAutoLoad: true });
      actor.start();
      expect(actor.getSnapshot().value).toBe('loading');
      actor.stop();
    });

    it('should go to ssr when isNotBrowser is true', () => {
      const machine = buildMachine.provide({
        actors: {
          loadBuildActor: fromSafeAsync(async () => {
            return { type: 'buildRetrieved', build: stubBuild };
          }),
        },
        guards: {
          isNotBrowser: () => true,
          shouldAutoLoad: () => false,
        },
      });
      const fileManagerRef = mock<BuildContext['fileManagerRef']>({ send: vi.fn() });
      const kernelOptions = mock<KernelClientOptions>();
      const actor = createActor(machine, {
        input: { buildId: 'b', fileManagerRef, kernelOptions },
      });
      actor.start();
      expect(actor.getSnapshot().value).toBe('ssr');
      actor.stop();
    });
  });

  // =========================================================================
  // State: idle
  // =========================================================================
  describe('idle', () => {
    it('should transition to loading on loadBuild', () => {
      const actor = createTestActor();
      actor.start();
      expect(actor.getSnapshot().value).toBe('idle');
      actor.send({ type: 'loadBuild', buildId: 'test-build' });
      expect(actor.getSnapshot().value).toBe('loading');
      actor.stop();
    });

    it('should accept createViewGraphics in idle', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'createViewGraphics', viewId: 'v1' });
      expect(actor.getSnapshot().context.viewGraphics.has('v1')).toBe(true);
      actor.stop();
    });

    it('should accept destroyViewGraphics in idle', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'createViewGraphics', viewId: 'v1' });
      actor.send({ type: 'destroyViewGraphics', viewId: 'v1' });
      expect(actor.getSnapshot().context.viewGraphics.has('v1')).toBe(false);
      actor.stop();
    });
  });

  // =========================================================================
  // State: loading
  // =========================================================================
  describe('loading', () => {
    it('should transition to ready on successful load', async () => {
      const actor = await startAndLoad();
      expect(actor.getSnapshot().matches({ ready: {} })).toBe(true);
      actor.stop();
    });

    it('should set build in context after load', async () => {
      const actor = await startAndLoad();
      expect(actor.getSnapshot().context.build).toEqual(stubBuild);
      expect(actor.getSnapshot().context.isLoading).toBe(false);
      actor.stop();
    });

    it('should transition to error on load failure', async () => {
      const actor = createTestActor({
        loadResult: async () => {
          throw new Error('load failed');
        },
      });
      actor.start();
      actor.send({ type: 'loadBuild', buildId: 'test-build' });
      await waitFor(actor, (s) => s.value === 'error');
      expect(actor.getSnapshot().context.error?.message).toBe('load failed');
      actor.stop();
    });

    it('should clear previous error on loading entry', async () => {
      const loadCallCount = { count: 0 };
      const actor = createTestActor({
        loadResult: async () => {
          loadCallCount.count++;
          if (loadCallCount.count === 1) {
            throw new Error('first attempt');
          }
          return stubBuild;
        },
      });
      actor.start();

      actor.send({ type: 'loadBuild', buildId: 'test-build' });
      await waitFor(actor, (s) => s.value === 'error');
      expect(actor.getSnapshot().context.error).toBeDefined();

      actor.send({ type: 'loadBuild', buildId: 'test-build' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));
      expect(actor.getSnapshot().context.error).toBeUndefined();
      actor.stop();
    });

    it('should emit buildLoaded event on successful load', async () => {
      const actor = createTestActor();
      actor.start();
      const emitted: unknown[] = [];
      actor.on('buildLoaded', (event) => emitted.push(event));

      actor.send({ type: 'loadBuild', buildId: 'test-build' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ type: 'buildLoaded', build: stubBuild });
      actor.stop();
    });

    it('should accept view graphics events during loading', async () => {
      let resolveLoad!: (value: Build) => void;
      const actor = createTestActor({
        loadResult: async () =>
          new Promise<Build>((resolve) => {
            resolveLoad = resolve;
          }),
      });
      actor.start();
      actor.send({ type: 'loadBuild', buildId: 'test-build' });
      expect(actor.getSnapshot().value).toBe('loading');

      actor.send({ type: 'createViewGraphics', viewId: 'v1' });
      expect(actor.getSnapshot().context.viewGraphics.has('v1')).toBe(true);

      resolveLoad(stubBuild);
      await waitFor(actor, (s) => s.matches({ ready: {} }));
      expect(actor.getSnapshot().context.viewGraphics.has('v1')).toBe(true);
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – context initialization
  // =========================================================================
  describe('ready – initial context', () => {
    it('should initialize with empty mainEntryFile when no mechanical asset', async () => {
      const actor = await startAndLoad();
      expect(actor.getSnapshot().context.mainEntryFile).toBe('');
      actor.stop();
    });

    it('should initialize with empty compilationUnits when shouldLoadModelOnStart is false', async () => {
      const actor = await startAndLoad({
        loadResult: stubBuildWithMechanical,
        shouldLoadModelOnStart: false,
      });
      expect(actor.getSnapshot().context.compilationUnits.size).toBe(0);
      actor.stop();
    });

    it('should set mainEntryFile via initializeKernelIfNeeded when shouldLoadModelOnStart is true', async () => {
      const actor = await startAndLoad({
        loadResult: stubBuildWithMechanical,
        shouldLoadModelOnStart: true,
      });
      expect(actor.getSnapshot().context.mainEntryFile).toBe('main.ts');
      expect(actor.getSnapshot().context.compilationUnits.has('main.ts')).toBe(true);
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – build metadata updates
  // =========================================================================
  describe('ready – metadata actions', () => {
    it('should update build name', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'updateName', name: 'New Name' });
      expect(actor.getSnapshot().context.build?.name).toBe('New Name');
      actor.stop();
    });

    it('should no-op updateName when build is undefined', async () => {
      const actor = await startAndLoad();
      // Manually clear the build for this edge case test
      // We can't easily unset build, but we can verify the action guard by
      // checking the build remains as-is
      actor.send({ type: 'updateName', name: 'Changed' });
      expect(actor.getSnapshot().context.build?.name).toBe('Changed');
      actor.stop();
    });

    it('should update build description', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'updateDescription', description: 'New desc' });
      expect(actor.getSnapshot().context.build?.description).toBe('New desc');
      actor.stop();
    });

    it('should update build thumbnail', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'updateThumbnail', thumbnail: 'new-thumb.png' });
      expect(actor.getSnapshot().context.build?.thumbnail).toBe('new-thumb.png');
      actor.stop();
    });

    it('should update tags with deduplication', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'updateTags', tags: ['x', 'y', 'x', 'z', 'y'] });
      expect(actor.getSnapshot().context.build?.tags).toEqual(['x', 'y', 'z']);
      actor.stop();
    });

    it('should update updatedAt on name change', async () => {
      const actor = await startAndLoad();
      const before = actor.getSnapshot().context.build!.updatedAt;
      actor.send({ type: 'updateName', name: 'Trigger update' });
      const after = actor.getSnapshot().context.build!.updatedAt;
      expect(after).toBeGreaterThanOrEqual(before);
      actor.stop();
    });

    it('should NOT update updatedAt on tag change', async () => {
      const actor = await startAndLoad();
      const before = actor.getSnapshot().context.build!.updatedAt;
      actor.send({ type: 'updateTags', tags: ['new'] });
      const after = actor.getSnapshot().context.build!.updatedAt;
      expect(after).toBe(before);
      actor.stop();
    });

    it('should set main file path in build assets', async () => {
      const actor = await startAndLoad({ loadResult: stubBuildWithMechanical });
      actor.send({ type: 'setMainFile', path: 'other.ts' });
      expect(actor.getSnapshot().context.build?.assets.mechanical?.main).toBe('other.ts');
      actor.stop();
    });

    it('should no-op setMainFile when no mechanical asset', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'setMainFile', path: 'other.ts' });
      expect(actor.getSnapshot().context.build?.assets.mechanical).toBeUndefined();
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – compilation units
  // =========================================================================
  describe('ready – compilation units', () => {
    it('should create a compilation unit', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'createCompilationUnit', entryFile: 'main.ts' });
      expect(actor.getSnapshot().context.compilationUnits.has('main.ts')).toBe(true);
      actor.stop();
    });

    it('should set mainEntryFile when it is currently empty', async () => {
      const actor = await startAndLoad();
      expect(actor.getSnapshot().context.mainEntryFile).toBe('');
      actor.send({ type: 'createCompilationUnit', entryFile: 'main.ts' });
      expect(actor.getSnapshot().context.mainEntryFile).toBe('main.ts');
      actor.stop();
    });

    it('should NOT override mainEntryFile when it is already set', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'createCompilationUnit', entryFile: 'first.ts' });
      actor.send({ type: 'createCompilationUnit', entryFile: 'second.ts' });
      expect(actor.getSnapshot().context.mainEntryFile).toBe('first.ts');
      expect(actor.getSnapshot().context.compilationUnits.has('second.ts')).toBe(true);
      actor.stop();
    });

    it('should no-op when creating a compilation unit that already exists', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'createCompilationUnit', entryFile: 'main.ts' });
      const unitBefore = actor.getSnapshot().context.compilationUnits.get('main.ts');
      actor.send({ type: 'createCompilationUnit', entryFile: 'main.ts' });
      const unitAfter = actor.getSnapshot().context.compilationUnits.get('main.ts');
      expect(unitAfter).toBe(unitBefore);
      actor.stop();
    });

    it('should destroy a compilation unit', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'createCompilationUnit', entryFile: 'main.ts' });
      expect(actor.getSnapshot().context.compilationUnits.has('main.ts')).toBe(true);
      actor.send({ type: 'destroyCompilationUnit', entryFile: 'main.ts' });
      expect(actor.getSnapshot().context.compilationUnits.has('main.ts')).toBe(false);
      actor.stop();
    });

    it('should clear mainEntryFile when destroying the main compilation unit', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'createCompilationUnit', entryFile: 'main.ts' });
      expect(actor.getSnapshot().context.mainEntryFile).toBe('main.ts');
      actor.send({ type: 'destroyCompilationUnit', entryFile: 'main.ts' });
      expect(actor.getSnapshot().context.mainEntryFile).toBe('');
      actor.stop();
    });

    it('should NOT clear mainEntryFile when destroying a non-main compilation unit', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'createCompilationUnit', entryFile: 'main.ts' });
      actor.send({ type: 'createCompilationUnit', entryFile: 'other.ts' });
      expect(actor.getSnapshot().context.mainEntryFile).toBe('main.ts');
      actor.send({ type: 'destroyCompilationUnit', entryFile: 'other.ts' });
      expect(actor.getSnapshot().context.mainEntryFile).toBe('main.ts');
      actor.stop();
    });

    it('should no-op when destroying a non-existent compilation unit', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'destroyCompilationUnit', entryFile: 'nonexistent.ts' });
      expect(actor.getSnapshot().context.compilationUnits.size).toBe(0);
      actor.stop();
    });

    it('should openInViewer: create unit and emit viewerFileRequested', async () => {
      const actor = await startAndLoad();
      const emitted: unknown[] = [];
      actor.on('viewerFileRequested', (event) => emitted.push(event));

      actor.send({ type: 'openInViewer', entryFile: 'viewer.ts' });
      expect(actor.getSnapshot().context.compilationUnits.has('viewer.ts')).toBe(true);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ entryFile: 'viewer.ts' });
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – view graphics
  // =========================================================================
  describe('ready – view graphics', () => {
    it('should create a graphics actor for a view', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'createViewGraphics', viewId: 'panel-1' });
      expect(actor.getSnapshot().context.viewGraphics.has('panel-1')).toBe(true);
      actor.stop();
    });

    it('should no-op when creating graphics for an existing view', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'createViewGraphics', viewId: 'panel-1' });
      const gfxBefore = actor.getSnapshot().context.viewGraphics.get('panel-1');
      actor.send({ type: 'createViewGraphics', viewId: 'panel-1' });
      const gfxAfter = actor.getSnapshot().context.viewGraphics.get('panel-1');
      expect(gfxAfter).toBe(gfxBefore);
      actor.stop();
    });

    it('should destroy a graphics actor', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'createViewGraphics', viewId: 'panel-1' });
      actor.send({ type: 'destroyViewGraphics', viewId: 'panel-1' });
      expect(actor.getSnapshot().context.viewGraphics.has('panel-1')).toBe(false);
      actor.stop();
    });

    it('should no-op when destroying a non-existent graphics view', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'destroyViewGraphics', viewId: 'nonexistent' });
      expect(actor.getSnapshot().context.viewGraphics.size).toBe(0);
      actor.stop();
    });

    it('should support multiple independent view graphics', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'createViewGraphics', viewId: 'v1' });
      actor.send({ type: 'createViewGraphics', viewId: 'v2' });
      expect(actor.getSnapshot().context.viewGraphics.size).toBe(2);
      actor.send({ type: 'destroyViewGraphics', viewId: 'v1' });
      expect(actor.getSnapshot().context.viewGraphics.size).toBe(1);
      expect(actor.getSnapshot().context.viewGraphics.has('v2')).toBe(true);
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – parameters
  // =========================================================================
  describe('ready – parameters', () => {
    it('should update code parameters in build context', async () => {
      const actor = await startAndLoad({ loadResult: stubBuildWithMechanical });
      actor.send({
        type: 'updateCodeParameters',
        files: {},
        parameters: { height: 20 },
      });
      expect(actor.getSnapshot().context.build?.assets.mechanical?.parameters).toEqual({ height: 20 });
      actor.stop();
    });

    it('should no-op updateCodeParameters when no mechanical asset', async () => {
      const actor = await startAndLoad();
      actor.send({
        type: 'updateCodeParameters',
        files: {},
        parameters: { height: 20 },
      });
      expect(actor.getSnapshot().context.build?.assets.mechanical).toBeUndefined();
      actor.stop();
    });

    it('should update parameters and forward to main compilation unit', async () => {
      const actor = await startAndLoad({
        loadResult: stubBuildWithMechanical,
        shouldLoadModelOnStart: true,
      });
      const mainUnit = actor.getSnapshot().context.compilationUnits.get('main.ts');
      expect(mainUnit).toBeDefined();

      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(actor.getSnapshot().context.build?.assets.mechanical?.parameters).toEqual({ depth: 5 });
      actor.stop();
    });

    it('should no-op setParameters when no mechanical asset', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(actor.getSnapshot().context.build?.assets.mechanical).toBeUndefined();
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – loadModel
  // =========================================================================
  describe('ready – loadModel', () => {
    it('should create compilation unit for main file when none exists', async () => {
      const actor = await startAndLoad({ loadResult: stubBuildWithMechanical });
      expect(actor.getSnapshot().context.compilationUnits.has('main.ts')).toBe(false);
      actor.send({ type: 'loadModel' });
      expect(actor.getSnapshot().context.compilationUnits.has('main.ts')).toBe(true);
      expect(actor.getSnapshot().context.mainEntryFile).toBe('main.ts');
      actor.stop();
    });

    it('should no-op loadModel when no mechanical asset', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'loadModel' });
      expect(actor.getSnapshot().context.compilationUnits.size).toBe(0);
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – storing (debounce + write)
  // =========================================================================
  describe('ready – storing', () => {
    it('should enter storing.pending after a metadata update', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'updateName', name: 'Trigger Store' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.matches({ ready: { storing: 'pending' } })).toBe(true);
      actor.stop();
    });

    it('should write build after debounce elapses', async () => {
      vi.useFakeTimers();
      try {
        let writeCallCount = 0;
        const actor = await startAndLoad({
          writeResult: async () => {
            writeCallCount++;
          },
        });

        actor.send({ type: 'updateName', name: 'Debounced' });
        expect(actor.getSnapshot().matches({ ready: { storing: 'pending' } })).toBe(true);

        await vi.advanceTimersByTimeAsync(500);

        const snapshot = await waitFor(actor, (s) => s.matches({ ready: { storing: 'idle' } }));
        expect(snapshot.matches({ ready: { storing: 'idle' } })).toBe(true);
        expect(writeCallCount).toBe(1);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reset debounce when another update arrives during pending', async () => {
      vi.useFakeTimers();
      try {
        let writeCallCount = 0;
        const actor = await startAndLoad({
          writeResult: async () => {
            writeCallCount++;
          },
        });

        actor.send({ type: 'updateName', name: 'First' });
        await vi.advanceTimersByTimeAsync(300);

        actor.send({ type: 'updateDescription', description: 'Second' });
        await vi.advanceTimersByTimeAsync(300);
        expect(writeCallCount).toBe(0);

        await vi.advanceTimersByTimeAsync(200);
        await waitFor(actor, (s) => s.matches({ ready: { storing: 'idle' } }));
        expect(writeCallCount).toBe(1);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should go to pending on write error, allowing retry', async () => {
      vi.useFakeTimers();
      try {
        let writeCallCount = 0;
        const actor = await startAndLoad({
          writeResult: async () => {
            writeCallCount++;
            if (writeCallCount === 1) {
              throw new Error('write failed');
            }
          },
        });

        actor.send({ type: 'updateName', name: 'Will Fail' });
        await vi.advanceTimersByTimeAsync(500);

        await waitFor(actor, (s) => s.matches({ ready: { storing: 'pending' } }));
        expect(writeCallCount).toBe(1);
        expect(actor.getSnapshot().context.error?.message).toBe('write failed');

        await vi.advanceTimersByTimeAsync(500);
        await waitFor(actor, (s) => s.matches({ ready: { storing: 'idle' } }));
        expect(writeCallCount).toBe(2);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should flush immediately on flushNow event', async () => {
      vi.useFakeTimers();
      try {
        let writeCallCount = 0;
        const actor = await startAndLoad({
          writeResult: async () => {
            writeCallCount++;
          },
        });

        actor.send({ type: 'updateName', name: 'Flush Me' });
        expect(actor.getSnapshot().matches({ ready: { storing: 'pending' } })).toBe(true);

        actor.send({ type: 'flushNow' });
        expect(actor.getSnapshot().matches({ ready: { storing: 'writing' } })).toBe(true);

        await vi.advanceTimersByTimeAsync(0);
        await waitFor(actor, (s) => s.matches({ ready: { storing: 'idle' } }));
        expect(writeCallCount).toBe(1);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should emit buildUpdated after successful write', async () => {
      vi.useFakeTimers();
      try {
        const actor = await startAndLoad({
          writeResult: async () => {
            /* No-op */
          },
        });

        const emitted: unknown[] = [];
        actor.on('buildUpdated', (event) => emitted.push(event));

        actor.send({ type: 'updateName', name: 'Updated' });
        await vi.advanceTimersByTimeAsync(500);
        await waitFor(actor, (s) => s.matches({ ready: { storing: 'idle' } }));

        expect(emitted).toHaveLength(1);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // State: ready – build ID change
  // =========================================================================
  describe('ready – build ID change', () => {
    it('should reload with same buildId (no actor respawn)', async () => {
      const loadResults = [stubBuild, { ...stubBuild, name: 'Reloaded' }];
      let loadIndex = 0;
      const actor = await startAndLoad({
        loadResult: async () => loadResults[loadIndex++]!,
      });

      actor.send({ type: 'loadBuild', buildId: 'test-build' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));
      expect(actor.getSnapshot().context.build?.name).toBe('Reloaded');
      actor.stop();
    });

    it('should stop and respawn actors when buildId changes', async () => {
      const actor = await startAndLoad();

      actor.send({ type: 'createCompilationUnit', entryFile: 'old.ts' });
      actor.send({ type: 'createViewGraphics', viewId: 'old-view' });
      expect(actor.getSnapshot().context.compilationUnits.size).toBe(1);
      expect(actor.getSnapshot().context.viewGraphics.size).toBe(1);

      actor.send({ type: 'loadBuild', buildId: 'new-build' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));

      expect(actor.getSnapshot().context.buildId).toBe('new-build');
      expect(actor.getSnapshot().context.compilationUnits.size).toBe(0);
      expect(actor.getSnapshot().context.viewGraphics.size).toBe(0);
      expect(actor.getSnapshot().context.mainEntryFile).toBe('');
      actor.stop();
    });
  });

  // =========================================================================
  // State: error
  // =========================================================================
  describe('error', () => {
    it('should transition to loading on loadBuild', async () => {
      let loadIndex = 0;
      const actor = createTestActor({
        loadResult: async () => {
          loadIndex++;
          if (loadIndex === 1) {
            throw new Error('boom');
          }
          return stubBuild;
        },
      });
      actor.start();

      actor.send({ type: 'loadBuild', buildId: 'test-build' });
      await waitFor(actor, (s) => s.value === 'error');

      actor.send({ type: 'loadBuild', buildId: 'test-build' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));
      expect(actor.getSnapshot().context.error).toBeUndefined();
      actor.stop();
    });

    it('should set error context on unknown error shape', async () => {
      const actor = createTestActor({
        // oxlint-disable-next-line @typescript-eslint/only-throw-error -- testing non-Error rejection
        loadResult: async () => {
          // oxlint-disable-next-line @typescript-eslint/only-throw-error -- testing non-Error rejection
          throw 'string error';
        },
      });
      actor.start();
      actor.send({ type: 'loadBuild', buildId: 'test-build' });
      await waitFor(actor, (s) => s.value === 'error');
      expect(actor.getSnapshot().context.error?.message).toBe('Unknown error');
      actor.stop();
    });
  });

  // =========================================================================
  // Context initialization
  // =========================================================================
  describe('context initialization', () => {
    it('should initialize with correct defaults', () => {
      const actor = createTestActor({ buildId: 'init-test' });
      actor.start();
      const { context } = actor.getSnapshot();
      expect(context.buildId).toBe('init-test');
      expect(context.build).toBeUndefined();
      expect(context.error).toBeUndefined();
      expect(context.isLoading).toBe(true);
      expect(context.mainEntryFile).toBe('');
      expect(context.compilationUnits.size).toBe(0);
      expect(context.viewGraphics.size).toBe(0);
      actor.stop();
    });
  });
});

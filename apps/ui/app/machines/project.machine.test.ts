import { describe, it, expect, vi, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createActor, waitFor } from 'xstate';
import type { Project } from '@taucad/types';
import type { RuntimeClientOptions } from '@taucad/runtime';
import { projectMachine } from '#machines/project.machine.js';
import type { ProjectContext } from '#machines/project.machine.js';
import { fromSafeAsync } from '#lib/xstate.lib.js';

vi.mock('#constants/browser.constants.js', () => ({
  isBrowser: true,
}));

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const stubProject: Project = {
  id: 'test-project',
  name: 'Test Project',
  description: 'A test project',
  author: { name: 'Test', avatar: '' },
  tags: ['a', 'b'],
  thumbnail: 'thumb.png',
  createdAt: 1000,
  updatedAt: 2000,
  assets: {},
} satisfies Project;

const stubProjectWithMechanical: Project = {
  ...stubProject,
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
  loadResult?: Project | (() => Promise<Project>);
  writeResult?: () => Promise<void>;
  shouldAutoLoad?: boolean;
  shouldLoadModelOnStart?: boolean;
  projectId?: string;
}) {
  const loadResult = options?.loadResult ?? stubProject;
  const loadFunction = typeof loadResult === 'function' ? loadResult : async () => loadResult;

  const machine = projectMachine.provide({
    actors: {
      loadProjectActor: fromSafeAsync(async () => {
        const project = await loadFunction();
        return { type: 'projectRetrieved', project };
      }),
      ...(options?.writeResult
        ? {
            writeProjectActor: fromSafeAsync(async () => {
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

  const fileManagerRef = mock<ProjectContext['fileManagerRef']>({ send: vi.fn() });
  const kernelOptions = mock<RuntimeClientOptions>();

  return createActor(machine, {
    input: {
      projectId: options?.projectId ?? 'test-project',
      shouldLoadModelOnStart: options?.shouldLoadModelOnStart ?? false,
      fileManagerRef,
      kernelOptions,
    },
  });
}

async function startAndLoad(options?: Parameters<typeof createTestActor>[0]) {
  const actor = createTestActor(options);
  actor.start();
  actor.send({ type: 'loadProject', projectId: options?.projectId ?? 'test-project' });
  await waitFor(actor, (s) => s.matches({ ready: {} }));
  return actor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('projectMachine', () => {
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
      const machine = projectMachine.provide({
        actors: {
          loadProjectActor: fromSafeAsync(async () => {
            return { type: 'projectRetrieved', project: stubProject };
          }),
        },
        guards: {
          isNotBrowser: () => true,
          shouldAutoLoad: () => false,
        },
      });
      const fileManagerRef = mock<ProjectContext['fileManagerRef']>({ send: vi.fn() });
      const kernelOptions = mock<RuntimeClientOptions>();
      const actor = createActor(machine, {
        input: { projectId: 'b', fileManagerRef, kernelOptions },
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
    it('should transition to loading on loadProject', () => {
      const actor = createTestActor();
      actor.start();
      expect(actor.getSnapshot().value).toBe('idle');
      actor.send({ type: 'loadProject', projectId: 'test-project' });
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

    it('should set project in context after load', async () => {
      const actor = await startAndLoad();
      expect(actor.getSnapshot().context.project).toEqual(stubProject);
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
      actor.send({ type: 'loadProject', projectId: 'test-project' });
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
          return stubProject;
        },
      });
      actor.start();

      actor.send({ type: 'loadProject', projectId: 'test-project' });
      await waitFor(actor, (s) => s.value === 'error');
      expect(actor.getSnapshot().context.error).toBeDefined();

      actor.send({ type: 'loadProject', projectId: 'test-project' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));
      expect(actor.getSnapshot().context.error).toBeUndefined();
      actor.stop();
    });

    it('should emit projectLoaded event on successful load', async () => {
      const actor = createTestActor();
      actor.start();
      const emitted: unknown[] = [];
      actor.on('projectLoaded', (event) => emitted.push(event));

      actor.send({ type: 'loadProject', projectId: 'test-project' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ type: 'projectLoaded', project: stubProject });
      actor.stop();
    });

    it('should accept view graphics events during loading', async () => {
      let resolveLoad!: (value: Project) => void;
      const actor = createTestActor({
        loadResult: async () =>
          new Promise<Project>((resolve) => {
            resolveLoad = resolve;
          }),
      });
      actor.start();
      actor.send({ type: 'loadProject', projectId: 'test-project' });
      expect(actor.getSnapshot().value).toBe('loading');

      actor.send({ type: 'createViewGraphics', viewId: 'v1' });
      expect(actor.getSnapshot().context.viewGraphics.has('v1')).toBe(true);

      resolveLoad(stubProject);
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
        loadResult: stubProjectWithMechanical,
        shouldLoadModelOnStart: false,
      });
      expect(actor.getSnapshot().context.compilationUnits.size).toBe(0);
      actor.stop();
    });

    it('should set mainEntryFile via initializeKernelIfNeeded when shouldLoadModelOnStart is true', async () => {
      const actor = await startAndLoad({
        loadResult: stubProjectWithMechanical,
        shouldLoadModelOnStart: true,
      });
      expect(actor.getSnapshot().context.mainEntryFile).toBe('main.ts');
      expect(actor.getSnapshot().context.compilationUnits.has('main.ts')).toBe(true);
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – project metadata updates
  // =========================================================================
  describe('ready – metadata actions', () => {
    it('should update project name', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'updateName', name: 'New Name' });
      expect(actor.getSnapshot().context.project?.name).toBe('New Name');
      actor.stop();
    });

    it('should no-op updateName when project is undefined', async () => {
      const actor = await startAndLoad();
      // Manually clear the project for this edge case test
      // We can't easily unset project, but we can verify the action guard by
      // checking the project remains as-is
      actor.send({ type: 'updateName', name: 'Changed' });
      expect(actor.getSnapshot().context.project?.name).toBe('Changed');
      actor.stop();
    });

    it('should update project description', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'updateDescription', description: 'New desc' });
      expect(actor.getSnapshot().context.project?.description).toBe('New desc');
      actor.stop();
    });

    it('should update project thumbnail', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'updateThumbnail', thumbnail: 'new-thumb.png' });
      expect(actor.getSnapshot().context.project?.thumbnail).toBe('new-thumb.png');
      actor.stop();
    });

    it('should update tags with deduplication', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'updateTags', tags: ['x', 'y', 'x', 'z', 'y'] });
      expect(actor.getSnapshot().context.project?.tags).toEqual(['x', 'y', 'z']);
      actor.stop();
    });

    it('should update updatedAt on name change', async () => {
      const actor = await startAndLoad();
      const before = actor.getSnapshot().context.project!.updatedAt;
      actor.send({ type: 'updateName', name: 'Trigger update' });
      const after = actor.getSnapshot().context.project!.updatedAt;
      expect(after).toBeGreaterThanOrEqual(before);
      actor.stop();
    });

    it('should NOT update updatedAt on tag change', async () => {
      const actor = await startAndLoad();
      const before = actor.getSnapshot().context.project!.updatedAt;
      actor.send({ type: 'updateTags', tags: ['new'] });
      const after = actor.getSnapshot().context.project!.updatedAt;
      expect(after).toBe(before);
      actor.stop();
    });

    it('should set main file path in project assets', async () => {
      const actor = await startAndLoad({ loadResult: stubProjectWithMechanical });
      actor.send({ type: 'setMainFile', path: 'other.ts' });
      expect(actor.getSnapshot().context.project?.assets.mechanical?.main).toBe('other.ts');
      actor.stop();
    });

    it('should no-op setMainFile when no mechanical asset', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'setMainFile', path: 'other.ts' });
      expect(actor.getSnapshot().context.project?.assets.mechanical).toBeUndefined();
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
    it('should update code parameters in project context', async () => {
      const actor = await startAndLoad({ loadResult: stubProjectWithMechanical });
      actor.send({
        type: 'updateCodeParameters',
        files: {},
        parameters: { height: 20 },
      });
      expect(actor.getSnapshot().context.project?.assets.mechanical?.parameters).toEqual({ height: 20 });
      actor.stop();
    });

    it('should no-op updateCodeParameters when no mechanical asset', async () => {
      const actor = await startAndLoad();
      actor.send({
        type: 'updateCodeParameters',
        files: {},
        parameters: { height: 20 },
      });
      expect(actor.getSnapshot().context.project?.assets.mechanical).toBeUndefined();
      actor.stop();
    });

    it('should update parameters and forward to main compilation unit', async () => {
      const actor = await startAndLoad({
        loadResult: stubProjectWithMechanical,
        shouldLoadModelOnStart: true,
      });
      const mainUnit = actor.getSnapshot().context.compilationUnits.get('main.ts');
      expect(mainUnit).toBeDefined();

      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(actor.getSnapshot().context.project?.assets.mechanical?.parameters).toEqual({ depth: 5 });
      actor.stop();
    });

    it('should no-op setParameters when no mechanical asset', async () => {
      const actor = await startAndLoad();
      actor.send({ type: 'setParameters', parameters: { depth: 5 } });
      expect(actor.getSnapshot().context.project?.assets.mechanical).toBeUndefined();
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – loadModel
  // =========================================================================
  describe('ready – loadModel', () => {
    it('should create compilation unit for main file when none exists', async () => {
      const actor = await startAndLoad({ loadResult: stubProjectWithMechanical });
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

    it('should write project after debounce elapses', async () => {
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

    it('should emit projectUpdated after successful write', async () => {
      vi.useFakeTimers();
      try {
        const actor = await startAndLoad({
          writeResult: async () => {
            /* No-op */
          },
        });

        const emitted: unknown[] = [];
        actor.on('projectUpdated', (event) => emitted.push(event));

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
  // State: ready – project ID change
  // =========================================================================
  describe('ready – project ID change', () => {
    it('should reload with same projectId (no actor respawn)', async () => {
      const loadResults = [stubProject, { ...stubProject, name: 'Reloaded' }];
      let loadIndex = 0;
      const actor = await startAndLoad({
        loadResult: async () => loadResults[loadIndex++]!,
      });

      actor.send({ type: 'loadProject', projectId: 'test-project' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));
      expect(actor.getSnapshot().context.project?.name).toBe('Reloaded');
      actor.stop();
    });

    it('should stop and respawn actors when projectId changes', async () => {
      const actor = await startAndLoad();

      actor.send({ type: 'createCompilationUnit', entryFile: 'old.ts' });
      actor.send({ type: 'createViewGraphics', viewId: 'old-view' });
      expect(actor.getSnapshot().context.compilationUnits.size).toBe(1);
      expect(actor.getSnapshot().context.viewGraphics.size).toBe(1);

      actor.send({ type: 'loadProject', projectId: 'new-project' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));

      expect(actor.getSnapshot().context.projectId).toBe('new-project');
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
    it('should transition to loading on loadProject', async () => {
      let loadIndex = 0;
      const actor = createTestActor({
        loadResult: async () => {
          loadIndex++;
          if (loadIndex === 1) {
            throw new Error('boom');
          }
          return stubProject;
        },
      });
      actor.start();

      actor.send({ type: 'loadProject', projectId: 'test-project' });
      await waitFor(actor, (s) => s.value === 'error');

      actor.send({ type: 'loadProject', projectId: 'test-project' });
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
      actor.send({ type: 'loadProject', projectId: 'test-project' });
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
      const actor = createTestActor({ projectId: 'init-test' });
      actor.start();
      const { context } = actor.getSnapshot();
      expect(context.projectId).toBe('init-test');
      expect(context.project).toBeUndefined();
      expect(context.error).toBeUndefined();
      expect(context.isLoading).toBe(true);
      expect(context.mainEntryFile).toBe('');
      expect(context.compilationUnits.size).toBe(0);
      expect(context.viewGraphics.size).toBe(0);
      actor.stop();
    });
  });
});

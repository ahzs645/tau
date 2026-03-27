import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor, waitFor } from 'xstate';
import type { EditorState } from '#types/editor.types.js';
import { defaultPanelState } from '#constants/editor.constants.js';
import { editorMachine } from '#machines/editor.machine.js';
import { fromSafeAsync } from '#lib/xstate.lib.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const stubEditorState: EditorState = {
  projectId: 'test-build',
  openFiles: [
    { path: 'src/main.ts', name: 'main.ts' },
    { path: 'src/utils.ts', name: 'utils.ts' },
  ],
  activeFilePath: 'src/main.ts',
  lastChatId: 'chat-1',
  panelState: defaultPanelState,
  editorLayout: undefined,
  viewerLayout: undefined,
  viewSettings: {},
  updatedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createTestActor(options?: {
  loadResult?: EditorState | undefined | (() => Promise<EditorState | undefined>);
  saveResult?: () => Promise<void>;
  projectId?: string;
}) {
  const loadResult = options?.loadResult;
  const loadFunction = typeof loadResult === 'function' ? loadResult : async () => loadResult;

  const machine = editorMachine.provide({
    actors: {
      loadEditorStateActor: fromSafeAsync(async () => {
        const state = await loadFunction();
        return { type: 'editorStateRetrieved', state };
      }),
      ...(options?.saveResult
        ? {
            saveEditorStateActor: fromSafeAsync(async () => {
              await options.saveResult!();
            }),
          }
        : {}),
    },
  });

  return createActor(machine, {
    input: { projectId: options?.projectId ?? 'test-build' },
  });
}

async function startAndLoad(options?: Parameters<typeof createTestActor>[0]) {
  const actor = createTestActor(options);
  actor.start();
  actor.send({ type: 'load' });
  await waitFor(actor, (s) => s.matches({ ready: {} }));
  return actor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('editorMachine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // State: idle
  // =========================================================================
  describe('idle', () => {
    it('should start in idle state', () => {
      const actor = createTestActor();
      actor.start();
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should transition to loading on load event', () => {
      const actor = createTestActor({
        // oxlint-disable-next-line no-empty-function, typescript-eslint/promise-function-async -- mock never-resolving promise
        loadResult: () => new Promise(() => {}),
      });
      actor.start();
      actor.send({ type: 'load' });
      expect(actor.getSnapshot().value).toBe('loading');
      actor.stop();
    });
  });

  // =========================================================================
  // State: loading
  // =========================================================================
  describe('loading', () => {
    it('should transition to ready after successful load', async () => {
      const actor = await startAndLoad({ loadResult: stubEditorState });
      expect(actor.getSnapshot().matches({ ready: {} })).toBe(true);
      actor.stop();
    });

    it('should set loaded state in context', async () => {
      const actor = await startAndLoad({ loadResult: stubEditorState });
      const { context } = actor.getSnapshot();
      expect(context.openFiles).toEqual(stubEditorState.openFiles);
      expect(context.activeFilePath).toBe('src/main.ts');
      expect(context.panelState).toEqual(defaultPanelState);
      actor.stop();
    });

    it('should handle load with undefined state', async () => {
      const actor = await startAndLoad({ loadResult: undefined });
      const { context } = actor.getSnapshot();
      expect(context.openFiles).toEqual([]);
      expect(context.activeFilePath).toBeUndefined();
      expect(context.panelState).toEqual(defaultPanelState);
      actor.stop();
    });

    it('should emit editorStateLoaded on successful load', async () => {
      const actor = createTestActor({ loadResult: stubEditorState });
      actor.start();
      const emitted: unknown[] = [];
      actor.on('editorStateLoaded', (event) => emitted.push(event));

      actor.send({ type: 'load' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ type: 'editorStateLoaded' });
      actor.stop();
    });

    it('should transition to ready even on load error (graceful degradation)', async () => {
      const actor = createTestActor({
        loadResult: async () => {
          throw new Error('load failed');
        },
      });
      actor.start();
      actor.send({ type: 'load' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));
      expect(actor.getSnapshot().matches({ ready: {} })).toBe(true);
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – file operations
  // =========================================================================
  describe('ready – file operations', () => {
    it('should open a new file', async () => {
      const actor = await startAndLoad({ loadResult: undefined });
      actor.send({ type: 'openFile', path: 'src/new.ts', source: 'user' });
      const { context } = actor.getSnapshot();
      expect(context.openFiles).toHaveLength(1);
      expect(context.openFiles[0]).toEqual({ path: 'src/new.ts', name: 'new.ts' });
      actor.stop();
    });

    it('should set active file on open', async () => {
      const actor = await startAndLoad({ loadResult: undefined });
      actor.send({ type: 'openFile', path: 'src/new.ts', source: 'user' });
      expect(actor.getSnapshot().context.activeFilePath).toBe('src/new.ts');
      actor.stop();
    });

    it('should close a file and update active file', async () => {
      const actor = await startAndLoad({ loadResult: stubEditorState });
      expect(actor.getSnapshot().context.openFiles).toHaveLength(2);

      actor.send({ type: 'closeFile', path: 'src/main.ts' });
      const { context } = actor.getSnapshot();
      expect(context.openFiles).toHaveLength(1);
      expect(context.activeFilePath).toBe('src/utils.ts');
      actor.stop();
    });

    it('should close all files', async () => {
      const actor = await startAndLoad({ loadResult: stubEditorState });
      actor.send({ type: 'closeAll' });
      const { context } = actor.getSnapshot();
      expect(context.openFiles).toHaveLength(0);
      expect(context.activeFilePath).toBeUndefined();
      actor.stop();
    });

    it('should rename a file in openFiles', async () => {
      const actor = await startAndLoad({ loadResult: stubEditorState });
      actor.send({ type: 'renameFile', oldPath: 'src/main.ts', newPath: 'src/index.ts' });
      const { context } = actor.getSnapshot();
      const renamed = context.openFiles.find((f) => f.path === 'src/index.ts');
      expect(renamed).toBeDefined();
      expect(renamed!.name).toBe('index.ts');
      expect(context.activeFilePath).toBe('src/index.ts');
      actor.stop();
    });

    it('should emit fileOpened event', async () => {
      const actor = await startAndLoad({ loadResult: undefined });
      const emitted: unknown[] = [];
      actor.on('fileOpened', (event) => emitted.push(event));

      actor.send({ type: 'openFile', path: 'src/test.ts', source: 'user' });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ type: 'fileOpened', path: 'src/test.ts' });
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – panel state
  // =========================================================================
  describe('ready – panel state', () => {
    it('should update panel state with deep merge', async () => {
      const actor = await startAndLoad({ loadResult: undefined });
      actor.send({
        type: 'setPanelState',
        panelState: { openPanels: { files: true } },
      });
      const { context } = actor.getSnapshot();
      expect(context.panelState.openPanels.files).toBe(true);
      expect(context.panelState.openPanels.chat).toBe(true);
      actor.stop();
    });

    it('should shallow-merge kernelPaneview into panel state', async () => {
      const actor = await startAndLoad({ loadResult: undefined });
      actor.send({
        type: 'setPanelState',
        panelState: {
          kernelPaneview: { 'main.ts': { isExpanded: true, size: 200 } },
        },
      });
      expect(actor.getSnapshot().context.panelState.kernelPaneview).toEqual({
        'main.ts': { isExpanded: true, size: 200 },
      });

      actor.send({
        type: 'setPanelState',
        panelState: {
          kernelPaneview: { 'other.ts': { isExpanded: false, size: 80 } },
        },
      });
      expect(actor.getSnapshot().context.panelState.kernelPaneview).toEqual({
        'main.ts': { isExpanded: true, size: 200 },
        'other.ts': { isExpanded: false, size: 80 },
      });
      actor.stop();
    });

    it('should shallow-merge parametersPaneview into panel state', async () => {
      const actor = await startAndLoad({ loadResult: undefined });
      actor.send({
        type: 'setPanelState',
        panelState: {
          parametersPaneview: { 'index.ts': { isExpanded: true, size: 150 } },
        },
      });
      expect(actor.getSnapshot().context.panelState.parametersPaneview).toEqual({
        'index.ts': { isExpanded: true, size: 150 },
      });
      actor.stop();
    });

    it('should preserve other panel state fields when merging paneview state', async () => {
      const actor = await startAndLoad({ loadResult: undefined });
      actor.send({
        type: 'setPanelState',
        panelState: { openPanels: { files: true } },
      });
      actor.send({
        type: 'setPanelState',
        panelState: {
          kernelPaneview: { 'main.ts': { isExpanded: true, size: 200 } },
        },
      });

      const { panelState } = actor.getSnapshot().context;
      expect(panelState.openPanels.files).toBe(true);
      expect(panelState.openPanels.chat).toBe(true);
      expect(panelState.kernelPaneview).toEqual({
        'main.ts': { isExpanded: true, size: 200 },
      });
      expect(panelState.parametersPaneview).toEqual({});
      actor.stop();
    });
  });

  // =========================================================================
  // State: ready – storing (debounce)
  // =========================================================================
  describe('ready – storing', () => {
    it('should enter pending after file operation', async () => {
      const actor = await startAndLoad({ loadResult: undefined });
      actor.send({ type: 'openFile', path: 'src/a.ts', source: 'user' });
      expect(actor.getSnapshot().matches({ ready: { storing: 'pending' } })).toBe(true);
      actor.stop();
    });

    it('should enter pending after closeAll', async () => {
      const actor = await startAndLoad({ loadResult: stubEditorState });
      expect(actor.getSnapshot().context.openFiles).toHaveLength(2);

      actor.send({ type: 'closeAll' });
      expect(actor.getSnapshot().context.openFiles).toHaveLength(0);
      expect(actor.getSnapshot().matches({ ready: { storing: 'pending' } })).toBe(true);
      actor.stop();
    });

    it('should write after debounce elapses', async () => {
      vi.useFakeTimers();
      try {
        let writeCallCount = 0;
        const actor = await startAndLoad({
          loadResult: undefined,
          saveResult: async () => {
            writeCallCount++;
          },
        });

        actor.send({ type: 'openFile', path: 'src/a.ts', source: 'user' });
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

    it('should flush on flushNow', async () => {
      vi.useFakeTimers();
      try {
        let writeCallCount = 0;
        const actor = await startAndLoad({
          loadResult: undefined,
          saveResult: async () => {
            writeCallCount++;
          },
        });

        actor.send({ type: 'openFile', path: 'src/a.ts', source: 'user' });
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
  });

  // =========================================================================
  // State: ready – reload
  // =========================================================================
  describe('ready – reload', () => {
    it('should reload with new projectId', async () => {
      const loadResults = [stubEditorState, { ...stubEditorState, projectId: 'new-build', openFiles: [] }];
      let loadIndex = 0;
      const actor = await startAndLoad({
        loadResult: async () => loadResults[loadIndex++],
      });

      expect(actor.getSnapshot().context.projectId).toBe('test-build');
      actor.send({ type: 'reload', projectId: 'new-build' });
      await waitFor(actor, (s) => s.matches({ ready: {} }));
      expect(actor.getSnapshot().context.projectId).toBe('new-build');
      expect(actor.getSnapshot().context.openFiles).toEqual([]);
      actor.stop();
    });
  });
});

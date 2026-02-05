import { assign, assertEvent, setup, fromPromise, enqueueActions, emit } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { PartialDeep } from 'type-fest';
import type { EditorState, EditorStateInput, OpenFile, FileOpenSource, PanelState } from '#types/editor.types.js';
import { defaultPanelState } from '#constants/editor.constants.js';

/**
 * Deep merge utility for panel state.
 * Merges partial updates into the current state while preserving unspecified values.
 */
function deepMergePanelState(current: PanelState, update: PartialDeep<PanelState>): PanelState {
  return {
    openPanels: {
      ...current.openPanels,
      ...update.openPanels,
    },
    panelSizes: {
      ...current.panelSizes,
      ...update.panelSizes,
    },
    mobileActiveTab: update.mobileActiveTab ?? current.mobileActiveTab,
  };
}

/**
 * Editor state Machine Context
 */
export type EditorStateContext = {
  buildId: string;
  openFiles: OpenFile[];
  activeFilePath: string | undefined;
  lastChatId: string | undefined;
  /** Panel layout state (open/close, sizes, mobile tab) */
  panelState: PanelState;
  isLoading: boolean;
  error: Error | undefined;
  /** Flag indicating changes occurred during a write operation that need persisting */
  hasPendingChanges: boolean;
};

/**
 * Editor state Machine Input
 */
type EditorStateMachineInput = {
  buildId: string;
};

/**
 * Editor state Machine Events
 */
type EditorStateEvent =
  | { type: 'load' }
  | { type: 'reload'; buildId: string }
  // File operations (consolidated from fileExplorerMachine)
  | { type: 'openFile'; path: string; source: FileOpenSource; lineNumber?: number; column?: number }
  | { type: 'closeFile'; path: string }
  | { type: 'setActiveFile'; path: string }
  | { type: 'renameFile'; oldPath: string; newPath: string }
  | { type: 'closeAll' }
  // Chat operations
  | { type: 'setLastChatId'; chatId: string }
  // Panel operations
  | { type: 'setPanelState'; panelState: PartialDeep<PanelState> };

/**
 * Editor state Machine Emitted Events
 */
type EditorStateEmitted =
  | { type: 'editorStateLoaded'; editorState: EditorState | undefined }
  | { type: 'fileOpened'; path: string; lineNumber?: number; column?: number; source?: FileOpenSource };

// Actors to be provided by the consumer
const loadEditorStateActor = fromPromise<EditorState | undefined, { buildId: string }>(async () => {
  throw new Error('Not implemented. Please supply via provide.');
});

const saveEditorStateActor = fromPromise<void, { editorState: EditorStateInput }>(async () => {
  throw new Error('Not implemented. Please supply via provide.');
});

/**
 * Editor State Machine
 *
 * Manages transient Editor state per-build:
 * - Open files / tabs
 * - Active file path
 * - Last active chat ID
 *
 * This machine is DECOUPLED from the build machine to keep the build machine
 * clean for CLI/multi-frontend reuse.
 */
export const editorMachine = setup({
  types: {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as EditorStateContext,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as EditorStateEvent,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    emitted: {} as EditorStateEmitted,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as EditorStateMachineInput,
  },
  actors: {
    loadEditorStateActor,
    saveEditorStateActor,
  },
  actions: {
    // ============================================================================
    // Lifecycle actions
    // ============================================================================
    setLoading: assign({ isLoading: true }),
    clearLoading: assign({ isLoading: false }),
    setError: assign({
      error({ event }) {
        if ('error' in event && event.error instanceof Error) {
          return event.error;
        }

        return new Error('Unknown error');
      },
      isLoading: false,
    }),
    clearError: assign({ error: undefined }),

    setLoadedState: enqueueActions(({ enqueue, event }) => {
      // Extract loaded state from actor done event
      const loadedState = (event as unknown as { output: EditorState | undefined }).output;

      // Merge loaded panelState with defaults to handle missing fields from old data
      const mergedPanelState = loadedState?.panelState
        ? deepMergePanelState(defaultPanelState, loadedState.panelState)
        : defaultPanelState;

      enqueue.assign({
        openFiles: loadedState?.openFiles ?? [],
        activeFilePath: loadedState?.activeFilePath,
        lastChatId: loadedState?.lastChatId,
        panelState: mergedPanelState,
        isLoading: false,
      });

      // Emit fileOpened for active file (for CAD, tabs, etc.)
      if (loadedState?.activeFilePath) {
        enqueue.emit({
          type: 'fileOpened',
          path: loadedState.activeFilePath,
          source: 'machine',
        });
      }

      // Always emit editorStateLoaded so consumers know loading is complete
      enqueue.emit({
        type: 'editorStateLoaded',
        editorState: loadedState,
      });
    }),

    updateBuildId: assign(({ event }) => {
      assertEvent(event, 'reload');
      return {
        buildId: event.buildId,
        openFiles: [],
        activeFilePath: undefined,
        lastChatId: undefined,
        panelState: defaultPanelState,
      };
    }),

    emitEditorStateLoadedEmpty: emit(() => ({
      type: 'editorStateLoaded' as const,
      editorState: undefined,
    })),

    // ============================================================================
    // File operations (consolidated from fileExplorerMachine)
    // ============================================================================
    openFile: enqueueActions(({ enqueue, event, context }) => {
      assertEvent(event, 'openFile');

      const existingFile = context.openFiles.find((f) => f.path === event.path);
      if (existingFile) {
        // File already open and active - still emit to allow line navigation
        if (context.activeFilePath === event.path) {
          enqueue.emit({
            type: 'fileOpened' as const,
            path: event.path,
            lineNumber: event.lineNumber,
            column: event.column,
            source: event.source,
          });
          return;
        }

        // File open but not active - set as active and emit
        enqueue.assign({
          activeFilePath: event.path,
        });
        enqueue.emit({
          type: 'fileOpened' as const,
          path: event.path,
          lineNumber: event.lineNumber,
          column: event.column,
          source: event.source,
        });
        return;
      }

      // Open new file
      const newFile: OpenFile = {
        path: event.path,
        name: event.path.split('/').pop() ?? event.path,
      };

      enqueue.assign({
        openFiles: [...context.openFiles, newFile],
        activeFilePath: newFile.path,
      });

      enqueue.emit({
        type: 'fileOpened' as const,
        path: event.path,
        lineNumber: event.lineNumber,
        column: event.column,
        source: event.source,
      });
    }),

    closeFile: enqueueActions(({ enqueue, event, context }) => {
      assertEvent(event, 'closeFile');

      const updatedOpenFiles = context.openFiles.filter((file) => file.path !== event.path);
      let newActiveFilePath = context.activeFilePath;

      // If closing the active file, set new active file
      if (context.activeFilePath === event.path) {
        newActiveFilePath = updatedOpenFiles.at(-1)?.path;

        // Emit fileOpened for the new active file (if any)
        if (newActiveFilePath) {
          enqueue.emit({
            type: 'fileOpened' as const,
            path: newActiveFilePath,
          });
        }
      }

      enqueue.assign({
        openFiles: updatedOpenFiles,
        activeFilePath: newActiveFilePath,
      });
    }),

    setActiveFile: enqueueActions(({ enqueue, event, context }) => {
      assertEvent(event, 'setActiveFile');

      // Already active - nothing to do
      if (context.activeFilePath === event.path) {
        return;
      }

      enqueue.assign({
        activeFilePath: event.path,
      });

      // Emit fileOpened for the new active file
      enqueue.emit({
        type: 'fileOpened' as const,
        path: event.path,
      });
    }),

    closeAll: enqueueActions(({ enqueue }) => {
      enqueue.assign({
        openFiles: [],
        activeFilePath: undefined,
      });
    }),

    renameFile: enqueueActions(({ enqueue, event, context }) => {
      assertEvent(event, 'renameFile');

      const { oldPath, newPath } = event;

      // Update the path in openFiles
      const updatedOpenFiles = context.openFiles.map((file) => {
        if (file.path === oldPath) {
          return {
            ...file,
            path: newPath,
            name: newPath.split('/').pop() ?? newPath,
          };
        }

        // Also handle nested files (for directory renames)
        if (file.path.startsWith(`${oldPath}/`)) {
          const relativePath = file.path.slice(oldPath.length);
          const newFilePath = `${newPath}${relativePath}`;
          return {
            ...file,
            path: newFilePath,
            name: newFilePath.split('/').pop() ?? newFilePath,
          };
        }

        return file;
      });

      // Update activeFilePath if it was the renamed file or a nested file
      let newActiveFilePath = context.activeFilePath;
      if (context.activeFilePath === oldPath) {
        newActiveFilePath = newPath;
      } else if (context.activeFilePath?.startsWith(`${oldPath}/`)) {
        const relativePath = context.activeFilePath.slice(oldPath.length);
        newActiveFilePath = `${newPath}${relativePath}`;
      }

      enqueue.assign({
        openFiles: updatedOpenFiles,
        activeFilePath: newActiveFilePath,
      });

      // Emit fileOpened for the renamed file so CAD machine updates its reference
      if (
        newActiveFilePath &&
        (context.activeFilePath === oldPath || context.activeFilePath?.startsWith(`${oldPath}/`))
      ) {
        enqueue.emit({
          type: 'fileOpened' as const,
          path: newActiveFilePath,
        });
      }
    }),

    // ============================================================================
    // Chat operations
    // ============================================================================
    setLastChatIdInContext: assign(({ event }) => {
      assertEvent(event, 'setLastChatId');
      return { lastChatId: event.chatId };
    }),

    // ============================================================================
    // Panel operations
    // ============================================================================
    setPanelStateInContext: assign(({ event, context }) => {
      assertEvent(event, 'setPanelState');
      return {
        panelState: deepMergePanelState(context.panelState, event.panelState),
      };
    }),

    // ============================================================================
    // Persistence tracking
    // ============================================================================
    setPendingChanges: assign({ hasPendingChanges: true }),
    clearPendingChanges: assign({ hasPendingChanges: false }),
  },
  guards: {
    isBuildIdChanging({ context, event }) {
      assertEvent(event, 'reload');
      return context.buildId !== event.buildId;
    },
    hasPendingChanges({ context }) {
      return context.hasPendingChanges;
    },
  },
  delays: {
    storeDebounce: 500,
  },
}).createMachine({
  id: 'editor',
  context({ input }) {
    return {
      buildId: input.buildId,
      openFiles: [],
      activeFilePath: undefined,
      lastChatId: undefined,
      panelState: defaultPanelState,
      isLoading: false,
      error: undefined,
      hasPendingChanges: false,
    };
  },
  initial: 'idle',
  states: {
    idle: {
      on: {
        load: {
          target: 'loading',
          actions: 'setLoading',
        },
        reload: {
          target: 'loading',
          actions: ['updateBuildId', 'setLoading'],
        },
      },
    },
    loading: {
      entry: 'clearError',
      invoke: {
        src: 'loadEditorStateActor',
        input: ({ context }) => ({ buildId: context.buildId }),
        onDone: {
          target: 'ready',
          actions: 'setLoadedState',
        },
        onError: {
          target: 'ready', // Editor state missing is fine, just use defaults
          actions: ['clearLoading', 'emitEditorStateLoadedEmpty'],
        },
      },
      on: {
        reload: {
          target: 'loading',
          actions: ['updateBuildId', 'setLoading'],
          reenter: true,
        },
      },
    },
    ready: {
      type: 'parallel',
      states: {
        operation: {
          initial: 'idle',
          states: {
            idle: {},
          },
          on: {
            // File operations
            openFile: {
              actions: 'openFile',
            },
            closeFile: {
              actions: 'closeFile',
            },
            setActiveFile: {
              actions: 'setActiveFile',
            },
            renameFile: {
              actions: 'renameFile',
            },
            closeAll: {
              actions: 'closeAll',
            },
            // Chat operations
            setLastChatId: {
              actions: 'setLastChatIdInContext',
            },
            // Panel operations
            setPanelState: {
              actions: 'setPanelStateInContext',
            },
            // Reload
            reload: {
              target: '#editor.loading',
              actions: ['updateBuildId', 'setLoading'],
            },
          },
        },
        storing: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                openFile: { target: 'pending' },
                closeFile: { target: 'pending' },
                setActiveFile: { target: 'pending' },
                renameFile: { target: 'pending' },
                setLastChatId: { target: 'pending' },
                setPanelState: { target: 'pending' },
              },
            },
            pending: {
              after: {
                storeDebounce: 'writing',
              },
              on: {
                openFile: { target: 'pending', reenter: true },
                closeFile: { target: 'pending', reenter: true },
                setActiveFile: { target: 'pending', reenter: true },
                renameFile: { target: 'pending', reenter: true },
                setLastChatId: { target: 'pending', reenter: true },
                setPanelState: { target: 'pending', reenter: true },
              },
            },
            writing: {
              invoke: {
                src: 'saveEditorStateActor',
                input({ context }) {
                  return {
                    editorState: {
                      buildId: context.buildId,
                      openFiles: context.openFiles,
                      activeFilePath: context.activeFilePath,
                      lastChatId: context.lastChatId,
                      panelState: context.panelState,
                    },
                  };
                },
                onDone: [
                  {
                    guard: 'hasPendingChanges',
                    target: 'pending',
                    actions: 'clearPendingChanges',
                  },
                  { target: 'idle' },
                ],
                onError: { target: 'pending', actions: 'clearPendingChanges' },
              },
              on: {
                // Track mutations during write so we persist again after completion
                openFile: { actions: 'setPendingChanges' },
                closeFile: { actions: 'setPendingChanges' },
                setActiveFile: { actions: 'setPendingChanges' },
                renameFile: { actions: 'setPendingChanges' },
                setLastChatId: { actions: 'setPendingChanges' },
                setPanelState: { actions: 'setPendingChanges' },
              },
            },
          },
        },
      },
    },
  },
});

export type EditorStateMachineRef = ActorRefFrom<typeof editorMachine>;

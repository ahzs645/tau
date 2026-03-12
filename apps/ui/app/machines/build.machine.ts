import { assign, assertEvent, setup, emit, enqueueActions } from 'xstate';
import type { ActorRefFrom, AnyStateMachine } from 'xstate';
import { produce } from 'immer';
import type { Build } from '@taucad/types';
import type { KernelClientOptions } from '@taucad/runtime';
import { isBrowser } from '#constants/browser.constants.js';
import type { GraphicsViewSettings } from '#constants/editor.constants.js';
import { defaultGraphicsSettings } from '#constants/editor.constants.js';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { cadMachine } from '#machines/cad.machine.js';
import { gitMachine } from '#machines/git.machine.js';
import { graphicsMachine } from '#machines/graphics.machine.js';
import { logMachine } from '#machines/logs.machine.js';
import type { fileManagerMachine } from '#machines/file-manager.machine.js';

/**
 * Build Machine Context
 */
export type BuildContext = {
  buildId: string;
  build: Build | undefined;
  error: Error | undefined;
  isLoading: boolean;
  shouldLoadModelOnStart: boolean;
  kernelOptions: KernelClientOptions;
  fileManagerRef: ActorRefFrom<typeof fileManagerMachine>;
  gitRef: ActorRefFrom<typeof gitMachine>;
  /** Per-viewer-panel graphics machines, keyed by Dockview panel ID */
  viewGraphics: Map<string, ActorRefFrom<typeof graphicsMachine>>;
  /** Dynamic compilation units keyed by entry file path. Each is a headless CadMachine+KernelMachine. */
  compilationUnits: Map<string, ActorRefFrom<typeof cadMachine>>;
  /** The main entry file path from build.assets.mechanical.main. Set after build loads. */
  mainEntryFile: string;
  logRef: ActorRefFrom<typeof logMachine>;
};

/**
 * Build Machine Input
 */
type BuildInput = {
  buildId: string;
  shouldLoadModelOnStart?: boolean;
  fileManagerRef: ActorRefFrom<typeof fileManagerMachine>;
  kernelOptions: KernelClientOptions;
};

// Define the actors that the machine can invoke
const loadBuildActor = fromSafeAsync<{ type: 'buildRetrieved'; build: Build }, { buildId: string }>(async () => {
  throw new Error('Not implemented. Please supply the `provide.actors.loadBuildActor` option to the build machine.');
});

const writeBuildActor = fromSafeAsync<void, { build: Build }>(async () => {
  throw new Error('Not implemented. Please supply the `provide.actors.writeBuildActor` option to the build machine.');
});

const buildActors = {
  loadBuildActor,
  writeBuildActor,
  git: gitMachine,
  graphics: graphicsMachine,
  // Having the cadMachine typed results in:
  // `The inferred type of this node exceeds the maximum length the compiler will serialize`.
  // We need to dig into this and possibly simplify the external type inferred from the machine.
  //
  // This has no impact on machine consumer typings, only to this machine where
  // some types will need to be manually asserted (Eslint will report those places).
  cad: cadMachine as AnyStateMachine,
  logs: logMachine,
} as const;

/**
 * Build Machine Events
 */
type BuildEventInternal =
  | { type: 'loadBuild'; buildId: string }
  | { type: 'updateName'; name: string }
  | { type: 'updateDescription'; description: string }
  | { type: 'updateTags'; tags: string[] }
  | { type: 'updateThumbnail'; thumbnail: string }
  | {
      type: 'updateCodeParameters';
      files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
      parameters: Record<string, unknown>;
    }
  | { type: 'setParameters'; parameters: Record<string, unknown> }
  | { type: 'loadModel' }
  | { type: 'setMainFile'; path: string }
  | { type: 'createCompilationUnit'; entryFile: string }
  | { type: 'openInViewer'; entryFile: string }
  | { type: 'destroyCompilationUnit'; entryFile: string }
  | {
      type: 'createViewGraphics';
      viewId: string;
      settings?: GraphicsViewSettings;
    }
  | { type: 'destroyViewGraphics'; viewId: string }
  // Flush pending state immediately (bypasses debounce, used on tab close)
  | { type: 'flushNow' };

type BuildEvent = BuildEventInternal | { type: 'buildRetrieved'; build: Build };

/**
 * Build Machine Emitted Events
 */
type BuildEmitted =
  | { type: 'buildLoaded'; build: Build }
  | { type: 'error'; error: Error }
  | { type: 'buildUpdated'; build: Build }
  | { type: 'viewerFileRequested'; entryFile: string };

/**
 * Build Machine
 *
 * Manages build lifecycle, storage operations, and filesystem coordination.
 *
 * States:
 * - idle: No build loaded
 * - loading: Loading build from storage
 * - ready: Build loaded and ready
 * - updating: Updating build metadata
 * - creating: Creating a new build
 * - deleting: Deleting a build
 * - error: An error occurred
 */
export const buildMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as BuildContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as BuildEvent,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    emitted: {} as BuildEmitted,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as BuildInput,
  },
  actors: buildActors,
  actions: {
    setError: assign({
      error({ event }) {
        if ('error' in event && event.error instanceof Error) {
          return event.error;
        }

        return new Error('Unknown error');
      },
      isLoading: false,
    }),
    clearError: assign({
      error: undefined,
    }),
    setLoading: assign({
      isLoading: true,
    }),
    clearLoading: assign({
      isLoading: false,
    }),
    updateBuildId: assign({
      buildId({ event }) {
        assertEvent(event, 'loadBuild');
        return event.buildId;
      },
    }),
    setBuild: assign({
      build({ event }) {
        assertEvent(event, 'buildRetrieved');
        return event.build;
      },
      isLoading: false,
    }),
    clearBuild: assign({
      build: undefined,
    }),
    updateName: assign(({ context, event }) => {
      assertEvent(event, 'updateName');
      if (!context.build) {
        return {};
      }

      return produce(context, (draft) => {
        draft.build!.name = event.name;
        draft.build!.updatedAt = Date.now();
      });
    }),
    updateDescription: assign(({ context, event }) => {
      assertEvent(event, 'updateDescription');
      if (!context.build) {
        return {};
      }

      return produce(context, (draft) => {
        draft.build!.description = event.description;
        draft.build!.updatedAt = Date.now();
      });
    }),
    updateTags: assign(({ context, event }) => {
      assertEvent(event, 'updateTags');
      if (!context.build) {
        return {};
      }

      // Deduplicate tags to ensure uniqueness
      const uniqueTags = [...new Set(event.tags)];

      return produce(context, (draft) => {
        draft.build!.tags = uniqueTags;
        // Don't update updatedAt for tags - they're metadata
      });
    }),
    updateThumbnail: assign(({ context, event }) => {
      assertEvent(event, 'updateThumbnail');
      if (!context.build) {
        return {};
      }

      return produce(context, (draft) => {
        draft.build!.thumbnail = event.thumbnail;
        // Don't update updatedAt for thumbnails - they're metadata
      });
    }),
    updateCodeParametersInContext: enqueueActions(({ enqueue, context, event }) => {
      assertEvent(event, 'updateCodeParameters');

      if (!context.build?.assets.mechanical) {
        return;
      }

      // Update build in context using Immer
      enqueue.assign(({ context }) =>
        produce(context, (draft) => {
          if (draft.build?.assets.mechanical) {
            draft.build.assets.mechanical.parameters = event.parameters;
            draft.build.updatedAt = Date.now();
          }
        }),
      );
    }),
    setParametersInContext: enqueueActions(({ enqueue, context, event }) => {
      assertEvent(event, 'setParameters');

      if (!context.build?.assets.mechanical) {
        return;
      }

      // Update build in context using Immer
      enqueue.assign(({ context }) =>
        produce(context, (draft) => {
          if (draft.build?.assets.mechanical) {
            draft.build.assets.mechanical.parameters = event.parameters;
            draft.build.updatedAt = Date.now();
          }
        }),
      );

      // Forward to the main file compilation unit
      const mainUnit = context.compilationUnits.get(context.mainEntryFile);
      if (mainUnit) {
        enqueue.sendTo(mainUnit, {
          type: 'setParameters',
          parameters: event.parameters,
        });
      }
    }),
    setMainFileInContext: assign(({ context, event }) => {
      assertEvent(event, 'setMainFile');
      if (!context.build?.assets.mechanical) {
        return {};
      }

      return produce(context, (draft) => {
        if (draft.build?.assets.mechanical) {
          draft.build.assets.mechanical.main = event.path;
          draft.build.updatedAt = Date.now();
        }
      });
    }),
    stopStatefulActors: enqueueActions(({ enqueue, context }) => {
      // Stop the old stateful actors (they'll be garbage collected)
      enqueue.stopChild(context.gitRef);

      // Stop all compilation units
      for (const unit of context.compilationUnits.values()) {
        enqueue.stopChild(unit);
      }

      // Stop all view graphics machines
      for (const gfx of context.viewGraphics.values()) {
        enqueue.stopChild(gfx);
      }
    }),
    respawnStatefulActors: assign({
      gitRef({ context, spawn, self }) {
        return spawn('git', {
          id: `git-${context.buildId}`,
          input: {
            buildId: context.buildId,
            parentRef: self,
            fileManagerRef: context.fileManagerRef,
          },
        });
      },
      // Reset compilation units - the primary one will be created during initializeKernelIfNeeded after build load
      compilationUnits: () => new Map(),
      mainEntryFile: () => '',
      // Reset view graphics - they'll be created by Dockview viewer panels
      viewGraphics: () => new Map(),
    }),
    initializeKernelIfNeeded: enqueueActions(({ enqueue, context }) => {
      // Only initialize if shouldLoadModelOnStart is true
      if (!context.shouldLoadModelOnStart) {
        return;
      }

      const mechanicalAsset = context.build?.assets.mechanical;
      if (!mechanicalAsset) {
        return;
      }

      const mainFile = mechanicalAsset.main;

      // Create the primary compilation unit for the main file if it doesn't exist
      if (context.compilationUnits.has(mainFile)) {
        // Compilation unit already exists, just set the main entry file and re-initialize
        enqueue.assign({ mainEntryFile: mainFile });
        const existingUnit = context.compilationUnits.get(mainFile)!;
        enqueue.sendTo(existingUnit, {
          type: 'initializeModel',
          file: {
            path: `/builds/${context.buildId}`,
            filename: mainFile,
          },
          parameters: mechanicalAsset.parameters,
        });
      } else {
        // Spawn is only available inside assign callbacks in XState v5.
        // We spawn and immediately send events to the new actor within the assign.
        enqueue.assign(({ spawn, context }) => {
          const cadUnit = spawn('cad', {
            id: `cad-${context.buildId}-${mainFile.replaceAll('/', '-')}`,
            input: {
              shouldInitializeKernelOnStart: false,
              logRef: context.logRef,
              fileManagerRef: context.fileManagerRef,
              kernelOptions: context.kernelOptions,
            },
          });

          cadUnit.send({
            type: 'initializeModel',
            file: {
              path: `/builds/${context.buildId}`,
              filename: mainFile,
            },
            parameters: mechanicalAsset.parameters,
          });

          const newUnits = new Map(context.compilationUnits);
          newUnits.set(mainFile, cadUnit as ActorRefFrom<typeof cadMachine>);
          return { compilationUnits: newUnits, mainEntryFile: mainFile };
        });
      }
    }),
    loadModel: enqueueActions(({ enqueue, context }) => {
      const mechanicalAsset = context.build?.assets.mechanical;
      if (!mechanicalAsset) {
        return;
      }

      const mainFile = mechanicalAsset.main;

      // Find or create the compilation unit for the main file
      const mainUnit = context.compilationUnits.get(mainFile);
      if (mainUnit) {
        enqueue.sendTo(mainUnit, {
          type: 'initializeModel',
          file: {
            path: `/builds/${context.buildId}`,
            filename: mainFile,
          },
          parameters: mechanicalAsset.parameters,
        });
      } else {
        // Spawn is only available inside assign callbacks in XState v5.
        enqueue.assign(({ spawn, context }) => {
          const cadUnit = spawn('cad', {
            id: `cad-${context.buildId}-${mainFile.replaceAll('/', '-')}`,
            input: {
              shouldInitializeKernelOnStart: false,
              logRef: context.logRef,
              fileManagerRef: context.fileManagerRef,
              kernelOptions: context.kernelOptions,
            },
          });

          cadUnit.send({
            type: 'initializeModel',
            file: {
              path: `/builds/${context.buildId}`,
              filename: mainFile,
            },
            parameters: mechanicalAsset.parameters,
          });

          const newUnits = new Map(context.compilationUnits);
          newUnits.set(mainFile, cadUnit as ActorRefFrom<typeof cadMachine>);
          return { compilationUnits: newUnits, mainEntryFile: mainFile };
        });
      }
    }),
    createCompilationUnit: enqueueActions(({ enqueue, context, event }) => {
      assertEvent(event, 'createCompilationUnit');

      // No-op if a compilation unit already exists for this entry file
      if (context.compilationUnits.has(event.entryFile)) {
        return;
      }

      // Spawn is only available inside assign callbacks in XState v5.
      enqueue.assign(({ spawn, context }) => {
        const cadUnit = spawn('cad', {
          id: `cad-${context.buildId}-${event.entryFile.replaceAll('/', '-')}`,
          input: {
            shouldInitializeKernelOnStart: true,
            logRef: context.logRef,
            fileManagerRef: context.fileManagerRef,
            kernelOptions: context.kernelOptions,
          },
        });

        // Initialize model with the entry file directly on the spawned actor
        cadUnit.send({
          type: 'initializeModel',
          file: {
            path: `/builds/${context.buildId}`,
            filename: event.entryFile,
          },
          parameters: context.build?.assets.mechanical?.parameters ?? {},
        });

        const newUnits = new Map(context.compilationUnits);
        newUnits.set(event.entryFile, cadUnit as ActorRefFrom<typeof cadMachine>);
        return {
          compilationUnits: newUnits,
          ...(context.mainEntryFile === '' ? { mainEntryFile: event.entryFile } : {}),
        };
      });
    }),
    openInViewer: enqueueActions(({ enqueue, event }) => {
      assertEvent(event, 'openInViewer');
      enqueue.raise({
        type: 'createCompilationUnit',
        entryFile: event.entryFile,
      });
      enqueue.emit({ type: 'viewerFileRequested', entryFile: event.entryFile });
    }),
    destroyCompilationUnit: enqueueActions(({ enqueue, context, event }) => {
      assertEvent(event, 'destroyCompilationUnit');

      const unit = context.compilationUnits.get(event.entryFile);
      if (!unit) {
        return;
      }

      enqueue.stopChild(unit);
      enqueue.assign(({ context }) => {
        const newUnits = new Map(context.compilationUnits);
        newUnits.delete(event.entryFile);
        return {
          compilationUnits: newUnits,
          ...(context.mainEntryFile === event.entryFile ? { mainEntryFile: '' } : {}),
        };
      });
    }),
    createViewGraphics: enqueueActions(({ enqueue, context, event }) => {
      assertEvent(event, 'createViewGraphics');

      // No-op if a graphics actor already exists for this view
      if (context.viewGraphics.has(event.viewId)) {
        return;
      }

      const settings = event.settings ?? defaultGraphicsSettings;

      enqueue.assign(({ spawn, context }) => {
        const gfx = spawn('graphics', {
          id: `graphics-view-${context.buildId}-${event.viewId}`,
          input: {
            defaultCameraFovAngle: settings.cameraFovAngle,
            measureSnapDistance: 40,
            enableSurfaces: settings.enableSurfaces,
            enableLines: settings.enableLines,
            enableGizmo: settings.enableGizmo,
            enableGrid: settings.enableGrid,
            enableAxes: settings.enableAxes,
            enableMatcap: settings.enableMatcap,
            enablePostProcessing: settings.enablePostProcessing,
            upDirection: settings.upDirection,
            environmentPreset: settings.environmentPreset,
            pinnedMeasurements: settings.pinnedMeasurements,
          },
        });

        const newMap = new Map(context.viewGraphics);
        newMap.set(event.viewId, gfx);
        return { viewGraphics: newMap };
      });
    }),
    destroyViewGraphics: enqueueActions(({ enqueue, context, event }) => {
      assertEvent(event, 'destroyViewGraphics');

      const gfx = context.viewGraphics.get(event.viewId);
      if (!gfx) {
        return;
      }

      enqueue.stopChild(gfx);
      enqueue.assign(({ context }) => {
        const newMap = new Map(context.viewGraphics);
        newMap.delete(event.viewId);
        return { viewGraphics: newMap };
      });
    }),
    emitBuildLoaded: emit(({ event }) => {
      assertEvent(event, 'buildRetrieved');
      return {
        type: 'buildLoaded',
        build: event.build,
      };
    }),
    emitBuildUpdated: emit(({ context }) => ({
      type: 'buildUpdated',
      build: context.build!,
    })),
  },
  guards: {
    isNotBrowser() {
      return !isBrowser;
    },
    shouldAutoLoad() {
      return isBrowser;
    },
    isBuildIdChanging({ context, event }) {
      assertEvent(event, 'loadBuild');
      return context.buildId !== event.buildId;
    },
  },
  delays: {
    storeDebounce: 500,
  },
}).createMachine({
  id: 'build',
  context({ input, spawn, self }) {
    const { buildId, shouldLoadModelOnStart = true, fileManagerRef, kernelOptions } = input;

    const gitRef = spawn('git', {
      id: `git-${buildId}`,
      input: { buildId, parentRef: self, fileManagerRef },
    });

    const logRef = spawn('logs', {
      id: `log-${buildId}`,
    });

    // Compilation units are created dynamically after build loads (when we know the main file).
    // The primary compilation unit is created by initializeKernelIfNeeded.
    const compilationUnits = new Map<string, ActorRefFrom<typeof cadMachine>>();

    // View graphics are created dynamically by Dockview viewer panels.
    const viewGraphics = new Map<string, ActorRefFrom<typeof graphicsMachine>>();

    return {
      buildId,
      build: undefined,
      error: undefined,
      isLoading: true,
      shouldLoadModelOnStart,
      kernelOptions,
      fileManagerRef,
      gitRef,
      viewGraphics,
      compilationUnits,
      mainEntryFile: '',
      logRef,
    };
  },
  on: {},
  exit: ['stopStatefulActors'],
  initial: 'checkEnvironment',
  states: {
    checkEnvironment: {
      always: [
        {
          guard: 'isNotBrowser',
          target: 'ssr',
        },
        {
          guard: 'shouldAutoLoad',
          target: 'loading',
        },
        {
          target: 'idle',
        },
      ],
    },
    ssr: {
      type: 'final',
    },
    idle: {
      on: {
        loadBuild: {
          target: 'loading',
          actions: ['updateBuildId', 'setLoading'],
        },
        // Accept view graphics lifecycle events in idle state so they
        // are not silently dropped if a useEffect fires before loading starts.
        createViewGraphics: {
          actions: 'createViewGraphics',
        },
        destroyViewGraphics: {
          actions: 'destroyViewGraphics',
        },
      },
    },
    loading: {
      entry: 'clearError',
      on: {
        // Accept view graphics lifecycle events during loading.
        // These are safe to process in any state -- they only depend on
        // context.buildId (always set) and defaultGraphicsSettings, with
        // zero dependency on context.build or any loaded data.
        createViewGraphics: {
          actions: 'createViewGraphics',
        },
        destroyViewGraphics: {
          actions: 'destroyViewGraphics',
        },
        buildRetrieved: {
          actions: ['setBuild', 'clearLoading', 'emitBuildLoaded'],
        },
      },
      invoke: {
        src: 'loadBuildActor',
        input: ({ context }) => ({ buildId: context.buildId }),
        onDone: {
          target: 'ready',
          actions: ['initializeKernelIfNeeded'],
        },
        onError: {
          target: 'error',
          actions: ['setError'],
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
            loadBuild: [
              {
                guard: 'isBuildIdChanging',
                target: '#build.loading',
                actions: ['updateBuildId', 'stopStatefulActors', 'respawnStatefulActors', 'setLoading'],
              },
              {
                target: '#build.loading',
                actions: 'setLoading',
              },
            ],
            updateName: {
              actions: ['updateName'],
            },
            updateDescription: {
              actions: ['updateDescription'],
            },
            updateTags: {
              actions: ['updateTags'],
            },
            updateThumbnail: {
              actions: ['updateThumbnail'],
            },
            updateCodeParameters: {
              actions: ['updateCodeParametersInContext'],
            },
            setParameters: {
              actions: ['setParametersInContext'],
            },
            loadModel: {
              actions: 'loadModel',
            },
            setMainFile: {
              actions: 'setMainFileInContext',
            },
            createCompilationUnit: {
              actions: 'createCompilationUnit',
            },
            openInViewer: {
              actions: 'openInViewer',
            },
            destroyCompilationUnit: {
              actions: 'destroyCompilationUnit',
            },
            createViewGraphics: {
              actions: 'createViewGraphics',
            },
            destroyViewGraphics: {
              actions: 'destroyViewGraphics',
            },
          },
        },
        storing: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                updateName: {
                  target: 'pending',
                },
                updateDescription: {
                  target: 'pending',
                },
                updateTags: {
                  target: 'pending',
                },
                updateThumbnail: {
                  target: 'pending',
                },
                updateCodeParameters: {
                  target: 'pending',
                },
                setParameters: {
                  target: 'pending',
                },
                setMainFile: {
                  target: 'pending',
                },
              },
            },
            pending: {
              after: {
                storeDebounce: 'writing',
              },
              on: {
                updateName: {
                  target: 'pending',
                  reenter: true,
                },
                updateDescription: {
                  target: 'pending',
                  reenter: true,
                },
                updateTags: {
                  target: 'pending',
                  reenter: true,
                },
                updateThumbnail: {
                  target: 'pending',
                  reenter: true,
                },
                updateCodeParameters: {
                  target: 'pending',
                  reenter: true,
                },
                setParameters: {
                  target: 'pending',
                  reenter: true,
                },
                setMainFile: {
                  target: 'pending',
                  reenter: true,
                },
                // Immediately bypass debounce and write
                flushNow: { target: 'writing' },
              },
            },
            writing: {
              invoke: {
                src: 'writeBuildActor',
                input({ context }) {
                  return { build: context.build! };
                },
                onDone: {
                  target: 'idle',
                  actions: ['emitBuildUpdated'],
                },
                onError: {
                  target: 'pending',
                  actions: ['setError'],
                },
              },
            },
          },
        },
      },
    },
    error: {
      on: {
        loadBuild: [
          {
            guard: 'isBuildIdChanging',
            target: 'loading',
            actions: ['updateBuildId', 'stopStatefulActors', 'respawnStatefulActors', 'setLoading'],
          },
          {
            target: 'loading',
            actions: 'setLoading',
          },
        ],
      },
    },
  },
});

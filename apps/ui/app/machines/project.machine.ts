import { assign, assertEvent, setup, emit, enqueueActions } from 'xstate';
import type { ActorRefFrom, AnyStateMachine } from 'xstate';
import { produce } from 'immer';
import type { FileParameterConfig, Project } from '@taucad/types';
import type { RuntimeClientOptions } from '@taucad/runtime';
import { isBrowser } from '#constants/browser.constants.js';
import type { GraphicsViewSettings } from '#constants/editor.constants.js';
import { defaultGraphicsSettings } from '#constants/editor.constants.js';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { cadMachine } from '#machines/cad.machine.js';
import { gitMachine } from '#machines/git.machine.js';
import { graphicsMachine } from '#machines/graphics.machine.js';
import { logMachine } from '#machines/logs.machine.js';
import type { fileManagerMachine } from '#machines/file-manager.machine.js';
import { updateSetValues, createSet, deleteSet, switchActiveSet } from '#utils/parameter-config.utils.js';

/**
 * Project Machine Context
 */
export type ProjectContext = {
  projectId: string;
  project: Project | undefined;
  error: Error | undefined;
  isLoading: boolean;
  shouldLoadModelOnStart: boolean;
  kernelOptions: RuntimeClientOptions;
  fileManagerRef: ActorRefFrom<typeof fileManagerMachine>;
  gitRef: ActorRefFrom<typeof gitMachine>;
  /** Per-viewer-panel graphics machines, keyed by Dockview panel ID */
  viewGraphics: Map<string, ActorRefFrom<typeof graphicsMachine>>;
  /** Dynamic compilation units keyed by entry file path. Each is a headless CadMachine+KernelMachine. */
  compilationUnits: Map<string, ActorRefFrom<typeof cadMachine>>;
  /** The main entry file path from project.assets.mechanical.main. Set after project loads. */
  mainEntryFile: string;
  logRef: ActorRefFrom<typeof logMachine>;
  /** Filesystem-based parameter configuration parameters file. */
  parameterConfig: FileParameterConfig | undefined;
};

/**
 * Project Machine Input
 */
type ProjectInput = {
  projectId: string;
  shouldLoadModelOnStart?: boolean;
  fileManagerRef: ActorRefFrom<typeof fileManagerMachine>;
  kernelOptions: RuntimeClientOptions;
};

// Define the actors that the machine can invoke
const loadProjectActor = fromSafeAsync<
  { type: 'projectRetrieved'; project: Project; parameterConfig?: FileParameterConfig },
  { projectId: string }
>(async () => {
  throw new Error(
    'Not implemented. Please supply the `provide.actors.loadProjectActor` option to the project machine.',
  );
});

const writeProjectActor = fromSafeAsync<void, { project: Project }>(async () => {
  throw new Error(
    'Not implemented. Please supply the `provide.actors.writeProjectActor` option to the project machine.',
  );
});

const writeParameterFileActor = fromSafeAsync<void, { projectId: string; config: FileParameterConfig }>(async () => {
  throw new Error(
    'Not implemented. Please supply the `provide.actors.writeParameterFileActor` option to the project machine.',
  );
});

const projectActors = {
  loadProjectActor,
  writeProjectActor,
  writeParameterFileActor,
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
 * Project Machine Events
 */
type ProjectEventInternal =
  | { type: 'loadProject'; projectId: string }
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
  | { type: 'setCompilationUnitParameters'; filePath: string; parameters: Record<string, unknown> }
  | { type: 'parameterFileChanged'; config: FileParameterConfig }
  | { type: 'switchParameterSet'; filePath: string; setName: string }
  | { type: 'createParameterSet'; filePath: string; setName: string; values?: Record<string, unknown> }
  | { type: 'deleteParameterSet'; filePath: string; setName: string }
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
  | { type: 'flushNow' };

type ProjectEvent =
  | ProjectEventInternal
  | { type: 'projectRetrieved'; project: Project; parameterConfig?: FileParameterConfig };

/**
 * Project Machine Emitted Events
 */
type ProjectEmitted =
  | { type: 'projectLoaded'; project: Project }
  | { type: 'error'; error: Error }
  | { type: 'projectUpdated'; project: Project }
  | { type: 'viewerFileRequested'; entryFile: string };

/**
 * Project Machine
 *
 * Manages project lifecycle, storage operations, and filesystem coordination.
 *
 * States:
 * - idle: No project loaded
 * - loading: Loading project from storage
 * - ready: Project loaded and ready
 * - updating: Updating project metadata
 * - creating: Creating a new project
 * - deleting: Deleting a project
 * - error: An error occurred
 */
export const projectMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as ProjectContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as ProjectEvent,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    emitted: {} as ProjectEmitted,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as ProjectInput,
  },
  actors: projectActors,
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
    updateProjectId: assign({
      projectId({ event }) {
        assertEvent(event, 'loadProject');
        return event.projectId;
      },
    }),
    setProject: assign({
      project({ event }) {
        assertEvent(event, 'projectRetrieved');
        return event.project;
      },
      parameterConfig({ event }) {
        assertEvent(event, 'projectRetrieved');
        return event.parameterConfig;
      },
      isLoading: false,
    }),
    clearProject: assign({
      project: undefined,
    }),
    updateName: assign(({ context, event }) => {
      assertEvent(event, 'updateName');
      if (!context.project) {
        return {};
      }

      return produce(context, (draft) => {
        draft.project!.name = event.name;
        draft.project!.updatedAt = Date.now();
      });
    }),
    updateDescription: assign(({ context, event }) => {
      assertEvent(event, 'updateDescription');
      if (!context.project) {
        return {};
      }

      return produce(context, (draft) => {
        draft.project!.description = event.description;
        draft.project!.updatedAt = Date.now();
      });
    }),
    updateTags: assign(({ context, event }) => {
      assertEvent(event, 'updateTags');
      if (!context.project) {
        return {};
      }

      // Deduplicate tags to ensure uniqueness
      const uniqueTags = [...new Set(event.tags)];

      return produce(context, (draft) => {
        draft.project!.tags = uniqueTags;
        // Don't update updatedAt for tags - they're metadata
      });
    }),
    updateThumbnail: assign(({ context, event }) => {
      assertEvent(event, 'updateThumbnail');
      if (!context.project) {
        return {};
      }

      return produce(context, (draft) => {
        draft.project!.thumbnail = event.thumbnail;
        // Don't update updatedAt for thumbnails - they're metadata
      });
    }),
    updateCodeParametersInContext: enqueueActions(({ enqueue, context, event }) => {
      assertEvent(event, 'updateCodeParameters');

      if (!context.project?.assets.mechanical) {
        return;
      }

      // Update project in context using Immer
      enqueue.assign(({ context }) =>
        produce(context, (draft) => {
          if (draft.project?.assets.mechanical) {
            draft.project.assets.mechanical.parameters = event.parameters;
            draft.project.updatedAt = Date.now();
          }
        }),
      );
    }),
    setParametersInContext: assign(({ context, event }) => {
      assertEvent(event, 'setParameters');
      if (!context.parameterConfig) {
        return {};
      }

      const filePath = context.mainEntryFile;
      const activeSet = context.parameterConfig.files[filePath]?.activeSet ?? 'default';
      const newConfig = updateSetValues(context.parameterConfig, {
        filePath,
        setName: activeSet,
        values: event.parameters,
      });
      return { parameterConfig: newConfig };
    }),
    setCompilationUnitParametersInContext: assign(({ context, event }) => {
      assertEvent(event, 'setCompilationUnitParameters');
      if (!context.parameterConfig) {
        return {};
      }

      const activeSet = context.parameterConfig.files[event.filePath]?.activeSet ?? 'default';
      const newConfig = updateSetValues(context.parameterConfig, {
        filePath: event.filePath,
        setName: activeSet,
        values: event.parameters,
      });
      return { parameterConfig: newConfig };
    }),
    handleParameterFileChanged: assign(({ event }) => {
      assertEvent(event, 'parameterFileChanged');
      return { parameterConfig: event.config };
    }),
    handleSwitchParameterSet: assign(({ context, event }) => {
      assertEvent(event, 'switchParameterSet');
      if (!context.parameterConfig) {
        return {};
      }
      return { parameterConfig: switchActiveSet(context.parameterConfig, event.filePath, event.setName) };
    }),
    handleCreateParameterSet: assign(({ context, event }) => {
      assertEvent(event, 'createParameterSet');
      if (!context.parameterConfig) {
        return {};
      }
      return {
        parameterConfig: createSet(context.parameterConfig, {
          filePath: event.filePath,
          setName: event.setName,
          values: event.values ?? {},
        }),
      };
    }),
    handleDeleteParameterSet: assign(({ context, event }) => {
      assertEvent(event, 'deleteParameterSet');
      if (!context.parameterConfig) {
        return {};
      }
      return { parameterConfig: deleteSet(context.parameterConfig, event.filePath, event.setName) };
    }),
    setMainFileInContext: assign(({ context, event }) => {
      assertEvent(event, 'setMainFile');
      if (!context.project?.assets.mechanical) {
        return {};
      }

      return produce(context, (draft) => {
        if (draft.project?.assets.mechanical) {
          draft.project.assets.mechanical.main = event.path;
          draft.project.updatedAt = Date.now();
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
      gitRef({ context, spawn }) {
        return spawn('git', {
          id: `git-${context.projectId}`,
          input: {
            projectId: context.projectId,
            fileManagerRef: context.fileManagerRef,
          },
        });
      },
      // Reset compilation units - the primary one will be created during initializeKernelIfNeeded after project load
      compilationUnits: () => new Map(),
      mainEntryFile: () => '',
      // Reset view graphics - they'll be created by Dockview viewer panels
      viewGraphics: () => new Map(),
    }),
    initializeKernelIfNeeded: enqueueActions(({ enqueue, context }) => {
      if (!context.shouldLoadModelOnStart) {
        return;
      }

      const mechanicalAsset = context.project?.assets.mechanical;
      if (!mechanicalAsset) {
        return;
      }

      const mainFile = mechanicalAsset.main;

      if (context.compilationUnits.has(mainFile)) {
        enqueue.assign({ mainEntryFile: mainFile });
        const existingUnit = context.compilationUnits.get(mainFile)!;
        enqueue.sendTo(existingUnit, {
          type: 'initializeModel',
          file: {
            path: `/projects/${context.projectId}`,
            filename: mainFile,
          },
        });
      } else {
        enqueue.assign(({ spawn, context }) => {
          const cadUnit = spawn('cad', {
            id: `cad-${context.projectId}-${mainFile.replaceAll('/', '-')}`,
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
              path: `/projects/${context.projectId}`,
              filename: mainFile,
            },
          });

          const newUnits = new Map(context.compilationUnits);
          newUnits.set(mainFile, cadUnit as ActorRefFrom<typeof cadMachine>);
          return { compilationUnits: newUnits, mainEntryFile: mainFile };
        });
      }
    }),
    loadModel: enqueueActions(({ enqueue, context }) => {
      const mechanicalAsset = context.project?.assets.mechanical;
      if (!mechanicalAsset) {
        return;
      }

      const mainFile = mechanicalAsset.main;

      const mainUnit = context.compilationUnits.get(mainFile);
      if (mainUnit) {
        enqueue.sendTo(mainUnit, {
          type: 'initializeModel',
          file: {
            path: `/projects/${context.projectId}`,
            filename: mainFile,
          },
        });
      } else {
        enqueue.assign(({ spawn, context }) => {
          const cadUnit = spawn('cad', {
            id: `cad-${context.projectId}-${mainFile.replaceAll('/', '-')}`,
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
              path: `/projects/${context.projectId}`,
              filename: mainFile,
            },
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
          id: `cad-${context.projectId}-${event.entryFile.replaceAll('/', '-')}`,
          input: {
            shouldInitializeKernelOnStart: true,
            logRef: context.logRef,
            fileManagerRef: context.fileManagerRef,
            kernelOptions: context.kernelOptions,
          },
        });

        cadUnit.send({
          type: 'initializeModel',
          file: {
            path: `/projects/${context.projectId}`,
            filename: event.entryFile,
          },
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
          id: `graphics-view-${context.projectId}-${event.viewId}`,
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
    emitProjectLoaded: emit(({ event }) => {
      assertEvent(event, 'projectRetrieved');
      return {
        type: 'projectLoaded',
        project: event.project,
      };
    }),
    emitProjectUpdated: emit(({ context }) => ({
      type: 'projectUpdated',
      project: context.project!,
    })),
  },
  guards: {
    isNotBrowser() {
      return !isBrowser;
    },
    shouldAutoLoad() {
      return isBrowser;
    },
    isProjectIdChanging({ context, event }) {
      assertEvent(event, 'loadProject');
      return context.projectId !== event.projectId;
    },
    hasParameterConfig({ context }) {
      return context.parameterConfig !== undefined;
    },
  },
  delays: {
    /** Zero-delay batching step so `pending` can handle `flushNow` before transitioning to `writing`. */
    pendingToWriting: 0,
  },
}).createMachine({
  id: 'project',
  context({ input, spawn }) {
    const { projectId, shouldLoadModelOnStart = true, fileManagerRef, kernelOptions } = input;

    const gitRef = spawn('git', {
      id: `git-${projectId}`,
      input: { projectId, fileManagerRef },
    });

    const logRef = spawn('logs', {
      id: `log-${projectId}`,
    });

    // Compilation units are created dynamically after project loads (when we know the main file).
    // The primary compilation unit is created by initializeKernelIfNeeded.
    const compilationUnits = new Map<string, ActorRefFrom<typeof cadMachine>>();

    // View graphics are created dynamically by Dockview viewer panels.
    const viewGraphics = new Map<string, ActorRefFrom<typeof graphicsMachine>>();

    return {
      projectId,
      project: undefined,
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
      parameterConfig: undefined,
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
        loadProject: {
          target: 'loading',
          actions: ['updateProjectId', 'setLoading'],
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
        // context.projectId (always set) and defaultGraphicsSettings, with
        // zero dependency on context.project or any loaded data.
        createViewGraphics: {
          actions: 'createViewGraphics',
        },
        destroyViewGraphics: {
          actions: 'destroyViewGraphics',
        },
        projectRetrieved: {
          actions: ['setProject', 'clearLoading', 'emitProjectLoaded'],
        },
      },
      invoke: {
        src: 'loadProjectActor',
        input: ({ context }) => ({ projectId: context.projectId }),
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
            loadProject: [
              {
                guard: 'isProjectIdChanging',
                target: '#project.loading',
                actions: ['updateProjectId', 'stopStatefulActors', 'respawnStatefulActors', 'setLoading'],
              },
              {
                target: '#project.loading',
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
            setCompilationUnitParameters: {
              actions: ['setCompilationUnitParametersInContext'],
            },
            parameterFileChanged: {
              actions: ['handleParameterFileChanged'],
            },
            switchParameterSet: {
              actions: ['handleSwitchParameterSet'],
            },
            createParameterSet: {
              actions: ['handleCreateParameterSet'],
            },
            deleteParameterSet: {
              actions: ['handleDeleteParameterSet'],
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
                  target: 'writing',
                },
                updateDescription: {
                  target: 'writing',
                },
                updateTags: {
                  target: 'writing',
                },
                updateThumbnail: {
                  target: 'writing',
                },
                updateCodeParameters: {
                  target: 'writing',
                },
                setMainFile: {
                  target: 'writing',
                },
              },
            },
            pending: {
              after: {
                pendingToWriting: 'writing',
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
                setMainFile: {
                  target: 'pending',
                  reenter: true,
                },
                flushNow: { target: 'writing' },
              },
            },
            writing: {
              invoke: {
                src: 'writeProjectActor',
                input({ context }) {
                  return { project: context.project! };
                },
                onDone: {
                  target: 'idle',
                  actions: ['emitProjectUpdated'],
                },
                onError: {
                  target: 'idle',
                  actions: ['setError'],
                },
              },
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
                setMainFile: {
                  target: 'pending',
                },
              },
            },
          },
        },
        parameterStoring: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                setParameters: { guard: 'hasParameterConfig', target: 'writing' },
                setCompilationUnitParameters: { guard: 'hasParameterConfig', target: 'writing' },
                switchParameterSet: { guard: 'hasParameterConfig', target: 'writing' },
                createParameterSet: { guard: 'hasParameterConfig', target: 'writing' },
                deleteParameterSet: { guard: 'hasParameterConfig', target: 'writing' },
              },
            },
            pending: {
              after: {
                pendingToWriting: 'writing',
              },
              on: {
                setParameters: { guard: 'hasParameterConfig', target: 'pending', reenter: true },
                setCompilationUnitParameters: { guard: 'hasParameterConfig', target: 'pending', reenter: true },
                switchParameterSet: { guard: 'hasParameterConfig', target: 'pending', reenter: true },
                createParameterSet: { guard: 'hasParameterConfig', target: 'pending', reenter: true },
                deleteParameterSet: { guard: 'hasParameterConfig', target: 'pending', reenter: true },
              },
            },
            writing: {
              invoke: {
                src: 'writeParameterFileActor',
                input({ context }) {
                  return {
                    projectId: context.projectId,
                    config: context.parameterConfig!,
                  };
                },
                onDone: { target: 'idle' },
                onError: {
                  target: 'idle',
                  actions: ['setError'],
                },
              },
              on: {
                setParameters: { guard: 'hasParameterConfig', target: 'pending' },
                setCompilationUnitParameters: { guard: 'hasParameterConfig', target: 'pending' },
                switchParameterSet: { guard: 'hasParameterConfig', target: 'pending' },
                createParameterSet: { guard: 'hasParameterConfig', target: 'pending' },
                deleteParameterSet: { guard: 'hasParameterConfig', target: 'pending' },
              },
            },
          },
        },
      },
    },
    error: {
      on: {
        loadProject: [
          {
            guard: 'isProjectIdChanging',
            target: 'loading',
            actions: ['updateProjectId', 'stopStatefulActors', 'respawnStatefulActors', 'setLoading'],
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

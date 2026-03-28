import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useCallback, useEffect } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { waitFor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { Remote } from 'comlink';
import { useQueryClient } from '@tanstack/react-query';
import type { FileParameterConfig } from '@taucad/types';
import type { RuntimeClientOptions } from '@taucad/runtime';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import type { ObjectStoreWorker } from '#hooks/object-store.worker.js';
import { projectMachine } from '#machines/project.machine.js';
import type { gitMachine } from '#machines/git.machine.js';
import { editorMachine } from '#machines/editor.machine.js';
import type { cadMachine } from '#machines/cad.machine.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import type { logMachine } from '#machines/logs.machine.js';
import { inspect } from '#machines/inspector.js';
import { useProjectManager } from '#hooks/use-project-manager.js';
import { defaultKernelOptions } from '#constants/kernel-worker.constants.js';
import { parseParameterConfig, createDefaultConfig, serializeParameterConfig } from '#utils/parameter-config.utils.js';

type ProjectContextType = {
  projectId: string;
  projectRef: ActorRefFrom<typeof projectMachine>;
  editorRef: ActorRefFrom<typeof editorMachine>;
  gitRef: ActorRefFrom<typeof gitMachine>;
  /** Per-viewer-panel graphics machines, keyed by Dockview panel ID */
  viewGraphics: Map<string, ActorRefFrom<typeof graphicsMachine>>;
  /** Dynamic compilation units keyed by entry file path. Each is a headless CadMachine+KernelMachine. */
  compilationUnits: Map<string, ActorRefFrom<typeof cadMachine>>;
  /** The main entry file path from project.assets.mechanical.main. */
  mainEntryFile: string;
  logRef: ActorRefFrom<typeof logMachine>;
  setCodeParameters: (
    files: Record<string, { content: Uint8Array<ArrayBuffer> }>,
    parameters: Record<string, unknown>,
  ) => void;
  setParameters: (parameters: Record<string, unknown>) => void;
  setCompilationUnitParameters: (filePath: string, parameters: Record<string, unknown>) => void;
  switchParameterSet: (filePath: string, setName: string) => void;
  createParameterSet: (filePath: string, setName: string, values?: Record<string, unknown>) => void;
  deleteParameterSet: (filePath: string, setName: string) => void;
  parameterConfig: FileParameterConfig | undefined;
  updateName: (name: string) => void;
  updateDescription: (description: string) => void;
  updateTags: (tags: string[]) => void;
  updateThumbnail: (thumbnail: string) => void;
  getMainFilename: () => Promise<string>;
  setLastChatId: (chatId: string) => void;
};

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export function ProjectProvider({
  children,
  projectId,
  provide,
  input,
  kernelOptions,
}: {
  readonly children: ReactNode;
  readonly projectId: string;
  readonly provide?: Parameters<typeof projectMachine.provide>[0];
  readonly input?: Omit<
    Parameters<typeof useActorRef<typeof projectMachine>>[1]['input'],
    'projectId' | 'fileManagerRef' | 'kernelOptions'
  >;
  readonly kernelOptions?: RuntimeClientOptions;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  // Create the project machine actor - it will auto-load based on projectId
  const fileManager = useFileManager();
  const projectManager = useProjectManager();

  const actorRef = useActorRef(
    projectMachine.provide({
      actors: {
        loadProjectActor: fromSafeAsync(async ({ input }) => {
          const project = await projectManager.getProject(input.projectId);
          if (!project) {
            throw new Error(`Project not found: ${input.projectId}`);
          }

          const readySnapshot = await waitFor(fileManager.fileManagerRef, (state) => state.matches('ready'));

          const parameterConfigPath = `.tau/parameters.json`;
          let parameterConfig: FileParameterConfig | undefined;

          const { contentService } = readySnapshot.context;
          if (contentService) {
            try {
              const data = await contentService.resolve(parameterConfigPath);
              const text = new TextDecoder().decode(data);
              parameterConfig = parseParameterConfig(text);
            } catch {
              const mainFile = project.assets.mechanical?.main ?? 'main.ts';
              parameterConfig = createDefaultConfig(mainFile);
              const serialized = serializeParameterConfig(parameterConfig);
              await contentService.write(parameterConfigPath, new TextEncoder().encode(serialized), 'machine');
            }
          }

          return {
            type: 'projectRetrieved',
            project,
            ...(parameterConfig ? { parameterConfig } : {}),
          };
        }),
        writeProjectActor: fromSafeAsync(async ({ input }) => {
          await projectManager.updateProject(input.project.id, input.project);
        }),
        writeParameterFileActor: fromSafeAsync(async ({ input, signal }) => {
          if (signal.aborted) {
            return;
          }
          const parameterConfigPath = `.tau/parameters.json`;
          const serialized = serializeParameterConfig(input.config);
          const encoded = new TextEncoder().encode(serialized);
          if (encoded.byteLength === 0) {
            return;
          }
          const { contentService } = fileManager.fileManagerRef.getSnapshot().context;
          if (contentService) {
            await contentService.write(parameterConfigPath, encoded, 'machine');
          }
        }),
      },
      ...provide,
    }),
    {
      input: {
        projectId,
        fileManagerRef: fileManager.fileManagerRef,
        kernelOptions: kernelOptions ?? defaultKernelOptions,
        ...input,
      },
      inspect,
    },
  );

  // Get the worker for Editor state persistence
  const getReadiedWorker = useCallback(async (): Promise<Remote<ObjectStoreWorker>> => {
    const snapshot = await waitFor(
      projectManager.projectManagerRef,
      (state) => state.matches('ready') || state.matches('error'),
    );
    if (snapshot.matches('error')) {
      throw new Error('Project manager worker failed to initialize');
    }

    if (!snapshot.context.wrappedWorker) {
      throw new Error('Project manager worker not initialized');
    }

    return snapshot.context.wrappedWorker;
  }, [projectManager.projectManagerRef]);

  // Create Editor state machine with provided actors
  const editorRef = useActorRef(
    editorMachine.provide({
      actors: {
        loadEditorStateActor: fromSafeAsync(async ({ input }) => {
          const worker = await getReadiedWorker();
          const state = await worker.getEditorState(input.projectId);
          return { type: 'editorStateRetrieved', state };
        }),
        saveEditorStateActor: fromSafeAsync(async ({ input }) => {
          const worker = await getReadiedWorker();
          await worker.updateEditorState(input.editorState);
        }),
      },
    }),
    {
      input: { projectId },
      inspect,
    },
  );

  // Select state from the machine
  const gitRef = useSelector(actorRef, (state) => state.context.gitRef);
  const viewGraphics = useSelector(actorRef, (state) => state.context.viewGraphics);
  const compilationUnits = useSelector(actorRef, (state) => state.context.compilationUnits);
  const mainEntryFile = useSelector(
    actorRef,

    (state) => state.context.mainEntryFile,
  );
  const logRef = useSelector(actorRef, (state) => state.context.logRef);
  const parameterConfig = useSelector(actorRef, (state) => state.context.parameterConfig);

  useEffect(() => {
    // Load the new project when the projectId changes
    actorRef.send({ type: 'loadProject', projectId });

    // Reload Editor state for new project (also clears open files via closeAll in updateProjectId)
    editorRef.send({ type: 'reload', projectId });
  }, [actorRef, projectId, editorRef]);

  // Coordinate: load Editor state after project loads
  useEffect(() => {
    const projectLoadedSub = actorRef.on('projectLoaded', () => {
      // Project loaded, now load Editor state
      editorRef.send({ type: 'load' });
    });

    return () => {
      projectLoadedSub.unsubscribe();
    };
  }, [actorRef, editorRef]);

  useEffect(() => {
    const subscription = actorRef.on('projectUpdated', () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [actorRef, queryClient]);

  // Subscribe to external parameter file changes
  useEffect(() => {
    const { contentService } = fileManager;
    if (!contentService) {
      return;
    }

    const parameterPath = `.tau/parameters.json`;
    const unsubscribe = contentService.onDidContentChange((event) => {
      if (event.type !== 'written' || event.path !== parameterPath || event.source === 'machine') {
        return;
      }
      try {
        const text = new TextDecoder().decode(event.data);
        const config = parseParameterConfig(text);
        actorRef.send({ type: 'parameterFileChanged', config });
      } catch {
        // Invalid JSON — ignore
      }
    });

    return unsubscribe;
  }, [fileManager, projectId, actorRef]);

  // Memoize callbacks
  const setCodeParameters = useCallback(
    (files: Record<string, { content: Uint8Array<ArrayBuffer> }>, parameters: Record<string, unknown>) => {
      actorRef.send({ type: 'updateCodeParameters', files, parameters });
    },
    [actorRef],
  );

  const setParameters = useCallback(
    (parameters: Record<string, unknown>) => {
      actorRef.send({ type: 'setParameters', parameters });
    },
    [actorRef],
  );

  const setCompilationUnitParameters = useCallback(
    (filePath: string, parameters: Record<string, unknown>) => {
      actorRef.send({ type: 'setCompilationUnitParameters', filePath, parameters });
    },
    [actorRef],
  );

  const switchParameterSet = useCallback(
    (filePath: string, setName: string) => {
      actorRef.send({ type: 'switchParameterSet', filePath, setName });
    },
    [actorRef],
  );

  const createParameterSet = useCallback(
    (filePath: string, setName: string, values?: Record<string, unknown>) => {
      actorRef.send({ type: 'createParameterSet', filePath, setName, values });
    },
    [actorRef],
  );

  const deleteParameterSet = useCallback(
    (filePath: string, setName: string) => {
      actorRef.send({ type: 'deleteParameterSet', filePath, setName });
    },
    [actorRef],
  );

  const updateName = useCallback(
    (name: string) => {
      actorRef.send({ type: 'updateName', name });
    },
    [actorRef],
  );

  const updateDescription = useCallback(
    (description: string) => {
      actorRef.send({ type: 'updateDescription', description });
    },
    [actorRef],
  );

  const updateTags = useCallback(
    (tags: string[]) => {
      actorRef.send({ type: 'updateTags', tags });
    },
    [actorRef],
  );

  const updateThumbnail = useCallback(
    (thumbnail: string) => {
      actorRef.send({ type: 'updateThumbnail', thumbnail });
    },
    [actorRef],
  );

  const setLastChatId = useCallback(
    (chatId: string) => {
      editorRef.send({ type: 'setLastChatId', chatId });
    },
    [editorRef],
  );

  const getMainFilename = useCallback(async () => {
    const snapshot = await waitFor(actorRef, (state) => Boolean(state.context.project?.assets.mechanical?.main));

    if (!snapshot.context.project?.assets.mechanical?.main) {
      throw new Error('Main file not found');
    }

    return snapshot.context.project.assets.mechanical.main;
  }, [actorRef]);

  const value = useMemo<ProjectContextType>(() => {
    return {
      projectId,
      projectRef: actorRef,
      editorRef,
      gitRef,
      viewGraphics,
      compilationUnits,
      mainEntryFile,
      logRef,
      parameterConfig,
      setCodeParameters,
      setParameters,
      setCompilationUnitParameters,
      switchParameterSet,
      createParameterSet,
      deleteParameterSet,
      updateName,
      updateDescription,
      updateTags,
      updateThumbnail,
      setLastChatId,
      getMainFilename,
    };
  }, [
    projectId,
    actorRef,
    editorRef,
    gitRef,
    viewGraphics,
    compilationUnits,
    mainEntryFile,
    logRef,
    parameterConfig,
    setCodeParameters,
    setParameters,
    setCompilationUnitParameters,
    switchParameterSet,
    createParameterSet,
    deleteParameterSet,
    updateName,
    updateDescription,
    updateTags,
    updateThumbnail,
    setLastChatId,
    getMainFilename,
  ]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/**
 * Find the graphics actor for the viewer panel displaying the main entry file.
 * Falls back to the first available graphics actor from viewGraphics.
 * Returns undefined when no viewGraphics exist (e.g. before any viewer panel mounts).
 * Used by external consumers (screenshot, RPC handlers, parameters) that are NOT inside a GraphicsProvider.
 */
export function useMainGraphics(): ActorRefFrom<typeof graphicsMachine> | undefined {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useMainGraphics must be used within a ProjectProvider');
  }

  const { viewGraphics, editorRef, mainEntryFile } = context;

  const viewSettings = useSelector(editorRef, (state) => state.context.viewSettings);

  // Find a viewer panel showing mainEntryFile
  for (const [viewId, graphicsRef] of viewGraphics) {
    const settings = viewSettings[viewId];
    if (settings?.entryFile === mainEntryFile) {
      return graphicsRef;
    }
  }

  // Fallback: return the first available graphics actor from viewGraphics
  const firstViewGraphics = viewGraphics.values().next().value;
  if (firstViewGraphics) {
    return firstViewGraphics;
  }

  return undefined;
}

export function useProject<T extends ProjectContextType = ProjectContextType>(options?: {
  readonly enableNoContext?: false;
}): T;
export function useProject<T extends ProjectContextType = ProjectContextType>(options: {
  readonly enableNoContext: true;
}): T | undefined;
export function useProject({ enableNoContext = false }: { readonly enableNoContext?: boolean } = {}):
  | ProjectContextType
  | undefined {
  const context = useContext(ProjectContext);
  if (context === undefined && !enableNoContext) {
    throw new Error('useProject must be used within a ProjectProvider');
  }

  return context;
}

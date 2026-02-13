import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useCallback, useEffect } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { fromPromise, waitFor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { Remote } from 'comlink';
import { useQueryClient } from '@tanstack/react-query';
import { useFileManager } from '#hooks/use-file-manager.js';
import type { ObjectStoreWorker } from '#hooks/object-store.worker.js';
import { buildMachine } from '#machines/build.machine.js';
import type { gitMachine } from '#machines/git.machine.js';
import { editorMachine } from '#machines/editor.machine.js';
import type { cadMachine } from '#machines/cad.machine.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import type { logMachine } from '#machines/logs.machine.js';
import { inspect } from '#machines/inspector.js';
import { useBuildManager } from '#hooks/use-build-manager.js';

type BuildContextType = {
  buildId: string;
  buildRef: ActorRefFrom<typeof buildMachine>;
  editorRef: ActorRefFrom<typeof editorMachine>;
  gitRef: ActorRefFrom<typeof gitMachine>;
  /** Per-viewer-panel graphics machines, keyed by Dockview panel ID */
  viewGraphics: Map<string, ActorRefFrom<typeof graphicsMachine>>;
  /** Dynamic compilation units keyed by entry file path. Each is a headless CadMachine+KernelMachine. */
  compilationUnits: Map<string, ActorRefFrom<typeof cadMachine>>;
  /** The main entry file path from build.assets.mechanical.main. */
  mainEntryFile: string;
  logRef: ActorRefFrom<typeof logMachine>;
  setCodeParameters: (
    files: Record<string, { content: Uint8Array<ArrayBuffer> }>,
    parameters: Record<string, unknown>,
  ) => void;
  setParameters: (parameters: Record<string, unknown>) => void;
  updateName: (name: string) => void;
  updateDescription: (description: string) => void;
  updateTags: (tags: string[]) => void;
  updateThumbnail: (thumbnail: string) => void;
  getMainFilename: () => Promise<string>;
  setLastChatId: (chatId: string) => void;
};

const BuildContext = createContext<BuildContextType | undefined>(undefined);

export function BuildProvider({
  children,
  buildId,
  provide,
  input,
}: {
  readonly children: ReactNode;
  readonly buildId: string;
  readonly provide?: Parameters<typeof buildMachine.provide>[0];
  readonly input?: Omit<Parameters<typeof useActorRef<typeof buildMachine>>[1]['input'], 'buildId' | 'fileManagerRef'>;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  // Create the build machine actor - it will auto-load based on buildId
  const fileManager = useFileManager();
  const buildManager = useBuildManager();

  const actorRef = useActorRef(
    buildMachine.provide({
      actors: {
        loadBuildActor: fromPromise(async ({ input }) => {
          const build = await buildManager.getBuild(input.buildId);
          if (!build) {
            throw new Error(`Build not found: ${input.buildId}`);
          }

          // Ensure the file manager is ready before loading the build
          await waitFor(fileManager.fileManagerRef, (state) => state.matches('ready'));

          return build;
        }),
        writeBuildActor: fromPromise(async ({ input }) => {
          await buildManager.updateBuild(input.build.id, input.build);
        }),
      },
      ...provide,
    }),
    {
      input: { buildId, fileManagerRef: fileManager.fileManagerRef, ...input },
      inspect,
    },
  );

  // Get the worker for Editor state persistence
  const getReadiedWorker = useCallback(async (): Promise<Remote<ObjectStoreWorker>> => {
    const snapshot = await waitFor(
      buildManager.buildManagerRef,
      (state) => state.matches('ready') || state.matches('error'),
    );
    if (snapshot.matches('error')) {
      throw new Error('Build manager worker failed to initialize');
    }

    if (!snapshot.context.wrappedWorker) {
      throw new Error('Build manager worker not initialized');
    }

    return snapshot.context.wrappedWorker;
  }, [buildManager.buildManagerRef]);

  // Create Editor state machine with provided actors
  const editorRef = useActorRef(
    editorMachine.provide({
      actors: {
        loadEditorStateActor: fromPromise(async ({ input }) => {
          const worker = await getReadiedWorker();
          return worker.getEditorState(input.buildId);
        }),
        saveEditorStateActor: fromPromise(async ({ input }) => {
          const worker = await getReadiedWorker();
          await worker.updateEditorState(input.editorState);
        }),
      },
    }),
    {
      input: { buildId },
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

  useEffect(() => {
    // FileManager → Compilation Units coordination.
    // When any file is written, re-trigger ALL compilation units with their own entry file.
    // Each unit re-compiles its entry point, picking up any changed imports from the written file.
    // No distinction between machine/user writes -- all writes are treated identically.
    const fileWrittenSub = fileManager.fileManagerRef.on('fileWritten', () => {
      const snapshot = actorRef.getSnapshot();
      const units = snapshot.context.compilationUnits;
      for (const [entryFile, unit] of units) {
        unit.send({
          type: 'setFile',
          file: { path: `/builds/${buildId}`, filename: entryFile },
        });
      }
    });

    return () => {
      fileWrittenSub.unsubscribe();
    };
  }, [fileManager.fileManagerRef, actorRef, buildId]);

  useEffect(() => {
    // Load the new build when the buildId changes
    actorRef.send({ type: 'loadBuild', buildId });

    // Reload Editor state for new build (also clears open files via closeAll in updateBuildId)
    editorRef.send({ type: 'reload', buildId });
  }, [actorRef, buildId, editorRef]);

  // Coordinate: load Editor state after build loads
  useEffect(() => {
    const buildLoadedSub = actorRef.on('buildLoaded', () => {
      // Build loaded, now load Editor state
      editorRef.send({ type: 'load' });
    });

    return () => {
      buildLoadedSub.unsubscribe();
    };
  }, [actorRef, editorRef]);

  useEffect(() => {
    const subscription = actorRef.on('buildUpdated', () => {
      // The build updated, invalidate the builds query
      void queryClient.invalidateQueries({ queryKey: ['builds'] });
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [actorRef, queryClient]);

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
    const snapshot = await waitFor(actorRef, (state) => Boolean(state.context.build?.assets.mechanical?.main));

    if (!snapshot.context.build?.assets.mechanical?.main) {
      throw new Error('Main file not found');
    }

    return snapshot.context.build.assets.mechanical.main;
  }, [actorRef]);

  const value = useMemo<BuildContextType>(() => {
    return {
      buildId,
      buildRef: actorRef,
      editorRef,
      gitRef,
      viewGraphics,
      compilationUnits,
      mainEntryFile,
      logRef,
      setCodeParameters,
      setParameters,
      updateName,
      updateDescription,
      updateTags,
      updateThumbnail,
      setLastChatId,
      getMainFilename,
    };
  }, [
    buildId,
    actorRef,
    editorRef,
    gitRef,
    viewGraphics,
    compilationUnits,
    mainEntryFile,
    logRef,
    setCodeParameters,
    setParameters,
    updateName,
    updateDescription,
    updateTags,
    updateThumbnail,
    setLastChatId,
    getMainFilename,
  ]);

  return <BuildContext.Provider value={value}>{children}</BuildContext.Provider>;
}

/**
 * Find the graphics actor for the viewer panel displaying the main entry file.
 * Falls back to the first available graphics actor from viewGraphics.
 * Returns undefined when no viewGraphics exist (e.g. before any viewer panel mounts).
 * Used by external consumers (screenshot, RPC handlers, parameters) that are NOT inside a GraphicsProvider.
 */
export function useMainGraphics(): ActorRefFrom<typeof graphicsMachine> | undefined {
  const context = useContext(BuildContext);
  if (!context) {
    throw new Error('useMainGraphics must be used within a BuildProvider');
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

export function useBuild<T extends BuildContextType = BuildContextType>(options?: {
  readonly enableNoContext?: false;
}): T;
export function useBuild<T extends BuildContextType = BuildContextType>(options: {
  readonly enableNoContext: true;
}): T | undefined;
export function useBuild({ enableNoContext = false }: { readonly enableNoContext?: boolean } = {}):
  | BuildContextType
  | undefined {
  const context = useContext(BuildContext);
  if (context === undefined && !enableNoContext) {
    throw new Error('useBuild must be used within a BuildProvider');
  }

  return context;
}

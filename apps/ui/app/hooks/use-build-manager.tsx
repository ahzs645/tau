import type { ReactNode } from 'react';
import type { PartialDeep } from 'type-fest';
import { createContext, useContext, useMemo, useCallback, useEffect } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { waitFor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { Build, FilesystemBackend, KernelProvider } from '@taucad/types';
import type { Chat } from '@taucad/chat';
import type { Remote } from 'comlink';
import { messageRole, messageStatus } from '@taucad/chat/constants';
import { buildManagerMachine } from '#hooks/build-manager.machine.js';
import type { ObjectStoreWorker, InitialEditorState } from '#hooks/object-store.worker.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { setBuildFilesystemConfig, getStoredDirectoryHandle, checkHandlePermission } from '#filesystem/handle-store.js';
import { createInitialBuild } from '#constants/build.constants.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import { createMessage } from '#utils/chat.utils.js';
import { getMainFile, getEmptyCode } from '#utils/kernel.utils.js';
import { encodeTextFile } from '#utils/filesystem.utils.js';
import { defaultBuildName } from '#constants/build-names.js';

/**
 * Shared options for initial chat configuration.
 */
type CreateBuildChatOptions = {
  /** If provided, add to chat (triggers AI response) */
  initialMessage?: {
    content: string;
    model: string;
    metadata?: Record<string, unknown>;
    imageUrls?: string[];
  };
  /** Chat name (defaults to 'Initial design' with message, 'Initial chat' without) */
  chatName?: string;
  /** Initial editor state overrides (e.g., panelState for initial panel layout) */
  editorState?: InitialEditorState;
};

/**
 * Create a new empty build from a kernel template.
 * Use this when starting a fresh build from scratch.
 */
type CreateBuildFromKernel = CreateBuildChatOptions & {
  /** The kernel/language to use for the new build */
  kernel: KernelProvider;
  /** Override default build name */
  buildName?: string;
};

/**
 * Create a build from existing build data and files.
 * Use this when cloning, remixing, or importing a build.
 */
type CreateBuildFromData = CreateBuildChatOptions & {
  /** The build metadata to use */
  build: Omit<Build, 'id' | 'createdAt' | 'updatedAt'>;
  /** The files for the build */
  files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
};

/**
 * Options for creating a build with an associated chat.
 * Either create from a kernel template (new build) or from existing data (clone/remix).
 */
export type CreateBuildOptions = CreateBuildFromKernel | CreateBuildFromData;

type BuildManagerContextType = {
  isLoading: boolean;
  error: Error | undefined;
  buildManagerRef: ActorRefFrom<typeof buildManagerMachine>;
  createBuild: (options: CreateBuildOptions) => Promise<Build>;
  updateBuild: (
    buildId: string,
    update: PartialDeep<Build>,
    options?: {
      ignoreKeys?: string[];
      noUpdatedAt?: boolean;
    },
  ) => Promise<Build | undefined>;
  duplicateBuild: (buildId: string) => Promise<Build>;
  getBuilds: (options?: { includeDeleted?: boolean }) => Promise<Build[]>;
  getBuild: (buildId: string) => Promise<Build | undefined>;
  deleteBuild: (buildId: string) => Promise<void>;
  // Chat methods
  createChat: (
    resourceId: string,
    chat: Omit<Chat, 'id' | 'resourceId' | 'createdAt' | 'updatedAt'> & { id?: string },
  ) => Promise<Chat>;
  updateChat: (
    chatId: string,
    update: PartialDeep<Chat>,
    options?: {
      ignoreKeys?: string[];
      noUpdatedAt?: boolean;
    },
  ) => Promise<Chat | undefined>;
  duplicateChat: (chatId: string) => Promise<Chat>;
  getChatsForResource: (resourceId: string, options?: { includeDeleted?: boolean }) => Promise<Chat[]>;
  getChat: (chatId: string) => Promise<Chat | undefined>;
  deleteChat: (chatId: string) => Promise<void>;
};

const BuildManagerContext = createContext<BuildManagerContextType | undefined>(undefined);

export function BuildManagerProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const actorRef = useActorRef(buildManagerMachine);
  const fileManager = useFileManager();
  const [defaultBackend] = useCookie(cookieName.filesystemBackend, 'indexeddb' as FilesystemBackend);

  // Select state from the machine
  const error = useSelector(actorRef, (state) => state.context.error);
  const isLoading = useSelector(actorRef, (state) => {
    return state.matches('initializing') || state.matches('creatingWorker');
  });

  useEffect(() => {
    // Initialize the machine on mount
    actorRef.send({ type: 'initialize' });
  }, [actorRef]);

  const getReadiedWorker = useCallback(async (): Promise<Remote<ObjectStoreWorker>> => {
    const snapshot = await waitFor(actorRef, (state) => state.matches('ready') || state.matches('error'));
    if (snapshot.matches('error')) {
      throw new Error('Build manager worker failed to initialize');
    }

    if (!snapshot.context.wrappedWorker) {
      throw new Error('Build manager worker not initialized');
    }

    return snapshot.context.wrappedWorker;
  }, [actorRef]);

  const createBuild = useCallback(
    async (options: CreateBuildOptions): Promise<Build> => {
      const worker = await getReadiedWorker();

      // Determine build data and files based on pattern
      let buildData: Omit<Build, 'id' | 'createdAt' | 'updatedAt'>;
      let files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
      let kernel: KernelProvider | undefined;

      if ('kernel' in options) {
        // CreateBuildFromKernel: Generate from kernel template
        kernel = options.kernel;
        const mainFileName = getMainFile(options.kernel);
        const emptyCode = getEmptyCode(options.kernel);
        const result = createInitialBuild({
          buildName: options.buildName ?? defaultBuildName,
          mainFileName,
          emptyCodeContent: encodeTextFile(emptyCode),
        });
        buildData = result.buildData;
        files = result.files;
      } else {
        // CreateBuildFromData: Use provided build data and files
        buildData = options.build;
        files = options.files;
      }

      // Create chat messages for atomic call
      const chatMessages = options.initialMessage
        ? [
            createMessage({
              content: options.initialMessage.content,
              role: messageRole.user,
              metadata: {
                ...options.initialMessage.metadata,
                kernel,
                model: options.initialMessage.model,
                status: messageStatus.pending,
              },
              imageUrls: options.initialMessage.imageUrls,
            }),
          ]
        : [];

      const chatName = options.chatName ?? (options.initialMessage ? 'Initial design' : 'Initial chat');

      // Single atomic call to create build + chat + Editor state
      const { build } = await worker.createBuildWithResources({
        build: buildData,
        chat: {
          name: chatName,
          messages: chatMessages,
        },
        editorState: options.editorState,
      });

      // Persist the per-build filesystem config
      let resolvedBackend: FilesystemBackend = defaultBackend;

      if (defaultBackend === 'webaccess') {
        // Verify workspace handle exists and has permission before using webaccess
        try {
          const workspaceHandle = await getStoredDirectoryHandle();
          if (workspaceHandle) {
            const permission = await checkHandlePermission(workspaceHandle);
            if (permission !== 'granted') {
              // Permission not granted, fall back to indexeddb
              resolvedBackend = 'indexeddb';
            }
          } else {
            // No workspace handle connected, fall back to indexeddb
            resolvedBackend = 'indexeddb';
          }
        } catch {
          // Fall back to indexeddb on any error
          resolvedBackend = 'indexeddb';
        }
      }

      await setBuildFilesystemConfig(build.id, resolvedBackend);

      // Write files to filesystem (separate worker, can't consolidate)
      const buildFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};
      for (const [path, file] of Object.entries(files)) {
        buildFiles[`/builds/${build.id}/${path}`] = file;
      }

      await fileManager.writeFiles(buildFiles);

      return build;
    },
    [getReadiedWorker, fileManager, defaultBackend],
  );

  const updateBuild = useCallback(
    async (
      buildId: string,
      update: PartialDeep<Build>,
      options?: {
        ignoreKeys?: string[];
        noUpdatedAt?: boolean;
      },
    ): Promise<Build | undefined> => {
      const worker = await getReadiedWorker();
      return worker.updateBuild(buildId, update, options);
    },
    [getReadiedWorker],
  );

  const duplicateBuild = useCallback(
    async (buildId: string): Promise<Build> => {
      const worker = await getReadiedWorker();
      const build = await worker.duplicateBuild(buildId);
      await fileManager.copyDirectory(`/builds/${buildId}`, `/builds/${build.id}`);
      return build;
    },
    [getReadiedWorker, fileManager],
  );

  const getBuilds = useCallback(
    async (options?: { includeDeleted?: boolean }): Promise<Build[]> => {
      const worker = await getReadiedWorker();
      return worker.getBuilds(options);
    },
    [getReadiedWorker],
  );

  const getBuild = useCallback(
    async (buildId: string): Promise<Build | undefined> => {
      const worker = await getReadiedWorker();

      return worker.getBuild(buildId);
    },
    [getReadiedWorker],
  );

  const deleteBuild = useCallback(
    async (buildId: string): Promise<void> => {
      const worker = await getReadiedWorker();
      await worker.deleteBuild(buildId);
      // No file deletion - so that the build can be restored in it's entirety (the build is only soft-deleted)
    },
    [getReadiedWorker],
  );

  // ============================================================================
  // Chat Methods
  // ============================================================================

  const createChat = useCallback(
    async (
      resourceId: string,
      chatData: Omit<Chat, 'id' | 'resourceId' | 'createdAt' | 'updatedAt'> & { id?: string },
    ): Promise<Chat> => {
      const worker = await getReadiedWorker();
      return worker.createChat(resourceId, chatData);
    },
    [getReadiedWorker],
  );

  const updateChat = useCallback(
    async (
      chatId: string,
      update: PartialDeep<Chat>,
      options?: {
        ignoreKeys?: string[];
        noUpdatedAt?: boolean;
      },
    ): Promise<Chat | undefined> => {
      const worker = await getReadiedWorker();
      return worker.updateChat(chatId, update, options);
    },
    [getReadiedWorker],
  );

  const duplicateChat = useCallback(
    async (chatId: string): Promise<Chat> => {
      const worker = await getReadiedWorker();
      return worker.duplicateChat(chatId);
    },
    [getReadiedWorker],
  );

  const getChatsForResource = useCallback(
    async (resourceId: string, options?: { includeDeleted?: boolean }): Promise<Chat[]> => {
      const worker = await getReadiedWorker();
      return worker.getChatsForResource(resourceId, options);
    },
    [getReadiedWorker],
  );

  const getChat = useCallback(
    async (chatId: string): Promise<Chat | undefined> => {
      const worker = await getReadiedWorker();
      return worker.getChat(chatId);
    },
    [getReadiedWorker],
  );

  const deleteChat = useCallback(
    async (chatId: string): Promise<void> => {
      const worker = await getReadiedWorker();
      return worker.deleteChat(chatId);
    },
    [getReadiedWorker],
  );

  const value = useMemo<BuildManagerContextType>(() => {
    return {
      isLoading,
      error,
      buildManagerRef: actorRef,
      createBuild,
      updateBuild,
      duplicateBuild,
      getBuilds,
      getBuild,
      deleteBuild,
      createChat,
      updateChat,
      duplicateChat,
      getChatsForResource,
      getChat,
      deleteChat,
    };
  }, [
    isLoading,
    error,
    actorRef,
    createBuild,
    updateBuild,
    duplicateBuild,
    getBuilds,
    getBuild,
    deleteBuild,
    createChat,
    updateChat,
    duplicateChat,
    getChatsForResource,
    getChat,
    deleteChat,
  ]);

  return <BuildManagerContext.Provider value={value}>{children}</BuildManagerContext.Provider>;
}

export function useBuildManager(): BuildManagerContextType {
  const context = useContext(BuildManagerContext);

  if (context === undefined) {
    throw new Error('useBuildManager must be used within a BuildManagerProvider');
  }

  return context;
}

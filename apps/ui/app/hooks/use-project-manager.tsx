import type { ReactNode } from 'react';
import type { PartialDeep } from 'type-fest';
import { createContext, useContext, useMemo, useCallback, useEffect } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { waitFor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { Project, FileSystemBackend } from '@taucad/types';
import type { KernelProvider } from '@taucad/runtime';
import type { Chat } from '@taucad/chat';
import type { Remote } from 'comlink';
import { messageRole, messageStatus } from '@taucad/chat/constants';
import { projectManagerMachine } from '#hooks/project-manager.machine.js';
import type { ObjectStoreWorker, InitialEditorState } from '#hooks/object-store.worker.js';
import { useFileManager } from '#hooks/use-file-manager.js';
import { setBuildFileSystemConfig, getStoredDirectoryHandle, checkHandlePermission } from '#filesystem/handle-store.js';
import { createInitialProject } from '#constants/project.constants.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import { createMessage } from '#utils/chat.utils.js';
import { getMainFile, getEmptyCode } from '#utils/kernel.utils.js';
import { encodeTextFile } from '#utils/filesystem.utils.js';
import { defaultProjectName } from '#constants/project-names.js';

/**
 * Shared options for initial chat configuration.
 */
type CreateProjectChatOptions = {
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
  /** Explicit backend override — takes precedence over the cookie default */
  backend?: FileSystemBackend;
};

/**
 * Create a new empty project from a kernel template.
 * Use this when starting a fresh project from scratch.
 */
type CreateProjectFromKernel = CreateProjectChatOptions & {
  /** The kernel/language to use for the new project */
  kernel: KernelProvider;
  /** Override default project name */
  projectName?: string;
};

/**
 * Create a project from existing project data and files.
 * Use this when cloning, remixing, or importing a project.
 */
type CreateProjectFromData = CreateProjectChatOptions & {
  /** The project metadata to use */
  project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;
  /** The files for the project */
  files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
};

/**
 * Options for creating a project with an associated chat.
 * Either create from a kernel template (new project) or from existing data (clone/remix).
 */
export type CreateProjectOptions = CreateProjectFromKernel | CreateProjectFromData;

type ProjectManagerContextType = {
  isLoading: boolean;
  error: Error | undefined;
  projectManagerRef: ActorRefFrom<typeof projectManagerMachine>;
  createProject: (options: CreateProjectOptions) => Promise<Project>;
  updateProject: (
    projectId: string,
    update: PartialDeep<Project>,
    options?: {
      noUpdatedAt?: boolean;
    },
  ) => Promise<Project | undefined>;
  duplicateProject: (projectId: string) => Promise<Project>;
  getProjects: (options?: { includeDeleted?: boolean }) => Promise<Project[]>;
  getProject: (projectId: string) => Promise<Project | undefined>;
  deleteProject: (projectId: string) => Promise<void>;
  // Chat methods
  createChat: (
    resourceId: string,
    chat: Omit<Chat, 'id' | 'resourceId' | 'createdAt' | 'updatedAt'> & {
      id?: string;
    },
  ) => Promise<Chat>;
  updateChat: (
    chatId: string,
    update: PartialDeep<Chat>,
    options?: {
      noUpdatedAt?: boolean;
    },
  ) => Promise<Chat | undefined>;
  patchChat: <K extends keyof Chat>(chatId: string, key: K, value: Chat[K]) => Promise<Chat | undefined>;
  setMessageEdit: (
    chatId: string,
    messageId: string,
    draft: NonNullable<Chat['messageEdits']>[string],
  ) => Promise<Chat | undefined>;
  clearMessageEdit: (chatId: string, messageId: string) => Promise<Chat | undefined>;
  softDeleteChat: (chatId: string) => Promise<Chat | undefined>;
  duplicateChat: (chatId: string) => Promise<Chat>;
  getChatsForResource: (resourceId: string, options?: { includeDeleted?: boolean }) => Promise<Chat[]>;
  getChat: (chatId: string) => Promise<Chat | undefined>;
  deleteChat: (chatId: string) => Promise<void>;
};

const ProjectManagerContext = createContext<ProjectManagerContextType | undefined>(undefined);

export function ProjectManagerProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const actorRef = useActorRef(projectManagerMachine);
  const fileManager = useFileManager();
  const [defaultBackend] = useCookie(cookieName.filesystemBackend, 'indexeddb' as FileSystemBackend);

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

  const createProject = useCallback(
    async (options: CreateProjectOptions): Promise<Project> => {
      const worker = await getReadiedWorker();

      // Determine project data and files based on pattern
      let projectData: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;
      let files: Record<string, { content: Uint8Array<ArrayBuffer> }>;
      let kernel: KernelProvider | undefined;

      if ('kernel' in options) {
        // CreateBuildFromKernel: Generate from kernel template
        kernel = options.kernel;
        const mainFileName = getMainFile(options.kernel);
        const emptyCode = getEmptyCode(options.kernel);
        const result = createInitialProject({
          projectName: options.projectName ?? defaultProjectName,
          mainFileName,
          emptyCodeContent: encodeTextFile(emptyCode),
        });
        projectData = result.projectData;
        files = result.files;
      } else {
        // CreateBuildFromData: Use provided project data and files
        projectData = options.project;
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

      // Single atomic call to create project + chat + Editor state
      const { project } = await worker.createProjectWithResources({
        project: projectData,
        chat: {
          name: chatName,
          messages: chatMessages,
        },
        editorState: options.editorState,
      });

      // Persist the per-build filesystem config
      let resolvedBackend: FileSystemBackend = options.backend ?? defaultBackend;

      if (resolvedBackend === 'webaccess') {
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

      await setBuildFileSystemConfig(project.id, resolvedBackend);

      const projectPrefix = `/projects/${project.id}`;
      await fileManager.mount(projectPrefix, resolvedBackend, { preservePath: true });

      const projectFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};
      for (const [path, file] of Object.entries(files)) {
        projectFiles[`${projectPrefix}/${path}`] = file;
      }

      try {
        await fileManager.writeFiles(projectFiles);
      } finally {
        fileManager.unmount(projectPrefix);
      }

      return project;
    },
    [getReadiedWorker, fileManager, defaultBackend],
  );

  const updateProject = useCallback(
    async (
      projectId: string,
      update: PartialDeep<Project>,
      options?: {
        noUpdatedAt?: boolean;
      },
    ): Promise<Project | undefined> => {
      const worker = await getReadiedWorker();
      return worker.updateProject(projectId, update, options);
    },
    [getReadiedWorker],
  );

  const duplicateProject = useCallback(
    async (projectId: string): Promise<Project> => {
      const worker = await getReadiedWorker();
      const project = await worker.duplicateProject(projectId);
      await fileManager.copyDirectory(`/projects/${projectId}`, `/projects/${project.id}`);
      return project;
    },
    [getReadiedWorker, fileManager],
  );

  const getProjects = useCallback(
    async (options?: { includeDeleted?: boolean }): Promise<Project[]> => {
      const worker = await getReadiedWorker();
      return worker.getProjects(options);
    },
    [getReadiedWorker],
  );

  const getProject = useCallback(
    async (projectId: string): Promise<Project | undefined> => {
      const worker = await getReadiedWorker();

      return worker.getProject(projectId);
    },
    [getReadiedWorker],
  );

  const deleteProject = useCallback(
    async (projectId: string): Promise<void> => {
      const worker = await getReadiedWorker();
      await worker.deleteProject(projectId);
      // No file deletion - so that the project can be restored in it's entirety (the project is only soft-deleted)
    },
    [getReadiedWorker],
  );

  // ============================================================================
  // Chat Methods
  // ============================================================================

  const createChat = useCallback(
    async (
      resourceId: string,
      chatData: Omit<Chat, 'id' | 'resourceId' | 'createdAt' | 'updatedAt'> & {
        id?: string;
      },
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
        noUpdatedAt?: boolean;
      },
    ): Promise<Chat | undefined> => {
      const worker = await getReadiedWorker();
      return worker.updateChat(chatId, update, options);
    },
    [getReadiedWorker],
  );

  const patchChat = useCallback(
    async <K extends keyof Chat>(chatId: string, key: K, value: Chat[K]): Promise<Chat | undefined> => {
      const worker = await getReadiedWorker();
      return worker.patchChat(chatId, key, value);
    },
    [getReadiedWorker],
  );

  const setMessageEdit = useCallback(
    async (
      chatId: string,
      messageId: string,
      draft: NonNullable<Chat['messageEdits']>[string],
    ): Promise<Chat | undefined> => {
      const worker = await getReadiedWorker();
      return worker.setMessageEdit(chatId, messageId, draft);
    },
    [getReadiedWorker],
  );

  const clearMessageEdit = useCallback(
    async (chatId: string, messageId: string): Promise<Chat | undefined> => {
      const worker = await getReadiedWorker();
      return worker.clearMessageEdit(chatId, messageId);
    },
    [getReadiedWorker],
  );

  const softDeleteChat = useCallback(
    async (chatId: string): Promise<Chat | undefined> => {
      const worker = await getReadiedWorker();
      return worker.softDeleteChat(chatId);
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

  const value = useMemo<ProjectManagerContextType>(() => {
    return {
      isLoading,
      error,
      projectManagerRef: actorRef,
      createProject,
      updateProject,
      duplicateProject,
      getProjects,
      getProject,
      deleteProject,
      createChat,
      updateChat,
      patchChat,
      setMessageEdit,
      clearMessageEdit,
      softDeleteChat,
      duplicateChat,
      getChatsForResource,
      getChat,
      deleteChat,
    };
  }, [
    isLoading,
    error,
    actorRef,
    createProject,
    updateProject,
    duplicateProject,
    getProjects,
    getProject,
    deleteProject,
    createChat,
    updateChat,
    patchChat,
    setMessageEdit,
    clearMessageEdit,
    softDeleteChat,
    duplicateChat,
    getChatsForResource,
    getChat,
    deleteChat,
  ]);

  return <ProjectManagerContext.Provider value={value}>{children}</ProjectManagerContext.Provider>;
}

export function useProjectManager(): ProjectManagerContextType {
  const context = useContext(ProjectManagerContext);

  if (context === undefined) {
    throw new Error('useProjectManager must be used within a ProjectManagerProvider');
  }

  return context;
}

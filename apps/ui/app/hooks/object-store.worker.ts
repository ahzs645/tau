import { expose } from 'comlink';
import type { PartialDeep } from 'type-fest';
import type { Project } from '@taucad/types';
import type { Chat } from '@taucad/chat';
import { IndexedDbStorageProvider } from '#db/indexeddb-storage.js';
import type { EditorState, EditorStateInput, PanelState } from '#types/editor.types.js';
import { defaultPanelState } from '#constants/editor.constants.js';

/**
 * Type for initial editor state overrides during project creation.
 * Uses PartialDeep to allow partial nested objects (e.g., openPanels: { chat: true }).
 * Excludes projectId and lastChatId as those are set automatically.
 */
export type InitialEditorState = PartialDeep<Omit<EditorStateInput, 'projectId' | 'lastChatId'>>;

// Create a singleton instance of the storage provider
const storage = new IndexedDbStorageProvider();

// Define the worker's API
const objectStoreWorker = {
  // ============================================================================
  // Project Methods
  // ============================================================================

  async createProject(project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Promise<Project> {
    return storage.createProject(project);
  },

  /**
   * Atomic method to create a project with its associated chat and Editor state in one call.
   * This reduces roundtrips between main thread and worker.
   * Implements rollback on partial failure to maintain atomicity.
   *
   * @param options - Options for project creation
   * @param options.project - The project data to create
   * @param options.chat - The chat data to create
   * @param options.editorState - Optional initial editor state overrides (e.g., panelState for initial panel layout)
   */
  // oxlint-disable-next-line complexity -- TODO: Refactor this function to make it more readable.
  async createProjectWithResources(options: {
    project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;
    chat: Omit<Chat, 'id' | 'resourceId' | 'createdAt' | 'updatedAt'>;
    editorState?: InitialEditorState;
  }): Promise<{ project: Project; chat: Chat }> {
    const project = await storage.createProject(options.project);

    let chat: Chat;
    try {
      chat = await storage.createChat(project.id, options.chat);
    } catch (chatError) {
      // Rollback: delete the project since chat creation failed
      try {
        await storage.deleteProject(project.id);
      } catch (cleanupError) {
        console.error('Failed to cleanup project after chat creation failure:', cleanupError);
      }

      throw chatError;
    }

    try {
      // Derive main file from project assets for auto-populating editor state
      const mainFile = options.project.assets.mechanical?.main;

      // Auto-populate activeFilePath and openFiles from main file if not provided
      const activeFilePath = options.editorState?.activeFilePath ?? mainFile;
      const openFiles =
        options.editorState?.openFiles && options.editorState.openFiles.length > 0
          ? options.editorState.openFiles
          : mainFile
            ? [{ path: mainFile, name: mainFile.split('/').pop() ?? mainFile, lastAccessedAt: Date.now() }]
            : [];

      // Merge provided panelState with defaults
      const mergedPanelState: PanelState = {
        openPanels: {
          ...defaultPanelState.openPanels,
          ...options.editorState?.panelState?.openPanels,
        },
        panelSizes: {
          ...defaultPanelState.panelSizes,
          ...options.editorState?.panelState?.panelSizes,
        },
        mobileActiveTab: options.editorState?.panelState?.mobileActiveTab ?? defaultPanelState.mobileActiveTab,
        kernelPaneview: {
          ...defaultPanelState.kernelPaneview,
          ...options.editorState?.panelState?.kernelPaneview,
        },
        parametersPaneview: {
          ...defaultPanelState.parametersPaneview,
          ...options.editorState?.panelState?.parametersPaneview,
        },
      };

      await storage.updateEditorState({
        projectId: project.id,
        openFiles,
        activeFilePath,
        lastChatId: chat.id,
        panelState: mergedPanelState,
        editorLayout: undefined,
        viewerLayout: undefined,
        viewSettings: {},
      });
    } catch (editorStateError) {
      // Rollback: delete chat and project since editor state update failed
      try {
        await storage.deleteChat(chat.id);
      } catch (cleanupError) {
        console.error('Failed to cleanup chat after editor state update failure:', cleanupError);
      }

      try {
        await storage.deleteProject(project.id);
      } catch (cleanupError) {
        console.error('Failed to cleanup project after editor state update failure:', cleanupError);
      }

      throw editorStateError;
    }

    return { project, chat };
  },

  async duplicateProject(projectId: string): Promise<Project> {
    const project = await storage.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Create the duplicated project
    const newProject = await storage.createProject({
      ...project,
      name: `${project.name} (Copy)`,
    });

    // Duplicate all chats for this project
    const chatIdMapping = await storage.duplicateResourceChats(projectId, newProject.id);

    // Duplicate Editor state if it exists, mapping lastChatId to the cloned chat
    const sourceEditorState = await storage.getEditorState(projectId);
    if (sourceEditorState) {
      const newLastChatId = sourceEditorState.lastChatId ? chatIdMapping[sourceEditorState.lastChatId] : undefined;
      await storage.updateEditorState({
        projectId: newProject.id,
        openFiles: sourceEditorState.openFiles,
        activeFilePath: sourceEditorState.activeFilePath,
        lastChatId: newLastChatId,
        panelState: sourceEditorState.panelState,
        editorLayout: sourceEditorState.editorLayout,
        viewerLayout: sourceEditorState.viewerLayout,
        viewSettings: sourceEditorState.viewSettings,
      });
    }

    return newProject;
  },

  async updateProject(
    projectId: string,
    update: PartialDeep<Project>,
    options?: {
      ignoreKeys?: string[];
      noUpdatedAt?: boolean;
    },
  ): Promise<Project | undefined> {
    return storage.updateProject(projectId, update, options);
  },

  async getProjects(options?: { includeDeleted?: boolean }): Promise<Project[]> {
    return storage.getProjects(options);
  },

  async getProject(projectId: string): Promise<Project | undefined> {
    return storage.getProject(projectId);
  },

  async deleteProject(projectId: string): Promise<void> {
    // Delete all chats associated with the project
    const chats = await storage.getChatsForResource(projectId, { includeDeleted: true });
    await Promise.all(chats.map(async (chat) => storage.deleteChat(chat.id)));

    // Delete the Editor state for the project
    await storage.deleteEditorState(projectId);

    // Delete the project itself
    return storage.deleteProject(projectId);
  },

  // ============================================================================
  // Chat Methods
  // ============================================================================

  async createChat(
    resourceId: string,
    chat: Omit<Chat, 'id' | 'resourceId' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<Chat> {
    return storage.createChat(resourceId, chat);
  },

  async updateChat(
    chatId: string,
    update: PartialDeep<Chat>,
    options?: { ignoreKeys?: string[]; noUpdatedAt?: boolean },
  ): Promise<Chat | undefined> {
    return storage.updateChat(chatId, update, options);
  },

  async getChat(chatId: string): Promise<Chat | undefined> {
    return storage.getChat(chatId);
  },

  async getChatsForResource(resourceId: string, options?: { includeDeleted?: boolean }): Promise<Chat[]> {
    return storage.getChatsForResource(resourceId, options);
  },

  async deleteChat(chatId: string): Promise<void> {
    return storage.deleteChat(chatId);
  },

  async duplicateChat(chatId: string): Promise<Chat> {
    return storage.duplicateChat(chatId);
  },

  async duplicateResourceChats(sourceResourceId: string, targetResourceId: string): Promise<Record<string, string>> {
    return storage.duplicateResourceChats(sourceResourceId, targetResourceId);
  },

  // ============================================================================
  // Editor State Methods
  // ============================================================================

  async getEditorState(projectId: string): Promise<EditorState | undefined> {
    return storage.getEditorState(projectId);
  },

  async updateEditorState(editorState: EditorStateInput): Promise<EditorState> {
    return storage.updateEditorState(editorState);
  },

  async deleteEditorState(projectId: string): Promise<void> {
    return storage.deleteEditorState(projectId);
  },
};

expose(objectStoreWorker);

export type ObjectStoreWorker = typeof objectStoreWorker;

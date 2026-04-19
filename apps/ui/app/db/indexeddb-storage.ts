import type { PartialDeep } from 'type-fest';
import deepmerge from 'deepmerge';
import type { Project } from '@taucad/types';
import type { Chat } from '@taucad/chat';
import { idPrefix } from '@taucad/types/constants';
import { generatePrefixedId } from '@taucad/utils/id';
import type { StorageProvider } from '#types/storage.types.js';
import type { EditorState, EditorStateInput } from '#types/editor.types.js';
import { metaConfig } from '#constants/meta.constants.js';

export class IndexedDbStorageProvider implements StorageProvider {
  private get dbName(): string {
    return `${metaConfig.databasePrefix}db`;
  }

  private get projectsStoreName(): string {
    return 'projects';
  }

  private get chatsStoreName(): string {
    return 'chats';
  }

  private get editorStoreName(): string {
    return 'editor';
  }

  private get version(): number {
    return 4;
  }

  public async createProject(project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Promise<Project> {
    const id = generatePrefixedId(idPrefix.project);
    const timestamp = Date.now();
    const projectWithId = {
      ...project,
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.projectsStoreName, 'readwrite');
      const store = transaction.objectStore(this.projectsStoreName);

      const request = store.add(projectWithId);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(projectWithId);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  public async updateProject(
    projectId: string,
    update: PartialDeep<Project>,
    options?: {
      ignoreKeys?: string[];
      /**
       * If true, the updatedAt timestamp will not be updated.
       *
       * This should be removed after hash-checking is added for avoiding
       * unnecessary updates.
       */
      noUpdatedAt?: boolean;
    },
  ): Promise<Project | undefined> {
    const db = await this.getDb();
    const existingProject = await this.getProject(projectId);

    if (!existingProject) {
      return undefined;
    }

    // If update contains an 'id' field matching projectId, treat it as a full project replacement
    // This is the new pattern from the parallel state machine refactor
    const isProject = 'id' in update && update.id === projectId;

    let updatedProject: Project;

    if (isProject) {
      // Full project replacement - no merging needed
      updatedProject = update as Project;
    } else {
      // Partial update - use deepmerge for backward compatibility
      const mergeIgnoreKeys = new Set(options?.ignoreKeys ?? []);
      const optionalParameters = options?.noUpdatedAt ? {} : { updatedAt: Date.now() };

      updatedProject = deepmerge(
        existingProject,
        { ...update, ...optionalParameters },
        {
          customMerge(key) {
            if (mergeIgnoreKeys.has(key)) {
              return (_source: unknown, target: unknown) => target;
            }

            return undefined;
          },
        },
      ) as Project;
    }

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.projectsStoreName, 'readwrite');
      const store = transaction.objectStore(this.projectsStoreName);

      const request = store.put(updatedProject);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(updatedProject);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  public async getProjects(options?: { includeDeleted?: boolean }): Promise<Project[]> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.projectsStoreName, 'readonly');
      const store = transaction.objectStore(this.projectsStoreName);
      const request = store.getAll();

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        const projects = request.result as Project[];
        // Filter out deleted projects unless explicitly requested
        const filteredProjects = options?.includeDeleted ? projects : projects.filter((project) => !project.deletedAt);
        resolve(filteredProjects);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  public async getProject(projectId: string): Promise<Project | undefined> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.projectsStoreName, 'readonly');
      const store = transaction.objectStore(this.projectsStoreName);
      const request = store.get(projectId);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result as Project | undefined);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  public async deleteProject(projectId: string): Promise<void> {
    // Get the project to make sure it exists
    const project = await this.getProject(projectId);
    if (!project) {
      return;
    }

    // Perform soft delete by updating deletedAt timestamp
    await this.updateProject(projectId, { deletedAt: Date.now() });
  }

  // ============================================================================
  // Chat Methods
  // ============================================================================

  public async createChat(
    resourceId: string,
    chat: Omit<Chat, 'id' | 'resourceId' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<Chat> {
    const id = chat.id ?? generatePrefixedId(idPrefix.chat);
    const timestamp = Date.now();
    const chatWithId: Chat = {
      ...chat,
      id,
      resourceId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.chatsStoreName, 'readwrite');
      const store = transaction.objectStore(this.chatsStoreName);

      const request = store.add(chatWithId);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(chatWithId);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  public async updateChat(
    chatId: string,
    update: PartialDeep<Chat>,
    options?: {
      ignoreKeys?: string[];
      noUpdatedAt?: boolean;
    },
  ): Promise<Chat | undefined> {
    const db = await this.getDb();
    const existingChat = await this.getChat(chatId);

    if (!existingChat) {
      return undefined;
    }

    // If update contains an 'id' field matching chatId, treat it as a full chat replacement
    const isFullChat = 'id' in update && update.id === chatId;

    let updatedChat: Chat;

    if (isFullChat) {
      // Full chat replacement - no merging needed
      updatedChat = update as Chat;
    } else {
      // Partial update - use deepmerge
      const mergeIgnoreKeys = new Set(options?.ignoreKeys ?? []);
      const optionalParameters = options?.noUpdatedAt ? {} : { updatedAt: Date.now() };

      updatedChat = deepmerge(
        existingChat,
        { ...update, ...optionalParameters },
        {
          customMerge(key) {
            if (mergeIgnoreKeys.has(key)) {
              return (_source: unknown, target: unknown) => target;
            }

            return undefined;
          },
        },
      ) as Chat;
    }

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.chatsStoreName, 'readwrite');
      const store = transaction.objectStore(this.chatsStoreName);

      const request = store.put(updatedChat);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(updatedChat);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  public async getChat(chatId: string): Promise<Chat | undefined> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.chatsStoreName, 'readonly');
      const store = transaction.objectStore(this.chatsStoreName);
      const request = store.get(chatId);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result as Chat | undefined);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  public async getChatsForResource(resourceId: string, options?: { includeDeleted?: boolean }): Promise<Chat[]> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.chatsStoreName, 'readonly');
      const store = transaction.objectStore(this.chatsStoreName);
      const index = store.index('resourceId');
      const request = index.getAll(resourceId);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        const chats = request.result as Chat[];
        // Filter out deleted chats unless explicitly requested
        const filteredChats = options?.includeDeleted ? chats : chats.filter((chat) => !chat.deletedAt);
        resolve(filteredChats);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  public async deleteChat(chatId: string): Promise<void> {
    // Get the chat to make sure it exists
    const chat = await this.getChat(chatId);
    if (!chat) {
      return;
    }

    // Perform soft delete by updating deletedAt timestamp
    await this.updateChat(chatId, { deletedAt: Date.now() });
  }

  public async duplicateChat(chatId: string): Promise<Chat> {
    const chat = await this.getChat(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    return this.createChat(chat.resourceId, {
      name: `${chat.name} (Copy)`,
      messages: chat.messages,
      draft: chat.draft,
      messageEdits: chat.messageEdits,
    });
  }

  public async duplicateResourceChats(
    sourceResourceId: string,
    targetResourceId: string,
  ): Promise<Record<string, string>> {
    const chats = await this.getChatsForResource(sourceResourceId);

    const duplicatedChats = await Promise.all(
      chats.map(async (chat) => {
        const newChat = await this.createChat(targetResourceId, {
          name: chat.name,
          messages: chat.messages,
          draft: chat.draft,
          messageEdits: chat.messageEdits,
        });
        return { oldId: chat.id, newId: newChat.id };
      }),
    );

    return Object.fromEntries(duplicatedChats.map(({ oldId, newId }) => [oldId, newId]));
  }

  // ============================================================================
  // Editor State Methods
  // ============================================================================

  public async getEditorState(projectId: string): Promise<EditorState | undefined> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.editorStoreName, 'readonly');
      const store = transaction.objectStore(this.editorStoreName);
      const request = store.get(projectId);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result as EditorState | undefined);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  public async updateEditorState(editorState: EditorStateInput): Promise<EditorState> {
    const db = await this.getDb();
    const stateWithTimestamp = { ...editorState, updatedAt: Date.now() };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.editorStoreName, 'readwrite');
      const store = transaction.objectStore(this.editorStoreName);
      const request = store.put(stateWithTimestamp);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(stateWithTimestamp);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  public async deleteEditorState(projectId: string): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.editorStoreName, 'readwrite');
      const store = transaction.objectStore(this.editorStoreName);
      const request = store.delete(projectId);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve();
      };

      transaction.oncomplete = () => {
        db.close();
      };
    });
  }

  // ============================================================================
  // Database Management
  // ============================================================================

  private async getDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- this is the preferred API for indexedDB
      request.onerror = () => {
        // oxlint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- we want to let the actual error be thrown
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const { oldVersion } = event;

        // Version 1: Create projects store
        if (oldVersion < 1 && !db.objectStoreNames.contains(this.projectsStoreName)) {
          db.createObjectStore(this.projectsStoreName, { keyPath: 'id' });
        }

        // Version 2+: Create chats store with resourceId index
        if (oldVersion < 2 && !db.objectStoreNames.contains(this.chatsStoreName)) {
          const chatsStore = db.createObjectStore(this.chatsStoreName, { keyPath: 'id' });
          chatsStore.createIndex('resourceId', 'resourceId', { unique: false });
        }

        // Version 3 was skipped for no good reason.

        // Version 4+: Create editor store for transient Editor state
        if (oldVersion < 4 && !db.objectStoreNames.contains(this.editorStoreName)) {
          db.createObjectStore(this.editorStoreName, { keyPath: 'projectId' });
        }
      };
    });
  }
}

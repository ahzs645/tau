/**
 * Handle & Config Store Module
 *
 * Persists FileSystemDirectoryHandle objects and per-build filesystem
 * configuration in a dedicated IndexedDB database.
 *
 * **Handles store** (`handles`):
 * FileSystemDirectoryHandle supports structured cloning, which means it can be
 * stored in IndexedDB and retrieved across sessions. However, the browser may
 * revoke permission between sessions, so callers must check/request permission
 * after retrieval. The workspace handle is stored with the key `'root'`.
 *
 * **Configs store** (`configs`):
 * Maps `projectId` to filesystem backend configuration. This is kept client-side
 * (separate from the Build type which syncs to the API DB). Architected for
 * future mount config expansion (e.g., zip library mounts).
 *
 * This module runs on the main thread only (permission APIs require window context).
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle
 */

import type { FileSystemBackend } from '@taucad/types';
import { metaConfig } from '#constants/meta.constants.js';

const dbName = `${metaConfig.databasePrefix}fs-handles`;
const handlesStoreName = 'handles';
const configsStoreName = 'configs';
const handleKey = 'root';
const dbVersion = 2;

/**
 * Per-build filesystem configuration.
 * Architected for future mount support (zip libraries, etc.).
 */
export type ProjectFileSystemConfig = {
  projectId: string;
  backend: FileSystemBackend;
  // Future: mounts?: Array<{ path: string; type: 'zip'; source: string }>;
};

// ============ Database (ref-counted singleton) ============

const idleCloseMs = 5000;

let cachedDb: IDBDatabase | undefined;
let refCount = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let openPromise: Promise<IDBDatabase> | undefined;

async function openHandleDbRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion);

    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(handlesStoreName)) {
        db.createObjectStore(handlesStoreName);
      }
      if (!db.objectStoreNames.contains(configsStoreName)) {
        db.createObjectStore(configsStoreName, { keyPath: 'projectId' });
      }
    });

    request.addEventListener('success', () => {
      resolve(request.result);
    });

    request.addEventListener('error', () => {
      reject(request.error ?? new Error(`Failed to open IndexedDB database: ${dbName}`));
    });
  });
}

async function acquireDb(): Promise<IDBDatabase> {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  refCount++;

  if (cachedDb) {
    return cachedDb;
  }

  openPromise ??= openHandleDbRaw();

  cachedDb = await openPromise;
  openPromise = undefined;
  return cachedDb;
}

function releaseDb(): void {
  refCount--;
  if (refCount > 0) {
    return;
  }

  idleTimer = setTimeout(() => {
    cachedDb?.close();
    cachedDb = undefined;
    idleTimer = undefined;
  }, idleCloseMs);
}

async function withDb<T>(operation: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await acquireDb();
  try {
    return await operation(db);
  } finally {
    releaseDb();
  }
}

// ============ Directory Handles ============

/**
 * Store a FileSystemDirectoryHandle in IndexedDB for persistence across sessions.
 * The workspace handle is stored with the default `'root'` key.
 */
export async function storeDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  return withDb(
    async (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(handlesStoreName, 'readwrite');
        const store = transaction.objectStore(handlesStoreName);
        const request = store.put(handle, handleKey);
        request.addEventListener('success', () => {
          resolve();
        });
        request.addEventListener('error', () => {
          reject(request.error ?? new Error('Failed to store directory handle'));
        });
      }),
  );
}

/**
 * Retrieve a previously stored FileSystemDirectoryHandle from IndexedDB.
 * Returns undefined if no handle has been stored.
 *
 * Note: The returned handle may not have permission. Call checkHandlePermission()
 * or requestHandlePermission() before using it.
 */
export async function getStoredDirectoryHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  return withDb(
    async (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(handlesStoreName, 'readonly');
        const store = transaction.objectStore(handlesStoreName);
        const request = store.get(handleKey);
        request.addEventListener('success', () => {
          resolve(request.result as FileSystemDirectoryHandle | undefined);
        });
        request.addEventListener('error', () => {
          reject(request.error ?? new Error('Failed to retrieve directory handle'));
        });
      }),
  );
}

/**
 * Remove the stored FileSystemDirectoryHandle from IndexedDB.
 */
export async function clearStoredDirectoryHandle(): Promise<void> {
  return withDb(
    async (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(handlesStoreName, 'readwrite');
        const store = transaction.objectStore(handlesStoreName);
        const request = store.delete(handleKey);
        request.addEventListener('success', () => {
          resolve();
        });
        request.addEventListener('error', () => {
          reject(request.error ?? new Error('Failed to clear directory handle'));
        });
      }),
  );
}

/**
 * Check the current permission state of a FileSystemDirectoryHandle.
 * This does not require a user gesture and can be called at any time.
 *
 * @returns 'granted' if the handle can be used, 'prompt' if permission needs to be
 *          requested (requires user gesture), or 'denied' if access was denied.
 */
export async function checkHandlePermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  return handle.queryPermission({ mode: 'readwrite' });
}

/**
 * Request read/write permission on a FileSystemDirectoryHandle.
 * This MUST be called from a user gesture (e.g., button click handler).
 *
 * @returns true if permission was granted, false otherwise.
 */
export async function requestHandlePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const result = await handle.requestPermission({ mode: 'readwrite' });
  return result === 'granted';
}

// ============ Build Filesystem Configs ============

/**
 * Store the filesystem backend configuration for a project.
 * This records which backend a project's files are stored in, so the correct
 * backend is used when loading the project in the future.
 */
export async function setBuildFileSystemConfig(projectId: string, backend: FileSystemBackend): Promise<void> {
  const config: ProjectFileSystemConfig = { projectId, backend };
  return withDb(
    async (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(configsStoreName, 'readwrite');
        const store = transaction.objectStore(configsStoreName);
        const request = store.put(config);
        request.addEventListener('success', () => {
          resolve();
        });
        request.addEventListener('error', () => {
          reject(request.error ?? new Error('Failed to store project filesystem config'));
        });
      }),
  );
}

/**
 * Retrieve the filesystem backend for a project.
 * Returns undefined if no config has been stored (legacy projects default to 'indexeddb').
 */
export async function getProjectFileSystemConfig(projectId: string): Promise<FileSystemBackend | undefined> {
  return withDb(
    async (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(configsStoreName, 'readonly');
        const store = transaction.objectStore(configsStoreName);
        const request = store.get(projectId);
        request.addEventListener('success', () => {
          resolve((request.result as ProjectFileSystemConfig | undefined)?.backend);
        });
        request.addEventListener('error', () => {
          reject(request.error ?? new Error('Failed to retrieve project filesystem config'));
        });
      }),
  );
}

/**
 * Remove the filesystem config for a project.
 * Should be called when a project is deleted.
 */
export async function deleteBuildFileSystemConfig(projectId: string): Promise<void> {
  return withDb(
    async (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(configsStoreName, 'readwrite');
        const store = transaction.objectStore(configsStoreName);
        const request = store.delete(projectId);
        request.addEventListener('success', () => {
          resolve();
        });
        request.addEventListener('error', () => {
          reject(request.error ?? new Error('Failed to delete project filesystem config'));
        });
      }),
  );
}

/**
 * Retrieve all project filesystem configs.
 * Used by the /files route to enumerate projects across all backends.
 */
export async function getAllProjectFileSystemConfigs(): Promise<ProjectFileSystemConfig[]> {
  return withDb(
    async (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(configsStoreName, 'readonly');
        const store = transaction.objectStore(configsStoreName);
        const request = store.getAll();
        request.addEventListener('success', () => {
          resolve(request.result as ProjectFileSystemConfig[]);
        });
        request.addEventListener('error', () => {
          reject(request.error ?? new Error('Failed to retrieve all project filesystem configs'));
        });
      }),
  );
}

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
 * Maps `buildId` to filesystem backend configuration. This is kept client-side
 * (separate from the Build type which syncs to the API DB). Architected for
 * future mount config expansion (e.g., zip library mounts).
 *
 * This module runs on the main thread only (permission APIs require window context).
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle
 */

import type { FilesystemBackend } from '@taucad/types';
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
export type BuildFilesystemConfig = {
  buildId: string;
  backend: FilesystemBackend;
  // Future: mounts?: Array<{ path: string; type: 'zip'; source: string }>;
};

// ============ Database ============

/**
 * Open (or create) the IndexedDB database for handle and config storage.
 * Handles schema upgrades from v1 (handles only) to v2 (handles + configs).
 */
async function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion);

    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(handlesStoreName)) {
        db.createObjectStore(handlesStoreName);
      }

      if (!db.objectStoreNames.contains(configsStoreName)) {
        db.createObjectStore(configsStoreName, { keyPath: 'buildId' });
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

// ============ Directory Handles ============

/**
 * Store a FileSystemDirectoryHandle in IndexedDB for persistence across sessions.
 * The workspace handle is stored with the default `'root'` key.
 */
export async function storeDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(handlesStoreName, 'readwrite');
    const store = transaction.objectStore(handlesStoreName);
    const request = store.put(handle, handleKey);

    request.addEventListener('success', () => {
      resolve();
    });

    request.addEventListener('error', () => {
      reject(request.error ?? new Error('Failed to store directory handle'));
    });

    transaction.addEventListener('complete', () => {
      db.close();
    });
  });
}

/**
 * Retrieve a previously stored FileSystemDirectoryHandle from IndexedDB.
 * Returns undefined if no handle has been stored.
 *
 * Note: The returned handle may not have permission. Call checkHandlePermission()
 * or requestHandlePermission() before using it.
 */
export async function getStoredDirectoryHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await openHandleDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(handlesStoreName, 'readonly');
    const store = transaction.objectStore(handlesStoreName);
    const request = store.get(handleKey);

    request.addEventListener('success', () => {
      const handle = request.result as FileSystemDirectoryHandle | undefined;
      resolve(handle);
    });

    request.addEventListener('error', () => {
      reject(request.error ?? new Error('Failed to retrieve directory handle'));
    });

    transaction.addEventListener('complete', () => {
      db.close();
    });
  });
}

/**
 * Remove the stored FileSystemDirectoryHandle from IndexedDB.
 */
export async function clearStoredDirectoryHandle(): Promise<void> {
  const db = await openHandleDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(handlesStoreName, 'readwrite');
    const store = transaction.objectStore(handlesStoreName);
    const request = store.delete(handleKey);

    request.addEventListener('success', () => {
      resolve();
    });

    request.addEventListener('error', () => {
      reject(request.error ?? new Error('Failed to clear directory handle'));
    });

    transaction.addEventListener('complete', () => {
      db.close();
    });
  });
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
 * Store the filesystem backend configuration for a build.
 * This records which backend a build's files are stored in, so the correct
 * backend is used when loading the build in the future.
 */
export async function setBuildFilesystemConfig(buildId: string, backend: FilesystemBackend): Promise<void> {
  const db = await openHandleDb();

  const config: BuildFilesystemConfig = { buildId, backend };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(configsStoreName, 'readwrite');
    const store = transaction.objectStore(configsStoreName);
    const request = store.put(config);

    request.addEventListener('success', () => {
      resolve();
    });

    request.addEventListener('error', () => {
      reject(request.error ?? new Error('Failed to store build filesystem config'));
    });

    transaction.addEventListener('complete', () => {
      db.close();
    });
  });
}

/**
 * Retrieve the filesystem backend for a build.
 * Returns undefined if no config has been stored (legacy builds default to 'indexeddb').
 */
export async function getBuildFilesystemConfig(buildId: string): Promise<FilesystemBackend | undefined> {
  const db = await openHandleDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(configsStoreName, 'readonly');
    const store = transaction.objectStore(configsStoreName);
    const request = store.get(buildId);

    request.addEventListener('success', () => {
      const config = request.result as BuildFilesystemConfig | undefined;
      resolve(config?.backend);
    });

    request.addEventListener('error', () => {
      reject(request.error ?? new Error('Failed to retrieve build filesystem config'));
    });

    transaction.addEventListener('complete', () => {
      db.close();
    });
  });
}

/**
 * Remove the filesystem config for a build.
 * Should be called when a build is deleted.
 */
export async function deleteBuildFilesystemConfig(buildId: string): Promise<void> {
  const db = await openHandleDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(configsStoreName, 'readwrite');
    const store = transaction.objectStore(configsStoreName);
    const request = store.delete(buildId);

    request.addEventListener('success', () => {
      resolve();
    });

    request.addEventListener('error', () => {
      reject(request.error ?? new Error('Failed to delete build filesystem config'));
    });

    transaction.addEventListener('complete', () => {
      db.close();
    });
  });
}

/**
 * Retrieve all build filesystem configs.
 * Used by the /files route to enumerate builds across all backends.
 */
export async function getAllBuildFilesystemConfigs(): Promise<BuildFilesystemConfig[]> {
  const db = await openHandleDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(configsStoreName, 'readonly');
    const store = transaction.objectStore(configsStoreName);
    const request = store.getAll();

    request.addEventListener('success', () => {
      const configs = request.result as BuildFilesystemConfig[];
      resolve(configs);
    });

    request.addEventListener('error', () => {
      reject(request.error ?? new Error('Failed to retrieve all build filesystem configs'));
    });

    transaction.addEventListener('complete', () => {
      db.close();
    });
  });
}

/**
 * ZenFS Configuration Module
 *
 * Provides filesystem configuration for different backends:
 * - IndexedDB: Default production backend using IndexedDB for persistent storage
 * - OPFS: Alternative production backend using Origin Private File System
 * - WebAccess: File System Access API backend for real local directory access
 * - InMemory: Used in tests for fast, isolated filesystem operations
 *
 * Mount points:
 * - '/': Main application filesystem
 * - '/git': Isolated filesystem for git operations (separate store)
 */
import { configure, InMemory, fs as zenfs } from '@zenfs/core';
import { IndexedDB, WebAccess } from '@zenfs/dom';
import type { FilesystemBackend, FilesystemBackendConfig } from '@taucad/types';
import { filesystemBackendMeta } from '@taucad/types/constants';
import { isOpfsSupported } from '#constants/browser.constants.js';
import { metaConfig } from '#constants/meta.constants.js';

/**
 * Git filesystem mount point.
 * All git operations should use paths under this mount.
 */
export const gitMountPoint = '/git';

/**
 * Track if filesystem has been configured to avoid re-initialization.
 */
let currentBackend: FilesystemBackend | undefined;
let configurationPromise: Promise<void> | undefined;
let gitMountConfigured = false;

/**
 * Backend registry - defines configuration for each backend type.
 */
const indexedDbBackend = {
  name: 'indexeddb',
  ...filesystemBackendMeta.indexeddb,
  canHandle: () => true,
  async create() {
    const storeName = `${metaConfig.databasePrefix}fs`;
    const mountConfig = {
      mounts: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- ZenFS uses '/' as mount point key
        '/': {
          backend: IndexedDB,
          storeName,
        },
      },
    };

    try {
      await configure(mountConfig);
    } catch (error) {
      // Detect IndexedDB corruption (e.g. from prior ZenFS race conditions) and recover
      // by deleting the corrupt database and retrying with a fresh store.
      if (error instanceof SyntaxError && error.message.includes('is not valid JSON')) {
        console.warn(
          '[FileManager:ZenFS] Corrupt IndexedDB detected, deleting database and retrying with fresh store...',
        );
        await deleteIndexedDatabase(storeName);
        await configure(mountConfig);
        return;
      }

      throw error;
    }
  },
} as const satisfies FilesystemBackendConfig;

/**
 * Delete an IndexedDB database by name.
 * Used for corruption recovery when the stored data is invalid.
 */
async function deleteIndexedDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener('success', () => {
      resolve();
    });
    request.addEventListener('error', () => {
      reject(request.error ?? new Error(`Failed to delete IndexedDB database: ${name}`));
    });
  });
}

const opfsBackend = {
  name: 'opfs',
  ...filesystemBackendMeta.opfs,
  canHandle: () => isOpfsSupported,
  async create() {
    const rootHandle = await navigator.storage.getDirectory();
    await configure({
      mounts: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- ZenFS uses '/' as mount point key
        '/': { backend: WebAccess, handle: rootHandle },
      },
    });
  },
} as const satisfies FilesystemBackendConfig;

/**
 * WebAccess (File System Access API) backend state.
 *
 * The FileSystemDirectoryHandle is set from the main thread via the worker's
 * setDirectoryHandle() method before configuring the webaccess backend.
 * The handle is obtained via showDirectoryPicker() and persisted in IndexedDB
 * by the handle-store module.
 */
let webAccessHandle: FileSystemDirectoryHandle | undefined;

/**
 * Set the FileSystemDirectoryHandle for the webaccess backend.
 * Must be called before configuring with 'webaccess' backend.
 */
export function setWebAccessHandle(handle: FileSystemDirectoryHandle): void {
  webAccessHandle = handle;
}

/**
 * Get the current FileSystemDirectoryHandle for the webaccess backend.
 * Returns undefined if no handle has been set.
 */
export function getWebAccessHandle(): FileSystemDirectoryHandle | undefined {
  return webAccessHandle;
}

const webAccessBackend = {
  name: 'webaccess',
  ...filesystemBackendMeta.webaccess,
  canHandle: () => webAccessHandle !== undefined,
  async create() {
    if (!webAccessHandle) {
      throw new Error('No directory handle set. Call setWebAccessHandle() before configuring webaccess backend.');
    }

    await configure({
      mounts: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- ZenFS uses '/' as mount point key
        '/': { backend: WebAccess, handle: webAccessHandle },
      },
    });
  },
} as const satisfies FilesystemBackendConfig;

const memoryBackend = {
  name: 'memory',
  ...filesystemBackendMeta.memory,
  canHandle: () => true,
  async create() {
    await configure({
      mounts: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- ZenFS uses '/' as mount point key
        '/': InMemory,
      },
    });
  },
} as const satisfies FilesystemBackendConfig;

/** Registry of all available backends */
export const filesystemBackends = [indexedDbBackend, opfsBackend, webAccessBackend, memoryBackend] as const;

/** Get backend config by name */
export function getBackendConfig(name: FilesystemBackend): FilesystemBackendConfig {
  const backend = filesystemBackends.find((b) => b.name === name);
  if (!backend) {
    throw new Error(`Unknown backend: ${name}`);
  }

  return backend;
}

/**
 * Configure ZenFS with the specified backend.
 * Safe to call multiple times - will only configure once unless reset.
 *
 * @param backend - The backend type to use ('indexeddb' or 'opfs' for production, 'memory' for tests)
 * @throws Error if the backend is not supported by the browser
 */
export async function configureFilesystem(backend: FilesystemBackend = 'indexeddb'): Promise<void> {
  // If already configured with the same backend, return the existing promise
  if (currentBackend === backend && configurationPromise) {
    return configurationPromise;
  }

  // If there's an existing configuration in progress, await it before starting a new one
  // This prevents concurrent reconfiguration races
  if (configurationPromise) {
    try {
      await configurationPromise;
    } catch {
      // Previous configuration failed, proceed with new configuration
    }

    // After awaiting, check again if we're now configured with the desired backend
    if (currentBackend === backend) {
      return;
    }
  }

  const config = getBackendConfig(backend);
  if (!config.canHandle()) {
    throw new Error(`Backend "${backend}" is not supported in this browser.`);
  }

  // Create a new configuration promise with error handling to allow retries
  configurationPromise = (async (): Promise<void> => {
    try {
      await config.create();
      // Only set currentBackend after successful configure() completes
      currentBackend = backend;
      gitMountConfigured = true;
    } catch (error) {
      // Clear the promise on failure so retries are possible
      configurationPromise = undefined;
      throw error;
    }
  })();

  return configurationPromise;
}

/**
 * Reconfigure the filesystem with a different backend.
 * Clears the current configuration state and configures with the new backend.
 *
 * @param backend - The new backend type to use
 * @throws Error if the backend is not supported by the browser
 */
export async function reconfigureFilesystem(backend: FilesystemBackend): Promise<void> {
  const config = getBackendConfig(backend);
  if (!config.canHandle()) {
    throw new Error(`Backend "${backend}" is not supported in this browser.`);
  }

  // Clear state to allow reconfiguration
  currentBackend = undefined;
  configurationPromise = undefined;
  gitMountConfigured = false;

  await configureFilesystem(backend);
}

/**
 * Ensure filesystem is configured before performing operations.
 * This is idempotent - if already configured, it will wait for completion
 * without reconfiguring (first caller's backend wins).
 *
 * @param backend - The backend type to configure if not already configured
 */
export async function ensureFilesystemConfigured(backend: FilesystemBackend): Promise<void> {
  if (configurationPromise) {
    // Already configured or configuring - just wait, ignore passed backend
    await configurationPromise;
    return;
  }

  // Not configured yet - configure with the specified backend
  await configureFilesystem(backend);
}

/**
 * Reset the filesystem configuration.
 * Used in tests to start with a fresh InMemory filesystem.
 */
export async function resetFilesystem(): Promise<void> {
  currentBackend = undefined;
  configurationPromise = undefined;
  gitMountConfigured = false;
  await configure({
    mounts: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- ZenFS uses '/' as mount point key
      '/': InMemory,
    },
  });
  currentBackend = 'memory';
  gitMountConfigured = true;
  configurationPromise = Promise.resolve();
}

/**
 * Ensure git filesystem mount is configured.
 * This is idempotent - if already configured or in-flight, waits for completion.
 *
 * Note: Git mount is automatically configured with the main filesystem.
 * This function is provided for explicit initialization in git operations.
 *
 * Handles:
 * - Already configured: returns immediately
 * - In-flight configuration: waits for the existing promise
 * - Failed configuration: allows retry by calling configureFilesystem()
 */
export async function ensureGitMountConfigured(): Promise<void> {
  // If there's an in-flight or completed configuration, wait for it
  if (configurationPromise) {
    await configurationPromise;
    // After awaiting, check if git mount was successfully configured
    if (gitMountConfigured) {
      return;
    }
    // Configuration completed but git mount not configured (shouldn't happen
    // in normal flow, but handle it by reconfiguring)
  }

  // Configure filesystem with IndexedDB backend which includes git mount.
  // Keep this explicit so git operations never fall back to OPFS.
  await configureFilesystem('indexeddb');
}

/**
 * Check if the git mount has been configured.
 */
export function isGitMountConfigured(): boolean {
  return gitMountConfigured;
}

/**
 * Get whether the filesystem has been configured.
 */
export function isFilesystemConfigured(): boolean {
  return currentBackend !== undefined;
}

/**
 * Get the current backend type.
 */
export function getCurrentBackend(): FilesystemBackend | undefined {
  return currentBackend;
}

/**
 * ZenFS filesystem instance.
 * Provides Node.js-compatible filesystem API across all backends.
 */
// eslint-disable-next-line unicorn/prefer-export-from -- Aliased export for cleaner imports throughout app
export const fs = zenfs;

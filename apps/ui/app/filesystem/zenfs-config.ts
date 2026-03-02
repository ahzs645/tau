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
import type { FileSystemBackend, FileSystemBackendConfig } from '@taucad/types';
import { filesystemBackendMeta } from '@taucad/types/constants';
import { isOpfsSupported } from '#constants/browser.constants.js';
import { metaConfig } from '#constants/meta.constants.js';

/**
 * Track if filesystem has been configured to avoid re-initialization.
 */
let currentBackend: FileSystemBackend | undefined;
let configurationPromise: Promise<void> | undefined;

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
      console.error('[ZenFS] IndexedDB configuration failed', error);
      throw error;
    }
  },
} as const satisfies FileSystemBackendConfig;

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
} as const satisfies FileSystemBackendConfig;

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
} as const satisfies FileSystemBackendConfig;

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
} as const satisfies FileSystemBackendConfig;

/** Registry of all available backends */
export const filesystemBackends = [indexedDbBackend, opfsBackend, webAccessBackend, memoryBackend] as const;

/** Get backend config by name */
export function getBackendConfig(name: FileSystemBackend): FileSystemBackendConfig {
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
export async function configureFileSystem(backend: FileSystemBackend = 'indexeddb'): Promise<void> {
  if (currentBackend === backend && configurationPromise) {
    return configurationPromise;
  }

  if (configurationPromise) {
    try {
      await configurationPromise;
    } catch {
      // Previous configuration failed, proceed with new configuration
    }

    if (currentBackend === backend) {
      return;
    }
  }

  const config = getBackendConfig(backend);
  if (!config.canHandle()) {
    throw new Error(`Backend "${backend}" is not supported in this browser.`);
  }

  configurationPromise = (async (): Promise<void> => {
    try {
      await config.create();
      currentBackend = backend;
    } catch (error) {
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
export async function reconfigureFileSystem(backend: FileSystemBackend): Promise<void> {
  const config = getBackendConfig(backend);
  if (!config.canHandle()) {
    throw new Error(`Backend "${backend}" is not supported in this browser.`);
  }

  // Clear state to allow reconfiguration
  currentBackend = undefined;
  configurationPromise = undefined;

  await configureFileSystem(backend);
}

/**
 * Ensure filesystem is configured before performing operations.
 * This is idempotent - if already configured, it will wait for completion
 * without reconfiguring (first caller's backend wins).
 *
 * @param backend - The backend type to configure if not already configured
 */
export async function ensureFileSystemConfigured(backend: FileSystemBackend): Promise<void> {
  if (configurationPromise) {
    // Already configured or configuring - just wait, ignore passed backend
    await configurationPromise;
    return;
  }

  // Not configured yet - configure with the specified backend
  await configureFileSystem(backend);
}

/**
 * Reset the filesystem configuration.
 * Used in tests to start with a fresh InMemory filesystem.
 */
export async function resetFileSystem(): Promise<void> {
  currentBackend = undefined;
  configurationPromise = undefined;
  await configure({
    mounts: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- ZenFS uses '/' as mount point key
      '/': InMemory,
    },
  });
  currentBackend = 'memory';
  configurationPromise = Promise.resolve();
}

/**
 * Ensure git filesystem mount is configured.
 * This is idempotent - if already configured or in-flight, waits for completion.
 */

/**
 * Get whether the filesystem has been configured.
 */
export function isFileSystemConfigured(): boolean {
  return currentBackend !== undefined;
}

/**
 * Get the current backend type.
 */
export function getCurrentBackend(): FileSystemBackend | undefined {
  return currentBackend;
}

/**
 * ZenFS filesystem instance.
 * Provides Node.js-compatible filesystem API across all backends.
 */
// eslint-disable-next-line unicorn/prefer-export-from -- Aliased export for cleaner imports throughout app
export const fs = zenfs;

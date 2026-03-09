import type { FileSystemBackend } from '@taucad/types';
import type { FileSystemProvider } from '#types.js';
import { createIndexedDbProvider } from '#providers/indexeddb-provider.js';
import { createWebAccessProvider } from '#providers/webaccess-provider.js';
import { createMemoryProvider } from '#providers/memory-provider.js';

/** Configuration for {@link ProviderRegistry}. */
export type ProviderRegistryOptions = {
  databasePrefix?: string;
};

/**
 * Manages the lifecycle and caching of filesystem providers across
 * backends (IndexedDB, OPFS, Web Access, memory).
 */
export class ProviderRegistry {
  private readonly _providers = new Map<string, FileSystemProvider>();
  private readonly _standaloneProviders = new Map<string, FileSystemProvider>();
  private readonly _databasePrefix: string;
  private _activeBackend: FileSystemBackend = 'indexeddb';
  private _directoryHandle: FileSystemDirectoryHandle | undefined;

  /**
   * Create a ProviderRegistry.
   *
   * @param options - Optional registry configuration.
   */
  public constructor(options?: ProviderRegistryOptions) {
    this._databasePrefix = options?.databasePrefix ?? 'tau';
  }

  /**
   * Get or lazily create a provider for the given backend.
   *
   * @param backend - Backend key; defaults to the active backend.
   * @returns Cached or newly created provider.
   */
  public async getProvider(backend?: FileSystemBackend): Promise<FileSystemProvider> {
    const key = backend ?? this._activeBackend;
    const cached = this._providers.get(key);
    if (cached) {
      return cached;
    }

    const provider = await this._createProvider(key);
    this._providers.set(key, provider);
    return provider;
  }

  /**
   * Shorthand for `getProvider()` using the currently active backend.
   *
   * @returns The active provider instance.
   */
  public async getActiveProvider(): Promise<FileSystemProvider> {
    return this.getProvider(this._activeBackend);
  }

  /**
   * Get or create a standalone provider for cross-backend reads
   * (e.g. the `/files` route). Cached separately from active providers.
   *
   * @param backend - Backend to create the provider for.
   * @param handle - Optional directory handle for webaccess backends.
   * @returns Standalone provider instance.
   */
  public async getStandaloneProvider(
    backend: FileSystemBackend,
    handle?: FileSystemDirectoryHandle,
  ): Promise<FileSystemProvider> {
    const cacheKey = backend === 'webaccess' && handle ? `${backend}:${handle.name}` : backend;

    const cached = this._standaloneProviders.get(cacheKey);
    if (cached) {
      return cached;
    }

    const provider = await this._createProvider(backend, handle);
    this._standaloneProviders.set(cacheKey, provider);
    return provider;
  }

  /**
   * Switch the active backend, disposing the previous provider and
   * invalidating any standalone provider for that backend.
   *
   * @param backend - New active backend.
   * @param handle - Optional directory handle for webaccess backends.
   */
  public async switchActiveProvider(backend: FileSystemBackend, handle?: FileSystemDirectoryHandle): Promise<void> {
    if (handle) {
      this._directoryHandle = handle;
    }

    this.invalidateStandaloneProvider(backend);

    const existingProvider = this._providers.get(backend);
    if (existingProvider) {
      existingProvider.dispose();
      this._providers.delete(backend);
    }

    this._activeBackend = backend;
    await this.getProvider(backend);
  }

  /**
   * Dispose and remove cached standalone providers for a backend.
   *
   * @param backend - Backend whose standalone providers to invalidate.
   */
  public invalidateStandaloneProvider(backend: FileSystemBackend): void {
    const keysToRemove: string[] = [];
    for (const key of this._standaloneProviders.keys()) {
      if (key === backend || key.startsWith(`${backend}:`)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this._standaloneProviders.get(key)?.dispose();
      this._standaloneProviders.delete(key);
    }
  }

  /**
   * Set the directory handle for webaccess backends.
   *
   * @param handle - Browser File System Access API directory handle.
   */
  public setDirectoryHandle(handle: FileSystemDirectoryHandle): void {
    this._directoryHandle = handle;
    this.invalidateStandaloneProvider('webaccess');
  }

  /**
   * The currently active storage backend.
   *
   * @returns Active backend key.
   */
  public get activeBackend(): FileSystemBackend {
    return this._activeBackend;
  }

  /** Dispose all cached providers (active and standalone). */
  public disposeAll(): void {
    for (const provider of this._providers.values()) {
      provider.dispose();
    }
    this._providers.clear();

    for (const provider of this._standaloneProviders.values()) {
      provider.dispose();
    }
    this._standaloneProviders.clear();
  }

  private async _createProvider(
    backend: FileSystemBackend,
    handle?: FileSystemDirectoryHandle,
  ): Promise<FileSystemProvider> {
    switch (backend) {
      case 'indexeddb': {
        return createIndexedDbProvider(this._databasePrefix);
      }
      case 'opfs': {
        const rootHandle = await navigator.storage.getDirectory();
        return createWebAccessProvider(rootHandle);
      }
      case 'webaccess': {
        const webHandle = handle ?? this._directoryHandle;
        if (!webHandle) {
          throw new Error('No directory handle set. Call setDirectoryHandle() before using webaccess backend.');
        }
        return createWebAccessProvider(webHandle);
      }
      case 'memory': {
        return createMemoryProvider();
      }
      default: {
        throw new Error(`Unknown backend: ${backend as string}`);
      }
    }
  }
}

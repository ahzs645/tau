import type { FileSystemBackend } from '@taucad/types';
import type { FileSystemProvider } from '#types.js';
import { MemoryProvider } from '#providers/memory-provider.js';
import { DirectIdbProvider } from '#providers/direct-idb-provider.js';
import { OPFSProvider } from '#providers/opfs-provider.js';
import { FileSystemAccessProvider } from '#providers/fs-access-provider.js';

/**
 * Configuration for {@link ProviderRegistry}.
 * @public
 */
export type ProviderRegistryOptions = {
  databasePrefix?: string;
};

/**
 * Factory for filesystem provider instances across backends
 * (IndexedDB, OPFS, Web Access, memory).
 *
 * Providers created via {@link createMountProvider} are uncached — the caller
 * owns their lifecycle. {@link getStandaloneProvider} caches providers
 * separately for read-only browsing use-cases.
 *
 * @public
 */
export class ProviderRegistry {
  private readonly _standaloneProviders = new Map<string, FileSystemProvider>();
  private readonly _databasePrefix: string;
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
   * Get or create a standalone provider for cross-backend reads
   * (e.g. the `/files` route). Cached separately from mount providers.
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
   * Create a fresh provider instance for use as a mount target.
   * Does not cache the instance. The caller owns the provider's lifecycle
   * and must dispose it.
   *
   * @param backend - Backend type to create.
   * @param handle - Optional directory handle for webaccess backends.
   * @returns A new, uncached provider instance.
   */
  public async createMountProvider(
    backend: FileSystemBackend,
    handle?: FileSystemDirectoryHandle,
  ): Promise<FileSystemProvider> {
    return this._createProvider(backend, handle);
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

  /** Dispose all cached standalone providers. */
  public disposeAll(): void {
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
        const provider = new DirectIdbProvider(this._databasePrefix);
        await provider.initialize();
        return provider;
      }
      case 'opfs': {
        const provider = new OPFSProvider();
        await provider.initialize();
        return provider;
      }
      case 'webaccess': {
        const webHandle = handle ?? this._directoryHandle;
        if (!webHandle) {
          throw new Error('No directory handle set. Call setDirectoryHandle() before using webaccess backend.');
        }
        return new FileSystemAccessProvider(webHandle);
      }
      case 'memory': {
        return new MemoryProvider();
      }
      default: {
        throw new Error(`Unknown backend: ${backend as string}`);
      }
    }
  }
}

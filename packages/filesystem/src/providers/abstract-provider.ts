/**
 * Abstract base class for native filesystem providers.
 *
 * Implements shared logic (exists, lstat, readFile with encoding, recursive mkdir,
 * dispose) so concrete providers only implement storage-specific primitives.
 *
 * @see docs/research/filesystem-runtime-strategy.md
 */

import type { FileSystemProvider, ProviderCapabilities, ProviderFileStat } from '#types.js';

/**
 * Base class for native {@link FileSystemProvider} implementations.
 *
 * Subclasses implement the abstract storage primitives; this class provides
 * the shared derived operations that are identical across all browser-based
 * backends (IndexedDB, OPFS, File System Access API).
 *
 * @public
 */
export abstract class AbstractFileSystemProvider implements FileSystemProvider {
  public abstract readonly id: string;
  public abstract readonly capabilities: ProviderCapabilities;

  // -- Public instance methods (readFile, mkdir, exists, lstat, dispose) -------

  // Overloaded readFile satisfying the FileSystemProvider contract.
  // Declared as a method statement so TypeScript applies loose overload
  // implementation checking (see docs/research/typescript-overloads.md §4).
  public readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  public readFile(path: string, encoding: 'utf8'): Promise<string>;
  public async readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array<ArrayBuffer> | string> {
    const raw = await this.readFileRaw(path);
    return encoding === 'utf8' ? new TextDecoder().decode(raw) : raw;
  }

  public async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (!options?.recursive) {
      await this.mkdirSingle(path);
      return;
    }

    const segments = path.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      try {
        // oxlint-disable-next-line no-await-in-loop -- Sequential mkdir required for recursive creation
        await this.mkdirSingle(current);
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') {
          throw error;
        }
      }
    }
  }

  public async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  public async lstat(path: string): Promise<ProviderFileStat> {
    return this.stat(path);
  }

  // oxlint-disable-next-line no-empty-function -- Default no-op; subclasses override when cleanup is needed
  public dispose(): void {}

  // -- Public abstract methods (storage-specific) -----------------------------

  public abstract writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void>;
  public abstract readdir(path: string): Promise<string[]>;
  public abstract stat(path: string): Promise<ProviderFileStat>;
  public abstract unlink(path: string): Promise<void>;
  public abstract rmdir(path: string): Promise<void>;
  public abstract rename(from: string, to: string): Promise<void>;

  // -- Protected abstract methods (internal primitives) -----------------------

  /**
   * Read raw bytes from the storage backend.
   * Concrete providers implement this; the public `readFile` wraps it
   * with optional UTF-8 decoding.
   */
  protected abstract readFileRaw(path: string): Promise<Uint8Array<ArrayBuffer>>;

  /**
   * Create a single directory. Subclasses must implement this for non-recursive
   * creation. The recursive variant is handled by the base class.
   */
  protected abstract mkdirSingle(path: string): Promise<void>;
}

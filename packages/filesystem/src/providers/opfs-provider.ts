/**
 * Origin Private File System (OPFS) filesystem provider.
 *
 * OPFS is the browser's built-in private filesystem accessed via
 * `navigator.storage.getDirectory()`. It uses the same `FileSystemDirectoryHandle`
 * API as the File System Access API, so this provider extends
 * {@link FileSystemAccessProvider} and only overrides initialization and identity.
 *
 * @see docs/research/shared-worker-gate-startup-performance.md R18
 * @see docs/research/filesystem-runtime-strategy.md Phase 5
 */

import type { ProviderCapabilities } from '#types.js';
import { FileSystemAccessProvider } from '#providers/fs-access-provider.js';

/**
 * Filesystem provider backed by the Origin Private File System.
 *
 * @public
 */
export class OPFSProvider extends FileSystemAccessProvider {
  public override get id(): string {
    return 'opfs';
  }

  public override readonly capabilities: ProviderCapabilities = {
    persistent: true,
    writable: true,
    quotaBased: true,
  };

  private _initialized = false;

  /**
   * Create an uninitialized provider. Call {@link initialize} before use.
   * A temporary empty handle is passed to super; replaced by the real OPFS
   * root in `initialize()`.
   */
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Placeholder handle replaced in initialize()
  public constructor() {
    super(undefined as unknown as FileSystemDirectoryHandle);
  }

  /**
   * Obtain the OPFS root directory handle from the browser.
   */
  public async initialize(): Promise<void> {
    const root = await navigator.storage.getDirectory();
    this._rootHandle = root;
    this._initialized = true;
  }

  public override async writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void> {
    this._ensureInitialized();
    return super.writeFile(path, data);
  }

  public override async readdir(path: string): Promise<string[]> {
    this._ensureInitialized();
    return super.readdir(path);
  }

  // ---------------------------------------------------------------------------
  // Protected instance methods
  // ---------------------------------------------------------------------------

  protected override async readFileRaw(path: string): Promise<Uint8Array<ArrayBuffer>> {
    this._ensureInitialized();
    return super.readFileRaw(path);
  }

  // ---------------------------------------------------------------------------
  // Private instance methods
  // ---------------------------------------------------------------------------

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error('OPFSProvider is not initialized. Call initialize() first.');
    }
  }
}

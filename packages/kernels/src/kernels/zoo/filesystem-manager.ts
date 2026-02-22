/* eslint-disable @typescript-eslint/parameter-properties -- parameter properties are non-erasable TypeScript */
import type { KernelFilesystem } from '@taucad/types';
import { joinPath } from '@taucad/utils/path';

/// FileSystemManager is a stateless adapter that provides filesystem operations
/// to the WASM context. It resolves relative paths to absolute using the provided basePath.
export class FileSystemManager {
  private readonly filesystem: KernelFilesystem;
  private readonly basePath: string;

  public constructor(filesystem: KernelFilesystem, basePath: string) {
    this.filesystem = filesystem;
    this.basePath = basePath;
  }

  /**
   * Called from WASM.
   * Reads a file using a path relative to basePath.
   */
  public async readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
    return this.filesystem.readFile(this.resolvePath(path));
  }

  /**
   * Called from WASM.
   * Checks if a file exists using a path relative to basePath.
   */
  public async exists(path: string): Promise<boolean> {
    return this.filesystem.exists(this.resolvePath(path));
  }

  /**
   * Called from WASM.
   * Lists all files in a directory using a path relative to basePath.
   */
  public async getAllFiles(path: string): Promise<string[]> {
    return this.filesystem.readdir(this.resolvePath(path));
  }

  /**
   * Resolve a relative path to an absolute path using basePath.
   */
  private resolvePath(relativePath: string): string {
    return joinPath(this.basePath, relativePath);
  }
}

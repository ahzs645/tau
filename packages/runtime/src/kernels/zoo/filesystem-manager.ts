import { joinPath } from '@taucad/utils/path';
import type { KernelFileSystem } from '#types/runtime-kernel.types.js';

/**
 * Stateless adapter that provides filesystem operations to the WASM context.
 * Resolves relative paths to absolute using the provided basePath.
 */
export class FileSystemManager {
  /* oxlint-disable-next-line @typescript-eslint/parameter-properties -- parameter properties are non-erasable TypeScript */
  private readonly filesystem: KernelFileSystem;
  /* oxlint-disable-next-line @typescript-eslint/parameter-properties -- parameter properties are non-erasable TypeScript */
  private readonly basePath: string;

  public constructor(filesystem: KernelFileSystem, basePath: string) {
    this.filesystem = filesystem;
    this.basePath = basePath;
  }

  /**
   * Called from WASM.
   * Reads a file using a path relative to basePath.
   *
   * @param path - the file path relative to basePath
   * @returns the file contents as a byte array
   */
  public async readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const out = await this.filesystem.readFile(this.resolvePath(path));
    return out;
  }

  /**
   * Called from WASM.
   * Checks if a file exists using a path relative to basePath.
   *
   * @param path - the file path relative to basePath
   * @returns whether the file exists
   */
  public async exists(path: string): Promise<boolean> {
    const ok = await this.filesystem.exists(this.resolvePath(path));
    return ok;
  }

  /**
   * Called from WASM.
   * Lists all files in a directory using a path relative to basePath.
   *
   * @param path - the directory path relative to basePath
   * @returns JSON array string of file names — matches kcl-lib WASM `getAllFiles` (`value.as_string` + `serde_json::from_str`)
   */
  public async getAllFiles(path: string): Promise<string> {
    const files = await this.filesystem.readdir(this.resolvePath(path));
    for (const name of files) {
      if (name.includes('/')) {
        throw new Error(
          `FileSystemManager.getAllFiles: kcl-lib expects single-segment filenames from readdir; got "${name}"`,
        );
      }
    }

    const json = JSON.stringify(files);
    return json;
  }

  /**
   * Resolve a relative path to an absolute path using basePath.
   *
   * @param relativePath - the path to resolve against basePath
   * @returns the absolute path
   */
  private resolvePath(relativePath: string): string {
    return joinPath(this.basePath, relativePath);
  }
}

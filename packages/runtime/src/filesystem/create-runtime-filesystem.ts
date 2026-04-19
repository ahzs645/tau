/**
 * Wrap a RuntimeFileSystemBase with default implementations
 * for the enhanced RuntimeFileSystem helper methods.
 *
 * Backends may supply optimized overrides for any of the enhanced methods.
 * If not supplied, the wrapper builds them from the 11 base primitives.
 */

import type { FileStatEntry } from '@taucad/types';
import type { RuntimeFileSystem, RuntimeFileSystemBase } from '#types/runtime-kernel.types.js';

type EnhancedMethods = Pick<RuntimeFileSystem, 'readFiles' | 'readdirContents' | 'readdirStat' | 'ensureDir'>;

/**
 * Create an enhanced `RuntimeFileSystem` from a base implementation.
 *
 * The four helper methods (`readFiles`, `readdirContents`, `readdirStat`, `ensureDir`)
 * have default implementations built from the 11 primitives. Backends can supply
 * optimized overrides (e.g. the FileManager can batch-read at the provider layer).
 *
 * @param base - Base filesystem (11 primitives) with optional enhanced method overrides
 * @returns Full RuntimeFileSystem with all enhanced methods guaranteed
 * @public
 */
export function createRuntimeFileSystem(base: RuntimeFileSystemBase & Partial<EnhancedMethods>): RuntimeFileSystem {
  return {
    ...base,

    readFiles:
      base.readFiles ??
      (async (paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>> => {
        const entries = await Promise.all(paths.map(async (p) => [p, await base.readFile(p)] as const));
        return Object.fromEntries(entries) as Record<string, Uint8Array<ArrayBuffer>>;
      }),

    ensureDir:
      base.ensureDir ??
      (async (path: string): Promise<void> => {
        await base.mkdir(path, { recursive: true });
      }),

    readdirContents:
      base.readdirContents ??
      (async (directoryPath: string): Promise<Record<string, Uint8Array<ArrayBuffer>>> => {
        const names = await base.readdir(directoryPath);
        const entries = await Promise.all(
          names.map(async (name) => {
            const fullPath = `${directoryPath}/${name}`;
            const s = await base.stat(fullPath);
            if (s.type === 'dir') {
              return undefined;
            }

            const content = await base.readFile(fullPath);
            return [name, content] as const;
          }),
        );
        return Object.fromEntries(
          entries.filter((entry): entry is readonly [string, Uint8Array<ArrayBuffer>] => entry !== undefined),
        ) as Record<string, Uint8Array<ArrayBuffer>>;
      }),

    readdirStat:
      base.readdirStat ??
      (async (directoryPath: string): Promise<FileStatEntry[]> => {
        const names = await base.readdir(directoryPath);
        return Promise.all(
          names.map(async (name) => {
            const fullPath = `${directoryPath}/${name}`;
            const s = await base.stat(fullPath);
            return { path: fullPath, name, ...s };
          }),
        );
      }),
  };
}

/**
 * Wrap a KernelFileSystemBase with default implementations
 * for the enhanced KernelFileSystem helper methods.
 *
 * Backends may supply optimized overrides for any of the enhanced methods.
 * If not supplied, the wrapper builds them from the 11 base primitives.
 */

import type { FileStatEntry } from '@taucad/types';
import type { KernelFileSystem, KernelFileSystemBase } from '#types/kernel-worker.types.js';

type EnhancedMethods = Pick<KernelFileSystem, 'readFiles' | 'readdirContents' | 'readdirStat' | 'ensureDir'>;

/**
 * Create an enhanced `KernelFileSystem` from a base implementation.
 *
 * The four helper methods (`readFiles`, `readdirContents`, `readdirStat`, `ensureDir`)
 * have default implementations built from the 11 primitives. Backends can supply
 * optimized overrides (e.g. the FileManager can batch-read at the ZenFS layer).
 *
 * @param base - Base filesystem (11 primitives) with optional enhanced method overrides
 * @returns Full KernelFileSystem with all enhanced methods guaranteed
 */
export function createKernelFileSystem(base: KernelFileSystemBase & Partial<EnhancedMethods>): KernelFileSystem {
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
      (async (dirPath: string): Promise<Record<string, Uint8Array<ArrayBuffer>>> => {
        const names = await base.readdir(dirPath);
        const entries = await Promise.all(
          names.map(async (name) => {
            const fullPath = `${dirPath}/${name}`;
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
      (async (dirPath: string): Promise<FileStatEntry[]> => {
        const names = await base.readdir(dirPath);
        return Promise.all(
          names.map(async (name) => {
            const fullPath = `${dirPath}/${name}`;
            const s = await base.stat(fullPath);
            return { path: fullPath, name, ...s };
          }),
        );
      }),
  };
}

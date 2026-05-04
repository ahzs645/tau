import type { FileSystemClient } from '#file-system-client.js';

type AssertKeys<Expected extends keyof FileSystemClient> = Expected;

/**
 * Compile-only export: these RPC entry points must remain on {@link FileSystemClient}.
 *
 * @public
 */
export type FileSystemClientCoreRpcKeys = AssertKeys<
  'readFile' | 'writeFile' | 'stat' | 'readDirectory' | 'getDirectoryStat' | 'exists' | 'watch'
>;

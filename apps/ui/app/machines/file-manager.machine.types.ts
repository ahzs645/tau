/**
 * File Manager Machine Types
 *
 * Shared types for the file manager machine and its consumers.
 * This file is kept separate from the machine implementation to avoid
 * importing browser-only dependencies (Web Workers) during SSR.
 *
 * Note: `import type` is used for machine imports — this is purely
 * compile-time and produces zero runtime imports, so SSR is unaffected.
 */

import type { ActorRefFrom } from 'xstate';
import type { FileStatEntry } from '@taucad/types';
import type { FileSystemClient } from '@taucad/fs-client/file-system-client';
import type { FileManagerMachine } from '#machines/file-manager.machine.js';

/**
 * Type-safe reference to the file manager XState actor.
 * Preserves the full XState type including literal event type unions.
 */
export type FileManagerRef = ActorRefFrom<FileManagerMachine>;

/**
 * File operations API surface used by Monaco services and UI components.
 * This is the superset of methods needed across all consumers.
 * Use `Pick<FileManagerApi, 'exists'>` etc. to narrow in component props.
 */
export type FileManagerApi = {
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
  exists: (path: string) => Promise<boolean>;
  readdir: (path: string) => Promise<string[]>;
  getDirectoryStat: (path: string) => Promise<FileStatEntry[]>;
};

/**
 * Full FileManager protocol served over MessagePort.
 * Alias of `FileSystemClient` for historical imports.
 */
export type FileManagerProtocol = FileSystemClient;

/**
 * Worker proxy: protocol plus optional `listen` for `fileChanged` and `dispose`.
 */
export type FileManagerProxy = FileSystemClient & {
  listen?: (event: string, handler: (data: unknown) => void) => () => void;
  dispose(): void;
};

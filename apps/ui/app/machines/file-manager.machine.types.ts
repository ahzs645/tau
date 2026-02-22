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
import type { FileStat } from '@taucad/types';
import type { FileManagerMachine } from '#machines/file-manager.machine.js';

/**
 * The source of the file write operation.
 * - 'editor': Write originated from user typing in the Monaco editor (special case for recursion prevention)
 * - 'user': Write originated from user action (create file, upload, etc.)
 * - 'machine': Write originated from machine/programmatic source (e.g., chat AI)
 */
export type FileWriteSource = 'editor' | 'user' | 'machine';

/**
 * Emitted events for UI consumers (toasts, Monaco updates, etc.)
 */
export type FileManagerEmitted =
  | { type: 'fileWritten'; path: string; data: Uint8Array<ArrayBuffer>; source: FileWriteSource }
  | { type: 'fileRead'; path: string; data: Uint8Array<ArrayBuffer> }
  | { type: 'fileRenamed'; oldPath: string; newPath: string }
  | { type: 'fileDeleted'; path: string; source: FileWriteSource };

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
  getDirectoryStat: (path: string) => Promise<FileStat[]>;
};

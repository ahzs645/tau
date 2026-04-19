/**
 * Filesystem Architecture Types
 *
 * Core types for the layered filesystem architecture:
 * - FileSystemProvider: abstraction over filesystem backends
 * - ProviderCapabilities: what a provider supports
 * - ProviderFileStat: stat result from provider operations
 * - ChangeEvent: push-based change notifications (canonical definition in @taucad/types)
 * - FileTreeNode: tree representation for /files route
 */

// oxlint-disable-next-line no-barrel-files/no-barrel-files -- re-export for internal consumers that import from #types.js
export type { ChangeEvent } from '@taucad/types';

/**
 * Capability flags describing what a storage provider supports.
 * @public
 */
export type ProviderCapabilities = {
  readonly persistent: boolean;
  readonly writable: boolean;
  readonly quotaBased: boolean;
  /** Whether the backend treats paths as case-sensitive. Defaults to `true`. */
  readonly caseSensitive?: boolean;
};

/**
 * Stat result returned by provider-level filesystem operations.
 * @public
 */
export type ProviderFileStat = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
};

/**
 * Backend-agnostic filesystem provider exposing POSIX-like operations.
 * @public
 */
export type FileSystemProvider = {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<ProviderFileStat>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  lstat(path: string): Promise<ProviderFileStat>;
  dispose(): void;
  /** Optional streaming read. When present, service routes through this instead of buffered readFile. */
  readFileStream?(path: string, options?: FileReadStreamOptions): ReadableStream<Uint8Array<ArrayBuffer>>;
  /** Optional batched readdir+stat. When present, eliminates N+1 stat calls per directory listing. */
  readdirWithStats?(path: string): Promise<Array<{ name: string } & ProviderFileStat>>;
};

/**
 * Options for streaming file reads.
 * @public
 */
export type FileReadStreamOptions = {
  /** Byte offset to start reading from. */
  position?: number;
  /** Maximum number of bytes to read. */
  length?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
};

/**
 * Node in a standalone backend file tree.
 * Used by the /files route to display all backends side-by-side.
 * @public
 */
export type FileTreeNode = {
  id: string;
  name: string;
  children?: FileTreeNode[];
};

/**
 * Cached directory entry with metadata, used by {@link DirectoryTreeCache}.
 * @public
 */
export type TreeEntry = {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
};

// =============================================================================
// Watch API types
// =============================================================================

/**
 * Filter mask for watch event types. When a field is `true`, events of that
 * type are delivered. When omitted or `undefined`, the type is included.
 * @public
 */
export type WatchEventFilter = {
  added?: boolean;
  updated?: boolean;
  deleted?: boolean;
  renamed?: boolean;
};

/**
 * Describes a filesystem watch subscription.
 *
 * - `paths`: absolute normalized watch roots
 * - `recursive`: watch subdirectories (default `false`)
 * - `includes`/`excludes`: glob patterns for path filtering
 * - `filter`: event type mask
 * - `correlationId`: echoed in outgoing events for client-side routing
 * @public
 */
export type WatchRequest = {
  paths: string[];
  recursive?: boolean;
  includes?: string[];
  excludes?: string[];
  filter?: WatchEventFilter;
  correlationId?: string;
};

/**
 * Events delivered to watch subscribers. `reset` and `overflow` signal that
 * the event stream is no longer reliable and consumers must resync.
 * @public
 */
export type WatchEvent =
  | { type: 'change'; path: string; correlationId?: string }
  | { type: 'delete'; path: string; correlationId?: string }
  | { type: 'rename'; oldPath: string; newPath: string; correlationId?: string }
  | { type: 'reset'; correlationId?: string }
  | { type: 'overflow'; correlationId?: string };

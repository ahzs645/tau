/**
 * Bridge between the FileSystemObserver API (Chrome 133+) and Tau's
 * ChangeEvent system. Provides progressive enhancement: returns `null`
 * when the API is unavailable, allowing callers to fall back to polling.
 *
 * @see https://developer.chrome.com/blog/file-system-observer
 */

import type { ChangeEvent } from '#types.js';
import type { FileSystemBackend } from '@taucad/types';

type FileSystemObserverCallback = (records: FileSystemChangeRecord[], observer: FileSystemObserver) => void;

type FileSystemChangeType = 'appeared' | 'disappeared' | 'modified' | 'moved' | 'unknown' | 'errored';

type FileSystemChangeRecord = {
  readonly root: FileSystemHandle;
  readonly changedHandle: FileSystemHandle;
  readonly relativePathComponents: readonly string[];
  readonly type: FileSystemChangeType;
  readonly relativePathMovedFrom?: readonly string[];
};

declare class FileSystemObserver {
  public constructor(callback: FileSystemObserverCallback);
  public observe(handle: FileSystemDirectoryHandle, options?: { recursive?: boolean }): Promise<void>;
  public unobserve(handle: FileSystemHandle): void;
  public disconnect(): void;
}

/**
 * Whether the FileSystemObserver API is available in the current environment.
 *
 * @returns `true` when `FileSystemObserver` exists in globalThis.
 * @public
 */
export function isFileSystemObserverSupported(): boolean {
  return typeof globalThis !== 'undefined' && 'FileSystemObserver' in globalThis;
}

/**
 * Maps a FileSystemObserver change record to a Tau ChangeEvent.
 *
 * @param record - The observer change record to map.
 * @param backend - Active filesystem backend identifier.
 * @returns The mapped ChangeEvent, or `undefined` for unhandled record types.
 * @public
 */
export function mapObserverRecord(record: FileSystemChangeRecord, backend: FileSystemBackend): ChangeEvent | undefined {
  const path = '/' + record.relativePathComponents.join('/');

  switch (record.type) {
    case 'appeared': {
      return { type: 'fileWritten', path, backend };
    }
    case 'modified': {
      return { type: 'fileWritten', path, backend };
    }
    case 'disappeared': {
      return { type: 'fileDeleted', path, backend };
    }
    case 'moved': {
      const oldPath = record.relativePathMovedFrom ? '/' + record.relativePathMovedFrom.join('/') : path;
      return { type: 'fileRenamed', oldPath, newPath: path, backend };
    }
    case 'errored':
    case 'unknown': {
      return undefined;
    }
    default: {
      return undefined;
    }
  }
}

/**
 * Wraps the FileSystemObserver API with Tau integration.
 * Emits ChangeEvents for observed directory mutations.
 * @public
 */
export class FileSystemObserverBridge {
  private _observer: FileSystemObserver | undefined;
  private readonly _onEvent: (event: ChangeEvent) => void;
  private readonly _backend: FileSystemBackend;

  public constructor(onEvent: (event: ChangeEvent) => void, backend: FileSystemBackend = 'webaccess') {
    this._onEvent = onEvent;
    this._backend = backend;
  }

  /**
   * Start observing a directory handle for changes.
   *
   * @param handle - Directory handle to observe recursively.
   * @returns `true` if the observer was started, `false` if the API is unavailable.
   */
  public async observe(handle: FileSystemDirectoryHandle): Promise<boolean> {
    if (!isFileSystemObserverSupported()) {
      return false;
    }

    this.disconnect();

    // eslint-disable-next-line @typescript-eslint/naming-convention -- Class constructor reference is conventionally PascalCase
    const ObserverClass = (globalThis as Record<string, unknown>)['FileSystemObserver'] as typeof FileSystemObserver;
    this._observer = new ObserverClass((records) => {
      for (const record of records) {
        const event = mapObserverRecord(record, this._backend);
        if (event) {
          this._onEvent(event);
        }
      }
    });

    await this._observer.observe(handle, { recursive: true });
    return true;
  }

  /**
   * Whether the bridge is actively observing.
   *
   * @returns `true` when the observer is connected.
   */
  public get isObserving(): boolean {
    return this._observer !== undefined;
  }

  /** Stop observing and release resources. */
  public disconnect(): void {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = undefined;
    }
  }
}

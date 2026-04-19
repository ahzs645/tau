import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isFileSystemObserverSupported,
  mapObserverRecord,
  FileSystemObserverBridge,
} from '#providers/filesystem-observer-bridge.js';
import type { ChangeEvent } from '#types.js';

const testBackend = 'webaccess';

function mockHandle(name: string): FileSystemDirectoryHandle {
  return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle;
}

describe('isFileSystemObserverSupported', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['FileSystemObserver'];
  });

  it('should return false when FileSystemObserver is not available', () => {
    expect(isFileSystemObserverSupported()).toBe(false);
  });

  it('should return true when FileSystemObserver is available', () => {
    (globalThis as Record<string, unknown>)['FileSystemObserver'] = class {
      public observe = vi.fn();
    };
    expect(isFileSystemObserverSupported()).toBe(true);
  });
});

describe('mapObserverRecord', () => {
  const root = mockHandle('root');
  const changedHandle = { kind: 'file', name: 'file.ts' } as unknown as FileSystemHandle;

  it('should map "appeared" to fileWritten', () => {
    const result = mapObserverRecord(
      { root, changedHandle, relativePathComponents: ['src', 'file.ts'], type: 'appeared' },
      testBackend,
    );
    expect(result).toEqual({ type: 'fileWritten', path: '/src/file.ts', backend: testBackend });
  });

  it('should map "modified" to fileWritten', () => {
    const result = mapObserverRecord(
      { root, changedHandle, relativePathComponents: ['src', 'file.ts'], type: 'modified' },
      testBackend,
    );
    expect(result).toEqual({ type: 'fileWritten', path: '/src/file.ts', backend: testBackend });
  });

  it('should map "disappeared" to fileDeleted', () => {
    const result = mapObserverRecord(
      { root, changedHandle, relativePathComponents: ['old.ts'], type: 'disappeared' },
      testBackend,
    );
    expect(result).toEqual({ type: 'fileDeleted', path: '/old.ts', backend: testBackend });
  });

  it('should map "moved" to fileRenamed', () => {
    const result = mapObserverRecord(
      {
        root,
        changedHandle,
        relativePathComponents: ['src', 'new.ts'],
        type: 'moved',
        relativePathMovedFrom: ['src', 'old.ts'],
      },
      testBackend,
    );
    expect(result).toEqual({
      type: 'fileRenamed',
      oldPath: '/src/old.ts',
      newPath: '/src/new.ts',
      backend: testBackend,
    });
  });

  it('should return undefined for "errored"', () => {
    const result = mapObserverRecord(
      { root, changedHandle, relativePathComponents: ['file.ts'], type: 'errored' },
      testBackend,
    );
    expect(result).toBeUndefined();
  });

  it('should return undefined for "unknown"', () => {
    const result = mapObserverRecord(
      { root, changedHandle, relativePathComponents: ['file.ts'], type: 'unknown' },
      testBackend,
    );
    expect(result).toBeUndefined();
  });
});

describe('FileSystemObserverBridge', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['FileSystemObserver'];
  });

  it('should return false when API is unavailable', async () => {
    const onEvent = vi.fn();
    const bridge = new FileSystemObserverBridge(onEvent);
    const result = await bridge.observe(mockHandle('root'));

    expect(result).toBe(false);
    expect(bridge.isObserving).toBe(false);
  });

  it('should create observer and start observing when API is available', async () => {
    const observeFunction = vi.fn().mockResolvedValue(undefined);
    const disconnectFunction = vi.fn();
    let capturedCallback: ((records: unknown[]) => void) | undefined;

    (globalThis as Record<string, unknown>)['FileSystemObserver'] = class {
      public observe = observeFunction;
      public disconnect = disconnectFunction;
      public constructor(callback: (records: unknown[]) => void) {
        capturedCallback = callback;
      }
    };

    const onEvent = vi.fn();
    const bridge = new FileSystemObserverBridge(onEvent);
    const handle = mockHandle('root');
    const result = await bridge.observe(handle);

    expect(result).toBe(true);
    expect(bridge.isObserving).toBe(true);
    expect(observeFunction).toHaveBeenCalledWith(handle, { recursive: true });
    expect(capturedCallback).toBeDefined();
  });

  it('should emit ChangeEvents when observer reports changes', async () => {
    let capturedCallback: ((records: unknown[]) => void) | undefined;
    const observeFunction = vi.fn().mockResolvedValue(undefined);

    (globalThis as Record<string, unknown>)['FileSystemObserver'] = class {
      public observe = observeFunction;
      public disconnect = vi.fn();
      public constructor(callback: (records: unknown[]) => void) {
        capturedCallback = callback;
      }
    };

    const events: ChangeEvent[] = [];
    const bridge = new FileSystemObserverBridge((event) => {
      events.push(event);
    });
    await bridge.observe(mockHandle('root'));

    capturedCallback!([
      {
        root: mockHandle('root'),
        changedHandle: { kind: 'file', name: 'a.ts' },
        relativePathComponents: ['src', 'a.ts'],
        type: 'modified',
      },
      {
        root: mockHandle('root'),
        changedHandle: { kind: 'file', name: 'b.ts' },
        relativePathComponents: ['b.ts'],
        type: 'disappeared',
      },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'fileWritten', path: '/src/a.ts', backend: 'webaccess' });
    expect(events[1]).toEqual({ type: 'fileDeleted', path: '/b.ts', backend: 'webaccess' });
  });

  it('should disconnect and clear observer state', async () => {
    const disconnectFunction = vi.fn();
    (globalThis as Record<string, unknown>)['FileSystemObserver'] = class {
      public observe = vi.fn().mockResolvedValue(undefined);
      public disconnect = disconnectFunction;
      // oxlint-disable-next-line no-useless-constructor, no-empty-function -- Mock constructor needs to accept callback arg
      public constructor(_callback: unknown) {}
    };

    const bridge = new FileSystemObserverBridge(vi.fn());
    await bridge.observe(mockHandle('root'));
    expect(bridge.isObserving).toBe(true);

    bridge.disconnect();
    expect(bridge.isObserving).toBe(false);
    expect(disconnectFunction).toHaveBeenCalledTimes(1);
  });
});

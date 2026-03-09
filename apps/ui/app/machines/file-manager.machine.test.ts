import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createActor } from 'xstate';
import { fileManagerMachine } from '#machines/file-manager.machine.js';
import { BoundedFileCache } from '@taucad/filesystem';

vi.mock('#machines/file-manager.worker.js?worker', () => ({
  default: class MockWorker {
    public terminate = vi.fn();
  },
}));

vi.mock('@taucad/kernels/filesystem', () => ({
  createFileSystemBridge: vi.fn(() => ({
    port: new MessageChannel().port1,
    dispose: vi.fn(),
  })),
  createBridgeProxy: vi.fn(() => ({
    reconfigure: vi.fn(),
    setDirectoryHandle: vi.fn(),
    getDirectoryStat: vi.fn(async () => []),
    readShallowDirectory: vi.fn(async () => []),
    dispose: vi.fn(),
  })),
}));

vi.mock('#filesystem/handle-store.js', () => ({
  getStoredDirectoryHandle: vi.fn(async () => undefined),
  getBuildFileSystemConfig: vi.fn(async () => undefined),
  checkHandlePermission: vi.fn(async () => 'granted'),
  storeDirectoryHandle: vi.fn(),
  requestHandlePermission: vi.fn(async () => true),
}));

describe('fileManagerMachine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start in initializing state when shouldInitializeOnStart is false', () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: false,
      },
    });
    actor.start();

    expect(actor.getSnapshot().value).toBe('initializing');
    actor.stop();
  });

  it('should transition to creatingWorker when shouldInitializeOnStart is true', () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    expect(actor.getSnapshot().value).toBe('creatingWorker');
    actor.stop();
  });

  it('should initialize context with BoundedFileCache', () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: false,
      },
    });
    actor.start();

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.fileCache).toBeInstanceOf(BoundedFileCache);
    expect(snapshot.context.fileTree).toBeInstanceOf(Map);
    expect(snapshot.context.rootDirectory).toBe('/test');
    expect(snapshot.context.backendType).toBe('indexeddb');
    expect(snapshot.context.eventUnsubscribe).toBeUndefined();

    actor.stop();
  });

  it('should accept setRoot event and reset context', () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: false,
      },
    });
    actor.start();

    actor.send({ type: 'initialize' });
    actor.send({ type: 'setRoot', path: '/new-root' });

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.rootDirectory).toBe('/new-root');

    actor.stop();
  });

  it('should use custom initial backend', () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: false,
        initialBackend: 'webaccess',
      },
    });
    actor.start();

    expect(actor.getSnapshot().context.backendType).toBe('webaccess');
    actor.stop();
  });

  it('should respond to initialize event from initializing state', () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: false,
      },
    });
    actor.start();

    expect(actor.getSnapshot().value).toBe('initializing');
    actor.send({ type: 'initialize' });
    expect(actor.getSnapshot().value).toBe('creatingWorker');

    actor.stop();
  });

  it('should handle setBackendType event', async () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    // Wait for ready state
    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('ready');
    });

    actor.send({ type: 'setBackendType', backendType: 'webaccess' });
    expect(actor.getSnapshot().context.backendType).toBe('webaccess');

    actor.stop();
  });

  it('should cache file data on fileWritten event', async () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('ready');
    });

    const data = new Uint8Array([1, 2, 3]);
    actor.send({ type: 'fileWritten', path: 'test.txt', data, source: 'user' });

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.fileCache.has('test.txt')).toBe(true);
    expect(snapshot.context.fileCache.get('test.txt')).toEqual(data);

    actor.stop();
  });

  it('should cache file data on fileRead event', async () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('ready');
    });

    const data = new Uint8Array([4, 5, 6]);
    actor.send({ type: 'fileRead', path: 'read.txt', data });

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.fileCache.has('read.txt')).toBe(true);
    expect(snapshot.context.fileCache.get('read.txt')).toEqual(data);

    actor.stop();
  });

  it('should optimistically rename in file tree and cache', async () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('ready');
    });

    // Seed the cache and tree
    const data = new Uint8Array([7, 8, 9]);
    actor.send({ type: 'fileWritten', path: 'old.txt', data, source: 'user' });

    // Now rename
    actor.send({ type: 'fileRenamed', oldPath: 'old.txt', newPath: 'new.txt' });

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.fileCache.has('old.txt')).toBe(false);
    expect(snapshot.context.fileCache.has('new.txt')).toBe(true);
    expect(snapshot.context.fileCache.get('new.txt')).toEqual(data);

    actor.stop();
  });

  it('should optimistically delete from file tree and cache', async () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('ready');
    });

    // Seed the cache
    const data = new Uint8Array([10, 11, 12]);
    actor.send({ type: 'fileWritten', path: 'todelete.txt', data, source: 'user' });
    expect(actor.getSnapshot().context.fileCache.has('todelete.txt')).toBe(true);

    // Delete
    actor.send({ type: 'fileDeleted', path: 'todelete.txt', source: 'user' });

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.fileCache.has('todelete.txt')).toBe(false);

    actor.stop();
  });

  it('should emit fileWritten event to subscribers', async () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('ready');
    });

    const emitted: unknown[] = [];
    actor.on('fileWritten', (event) => {
      emitted.push(event);
    });

    const data = new Uint8Array([1]);
    actor.send({ type: 'fileWritten', path: 'emit.txt', data, source: 'user' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'fileWritten', path: 'emit.txt', source: 'user' });

    actor.stop();
  });

  it('should clean up on stop', async () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('ready');
    });

    actor.stop();
    expect(actor.getSnapshot().status).toBe('stopped');
  });
});

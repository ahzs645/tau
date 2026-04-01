import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createActor } from 'xstate';
import { fileManagerMachine } from '#machines/file-manager.machine.js';

vi.mock('#machines/file-manager.worker.js?worker', () => ({
  default: class MockWorker {
    public terminate = vi.fn();
    public addEventListener = vi.fn();
    public removeEventListener = vi.fn();
    public postMessage = vi.fn();
  },
}));

const mockReconfigure = vi.fn();

vi.mock('@taucad/runtime/filesystem', () => ({
  createFileSystemBridge: vi.fn(() => ({
    port: new MessageChannel().port1,
    dispose: vi.fn(),
  })),
  createBridgeProxy: vi.fn(() => ({
    reconfigure: mockReconfigure,
    setDirectoryHandle: vi.fn(),
    getDirectoryStat: vi.fn(async () => []),
    readShallowDirectory: vi.fn(async () => []),
    readDirectory: vi.fn(async () => []),
    dispose: vi.fn(),
    listen: vi.fn(() => vi.fn()),
  })),
}));

const mockGetProjectFileSystemConfig = vi.fn<() => Promise<string | undefined>>();

vi.mock('#filesystem/handle-store.js', () => ({
  getStoredDirectoryHandle: vi.fn(async () => undefined),
  getProjectFileSystemConfig: async () => mockGetProjectFileSystemConfig(),
  checkHandlePermission: vi.fn(async () => 'granted'),
  storeDirectoryHandle: vi.fn(),
  requestHandlePermission: vi.fn(async () => true),
}));

describe('fileManagerMachine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectFileSystemConfig.mockResolvedValue(undefined);
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

  it('should initialize context without fileCache or fileTree', () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: false,
      },
    });
    actor.start();

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.rootDirectory).toBe('/test');
    expect(snapshot.context.backendType).toBe('indexeddb');
    expect(snapshot.context.contentService).toBeUndefined();
    expect(snapshot.context.treeService).toBeUndefined();

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

  it('should handle setBackendType event in ready state', async () => {
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

    actor.send({ type: 'setBackendType', backendType: 'webaccess' });
    expect(actor.getSnapshot().context.backendType).toBe('webaccess');

    actor.stop();
  });

  it('should create contentService and treeService on init', async () => {
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

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.contentService).toBeDefined();
    expect(snapshot.context.treeService).toBeDefined();

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

  // ── projectId-based backend resolution ────────────────────────────────────

  describe('projectId backend resolution', () => {
    it('should reconfigure to opfs when project config stores opfs', async () => {
      mockGetProjectFileSystemConfig.mockResolvedValue('opfs');

      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/projects/test-id',
          shouldInitializeOnStart: true,
          projectId: 'test-id',
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      expect(mockGetProjectFileSystemConfig).toHaveBeenCalled();
      expect(mockReconfigure).toHaveBeenCalledWith('opfs');
      actor.stop();
    });

    it('should not reconfigure when project config returns undefined (defaults to indexeddb)', async () => {
      mockGetProjectFileSystemConfig.mockResolvedValue(undefined);

      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/projects/test-id',
          shouldInitializeOnStart: true,
          projectId: 'test-id',
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      expect(mockGetProjectFileSystemConfig).toHaveBeenCalled();
      expect(mockReconfigure).not.toHaveBeenCalled();
      actor.stop();
    });

    it('should not query project config when projectId is absent', async () => {
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

      expect(mockGetProjectFileSystemConfig).not.toHaveBeenCalled();
      actor.stop();
    });

    it('should reconfigure to memory when project config stores memory', async () => {
      mockGetProjectFileSystemConfig.mockResolvedValue('memory');

      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/projects/mem-id',
          shouldInitializeOnStart: true,
          projectId: 'mem-id',
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      expect(mockReconfigure).toHaveBeenCalledWith('memory');
      actor.stop();
    });
  });
});

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

const mockMount = vi.fn<(prefix: string, backend: string, options?: unknown) => Promise<void>>();
const mockUnmount = vi.fn<(prefix: string) => void>();
const mockWaitForWorkerReady = vi.fn<() => Promise<void>>();
const mockCreateFileSystemBridge = vi.fn(() => ({
  port: new MessageChannel().port1,
  dispose: vi.fn(),
}));

vi.mock('@taucad/runtime/filesystem', () => ({
  createFileSystemBridge: () => mockCreateFileSystemBridge(),
  waitForWorkerReady: async () => mockWaitForWorkerReady(),
  createBridgeProxy: vi.fn(() => ({
    mount: mockMount,
    unmount: mockUnmount,
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
    mockWaitForWorkerReady.mockResolvedValue(undefined);
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

  it('should transition to connectingWorker when shouldInitializeOnStart is true', () => {
    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    expect(actor.getSnapshot().value).toBe('connectingWorker');
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
    expect(actor.getSnapshot().value).toBe('connectingWorker');

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

  // ── worker readiness gating ─────────────────────────────────────────────

  describe('worker readiness gating', () => {
    it('should not create bridge before worker signals ready', async () => {
      let resolveReady!: () => void;
      mockWaitForWorkerReady.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveReady = resolve;
        }),
      );

      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/test',
          shouldInitializeOnStart: true,
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(mockWaitForWorkerReady).toHaveBeenCalledOnce();
      });

      expect(mockCreateFileSystemBridge).not.toHaveBeenCalled();

      resolveReady();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      expect(mockCreateFileSystemBridge).toHaveBeenCalledOnce();
      actor.stop();
    });

    it('should create bridge and reach ready after worker signals ready', async () => {
      mockWaitForWorkerReady.mockResolvedValue(undefined);

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

      expect(mockWaitForWorkerReady).toHaveBeenCalledOnce();
      expect(mockCreateFileSystemBridge).toHaveBeenCalledOnce();
      actor.stop();
    });
  });

  // ── shared worker (project-scoped FM) ────────────────────────────────────

  describe('shared worker initialization', () => {
    it('should skip waitForWorkerReady and reach ready when sharedWorker is provided', async () => {
      mockWaitForWorkerReady.mockReturnValue(new Promise<void>(() => {}));

      const sharedWorker = {
        terminate: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
      } as unknown as Worker;

      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/projects/shared-proj',
          shouldInitializeOnStart: true,
          projectId: 'shared-proj',
          sharedWorker,
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      expect(mockWaitForWorkerReady).not.toHaveBeenCalled();
      expect(mockCreateFileSystemBridge).toHaveBeenCalledOnce();
      actor.stop();
    });

    it('should still call waitForWorkerReady when no sharedWorker (fresh worker)', async () => {
      mockWaitForWorkerReady.mockResolvedValue(undefined);

      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/projects/fresh-proj',
          shouldInitializeOnStart: true,
          projectId: 'fresh-proj',
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      expect(mockWaitForWorkerReady).toHaveBeenCalledOnce();
      actor.stop();
    });
  });

  // ── projectId-based backend resolution ────────────────────────────────────

  describe('projectId backend resolution', () => {
    it('should call mount with opfs when project config stores opfs', async () => {
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
      expect(mockMount).toHaveBeenCalledWith('/projects/test-id', 'opfs', { preservePath: true });
      actor.stop();
    });

    it('should call mount with indexeddb when project config returns undefined', async () => {
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
      expect(mockMount).toHaveBeenCalledWith('/projects/test-id', 'indexeddb', { preservePath: true });
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

    it('should call mount with memory when project config stores memory', async () => {
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

      expect(mockMount).toHaveBeenCalledWith('/projects/mem-id', 'memory', { preservePath: true });
      actor.stop();
    });

    it('should not mount when no projectId (root FM uses stable root mount)', async () => {
      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/test',
          shouldInitializeOnStart: true,
          initialBackend: 'opfs',
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      expect(mockMount).not.toHaveBeenCalled();
      actor.stop();
    });
  });

  // ── two-phase init (R1) ──────────────────────────────────────────────

  describe('two-phase init', () => {
    it('should transition to connectingWorker when initialize is sent', () => {
      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/test',
          shouldInitializeOnStart: false,
        },
      });
      actor.start();

      expect(actor.getSnapshot().value).toBe('initializing');
      actor.send({ type: 'initialize' });
      expect(actor.getSnapshot().value).toBe('connectingWorker');

      actor.stop();
    });

    it('should set context.worker after connectingWorker completes but before services are ready', async () => {
      let resolveServices!: () => void;
      const servicesGate = new Promise<void>((resolve) => {
        resolveServices = resolve;
      });

      mockGetProjectFileSystemConfig.mockImplementation(async () => {
        await servicesGate;
        return undefined;
      });

      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/projects/test-id',
          shouldInitializeOnStart: true,
          projectId: 'test-id',
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('initializingServices');
      });

      const snapshot = actor.getSnapshot();
      expect(snapshot.context.worker).toBeDefined();
      expect(snapshot.context.proxy).toBeDefined();
      expect(snapshot.context.contentService).toBeUndefined();
      expect(snapshot.context.treeService).toBeUndefined();

      resolveServices();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      actor.stop();
    });

    it('should transition through connectingWorker then initializingServices then ready', async () => {
      const states: string[] = [];
      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/test',
          shouldInitializeOnStart: true,
        },
      });
      actor.subscribe((snapshot) => {
        const value = snapshot.value as string;
        if (states.at(-1) !== value) {
          states.push(value);
        }
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      expect(states).toEqual(['initializing', 'connectingWorker', 'initializingServices', 'ready']);
      actor.stop();
    });

    it('should set services only after initializingServices completes', async () => {
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
      expect(snapshot.context.worker).toBeDefined();
      expect(snapshot.context.proxy).toBeDefined();

      actor.stop();
    });

    it('should handle setRoot in initializingServices state', async () => {
      let resolveServices!: () => void;
      const servicesGate = new Promise<void>((resolve) => {
        resolveServices = resolve;
      });

      mockGetProjectFileSystemConfig.mockImplementation(async () => {
        await servicesGate;
        return undefined;
      });

      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/projects/proj-a',
          shouldInitializeOnStart: true,
          projectId: 'proj-a',
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('initializingServices');
      });

      resolveServices();
      mockGetProjectFileSystemConfig.mockResolvedValue(undefined);

      actor.send({ type: 'setRoot', path: '/projects/proj-b', projectId: 'proj-b' });
      expect(actor.getSnapshot().context.rootDirectory).toBe('/projects/proj-b');

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      actor.stop();
    });
  });

  // ── project mount lifecycle cleanup ────────────────────────────────────

  describe('project mount lifecycle', () => {
    it('should unmount project prefix on root change when projectId is set', async () => {
      mockGetProjectFileSystemConfig.mockResolvedValue(undefined);

      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/projects/proj-1',
          shouldInitializeOnStart: true,
          projectId: 'proj-1',
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      actor.send({ type: 'setRoot', path: '/projects/proj-2', projectId: 'proj-2' });

      expect(mockUnmount).toHaveBeenCalledWith('/projects/proj-1');
      actor.stop();
    });

    it('should not call unmount on root change when no projectId', async () => {
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

      actor.send({ type: 'setRoot', path: '/other' });

      expect(mockUnmount).not.toHaveBeenCalled();
      actor.stop();
    });
  });

  describe('shared file pool', () => {
    it('should post filePool message to worker after ready', async () => {
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

      const { worker: fmWorker } = actor.getSnapshot().context;
      expect(fmWorker).toBeDefined();
      const postMessage = vi.mocked(fmWorker!.postMessage);
      const filePoolCall = postMessage.mock.calls.find(
        ([message]) => (message as { type?: string }).type === 'filePool',
      );
      expect(filePoolCall).toBeDefined();
      expect((filePoolCall![0] as { buffer: SharedArrayBuffer }).buffer).toBeInstanceOf(SharedArrayBuffer);

      actor.stop();
    });

    it('should store filePoolBuffer on context after worker connect', async () => {
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

      expect(actor.getSnapshot().context.filePoolBuffer).toBeInstanceOf(SharedArrayBuffer);

      actor.stop();
    });

    it('should reach ready state when SharedArrayBuffer is unavailable', async () => {
      const original = globalThis.SharedArrayBuffer;
      (globalThis as Record<string, unknown>)['SharedArrayBuffer'] = undefined;

      try {
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

        expect(actor.getSnapshot().context.filePoolBuffer).toBeUndefined();

        actor.stop();
      } finally {
        (globalThis as Record<string, unknown>)['SharedArrayBuffer'] = original;
      }
    });

    it('should not post filePool message to worker when SharedArrayBuffer is unavailable', async () => {
      const original = globalThis.SharedArrayBuffer;
      (globalThis as Record<string, unknown>)['SharedArrayBuffer'] = undefined;

      try {
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

        const { worker: fmWorker } = actor.getSnapshot().context;
        expect(fmWorker).toBeDefined();
        const postMessage = vi.mocked(fmWorker!.postMessage);
        const filePoolCall = postMessage.mock.calls.find(
          ([message]) => (message as { type?: string }).type === 'filePool',
        );
        expect(filePoolCall).toBeUndefined();

        actor.stop();
      } finally {
        (globalThis as Record<string, unknown>)['SharedArrayBuffer'] = original;
      }
    });
  });
});

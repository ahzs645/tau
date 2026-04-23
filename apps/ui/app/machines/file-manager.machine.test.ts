import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createActor } from 'xstate';
import { fileManagerMachine } from '#machines/file-manager.machine.js';

const workerTestState = vi.hoisted(() => {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- recursive type cannot be expressed inline
  const instances: Array<{
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    dispatchEvent: (event: Event) => void;
  }> = [];
  return { instances };
});

vi.mock('#machines/file-manager.worker.js?worker', () => ({
  default: class MockWorker {
    public terminate = vi.fn();
    public postMessage = vi.fn();
    public addEventListener = vi.fn((type: string, handler: (event: Event) => void) => {
      const handlers = this.listeners.get(type) ?? new Set<(event: Event) => void>();
      handlers.add(handler);
      this.listeners.set(type, handlers);
    });
    public removeEventListener = vi.fn((type: string, handler: (event: Event) => void) => {
      this.listeners.get(type)?.delete(handler);
    });
    private readonly listeners = new Map<string, Set<(event: Event) => void>>();
    public constructor() {
      workerTestState.instances.push(this);
    }
    public dispatchEvent(event: Event): boolean {
      for (const handler of this.listeners.get(event.type) ?? []) {
        handler(event);
      }
      return true;
    }
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
    workerTestState.instances.length = 0;
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
      mockWaitForWorkerReady.mockReturnValue(
        new Promise<void>(() => {
          /* Never resolves: simulates pending worker readiness */
        }),
      );

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

    // ── R8: nested FM reuses parent SAB instead of allocating a new one ──
    // See docs/research/staging-cors-coep-safari-rendering-audit.md
    it('should reuse parent sharedFilePoolBuffer instead of allocating a new SAB (R8)', async () => {
      const sharedWorker = {
        terminate: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
      } as unknown as Worker;

      // Match the production filePoolBytes size (50 MiB) so SharedPool init succeeds.
      const parentBuffer = new SharedArrayBuffer(50 * 1024 * 1024);

      const actor = createActor(fileManagerMachine, {
        input: {
          rootDirectory: '/projects/nested',
          shouldInitializeOnStart: true,
          projectId: 'nested',
          sharedWorker,
          sharedFilePoolBuffer: parentBuffer,
        },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('ready');
      });

      // The nested machine inherits the parent's SAB by reference.
      expect(actor.getSnapshot().context.filePoolBuffer).toBe(parentBuffer);

      // It must not re-post `filePool` to the shared worker — the parent FM
      // already did that for this worker instance.
      const sharedPostMessage = vi.mocked(sharedWorker.postMessage);
      const filePoolCall = sharedPostMessage.mock.calls.find(
        ([message]) => (message as { type?: string }).type === 'filePool',
      );
      expect(filePoolCall).toBeUndefined();

      actor.stop();
    });

    it('should allocate exactly one SAB per machine when no sharedFilePoolBuffer provided (R8)', async () => {
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

      const { worker: fmWorker, filePoolBuffer } = actor.getSnapshot().context;
      expect(filePoolBuffer).toBeInstanceOf(SharedArrayBuffer);

      const postMessage = vi.mocked(fmWorker!.postMessage);
      const filePoolCalls = postMessage.mock.calls.filter(
        ([message]) => (message as { type?: string }).type === 'filePool',
      );
      expect(filePoolCalls).toHaveLength(1);
      expect((filePoolCalls[0]![0] as { buffer: SharedArrayBuffer }).buffer).toBe(filePoolBuffer);

      actor.stop();
    });
  });

  // ── worker error diagnostics ────────────────────────────────────────────
  // See docs/research/staging-cors-coep-safari-rendering-audit.md and
  // .cursor/plans/file-manager_worker_error_diagnostics_*.plan.md
  describe('worker error diagnostics', () => {
    const startActorAndGrabWorker = async (): Promise<{
      actor: ReturnType<typeof createActor<typeof fileManagerMachine>>;
      worker: (typeof workerTestState.instances)[number];
    }> => {
      // Block worker readiness so we can dispatch the error before resolution.
      mockWaitForWorkerReady.mockReturnValue(
        new Promise<void>(() => {
          /* Never resolves — tests dispatch worker error events synchronously to win the race. */
        }),
      );

      const actor = createActor(fileManagerMachine, {
        input: { rootDirectory: '/test', shouldInitializeOnStart: true },
      });
      actor.start();

      await vi.waitFor(() => {
        expect(workerTestState.instances).toHaveLength(1);
      });
      return { actor, worker: workerTestState.instances[0]! };
    };

    it('routes a plain `error` Event (load failure) into the FM error state with actionable guidance', async () => {
      const { actor, worker } = await startActorAndGrabWorker();

      worker.dispatchEvent(new Event('error'));

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('error');
      });

      const { error } = actor.getSnapshot().context;
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(/Worker script failed to load/);
      expect(error?.message).toMatch(/Network tab/);
      expect(worker.terminate).toHaveBeenCalledTimes(1);

      actor.stop();
    });

    it('routes an `ErrorEvent` with `error.stack` into the FM error state preserving the stack', async () => {
      const { actor, worker } = await startActorAndGrabWorker();

      const cause = new Error('boom inside worker');
      cause.stack = 'Error: boom inside worker\n    at file-manager.worker.ts:42:7';
      worker.dispatchEvent(
        new ErrorEvent('error', {
          message: 'Uncaught Error: boom inside worker',
          filename: 'http://localhost:3000/assets/file-manager.worker-XXX.js',
          lineno: 42,
          colno: 7,
          error: cause,
        }),
      );

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('error');
      });

      const { error } = actor.getSnapshot().context;
      expect(error?.message).toContain('Uncaught Error: boom inside worker');
      expect(error?.message).toContain('file-manager.worker-XXX.js:42:7');
      expect(error?.stack).toBe(cause.stack);

      actor.stop();
    });

    it('routes a `messageerror` Event into the FM error state with a structured-clone explanation', async () => {
      const { actor, worker } = await startActorAndGrabWorker();

      worker.dispatchEvent(new Event('messageerror'));

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('error');
      });

      expect(actor.getSnapshot().context.error?.message).toMatch(/messageerror/);
      expect(actor.getSnapshot().context.error?.message).toMatch(/structured-clone/);

      actor.stop();
    });

    it('routes a `__worker_init_error__` envelope into the FM error state with the originating phase', async () => {
      const { actor, worker } = await startActorAndGrabWorker();

      const envelope = {
        type: '__worker_init_error__',
        phase: "mount('/', 'indexeddb')",
        message: 'IndexedDB unavailable',
        stack: 'Error: IndexedDB unavailable\n    at file-manager.worker.ts:56',
      };
      worker.dispatchEvent(new MessageEvent('message', { data: envelope }));

      await vi.waitFor(() => {
        expect(actor.getSnapshot().value).toBe('error');
      });

      const { error } = actor.getSnapshot().context;
      expect(error?.message).toContain("Worker mount('/', 'indexeddb') failed: IndexedDB unavailable");

      actor.stop();
    });

    it('ignores unrelated worker `message` events', async () => {
      const { actor, worker } = await startActorAndGrabWorker();

      worker.dispatchEvent(new MessageEvent('message', { data: { type: 'something-else' } }));

      // Still waiting on `waitForWorkerReady` (which never resolves) — must
      // not have fallen into the error state from an unrelated message.
      expect(actor.getSnapshot().value).toBe('connectingWorker');

      actor.stop();
    });
  });
});

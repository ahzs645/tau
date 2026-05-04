// @vitest-environment jsdom
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
  port: {
    postMessage: vi.fn(),
    onMessage: vi.fn((_handler: (data: unknown) => void) => vi.fn()),
    close: vi.fn(),
  },
  dispose: vi.fn(),
}));

vi.mock('@taucad/runtime/transport-internals', () => ({
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

const { waitForFileManagerServices } = await import('#hooks/use-file-manager.js');

describe('waitForFileManagerServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerTestState.instances.length = 0;
    mockGetProjectFileSystemConfig.mockResolvedValue(undefined);
    mockWaitForWorkerReady.mockResolvedValue(undefined);
  });

  it('should resolve immediately when both services are already bound', async () => {
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

    const result = await waitForFileManagerServices(actor);
    expect(result.contentService).toBe(actor.getSnapshot().context.contentService);
    expect(result.treeService).toBe(actor.getSnapshot().context.treeService);

    actor.stop();
  });

  it('should wait until services become bound when initialization is gated', async () => {
    let resolveReady!: () => void;
    mockWaitForWorkerReady.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
    );

    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test-gate',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    await vi.waitFor(() => {
      expect(mockWaitForWorkerReady).toHaveBeenCalledOnce();
    });

    const servicesPromise = waitForFileManagerServices(actor);

    resolveReady();

    const resolved = await servicesPromise;
    expect(resolved.contentService).toBeDefined();
    expect(resolved.treeService).toBeDefined();

    actor.stop();
  });

  it('should reject with the file-manager error message when the actor enters error', async () => {
    mockWaitForWorkerReady.mockReturnValue(
      new Promise<void>(() => {
        /* Never resolves — see file-manager.machine.test worker error diagnostics. */
      }),
    );

    const actor = createActor(fileManagerMachine, {
      input: {
        rootDirectory: '/test-err',
        shouldInitializeOnStart: true,
      },
    });
    actor.start();

    await vi.waitFor(() => {
      expect(workerTestState.instances).toHaveLength(1);
    });
    const worker = workerTestState.instances[0]!;
    worker.dispatchEvent(new Event('error'));

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('error');
    });

    const { error } = actor.getSnapshot().context;
    expect(error).toBeInstanceOf(Error);

    await expect(waitForFileManagerServices(actor)).rejects.toThrow(error!.message);

    actor.stop();
  });
});

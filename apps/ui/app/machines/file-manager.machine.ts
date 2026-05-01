import { assign, assertEvent, setup, enqueueActions } from 'xstate';
import type { ChangeEvent, FileEntry, FileSystemBackend } from '@taucad/types';
import { createBridgeProxy, createFileSystemBridge, waitForWorkerReady } from '@taucad/runtime/transport-internals';
import { safeDispose } from '@taucad/utils/dispose';
import FileManagerWorker from '#machines/file-manager.worker.js?worker';
import {
  getStoredDirectoryHandle,
  getProjectFileSystemConfig,
  checkHandlePermission,
} from '#filesystem/handle-store.js';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { normalizePath } from '@taucad/utils/path';
import { FileContentService } from '#lib/file-content-service.js';
import { SharedPool } from '@taucad/memory';
import { FileTreeService } from '#lib/file-tree-service.js';
import type { FileManagerProxy, FileManagerProtocol } from '#machines/file-manager.machine.types.js';
import {
  formatWorkerError,
  formatWorkerErrorEnvelope,
  isWorkerErrorEnvelope,
  toWorkerError,
} from '#machines/file-manager-worker-error.js';

const fileCacheMaxEntries = 500;
const fileCacheMaxTotalBytes = 128 * 1024 * 1024;
const fileCacheMaxSingleFileBytes = 1024 * 1024;

const filePoolBytes = 50 * 1024 * 1024;

type FileManagerContext = {
  worker: Worker | undefined;
  proxy: (FileManagerProxy & { listen?: (event: string, handler: (data: unknown) => void) => () => void }) | undefined;
  bridgeDispose?: () => void;
  filePoolBuffer: SharedArrayBuffer | undefined;
  contentService: FileContentService | undefined;
  treeService: FileTreeService | undefined;
  error: Error | undefined;
  rootDirectory: string;
  shouldInitializeOnStart: boolean;
  backendType: FileSystemBackend;
  webAccessNeedsPermission: boolean;
  projectId: string | undefined;
  sharedWorker: Worker | undefined;
};

// ============ Lifecycle Actors ============

type WorkerConnectedEvent = {
  type: 'workerConnected';
  worker: Worker;
  proxy: FileManagerProxy & { listen?: (event: string, handler: (data: unknown) => void) => () => void };
  bridgeDispose: () => void;
  filePoolBuffer: SharedArrayBuffer | undefined;
};

type WorkerInitializedEvent = {
  type: 'workerInitialized';
  configuredBackend: FileSystemBackend;
  webAccessNeedsPermission: boolean;
  initialEntries: FileEntry[];
  contentService: FileContentService;
  treeService: FileTreeService;
};

const connectWorkerActor = fromSafeAsync<WorkerConnectedEvent, { context: FileManagerContext }>(
  async ({ input, signal }) => {
    const { context } = input;
    const initT0 = performance.now();
    console.debug(`[FileManager] connectWorkerActor: start +${initT0.toFixed(0)}ms`);

    safeDispose(() => context.proxy?.dispose());
    safeDispose(context.bridgeDispose);
    context.contentService?.dispose();
    context.treeService?.dispose();

    if (context.worker && !context.sharedWorker) {
      safeDispose(() => context.worker?.terminate());
    }

    const worker = context.sharedWorker ?? new FileManagerWorker({ name: `fm-root` });
    console.debug(`[FileManager] worker created +${(performance.now() - initT0).toFixed(1)}ms`);

    // Crash-aware error/messageerror/envelope listeners. Listeners are
    // installed before any await so a synchronous load failure (404 served as
    // HTML, COEP block, SyntaxError) is captured and surfaced through the
    // XState `error` transition instead of being silently swallowed. The
    // listeners stay attached after readiness so post-init crashes are at
    // least visible in the console (the `crashSignal` Promise is only racy
    // during the connect phase — `armed` is flipped to `false` afterwards
    // so its callback no longer rejects).
    let armed = true;
    let rejectOnCrash!: (error: Error) => void;
    const crashSignal = new Promise<never>((_resolve, reject) => {
      rejectOnCrash = reject;
    });
    // Suppress unhandled-rejection warnings if `crashSignal` never wins the race.
    // The handler is intentionally inert because errors are already reported
    // via `console.error` inside `reportAndMaybeReject`.
    const noop = (): void => {
      /* Swallowed by design — see comment above. */
    };
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then) -- attaching a catch handler to a Promise we may never await
    crashSignal.catch(noop);

    const reportAndMaybeReject = (formatted: ReturnType<typeof formatWorkerError>): void => {
      const error = toWorkerError(formatted);
      console.error('[FileManager] worker error:', formatted.message, formatted);
      if (armed) {
        rejectOnCrash(error);
      }
    };

    const onWorkerError = (event: Event): void => {
      reportAndMaybeReject(formatWorkerError(event));
    };
    const onWorkerMessageError = (event: Event): void => {
      reportAndMaybeReject(formatWorkerError(event));
    };
    const onWorkerEnvelope = (event: MessageEvent<unknown>): void => {
      if (isWorkerErrorEnvelope(event.data)) {
        reportAndMaybeReject(formatWorkerErrorEnvelope(event.data));
      }
    };

    worker.addEventListener('error', onWorkerError);
    worker.addEventListener('messageerror', onWorkerMessageError);
    worker.addEventListener('message', onWorkerEnvelope);

    if (!context.sharedWorker) {
      try {
        await Promise.race([waitForWorkerReady(worker, signal), crashSignal]);
        console.debug(`[FileManager] worker ready +${(performance.now() - initT0).toFixed(1)}ms`);
      } catch (error) {
        worker.removeEventListener('error', onWorkerError);
        worker.removeEventListener('messageerror', onWorkerMessageError);
        worker.removeEventListener('message', onWorkerEnvelope);
        // We only entered this branch when `context.sharedWorker` was undefined,
        // so the freshly-created worker is owned by us and must be terminated
        // here before re-throwing. Wrapped in `safeDispose` to mirror the rest
        // of the file's worker-teardown patterns.
        safeDispose(() => {
          worker.terminate();
        });
        throw error;
      }
    }
    armed = false;

    // Allocate the file-pool SharedArrayBuffer at most once per worker instance.
    // When `sharedWorker` is supplied, the parent FM has already allocated the
    // SAB and posted the `filePool` message to that worker; nested FMs reuse
    // the parent's SAB by reading it from `context.filePoolBuffer` so the
    // 50 MiB pool isn't duplicated per project route.
    const { filePoolBuffer: inheritedPoolBuffer } = context;
    let filePoolBuffer: SharedArrayBuffer | undefined = inheritedPoolBuffer;
    if (inheritedPoolBuffer) {
      console.debug(`[FileManager] filePool SAB inherited from parent +${(performance.now() - initT0).toFixed(1)}ms`);
    } else {
      try {
        filePoolBuffer = new SharedArrayBuffer(filePoolBytes);
        worker.postMessage({ type: 'filePool', buffer: filePoolBuffer });
        console.debug(`[FileManager] filePool SAB allocated +${(performance.now() - initT0).toFixed(1)}ms`);
      } catch {
        console.debug('[FileManager] SharedArrayBuffer unavailable, skipping file pool');
      }
    }

    const { port, dispose: bridgeDispose } = createFileSystemBridge(worker);
    console.debug(`[FileManager] bridge created, port transferred +${(performance.now() - initT0).toFixed(1)}ms`);
    const proxy = createBridgeProxy<FileManagerProtocol>(port);
    console.debug(`[FileManager] proxy created +${(performance.now() - initT0).toFixed(1)}ms`);

    return { type: 'workerConnected', worker, proxy, bridgeDispose, filePoolBuffer };
  },
);

const initializeServicesActor = fromSafeAsync<WorkerInitializedEvent, { context: FileManagerContext }>(
  async ({ input, signal }) => {
    const { context } = input;
    const proxy = context.proxy!;
    const initT0 = performance.now();
    console.debug(`[FileManager] initializeServicesActor: start +${initT0.toFixed(0)}ms`);

    let backend = context.backendType;
    if (context.projectId) {
      signal.throwIfAborted();
      const projectBackend = await getProjectFileSystemConfig(context.projectId);
      backend = projectBackend ?? 'indexeddb';
    }

    let webAccessNeedsPermission = false;

    if (backend === 'webaccess') {
      const workspaceHandle = await getStoredDirectoryHandle();
      if (workspaceHandle) {
        const permission = await checkHandlePermission(workspaceHandle);
        if (permission === 'granted') {
          proxy.setDirectoryHandle(workspaceHandle);
          if (context.projectId) {
            const projectPrefix = `/projects/${context.projectId}`;
            await proxy.mount(projectPrefix, 'webaccess', { preservePath: true });
          }
        } else {
          webAccessNeedsPermission = true;
          backend = 'indexeddb';
        }
      } else {
        webAccessNeedsPermission = true;
        backend = 'indexeddb';
      }
    }

    if (backend !== 'webaccess' && context.projectId) {
      const projectPrefix = `/projects/${context.projectId}`;
      await proxy.mount(projectPrefix, backend, { preservePath: true });
    }

    let initialEntries: FileEntry[] = [];
    try {
      const rootPath = context.rootDirectory;
      const absolutePath = normalizePath(rootPath);
      console.debug(
        `[FileManager] calling readDirectory('${absolutePath}') +${(performance.now() - initT0).toFixed(1)}ms`,
      );
      const rootNodes = await proxy.readDirectory(absolutePath);
      console.debug(
        `[FileManager] readDirectory returned ${rootNodes.length} entries +${(performance.now() - initT0).toFixed(1)}ms`,
      );
      for (const node of rootNodes) {
        initialEntries.push({
          path: node.name,
          name: node.name,
          type: node.children === undefined ? 'file' : 'dir',
          size: 0,
          mtimeMs: Date.now(),
          isLoaded: false,
        });
      }
    } catch (error) {
      console.debug('[FileManager] Initial tree hydration failed (empty filesystem?):', error);
      initialEntries = [];
    }

    const filePool = context.filePoolBuffer ? new SharedPool(context.filePoolBuffer) : undefined;

    const contentService = new FileContentService({
      proxy,
      rootDirectory: context.rootDirectory,
      cacheOptions: {
        maxEntries: fileCacheMaxEntries,
        maxTotalBytes: fileCacheMaxTotalBytes,
        maxSingleFileBytes: fileCacheMaxSingleFileBytes,
      },
      filePool,
    });

    const treeService = new FileTreeService({
      proxy,
      rootDirectory: context.rootDirectory,
      initialEntries,
    });

    treeService.connectToContentService(contentService);

    proxy.listen?.('fileChanged', (event) => {
      const changeEvent = event as ChangeEvent;
      treeService.handleWorkerFileChanged(changeEvent);
      contentService.handleWorkerFileChanged(changeEvent);
    });

    console.debug('[FileManager] initializeServicesActor: success');
    return {
      type: 'workerInitialized',
      configuredBackend: backend,
      webAccessNeedsPermission,
      initialEntries,
      contentService,
      treeService,
    };
  },
);

const fileManagerActors = {
  connectWorkerActor,
  initializeServicesActor,
} as const;

// ============ Events ============

type FileManagerEventLifecycle =
  | { type: 'initialize' }
  | { type: 'setRoot'; path: string; projectId?: string }
  | { type: 'setBackendType'; backendType: FileSystemBackend };

type FileManagerEvent = FileManagerEventLifecycle | WorkerConnectedEvent | WorkerInitializedEvent;

type FileManagerInput = {
  rootDirectory: string;
  shouldInitializeOnStart?: boolean;
  initialBackend?: FileSystemBackend;
  projectId?: string;
  sharedWorker?: Worker;
  /**
   * SharedArrayBuffer to reuse for the file-pool when nested under another
   * `FileManagerProvider`. Set to the parent FM's `filePoolBuffer` so the
   * nested machine skips its own allocation/post.
   */
  sharedFilePoolBuffer?: SharedArrayBuffer;
};

export const fileManagerMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    context: {} as FileManagerContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    events: {} as FileManagerEvent,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    input: {} as FileManagerInput,
  },
  actors: fileManagerActors,
  actions: {
    setError: assign({
      error({ event }) {
        if ('error' in event && event.error instanceof Error) {
          console.error('[FileManager] error:', event.error);
          return event.error;
        }
        return undefined;
      },
    }),

    clearError: assign({ error: undefined }),

    destroyWorkerAndServices: assign(({ context }) => {
      if (context.projectId && context.proxy) {
        const projectPrefix = `/projects/${context.projectId}`;
        context.proxy.unmount(projectPrefix);
      }

      context.contentService?.dispose();
      context.treeService?.dispose();
      safeDispose(() => context.proxy?.dispose());
      safeDispose(context.bridgeDispose);

      if (!context.sharedWorker) {
        safeDispose(() => context.worker?.terminate());
      }

      return {
        proxy: undefined,
        bridgeDispose: undefined,
        worker: context.sharedWorker ? context.worker : undefined,
        contentService: undefined,
        treeService: undefined,
      };
    }),

    updateRootAndReset: assign({
      rootDirectory({ event }) {
        assertEvent(event, 'setRoot');
        return event.path;
      },
      projectId({ event }) {
        assertEvent(event, 'setRoot');
        return event.projectId;
      },
      error: undefined,
    }),

    updateWorkerFromConnect: assign({
      worker({ event }) {
        assertEvent(event, 'workerConnected');
        return event.worker;
      },
      proxy({ event }) {
        assertEvent(event, 'workerConnected');
        return event.proxy;
      },
      bridgeDispose({ event }) {
        assertEvent(event, 'workerConnected');
        return event.bridgeDispose;
      },
      filePoolBuffer({ event }) {
        assertEvent(event, 'workerConnected');
        return event.filePoolBuffer;
      },
    }),

    updateBackendFromInit: assign({
      backendType({ event }) {
        assertEvent(event, 'workerInitialized');
        return event.configuredBackend;
      },
      webAccessNeedsPermission({ event }) {
        assertEvent(event, 'workerInitialized');
        return event.webAccessNeedsPermission;
      },
      contentService({ event }) {
        assertEvent(event, 'workerInitialized');
        return event.contentService;
      },
      treeService({ event }) {
        assertEvent(event, 'workerInitialized');
        return event.treeService;
      },
    }),

    updateBackendType: assign({
      backendType({ event }) {
        assertEvent(event, 'setBackendType');
        return event.backendType;
      },
    }),

    startPolling({ context }) {
      if (context.backendType === 'webaccess') {
        context.treeService?.startPolling();
      }
    },

    stopPolling({ context }) {
      context.treeService?.stopChangeDetection();
    },
  },
  guards: {
    isRootChanged({ context, event }) {
      assertEvent(event, 'setRoot');
      return event.path !== context.rootDirectory || event.projectId !== context.projectId;
    },
  },
}).createMachine({
  id: 'fileManager',
  entry: enqueueActions(({ enqueue, context, self }) => {
    if (context.shouldInitializeOnStart) {
      enqueue.sendTo(self, { type: 'initialize' });
    }
  }),
  context: ({ input }) => ({
    worker: undefined,
    proxy: undefined,
    // Seed with the parent's SAB when nested so the connect actor's gate
    // observes a non-undefined buffer and skips re-allocation.
    filePoolBuffer: input.sharedFilePoolBuffer,
    contentService: undefined,
    treeService: undefined,
    error: undefined,
    rootDirectory: input.rootDirectory,
    shouldInitializeOnStart: input.shouldInitializeOnStart ?? true,
    backendType: input.initialBackend ?? 'indexeddb',
    webAccessNeedsPermission: false,
    projectId: input.projectId,
    sharedWorker: input.sharedWorker,
  }),
  initial: 'initializing',
  exit: ['stopPolling', 'destroyWorkerAndServices'],
  states: {
    initializing: {
      on: {
        initialize: { target: 'connectingWorker' },
      },
    },

    connectingWorker: {
      entry: ['clearError'],
      on: {
        setRoot: {
          target: 'connectingWorker',
          guard: 'isRootChanged',
          actions: ['stopPolling', 'destroyWorkerAndServices', 'updateRootAndReset'],
        },
        workerConnected: {
          actions: ['updateWorkerFromConnect'],
        },
      },
      invoke: {
        src: 'connectWorkerActor',
        input({ context }) {
          return { context };
        },
        onDone: 'initializingServices',
        onError: {
          target: 'error',
          actions: ['setError'],
        },
      },
    },

    initializingServices: {
      on: {
        setRoot: {
          target: 'connectingWorker',
          guard: 'isRootChanged',
          actions: ['stopPolling', 'destroyWorkerAndServices', 'updateRootAndReset'],
        },
        workerInitialized: {
          actions: ['updateBackendFromInit'],
        },
      },
      invoke: {
        src: 'initializeServicesActor',
        input({ context }) {
          return { context };
        },
        onDone: 'ready',
        onError: {
          target: 'error',
          actions: ['setError'],
        },
      },
    },

    ready: {
      entry: ['startPolling'],
      exit: ['stopPolling'],
      on: {
        setRoot: {
          target: 'connectingWorker',
          guard: 'isRootChanged',
          actions: ['stopPolling', 'destroyWorkerAndServices', 'updateRootAndReset'],
        },

        setBackendType: {
          actions: ['updateBackendType'],
        },
      },
    },

    error: {
      entry({ context }) {
        console.error('[FileManager] state → error', context.error);
      },
      on: {
        setRoot: {
          target: 'connectingWorker',
          actions: ['destroyWorkerAndServices', 'updateRootAndReset'],
        },
        initialize: {
          target: 'connectingWorker',
        },
      },
    },
  },
});

export type FileManagerMachine = typeof fileManagerMachine;

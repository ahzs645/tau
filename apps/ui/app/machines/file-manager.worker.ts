/**
 * File-Manager Worker
 *
 * Single entry point for all filesystem access. Every connection (main thread,
 * kernel workers, git) receives a MessagePort that is served by the same
 * WorkspaceFileService instance. Writes to the same file are serialized via a per-file
 * ResourceQueue (VS Code pattern); writes to different files run in parallel.
 */

import { exposeFileSystem, workerReadyMessageType } from '@taucad/runtime/filesystem';

import {
  ProviderRegistry,
  ResourceQueue,
  DirectoryTreeCache,
  ChangeEventBus,
  WorkspaceFileService,
  MountTable,
  EventCoalescer,
  ThrottledWorker,
} from '@taucad/filesystem';
import { FileSystemAccessProvider } from '@taucad/filesystem/backend';
import { SharedPool } from '@taucad/memory';
import { metaConfig } from '#constants/meta.constants.js';

const providerRegistry = new ProviderRegistry({ databasePrefix: metaConfig.databasePrefix });
const resourceQueue = new ResourceQueue();
const treeCache = new DirectoryTreeCache();
const eventBus = new ChangeEventBus();
const mountTable = new MountTable();

/**
 * Structured envelope sent to the main thread when the worker catches one of
 * its own crashes. Mirrors the `WorkerErrorEnvelope` type the main-thread FM
 * machine listens for in `file-manager-worker-error.ts`. Posting this before
 * the worker re-throws (or before the browser fires the opaque load-failure
 * `error` event) ensures the FM XState machine surfaces a real message
 * instead of `undefined undefined undefined`.
 */
type WorkerErrorEnvelope = {
  type: '__worker_init_error__' | '__worker_runtime_error__';
  phase: string;
  name?: string;
  message: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  causeMessage?: string;
};

const stringifyCause = (cause: unknown): string | undefined => {
  if (cause === undefined) {
    return undefined;
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === 'string') {
    return cause;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return Object.prototype.toString.call(cause);
  }
};

const serializeError = (error: unknown): { name?: string; message: string; stack?: string; causeMessage?: string } => {
  if (error instanceof Error) {
    const { name, message, stack, cause } = error;
    return { name, message, stack, causeMessage: stringifyCause(cause) };
  }
  return { message: typeof error === 'string' ? error : JSON.stringify(error) };
};

const postWorkerInitError = (phase: string, error: unknown): void => {
  const envelope: WorkerErrorEnvelope = { type: '__worker_init_error__', phase, ...serializeError(error) };
  self.postMessage(envelope);
  console.error(`[FM-Worker] ${phase} failed:`, error);
};

self.addEventListener('error', (event) => {
  const envelope: WorkerErrorEnvelope = {
    type: '__worker_runtime_error__',
    phase: 'runtime',
    message: event.message || 'Unknown worker runtime error',
    filename: event.filename || undefined,
    lineno: event.lineno || undefined,
    colno: event.colno || undefined,
    stack: event.error instanceof Error ? event.error.stack : undefined,
    name: event.error instanceof Error ? event.error.name : undefined,
  };
  self.postMessage(envelope);
});

self.addEventListener('unhandledrejection', (event) => {
  const envelope: WorkerErrorEnvelope = {
    type: '__worker_runtime_error__',
    phase: 'unhandledrejection',
    ...serializeError(event.reason),
  };
  self.postMessage(envelope);
});

async function createNodeModulesMount(): Promise<void> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) {
    console.debug('[FM-Worker] OPFS not available, /node_modules falls through to root mount');
    return;
  }
  try {
    const opfsRoot = await navigator.storage.getDirectory();
    const nodeModulesHandle = await opfsRoot.getDirectoryHandle('tau-node-modules', { create: true });
    const nodeModulesProvider = new FileSystemAccessProvider(nodeModulesHandle);
    mountTable.mount('/node_modules', nodeModulesProvider, { backend: 'opfs' });
    console.debug('[FM-Worker] /node_modules mounted on OPFS');
  } catch (error) {
    console.warn('[FM-Worker] Failed to mount OPFS /node_modules, falling through to root', error);
  }
}

const fileService = new WorkspaceFileService({
  providerRegistry,
  resourceQueue,
  treeCache,
  eventBus,
  mountTable,
});

const t0 = performance.now();
console.debug(`[FM-Worker] module evaluated in ${t0.toFixed(1)}ms`);

try {
  await fileService.mount('/', 'indexeddb');
} catch (error) {
  postWorkerInitError("mount('/', 'indexeddb')", error);
  throw error;
}

try {
  await createNodeModulesMount();
} catch (error) {
  postWorkerInitError('createNodeModulesMount', error);
  throw error;
}

exposeFileSystem(fileService, {
  watchHandler: {
    watch(request, handler, ownerId) {
      return fileService.watch(request, handler, ownerId);
    },
    cleanupWatches(ownerId) {
      fileService.cleanupWatches(ownerId);
    },
  },
  changeEventBus: eventBus,
  createCoalescer: (deliver, coalescingWindow) => new EventCoalescer(deliver, { coalescingWindow }),
  createThrottledWorker: (handler) => new ThrottledWorker(handler),
});

self.addEventListener('message', (event: MessageEvent<{ type: string; buffer?: SharedArrayBuffer }>) => {
  const { data } = event;
  if (data.type === 'filePool' && data.buffer instanceof SharedArrayBuffer) {
    fileService.setFilePool(new SharedPool(data.buffer));
    console.debug('[FM-Worker] filePool attached');
  }
});

console.debug(`[FM-Worker] exposeFileSystem registered at +${(performance.now() - t0).toFixed(1)}ms`);
self.postMessage({ type: workerReadyMessageType });

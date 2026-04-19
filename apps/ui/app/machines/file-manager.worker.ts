/**
 * File-Manager Worker
 *
 * Single entry point for all filesystem access. Every connection (main thread,
 * kernel workers, git) receives a MessagePort that is served by the same
 * FileService instance. Writes to the same file are serialized via a per-file
 * ResourceQueue (VS Code pattern); writes to different files run in parallel.
 */

import { exposeFileSystem, workerReadyMessageType } from '@taucad/runtime/filesystem';

import {
  ProviderRegistry,
  ResourceQueue,
  DirectoryTreeCache,
  ChangeEventBus,
  FileService,
  MountTable,
  EventCoalescer,
  ThrottledWorker,
} from '@taucad/filesystem';
import { FileSystemAccessProvider } from '@taucad/filesystem/providers';
import { SharedPool } from '@taucad/memory';
import { metaConfig } from '#constants/meta.constants.js';

const providerRegistry = new ProviderRegistry({ databasePrefix: metaConfig.databasePrefix });
const resourceQueue = new ResourceQueue();
const treeCache = new DirectoryTreeCache();
const eventBus = new ChangeEventBus();
const mountTable = new MountTable();

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

const fileService = new FileService({
  providerRegistry,
  resourceQueue,
  treeCache,
  eventBus,
  mountTable,
});

const t0 = performance.now();
console.debug(`[FM-Worker] module evaluated in ${t0.toFixed(1)}ms`);

await fileService.mount('/', 'indexeddb');
await createNodeModulesMount();

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
  createCoalescer: (deliver, windowMs) => new EventCoalescer(deliver, { windowMs }),
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

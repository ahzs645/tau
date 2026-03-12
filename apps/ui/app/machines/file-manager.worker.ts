/**
 * File-Manager Worker
 *
 * Single entry point for all filesystem access. Every connection (main thread,
 * kernel workers, git) receives a MessagePort that is served by the same
 * FileService instance -- sharing one serialization queue. This prevents
 * the TOCTOU race condition in ZenFS's commitNew (zen-fs/core#256).
 */

import { exposeFileSystem } from '@taucad/runtime/filesystem';
import {
  ProviderRegistry,
  WriteCoordinator,
  DirectoryTreeCache,
  ChangeEventBus,
  FileService,
} from '@taucad/filesystem';
import { metaConfig } from '#constants/meta.constants.js';

const providerRegistry = new ProviderRegistry({ databasePrefix: metaConfig.databasePrefix });
const writeCoordinator = new WriteCoordinator();
const treeCache = new DirectoryTreeCache();
const eventBus = new ChangeEventBus();

const fileService = new FileService({
  providerRegistry,
  writeCoordinator,
  treeCache,
  eventBus,
});

const t0 = performance.now();
console.debug(`[FM-Worker] module evaluated in ${t0.toFixed(1)}ms`);

exposeFileSystem(fileService, {
  watchHandler: {
    watch(request, handler, ownerId) {
      return fileService.watch(request, handler, ownerId);
    },
    cleanupWatches(ownerId) {
      fileService.cleanupWatches(ownerId);
    },
  },
});

console.debug(`[FM-Worker] exposeFileSystem registered at +${(performance.now() - t0).toFixed(1)}ms`);
self.postMessage({ type: '__worker_ready__' });

export type {
  ProviderCapabilities,
  ProviderFileStat,
  FileSystemProvider,
  FileReadStreamOptions,
  ChangeEvent,
  FileTreeNode,
  TreeEntry,
  WatchEventFilter,
  WatchRequest,
  WatchEvent,
} from '#types.js';

export { FileService } from '#file-service.js';
export type { MkdirOptions } from '#file-service.js';

export { ProviderRegistry } from '#provider-registry.js';
export type { ProviderRegistryOptions } from '#provider-registry.js';

export { BoundedFileCache } from '#bounded-file-cache.js';
export { ResourceQueue } from '#resource-queue.js';
export { WriteCoordinator } from '#write-coordinator.js';
export { ResourceWriteQueue } from '#resource-write-queue.js';
export { ChangeEventBus } from '#change-event-bus.js';
export { DirectoryTreeCache } from '#directory-tree-cache.js';
export { InMemoryFileTree } from '#in-memory-file-tree.js';
export type { TreeNode } from '#in-memory-file-tree.js';
export { EventCoalescer, coalesceEvents } from '#event-coalescer.js';
export type { CoalescerOptions } from '#event-coalescer.js';
export { ThrottledWorker } from '#throttled-worker.js';
export type { ThrottledWorkerOptions } from '#throttled-worker.js';
export { WatchRegistry } from '#watch-registry.js';
export type { WatchRegistryOptions } from '#watch-registry.js';
export {
  FileSystemObserverBridge,
  isFileSystemObserverSupported,
  mapObserverRecord,
} from '#providers/filesystem-observer-bridge.js';
export { streamChunkSize, bufferToStream } from '#providers/stream-utils.js';
export type { FileReadStreamOptions as StreamFileReadOptions } from '#providers/stream-utils.js';
export { CrossTabCoordinator, isNavigatorLocksSupported } from '#cross-tab-coordinator.js';

export { MountTable } from '#mount-table.js';
export type { MountConfig, MountEntry, MountOptions, MountResolution } from '#mount-table.js';

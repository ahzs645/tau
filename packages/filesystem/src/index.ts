export type {
  ProviderCapabilities,
  ProviderFileStat,
  FileSystemProvider,
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
export { WriteCoordinator } from '#write-coordinator.js';
export { ChangeEventBus } from '#change-event-bus.js';
export { DirectoryTreeCache } from '#directory-tree-cache.js';
export { EventCoalescer, coalesceEvents } from '#event-coalescer.js';
export type { CoalescerOptions } from '#event-coalescer.js';
export { WatchRegistry } from '#watch-registry.js';
export type { WatchRegistryOptions } from '#watch-registry.js';

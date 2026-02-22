// Client
export { createKernelClient } from '#client/kernel-client.js';
export type { KernelClient, KernelClientOptions } from '#client/kernel-client.js';

// Plugin types
export type { KernelPlugin, MiddlewarePlugin, BundlerPlugin } from '#plugins/plugin-types.js';

// Presets
export { presets } from '#plugins/presets.js';

// Filesystem constructors
export { fromNodeFS, fromMemoryFS } from '#client/filesystem-constructors.js';

// FileManager bridge (for advanced usage / UI consumption)
export { KernelWorkerClient } from '#framework/kernel-worker-client.js';
export type { OnLogCallback, OnTelemetryCallback, OnProgressCallback } from '#framework/kernel-worker-client.js';
export { createFileManagerPort } from '#framework/kernel-worker-filemanager-bridge.js';
export type { KernelFileManager } from '#framework/kernel-worker-filemanager-bridge.js';

// Plugin author APIs
export { defineKernel } from '#types/kernel-worker.types.js';
export { defineBundler } from '#types/kernel-bundler.types.js';

// Kernel types (re-exported for consumers)
export type * from '#types/index.js';

// Helpers & Guards
export { createKernelSuccess, createKernelError, isKernelSuccess, isKernelError } from '#framework/kernel-helpers.js';

// Legacy (kept for backwards compatibility during migration)
export { createDefaultConfig } from '#config.js';
export type { DefaultConfigOptions, DefaultConfigResult } from '#config.js';

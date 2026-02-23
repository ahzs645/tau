// Client
export { createKernelClient } from '#client/kernel-client.js';
export type { KernelClient, KernelClientOptions, ConnectOptions } from '#client/kernel-client.js';

// Plugin types
export type { KernelPlugin, MiddlewarePlugin, BundlerPlugin } from '#plugins/plugin-types.js';

// Plugin factory helpers
export { createKernelPlugin, createMiddlewarePlugin, createBundlerPlugin } from '#plugins/plugin-helpers.js';

// Presets
export { presets } from '#plugins/presets.js';

// Filesystem constructors
export { fromNodeFS, fromMemoryFS, fromZenFS } from '#client/filesystem-constructors.js';

// Filesystem bridge (for advanced usage / UI consumption)
export { KernelWorkerClient } from '#framework/kernel-worker-client.js';
export type { OnLogCallback, OnTelemetryCallback, OnProgressCallback } from '#framework/kernel-worker-client.js';
export { createFileSystemPort } from '#framework/kernel-filesystem-bridge.js';

// Plugin author APIs
export { defineKernel } from '#types/kernel-worker.types.js';
export { defineBundler } from '#types/kernel-bundler.types.js';

// Kernel types (re-exported for consumers)
export type * from '#types/index.js';

// Helpers
export { createKernelSuccess, createKernelError } from '#framework/kernel-helpers.js';

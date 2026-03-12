/* oxlint-disable no-barrel-files/no-barrel-files -- public API re-export */
// Client
export { createKernelClient } from '#client/kernel-client.js';
export {
  RenderSupersededError,
  isRenderSupersededError,
  RenderAbortedError,
  isRenderAbortedError,
} from '#framework/kernel-worker-client.js';
export type {
  KernelClient,
  KernelClientOptions,
  ConnectOptions,
  CodeInput,
  FileInput,
  ExportResult,
} from '#client/kernel-client.js';

// Plugin types
export type { KernelPlugin, MiddlewarePlugin, BundlerPlugin } from '#plugins/plugin-types.js';

// Plugin factory helpers
export { createKernelPlugin, createMiddlewarePlugin, createBundlerPlugin } from '#plugins/plugin-helpers.js';

// Presets
export { presets } from '#plugins/presets.js';

// Filesystem constructors (browser-safe only; fromNodeFS is available via direct import)
export { fromMemoryFS } from '#filesystem/from-memory-fs.js';
export { fromFsLike } from '#filesystem/from-fs-like.js';

// Filesystem bridge (for advanced usage / UI consumption)
export { KernelWorkerClient } from '#framework/kernel-worker-client.js';
export type {
  OnLogCallback,
  OnTelemetryCallback,
  OnProgressCallback,
  OnStateChangedCallback,
} from '#framework/kernel-worker-client.js';
export { createBridgePort } from '#framework/kernel-filesystem-bridge.js';
export type { BridgeHandle } from '#framework/kernel-filesystem-bridge.js';

// Kernel types (re-exported for consumers, includes defineKernel and defineBundler)
export * from '#types/index.js';

// Helpers
export { createKernelSuccess, createKernelError } from '#framework/kernel-helpers.js';

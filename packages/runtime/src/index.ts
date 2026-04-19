/* oxlint-disable no-barrel-files/no-barrel-files -- public API re-export */
// Client
export { createRuntimeClient } from '#client/runtime-client.js';
export { createRuntimeClientOptions } from '#client/runtime-client-options.js';
export {
  RenderSupersededError,
  isRenderSupersededError,
  RenderAbortedError,
  isRenderAbortedError,
  RenderTimeoutError,
  isRenderTimeoutError,
} from '#framework/runtime-worker-client.js';
export type {
  RuntimeClient,
  RuntimeClientOptions,
  SharedMemoryConfig,
  ConnectOptions,
  CodeInput,
  FileInput,
  ExportResult,
} from '#client/runtime-client.js';

// Plugin types
export type {
  KernelPlugin,
  MiddlewarePlugin,
  BundlerPlugin,
  TranscoderPlugin,
  CollectExportFormats,
  CollectFormatMap,
  CollectKernelIds,
  CollectRenderOptions,
  CollectTranscodeMap,
  CollectTranscoderTargets,
  KnownSourceFormats,
  KnownTargetFormats,
  KnownTranscoderIds,
  MergeExportMap,
  RenderOptionsFor,
} from '#plugins/plugin-types.js';

// Plugin factory helpers
export {
  createKernelPlugin,
  createMiddlewarePlugin,
  createBundlerPlugin,
  createTranscoderPlugin,
} from '#plugins/plugin-helpers.js';

// Presets
export { presets } from '#plugins/presets.js';

// Filesystem constructors (browser-safe only; fromNodeFS is at @taucad/runtime/filesystem/node)
export { fromMemoryFS } from '#filesystem/from-memory-fs.js';
export { fromFsLike } from '#filesystem/from-fs-like.js';

// Filesystem bridge (for advanced usage / UI consumption)
export { RuntimeWorkerClient } from '#framework/runtime-worker-client.js';
export type {
  OnLogCallback,
  OnTelemetryCallback,
  OnProgressCallback,
  OnStateChangedCallback,
} from '#framework/runtime-worker-client.js';
export { createBridgePort } from '#framework/runtime-filesystem-bridge.js';
export type { BridgeHandle } from '#framework/runtime-filesystem-bridge.js';

// Core types (runtime, kernel, bundler, middleware, protocol)
export * from '#types/index.js';

// Helpers
export { createKernelSuccess, createKernelError } from '#kernels/kernel-helpers.js';

/**
 * Consumer-facing bundler plugin factory functions.
 * Each factory returns a BundlerPlugin registration object with resolved module URL.
 */

import { createBundlerPlugin } from '#plugins/plugin-helpers.js';

/**
 * Esbuild bundler options.
 * @public
 */
export type EsbuildOptions = {
  /** Override the default file extensions this bundler handles. Defaults to ['ts', 'js', 'tsx', 'jsx']. */
  extensions?: string[];
};

/**
 * Create an esbuild bundler plugin registration.
 * Handles JS/TS file bundling, code execution, and module resolution via esbuild-wasm.
 *
 * @public
 *
 * @example <caption>Client with esbuild bundler</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad()],
 *   bundlers: [esbuild({ extensions: ['ts', 'tsx'] })],
 * });
 * ```
 */
export const esbuild = createBundlerPlugin<EsbuildOptions>((options) => ({
  id: 'esbuild',
  moduleUrl: new URL('../bundler/esbuild.bundler.js', import.meta.url).href,
  extensions: options?.extensions ?? ['ts', 'js', 'tsx', 'jsx'],
}));

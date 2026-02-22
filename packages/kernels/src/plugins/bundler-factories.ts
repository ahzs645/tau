/**
 * Consumer-facing bundler plugin factory functions.
 * Each factory returns a BundlerPlugin registration object with resolved module URL.
 */

import type { BundlerPlugin } from '#plugins/plugin-types.js';

/**
 * Esbuild bundler options.
 */
export type EsbuildOptions = {
  /** Override the default file extensions this bundler handles. Defaults to ['ts', 'js', 'tsx', 'jsx']. */
  extensions?: string[];
};

/**
 * Create an esbuild bundler plugin registration.
 * Handles JS/TS file bundling, code execution, and module resolution via esbuild-wasm.
 *
 * @param options - Optional esbuild-specific configuration
 * @returns BundlerPlugin for esbuild
 *
 * @example
 * ```typescript
 * esbuild()                            // default: ['ts', 'js', 'tsx', 'jsx']
 * esbuild({ extensions: ['ts', 'tsx'] }) // TypeScript only
 * ```
 */
export function esbuild(options?: EsbuildOptions): BundlerPlugin {
  return {
    id: 'esbuild',
    moduleUrl: new URL('../bundler/esbuild.bundler.js', import.meta.url).href,
    extensions: options?.extensions ?? ['ts', 'js', 'tsx', 'jsx'],
    options: options as Record<string, unknown> | undefined,
  };
}

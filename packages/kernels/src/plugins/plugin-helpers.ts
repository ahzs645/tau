/**
 * Generic plugin factory helpers.
 *
 * Each helper uses two overloads to produce a correctly-typed factory function:
 *
 *   Overload 1 (no type param)   -> returns `() => Plugin`
 *   Overload 2 (with type param) -> returns `(options: T) => Plugin` or `(options?: T) => Plugin`
 *
 * Optionality is determined by `Partial<T> extends T`: when every key in T is
 * already optional, Partial<T> is identical to T and the check passes, making the
 * options parameter optional. When T has required keys, the check fails and options
 * become mandatory.
 *
 * Config can be a static object or a builder `(options: T | undefined) => Config`
 * for cases where plugin fields depend on options (e.g. esbuild extensions).
 */

import type { KernelPlugin, MiddlewarePlugin, BundlerPlugin } from '#plugins/plugin-types.js';

// --- Kernel ---

type KernelPluginConfig = Omit<KernelPlugin, 'options'>;

/**
 * Creates a type-safe kernel plugin factory from a static config or builder function.
 *
 * @param config - Static plugin configuration or a builder that receives options
 * @returns A factory function that produces KernelPlugin registrations
 */
export function createKernelPlugin(config: KernelPluginConfig): () => KernelPlugin;
export function createKernelPlugin<Options extends Record<string, unknown>>(
  config: KernelPluginConfig | ((options: Options | undefined) => KernelPluginConfig),
): Partial<Options> extends Options ? (options?: Options) => KernelPlugin : (options: Options) => KernelPlugin;
export function createKernelPlugin(
  config: KernelPluginConfig | ((options?: Record<string, unknown>) => KernelPluginConfig),
): (options?: Record<string, unknown>) => KernelPlugin {
  return (options) => {
    const resolved = typeof config === 'function' ? config(options) : config;
    return { ...resolved, options };
  };
}

// --- Middleware ---

type MiddlewarePluginConfig = Omit<MiddlewarePlugin, 'options'>;

/**
 * Creates a type-safe middleware plugin factory from a static config or builder function.
 *
 * @param config - Static plugin configuration or a builder that receives options
 * @returns A factory function that produces MiddlewarePlugin registrations
 */
export function createMiddlewarePlugin(config: MiddlewarePluginConfig): () => MiddlewarePlugin;
export function createMiddlewarePlugin<Options extends Record<string, unknown>>(
  config: MiddlewarePluginConfig | ((options: Options | undefined) => MiddlewarePluginConfig),
): Partial<Options> extends Options ? (options?: Options) => MiddlewarePlugin : (options: Options) => MiddlewarePlugin;
export function createMiddlewarePlugin(
  config: MiddlewarePluginConfig | ((options?: Record<string, unknown>) => MiddlewarePluginConfig),
): (options?: Record<string, unknown>) => MiddlewarePlugin {
  return (options) => {
    const resolved = typeof config === 'function' ? config(options) : config;
    return { ...resolved, options };
  };
}

// --- Bundler ---

type BundlerPluginConfig = Omit<BundlerPlugin, 'options'>;

/**
 * Creates a type-safe bundler plugin factory from a static config or builder function.
 *
 * @param config - Static plugin configuration or a builder that receives options
 * @returns A factory function that produces BundlerPlugin registrations
 */
export function createBundlerPlugin(config: BundlerPluginConfig): () => BundlerPlugin;
export function createBundlerPlugin<Options extends Record<string, unknown>>(
  config: BundlerPluginConfig | ((options: Options | undefined) => BundlerPluginConfig),
): Partial<Options> extends Options ? (options?: Options) => BundlerPlugin : (options: Options) => BundlerPlugin;
export function createBundlerPlugin(
  config: BundlerPluginConfig | ((options?: Record<string, unknown>) => BundlerPluginConfig),
): (options?: Record<string, unknown>) => BundlerPlugin {
  return (options) => {
    const resolved = typeof config === 'function' ? config(options) : config;
    return { ...resolved, options };
  };
}

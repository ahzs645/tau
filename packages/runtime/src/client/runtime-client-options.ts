import deepmerge from 'deepmerge';
import type { RuntimeClientOptions } from '#client/runtime-client.js';
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- variance: accepts any plugin generic
import type { KernelPlugin, MiddlewarePlugin, BundlerPlugin, TranscoderPlugin } from '#plugins/plugin-types.js';

// oxlint-disable @typescript-eslint/no-explicit-any, typescript/no-unnecessary-type-arguments -- variance: union of all plugin types; constrain Id to string so plugin.id is typed as string (not any)
type PluginWithId =
  | KernelPlugin<any, any, string>
  | MiddlewarePlugin
  | BundlerPlugin
  | TranscoderPlugin<any, any, string>;
// oxlint-enable @typescript-eslint/no-explicit-any, typescript/no-unnecessary-type-arguments -- variance: union of all plugin types; constrain Id to string so plugin.id is typed as string (not any)

const pluginArrayKeys = new Set(['kernels', 'middleware', 'bundlers', 'transcoders']);
const opaqueKeys = new Set(['transport', 'fileSystem', 'sharedMemory']);

/**
 * Merge two plugin arrays by ID: replace existing plugins in-place (preserving
 * position/priority), append plugins with new IDs at the end.
 *
 * @param base - Base plugin array to merge into
 * @param overrides - Override plugins to apply (replace by ID or append)
 * @returns Merged plugin array with replacements in-place and new plugins appended
 */
function mergePluginArrays<T extends PluginWithId>(base: T[], overrides: T[]): T[] {
  const overrideMap = new Map<string, T>(overrides.map((plugin) => [plugin.id, plugin]));
  const seen = new Set<string>();

  const merged = base.map((plugin) => {
    const override = overrideMap.get(plugin.id);
    if (override) {
      seen.add(plugin.id);
      return override;
    }
    return plugin;
  });

  for (const plugin of overrides) {
    if (!seen.has(plugin.id)) {
      merged.push(plugin);
    }
  }

  return merged;
}

/**
 * Create a type-safe `RuntimeClientOptions` object with full intellisense,
 * or smart-merge a base configuration with partial overrides.
 *
 * **Identity overload** -- provides intellisense without importing the
 * `RuntimeClientOptions` type:
 *
 * ```typescript
 * import { createRuntimeClientOptions } from '@taucad/runtime';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 *
 * const options = createRuntimeClientOptions({
 *   kernels: [replicad()],
 *   bundlers: [esbuild()],
 * });
 * ```
 *
 * **Merge overload** -- smart-merges a base with overrides using three
 * strategies based on field type:
 *
 * - **Plugin arrays** (`kernels`, `middleware`, `bundlers`): ID-based merge.
 *   Plugins with a matching `id` in the base are replaced in-place (preserving
 *   priority order); plugins with new IDs are appended.
 * - **Opaque fields** (`transport`, `fileSystem`): Full replacement.
 * - **All other fields**: Deep merge. Override keys replace base keys; absent
 *   keys preserve the base value.
 *
 * ```typescript
 * import { createRuntimeClientOptions } from '@taucad/runtime';
 * import { replicad } from '@taucad/runtime/kernels';
 *
 * const defaults = createRuntimeClientOptions({ kernels: [replicad()] });
 * const debug = createRuntimeClientOptions(defaults, {
 *   kernels: [replicad({ withSourceMapping: true })],
 * });
 * ```
 *
 * @param options - Complete options (identity overload)
 * @returns A `RuntimeClientOptions` object
 *
 * @public
 */
// oxlint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-restricted-types -- variance + empty-tuple default
export function createRuntimeClientOptions<
  const K extends KernelPlugin<any, any, any>[],
  const T extends TranscoderPlugin<any, any, any>[] = [],
>(options: RuntimeClientOptions<K, T>): RuntimeClientOptions<K, T>;
/**
 * Smart-merge a base configuration with partial overrides.
 *
 * @param base - Base options to merge from
 * @param overrides - Partial overrides to smart-merge into the base
 * @returns A new merged `RuntimeClientOptions` object
 *
 * @public
 */
export function createRuntimeClientOptions<
  const K extends KernelPlugin<any, any, any>[],
  const T extends TranscoderPlugin<any, any, any>[] = [],
  const K2 extends KernelPlugin<any, any, any>[] = K,
  const T2 extends TranscoderPlugin<any, any, any>[] = T,
>(base: RuntimeClientOptions<K, T>, overrides: Partial<RuntimeClientOptions<K2, T2>>): RuntimeClientOptions<K, T>;
// oxlint-enable @typescript-eslint/no-explicit-any
/**
 * Implementation: routes to identity or smart-merge based on arity.
 *
 * @param optionsOrBase - Options (identity) or base options (merge)
 * @param overrides - Partial overrides when merging
 * @returns A `RuntimeClientOptions` object
 *
 * @public
 */
export function createRuntimeClientOptions(
  optionsOrBase: RuntimeClientOptions,
  overrides?: Partial<RuntimeClientOptions>,
): RuntimeClientOptions {
  if (!overrides) {
    return optionsOrBase;
  }

  return deepmerge<RuntimeClientOptions>(optionsOrBase, overrides as RuntimeClientOptions, {
    customMerge(key) {
      if (pluginArrayKeys.has(key)) {
        return (base: PluginWithId[], override: PluginWithId[]) => mergePluginArrays(base, override);
      }
      if (opaqueKeys.has(key)) {
        return (_base: unknown, override: unknown) => override;
      }
      return undefined;
    },
  });
}

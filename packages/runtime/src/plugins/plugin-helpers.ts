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

import type { z } from 'zod';
import type { KernelPlugin, MiddlewarePlugin, BundlerPlugin, TranscoderPlugin } from '#plugins/plugin-types.js';

// --- Kernel ---

type KernelPluginConfig<
  Id extends string = string,
  ExportSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
  RenderSchema extends z.ZodType = z.ZodType,
> = Omit<
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- variance: strip phantom generic
  KernelPlugin<any, any, Id>,
  'options'
> & {
  /** Zod schema for kernel-specific render options. Type is inferred from this schema via phantom type. */
  renderSchema?: RenderSchema;
  /**
   * Zod schemas for per-format export options. Keys define the supported export formats.
   * Consumed for type inference only; JSON Schema resolved lazily in worker.
   */
  exportSchemas?: ExportSchemas;
  /** Zod schema for kernel options. Options type is inferred from this schema, avoiding explicit type parameters. */
  optionsSchema?: z.ZodType;
};

/** Resolve render options: `Record<string, unknown>` when no renderSchema, otherwise input type from Zod (preserves `.default()` optionality). */
type ResolveRenderOptions<RenderSchema extends z.ZodType> = z.ZodType extends RenderSchema
  ? Record<string, unknown>
  : z.input<RenderSchema>;

/** Derive per-format export option input types from Zod schemas (preserves `.default()` optionality). */
type InferFormatMap<ExportSchemas extends Record<string, z.ZodType>> = {
  [K in keyof ExportSchemas]: z.input<ExportSchemas[K]>;
};

/**
 * Resolve to `{}` when ExportSchemas is the wide default (no exportSchemas provided),
 * otherwise compute the concrete FormatMap.
 */
// oxlint-disable @typescript-eslint/no-empty-object-type -- intentional: matches KernelPlugin default
type ResolveFormatMap<ExportSchemas extends Record<string, z.ZodType>> = {} extends ExportSchemas
  ? {}
  : InferFormatMap<ExportSchemas>;
// oxlint-enable @typescript-eslint/no-empty-object-type

/**
 * Creates a type-safe kernel plugin factory from a static config.
 *
 * When `exportSchemas` contains Zod schemas, the schema keys define the supported
 * export formats. The factory's return type carries a phantom generic with the
 * inferred per-format option types. JSON Schema generation is deferred to the worker.
 *
 * When `optionsSchema` is provided, Options are inferred from the schema — no
 * explicit type parameter needed. This avoids TypeScript's partial-inference
 * limitation where providing one generic prevents inference of others.
 *
 * @param config - Static plugin configuration
 * @returns A factory function that produces KernelPlugin registrations
 * @public
 *
 * @example <caption>Kernel with export schemas and options</caption>
 * ```typescript
 * import { z } from 'zod';
 * import { createKernelPlugin } from '@taucad/runtime';
 *
 * export const myKernel = createKernelPlugin({
 *   id: 'my-kernel',
 *   moduleUrl: new URL('my-kernel.js', import.meta.url).href,
 *   extensions: ['ts'],
 *   optionsSchema: z.object({ debug: z.boolean().default(false) }),
 *   exportSchemas: { stl: z.object({ binary: z.boolean().default(true) }) },
 * });
 * // Inferred: (options?: { debug?: boolean }) => KernelPlugin<{ stl: { binary: boolean } }>
 * ```
 */
export function createKernelPlugin<
  const Id extends string,
  ExportSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
  RenderSchema extends z.ZodType = z.ZodType,
>(
  config: KernelPluginConfig<Id, ExportSchemas, RenderSchema> & { optionsSchema?: undefined },
): () => KernelPlugin<ResolveFormatMap<ExportSchemas>, ResolveRenderOptions<RenderSchema>, Id>;
/** Creates a kernel plugin factory with options inferred from optionsSchema. */
export function createKernelPlugin<
  const Id extends string,
  ExportSchemas extends Record<string, z.ZodType>,
  RenderSchema extends z.ZodType,
  OptionsSchema extends z.ZodType,
>(
  config: KernelPluginConfig<Id, ExportSchemas, RenderSchema> & { optionsSchema: OptionsSchema },
): Partial<z.input<OptionsSchema>> extends z.input<OptionsSchema>
  ? (
      options?: z.input<OptionsSchema>,
    ) => KernelPlugin<ResolveFormatMap<ExportSchemas>, ResolveRenderOptions<RenderSchema>, Id>
  : (
      options: z.input<OptionsSchema>,
    ) => KernelPlugin<ResolveFormatMap<ExportSchemas>, ResolveRenderOptions<RenderSchema>, Id>;
/**
 * Implementation: strips schema fields and returns pure metadata.
 * @public
 */
export function createKernelPlugin(config: KernelPluginConfig): (options?: unknown) => KernelPlugin {
  return (options) => {
    const { exportSchemas: _es, renderSchema: _rs, optionsSchema: _os, ...rest } = config;
    return { ...rest, options: options as Record<string, unknown> };
  };
}

// --- Middleware ---

type MiddlewarePluginConfig = Omit<MiddlewarePlugin, 'options'>;

/**
 * Creates a type-safe middleware plugin factory from a static config or builder function.
 *
 * @param config - Static plugin configuration or a builder that receives options
 * @returns A factory function that produces MiddlewarePlugin registrations
 * @public
 */
export function createMiddlewarePlugin(config: MiddlewarePluginConfig): () => MiddlewarePlugin;
/**
 * Wraps a middleware plugin config or factory into a resolved plugin constructor.
 *
 * @param config - Plugin configuration object or factory function
 * @returns A plugin constructor function
 * @public
 */
export function createMiddlewarePlugin<Options extends Record<string, unknown>>(
  config: MiddlewarePluginConfig | ((options: Options | undefined) => MiddlewarePluginConfig),
): Partial<Options> extends Options ? (options?: Options) => MiddlewarePlugin : (options: Options) => MiddlewarePlugin;
/**
 * Wraps a middleware plugin config or factory into a resolved plugin constructor.
 *
 * @param config - Plugin configuration object or factory function
 * @returns A plugin constructor function
 * @public
 */
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
 * @public
 */
export function createBundlerPlugin(config: BundlerPluginConfig): () => BundlerPlugin;
/**
 * Wraps a bundler plugin config or factory into a resolved plugin constructor.
 *
 * @param config - Plugin configuration object or factory function
 * @returns A plugin constructor function
 * @public
 */
export function createBundlerPlugin<Options extends Record<string, unknown>>(
  config: BundlerPluginConfig | ((options: Options | undefined) => BundlerPluginConfig),
): Partial<Options> extends Options ? (options?: Options) => BundlerPlugin : (options: Options) => BundlerPlugin;
/**
 * Wraps a bundler plugin config or factory into a resolved plugin constructor.
 *
 * @param config - Plugin configuration object or factory function
 * @returns A plugin constructor function
 * @public
 */
export function createBundlerPlugin(
  config: BundlerPluginConfig | ((options?: Record<string, unknown>) => BundlerPluginConfig),
): (options?: Record<string, unknown>) => BundlerPlugin {
  return (options) => {
    const resolved = typeof config === 'function' ? config(options) : config;
    return { ...resolved, options };
  };
}

// --- Transcoder ---

type TranscoderPluginConfig<
  Id extends string = string,
  From extends string = string,
  EdgeSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
> = Omit<
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- variance: strip phantom generics
  TranscoderPlugin<any, any, Id>,
  'options'
> & {
  /** Source format this transcoder converts from (e.g., `'glb'`). Enables type-level merging of kernel source-format options into transcoded target types. */
  from?: From;
  /**
   * Static edge option schemas keyed by target format. Provides compile-time type information;
   * the loaded {@link TranscoderDefinition.edges} array is the runtime source of truth.
   */
  edges?: EdgeSchemas;
};

/** Derive per-edge option input types from Zod schemas (preserves `.default()` optionality). */
type InferEdgeMap<EdgeSchemas extends Record<string, z.ZodType>> = {
  [K in keyof EdgeSchemas]: z.input<EdgeSchemas[K]>;
};

// oxlint-disable @typescript-eslint/no-empty-object-type -- intentional: matches TranscoderPlugin default
type ResolveEdgeMap<EdgeSchemas extends Record<string, z.ZodType>> = {} extends EdgeSchemas
  ? {}
  : InferEdgeMap<EdgeSchemas>;
// oxlint-enable @typescript-eslint/no-empty-object-type

/**
 * Creates a type-safe transcoder plugin factory from a static config.
 *
 * When `edges` contains Zod schemas keyed by target format, the factory's
 * return type carries a phantom generic with the inferred per-format edge option types.
 * When `from` is provided, the `From` literal is carried for source-format merging.
 *
 * @param config - Static plugin configuration
 * @returns A factory function that produces TranscoderPlugin registrations
 * @public
 */
export function createTranscoderPlugin<
  const Id extends string,
  const From extends string = string,
  EdgeSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
>(config: TranscoderPluginConfig<Id, From, EdgeSchemas>): () => TranscoderPlugin<ResolveEdgeMap<EdgeSchemas>, From, Id>;
/**
 * Wraps a transcoder plugin config or factory into a resolved plugin constructor.
 *
 * @param config - Plugin configuration object or factory function
 * @returns A plugin constructor function
 * @public
 */
export function createTranscoderPlugin<Options extends Record<string, unknown>>(
  config: TranscoderPluginConfig | ((options: Options | undefined) => TranscoderPluginConfig),
): Partial<Options> extends Options ? (options?: Options) => TranscoderPlugin : (options: Options) => TranscoderPlugin;
/**
 * Wraps a transcoder plugin config or factory into a resolved plugin constructor.
 *
 * @param config - Plugin configuration object or factory function
 * @returns A plugin constructor function
 * @public
 */
export function createTranscoderPlugin(
  config: TranscoderPluginConfig | ((options?: Record<string, unknown>) => TranscoderPluginConfig),
): (options?: Record<string, unknown>) => TranscoderPlugin {
  return (options) => {
    const resolved = typeof config === 'function' ? config(options) : config;
    const {
      edges: _edges,
      from: _from,
      ...rest
    } = resolved as TranscoderPluginConfig & { edges?: unknown; from?: unknown };
    return { ...rest, options };
  };
}

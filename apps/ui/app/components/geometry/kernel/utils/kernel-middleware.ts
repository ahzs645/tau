import type { z } from 'zod';
import type { PartialDeep } from 'type-fest';
import deepmerge from 'deepmerge';
import type {
  WrapCreateGeometryHook,
  WrapExportGeometryHook,
  WrapGetParametersHook,
  KernelLogger,
  KernelMiddlewareRuntime,
  MiddlewareState,
  KernelFilesystem,
  Dependency,
  LogLevel,
  OnWorkerLog,
} from '@taucad/types';

/**
 * Type alias for an empty Zod object schema.
 * Used as the default when no state schema is provided.
 * z.infer of this type yields `{}`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Represents z.object({}) schema type
type EmptyZodObject = z.ZodObject<{}>;

/**
 * Type alias for an empty state object.
 * Used as the default inferred state type when no state schema is provided.
 * Equivalent to z.infer<EmptyZodObject>.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Represents an empty state object
type EmptyState = {};

/**
 * Configuration for creating a kernel middleware.
 *
 * @template StateSchema - Optional Zod object schema for the middleware state.
 *   Defaults to an empty object schema when no state is needed.
 */
export type KernelMiddlewareConfig<StateSchema extends z.ZodObject<z.ZodRawShape> = EmptyZodObject> = {
  /** Name of the middleware for debugging and logging */
  name: string;
  /** Version of the middleware for cache key computation. Defaults to '1' if not provided. */
  version?: string;
  /** Optional Zod schema for type-safe state. Must be a z.object() schema. */
  stateSchema?: StateSchema;
  /** Wrap-style hook for createGeometry with onion model execution */
  wrapCreateGeometry?: WrapCreateGeometryHook<z.infer<StateSchema>>;
  /** Wrap-style hook for exportGeometry with onion model execution */
  wrapExportGeometry?: WrapExportGeometryHook<z.infer<StateSchema>>;
  /** Wrap-style hook for getParameters with onion model execution */
  wrapGetParameters?: WrapGetParametersHook<z.infer<StateSchema>>;
};

/**
 * A kernel middleware instance with typed wrap-style hooks.
 *
 * @template StateSchema - The Zod schema type for the state.
 *   Keeping the schema type (not inferred type) allows proper type flow from config to middleware.
 *   Defaults to an empty object schema when no state is needed.
 */
export type KernelMiddleware<StateSchema extends z.ZodObject<z.ZodRawShape> = EmptyZodObject> = {
  /** Name of the middleware */
  name: string;
  /** Version of the middleware for cache key computation. Defaults to '1' if not provided. */
  version?: string;
  /** Zod schema for validating state updates (if provided) */
  stateSchema?: StateSchema;
  /** Wrap-style hook for createGeometry with onion model execution */
  wrapCreateGeometry?: WrapCreateGeometryHook<z.infer<StateSchema>>;
  /** Wrap-style hook for exportGeometry with onion model execution */
  wrapExportGeometry?: WrapExportGeometryHook<z.infer<StateSchema>>;
  /** Wrap-style hook for getParameters with onion model execution */
  wrapGetParameters?: WrapGetParametersHook<z.infer<StateSchema>>;
};

/**
 * Creates a kernel middleware instance with wrap-style hooks.
 *
 * Middleware allows intercepting and transforming results from kernel operations
 * using an onion model where code after handler() runs on the "return journey".
 * This pattern is inspired by LangChain's wrap-style middleware hooks.
 *
 * @param config - Middleware configuration with wrap hooks and optional state schema
 * @returns A middleware instance that can be applied to kernel workers
 *
 * @example
 * ```typescript
 * // Simple logging middleware - destructure what you need
 * const loggingMiddleware = createKernelMiddleware({
 *   name: 'Logging',
 *   async wrapCreateGeometry(input, handler, { logger }) {
 *     logger.debug('Computing geometry...');
 *     const result = await handler(input);
 *     logger.debug('Geometry computed');
 *     return result;
 *   },
 * });
 *
 * // Caching middleware with type-safe state
 * const cacheMiddleware = createKernelMiddleware({
 *   name: 'GeometryCache',
 *   stateSchema: z.object({
 *     cacheKey: z.string(),
 *     cacheHit: z.boolean(),
 *   }),
 *   async wrapCreateGeometry({ basePath }, handler, { state, dependencyHash }) {
 *     const cacheKey = dependencyHash;
 *
 *     // Check cache - short-circuit on hit
 *     const cached = await checkCache(cacheKey);
 *     if (cached) {
 *       state.update({ cacheKey, cacheHit: true });
 *       return cached;  // Still flows through upstream middleware
 *     }
 *
 *     // Cache miss - execute downstream
 *     state.update({ cacheKey, cacheHit: false });
 *     const result = await handler(input);
 *
 *     // Write to cache on way back up
 *     await writeCache(cacheKey, result);
 *     return result;
 *   },
 * });
 * ```
 */
export function createKernelMiddleware<StateSchema extends z.ZodObject<z.ZodRawShape> = EmptyZodObject>(
  config: KernelMiddlewareConfig<StateSchema>,
): KernelMiddleware<StateSchema> {
  return {
    name: config.name,
    version: config.version ?? '1',
    stateSchema: config.stateSchema,
    wrapCreateGeometry: config.wrapCreateGeometry,
    wrapExportGeometry: config.wrapExportGeometry,
    wrapGetParameters: config.wrapGetParameters,
  };
}

/**
 * Create a middleware logger from an OnWorkerLog callback.
 * The logger automatically injects the middleware name as the component.
 *
 * @param onLog - The log callback from KernelWorker
 * @param middlewareName - Name of the middleware for origin.component
 * @returns Logger instance with convenience methods
 */
export function createMiddlewareLogger(onLog: OnWorkerLog, middlewareName: string): KernelLogger {
  const emit = (level: LogLevel, message: string, data?: unknown): void => {
    onLog({
      level,
      message,
      origin: { component: middlewareName },
      data,
    });
  };

  return {
    log(message, options) {
      emit('info', message, options?.data);
    },
    debug(message, options) {
      emit('debug', message, options?.data);
    },
    trace(message, options) {
      emit('trace', message, options?.data);
    },
    warn(message, options) {
      emit('warn', message, options?.data);
    },
    error(message, options) {
      emit('error', message, options?.data);
    },
    custom(level, message, options) {
      emit(level, message, options?.data);
    },
  };
}

/**
 * Create a type-safe state for a middleware.
 * The state validates updates against the Zod schema if provided.
 *
 * Note: Array updates replace the entire array rather than concatenating.
 * For example: state.update({ items: [1, 2] }) then state.update({ items: [3] })
 * results in { items: [3] }, not { items: [1, 2, 3] }.
 *
 * @param schema - Optional Zod object schema for validation
 * @returns State instance with value and update method
 */
export function createMiddlewareState<State extends Record<string, unknown> = EmptyState>(
  schema?: z.ZodObject<z.ZodRawShape>,
): MiddlewareState<State> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- initial value is empty object
  let stateValue: PartialDeep<State> = {} as PartialDeep<State>;

  return {
    /**
     * Get the current state value.
     * @returns The current state value.
     */
    get value() {
      return stateValue;
    },
    /**
     * Update the state with partial data.
     * Values are validated against the Zod schema before being merged.
     *
     * Note: Array updates replace the entire array rather than concatenating.
     * For example: state.update({ items: [1, 2] }) then state.update({ items: [3] })
     * results in { items: [3] }, not { items: [1, 2, 3] }.
     *
     * @param partial - Partial data to merge into the state
     */
    update(partial: Partial<State>) {
      // First, construct the merged object using deepmerge for proper nested object handling
      // Use arrayMerge to replace arrays instead of concatenating (default deepmerge behavior)
      const merged = deepmerge(stateValue, partial, {
        arrayMerge: (_target: unknown[], source: unknown[]) => source,
      }) as PartialDeep<State>;

      // Then validate against schema if provided
      if (schema) {
        // Use partial schema for validation - allows partial updates
        const partialSchema = schema.partial();
        partialSchema.parse(merged);
      }

      stateValue = merged;
    },
  };
}

/**
 * Options for creating a middleware runtime.
 */
export type CreateMiddlewareRuntimeOptions = {
  /** The log callback from KernelWorker */
  onLog: OnWorkerLog;
  /** Name of the middleware */
  middlewareName: string;
  /** Filesystem for all file operations */
  filesystem: KernelFilesystem;
  /** Array of dependencies for cache key computation */
  dependencies: readonly Dependency[];
  /** Pre-computed SHA-256 hash of all dependencies */
  dependencyHash: string;
  /** Optional Zod object schema for the state */
  stateSchema?: z.ZodObject<z.ZodRawShape>;
};

/**
 * Create a middleware runtime with logger, filesystem, state, and dependencies.
 *
 * @param options - Runtime configuration options
 * @returns Runtime instance for middleware wrap hooks
 */
export function createMiddlewareRuntime<State extends Record<string, unknown> = EmptyState>(
  options: CreateMiddlewareRuntimeOptions,
): KernelMiddlewareRuntime<State> {
  const { onLog, middlewareName, filesystem, dependencies, dependencyHash, stateSchema } = options;

  return {
    logger: createMiddlewareLogger(onLog, middlewareName),
    filesystem,
    state: createMiddlewareState<State>(stateSchema),
    dependencies,
    dependencyHash,
  };
}

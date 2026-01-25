import type { z } from 'zod';
import type { PartialDeep } from 'type-fest';
import deepmerge from 'deepmerge';
import type {
  WrapComputeGeometryHook,
  WrapExportGeometryHook,
  WrapExtractParametersHook,
  KernelMiddlewareLogger,
  KernelMiddlewareRuntime,
  MiddlewareState,
  MiddlewareFileManager,
  Dependency,
} from '@taucad/types';
import type { LogLevel, OnWorkerLog } from '#types/console.types.js';

/**
 * Type alias for an empty Zod object schema.
 * Used as the default when no state schema is provided.
 * z.infer of this type yields `{}`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Represents z.object({}) schema type
type EmptyZodObject = z.ZodObject<{}>;

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
  /** Wrap-style hook for computeGeometry with onion model execution */
  wrapComputeGeometry?: WrapComputeGeometryHook<z.infer<StateSchema>>;
  /** Wrap-style hook for exportGeometry with onion model execution */
  wrapExportGeometry?: WrapExportGeometryHook<z.infer<StateSchema>>;
  /** Wrap-style hook for extractParameters with onion model execution */
  wrapExtractParameters?: WrapExtractParametersHook<z.infer<StateSchema>>;
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
  /** Wrap-style hook for computeGeometry with onion model execution */
  wrapComputeGeometry?: WrapComputeGeometryHook<z.infer<StateSchema>>;
  /** Wrap-style hook for exportGeometry with onion model execution */
  wrapExportGeometry?: WrapExportGeometryHook<z.infer<StateSchema>>;
  /** Wrap-style hook for extractParameters with onion model execution */
  wrapExtractParameters?: WrapExtractParametersHook<z.infer<StateSchema>>;
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
 * // Simple logging middleware
 * const loggingMiddleware = createKernelMiddleware({
 *   name: 'Logging',
 *   async wrapComputeGeometry(request, handler) {
 *     request.runtime.logger.debug('Computing geometry...');
 *     const result = await handler(request);
 *     request.runtime.logger.debug('Geometry computed');
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
 *   async wrapComputeGeometry(request, handler) {
 *     const { input, runtime } = request;
 *     const cacheKey = computeCacheKey(input);
 *
 *     // Check cache - short-circuit on hit
 *     const cached = await checkCache(cacheKey);
 *     if (cached) {
 *       runtime.state.update({ cacheKey, cacheHit: true });
 *       return cached;  // Still flows through upstream middleware
 *     }
 *
 *     // Cache miss - execute downstream
 *     runtime.state.update({ cacheKey, cacheHit: false });
 *     const result = await handler(request);
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
    version: config.version,
    stateSchema: config.stateSchema,
    wrapComputeGeometry: config.wrapComputeGeometry,
    wrapExportGeometry: config.wrapExportGeometry,
    wrapExtractParameters: config.wrapExtractParameters,
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
export function createMiddlewareLogger(onLog: OnWorkerLog, middlewareName: string): KernelMiddlewareLogger {
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
  };
}

/**
 * Create a type-safe state for a middleware.
 * The state validates updates against the Zod schema if provided.
 *
 * @param schema - Optional Zod object schema for validation
 * @returns State instance with value and update method
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export function createMiddlewareState<State extends Record<string, unknown> = {}>(
  schema?: z.ZodObject<z.ZodRawShape>,
): MiddlewareState<State> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- initial value is empty object
  let stateValue: PartialDeep<State> = {} as PartialDeep<State>;

  return {
    get value() {
      return stateValue;
    },
    update(partial: Partial<State>) {
      // First, construct the merged object using deepmerge for proper nested object handling
      const merged = deepmerge(stateValue, partial) as PartialDeep<State>;

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
  /** File manager instance */
  fileManager: MiddlewareFileManager;
  /** Array of dependencies for cache key computation */
  dependencies: readonly Dependency[];
  /** Pre-computed SHA-256 hash of all dependencies */
  dependencyHash: string;
  /** Optional Zod object schema for the state */
  stateSchema?: z.ZodObject<z.ZodRawShape>;
};

/**
 * Create a middleware runtime with logger, file manager, state, and dependencies.
 *
 * @param options - Runtime configuration options
 * @returns Runtime instance for middleware wrap hooks
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export function createMiddlewareRuntime<State extends Record<string, unknown> = {}>(
  options: CreateMiddlewareRuntimeOptions,
): KernelMiddlewareRuntime<State> {
  const { onLog, middlewareName, fileManager, dependencies, dependencyHash, stateSchema } = options;

  return {
    logger: createMiddlewareLogger(onLog, middlewareName),
    fileManager,
    state: createMiddlewareState<State>(stateSchema),
    dependencies,
    dependencyHash,
  };
}

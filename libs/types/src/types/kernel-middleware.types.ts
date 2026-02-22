/**
 * Kernel Middleware Types
 *
 * Types for the middleware subsystem: wrap-style hooks, middleware state,
 * middleware runtime context, and handler types for the onion-model pipeline.
 */

import type { PartialDeep } from 'type-fest';
import type { CreateGeometryResult, ExportGeometryResult, GetParametersResult } from '#types/kernel.types.js';
import type { Dependency } from '#types/kernel-dependency.types.js';
import type {
  KernelLogger,
  KernelFilesystem,
  CreateGeometryInput,
  ExportGeometryInput,
  GetParametersInput,
} from '#types/kernel-worker.types.js';

// =============================================================================
// Middleware State & Runtime
// =============================================================================

/**
 * Type-safe state for middleware to persist data during an operation.
 *
 * The state is scoped to a single middleware and persists for the duration of
 * one operation (e.g., one createGeometry call). In wrap-style hooks, state
 * can be updated before calling handler() and read after it returns.
 *
 * @template T - The state schema type inferred from Zod. Must be an object type.
 */
export type MiddlewareState<T extends Record<string, unknown>> = {
  /**
   * Current state value.
   * Type is PartialDeep<T> since update() may be called with partial data
   * or not called at all.
   */
  readonly value: PartialDeep<T>;

  /**
   * Update the state with partial data.
   * Values are validated against the Zod schema before being merged.
   *
   * @param partial - Partial data to merge into the state
   */
  update: (partial: Partial<T>) => void;
};

/**
 * Runtime context provided to middleware wrap hooks.
 * Contains services and utilities available during hook execution.
 *
 * @template State - The state type inferred from the middleware's stateSchema. Must be an object type.
 * @template Config - The config type inferred from the middleware's configSchema. Must be an object type.
 */

export type KernelMiddlewareRuntime<
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
  State extends Record<string, unknown> = {},
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
  Config extends Record<string, unknown> = {},
> = {
  /** Logger with middleware name pre-configured as the component */
  logger: KernelLogger;
  /** Filesystem for all file operations (uses absolute path methods for middleware) */
  filesystem: KernelFilesystem;
  /** Type-safe state for persisting data during the wrap hook execution */
  state: MiddlewareState<State>;
  /** Resolved config (configSchema defaults merged with caller overrides) */
  config: Config;
  /**
   * Dependencies for cache key computation.
   * Includes file dependencies (source files, fonts), middleware signatures,
   * framework version, and kernel options.
   */
  dependencies: readonly Dependency[];
  /**
   * Pre-computed SHA-256 hash of all dependencies.
   * Can be used as a cache key or unique geometry identifier.
   * This is a 64-character hex string.
   */
  dependencyHash: string;
};

// =============================================================================
// Middleware Handler Types (Wrap-Style Hooks)
// =============================================================================

/**
 * Handler function for createGeometry.
 * Called by wrap hooks to continue the middleware chain or execute the main operation.
 * Runtime is captured in the handler's closure, so middleware only passes input.
 * Uses internal geometry types (without hash) - hash is added by kernel-worker.ts.
 */
export type CreateGeometryHandler = (input: CreateGeometryInput) => Promise<CreateGeometryResult>;

/**
 * Handler function for exportGeometry.
 * Called by wrap hooks to continue the middleware chain or execute the main operation.
 * Runtime is captured in the handler's closure, so middleware only passes input.
 */
export type ExportGeometryHandler = (input: ExportGeometryInput) => Promise<ExportGeometryResult>;

/**
 * Handler function for getParameters.
 * Called by wrap hooks to continue the middleware chain or execute the main operation.
 * Runtime is captured in the handler's closure, so middleware only passes input.
 */
export type GetParametersHandler = (input: GetParametersInput) => Promise<GetParametersResult>;

// =============================================================================
// Middleware Wrap Hook Types
// =============================================================================

/**
 * Wrap-style hook for createGeometry.
 * Provides full control over execution: can short-circuit, transform input/output,
 * or add pre/post processing. Code after handler() runs on the "return journey"
 * (onion model), so short-circuited results still flow through upstream middleware.
 *
 * Arguments: (input, handler, runtime)
 * - input: what to process (destructure what you need)
 * - handler: call to continue the chain (always used)
 * - runtime: services like logger/filesystem (only destructure if needed)
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 *
 * @example
 * ```typescript
 * async wrapCreateGeometry({ basePath }, handler, { logger, filesystem, dependencyHash }) {
 *   // PRE: Check cache
 *   const cached = await checkCache(basePath, dependencyHash);
 *   if (cached) return cached;  // Short-circuit
 *
 *   // EXECUTE: Call downstream (just pass input)
 *   const result = await handler(input);
 *
 *   // POST: Transform result (runs even if upstream short-circuited)
 *   return transform(result);
 * }
 * ```
 */

export type WrapCreateGeometryHook<
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
  State extends Record<string, unknown> = {},
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
  Config extends Record<string, unknown> = {},
> = (
  input: CreateGeometryInput,
  handler: CreateGeometryHandler,
  runtime: KernelMiddlewareRuntime<State, Config>,
) => Promise<CreateGeometryResult>;

/**
 * Wrap-style hook for exportGeometry.
 * Provides full control over execution with onion model semantics.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */

export type WrapExportGeometryHook<
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
  State extends Record<string, unknown> = {},
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
  Config extends Record<string, unknown> = {},
> = (
  input: ExportGeometryInput,
  handler: ExportGeometryHandler,
  runtime: KernelMiddlewareRuntime<State, Config>,
) => Promise<ExportGeometryResult>;

/**
 * Wrap-style hook for getParameters.
 * Provides full control over execution with onion model semantics.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */

export type WrapGetParametersHook<
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
  State extends Record<string, unknown> = {},
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
  Config extends Record<string, unknown> = {},
> = (
  input: GetParametersInput,
  handler: GetParametersHandler,
  runtime: KernelMiddlewareRuntime<State, Config>,
) => Promise<GetParametersResult>;

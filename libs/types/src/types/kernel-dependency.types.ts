/**
 * Kernel Dependency Types
 *
 * Discriminated union of dependency types used for cache key computation.
 * Ensures all factors affecting the output are captured.
 */

/**
 * A file dependency representing a source file or font file.
 * The contentHash is a SHA-256 hash of the file's contents.
 */
export type FileDependency = {
  type: 'file';
  /** Path to the file relative to the build directory */
  path: string;
  /** SHA-256 hash of the file contents */
  contentHash: string;
};

/**
 * A middleware dependency representing a middleware in the chain.
 * The index preserves the execution order in the chain.
 */
export type MiddlewareDependency = {
  type: 'middleware';
  /** Name of the middleware */
  name: string;
  /** Version of the middleware */
  version: string;
  /** Position in the middleware chain (0-indexed) */
  index: number;
  /** Raw config object -- serialized in the final dependency hash pass */
  config: Record<string, unknown>;
};

/**
 * A framework dependency representing the Tau framework version.
 */
export type FrameworkDependency = {
  type: 'framework';
  /** Framework name (always 'tau') */
  name: 'tau';
  /** Version string from package.json */
  version: string;
};

/**
 * An option dependency representing a kernel configuration option.
 * Used to track mesh tolerances, backend arguments, etc.
 */
export type OptionDependency = {
  type: 'option';
  /** Option key (e.g., 'meshConfiguration', 'arguments') */
  key: string;
  /** Option value (serialized to JSON for hashing) */
  value: unknown;
};

/**
 * A parameter dependency representing user-provided parameter values.
 * Used to invalidate cache when parameter values change.
 */
export type ParameterDependency = {
  type: 'parameter';
  /** Raw parameters object -- serialized in the final dependency hash pass */
  parameters: Record<string, unknown>;
};

/**
 * An asset dependency representing a bundled asset (font, WASM, etc.).
 * Used to invalidate cache when assets change between deployments.
 */
export type AssetDependency = {
  type: 'asset';
  /** Asset identifier (e.g., 'font:Geist-Regular.ttf', 'wasm:opencascade') */
  name: string;
  /** SHA-256 hash of the asset content */
  contentHash: string;
};

/**
 * Discriminated union of all dependency types.
 * Used for cache key computation to ensure all factors affecting
 * the output are captured.
 */
export type Dependency =
  | FileDependency
  | MiddlewareDependency
  | FrameworkDependency
  | OptionDependency
  | ParameterDependency
  | AssetDependency;

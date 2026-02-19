/**
 * Kernel Middleware Testing Utilities
 *
 * Shared helper functions for testing kernel middleware.
 */

import deepmerge from 'deepmerge';
import type { PartialDeep } from 'type-fest';
import type {
  CreateGeometryResult,
  CreateGeometryResultCompleted,
  GeometryResponse,
  KernelMiddlewareRuntime,
  KernelLogger,
  KernelRuntime,
  KernelDefinition,
  MiddlewareState,
  KernelFilesystem,
  FileStat,
  KernelIssue,
  Dependency,
  GetParametersResult,
  ExportGeometryResult,
  GeometryFile,
  CanHandleInput,
  GetDependenciesInput,
  GetParametersInput,
  CreateGeometryInput,
  ExportGeometryInput,
  OnWorkerLog,
  MiddlewareConfig,
} from '@taucad/types';
import * as kernelSymbols from '@taucad/types/symbols';
import { dirname } from '@zenfs/core/path';
import { vi } from 'vitest';
import type { KernelMiddleware } from '#components/geometry/kernel/middleware/kernel-middleware.js';
import { KernelRuntimeWorker } from '#components/geometry/kernel/kernel-runtime-worker.js';
import type { ResolvedMiddleware } from '#components/geometry/kernel/utils/kernel-worker.js';
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import { createFileManagerPort } from '#components/geometry/kernel/utils/kernel-worker-filemanager-bridge.js';
import { configureFilesystem, resetFilesystem, fs } from '#filesystem/zenfs-config.js';
import { fileManager } from '#machines/file-manager.js';
import { joinPath } from '#utils/path.utils.js';

// =============================================================================
// Test Filesystem Utilities
// =============================================================================

/**
 * Seed the test filesystem with files.
 * Configures the in-memory backend and seeds with provided files.
 * Uses the central configureFilesystem for consistency with production code.
 *
 * @param files - Record of absolute paths to file contents
 */
export async function seedTestFilesystem(files: Record<string, string | Uint8Array<ArrayBuffer>>): Promise<void> {
  // Use central config with InMemory backend - this sets the "first wins" state
  await configureFilesystem('memory');

  // Write files to the filesystem
  for (const [path, content] of Object.entries(files)) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const parentDir = dirname(normalizedPath);

    // Create parent directories if needed
    if (parentDir && parentDir !== '/') {
      // eslint-disable-next-line no-await-in-loop -- Need to create directories before files
      await fs.promises.mkdir(parentDir, { recursive: true });
    }

    // Write file content
    // eslint-disable-next-line no-await-in-loop -- Need sequential file writes
    await fs.promises.writeFile(normalizedPath, content);
  }
}

/**
 * Clear the test filesystem by resetting to a fresh in-memory backend.
 */
export async function clearTestFilesystem(): Promise<void> {
  await resetFilesystem();
}

// =============================================================================
// Worker Testing Utilities
// =============================================================================

/**
 * Options for initializing a kernel worker in tests.
 */
export type InitializeWorkerOptions = {
  /** Custom log handler */
  onLog?: OnWorkerLog;
  /** Worker-specific options passed to initializeEntry (e.g., ReplicadWorker: { withExceptions: true }) */
  workerOptions?: Record<string, unknown>;
  /** Middleware configuration (defaults to empty array for tests that bypass dynamic loading) */
  middlewareConfig?: MiddlewareConfig;
};

/**
 * Initialize a kernel worker using the production code path.
 * Uses MessageChannel to connect to the real fileManager, ensuring tests
 * exercise the same code path as production.
 *
 * IMPORTANT: Call seedTestFilesystem() before this to configure InMemory backend.
 * The first call to configure the filesystem "wins" - tests configure InMemory,
 * so the fileManager's ensureFilesystemConfigured('indexeddb') just waits.
 *
 * @param worker - The kernel worker instance to initialize
 * @param options - Optional configuration (onLog, workerOptions for kernel-specific settings like withExceptions)
 * @returns Promise resolving to the initialized worker
 */
export async function initializeWorkerForTesting<T extends KernelWorker>(
  worker: T,
  options?: InitializeWorkerOptions,
): Promise<T> {
  const port = createFileManagerPort(fileManager);

  await worker[kernelSymbols.initializeEntry](
    {
      onLog:
        options?.onLog ??
        (() => {
          // No-op for testing
        }),
    },
    { fileManagerPort: port },
    options?.workerOptions ?? {},
    options?.middlewareConfig ?? [],
  );

  return worker;
}

/**
 * Create a mock logger for kernel and middleware testing.
 * Returns a logger with vitest mock functions.
 */
export function createMockLogger(): KernelLogger & {
  log: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  custom: ReturnType<typeof vi.fn>;
} {
  return {
    log: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    custom: vi.fn(),
  };
}

/**
 * Options for creating a mock filesystem with vitest mocks.
 */
export type MockFilesystemOptions = {
  /** Result for exists calls */
  existsResult?: boolean | ((path: string) => boolean | Promise<boolean>);
  /** Result for readFile calls */
  readFileResult?:
    | string
    | Uint8Array<ArrayBuffer>
    | ((path: string) => string | Uint8Array<ArrayBuffer> | Promise<string | Uint8Array<ArrayBuffer>>);
  /** Result for getDirectoryStat calls */
  getDirectoryStatResult?: FileStat[];
};

/**
 * Mock functions exposed for test assertions and setup.
 */
export type MockFilesystemMocks = {
  readFile: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  readdir: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  ensureDirectoryExists: ReturnType<typeof vi.fn>;
  getDirectoryStat: ReturnType<typeof vi.fn>;
  getDirectoryContents: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
};

/**
 * A mock KernelFilesystem with vitest mock functions for verification.
 * Use the `mocks` property to access mock functions for test setup.
 */
export type MockFilesystem = KernelFilesystem & {
  /** Access underlying mock functions for test assertions and setup */
  mocks: MockFilesystemMocks;
};

/**
 * Create a mock filesystem for middleware testing.
 * Returns a filesystem with vitest mock functions for assertion.
 *
 * @example
 * ```typescript
 * const filesystem = createMockFilesystem({ existsResult: true });
 * // Configure mock behavior
 * filesystem.mocks.readFile.mockRejectedValue(new Error('Read error'));
 * // Verify calls
 * expect(filesystem.mocks.writeFile).toHaveBeenCalledWith(path, data);
 * ```
 */
export function createMockFilesystem(options?: MockFilesystemOptions): MockFilesystem {
  const existsFn = vi.fn().mockImplementation(async (path: string) => {
    if (typeof options?.existsResult === 'function') {
      return options.existsResult(path);
    }

    return options?.existsResult ?? false;
  });

  const readFileFn = vi.fn().mockImplementation(async (path: string) => {
    if (typeof options?.readFileResult === 'function') {
      return options.readFileResult(path);
    }

    return options?.readFileResult ?? new Uint8Array();
  });

  // Create base mock functions
  const writeFileFn = vi.fn().mockResolvedValue(undefined);
  const mkdirFn = vi.fn().mockResolvedValue(undefined);
  const ensureDirectoryExistsFn = vi.fn().mockResolvedValue(undefined);
  const getDirectoryStatFn = vi.fn().mockResolvedValue(options?.getDirectoryStatResult ?? []);
  const getDirectoryContentsFn = vi.fn().mockResolvedValue({});
  const unlinkFn = vi.fn().mockResolvedValue(undefined);
  const readdirFn = vi.fn().mockResolvedValue([]);

  // Define readFile with overload signatures - delegates to mock
  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  async function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
    return readFileFn(path, encoding) as Promise<string | Uint8Array<ArrayBuffer>>;
  }

  // Mocks object for test assertions
  const mocks: MockFilesystemMocks = {
    readFile: readFileFn,
    exists: existsFn,
    readdir: readdirFn,
    writeFile: writeFileFn,
    mkdir: mkdirFn,
    ensureDirectoryExists: ensureDirectoryExistsFn,
    getDirectoryStat: getDirectoryStatFn,
    getDirectoryContents: getDirectoryContentsFn,
    unlink: unlinkFn,
  };

  return {
    // Properly typed overloaded function
    readFile,

    async readFiles(paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
      const result: Record<string, Uint8Array<ArrayBuffer>> = {};
      for (const path of paths) {
        const content = (await readFileFn(path)) as Uint8Array<ArrayBuffer>;
        result[path] = content;
      }

      return result;
    },

    exists: async (path: string) => existsFn(path) as Promise<boolean>,
    readdir: async (path: string) => readdirFn(path) as Promise<string[]>,
    writeFile: async (path: string, data: Uint8Array<ArrayBuffer> | string) => writeFileFn(path, data) as Promise<void>,
    mkdir: async (path: string, options_?: { recursive?: boolean }) => mkdirFn(path, options_) as Promise<void>,
    ensureDirectoryExists: async (path: string) => ensureDirectoryExistsFn(path) as Promise<void>,
    getDirectoryStat: async (path: string) => getDirectoryStatFn(path) as Promise<FileStat[]>,
    getDirectoryContents: async (path: string) =>
      getDirectoryContentsFn(path) as Promise<Record<string, Uint8Array<ArrayBuffer>>>,
    unlink: async (path: string) => unlinkFn(path) as Promise<void>,

    // Expose mocks for test assertions
    mocks,
  };
}

/**
 * Create a mock state for middleware testing.
 */
export function createMockState<T extends Record<string, unknown>>(): MiddlewareState<T> & {
  update: ReturnType<typeof vi.fn>;
} {
  // Start with empty object - we use a wrapper object to allow reassignment
  // while still having the getter work correctly
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Test utility requires flexible typing
  const stateContainer: { value: PartialDeep<T> } = { value: {} as PartialDeep<T> };

  const updateFn = vi.fn().mockImplementation((partial: Partial<T>) => {
    // Use deepmerge to match production createMiddlewareState behavior
    // Use arrayMerge to replace arrays instead of concatenating (matches kernel-middleware.ts)
    stateContainer.value = deepmerge(stateContainer.value, partial, {
      arrayMerge: (_target: unknown[], source: unknown[]) => source,
    }) as PartialDeep<T>;
  });

  return {
    get value() {
      return stateContainer.value;
    },
    update: updateFn,
  };
}

/**
 * Create a mock middleware runtime for testing.
 * Combines logger, filesystem, state, and dependencies.
 */
/** Default mock dependency hash for testing */
const defaultMockDependencyHash = 'a'.repeat(64);

export function createMockRuntime<
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
  State extends Record<string, unknown> = {},
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
  Config extends Record<string, unknown> = {},
>(options?: {
  filesystemOverrides?: MockFilesystemOptions;
  dependencies?: readonly Dependency[];
  dependencyHash?: string;
  config?: Config;
}): KernelMiddlewareRuntime<State, Config> & {
  logger: ReturnType<typeof createMockLogger>;
  filesystem: MockFilesystem;
  state: ReturnType<typeof createMockState<State>>;
} {
  return {
    logger: createMockLogger(),
    filesystem: createMockFilesystem(options?.filesystemOverrides),
    state: createMockState<State>(),

    config: (options?.config ?? {}) as Config,
    dependencies: options?.dependencies ?? [],
    dependencyHash: options?.dependencyHash ?? defaultMockDependencyHash,
  };
}

/**
 * Create a successful CreateGeometryResultInternal with geometries.
 * Used for testing middleware which works with internal types (without hash).
 */
export function createSuccessResult(geometries: GeometryResponse[]): CreateGeometryResult {
  return {
    success: true,
    data: geometries,
    issues: [],
  };
}

/**
 * Create a successful CreateGeometryResultInternal with a single GLTF geometry.
 */
export function createGltfSuccessResult(content: Uint8Array<ArrayBuffer>): CreateGeometryResult {
  return createSuccessResult([{ format: 'gltf', content }]);
}

/**
 * Create a failed CreateGeometryResultInternal.
 */
export function createErrorResult(issues?: KernelIssue[]): CreateGeometryResult {
  return {
    success: false,
    issues: issues ?? [
      {
        message: 'Test error',
        severity: 'error',
        type: 'kernel',
      },
    ],
  };
}

/**
 * Create an empty successful result.
 */
export function createEmptySuccessResult(): CreateGeometryResult {
  return createSuccessResult([]);
}

/**
 * Create a CreateGeometryInput for testing.
 */
export function createMockInput(overrides?: Partial<CreateGeometryInput>): CreateGeometryInput {
  return {
    filePath: '/builds/test-build/test.kcl',
    basePath: '/builds/test-build',
    parameters: {},
    ...overrides,
  };
}

/**
 * Create a GeometryFile for testing.
 * Used to create test inputs for worker methods like canHandleEntry, getParametersEntry, createGeometryEntry.
 */
export function createGeometryFile(filename: string, basePath = '/builds/test'): GeometryFile {
  return {
    filename,
    path: basePath,
  };
}

// =============================================================================
// Worker Test Helpers
// =============================================================================

/**
 * Options for createTestWorker.
 */
export type CreateTestWorkerOptions = {
  /** Worker-specific options passed to initializeEntry (e.g., ReplicadWorker: { withExceptions: true }) */
  workerOptions?: Record<string, unknown>;
  /** Extensions the kernel handles (defaults to ['ts', 'js', 'scad', 'kcl', '*']) */
  extensions?: string[];
  /** Import detection regex source (for JS/TS kernel disambiguation) */
  detectImport?: string;
};

/**
 * Infer the file extensions a kernel handles from its definition.
 * Uses the kernel name as a heuristic when extensions aren't explicitly provided.
 */
function inferExtensions(definition: KernelDefinition): string[] {
  const name = definition.name.toLowerCase();

  if (name.includes('replicad') || name.includes('jscad')) {
    return ['ts', 'js'];
  }

  if (name.includes('openscad') || name.includes('scad')) {
    return ['scad'];
  }

  if (name.includes('zoo') || name.includes('kcl')) {
    return ['kcl'];
  }

  return ['*'];
}

/**
 * Infer an import-detection regex from the kernel name.
 * Returns undefined when the kernel has its own canHandle() that performs detection.
 */
function inferDetectImport(definition: KernelDefinition): string | undefined {
  if (definition.canHandle) {
    return undefined;
  }

  return undefined;
}

/**
 * Create and initialize a KernelRuntimeWorker with a single kernel definition.
 * Seeds the filesystem with provided files before creating the worker.
 * Uses the production runtime worker path (defineKernel modules).
 *
 * @param definition - The kernel definition (from defineKernel())
 * @param files - Record of relative paths to file contents
 * @param options - Optional worker options
 * @returns Promise resolving to the initialized runtime worker
 */
export async function createTestWorker(
  definition: KernelDefinition,
  files: Record<string, string>,
  options?: CreateTestWorkerOptions,
): Promise<KernelRuntimeWorker> {
  const basePath = '/builds/test';

  const absoluteFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    absoluteFiles[joinPath(basePath, path)] = content;
  }

  await seedTestFilesystem(absoluteFiles);

  const worker = new KernelRuntimeWorker();
  const extensions = options?.extensions ?? inferExtensions(definition);
  const detectImport = options?.detectImport ?? inferDetectImport(definition);

  await initializeWorkerForTesting(worker, {
    workerOptions: {
      kernelModules: [
        {
          id: definition.name,
          moduleUrl: 'test://inline',
          extensions,
          detectImport,
          options: options?.workerOptions,
          definition,
        },
      ],
    },
  });

  return worker;
}

/**
 * Helper to extract parameters from a kernel and assert success.
 *
 * @param definition - The kernel definition to use
 * @param files - Record of relative paths to file contents
 * @param mainFile - The main file to extract parameters from
 * @returns Promise resolving to the extracted parameters and JSON schema
 */
export async function getTestParameters(
  definition: KernelDefinition,
  files: Record<string, string>,
  mainFile: string,
): Promise<{ jsonSchema: unknown; defaultParameters: Record<string, unknown> }> {
  const { expect } = await import('vitest');

  const worker = await createTestWorker(definition, files);
  const result = await worker[kernelSymbols.getParametersEntry](createGeometryFile(mainFile));

  expect(result.success).toBe(true);

  if (!result.success) {
    throw new Error('Extraction failed');
  }

  return result.data;
}

/**
 * Helper to create geometry using a kernel and return the result.
 *
 * @param definition - The kernel definition to use
 * @param files - Record of relative paths to file contents
 * @param mainFile - The main file to create geometry from
 * @param parameters - Optional parameters to pass to the geometry creation
 * @param options - Optional worker options
 * @returns Promise resolving to the geometry creation result
 */
export async function createTestGeometry(
  definition: KernelDefinition,
  files: Record<string, string>,
  mainFile: string,
  parameters: Record<string, unknown> = {},
  options?: CreateTestWorkerOptions,
): Promise<CreateGeometryResult> {
  const worker = await createTestWorker(definition, files, options);
  const geometryFile = createGeometryFile(mainFile);
  return worker[kernelSymbols.createGeometryEntry](geometryFile, parameters);
}

/**
 * Create a mock KernelRuntime for kernel method testing.
 * Uses the same filesystem and logger patterns as middleware runtime.
 */
export function createMockKernelRuntime(options?: { filesystemOverrides?: MockFilesystemOptions }): KernelRuntime & {
  logger: ReturnType<typeof createMockLogger>;
  filesystem: MockFilesystem;
} {
  return {
    logger: createMockLogger(),
    filesystem: createMockFilesystem(options?.filesystemOverrides),
    fileContentCache: new Map(),
  };
}

// =============================================================================
// Mock KernelWorker for Testing
// =============================================================================

/**
 * Options for creating a MockKernelWorker.
 */
export type MockKernelWorkerOptions = {
  /** Middleware array to use (overrides default middleware) */
  middleware: KernelMiddleware[];
  /** Resolved configs parallel to the middleware array (defaults to empty objects) */
  middlewareConfigs?: Array<Record<string, unknown>>;
  /** Per-middleware enabled overrides (defaults to middleware.enabled ?? true) */
  middlewareEnabled?: boolean[];
  /** Result to return from createGeometry */
  computeResult?: CreateGeometryResult;
  /** Custom onLog handler */
  onLog?: OnWorkerLog;
  /** Mock filesystem for middleware operations */
  filesystem?: KernelFilesystem;
};

/**
 * Mock concrete implementation of KernelWorker for testing.
 * Allows injection of custom middleware to test the onion chain behavior.
 */
export class MockKernelWorker extends KernelWorker {
  protected override readonly name = 'MockKernelWorker';

  private readonly testResolvedMiddleware: ResolvedMiddleware[];
  private readonly mockComputeResult: CreateGeometryResult;

  public constructor(options: MockKernelWorkerOptions) {
    super();
    this.testResolvedMiddleware = options.middleware.map((middleware, index) => ({
      middleware,
      config: options.middlewareConfigs?.[index] ?? {},
      url: `mock://${middleware.name}`,
      enabled: options.middlewareEnabled?.[index] ?? middleware.enabled ?? true,
    }));
    this.mockComputeResult =
      options.computeResult ?? createSuccessResult([{ format: 'gltf', content: new Uint8Array([1, 2, 3]) }]);

    // Set up onLog - use provided or no-op (must be done before _logger)
    // @ts-expect-error - Test utility accessing internals
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- Mock implementation
    this.onLog = options.onLog ?? (() => {});

    // Set up the internal _filesystem property directly
    // @ts-expect-error - Test utility accessing internals
    this._filesystem = options.filesystem ?? createMockFilesystem();

    // Set up the internal _logger property directly (uses createLogger which depends on onLog)
    // @ts-expect-error - Test utility accessing internals
    this._logger = this.createLogger();
  }

  /**
   * Helper to run createGeometryEntry with a mock file.
   */
  public async runCreateGeometry(
    filename = 'test.kcl',
    parameters: Record<string, unknown> = {},
  ): Promise<CreateGeometryResultCompleted> {
    const mockFile: GeometryFile = { filename, path: filename };
    return this[kernelSymbols.createGeometryEntry](mockFile, parameters);
  }

  /**
   * Override getMiddleware to return test middleware with resolved configs.
   */
  public override [kernelSymbols.getMiddleware](): ResolvedMiddleware[] {
    return this.testResolvedMiddleware;
  }

  // Stub implementations of abstract methods
  protected override async canHandle(_input: CanHandleInput, _runtime: KernelRuntime): Promise<boolean> {
    return true;
  }

  protected override async getParameters(
    _input: GetParametersInput,
    _runtime: KernelRuntime,
  ): Promise<GetParametersResult> {
    return {
      success: true,
      data: { defaultParameters: {}, jsonSchema: { type: 'object', properties: {} } },
      issues: [],
    };
  }

  protected override async createGeometry(
    _input: CreateGeometryInput,
    _runtime: KernelRuntime,
  ): Promise<CreateGeometryResult> {
    return this.mockComputeResult;
  }

  protected override async exportGeometry(
    _input: ExportGeometryInput,
    _runtime: KernelRuntime,
  ): Promise<ExportGeometryResult> {
    return {
      success: true,
      data: [{ blob: new Blob(), name: 'export.gltf' }],
      issues: [],
    };
  }

  protected override async getDependencies(
    { filePath }: GetDependenciesInput,
    _runtime: KernelRuntime,
  ): Promise<string[]> {
    return [filePath];
  }
}
